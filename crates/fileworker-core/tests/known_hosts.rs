use fileworker_core::known_hosts::{HostIdentity, KnownHostStore};
use std::{fs, sync::Arc, thread};

fn key(byte: u8) -> HostIdentity {
    HostIdentity::from_key("ssh-ed25519", &[byte; 32])
}

#[test]
fn unknown_host_requires_explicit_trust_and_port_is_part_of_identity() {
    let root = tempfile::tempdir().unwrap();
    let store = KnownHostStore::new(root.path().to_owned());
    assert!(!store.check("EXAMPLE.com", 22, &key(1)).unwrap());
    assert!(!root.path().join("known_hosts.json").exists());
    store.trust("EXAMPLE.com", 22, &key(1)).unwrap();
    let reopened = KnownHostStore::new(root.path().to_owned());
    assert!(reopened.check("example.com", 22, &key(1)).unwrap());
    assert!(!reopened.check("example.com", 2222, &key(1)).unwrap());
}

#[test]
fn changed_key_cannot_be_silently_retrusted() {
    let root = tempfile::tempdir().unwrap();
    let store = KnownHostStore::new(root.path().to_owned());
    store.trust("example.com", 22, &key(1)).unwrap();
    let original = fs::read(root.path().join("known_hosts.json")).unwrap();
    assert_eq!(
        store.check("example.com", 22, &key(2)).unwrap_err().code,
        "host_key_changed"
    );
    assert_eq!(
        store.trust("example.com", 22, &key(2)).unwrap_err().code,
        "host_key_changed"
    );
    assert_eq!(
        fs::read(root.path().join("known_hosts.json")).unwrap(),
        original
    );
}

#[test]
fn corrupt_trust_file_is_preserved_and_blocks_new_trust() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("known_hosts.json");
    fs::write(&path, b"{broken").unwrap();
    let store = KnownHostStore::new(root.path().to_owned());
    assert_eq!(
        store.check("example.com", 22, &key(1)).unwrap_err().code,
        "invalid_known_hosts"
    );
    assert!(store.trust("example.com", 22, &key(1)).is_err());
    assert_eq!(fs::read(path).unwrap(), b"{broken");
}

#[test]
fn concurrent_trust_preserves_all_hosts() {
    let root = tempfile::tempdir().unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(4));
    let handles: Vec<_> = (0..4)
        .map(|index| {
            let root = root.path().to_owned();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                KnownHostStore::new(root)
                    .trust(&format!("host-{index}"), 22, &key(index))
                    .unwrap();
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let store = KnownHostStore::new(root.path().to_owned());
    for index in 0..4 {
        assert!(
            store
                .check(&format!("host-{index}"), 22, &key(index))
                .unwrap()
        );
    }
}

#[cfg(unix)]
#[test]
fn trust_file_has_private_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    KnownHostStore::new(root.path().to_owned())
        .trust("localhost", 22, &key(1))
        .unwrap();
    let mode = fs::metadata(root.path().join("known_hosts.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}
