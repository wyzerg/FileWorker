use super::{ConflictPolicy, TransferDirection, TransferRequest};
use crate::{connections::ConnectionManager, error::CoreError, remote_path};
use ssh2::{ErrorCode, OpenFlags, OpenType, RenameFlags, Sftp};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, TryLockError, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

type TargetLockMap = HashMap<String, Weak<Mutex<()>>>;
#[derive(Default)]
pub(super) struct TargetLocks(Mutex<TargetLockMap>);
impl TargetLocks {
    fn get(&self, key: String) -> Result<Arc<Mutex<()>>, CoreError> {
        let mut locks = self.0.lock().map_err(|_| failed("目标文件锁不可用"))?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        Ok(lock)
    }
}

pub(super) struct Outcome {
    pub path: String,
    pub warning: Option<String>,
}

pub(super) fn execute(
    remote: &ConnectionManager,
    targets: &TargetLocks,
    request: &TransferRequest,
    policy: ConflictPolicy,
    canceled: &AtomicBool,
    progress: impl Fn(u64, u64, &str),
) -> Result<Outcome, CoreError> {
    let (connection, session_canceled) =
        remote.transfer_connection(&request.session_id, canceled)?;
    let check = || {
        if canceled.load(Ordering::SeqCst) || session_canceled.load(Ordering::SeqCst) {
            Err(CoreError::new("transfer_canceled", "传输已取消"))
        } else {
            Ok(())
        }
    };
    check()?;
    let sftp = connection.filesystem()?;
    let name = request.source_path.rsplit('/').next().unwrap_or("");
    let directory = match request.direction {
        TransferDirection::Upload => {
            let directory = sftp
                .realpath(Path::new(&request.destination_dir))
                .map_err(remote_error)?;
            let path = path_text(&directory)?;
            remote_path::resolve("/", &path)?;
            if !sftp.stat(&directory).map_err(remote_error)?.is_dir() {
                return Err(failed("远程目标不是目录"));
            }
            directory
        }
        TransferDirection::Download => {
            let directory = fs::canonicalize(&request.destination_dir).map_err(local_error)?;
            if !directory.is_dir() {
                return Err(failed("本地目标不是目录"));
            }
            directory
        }
    };
    let lock_key = match request.direction {
        TransferDirection::Upload => {
            format!("{}:{}", request.session_id, directory.join(name).display())
        }
        TransferDirection::Download => format!("local:{}", directory.join(name).display()),
    };
    let lock = targets.get(lock_key)?;
    let _guard = loop {
        check()?;
        match lock.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(20)),
            Err(_) => return Err(failed("目标文件锁不可用")),
        }
    };
    let exists = |path: &Path| -> Result<bool, CoreError> {
        match request.direction {
            TransferDirection::Upload => remote_exists(sftp, path),
            TransferDirection::Download => local_exists(path),
        }
    };
    let mut destination = directory.join(name);
    if exists(&destination)? {
        match policy {
            ConflictPolicy::Ask | ConflictPolicy::Skip => return Err(conflict()),
            ConflictPolicy::KeepBoth => destination = unused_name(&directory, name, &exists)?,
            ConflictPolicy::Overwrite => {}
        }
    }
    check()?;
    match request.direction {
        TransferDirection::Upload => {
            upload(sftp, request, &mut destination, policy, &check, &progress)
        }
        TransferDirection::Download => {
            download(sftp, request, &mut destination, policy, &check, &progress)
        }
    }
}

