use crate::error::CoreError;
use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostIdentity {
    pub algorithm: String,
    pub fingerprint: String,
}

impl HostIdentity {
    pub fn from_key(algorithm: &str, key: &[u8]) -> Self {
        Self {
            algorithm: algorithm.into(),
            fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key))),
        }
    }
}

pub struct KnownHostStore {
    root: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    hosts: Vec<Record>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    host: String,
    port: u16,
    identity: HostIdentity,
}

impl KnownHostStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn check(&self, host: &str, port: u16, key: &HostIdentity) -> Result<bool, CoreError> {
        check_records(&self.read()?, host, port, key)
    }

    pub fn trust(&self, host: &str, port: u16, key: &HostIdentity) -> Result<(), CoreError> {
        self.trust_checked(host, port, key, || Ok(()))
    }

    pub(crate) fn trust_checked<G>(
        &self,
        host: &str,
        port: u16,
        key: &HostIdentity,
        before_commit: impl FnOnce() -> Result<G, CoreError>,
    ) -> Result<(), CoreError> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.root).map_err(storage_error)?;
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(self.root.join("known_hosts.lock"))
            .map_err(storage_error)?;
        lock.lock().map_err(storage_error)?;
        let mut hosts = self.read()?;
        if check_records(&hosts, host, port, key)? {
            return Ok(());
        }
        hosts.push(Record {
            host: host.to_ascii_lowercase(),
            port,
            identity: key.clone(),
        });
        let bytes = serde_json::to_vec_pretty(&Document { version: 1, hosts })
            .map_err(|_| invalid_document())?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root).map_err(storage_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(storage_error)?;
        }
        temporary.write_all(&bytes).map_err(storage_error)?;
        temporary.as_file().sync_all().map_err(storage_error)?;
        // Hold the attempt guard only for the atomic commit, not file locks or disk sync.
        let _current = before_commit()?;
        temporary
            .persist(self.root.join("known_hosts.json"))
            .map_err(|error| storage_error(error.error))?;
        Ok(())
    }

    fn read(&self) -> Result<Vec<Record>, CoreError> {
        let bytes = match fs::read(self.root.join("known_hosts.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(storage_error(error)),
        };
        let document: Document = serde_json::from_slice(&bytes).map_err(|_| invalid_document())?;
        if document.version != 1 {
            return Err(invalid_document());
        }
        let mut seen = HashSet::new();
        for record in &document.hosts {
            let valid_hash = record
                .identity
                .fingerprint
                .strip_prefix("SHA256:")
                .and_then(|value| STANDARD_NO_PAD.decode(value).ok())
                .is_some_and(|bytes| bytes.len() == 32);
            if record.host.is_empty()
                || record.port == 0
                || !valid_hash
                || record.identity.algorithm.is_empty()
                || !seen.insert((record.host.to_ascii_lowercase(), record.port))
            {
                return Err(invalid_document());
            }
        }
        Ok(document.hosts)
    }
}

fn check_records(
    hosts: &[Record],
    host: &str,
    port: u16,
    key: &HostIdentity,
) -> Result<bool, CoreError> {
    let Some(record) = hosts
        .iter()
        .find(|record| record.host.eq_ignore_ascii_case(host) && record.port == port)
    else {
        return Ok(false);
    };
    if record.identity != *key {
        return Err(CoreError::new(
            "host_key_changed",
            format!(
                "服务器 {host}:{port} 的主机指纹已变化，连接已阻止。已保存：{}；本次：{}。请联系管理员核实，不要直接覆盖信任记录。",
                record.identity.fingerprint, key.fingerprint,
            ),
        ));
    }
    Ok(true)
}

fn invalid_document() -> CoreError {
    CoreError::new(
        "invalid_known_hosts",
        "主机信任文件损坏或版本不受支持，连接已阻止，原文件未被修改",
    )
}

fn storage_error(error: std::io::Error) -> CoreError {
    CoreError::new("known_hosts_io", format!("无法访问主机信任文件：{error}"))
}
