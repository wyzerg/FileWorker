use fileworker_core::profiles::{AuthMethod, ConnectionGroup, ConnectionProfile, ProfileStore};
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
        group_id: None,
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

#[test]
fn version_two_config_reads_grouped_profiles_without_writing() {
    let root = tempfile::tempdir().unwrap();
    let group_id = Uuid::new_v4().to_string();
    let mut item = serde_json::to_value(profile()).unwrap();
    item["groupId"] = group_id.clone().into();
    let original = serde_json::to_vec(&serde_json::json!({
        "version": 2,
        "groups": [{"id": group_id, "name": "生产环境"}],
        "profiles": [item.clone()]
    }))
    .unwrap();
    let path = root.path().join("profiles.json");
    fs::write(&path, &original).unwrap();
    let loaded = ProfileStore::new(root.path().into()).list().unwrap();
    assert_eq!(serde_json::to_value(&loaded[0]).unwrap(), item);
    assert_eq!(fs::read(path).unwrap(), original);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn first_version_one_mutation_creates_an_exact_backup_and_version_two_config() {
    let root = tempfile::tempdir().unwrap();
    let item = profile();
    let original = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "profiles": [item.clone()]
    }))
    .unwrap();
    let path = root.path().join("profiles.json");
    fs::write(&path, &original).unwrap();
    let store = ProfileStore::new(root.path().into());
    assert_eq!(store.list().unwrap(), vec![item.clone()]);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    let mut updated = item;
    updated.name = "迁移后".into();
    store.save(updated.clone()).unwrap();
    assert_eq!(
        fs::read(root.path().join("profiles.v1.backup.json")).unwrap(),
        original
    );
    let document: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(document["version"], 2);
    assert_eq!(document["groups"], serde_json::json!([]));
    assert_eq!(store.list().unwrap(), vec![updated]);
}

#[test]
fn private_key_content_requires_no_path_and_never_persists_one() {
    let root = tempfile::tempdir().unwrap();
    let mut input = serde_json::to_value(profile()).unwrap();
    input["authMethod"] = "privateKeyContent".into();
    input["privateKeyPath"] = "/old/key".into();
    let item: ConnectionProfile = serde_json::from_value(input).unwrap();
    let store = ProfileStore::new(root.path().into());
    let saved = store.save(item).unwrap();
    assert_eq!(saved.private_key_path, None);
    let value = serde_json::to_value(&saved).unwrap();
    assert_eq!(value["authMethod"], "privateKeyContent");
    assert_eq!(store.list().unwrap(), vec![saved]);
    let persisted = fs::read_to_string(root.path().join("profiles.json")).unwrap();
    assert!(!persisted.contains("/old/key"));
}

fn group(name: &str) -> ConnectionGroup {
    ConnectionGroup {
        id: Uuid::new_v4().to_string(),
        name: name.into(),
    }
}

#[test]
fn groups_roundtrip_rename_and_keep_the_same_identity() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let mut expected = group("生产环境");
    let mut input = expected.clone();
    input.name = "  生产环境  ".into();
    assert_eq!(store.save_group(input).unwrap(), expected);
    expected.name = "数据库".into();
    assert_eq!(store.save_group(expected.clone()).unwrap(), expected);
    assert_eq!(
        ProfileStore::new(root.path().into()).list_groups().unwrap(),
        vec![expected]
    );
    assert!(!root.path().join("profiles.v1.backup.json").exists());
}

#[test]
fn listing_groups_in_an_uninitialized_store_creates_nothing() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("absent");
    assert!(
        ProfileStore::new(path.clone())
            .list_groups()
            .unwrap()
            .is_empty()
    );
    assert!(!path.exists());
}

#[test]
fn deleting_a_group_ungroups_children_without_changing_connection_identities() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let first_group = store.save_group(group("生产")).unwrap();
    let second_group = store.save_group(group("开发")).unwrap();
    let mut first = profile();
    first.group_id = Some(first_group.id.clone());
    let mut second = profile();
    second.group_id = Some(first_group.id.clone());
    second.auth_method = AuthMethod::PrivateKey;
    second.private_key_path = Some("/ssh/key".into());
    let mut other = profile();
    other.group_id = Some(second_group.id.clone());
    let ungrouped = profile();
    for item in [&first, &second, &other, &ungrouped] {
        store.save(item.clone()).unwrap();
    }
    store.delete_group(&first_group.id).unwrap();
    first.group_id = None;
    second.group_id = None;
    let reopened = ProfileStore::new(root.path().into());
    assert_eq!(reopened.list_groups().unwrap(), vec![second_group]);
    assert_eq!(
        reopened.list().unwrap(),
        vec![first, second, other, ungrouped]
    );
    let original = fs::read(root.path().join("profiles.json")).unwrap();
    store.delete_group(&first_group.id).unwrap();
    assert_eq!(
        fs::read(root.path().join("profiles.json")).unwrap(),
        original
    );
}