fn upload(
    sftp: &Sftp,
    request: &TransferRequest,
    destination: &mut PathBuf,
    policy: ConflictPolicy,
    check: &impl Fn() -> Result<(), CoreError>,
    progress: &impl Fn(u64, u64, &str),
) -> Result<Outcome, CoreError> {
    let source = Path::new(&request.source_path);
    if !fs::symlink_metadata(source).map_err(local_error)?.is_file() {
        return Err(failed("仅支持普通文件，不能上传目录、符号链接或设备文件"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut input = options.open(source).map_err(local_error)?;
    let before = input.metadata().map_err(local_error)?;
    if !before.is_file() {
        return Err(failed("上传来源不再是普通文件"));
    }
    let directory = destination.parent().ok_or_else(|| failed("目标目录无效"))?;
    let temporary = directory.join(format!(".fileworker-{}.part", Uuid::new_v4()));
    let mut output = sftp
        .open_mode(
            &temporary,
            OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
            0o600,
            OpenType::File,
        )
        .map_err(remote_error)?;
    let result = (|| {
        let target = path_text(destination)?;
        copy_stream(
            &mut input,
            &mut output,
            before.len(),
            &target,
            check,
            progress,
        )?;
        let stat = output.stat().map_err(remote_error)?;
        if stat.size != Some(before.len()) {
            return Err(failed("远程临时文件长度不一致，未替换目标文件"));
        }
        output.close().map_err(remote_error)?;
        let after = input.metadata().map_err(local_error)?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err(source_changed());
        }
        check()?;
        let warning = if policy == ConflictPolicy::Overwrite && remote_exists(sftp, destination)? {
            overwrite_remote(sftp, &temporary, destination, check)?
        } else {
            loop {
                check()?;
                match sftp.rename(&temporary, destination, Some(RenameFlags::empty())) {
                    Ok(()) => break None,
                    Err(_) if remote_exists(sftp, destination)? => {
                        if policy != ConflictPolicy::KeepBoth {
                            return Err(conflict());
                        }
                        *destination = unused_name(
                            destination.parent().ok_or_else(|| failed("目标目录无效"))?,
                            request.source_path.rsplit('/').next().unwrap_or(""),
                            &|path| remote_exists(sftp, path),
                        )?;
                    }
                    Err(error) => return Err(remote_error(error)),
                }
            }
        };
        Ok(Outcome {
            path: path_text(destination)?,
            warning,
        })
    })();
    // A failed CLOSE can leave the handle alive; drop it before attempting cleanup.
    drop(output);
    if result.is_err()
        && let Err(error) = sftp.unlink(&temporary)
        && !matches!(error.code(), ErrorCode::SFTP(2 | 10))
    {
        return Err(CoreError::new(
            "transfer_cleanup",
            format!(
                "{}；未能清理远程临时文件 {}，请在重新连接后检查",
                result
                    .as_ref()
                    .err()
                    .map(|error| error.message.as_str())
                    .unwrap_or("传输失败"),
                temporary.display()
            ),
        ));
    }
    result
}

fn overwrite_remote(
    sftp: &Sftp,
    temporary: &Path,
    destination: &Path,
    check: &impl Fn() -> Result<(), CoreError>,
) -> Result<Option<String>, CoreError> {
    let stat = sftp.lstat(destination).map_err(remote_error)?;
    if !stat.is_file() {
        return Err(failed("不能覆盖远程目录、符号链接或特殊文件"));
    }
    let backup = destination
        .parent()
        .ok_or_else(|| failed("目标目录无效"))?
        .join(format!(".fileworker-{}.backup", Uuid::new_v4()));
    check()?;
    sftp.rename(destination, &backup, Some(RenameFlags::empty()))
        .map_err(remote_error)?;
    let commit = check().and_then(|()| {
        sftp.rename(temporary, destination, Some(RenameFlags::empty()))
            .map_err(remote_error)
    });
    if let Err(error) = commit {
        return match sftp.rename(&backup, destination, Some(RenameFlags::empty())) {
            Ok(()) => Err(error),
            Err(_) => Err(failed(format!(
                "{}；原文件保留在 {}，恢复失败，未覆盖当前目标，请检查后手动恢复",
                error.message,
                backup.display()
            ))),
        };
    }
    Ok(sftp
        .unlink(&backup)
        .err()
        .map(|_| format!("文件已传输，原文件备份未能清理：{}", backup.display())))
}

fn download(
    sftp: &Sftp,
    request: &TransferRequest,
    destination: &mut PathBuf,
    policy: ConflictPolicy,
    check: &impl Fn() -> Result<(), CoreError>,
    progress: &impl Fn(u64, u64, &str),
) -> Result<Outcome, CoreError> {
    let source = Path::new(&request.source_path);
    let before = sftp.lstat(source).map_err(remote_error)?;
    if !before.is_file() {
        return Err(failed("仅支持普通文件，不能下载目录、符号链接或设备文件"));
    }
    let total = before
        .size
        .ok_or_else(|| failed("服务器未提供文件大小，无法安全校验下载"))?;
    let mut input = sftp.open(source).map_err(remote_error)?;
    let opened = input.stat().map_err(remote_error)?;
    if !opened.is_file() || opened.size != before.size || opened.mtime != before.mtime {
        return Err(source_changed());
    }
    let directory = destination
        .parent()
        .ok_or_else(|| failed("目标目录无效"))?
        .to_owned();
    let mut output = tempfile::Builder::new()
        .prefix(".fileworker-")
        .suffix(".part")
        .tempfile_in(&directory)
        .map_err(local_error)?;
    let target = path_text(destination)?;
    copy_stream(&mut input, &mut output, total, &target, check, progress)?;
    let after = input.stat().map_err(remote_error)?;
    if after.size != before.size || after.mtime != before.mtime {
        return Err(source_changed());
    }
    input.close().map_err(remote_error)?;
    output.as_file_mut().sync_all().map_err(local_error)?;
    check()?;
    if policy == ConflictPolicy::Overwrite {
        if local_exists(destination)?
            && !fs::symlink_metadata(&destination)
                .map_err(local_error)?
                .is_file()
        {
            return Err(failed("不能覆盖本地目录、符号链接或特殊文件"));
        }
        output
            .persist(&destination)
            .map_err(|error| local_error(error.error))?;
    } else {
        loop {
            check()?;
            match output.persist_noclobber(&destination) {
                Ok(_) => break,
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    output = error.file;
                    if policy != ConflictPolicy::KeepBoth {
                        return Err(conflict());
                    }
                    *destination = unused_name(
                        &directory,
                        request.source_path.rsplit('/').next().unwrap_or(""),
                        &local_exists,
                    )?;
                }
                Err(error) => return Err(local_error(error.error)),
            }
        }
    }
    let warning = File::open(&directory)
        .and_then(|file| file.sync_all())
        .err()
        .map(|_| "文件已下载，但目录同步未完成；断电后请检查目标文件".to_owned());
    Ok(Outcome {
        path: path_text(destination)?,
        warning,
    })
}

fn copy_stream(
    input: &mut impl Read,
    output: &mut impl Write,
    total: u64,
    target: &str,
    check: &impl Fn() -> Result<(), CoreError>,
    progress: &impl Fn(u64, u64, &str),
) -> Result<(), CoreError> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut done = 0_u64;
    progress(0, total, target);
    loop {
        check()?;
        let count = input.read(&mut buffer).map_err(stream_error)?;
        if count == 0 {
            break;
        }
        done = done.checked_add(count as u64).ok_or_else(source_changed)?;
        if done > total {
            return Err(source_changed());
        }
        output.write_all(&buffer[..count]).map_err(stream_error)?;
        check()?;
        progress(done, total, target);
    }
    if done != total {
        return Err(source_changed());
    }
    output.flush().map_err(stream_error)?;
    Ok(())
}

