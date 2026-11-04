use crate::error::CoreError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub private_key_path: Option<String>,
    pub remote_path: String,
}

pub struct ProfileStore {
    root: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileDocument {
    version: u32,
    profiles: Vec<ConnectionProfile>,
}

impl ConnectionProfile {
    pub(crate) fn validated(mut self) -> Result<Self, CoreError> {
        let invalid = |message| CoreError::new("invalid_profile", message);
        Uuid::parse_str(&self.id).map_err(|_| invalid("连接标识无效"))?;
        self.name = self.name.trim().to_owned();
        self.host = self.host.trim().to_owned();
        self.username = self.username.trim().to_owned();
        if self.name.is_empty() || self.name.len() > 600 {
            return Err(invalid("请填写连接名称，长度不能超过 200 个汉字"));
        }
        if self.host.is_empty()
            || self.host.len() > 255
            || self.host.chars().any(char::is_whitespace)
            || self.host.contains(['/', '\\', '\0'])
        {
            return Err(invalid("主机地址应为域名或 IP 地址，不包含协议和路径"));
        }
        if self.port == 0 {
            return Err(invalid("端口必须在 1 到 65535 之间"));
        }
        if self.username.is_empty()
            || self.username.len() > 256
            || self.username.chars().any(char::is_control)
        {
            return Err(invalid("请填写有效的用户名"));
        }
        if self.remote_path.chars().any(char::is_control) {
            return Err(invalid("远程目录不能包含控制字符"));
        }
        if self.remote_path.is_empty() {
            self.remote_path = ".".into();
        }
        match self.auth_method {
            AuthMethod::Password => self.private_key_path = None,
            AuthMethod::PrivateKey => {
                let path = self.private_key_path.as_deref().unwrap_or("");
                if path.trim().is_empty() || path.contains('\0') {
                    return Err(invalid("请选择 SSH 私钥文件"));
                }
            }
        }
        Ok(self)
    }
}

impl ProfileStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn list(&self) -> Result<Vec<ConnectionProfile>, CoreError> {
        let bytes = match fs::read(self.root.join("profiles.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(config_io("读取连接配置", error)),
        };
        let document: ProfileDocument = serde_json::from_slice(&bytes).map_err(|error| {
            CoreError::new(
                "invalid_config",
                format!(
                    "连接配置格式不正确（第 {} 行、第 {} 列），原文件未被修改",
                    error.line(),
                    error.column()
                ),
            )
        })?;
        if document.version != 1 {
            return Err(CoreError::new(
                "unsupported_config_version",
                "当前应用不支持此配置版本，原文件未被修改",
            ));
        }
        let mut ids = HashSet::new();
        let mut profiles = Vec::with_capacity(document.profiles.len());
        for profile in document.profiles {
            let profile = profile.validated()?;
            if !ids.insert(profile.id.clone()) {
                return Err(CoreError::new(
                    "invalid_config",
                    "连接配置存在重复标识，原文件未被修改",
                ));
            }
            profiles.push(profile);
        }
        Ok(profiles)
    }

    pub fn save(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, CoreError> {
        let profile = profile.validated()?;
        let _transaction_lock = self.lock()?;
        let mut profiles = self.list()?;
        if let Some(existing) = profiles
            .iter_mut()
            .find(|existing| existing.id == profile.id)
        {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        self.write(profiles)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        let _transaction_lock = self.lock()?;
        let mut profiles = self.list()?;
        let original_len = profiles.len();
        profiles.retain(|profile| profile.id != id);
        if profiles.len() != original_len {
            self.write(profiles)?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<fs::File, CoreError> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&self.root)
            .map_err(|error| config_io("创建配置目录", error))?;
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(self.root.join("profiles.lock"))
            .map_err(|error| config_io("打开配置事务锁", error))?;
        file.lock()
            .map_err(|error| config_io("获取配置事务锁", error))?;
        Ok(file)
    }

    fn write(&self, profiles: Vec<ConnectionProfile>) -> Result<(), CoreError> {
        let bytes = serde_json::to_vec_pretty(&ProfileDocument {
            version: 1,
            profiles,
        })
        .map_err(|_| CoreError::new("serialize_config", "无法序列化连接配置"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)
            .map_err(|error| config_io("创建临时配置", error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| config_io("设置配置权限", error))?;
        }
        temporary
            .write_all(&bytes)
            .map_err(|error| config_io("写入连接配置", error))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| config_io("刷新连接配置", error))?;
        temporary
            .persist(self.root.join("profiles.json"))
            .map_err(|error| config_io("替换连接配置", error.error))?;
        Ok(())
    }
}

fn config_io(action: &str, error: std::io::Error) -> CoreError {
    CoreError::new("config_io", format!("{action}失败：{error}"))
}