#[test]
fn a_connection_can_move_between_groups_and_return_to_ungrouped() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let first = store.save_group(group("一")).unwrap();
    let second = store.save_group(group("二")).unwrap();
    let mut item = profile();
    item.group_id = Some(first.id);
    store.save(item.clone()).unwrap();
    item.group_id = Some(second.id);
    store.save(item.clone()).unwrap();
    assert_eq!(store.list().unwrap(), vec![item.clone()]);
    item.group_id = None;
    store.save(item.clone()).unwrap();
    assert_eq!(store.list().unwrap(), vec![item]);
}

#[test]
fn missing_or_malformed_group_references_cannot_change_config() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let item = store.save(profile()).unwrap();
    let original = fs::read(root.path().join("profiles.json")).unwrap();
    for id in [Uuid::new_v4().to_string(), "bad-id".into(), "".into()] {
        let mut invalid = item.clone();
        invalid.group_id = Some(id);
        assert!(store.save(invalid).is_err());
        assert_eq!(
            fs::read(root.path().join("profiles.json")).unwrap(),
            original
        );
    }
    assert!(!root.path().join("profiles.v1.backup.json").exists());
}

#[test]
fn invalid_groups_and_case_insensitive_duplicate_names_never_change_config() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let existing = store.save_group(group("Production")).unwrap();
    let other = store.save_group(group("Development")).unwrap();
    let original = fs::read(root.path().join("profiles.json")).unwrap();
    let mut invalid_id = group("有效名称");
    invalid_id.id = "not-a-uuid".into();
    let mut renamed_duplicate = other;
    renamed_duplicate.name = "production".into();
    for invalid in [
        invalid_id,
        group(" "),
        group(&"长".repeat(201)),
        group("有\0控制字符"),
        group("prod\nuction"),
        group(" production "),
        group("PRODUCTION"),
        renamed_duplicate,
    ] {
        assert!(store.save_group(invalid).is_err());
        assert_eq!(
            fs::read(root.path().join("profiles.json")).unwrap(),
            original
        );
    }
    assert!(store.delete_group("invalid-id").is_err());
    assert_eq!(store.list_groups().unwrap()[0], existing);
}

#[test]
fn corrupt_group_documents_reject_all_reads_and_mutations_without_replacement() {
    let duplicate_group = group("Production");
    let item = profile();
    let mut dangling = item.clone();
    dangling.group_id = Some(Uuid::new_v4().to_string());
    let mut invalid_id = group("有效");
    invalid_id.id = "invalid".into();
    let cases = [
        serde_json::json!({"version": 2, "groups": [duplicate_group.clone(), duplicate_group.clone()], "profiles": []}),
        serde_json::json!({"version": 2, "groups": [duplicate_group, group(" production ")], "profiles": []}),
        serde_json::json!({"version": 2, "groups": [invalid_id], "profiles": []}),
        serde_json::json!({"version": 2, "groups": [group(" ")], "profiles": []}),
        serde_json::json!({"version": 2, "groups": [], "profiles": [item.clone(), item]}),
        serde_json::json!({"version": 2, "groups": [], "profiles": [dangling]}),
        serde_json::json!({"version": 2, "groups": [], "profiles": [], "password": "secret"}),
        serde_json::json!({"version": 2, "profiles": []}),
        serde_json::json!({"version": 1, "groups": [group("v1 不支持分组")], "profiles": []}),
        serde_json::json!({"version": 99, "groups": [], "profiles": []}),
    ];
    for document in cases {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("profiles.json");
        let original = serde_json::to_vec(&document).unwrap();
        fs::write(&path, &original).unwrap();
        let store = ProfileStore::new(root.path().into());
        assert!(store.list().is_err(), "{document}");
        assert!(store.list_groups().is_err(), "{document}");
        assert!(store.save(profile()).is_err(), "{document}");
        assert!(store.save_group(group("新建")).is_err(), "{document}");
        assert!(
            store.delete(&Uuid::new_v4().to_string()).is_err(),
            "{document}"
        );
        assert!(
            store.delete_group(&Uuid::new_v4().to_string()).is_err(),
            "{document}"
        );
        assert_eq!(fs::read(path).unwrap(), original);
        assert!(!root.path().join("profiles.v1.backup.json").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }
}

#[test]
fn group_and_profile_secrets_or_nested_groups_are_rejected() {
    for field in ["password", "passphrase", "privateKey", "privateKeyContent"] {
        let mut item = serde_json::to_value(profile()).unwrap();
        item[field] = "secret".into();
        assert!(serde_json::from_value::<ConnectionProfile>(item).is_err());
        let mut item = serde_json::to_value(group("环境")).unwrap();
        item[field] = "secret".into();
        assert!(serde_json::from_value::<ConnectionGroup>(item).is_err());
    }
    let mut nested = serde_json::to_value(group("环境")).unwrap();
    nested["parentId"] = Uuid::new_v4().to_string().into();
    assert!(serde_json::from_value::<ConnectionGroup>(nested).is_err());
}

fn version_one_config(root: &std::path::Path, profiles: &[ConnectionProfile]) -> Vec<u8> {
    let mut profiles = serde_json::to_value(profiles).unwrap();
    for item in profiles.as_array_mut().unwrap() {
        item.as_object_mut().unwrap().remove("groupId");
    }
    let original = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "profiles": profiles
    }))
    .unwrap();
    fs::write(root.join("profiles.json"), &original).unwrap();
    original
}

