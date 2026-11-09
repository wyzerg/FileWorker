use crate::{credentials::CredentialStore, error::CoreError};
use chacha20poly1305::{
    AeadInPlace, KeyInit, Tag, XChaCha20Poly1305, XNonce,
    aead::{OsRng, rand_core::RngCore},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const KEY_HEADER: &[u8; 8] = b"FWKEY\x01\0\0";
const RECORD_HEADER: &[u8; 8] = b"FWCRED\x01\0";
const KEY_SIZE: usize = 32;
const NONCE_SIZE: usize = 24;
const TAG_SIZE: usize = 16;
const RECORD_OVERHEAD: usize = RECORD_HEADER.len() + NONCE_SIZE + TAG_SIZE;
const MAX_SECRET: usize = 8 * 1024 * 1024;
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);

pub struct LocalCredentialStore {
    directory: PathBuf,
}

impl LocalCredentialStore {
    pub fn new(app_data: PathBuf) -> Self {
        Self {
            directory: app_data.join("credentials-v1"),
        }
    }

    fn record(&self, account: &str) -> Result<PathBuf, CoreError> {
        if account.is_empty() || account.len() > 4096 || account.chars().any(char::is_control) {
            return Err(unavailable());
        }
        Ok(self
            .directory
            .join(format!("{:x}.enc", Sha256::digest(account.as_bytes()))))
    }

    fn lock(&self, create: bool) -> Result<Option<File>, CoreError> {
        if create {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&self.directory).map_err(|_| unavailable())?;
        }
        let Some(metadata) = path_metadata(&self.directory)? else {
            return Ok(None);
        };
        validate(&metadata, true)?;
        let path = self.directory.join("store.lock");
        if let Some(metadata) = path_metadata(&path)? {
            validate(&metadata, false)?;
        } else if !create {
            if fs::read_dir(&self.directory)
                .map_err(|_| unavailable())?
                .next()
                .is_none()
            {
                return Ok(None);
            }
            return Err(unavailable());
        }
        let mut options = private_options();
        options.write(true).create(create).truncate(false);
        let file = options.open(&path).map_err(|_| unavailable())?;
        validate(&file.metadata().map_err(|_| unavailable())?, false)?;
        let started = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if started.elapsed() < LOCK_TIMEOUT => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return Err(unavailable()),
            }
        }
        // A replaced lock must not split concurrent writers into different transactions.
        check_open_file(&path, &file)?;
        validate(
            &fs::symlink_metadata(&self.directory).map_err(|_| unavailable())?,
            true,
        )?;
        Ok(Some(file))
    }

    fn key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, CoreError> {
        let path = self.directory.join("master.key");
        if let Some(bytes) = read_private(&path, KEY_HEADER.len() + KEY_SIZE)? {
            if bytes.len() != KEY_HEADER.len() + KEY_SIZE || !bytes.starts_with(KEY_HEADER) {
                return Err(unavailable());
            }
            return Ok(Zeroizing::new(bytes[KEY_HEADER.len()..].to_vec()));
        }
        if !create {
            return Err(unavailable());
        }
        // Never regenerate a missing key while any previous store data remains.
        for entry in fs::read_dir(&self.directory).map_err(|_| unavailable())? {
            if entry.map_err(|_| unavailable())?.file_name() != "store.lock" {
                return Err(unavailable());
            }
        }
        let mut key = Zeroizing::new(vec![0; KEY_SIZE]);
        OsRng.try_fill_bytes(&mut key).map_err(|_| unavailable())?;
        let mut bytes = Zeroizing::new(Vec::with_capacity(KEY_HEADER.len() + KEY_SIZE));
        bytes.extend_from_slice(KEY_HEADER);
        bytes.extend_from_slice(&key);
        self.temporary(&bytes)?
            .persist_noclobber(&path)
            .map_err(|_| unavailable())?;
        self.sync_directory()?;
        Ok(key)
    }

    fn decrypt(
        &self,
        account: &str,
        mut bytes: Zeroizing<Vec<u8>>,
        key: &[u8],
    ) -> Result<Zeroizing<String>, CoreError> {
        if bytes.len() < RECORD_OVERHEAD || !bytes.starts_with(RECORD_HEADER) {
            return Err(unavailable());
        }
        let nonce =
            *XNonce::from_slice(&bytes[RECORD_HEADER.len()..RECORD_HEADER.len() + NONCE_SIZE]);
        let tag_offset = bytes.len() - TAG_SIZE;
        let tag = *Tag::from_slice(&bytes[tag_offset..]);
        let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| unavailable())?;
        cipher
            .decrypt_in_place_detached(
                &nonce,
                &associated_data(account),
                &mut bytes[RECORD_HEADER.len() + NONCE_SIZE..tag_offset],
                &tag,
            )
            .map_err(|_| unavailable())?;
        let text = std::str::from_utf8(&bytes[RECORD_HEADER.len() + NONCE_SIZE..tag_offset])
            .map_err(|_| unavailable())?;
        Ok(Zeroizing::new(text.to_owned()))
    }

    fn temporary(&self, bytes: &[u8]) -> Result<tempfile::NamedTempFile, CoreError> {
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|_| unavailable())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| unavailable())?;
        }
        temporary.write_all(bytes).map_err(|_| unavailable())?;
        temporary.as_file().sync_all().map_err(|_| unavailable())?;
        Ok(temporary)
    }

    fn sync_directory(&self) -> Result<(), CoreError> {
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| unavailable())?;
        Ok(())
    }
}

