use fileworker_core::{credentials::CredentialStore, local_credentials::LocalCredentialStore};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};

fn directory(root: &Path) -> PathBuf {
    root.join("credentials-v1")
}

fn records(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory(root))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "enc"))
        .collect()
}

#[test]
fn missing_reads_status_and_deletion_create_no_files() {
    let root = tempfile::tempdir().unwrap();
    let app_data = root.path().join("not-created");
    let store = LocalCredentialStore::new(app_data.clone());
    assert!(store.supported());
    assert!(!store.exists("absent").unwrap());
    assert_eq!(store.get("absent").unwrap_err().code, "credential_missing");
    store.delete("absent").unwrap();
    assert!(!app_data.exists());
}

#[test]
fn an_empty_private_directory_left_by_interrupted_initialization_can_be_reused() {
    let root = tempfile::tempdir().unwrap();
    let vault = directory(root.path());
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&vault).unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    assert!(!store.exists("account").unwrap());
    assert_eq!(store.get("account").unwrap_err().code, "credential_missing");
    store.delete("account").unwrap();
    assert_eq!(fs::read_dir(&vault).unwrap().count(), 0);
    store.set("account", "secret").unwrap();
    assert_eq!(store.get("account").unwrap().as_str(), "secret");
}

#[test]
fn passwords_empty_passphrases_and_pasted_keys_survive_a_new_store_instance() {
    let root = tempfile::tempdir().unwrap();
    let key = "{\"version\":1,\"privateKey\":\"isolated-key\\n\",\"passphrase\":\"口令\"}";
    {
        let store = LocalCredentialStore::new(root.path().into());
        store.set("password", "密码-123").unwrap();
        store.set("empty-key-passphrase", "").unwrap();
        store.set("pasted-key", key).unwrap();
    }
    let reopened = LocalCredentialStore::new(root.path().into());
    assert_eq!(reopened.get("password").unwrap().as_str(), "密码-123");
    assert_eq!(reopened.get("empty-key-passphrase").unwrap().as_str(), "");
    assert_eq!(reopened.get("pasted-key").unwrap().as_str(), key);
    assert!(reopened.exists("password").unwrap());
    assert!(reopened.exists("empty-key-passphrase").unwrap());
    assert!(!root.path().join("profiles.json").exists());
}

#[test]
fn disk_records_and_temporary_files_never_contain_plaintext() {
    let root = tempfile::tempdir().unwrap();
    let secret = "unique-credential-value-not-for-disk-781064";
    let store = LocalCredentialStore::new(root.path().into());
    store
        .set("unique-account-not-for-filenames", secret)
        .unwrap();
    for entry in fs::read_dir(directory(root.path())).unwrap() {
        let path = entry.unwrap().path();
        let bytes = fs::read(&path).unwrap();
        assert!(
            !bytes
                .windows(secret.len())
                .any(|part| part == secret.as_bytes())
        );
        assert!(
            !path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains("unique-account")
        );
    }
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 3);
}

#[test]
fn updates_use_a_new_nonce_and_keep_the_original_key() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("account", "same-secret").unwrap();
    let path = records(root.path()).pop().unwrap();
    let before = fs::read(&path).unwrap();
    let key = fs::read(directory(root.path()).join("master.key")).unwrap();
    store.set("account", "same-secret").unwrap();
    assert_ne!(fs::read(&path).unwrap(), before);
    assert_eq!(
        fs::read(directory(root.path()).join("master.key")).unwrap(),
        key
    );
    assert_eq!(store.get("account").unwrap().as_str(), "same-secret");
    assert_eq!(records(root.path()).len(), 1);
}

#[test]
fn forgetting_is_idempotent_and_preserves_other_accounts_and_key() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("first", "secret-one").unwrap();
    store.set("second", "secret-two").unwrap();
    let key = fs::read(directory(root.path()).join("master.key")).unwrap();
    store.delete("first").unwrap();
    store.delete("first").unwrap();
    assert!(!store.exists("first").unwrap());
    assert_eq!(store.get("second").unwrap().as_str(), "secret-two");
    store.delete("second").unwrap();
    store.set("third", "secret-three").unwrap();
    assert_eq!(
        fs::read(directory(root.path()).join("master.key")).unwrap(),
        key
    );
}

#[test]
fn status_does_not_decrypt_a_record_and_corrupt_records_can_be_explicitly_forgotten() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("account", "secret").unwrap();
    let path = records(root.path()).pop().unwrap();
    fs::write(&path, b"corrupt-record").unwrap();
    assert!(store.exists("account").unwrap());
    assert_eq!(
        store.get("account").unwrap_err().code,
        "credential_unavailable"
    );
    fs::remove_file(directory(root.path()).join("master.key")).unwrap();
    store.delete("account").unwrap();
    assert!(!path.exists());
    assert!(!store.exists("account").unwrap());
}

