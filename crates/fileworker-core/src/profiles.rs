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
    PrivateKeyContent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

pub struct ProfileStore {
    root: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileDocument {
    version: u32,
    #[serde(default)]
    groups: Option<Vec<ConnectionGroup>>,
    profiles: Vec<ConnectionProfile>,
}

struct StoredProfiles {
    groups: Vec<ConnectionGroup>,
    profiles: Vec<ConnectionProfile>,
    original_v1: Option<Vec<u8>>,
}

impl ConnectionGroup {
    fn validated(mut self) -> Result<Self, CoreError> {
        let invalid = |message| CoreError::new("invalid_group", message);
        Uuid::parse_str(&self.id).map_err(|_| invalid("分组标识无效"))?;
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.len() > 600 {
            return Err(invalid("请填写分组名称，长度不能超过 200 个汉字"));
        }
        if self.name.chars().any(char::is_control) {
            return Err(invalid("分组名称不能包含控制字符"));
        }
        Ok(self)
    }
}

impl ConnectionProfile {
    pub(crate) fn validated(mut self) -> Result<Self, CoreError> {
        let invalid = |message| CoreError::new("invalid_profile", message);
        Uuid::parse_str(&self.id).map_err(|_| invalid("连接标识无效"))?;
        if let Some(id) = &self.group_id {
            Uuid::parse_str(id).map_err(|_| invalid("分组标识无效"))?;
        }
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
            AuthMethod::Password | AuthMethod::PrivateKeyContent => self.private_key_path = None,
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

impl StoredProfiles {
    fn validated(mut self) -> Result<Self, CoreError> {
        let mut group_ids = HashSet::new();
        let mut group_names = HashSet::new();
        for group in &mut self.groups {
            *group = group.clone().validated()?;
            let id = Uuid::parse_str(&group.id)
                .map_err(|_| CoreError::new("invalid_config", "连接配置存在无效分组标识"))?;
            if !group_ids.insert(id) || !group_names.insert(group.name.to_lowercase()) {
                return Err(CoreError::new(
                    "invalid_config",
                    "连接配置存在重复分组标识或名称，原文件未被修改",
                ));
            }
        }
        let mut profile_ids = HashSet::new();
        for profile in &mut self.profiles {
            *profile = profile.clone().validated()?;
            let id = Uuid::parse_str(&profile.id)
                .map_err(|_| CoreError::new("invalid_config", "连接配置存在无效连接标识"))?;
            if !profile_ids.insert(id) {
                return Err(CoreError::new(
                    "invalid_config",
                    "连接配置存在重复标识，原文件未被修改",
                ));
            }
            if let Some(group_id) = &profile.group_id
                && !self.groups.iter().any(|group| group.id == *group_id)
            {
                return Err(CoreError::new(
                    "invalid_config",
                    "连接引用的分组不存在，原文件未被修改",
                ));
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
        Ok(self.read()?.profiles)
    }

    pub fn list_groups(&self) -> Result<Vec<ConnectionGroup>, CoreError> {
        Ok(self.read()?.groups)
    }

    fn read(&self) -> Result<StoredProfiles, CoreError> {
        let bytes = match fs::read(self.root.join("profiles.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoredProfiles {
                    groups: Vec::new(),
                    profiles: Vec::new(),
                    original_v1: None,
                });
            }
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
        if document.version != 1 && document.version != 2 {
            return Err(CoreError::new(
                "unsupported_config_version",
                "当前应用不支持此配置版本，原文件未被修改",
            ));
        }
        let groups = match (document.version, document.groups) {
            (1, None) => Vec::new(),
            (2, Some(groups)) => groups,
            _ => {
                return Err(CoreError::new(
                    "invalid_config",
                    "连接配置的分组格式与版本不符，原文件未被修改",
                ));
            }
        };
        StoredProfiles {
            groups,
            profiles: document.profiles,
            original_v1: (document.version == 1).then_some(bytes),
        }
        .validated()
    }

    pub fn save(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, CoreError> {
        let profile = profile.validated()?;
        let _transaction_lock = self.lock()?;
        let mut document = self.read()?;
        if let Some(group_id) = &profile.group_id
            && !document.groups.iter().any(|group| group.id == *group_id)
        {
            return Err(CoreError::new("invalid_profile", "连接引用的分组不存在"));
        }
        if let Some(existing) = document
            .profiles
            .iter_mut()
            .find(|existing| existing.id == profile.id)
        {
            *existing = profile.clone();
        } else {
            document.profiles.push(profile.clone());
        }
        self.write(document)?;
        Ok(profile)
    }

    pub fn save_group(&self, group: ConnectionGroup) -> Result<ConnectionGroup, CoreError> {
        let group = group.validated()?;
        let _transaction_lock = self.lock()?;
        let mut document = self.read()?;
        if document.groups.iter().any(|existing| {
            existing.id != group.id && existing.name.to_lowercase() == group.name.to_lowercase()
        }) {
            return Err(CoreError::new("invalid_group", "已存在同名分组"));
        }
        if let Some(existing) = document
            .groups
            .iter_mut()
            .find(|existing| existing.id == group.id)
        {
            *existing = group.clone();
        } else {
            document.groups.push(group.clone());
        }
        self.write(document)?;
        Ok(group)
    }

    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        let _transaction_lock = self.lock()?;
        let mut document = self.read()?;
        let original_len = document.profiles.len();
        document.profiles.retain(|profile| profile.id != id);
        if document.profiles.len() != original_len {
            self.write(document)?;
        }
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> Result<(), CoreError> {
        Uuid::parse_str(id).map_err(|_| CoreError::new("invalid_group", "分组标识无效"))?;
        let _transaction_lock = self.lock()?;
        let mut document = self.read()?;
        let original_len = document.groups.len();
        document.groups.retain(|group| group.id != id);
        if document.groups.len() != original_len {
            for profile in &mut document.profiles {
                if profile.group_id.as_deref() == Some(id) {
                    profile.group_id = None;
                }
            }
            self.write(document)?;
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

    fn write(&self, document: StoredProfiles) -> Result<(), CoreError> {
        let document = document.validated()?;
        let bytes = serde_json::to_vec_pretty(&ProfileDocument {
            version: 2,
            groups: Some(document.groups),
            profiles: document.profiles,
        })
        .map_err(|_| CoreError::new("serialize_config", "无法序列化连接配置"))?;
        let temporary = self.temporary(&bytes)?;
        if let Some(original) = document.original_v1 {
            // 先完整落盘备份，再替换主配置；已存在的备份绝不覆盖。
            let backup = self.temporary(&original)?;
            let path = self.root.join("profiles.v1.backup.json");
            if let Err(error) = backup.persist_noclobber(&path) {
                if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(config_io("备份旧版连接配置", error.error));
                }
                let metadata = fs::symlink_metadata(path)
                    .map_err(|error| config_io("读取旧版配置备份", error))?;
                if !metadata.file_type().is_file() {
                    return Err(CoreError::new(
                        "config_io",
                        "旧版配置备份路径不是普通文件，原文件未被修改",
                    ));
                }
            }
        }
        temporary
            .persist(self.root.join("profiles.json"))
            .map_err(|error| config_io("替换连接配置", error.error))?;
        Ok(())
    }

    fn temporary(&self, bytes: &[u8]) -> Result<tempfile::NamedTempFile, CoreError> {
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
            .write_all(bytes)
            .map_err(|error| config_io("写入连接配置", error))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| config_io("刷新连接配置", error))?;
        Ok(temporary)
    }
}

fn config_io(action: &str, error: std::io::Error) -> CoreError {
    CoreError::new("config_io", format!("{action}失败：{error}"))
}