#[test]
fn reading_version_one_and_noop_deletes_do_not_migrate_or_make_a_backup() {
    let root = tempfile::tempdir().unwrap();
    let item = profile();
    let original = version_one_config(root.path(), std::slice::from_ref(&item));
    let store = ProfileStore::new(root.path().into());
    assert_eq!(store.list().unwrap(), vec![item]);
    assert!(store.list_groups().unwrap().is_empty());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    store.delete(&Uuid::new_v4().to_string()).unwrap();
    store.delete_group(&Uuid::new_v4().to_string()).unwrap();
    assert_eq!(
        fs::read(root.path().join("profiles.json")).unwrap(),
        original
    );
    assert!(!root.path().join("profiles.v1.backup.json").exists());
}

#[test]
fn saving_a_group_migrates_version_one_without_losing_profiles() {
    let root = tempfile::tempdir().unwrap();
    let item = profile();
    let original = version_one_config(root.path(), std::slice::from_ref(&item));
    let store = ProfileStore::new(root.path().into());
    let saved = store.save_group(group("环境")).unwrap();
    assert_eq!(store.list().unwrap(), vec![item]);
    assert_eq!(store.list_groups().unwrap(), vec![saved]);
    assert_eq!(
        fs::read(root.path().join("profiles.v1.backup.json")).unwrap(),
        original
    );
}

#[test]
fn deleting_a_profile_migrates_version_one_with_an_exact_backup() {
    let root = tempfile::tempdir().unwrap();
    let first = profile();
    let second = profile();
    let original = version_one_config(root.path(), &[first.clone(), second.clone()]);
    let store = ProfileStore::new(root.path().into());
    store.delete(&first.id).unwrap();
    assert_eq!(store.list().unwrap(), vec![second]);
    assert_eq!(
        fs::read(root.path().join("profiles.v1.backup.json")).unwrap(),
        original
    );
    let document: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("profiles.json")).unwrap()).unwrap();
    assert_eq!(document["version"], 2);
}

#[test]
fn migration_never_overwrites_a_prior_backup() {
    let root = tempfile::tempdir().unwrap();
    version_one_config(root.path(), &[]);
    let backup = root.path().join("profiles.v1.backup.json");
    fs::write(&backup, b"prior backup").unwrap();
    let store = ProfileStore::new(root.path().into());
    store.save(profile()).unwrap();
    assert_eq!(fs::read(&backup).unwrap(), b"prior backup");
    store.save_group(group("环境")).unwrap();
    assert_eq!(fs::read(backup).unwrap(), b"prior backup");
}

