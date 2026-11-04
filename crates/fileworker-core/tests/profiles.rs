use fileworker_core::profiles::{AuthMethod, ConnectionProfile, ProfileStore};
use std::fs;
use uuid::Uuid;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: Uuid::new_v4().to_string(),
        name: "测试连接".into(),
        host: "localhost".into(),
        port: 22,
        username: "tester".into(),
        auth_method: AuthMethod::Password,
        private_key_path: None,
        remote_path: ".".into(),
    }
}

#[test]
fn saving_and_reopening_preserves_a_profile() {
    let root = tempfile::tempdir().unwrap();
    let expected = profile();
    ProfileStore::new(root.path().into())
        .save(expected.clone())
        .unwrap();
    assert_eq!(
        ProfileStore::new(root.path().into()).list().unwrap(),
        vec![expected]
    );
}

#[test]
fn updating_same_id_does_not_duplicate_a_profile() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let mut item = profile();
    store.save(item.clone()).unwrap();
    item.name = "已更新".into();
    store.save(item.clone()).unwrap();
    assert_eq!(store.list().unwrap(), vec![item]);
}

#[test]
fn deleting_one_profile_preserves_other_profiles() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let first = profile();
    let second = profile();
    store.save(first.clone()).unwrap();
    store.save(second.clone()).unwrap();
    store.delete(&first.id).unwrap();
    assert_eq!(
        ProfileStore::new(root.path().into()).list().unwrap(),
        vec![second]
    );
}

#[test]
fn secret_fields_are_rejected_on_input() {
    let mut value = serde_json::to_value(profile()).unwrap();
    value["password"] = "must-not-be-persisted".into();
    assert!(serde_json::from_value::<ConnectionProfile>(value).is_err());
}

#[test]
fn invalid_profiles_never_create_a_config_file() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let mut bad = profile();
    bad.host = "ssh://localhost".into();
    assert!(store.save(bad).is_err());
    let mut bad = profile();
    bad.port = 0;
    assert!(store.save(bad).is_err());
    let mut bad = profile();
    bad.username = "  ".into();
    assert!(store.save(bad).is_err());
    let mut bad = profile();
    bad.auth_method = AuthMethod::PrivateKey;
    assert!(store.save(bad).is_err());
    assert!(!root.path().join("profiles.json").exists());
}

#[test]
fn corrupt_config_is_not_silently_replaced() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("profiles.json");
    fs::write(&path, b"{broken").unwrap();
    let store = ProfileStore::new(root.path().into());
    assert!(store.list().is_err());
    assert!(store.save(profile()).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"{broken");
}

#[test]
fn future_config_version_is_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("profiles.json");
    let original = br#"{"version":99,"profiles":[]}"#;
    fs::write(&path, original).unwrap();
    let store = ProfileStore::new(root.path().into());
    assert!(store.save(profile()).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn uninitialized_store_is_empty_without_creating_directories() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("not-created");
    assert!(ProfileStore::new(path.clone()).list().unwrap().is_empty());
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn config_and_new_parent_directory_have_private_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("private");
    ProfileStore::new(path.clone()).save(profile()).unwrap();
    assert_eq!(
        fs::metadata(path.join("profiles.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn profile_transactions_hold_a_file_lock_before_reading() {
    use std::sync::{Arc, Barrier, mpsc};
    use std::time::Duration;
    let root = tempfile::tempdir().unwrap();
    let lock = fs::File::create(root.path().join("profiles.lock")).unwrap();
    lock.lock().unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let (sender, receiver) = mpsc::channel();
    let mut workers = Vec::new();
    for _ in 0..2 {
        let store = ProfileStore::new(root.path().into());
        let barrier = Arc::clone(&barrier);
        let sender = sender.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            let result = store.save(profile());
            sender.send(result).unwrap();
        }));
    }
    barrier.wait();
    let early_result = receiver.recv_timeout(Duration::from_millis(100));
    lock.unlock().unwrap();
    for worker in workers {
        worker.join().unwrap();
    }
    assert!(
        early_result.is_err(),
        "保存任务在获得配置事务锁之前就已完成"
    );
    assert_eq!(
        ProfileStore::new(root.path().into()).list().unwrap().len(),
        2
    );
}