#[test]
fn copied_ciphertext_cannot_authenticate_as_another_account() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("first", "secret-one").unwrap();
    let first = records(root.path()).pop().unwrap();
    store.set("second", "secret-two").unwrap();
    let second = records(root.path())
        .into_iter()
        .find(|path| path != &first)
        .unwrap();
    fs::copy(first, second).unwrap();
    assert_eq!(
        store.get("second").unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(store.get("first").unwrap().as_str(), "secret-one");
}

#[test]
fn tampering_unknown_versions_and_truncation_fail_without_rewriting_records() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("account", "sensitive-not-for-errors").unwrap();
    let path = records(root.path()).pop().unwrap();
    let original = fs::read(&path).unwrap();
    for index in [0, 12, original.len() - 1] {
        let mut changed = original.clone();
        changed[index] ^= 1;
        fs::write(&path, &changed).unwrap();
        let error = store.get("account").unwrap_err();
        assert_eq!(error.code, "credential_unavailable");
        assert!(!error.message.contains("sensitive-not-for-errors"));
        assert_eq!(fs::read(&path).unwrap(), changed);
    }
    fs::write(&path, &original[..12]).unwrap();
    assert_eq!(
        store.get("account").unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(fs::read(&path).unwrap(), &original[..12]);
    store.delete("account").unwrap();
    assert!(!store.exists("account").unwrap());
}

#[test]
fn missing_or_broken_keys_never_replace_a_key_or_existing_ciphertext() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("old", "still-needed").unwrap();
    let key_path = directory(root.path()).join("master.key");
    let record_path = records(root.path()).pop().unwrap();
    let original = fs::read(&record_path).unwrap();
    fs::remove_file(&key_path).unwrap();
    assert_eq!(store.get("old").unwrap_err().code, "credential_unavailable");
    assert_eq!(
        store.exists("old").unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(
        store.set("new", "replacement").unwrap_err().code,
        "credential_unavailable"
    );
    assert!(!key_path.exists());
    fs::write(&key_path, b"invalid-key").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(
        store.set("new", "replacement").unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(fs::read(&key_path).unwrap(), b"invalid-key");
    assert_eq!(fs::read(&record_path).unwrap(), original);
    assert_eq!(records(root.path()).len(), 1);
}

#[test]
fn a_wrong_installation_key_cannot_decrypt_or_silently_overwrite_a_record() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(first.path().into());
    let other = LocalCredentialStore::new(second.path().into());
    store.set("account", "first-secret").unwrap();
    other.set("account", "other-secret").unwrap();
    let key_path = directory(first.path()).join("master.key");
    assert_ne!(
        fs::read(&key_path).unwrap(),
        fs::read(directory(second.path()).join("master.key")).unwrap()
    );
    fs::copy(directory(second.path()).join("master.key"), key_path).unwrap();
    let path = records(first.path()).pop().unwrap();
    let original = fs::read(&path).unwrap();
    assert_eq!(
        store.get("account").unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(
        store.set("account", "new-secret").unwrap_err().code,
        "credential_unavailable"
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn huge_input_and_existing_oversized_records_fail_without_plaintext_or_replacement() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    let huge = "x".repeat(8 * 1024 * 1024 + 1);
    assert!(store.set("account", &huge).is_err());
    assert!(!directory(root.path()).exists());
    store.set("account", "original-secret").unwrap();
    let path = records(root.path()).pop().unwrap();
    let original = fs::read(&path).unwrap();
    assert!(store.set("account", &huge).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(16 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        store.get("account").unwrap_err().code,
        "credential_unavailable"
    );
    assert!(store.set("account", "replacement").is_err());
    assert_eq!(fs::metadata(path).unwrap().len(), 16 * 1024 * 1024);
}

#[test]
fn account_names_cannot_escape_the_private_directory() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("../outside-secret", "value").unwrap();
    assert_eq!(store.get("../outside-secret").unwrap().as_str(), "value");
    assert!(!root.path().join("outside-secret").exists());
    for invalid in ["", "bad\0account", "bad\naccount"] {
        assert!(store.set(invalid, "value").is_err());
    }
}

#[test]
fn concurrent_first_saves_share_a_key_and_preserve_every_record() {
    let root = tempfile::tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(12));
    thread::scope(|scope| {
        for index in 0..12 {
            let barrier = barrier.clone();
            let path = root.path().to_owned();
            scope.spawn(move || {
                let store = LocalCredentialStore::new(path);
                barrier.wait();
                store
                    .set(&format!("account-{index}"), &format!("secret-{index}"))
                    .unwrap();
            });
        }
    });
    let store = LocalCredentialStore::new(root.path().into());
    for index in 0..12 {
        assert_eq!(
            store.get(&format!("account-{index}")).unwrap().as_str(),
            format!("secret-{index}")
        );
    }
    assert_eq!(records(root.path()).len(), 12);
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 14);
}