#[test]
fn backup_failure_keeps_version_one_original_and_cleans_temporary_files() {
    let root = tempfile::tempdir().unwrap();
    let original = version_one_config(root.path(), &[profile()]);
    fs::create_dir(root.path().join("profiles.v1.backup.json")).unwrap();
    let store = ProfileStore::new(root.path().into());
    assert!(store.save(profile()).is_err());
    assert!(store.save_group(group("环境")).is_err());
    assert_eq!(
        fs::read(root.path().join("profiles.json")).unwrap(),
        original
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
}

#[cfg(unix)]
#[test]
fn migrated_config_and_backup_are_private_even_when_the_original_was_public() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    version_one_config(root.path(), &[]);
    fs::set_permissions(
        root.path().join("profiles.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    ProfileStore::new(root.path().into())
        .save(profile())
        .unwrap();
    for name in ["profiles.json", "profiles.v1.backup.json"] {
        assert_eq!(
            fs::metadata(root.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn invalid_version_one_mutations_never_trigger_migration() {
    let root = tempfile::tempdir().unwrap();
    let original = version_one_config(root.path(), &[]);
    let store = ProfileStore::new(root.path().into());
    let mut invalid = profile();
    invalid.group_id = Some(Uuid::new_v4().to_string());
    assert!(store.save(invalid).is_err());
    assert!(store.save_group(group(" ")).is_err());
    assert_eq!(
        fs::read(root.path().join("profiles.json")).unwrap(),
        original
    );
    assert!(!root.path().join("profiles.v1.backup.json").exists());
}

#[test]
fn password_clears_stale_key_paths_but_file_keys_still_require_a_valid_path() {
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let mut item = profile();
    item.private_key_path = Some("/old/key".into());
    assert_eq!(store.save(item).unwrap().private_key_path, None);
    for path in [None, Some("  ".into()), Some("bad\0path".into())] {
        let mut item = profile();
        item.auth_method = AuthMethod::PrivateKey;
        item.private_key_path = path;
        assert!(store.save(item).is_err());
    }
}

#[test]
fn group_transactions_wait_for_the_existing_profile_lock() {
    use std::sync::{Arc, Barrier, mpsc};
    use std::time::Duration;
    let root = tempfile::tempdir().unwrap();
    let store = ProfileStore::new(root.path().into());
    let existing = store.save_group(group("待删除")).unwrap();
    let lock = fs::File::open(root.path().join("profiles.lock")).unwrap();
    lock.lock().unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let (sender, receiver) = mpsc::channel();
    let mut workers = Vec::new();
    for deleting in [false, true] {
        let store = ProfileStore::new(root.path().into());
        let id = existing.id.clone();
        let barrier = Arc::clone(&barrier);
        let sender = sender.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            let result = if deleting {
                store.delete_group(&id)
            } else {
                store.save_group(group("新环境")).map(|_| ())
            };
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
        "分组操作在获得配置事务锁之前就已完成"
    );
    for result in receiver.try_iter() {
        result.unwrap();
    }
    let groups = store.list_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "新环境");
}

#[test]
fn concurrent_profile_and_group_saves_keep_every_change_and_one_original_backup() {
    use std::sync::{Arc, Barrier};
    let root = tempfile::tempdir().unwrap();
    let original = version_one_config(root.path(), &[]);
    let barrier = Arc::new(Barrier::new(8));
    let mut workers = Vec::new();
    for index in 0..8 {
        let store = ProfileStore::new(root.path().into());
        let barrier = Arc::clone(&barrier);
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            if index % 2 == 0 {
                store.save(profile()).unwrap();
            } else {
                store.save_group(group(&format!("环境 {index}"))).unwrap();
            }
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
    let store = ProfileStore::new(root.path().into());
    assert_eq!(store.list().unwrap().len(), 4);
    assert_eq!(store.list_groups().unwrap().len(), 4);
    assert_eq!(
        fs::read(root.path().join("profiles.v1.backup.json")).unwrap(),
        original
    );
}

#[test]
fn concurrent_duplicate_group_names_allow_only_one_save() {
    use std::sync::{Arc, Barrier};
    let root = tempfile::tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for name in ["Production", "PRODUCTION"] {
        let store = ProfileStore::new(root.path().into());
        let barrier = Arc::clone(&barrier);
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            store.save_group(group(name))
        }));
    }
    let successful = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .filter(Result::is_ok)
        .count();
    assert_eq!(successful, 1);
    assert_eq!(
        ProfileStore::new(root.path().into())
            .list_groups()
            .unwrap()
            .len(),
        1
    );
}
