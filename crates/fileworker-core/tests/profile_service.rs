use fileworker_core::{
    connections::ConnectionManager,
    credentials::{CredentialStore, credential_account},
    error::CoreError,
    profile_service::ProfileService,
    profiles::{AuthMethod, ConnectionGroup, ConnectionProfile, ProfileStore},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use zeroize::Zeroizing;

#[derive(Default)]
struct Credentials {
    values: Mutex<HashMap<String, String>>,
    fail_delete: AtomicBool,
    unsupported: AtomicBool,
}

impl CredentialStore for Credentials {
    fn get(&self, _: &str) -> Result<Zeroizing<String>, CoreError> {
        panic!("配置变更只能删除凭据，不能读取秘密");
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError> {
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), CoreError> {
        assert!(self.supported());
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(CoreError::new("credential_unavailable", "隔离存储拒绝删除"));
        }
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
    fn supported(&self) -> bool {
        !self.unsupported.load(Ordering::SeqCst)
    }
}

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: "e6814610-8703-4c50-ab27-e823c8577fc3".into(),
        name: "原连接".into(),
        host: "example.invalid".into(),
        port: 22,
        username: "tester".into(),
        auth_method: AuthMethod::Password,
        private_key_path: None,
        remote_path: ".".into(),
        group_id: None,
    }
}

fn service(root: &std::path::Path, credentials: Arc<Credentials>) -> ProfileService {
    let remote = Arc::new(ConnectionManager::new(
        root.into(),
        root.into(),
        credentials,
    ));
    ProfileService::new(ProfileStore::new(root.into()), remote)
}

#[test]
fn identity_changes_and_deletion_remove_only_the_previous_credential() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(Credentials::default());
    let service = service(root.path(), credentials.clone());
    let original = service.save(profile()).unwrap();
    let account = credential_account(&original);
    credentials.set(&account, "isolated-password").unwrap();
    credentials.set("unrelated", "retain").unwrap();
    let mut changed = original.clone();
    changed.host = "new.example.invalid".into();
    let changed = service.save(changed).unwrap();
    assert!(!credentials.values.lock().unwrap().contains_key(&account));
    let next_account = credential_account(&changed);
    credentials.set(&next_account, "new-password").unwrap();
    service.delete(&changed.id).unwrap();
    service.delete(&changed.id).unwrap();
    assert!(service.store().list().unwrap().is_empty());
    assert_eq!(
        *credentials.values.lock().unwrap(),
        HashMap::from([("unrelated".into(), "retain".into())])
    );
}

#[test]
fn renaming_and_group_operations_preserve_saved_credentials() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(Credentials::default());
    let service = service(root.path(), credentials.clone());
    let mut item = service.save(profile()).unwrap();
    let account = credential_account(&item);
    credentials.set(&account, "isolated-password").unwrap();
    let group = ConnectionGroup {
        id: "45c20fc4-501c-4863-85e1-cf29d06caef4".into(),
        name: "生产".into(),
    };
    service.store().save_group(group.clone()).unwrap();
    item.name = "重命名".into();
    item.remote_path = "/data".into();
    item.group_id = Some(group.id.clone());
    service.save(item).unwrap();
    service.store().delete_group(&group.id).unwrap();
    assert_eq!(
        credentials
            .values
            .lock()
            .unwrap()
            .get(&account)
            .map(String::as_str),
        Some("isolated-password")
    );
    assert!(service.store().list().unwrap()[0].group_id.is_none());
}

#[test]
fn invalid_edits_and_failed_credential_cleanup_leave_the_old_configuration() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(Credentials::default());
    let service = service(root.path(), credentials.clone());
    let original = service.save(profile()).unwrap();
    let account = credential_account(&original);
    credentials.set(&account, "isolated-password").unwrap();
    let mut invalid = original.clone();
    invalid.host = "bad/path".into();
    assert!(service.save(invalid).is_err());
    let mut invalid_group = original.clone();
    invalid_group.host = "changed.example.invalid".into();
    invalid_group.group_id = Some("45c20fc4-501c-4863-85e1-cf29d06caef4".into());
    assert!(service.save(invalid_group).is_err());
    assert!(credentials.values.lock().unwrap().contains_key(&account));
    credentials.fail_delete.store(true, Ordering::SeqCst);
    let mut changed = original.clone();
    changed.host = "changed.example.invalid".into();
    assert_eq!(
        service.save(changed).unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(
        service.delete(&original.id).unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(service.store().list().unwrap(), vec![original]);
    assert!(credentials.values.lock().unwrap().contains_key(&account));
}

#[test]
fn unsupported_platforms_can_edit_and_delete_without_accessing_a_vault() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(Credentials::default());
    credentials.unsupported.store(true, Ordering::SeqCst);
    let service = service(root.path(), credentials);
    let mut item = service.save(profile()).unwrap();
    item.username = "other".into();
    let item = service.save(item).unwrap();
    service.delete(&item.id).unwrap();
    assert!(service.store().list().unwrap().is_empty());
}

#[test]
fn a_disk_failure_after_cleanup_keeps_the_profile_and_explains_that_credentials_need_reentry() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(Credentials::default());
    let service = service(root.path(), credentials.clone());
    let original = service.save(profile()).unwrap();
    credentials
        .set(&credential_account(&original), "isolated-password")
        .unwrap();
    std::fs::remove_file(root.path().join("profiles.lock")).unwrap();
    std::fs::create_dir(root.path().join("profiles.lock")).unwrap();
    let error = service.delete(&original.id).unwrap_err();
    assert!(error.message.contains("凭据"));
    assert_eq!(service.store().list().unwrap(), vec![original]);
    assert!(credentials.values.lock().unwrap().is_empty());
}