#[test]
fn subprocess_save_fixture() {
    let Some(root) = std::env::var_os("FILEWORKER_CREDENTIAL_FIXTURE_ROOT") else {
        return;
    };
    let index = std::env::var("FILEWORKER_CREDENTIAL_FIXTURE_INDEX").unwrap();
    let store = LocalCredentialStore::new(root.into());
    store
        .set(&format!("process-{index}"), &format!("value-{index}"))
        .unwrap();
}

#[test]
fn independent_processes_initialize_one_store_without_losing_records() {
    let root = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    for index in 0..8 {
        children.push(
            std::process::Command::new(&executable)
                .args(["--exact", "subprocess_save_fixture"])
                .env("FILEWORKER_CREDENTIAL_FIXTURE_ROOT", root.path())
                .env("FILEWORKER_CREDENTIAL_FIXTURE_INDEX", index.to_string())
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
    }
    let results: Vec<_> = children
        .iter_mut()
        .map(|child| child.wait().unwrap())
        .collect();
    assert!(results.iter().all(|status| status.success()));
    let store = LocalCredentialStore::new(root.path().into());
    for index in 0..8 {
        assert_eq!(
            store.get(&format!("process-{index}")).unwrap().as_str(),
            format!("value-{index}")
        );
    }
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 10);
}

#[test]
fn a_contended_store_lock_times_out_instead_of_blocking_authentication_forever() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("account", "original").unwrap();
    let lock = fs::File::open(directory(root.path()).join("store.lock")).unwrap();
    lock.lock().unwrap();
    let started = Instant::now();
    let error = store.set("account", "replacement").unwrap_err();
    assert_eq!(error.code, "credential_unavailable");
    assert!(started.elapsed() < Duration::from_secs(4));
    drop(lock);
    assert_eq!(store.get("account").unwrap().as_str(), "original");
}

#[test]
fn a_failed_record_replacement_preserves_other_secrets_and_cleans_staging() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("good", "keep-me").unwrap();
    let good = records(root.path()).pop().unwrap();
    store.set("bad", "blocked").unwrap();
    let bad = records(root.path())
        .into_iter()
        .find(|path| path != &good)
        .unwrap();
    fs::remove_file(&bad).unwrap();
    fs::create_dir(&bad).unwrap();
    assert!(store.set("bad", "replacement").is_err());
    assert!(bad.is_dir());
    assert_eq!(store.get("good").unwrap().as_str(), "keep-me");
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 4);
}

#[cfg(unix)]
#[test]
fn store_files_and_directory_are_owner_only_and_unsafe_existing_permissions_are_rejected() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    store.set("account", "secret").unwrap();
    let vault = directory(root.path());
    assert_eq!(
        fs::metadata(&vault).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for item in fs::read_dir(&vault).unwrap() {
        assert_eq!(
            item.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let key = vault.join("master.key");
    fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        store.get("account").unwrap_err().code,
        "credential_unavailable"
    );
    assert!(store.set("another", "value").is_err());
    assert_eq!(
        fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o644
    );
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(store.get("account").is_err());
    assert!(store.delete("account").is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_directories_keys_locks_and_records_are_never_followed() {
    use std::os::unix::fs::symlink;
    for filename in ["master.key", "store.lock", "record"] {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().into());
        store.set("account", "secret").unwrap();
        let target = if filename == "record" {
            records(root.path()).pop().unwrap()
        } else {
            directory(root.path()).join(filename)
        };
        let external = outside.path().join("external");
        fs::write(&external, b"must-not-change").unwrap();
        fs::remove_file(&target).unwrap();
        symlink(&external, &target).unwrap();
        assert!(store.get("account").is_err(), "{filename}");
        assert!(store.set("account", "replacement").is_err(), "{filename}");
        if filename != "master.key" {
            assert!(store.delete("account").is_err(), "{filename}");
        }
        assert_eq!(fs::read(external).unwrap(), b"must-not-change");
        assert!(
            fs::symlink_metadata(target)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), directory(root.path())).unwrap();
    let store = LocalCredentialStore::new(root.path().into());
    assert!(store.set("account", "secret").is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn hard_linked_key_lock_or_record_is_rejected_without_modifying_the_other_link() {
    for filename in ["master.key", "store.lock", "record"] {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().into());
        store.set("account", "secret").unwrap();
        let path = if filename == "record" {
            records(root.path()).pop().unwrap()
        } else {
            directory(root.path()).join(filename)
        };
        let link = outside.path().join("other-link");
        fs::hard_link(&path, &link).unwrap();
        let before = fs::read(&link).unwrap();
        assert_eq!(
            store.get("account").unwrap_err().code,
            "credential_unavailable"
        );
        assert!(store.set("account", "replacement").is_err());
        if filename != "master.key" {
            assert!(store.delete("account").is_err());
        }
        assert_eq!(fs::read(link).unwrap(), before);
    }
}