impl CredentialStore for LocalCredentialStore {
    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError> {
        let path = self.record(account)?;
        let _lock = self.lock(false)?.ok_or_else(missing)?;
        let bytes = read_private(&path, MAX_SECRET + RECORD_OVERHEAD)?.ok_or_else(missing)?;
        self.decrypt(account, bytes, &self.key(false)?)
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError> {
        let path = self.record(account)?;
        if secret.len() > MAX_SECRET {
            return Err(unavailable());
        }
        let _lock = self.lock(true)?.ok_or_else(unavailable)?;
        let key = self.key(true)?;
        if let Some(previous) = read_private(&path, MAX_SECRET + RECORD_OVERHEAD)? {
            self.decrypt(account, previous, &key)?;
        }
        let mut nonce = [0; NONCE_SIZE];
        OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| unavailable())?;
        let mut encrypted = Zeroizing::new(secret.as_bytes().to_vec());
        let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| unavailable())?;
        let tag = cipher
            .encrypt_in_place_detached(
                XNonce::from_slice(&nonce),
                &associated_data(account),
                &mut encrypted,
            )
            .map_err(|_| unavailable())?;
        let mut record = Vec::with_capacity(encrypted.len() + RECORD_OVERHEAD);
        record.extend_from_slice(RECORD_HEADER);
        record.extend_from_slice(&nonce);
        record.extend_from_slice(&encrypted);
        record.extend_from_slice(&tag);
        let temporary = self.temporary(&record)?;
        if let Some(metadata) = path_metadata(&path)? {
            validate(&metadata, false)?;
        }
        temporary.persist(&path).map_err(|_| unavailable())?;
        self.sync_directory()
    }

    fn delete(&self, account: &str) -> Result<(), CoreError> {
        let path = self.record(account)?;
        let Some(_lock) = self.lock(false)? else {
            return Ok(());
        };
        if let Some(metadata) = path_metadata(&path)? {
            validate(&metadata, false)?;
            fs::remove_file(path).map_err(|_| unavailable())?;
            self.sync_directory()?;
        }
        Ok(())
    }

    fn exists(&self, account: &str) -> Result<bool, CoreError> {
        let path = self.record(account)?;
        let Some(_lock) = self.lock(false)? else {
            return Ok(false);
        };
        let Some(metadata) = path_metadata(&path)? else {
            return Ok(false);
        };
        validate(&metadata, false)?;
        self.key(false)?;
        Ok(true)
    }
}

fn associated_data(account: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(RECORD_HEADER.len() + 8 + account.len());
    data.extend_from_slice(RECORD_HEADER);
    data.extend_from_slice(&(account.len() as u64).to_be_bytes());
    data.extend_from_slice(account.as_bytes());
    data
}

fn path_metadata(path: &Path) -> Result<Option<Metadata>, CoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(unavailable()),
    }
}

fn validate(metadata: &Metadata, directory: bool) -> Result<(), CoreError> {
    if if directory {
        !metadata.file_type().is_dir()
    } else {
        !metadata.file_type().is_file()
    } {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Only the owning user may read the key or change the store's contents.
        if metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
            || (!directory && metadata.nlink() != 1)
        {
            return Err(unavailable());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(unavailable());
        }
    }
    Ok(())
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    options
}

fn check_open_file(path: &Path, file: &File) -> Result<(), CoreError> {
    let before = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    let opened = file.metadata().map_err(|_| unavailable())?;
    validate(&before, false)?;
    validate(&opened, false)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(unavailable());
        }
    }
    Ok(())
}

fn read_private(path: &Path, limit: usize) -> Result<Option<Zeroizing<Vec<u8>>>, CoreError> {
    let Some(metadata) = path_metadata(path)? else {
        return Ok(None);
    };
    validate(&metadata, false)?;
    if metadata.len() > limit as u64 {
        return Err(unavailable());
    }
    let file = private_options().open(path).map_err(|_| unavailable())?;
    check_open_file(path, &file)?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(limit.min(metadata.len() as usize) + 1));
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > limit {
        return Err(unavailable());
    }
    Ok(Some(bytes))
}

fn missing() -> CoreError {
    CoreError::new(
        "credential_missing",
        "此连接没有已保存的本地凭据，请输入密码或私钥口令",
    )
}

fn unavailable() -> CoreError {
    CoreError::new(
        "credential_unavailable",
        "无法读写本地加密凭据，请重新输入或检查应用数据目录",
    )
}
