use crate::{
    error::CoreError,
    known_hosts::HostIdentity,
    local::{DirectoryListing, FileEntry},
    profiles::{AuthMethod, ConnectionProfile},
    remote_path,
};
use ssh2::{ErrorCode, HostKeyType, Session, Sftp};
use std::{
    net::{Shutdown, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

pub(crate) struct SftpConnection {
    session: Session,
    sftp: Option<Sftp>,
    pub socket: Arc<TcpStream>,
    pub identity: HostIdentity,
    profile: ConnectionProfile,
}

impl SftpConnection {
    pub(crate) fn filesystem(&self) -> Result<&Sftp, CoreError> {
        self.sftp
            .as_ref()
            .ok_or_else(|| CoreError::new("not_authenticated", "请先完成服务器认证"))
    }

    pub fn probe(
        profile: ConnectionProfile,
        timeout: Duration,
        register_socket: impl FnOnce(Arc<TcpStream>) -> Result<(), CoreError>,
    ) -> Result<Self, CoreError> {
        let started = Instant::now();
        let endpoint = (profile.host.clone(), profile.port);
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = sender.send(
                endpoint
                    .to_socket_addrs()
                    .map(|addresses| addresses.collect::<Vec<_>>()),
            );
        });
        let addresses = receiver
            .recv_timeout(timeout)
            .map_err(|_| {
                CoreError::new("connection_timeout", "解析主机地址超时，请检查网络后重试")
            })?
            .map_err(|_| {
                CoreError::new("connection_failed", "无法解析主机地址，请检查域名或 IP")
            })?;
        let mut stream = None;
        for address in addresses {
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            if let Ok(socket) = TcpStream::connect_timeout(&address, remaining) {
                stream = Some(socket);
                break;
            }
        }
        let stream = stream.ok_or_else(|| {
            CoreError::new(
                "connection_failed",
                "无法连接服务器，请检查地址、端口和网络",
            )
        })?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| connection_lost())?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|_| connection_lost())?;
        let socket = Arc::new(stream.try_clone().map_err(|_| connection_lost())?);
        register_socket(socket.clone())?;
        let mut session =
            Session::new().map_err(|_| CoreError::new("ssh_unavailable", "无法初始化 SSH"))?;
        session.set_tcp_stream(stream);
        session.set_timeout(timeout.as_millis().clamp(1, u32::MAX as u128) as u32);
        session.handshake().map_err(|_| {
            CoreError::new(
                "ssh_handshake",
                "SSH 握手失败或超时，请确认端口提供 SSH 服务",
            )
        })?;
        let (key, kind) = session
            .host_key()
            .ok_or_else(|| CoreError::new("host_key_missing", "服务器没有提供可验证的主机密钥"))?;
        let algorithm = match kind {
            HostKeyType::Rsa => "ssh-rsa",
            HostKeyType::Ed25519 => "ssh-ed25519",
            HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
            HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
            HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
            _ => {
                return Err(CoreError::new(
                    "host_key_unsupported",
                    "服务器使用不受支持的主机密钥类型",
                ));
            }
        };
        let identity = HostIdentity::from_key(algorithm, key);
        Ok(Self {
            session,
            sftp: None,
            socket,
            identity,
            profile,
        })
    }

    pub fn authenticate(&mut self, secret: &str, home: &Path) -> Result<String, CoreError> {
        let authentication = match self.profile.auth_method {
            AuthMethod::Password => self
                .session
                .userauth_password(&self.profile.username, secret),
            AuthMethod::PrivateKey => {
                let raw = self.profile.private_key_path.as_deref().unwrap_or("");
                let key = if let Some(relative) = raw.strip_prefix("~/") {
                    home.join(relative)
                } else {
                    PathBuf::from(raw)
                };
                if !key.is_absolute() || !key.is_file() {
                    return Err(CoreError::new(
                        "private_key_missing",
                        "私钥文件不存在，请选择绝对路径或 ~/ 开头的路径",
                    ));
                }
                self.session.userauth_pubkey_file(
                    &self.profile.username,
                    None,
                    &key,
                    (!secret.is_empty()).then_some(secret),
                )
            }
        };
        authentication.map_err(|_| {
            CoreError::new(
                "authentication_failed",
                "认证失败，请检查用户名、密码、私钥及口令，或重新连接后重试",
            )
        })?;
        if !self.session.authenticated() {
            return Err(CoreError::new("authentication_failed", "服务器未接受认证"));
        }
        let sftp = self.session.sftp().map_err(|_| {
            CoreError::new("sftp_unavailable", "认证成功，但服务器无法打开 SFTP 子系统")
        })?;
        let home = sftp.realpath(Path::new(".")).map_err(directory_error)?;
        let home = home
            .to_str()
            .filter(|value| value.starts_with('/'))
            .ok_or_else(|| {
                CoreError::new(
                    "unsupported_path",
                    "服务器返回的主目录不是有效的 UTF-8 POSIX 路径",
                )
            })?;
        self.sftp = Some(sftp);
        remote_path::resolve(home, &self.profile.remote_path)
    }

    pub fn list_directory(&self, input: &str) -> Result<DirectoryListing, CoreError> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| CoreError::new("not_authenticated", "请先完成服务器认证"))?;
        if !input.starts_with('/') {
            return Err(CoreError::new(
                "invalid_remote_path",
                "远程请求必须包含明确的绝对路径",
            ));
        }
        let requested = remote_path::resolve("/", input)?;
        // ssh2 translates backslashes on Windows; reject rather than access a different path.
        #[cfg(windows)]
        if requested.contains('\\') {
            return Err(CoreError::new(
                "unsupported_path",
                "此平台暂不支持包含反斜杠的远程路径",
            ));
        }
        let canonical = sftp
            .realpath(Path::new(&requested))
            .map_err(directory_error)?;
        let path = canonical
            .to_str()
            .filter(|value| value.starts_with('/') && !value.chars().any(char::is_control))
            .ok_or_else(|| CoreError::new("unsupported_path", "远程目录路径无法安全显示为 UTF-8"))?
            .to_owned();
        let mut directory = sftp.opendir(Path::new(&path)).map_err(directory_error)?;
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        loop {
            let (name, mut stat) = match directory.readdir() {
                Ok(entry) => entry,
                Err(error) if error.code() == ErrorCode::Session(-16) => break,
                Err(error) => return Err(directory_error(error)),
            };
            let Some(name) = name.to_str() else {
                warnings.push("已跳过一个非 UTF-8 远程文件名，未将它转换为其他路径".into());
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }
            if name.is_empty() || name.contains('/') || name.chars().any(char::is_control) {
                warnings.push("已跳过一个无法安全显示的远程文件名".into());
                continue;
            }
            #[cfg(windows)]
            if name.contains('\\') {
                warnings.push("已跳过一个此平台暂不支持的远程文件名".into());
                continue;
            }
            let full_path = if path == "/" {
                format!("/{name}")
            } else {
                format!("{path}/{name}")
            };
            let is_symlink = stat.file_type().is_symlink();
            if is_symlink {
                match sftp.stat(Path::new(&full_path)) {
                    Ok(target) => stat = target,
                    Err(error) => {
                        let error = directory_error(error);
                        if error.code == "connection_lost" {
                            return Err(error);
                        }
                        warnings.push(format!("无法读取「{name}」的链接目标"));
                    }
                }
            }
            let is_dir = stat.is_dir();
            entries.push(FileEntry {
                name: name.into(),
                path: full_path,
                is_dir,
                is_symlink,
                size: if is_dir { None } else { stat.size },
                modified_ms: stat.mtime.and_then(|time| time.checked_mul(1000)),
                hidden: name.starts_with('.'),
            });
            if entries.len() >= 100_000 {
                warnings.push("此目录超过 100000 项，仅显示前 100000 项".into());
                break;
            }
        }
        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(DirectoryListing {
            parent_path: remote_path::parent(&path),
            path,
            entries,
            warnings,
        })
    }
}

impl Drop for SftpConnection {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

fn directory_error(error: ssh2::Error) -> CoreError {
    match error.code() {
        ErrorCode::SFTP(2 | 10) => CoreError::new("remote_directory", "远程目录不存在，请检查路径"),
        ErrorCode::SFTP(3) => CoreError::new("remote_directory", "没有读取此远程目录的权限"),
        ErrorCode::SFTP(_) | ErrorCode::Session(-31) => {
            CoreError::new("remote_directory", "无法读取远程目录，请确认路径及权限")
        }
        _ => connection_lost(),
    }
}

fn connection_lost() -> CoreError {
    CoreError::new("connection_lost", "服务器连接已中断或超时，请重新连接")
}
