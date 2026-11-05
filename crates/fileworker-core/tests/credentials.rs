use fileworker_core::{
    connections::ConnectionManager,
    credentials::{CredentialStore, credential_account},
    error::CoreError,
    profiles::{AuthMethod, ConnectionProfile},
};
use std::sync::Arc;
use zeroize::Zeroizing;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: "e6814610-8703-4c50-ab27-e823c8577fc3".into(),
        name: "开发".into(),
        host: "example.com".into(),
        port: 22,
        username: "tester".into(),
        auth_method: AuthMethod::Password,
        private_key_path: None,
        remote_path: ".".into(),
        group_id: None,
    }
}

#[test]
fn credentials_are_bound_to_the_server_account_and_authentication_identity() {
    let original = profile();
    let account = credential_account(&original);
    let mut changes = Vec::new();
    let mut changed = original.clone();
    changed.host = "other.example.com".into();
    changes.push(changed);
    let mut changed = original.clone();
    changed.port = 2222;
    changes.push(changed);
    let mut changed = original.clone();
    changed.username = "other".into();
    changes.push(changed);
    let mut changed = original.clone();
    changed.id = "45c20fc4-501c-4863-85e1-cf29d06caef4".into();
    changes.push(changed);
    let mut changed = original.clone();
    changed.auth_method = AuthMethod::PrivateKey;
    changed.private_key_path = Some("/tmp/key".into());
    changes.push(changed);
    for changed in changes {
        assert_ne!(credential_account(&changed), account);
    }
    let mut renamed = original.clone();
    renamed.name = "新名字".into();
    renamed.remote_path = "/data".into();
    renamed.group_id = Some("45c20fc4-501c-4863-85e1-cf29d06caef4".into());
    assert_eq!(credential_account(&renamed), account);
    let mut key = original;
    key.auth_method = AuthMethod::PrivateKey;
    key.private_key_path = Some("/tmp/a".into());
    let before = credential_account(&key);
    key.private_key_path = Some("/tmp/b".into());
    assert_ne!(credential_account(&key), before);
}

#[test]
fn pasted_private_keys_have_a_separate_credential_identity() {
    let password = profile();
    let mut pasted = password.clone();
    pasted.auth_method = AuthMethod::PrivateKeyContent;
    let mut file_key = pasted.clone();
    file_key.auth_method = AuthMethod::PrivateKey;
    assert_ne!(credential_account(&pasted), credential_account(&password));
    assert_ne!(credential_account(&pasted), credential_account(&file_key));
    let account = credential_account(&pasted);
    pasted.name = "重命名".into();
    pasted.group_id = Some("45c20fc4-501c-4863-85e1-cf29d06caef4".into());
    assert_eq!(credential_account(&pasted), account);
}

#[cfg(target_pointer_width = "64")]
#[test]
fn existing_password_and_file_key_account_hashes_are_unchanged() {
    let mut item = profile();
    assert_eq!(
        credential_account(&item),
        "v1:f29eae36a4cd47310c351091ce312b87c96acfebbd407afe50e019bdb5679e03"
    );
    item.auth_method = AuthMethod::PrivateKey;
    item.private_key_path = Some("/tmp/a".into());
    assert_eq!(
        credential_account(&item),
        "v1:55a7f8c07c87cd106bf0965365735c60c3e6f729987c3d67b265fe2e28058a7d"
    );
}

struct DefaultLookup;

impl CredentialStore for DefaultLookup {
    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError> {
        match account {
            "present" => Ok(Zeroizing::new("secret".into())),
            "empty" => Ok(Zeroizing::new(String::new())),
            "denied" => Err(CoreError::new("credential_unavailable", "安全存储不可用")),
            _ => Err(CoreError::new("credential_missing", "没有已保存凭据")),
        }
    }

    fn set(&self, _: &str, _: &str) -> Result<(), CoreError> {
        panic!("查询状态不能写入凭据")
    }

    fn delete(&self, _: &str) -> Result<(), CoreError> {
        panic!("查询状态不能删除凭据")
    }
}

#[test]
fn default_existence_lookup_distinguishes_missing_empty_and_unavailable_credentials() {
    let store = DefaultLookup;
    assert!(store.supported());
    assert!(store.exists("present").unwrap());
    assert!(store.exists("empty").unwrap());
    assert!(!store.exists("absent").unwrap());
    assert_eq!(
        store.exists("denied").unwrap_err().code,
        "credential_unavailable"
    );
}

struct MetadataOnly {
    account: String,
    available: bool,
    supported: bool,
    fail: bool,
}

impl CredentialStore for MetadataOnly {
    fn get(&self, _: &str) -> Result<Zeroizing<String>, CoreError> {
        panic!("元数据查询不能读取密码或触发钥匙串秘密访问")
    }

    fn exists(&self, account: &str) -> Result<bool, CoreError> {
        assert!(self.supported, "不支持安全存储的平台不能查询凭据");
        assert_eq!(account, self.account);
        if self.fail {
            Err(CoreError::new("credential_unavailable", "安全存储不可用"))
        } else {
            Ok(self.available)
        }
    }

    fn supported(&self) -> bool {
        self.supported
    }

    fn set(&self, _: &str, _: &str) -> Result<(), CoreError> {
        panic!("元数据查询不能写入凭据")
    }

    fn delete(&self, _: &str) -> Result<(), CoreError> {
        panic!("元数据查询不能删除凭据")
    }
}

#[test]
fn credential_status_uses_metadata_only_and_creates_no_configuration_files() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("not-created");
    let item = profile();
    for available in [false, true] {
        let manager = ConnectionManager::new(
            config.clone(),
            root.path().into(),
            Arc::new(MetadataOnly {
                account: credential_account(&item),
                available,
                supported: true,
                fail: false,
            }),
        );
        let status = manager.credential_status(&item).unwrap();
        assert_eq!(status.available, available);
        assert!(status.supported);
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"available": available, "supported": true})
        );
        assert!(!config.exists());
    }
}

#[test]
fn unsupported_credential_status_skips_the_lookup() {
    let root = tempfile::tempdir().unwrap();
    let item = profile();
    let manager = ConnectionManager::new(
        root.path().into(),
        root.path().into(),
        Arc::new(MetadataOnly {
            account: credential_account(&item),
            available: true,
            supported: false,
            fail: false,
        }),
    );
    let status = manager.credential_status(&item).unwrap();
    assert!(!status.available);
    assert!(!status.supported);
}

#[test]
fn unavailable_credential_status_is_not_reported_as_missing() {
    let root = tempfile::tempdir().unwrap();
    let item = profile();
    let manager = ConnectionManager::new(
        root.path().into(),
        root.path().into(),
        Arc::new(MetadataOnly {
            account: credential_account(&item),
            available: false,
            supported: true,
            fail: true,
        }),
    );
    assert_eq!(
        manager.credential_status(&item).unwrap_err().code,
        "credential_unavailable"
    );
}