fn unused_name(
    directory: &Path,
    name: &str,
    exists: &impl Fn(&Path) -> Result<bool, CoreError>,
) -> Result<PathBuf, CoreError> {
    let split = name.rfind('.').filter(|index| *index > 0);
    let (stem, extension) = split
        .map(|index| (&name[..index], &name[index..]))
        .unwrap_or((name, ""));
    for number in 1..=1000 {
        let path = directory.join(format!("{stem} ({number}){extension}"));
        if !exists(&path)? {
            return Ok(path);
        }
    }
    Err(failed("同名副本过多，请更换目标目录或文件名"))
}

fn remote_exists(sftp: &Sftp, path: &Path) -> Result<bool, CoreError> {
    match sftp.lstat(path) {
        Ok(_) => Ok(true),
        Err(error) if matches!(error.code(), ErrorCode::SFTP(2 | 10)) => Ok(false),
        Err(error) => Err(remote_error(error)),
    }
}
fn local_exists(path: &Path) -> Result<bool, CoreError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(local_error(error)),
    }
}
fn path_text(path: &Path) -> Result<String, CoreError> {
    path.to_str()
        .filter(|value| value.starts_with('/') && !value.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| failed("目标路径无法安全显示为 UTF-8"))
}
fn remote_error(error: ssh2::Error) -> CoreError {
    let message = match error.code() {
        ErrorCode::SFTP(2 | 10) => "远程文件或目录不存在",
        ErrorCode::SFTP(3) => "没有传输此远程文件的权限",
        ErrorCode::SFTP(_) => "远程文件操作失败，请检查权限、空间及服务器支持",
        _ => "传输连接已中断或超时，请检查网络后重试",
    };
    failed(message)
}
fn local_error(error: std::io::Error) -> CoreError {
    failed(format!("本地文件操作失败：{error}"))
}
fn stream_error(error: std::io::Error) -> CoreError {
    failed(format!("文件读写失败，请检查网络、权限及磁盘空间：{error}"))
}
fn source_changed() -> CoreError {
    failed("源文件在传输期间发生变化或长度不符，未提交目标文件，请重试")
}
fn conflict() -> CoreError {
    CoreError::new("transfer_conflict", "目标已存在同名文件，请选择处理方式")
}
fn failed(message: impl Into<String>) -> CoreError {
    CoreError::new("transfer_failed", message)
}
