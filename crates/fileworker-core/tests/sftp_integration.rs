use fileworker_core::{
    connections::ConnectionManager,
    credentials::{CredentialStore, credential_account},
    error::CoreError,
    local_credentials::LocalCredentialStore,
    profile_service::ProfileService,
    profiles::{AuthMethod, ConnectionGroup, ConnectionProfile, ProfileStore},
    remote_files::{RemoteFileAction, RemotePreview},
    transfers::{
        ConflictPolicy, TransferDirection, TransferManager, TransferRequest, TransferState,
    },
};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Default)]
struct MemoryCredentials {
    values: Mutex<HashMap<String, String>>,
    reads: AtomicUsize,
    fail_writes: AtomicBool,
}
impl CredentialStore for MemoryCredentials {
    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.values
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Zeroizing::new)
            .ok_or_else(|| CoreError::new("credential_missing", "没有已保存凭据"))
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError> {
        if self.fail_writes.load(Ordering::SeqCst) {
            return Err(CoreError::new(
                "credential_unavailable",
                "测试安全存储不可用",
            ));
        }
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), CoreError> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }

    fn exists(&self, account: &str) -> Result<bool, CoreError> {
        Ok(self.values.lock().unwrap().contains_key(account))
    }
}

struct BlockingCredentials {
    memory: MemoryCredentials,
    block_read: bool,
    blocked: AtomicBool,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl BlockingCredentials {
    fn new(block_read: bool) -> (Arc<Self>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered, started) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        (
            Arc::new(Self {
                memory: MemoryCredentials::default(),
                block_read,
                blocked: AtomicBool::new(false),
                entered,
                release: Mutex::new(resume),
            }),
            started,
            release,
        )
    }

    fn wait(&self) {
        if self.blocked.swap(true, Ordering::SeqCst) {
            return;
        }
        self.entered.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
    }
}

impl CredentialStore for BlockingCredentials {
    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError> {
        if self.block_read {
            self.wait();
        }
        self.memory.get(account)
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError> {
        if !self.block_read {
            self.wait();
        }
        self.memory.set(account, secret)
    }

    fn delete(&self, account: &str) -> Result<(), CoreError> {
        self.memory.delete(account)
    }
}

struct PostCommitFailure {
    store: LocalCredentialStore,
    reported: AtomicBool,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl CredentialStore for PostCommitFailure {
    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError> {
        self.store.get(account)
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError> {
        self.store.set(account, secret)?;
        if !self.reported.swap(true, Ordering::SeqCst) {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            return Err(CoreError::new(
                "credential_unavailable",
                "injected post-commit sync failure",
            ));
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), CoreError> {
        self.store.delete(account)
    }
}

fn wait_until(condition: impl Fn() -> bool, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    condition()
}

struct Server {
    child: Child,
    port: u16,
    key_path: String,
    #[cfg(unix)]
    root: PathBuf,
}
impl Server {
    fn start(root: &Path, port: u16, key: &str) -> Self {
        Self::start_with_algorithms(root, port, key, false)
    }
    fn start_with_algorithms(root: &Path, port: u16, key: &str, repeated: bool) -> Self {
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let python = std::env::var_os("FILEWORKER_TEST_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| project.join("target/sftp-test-venv/bin/python"));
        let mut child = Command::new(python)
            .arg("-u")
            .arg(project.join("tests/fixtures/sftp_server.py"))
            .arg(root)
            .arg(port.to_string())
            .arg(key)
            .arg(if repeated {
                "repeat-algorithms"
            } else {
                "normal"
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start isolated SFTP fixture");
        let mut output = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut output)
            .unwrap();
        let ready: serde_json::Value =
            serde_json::from_str(&output).expect("SFTP fixture ready JSON");
        Self {
            child,
            port: ready["port"].as_u64().unwrap() as u16,
            key_path: ready["keyPath"].as_str().unwrap().into(),
            #[cfg(unix)]
            root: root.into(),
        }
    }
    fn profile(&self) -> ConnectionProfile {
        ConnectionProfile {
            id: "e6814610-8703-4c50-ab27-e823c8577fc3".into(),
            name: "隔离测试".into(),
            host: "127.0.0.1".into(),
            port: self.port,
            username: "tester".into(),
            auth_method: AuthMethod::Password,
            private_key_path: None,
            remote_path: ".".into(),
            group_id: None,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let denied = self.root.join("files/denied");
            if fs::symlink_metadata(&denied).is_ok_and(|metadata| metadata.is_dir()) {
                let _ = fs::set_permissions(denied, fs::Permissions::from_mode(0o700));
            }
        }
    }
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn secret(value: &str) -> Option<Zeroizing<String>> {
    Some(Zeroizing::new(value.into()))
}

#[cfg(unix)]
#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn isolated_server_restores_denied_directory_permissions_for_complete_fixture_cleanup() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().to_owned();
    let server = Server::start(fixture.path(), 0, "host");
    drop(server);
    let result = fixture.close();
    if result.is_err() {
        fs::set_permissions(path.join("files/denied"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir_all(&path).unwrap();
    }
    assert!(
        result.is_ok(),
        "SFTP fixture cleanup must remove all generated files"
    );
    assert!(!path.exists());
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn interrupted_local_credentials_initialization_can_be_retried_through_authentication() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let mut directory = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory
        .create(config.path().join("credentials-v1"))
        .unwrap();
    let store = Arc::new(LocalCredentialStore::new(config.path().into()));
    let manager =
        ConnectionManager::new(config.path().into(), fixture.path().into(), store.clone());
    let profile = server.profile();
    assert!(!manager.credential_status(&profile).unwrap().available);
    let attempt = id();
    manager.probe(attempt.clone(), profile.clone()).unwrap();
    manager.trust(&attempt).unwrap();
    let connected = manager
        .authenticate(&attempt, secret("test-password-only"), true)
        .unwrap();
    assert!(connected.warning.is_none());
    assert_eq!(
        store.get(&credential_account(&profile)).unwrap().as_str(),
        "test-password-only"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn canceled_post_commit_save_failures_restore_the_previous_local_credential() {
    let fixture = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    for previous in [None, Some("previous-saved-value")] {
        let config = tempfile::tempdir().unwrap();
        let local = LocalCredentialStore::new(config.path().into());
        let profile = server.profile();
        let account = credential_account(&profile);
        if let Some(previous) = previous {
            local.set(&account, previous).unwrap();
        }
        let (entered, started) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let store = Arc::new(PostCommitFailure {
            store: local,
            reported: AtomicBool::new(false),
            entered,
            release: Mutex::new(resume),
        });
        let manager = Arc::new(ConnectionManager::new(
            config.path().into(),
            fixture.path().into(),
            store.clone(),
        ));
        let attempt = id();
        manager.probe(attempt.clone(), profile).unwrap();
        manager.trust(&attempt).unwrap();
        let worker = {
            let manager = manager.clone();
            let attempt = attempt.clone();
            std::thread::spawn(move || {
                manager.authenticate(&attempt, secret("test-password-only"), true)
            })
        };
        started.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(store.get(&account).unwrap().as_str(), "test-password-only");
        manager.cancel(&attempt).unwrap();
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err().code, "attempt_expired");
        if let Some(previous) = previous {
            assert_eq!(store.get(&account).unwrap().as_str(), previous);
        } else {
            assert_eq!(store.get(&account).unwrap_err().code, "credential_missing");
        }
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn local_credentials_save_after_authentication_and_reconnect_after_restart() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let profile = server.profile();
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(LocalCredentialStore::new(config.path().into())),
    );
    let attempt = id();
    manager.probe(attempt.clone(), profile.clone()).unwrap();
    assert_eq!(
        manager
            .authenticate(&attempt, None, false)
            .unwrap_err()
            .code,
        "host_not_trusted"
    );
    assert!(!config.path().join("credentials-v1").exists());
    manager.trust(&attempt).unwrap();
    assert_eq!(
        manager
            .authenticate(&attempt, secret("wrong-password"), true)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    assert!(!config.path().join("credentials-v1").exists());
    let temporary = manager
        .authenticate(&attempt, secret("test-password-only"), false)
        .unwrap();
    assert!(!config.path().join("credentials-v1").exists());
    manager.disconnect(&temporary.session_id).unwrap();
    let attempt = id();
    manager.probe(attempt.clone(), profile.clone()).unwrap();
    let connected = manager
        .authenticate(&attempt, secret("test-password-only"), true)
        .unwrap();
    assert!(connected.warning.is_none());
    assert!(manager.credential_status(&profile).unwrap().available);
    manager.shutdown();
    drop(manager);

    let restarted = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(LocalCredentialStore::new(config.path().into())),
    );
    let attempt = id();
    assert!(
        restarted
            .probe(attempt.clone(), profile.clone())
            .unwrap()
            .trusted
    );
    let connected = restarted.authenticate(&attempt, None, false).unwrap();
    assert_eq!(
        restarted.list(&connected.session_id, "/").unwrap().path,
        "/"
    );
    restarted.forget_credential(&profile).unwrap();
    assert!(!restarted.credential_status(&profile).unwrap().available);
    assert_eq!(
        restarted.list(&connected.session_id, "/").unwrap().path,
        "/"
    );
    restarted.disconnect(&connected.session_id).unwrap();
    let attempt = id();
    restarted.probe(attempt.clone(), profile).unwrap();
    assert_eq!(
        restarted
            .authenticate(&attempt, None, false)
            .unwrap_err()
            .code,
        "credential_missing"
    );
    restarted.cancel(&attempt).unwrap();
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn local_credentials_key_files_and_pasted_keys_are_reusable_after_restart() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    for (method, filename, passphrase) in [
        (AuthMethod::PrivateKey, "client.pem", "test-key-passphrase"),
        (
            AuthMethod::PrivateKeyContent,
            "client-ed25519",
            "test-ed25519-passphrase",
        ),
        (AuthMethod::PrivateKeyContent, "client-plain", ""),
    ] {
        let mut profile = server.profile();
        profile.id = id();
        profile.auth_method = method.clone();
        let input = if method == AuthMethod::PrivateKey {
            profile.private_key_path = Some(fixture.path().join(filename).to_str().unwrap().into());
            passphrase.to_owned()
        } else {
            pasted_secret(fixture.path(), filename, passphrase)
        };
        let manager = ConnectionManager::new(
            config.path().into(),
            fixture.path().into(),
            Arc::new(LocalCredentialStore::new(config.path().into())),
        );
        let attempt = id();
        if !manager
            .probe(attempt.clone(), profile.clone())
            .unwrap()
            .trusted
        {
            manager.trust(&attempt).unwrap();
        }
        let connected = manager
            .authenticate(&attempt, secret(&input), true)
            .unwrap();
        assert!(connected.warning.is_none());
        assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
        manager.shutdown();
        drop(manager);
        let restarted = ConnectionManager::new(
            config.path().into(),
            fixture.path().into(),
            Arc::new(LocalCredentialStore::new(config.path().into())),
        );
        let attempt = id();
        assert!(
            restarted
                .probe(attempt.clone(), profile.clone())
                .unwrap()
                .trusted
        );
        let connected = restarted.authenticate(&attempt, None, false).unwrap();
        assert!(connected.warning.is_none());
        assert_eq!(
            restarted.list(&connected.session_id, "/").unwrap().path,
            "/"
        );
        restarted.forget_credential(&profile).unwrap();
        assert!(!restarted.credential_status(&profile).unwrap().available);
        assert_eq!(
            restarted.list(&connected.session_id, "/").unwrap().path,
            "/"
        );
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn local_credentials_follow_profile_identity_without_affecting_other_connections() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let store = Arc::new(LocalCredentialStore::new(config.path().into()));
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        store.clone(),
    ));
    let profiles = ProfileService::new(ProfileStore::new(config.path().into()), manager.clone());
    let first = profiles.save(server.profile()).unwrap();
    let mut second = first.clone();
    second.id = id();
    profiles.save(second.clone()).unwrap();
    for profile in [&first, &second] {
        let attempt = id();
        let probe = profiles.probe(&profile.id, attempt.clone()).unwrap();
        if !probe.trusted {
            manager.trust(&attempt).unwrap();
        }
        assert!(
            manager
                .authenticate(&attempt, secret("test-password-only"), true)
                .unwrap()
                .warning
                .is_none()
        );
    }
    let mut renamed = first.clone();
    renamed.name = "renamed-fixture".into();
    profiles.save(renamed.clone()).unwrap();
    assert!(manager.credential_status(&renamed).unwrap().available);
    renamed.username = "new-fixture-identity".into();
    profiles.save(renamed.clone()).unwrap();
    assert!(!store.exists(&credential_account(&first)).unwrap());
    assert!(!manager.credential_status(&renamed).unwrap().available);
    assert!(manager.credential_status(&second).unwrap().available);
    profiles.delete(&second.id).unwrap();
    assert!(!store.exists(&credential_account(&second)).unwrap());
    assert_eq!(profiles.store().list().unwrap(), vec![renamed]);
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn local_credentials_storage_failure_keeps_the_authenticated_session_usable() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    fs::write(config.path().join("credentials-v1"), b"blocked-store-path").unwrap();
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(LocalCredentialStore::new(config.path().into())),
    );
    let attempt = id();
    manager.probe(attempt.clone(), server.profile()).unwrap();
    manager.trust(&attempt).unwrap();
    let connected = manager
        .authenticate(&attempt, secret("test-password-only"), true)
        .unwrap();
    assert!(
        connected
            .warning
            .as_deref()
            .unwrap()
            .contains("本地加密存储")
    );
    assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
    assert_eq!(
        fs::read(config.path().join("credentials-v1")).unwrap(),
        b"blocked-store-path"
    );
}

fn connected_manager(
    root: &Path,
    config: &Path,
    server: &Server,
) -> (Arc<ConnectionManager>, String) {
    let remote = Arc::new(ConnectionManager::new(
        config.into(),
        root.into(),
        Arc::new(MemoryCredentials::default()),
    ));
    let attempt = id();
    remote.probe(attempt.clone(), server.profile()).unwrap();
    remote.trust(&attempt).unwrap();
    let session = remote
        .authenticate(&attempt, secret("test-password-only"), false)
        .unwrap();
    (remote, session.session_id)
}

fn connect_profile(manager: &ConnectionManager, profile: ConnectionProfile) -> (String, String) {
    let attempt = id();
    if !manager.probe(attempt.clone(), profile).unwrap().trusted {
        manager.trust(&attempt).unwrap();
    }
    let session = manager
        .authenticate(&attempt, secret("test-password-only"), false)
        .unwrap();
    (attempt, session.session_id)
}

#[cfg(unix)]
#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_directory_deadline_bounds_the_whole_operation_not_each_individual_response() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let remote = ConnectionManager::with_timeouts(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(500),
        Duration::from_secs(120),
    );
    let (_, session) = connect_profile(&remote, server.profile());
    for index in 0..40 {
        symlink(
            "hello.txt",
            fixture.path().join(format!("files/link-{index}")),
        )
        .unwrap();
    }
    fs::write(fixture.path().join("slow-stats"), b"enabled").unwrap();
    let started = Instant::now();
    let result = remote.list(&session, "/");
    let elapsed = started.elapsed();
    assert!(
        result
            .as_ref()
            .is_err_and(|error| matches!(error.code, "connection_lost" | "session_closed")),
        "the full directory request must time out rather than succeed after {elapsed:?}"
    );
    assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
    assert!(!remote.is_session_active(&session));
}

#[cfg(unix)]
#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_directory_deadline_includes_time_queued_behind_another_operation() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let remote = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(1200),
        Duration::from_secs(120),
    ));
    let (_, session) = connect_profile(&remote, server.profile());
    for index in 0..14 {
        symlink(
            "hello.txt",
            fixture.path().join(format!("files/link-{index}")),
        )
        .unwrap();
    }
    fs::write(fixture.path().join("slow-stats"), b"enabled").unwrap();
    let listing = {
        let remote = remote.clone();
        let session = session.clone();
        std::thread::spawn(move || remote.list(&session, "/"))
    };
    let entered = wait_until(
        || fixture.path().join("stat-entered").exists(),
        Duration::from_secs(2),
    );
    let started = Instant::now();
    let queued = remote.list(&session, "/");
    let elapsed = started.elapsed();
    let first = listing.join().unwrap();
    assert!(entered);
    first.unwrap();
    assert_eq!(
        queued.unwrap_err().code,
        "connection_lost",
        "queueing must not grant the operation another full timeout"
    );
    assert!(elapsed < Duration::from_millis(1800), "{elapsed:?}");
    assert!(!remote.is_session_active(&session));
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn health_check_detects_an_idle_server_close_without_disconnecting_another_session() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server_a = Server::start(first.path(), 0, "host");
    let server_b = Server::start(second.path(), 0, "host");
    let (remote, session_a) = connected_manager(first.path(), config.path(), &server_a);
    let mut profile_b = server_b.profile();
    profile_b.id = id();
    let (_, session_b) = connect_profile(&remote, profile_b);
    remote.check_session(&session_a).unwrap();
    remote.check_session(&session_b).unwrap();
    assert_eq!(
        fs::read_to_string(first.path().join("connections"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    drop(server_a);
    assert_eq!(
        remote.check_session(&session_a).unwrap_err().code,
        "connection_lost"
    );
    assert!(!remote.is_session_active(&session_a));
    assert_eq!(
        remote.check_session(&session_a).unwrap_err().code,
        "session_closed"
    );
    assert!(remote.is_session_active(&session_b));
    assert_eq!(remote.list(&session_b, "/folder").unwrap().path, "/folder");
    assert_eq!(
        fs::read_to_string(second.path().join("connections"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn health_check_treats_permission_responses_as_live_but_transport_statuses_as_lost() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    fs::write(fixture.path().join("stat-error"), b"3").unwrap();
    remote.check_session(&session).unwrap();
    assert!(remote.is_session_active(&session));
    fs::remove_file(fixture.path().join("stat-error")).unwrap();
    assert_eq!(remote.list(&session, "/").unwrap().path, "/");
    for code in [6, 7] {
        let (_, session) = connect_profile(&remote, server.profile());
        fs::write(fixture.path().join("stat-error"), code.to_string()).unwrap();
        assert_eq!(
            remote.check_session(&session).unwrap_err().code,
            "connection_lost"
        );
        assert!(!remote.is_session_active(&session));
        fs::remove_file(fixture.path().join("stat-error")).unwrap();
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn health_check_does_not_queue_behind_a_busy_session_and_unresponsive_requests_expire() {
    let fixture = tempfile::tempdir().unwrap();
    let other_fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let other_server = Server::start(other_fixture.path(), 0, "host");
    let remote = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(600),
        Duration::from_secs(120),
    ));
    let (_, session) = connect_profile(&remote, server.profile());
    let mut other_profile = other_server.profile();
    other_profile.id = id();
    let (_, other_session) = connect_profile(&remote, other_profile);
    fs::write(fixture.path().join("pause-stat"), b"enabled").unwrap();
    let (done, finished) = mpsc::channel();
    let checking = {
        let remote = remote.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            let result = remote.check_session(&session);
            done.send(result).unwrap();
        })
    };
    let entered = wait_until(
        || fixture.path().join("stat-entered").exists(),
        Duration::from_secs(2),
    );
    let started = Instant::now();
    let busy_result = remote.check_session(&session);
    let busy_elapsed = started.elapsed();
    remote.check_session(&other_session).unwrap();
    assert_eq!(remote.list(&other_session, "/").unwrap().path, "/");
    let outcome = finished.recv_timeout(Duration::from_secs(2));
    fs::remove_file(fixture.path().join("pause-stat")).unwrap();
    checking.join().unwrap();
    assert!(entered, "fixture must receive a real SFTP health request");
    busy_result.unwrap();
    assert!(
        busy_elapsed < Duration::from_millis(200),
        "{busy_elapsed:?}"
    );
    assert_eq!(outcome.unwrap().unwrap_err().code, "connection_lost");
    assert!(!remote.is_session_active(&session));
    assert!(remote.is_session_active(&other_session));
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_mutation_timeout_closes_its_session_without_replaying_the_write() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let remote = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(500),
        Duration::from_secs(120),
    ));
    let (_, session) = connect_profile(&remote, server.profile());
    let queue = TransferManager::new(remote.clone());
    fs::write(fixture.path().join("pause-mutation"), b"enabled").unwrap();
    let started = Instant::now();
    let result = queue.mutate_remote_file(
        &session,
        "/",
        RemoteFileAction::CreateDirectory {
            name: "unknown-result".into(),
        },
    );
    let elapsed = started.elapsed();
    fs::remove_file(fixture.path().join("pause-mutation")).unwrap();
    assert!(fixture.path().join("mutation-entered").exists());
    assert_eq!(result.unwrap_err().code, "connection_lost");
    assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
    assert!(!remote.is_session_active(&session));
    assert_eq!(
        queue
            .mutate_remote_file(
                &session,
                "/",
                RemoteFileAction::CreateDirectory {
                    name: "not-replayed".into()
                },
            )
            .unwrap_err()
            .code,
        "session_closed"
    );
    assert!(!fixture.path().join("files/not-replayed").exists());
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn a_mutation_executed_before_a_lost_reply_is_reported_as_unknown_and_not_replayed() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let remote = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(500),
        Duration::from_secs(120),
    ));
    let (_, session) = connect_profile(&remote, server.profile());
    let queue = TransferManager::new(remote.clone());
    fs::write(fixture.path().join("pause-mutation-reply"), b"enabled").unwrap();
    let result = queue.mutate_remote_file(
        &session,
        "/",
        RemoteFileAction::CreateDirectory {
            name: "already-created".into(),
        },
    );
    fs::remove_file(fixture.path().join("pause-mutation-reply")).unwrap();
    assert_eq!(result.unwrap_err().code, "connection_lost");
    assert!(!remote.is_session_active(&session));
    assert!(fixture.path().join("files/already-created").is_dir());
    assert_eq!(
        fs::read_to_string(fixture.path().join("mutation-requests")).unwrap(),
        "requested\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.path().join("mutation-replies")).unwrap(),
        "executed\n"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn canceled_health_checks_cannot_close_a_replacement_session_for_the_same_profile() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, old_session) = connected_manager(fixture.path(), config.path(), &server);
    fs::write(fixture.path().join("pause-stat"), b"enabled").unwrap();
    let checking = {
        let remote = remote.clone();
        let old_session = old_session.clone();
        std::thread::spawn(move || remote.check_session(&old_session))
    };
    let entered = wait_until(
        || fixture.path().join("stat-entered").exists(),
        Duration::from_secs(2),
    );
    let (_, new_session) = connect_profile(&remote, server.profile());
    fs::remove_file(fixture.path().join("pause-stat")).unwrap();
    let old_result = checking.join().unwrap();
    assert!(entered);
    assert_eq!(old_result.unwrap_err().code, "session_closed");
    assert!(!remote.is_session_active(&old_session));
    assert!(remote.is_session_active(&new_session));
    remote.check_session(&new_session).unwrap();
    assert_eq!(remote.list(&new_session, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn completed_operations_do_not_leave_deadlines_that_disconnect_idle_live_sessions() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let remote = ConnectionManager::with_timeouts(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(400),
        Duration::from_secs(120),
    );
    let (_, session) = connect_profile(&remote, server.profile());
    assert_eq!(remote.list(&session, "/").unwrap().path, "/");
    remote.check_session(&session).unwrap();
    assert!(!wait_until(
        || !remote.is_session_active(&session),
        Duration::from_millis(900),
    ));
    remote.check_session(&session).unwrap();
    assert_eq!(remote.list(&session, "/").unwrap().path, "/");
}

fn transfer_request(
    session: &str,
    source: &str,
    destination: &str,
    upload: bool,
) -> TransferRequest {
    TransferRequest {
        session_id: session.into(),
        source_path: source.into(),
        destination_dir: destination.into(),
        direction: if upload {
            TransferDirection::Upload
        } else {
            TransferDirection::Download
        },
    }
}

fn wait_for_job(queue: &TransferManager, job: &str, state: TransferState) {
    assert!(
        wait_until(
            || queue
                .snapshot()
                .unwrap()
                .jobs
                .iter()
                .any(|item| item.id == job && item.state == state),
            Duration::from_secs(15)
        ),
        "expected {state:?}, snapshot: {:?}",
        queue.snapshot().unwrap()
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_browsing_and_transfers_survive_another_profile_connecting_and_disconnecting() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let downloads = tempfile::tempdir().unwrap();
    let server_a = Server::start(first.path(), 0, "host");
    let server_b = Server::start(second.path(), 0, "host");
    let (remote, session_a) = connected_manager(first.path(), config.path(), &server_a);
    fs::write(first.path().join("slow-transfers"), b"enabled").unwrap();
    let data = vec![71; 2 * 1024 * 1024];
    let upload_a = local.path().join("only-a.bin");
    let upload_b = local.path().join("only-b.txt");
    fs::write(&upload_a, &data).unwrap();
    fs::write(&upload_b, b"second server").unwrap();
    let queue = TransferManager::new(remote.clone());
    let jobs_a = queue
        .enqueue(vec![transfer_request(
            &session_a,
            upload_a.to_str().unwrap(),
            "/",
            true,
        )])
        .unwrap();
    assert!(wait_until(
        || queue.snapshot().unwrap().jobs[0].transferred_bytes > 0,
        Duration::from_secs(5)
    ));
    let mut profile_b = server_b.profile();
    profile_b.id = id();
    let attempt_b = id();
    remote.probe(attempt_b.clone(), profile_b).unwrap();
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    remote.trust(&attempt_b).unwrap();
    let session_b = remote
        .authenticate(&attempt_b, secret("test-password-only"), false)
        .unwrap()
        .session_id;
    assert_ne!(session_a, session_b);
    assert!(remote.is_session_active(&session_a));
    assert_eq!(remote.list(&session_b, "/folder").unwrap().path, "/folder");
    let jobs_b = queue
        .enqueue(vec![transfer_request(
            &session_b,
            upload_b.to_str().unwrap(),
            "/",
            true,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs_b[0], TransferState::Completed);
    remote.disconnect(&session_b).unwrap();
    assert_eq!(
        remote.list(&session_b, "/").unwrap_err().code,
        "session_closed"
    );
    wait_for_job(&queue, &jobs_a[0], TransferState::Completed);
    assert_eq!(
        fs::read(first.path().join("files/only-a.bin")).unwrap(),
        data
    );
    assert_eq!(
        fs::read(second.path().join("files/only-b.txt")).unwrap(),
        b"second server"
    );
    assert!(!first.path().join("files/only-b.txt").exists());
    assert!(!second.path().join("files/only-a.bin").exists());
    let download = queue
        .enqueue(vec![transfer_request(
            &session_a,
            "/only-a.bin",
            downloads.path().to_str().unwrap(),
            false,
        )])
        .unwrap();
    wait_for_job(&queue, &download[0], TransferState::Completed);
    assert_eq!(fs::read(downloads.path().join("only-a.bin")).unwrap(), data);
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_failed_canceled_and_superseded_attempts_preserve_authenticated_sessions() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session_a) = connected_manager(fixture.path(), config.path(), &server);
    let mut profile_b = server.profile();
    profile_b.id = id();
    let failed = id();
    remote.probe(failed.clone(), profile_b.clone()).unwrap();
    assert_eq!(
        remote
            .authenticate(&failed, secret("wrong"), false)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    remote.cancel(&failed).unwrap();
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    let pending = id();
    remote.probe(pending.clone(), profile_b.clone()).unwrap();
    remote.cancel(&pending).unwrap();
    assert_eq!(remote.trust(&pending).unwrap_err().code, "attempt_expired");
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    let superseded = id();
    remote.probe(superseded.clone(), profile_b.clone()).unwrap();
    let replacement = id();
    remote.probe(replacement.clone(), profile_b).unwrap();
    remote.cancel(&superseded).unwrap();
    assert_eq!(
        remote.trust(&superseded).unwrap_err().code,
        "attempt_expired"
    );
    let session_b = remote
        .authenticate(&replacement, secret("test-password-only"), false)
        .unwrap();
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    assert_eq!(remote.list(&session_b.session_id, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_cancel_by_attempt_and_disconnect_by_session_are_targeted() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let remote = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
    );
    let (attempt_a, session_a) = connect_profile(&remote, server.profile());
    let mut profile_b = server.profile();
    profile_b.id = id();
    let (attempt_b, session_b) = connect_profile(&remote, profile_b.clone());
    remote.cancel(&attempt_b).unwrap();
    remote.cancel(&attempt_b).unwrap();
    assert_eq!(
        remote.list(&session_b, "/").unwrap_err().code,
        "session_closed"
    );
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    let (_, session_b) = connect_profile(&remote, profile_b);
    remote.disconnect(&session_a).unwrap();
    remote.disconnect(&session_a).unwrap();
    remote.disconnect(&id()).unwrap();
    remote.cancel(&attempt_a).unwrap();
    assert_eq!(
        remote.list(&session_a, "/").unwrap_err().code,
        "session_closed"
    );
    assert_eq!(remote.list(&session_b, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_profile_disconnect_preserves_other_active_and_pending_profiles() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session_a) = connected_manager(fixture.path(), config.path(), &server);
    let mut profile_b = server.profile();
    profile_b.id = id();
    let (_, session_b) = connect_profile(&remote, profile_b.clone());
    let mut profile_c = server.profile();
    profile_c.id = id();
    let attempt_c = id();
    remote.probe(attempt_c.clone(), profile_c.clone()).unwrap();
    remote.disconnect_profile(&profile_b.id).unwrap();
    assert_eq!(
        remote.list(&session_b, "/").unwrap_err().code,
        "session_closed"
    );
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    let session_c = remote
        .authenticate(&attempt_c, secret("test-password-only"), false)
        .unwrap();
    let pending_b = id();
    remote.probe(pending_b.clone(), profile_b.clone()).unwrap();
    remote.disconnect_profile(&profile_b.id).unwrap();
    remote.disconnect_profile(&profile_b.id).unwrap();
    assert_eq!(
        remote.trust(&pending_b).unwrap_err().code,
        "attempt_expired"
    );
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    assert_eq!(remote.list(&session_c.session_id, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_same_profile_replaces_only_after_successful_authentication() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session_a) = connected_manager(fixture.path(), config.path(), &server);
    let mut profile_b = server.profile();
    profile_b.id = id();
    let (_, session_b) = connect_profile(&remote, profile_b);
    let replacement = id();
    remote.probe(replacement.clone(), server.profile()).unwrap();
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    assert_eq!(
        remote
            .authenticate(&replacement, secret("wrong"), false)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    let new = remote
        .authenticate(&replacement, secret("test-password-only"), false)
        .unwrap();
    assert_ne!(new.session_id, session_a);
    assert_eq!(
        remote.list(&session_a, "/").unwrap_err().code,
        "session_closed"
    );
    assert_eq!(remote.list(&new.session_id, "/").unwrap().path, "/");
    assert_eq!(remote.list(&session_b, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_profile_invalidation_does_not_close_other_profiles() {
    let fixture = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    for deleting in [true, false] {
        let config = tempfile::tempdir().unwrap();
        let remote = Arc::new(ConnectionManager::new(
            config.path().into(),
            fixture.path().into(),
            Arc::new(MemoryCredentials::default()),
        ));
        let service = ProfileService::new(ProfileStore::new(config.path().into()), remote.clone());
        let profile_a = service.save(server.profile()).unwrap();
        let mut profile_b = server.profile();
        profile_b.id = id();
        profile_b = service.save(profile_b).unwrap();
        let (_, session_a) = connect_profile(&remote, profile_a);
        let (_, session_b) = connect_profile(&remote, profile_b.clone());
        if deleting {
            service.delete(&profile_b.id).unwrap();
        } else {
            profile_b.username = "changed-account".into();
            service.save(profile_b).unwrap();
        }
        assert_eq!(
            remote.list(&session_b, "/").unwrap_err().code,
            "session_closed"
        );
        assert_eq!(remote.list(&session_a, "/").unwrap().path, "/");
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_shutdown_drains_transfers_then_closes_all_active_and_pending_connections() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session_a) = connected_manager(fixture.path(), config.path(), &server);
    let mut profile_b = server.profile();
    profile_b.id = id();
    let (_, session_b) = connect_profile(&remote, profile_b);
    let queue = TransferManager::new(remote.clone());
    queue.set_concurrency(1).unwrap();
    fs::write(fixture.path().join("slow-transfers"), b"enabled").unwrap();
    let source = local.path().join("shutdown.bin");
    fs::write(&source, vec![19; 2 * 1024 * 1024]).unwrap();
    let jobs = queue
        .enqueue(vec![
            transfer_request(&session_a, source.to_str().unwrap(), "/", true),
            transfer_request(&session_b, source.to_str().unwrap(), "/", true),
        ])
        .unwrap();
    assert!(wait_until(
        || queue.snapshot().unwrap().jobs[0].transferred_bytes > 0,
        Duration::from_secs(5)
    ));
    let mut profile_c = server.profile();
    profile_c.id = id();
    let pending = id();
    remote.probe(pending.clone(), profile_c).unwrap();
    queue.shutdown();
    remote.shutdown();
    remote.shutdown();
    for job in jobs {
        wait_for_job(&queue, &job, TransferState::Canceled);
    }
    for session in [&session_a, &session_b] {
        assert!(!remote.is_session_active(session));
        assert_eq!(
            remote.list(session, "/").unwrap_err().code,
            "session_closed"
        );
    }
    assert_eq!(remote.trust(&pending).unwrap_err().code, "attempt_expired");
    assert_eq!(
        remote
            .authenticate(&pending, secret("test-password-only"), false)
            .unwrap_err()
            .code,
        "attempt_expired"
    );
    assert_eq!(
        remote.probe(id(), server.profile()).unwrap_err().code,
        "session_closed"
    );
    assert!(!fixture.path().join("files/shutdown.bin").exists());
    assert!(
        !fs::read_dir(fixture.path().join("files"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".fileworker-"))
    );
    assert!(wait_until(
        || {
            fs::read_to_string(fixture.path().join("disconnect-events"))
                .unwrap_or_default()
                .lines()
                .count()
                == fs::read_to_string(fixture.path().join("connections"))
                    .unwrap()
                    .lines()
                    .count()
        },
        Duration::from_secs(2)
    ));
}

#[test]
fn multi_session_shutdown_interrupts_a_pending_handshake_and_rejects_new_probes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let config = tempfile::tempdir().unwrap();
    let profile = ConnectionProfile {
        id: id(),
        name: "shutdown handshake".into(),
        host: "127.0.0.1".into(),
        port: listener.local_addr().unwrap().port(),
        username: "tester".into(),
        auth_method: AuthMethod::Password,
        private_key_path: None,
        remote_path: ".".into(),
        group_id: None,
    };
    let manager = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        config.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_secs(3),
        Duration::from_secs(120),
    ));
    let (accepted, received) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        accepted.send(()).unwrap();
        let mut buffer = [0; 256];
        loop {
            match socket.read(&mut buffer) {
                Ok(0) => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    });
    let probe = {
        let manager = manager.clone();
        let profile = profile.clone();
        std::thread::spawn(move || manager.probe(id(), profile))
    };
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    let started = Instant::now();
    manager.shutdown();
    let elapsed = started.elapsed();
    let result = probe.join().unwrap();
    assert!(
        peer.join().unwrap(),
        "shutdown must close the registered socket"
    );
    assert!(elapsed < Duration::from_millis(600));
    assert_eq!(result.unwrap_err().code, "attempt_expired");
    assert_eq!(
        manager.probe(id(), profile).unwrap_err().code,
        "session_closed"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_shutdown_during_credential_save_cancels_without_waiting_and_rolls_back() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (credentials, started, release) = BlockingCredentials::new(false);
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    ));
    let (_, session) = connect_profile(&manager, server.profile());
    let mut profile = server.profile();
    profile.id = id();
    let account = credential_account(&profile);
    credentials
        .memory
        .set(&account, "previous-saved-value")
        .unwrap();
    let attempt = id();
    manager.probe(attempt.clone(), profile).unwrap();
    let auth = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            manager.authenticate(&attempt, secret("test-password-only"), true)
        })
    };
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    let start = Instant::now();
    manager.shutdown();
    let elapsed = start.elapsed();
    release.send(()).unwrap();
    let result = auth.join().unwrap();
    assert!(
        elapsed < Duration::from_millis(600),
        "shutdown must not wait on the vault"
    );
    assert_eq!(result.unwrap_err().code, "attempt_expired");
    assert_eq!(
        manager.list(&session, "/").unwrap_err().code,
        "session_closed"
    );
    assert_eq!(
        credentials.memory.get(&account).unwrap().as_str(),
        "previous-saved-value"
    );
    assert_eq!(
        manager.probe(id(), server.profile()).unwrap_err().code,
        "session_closed"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn multi_session_drop_closes_every_active_and_pending_socket() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
    );
    let (_, session_a) = connect_profile(&manager, server.profile());
    let mut profile_b = server.profile();
    profile_b.id = id();
    let (_, session_b) = connect_profile(&manager, profile_b);
    let mut profile_c = server.profile();
    profile_c.id = id();
    manager.probe(id(), profile_c).unwrap();
    assert_eq!(manager.list(&session_a, "/").unwrap().path, "/");
    assert_eq!(manager.list(&session_b, "/").unwrap().path, "/");
    drop(manager);
    assert!(wait_until(
        || {
            fs::read_to_string(fixture.path().join("disconnect-events"))
                .unwrap_or_default()
                .lines()
                .count()
                == 3
        },
        Duration::from_secs(2)
    ));
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn transfers_roundtrip_binary_empty_and_unicode_without_saving_credentials() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let downloads = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote.clone());
    let data: Vec<u8> = (0..300_013).map(|index| (index % 251) as u8).collect();
    fs::write(local.path().join("二进制.bin"), &data).unwrap();
    fs::write(local.path().join("empty.txt"), []).unwrap();
    let uploads = queue
        .enqueue(vec![
            transfer_request(
                &session,
                local.path().join("二进制.bin").to_str().unwrap(),
                "/",
                true,
            ),
            transfer_request(
                &session,
                local.path().join("empty.txt").to_str().unwrap(),
                "/",
                true,
            ),
        ])
        .unwrap();
    for job in &uploads {
        wait_for_job(&queue, job, TransferState::Completed);
    }
    assert_eq!(
        fs::read(fixture.path().join("files/二进制.bin")).unwrap(),
        data
    );
    let jobs = queue
        .enqueue(vec![
            transfer_request(
                &session,
                "/二进制.bin",
                downloads.path().to_str().unwrap(),
                false,
            ),
            transfer_request(
                &session,
                "/empty.txt",
                downloads.path().to_str().unwrap(),
                false,
            ),
        ])
        .unwrap();
    for job in &jobs {
        wait_for_job(&queue, job, TransferState::Completed);
    }
    assert_eq!(fs::read(downloads.path().join("二进制.bin")).unwrap(), data);
    assert_eq!(fs::read(downloads.path().join("empty.txt")).unwrap(), b"");
    assert_eq!(fs::read_dir(downloads.path()).unwrap().count(), 2);
    assert!(
        !serde_json::to_string(&queue.snapshot().unwrap())
            .unwrap()
            .contains("test-password-only")
    );
    assert!(remote.list(&session, "/").is_ok());
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn conflicts_never_silently_overwrite_and_support_skip_replace_and_keep_both() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    let source = local.path().join("hello.txt");
    fs::write(&source, b"new contents").unwrap();
    for policy in [
        ConflictPolicy::Skip,
        ConflictPolicy::KeepBoth,
        ConflictPolicy::Overwrite,
    ] {
        let jobs = queue
            .enqueue(vec![transfer_request(
                &session,
                source.to_str().unwrap(),
                "/",
                true,
            )])
            .unwrap();
        wait_for_job(&queue, &jobs[0], TransferState::Conflict);
        assert_eq!(
            fs::read(fixture.path().join("files/hello.txt")).unwrap(),
            b"hello"
        );
        queue.resolve_conflict(&jobs[0], policy).unwrap();
        wait_for_job(
            &queue,
            &jobs[0],
            if policy == ConflictPolicy::Skip {
                TransferState::Skipped
            } else {
                TransferState::Completed
            },
        );
        if policy == ConflictPolicy::KeepBoth {
            assert_eq!(
                fs::read(fixture.path().join("files/hello (1).txt")).unwrap(),
                b"new contents"
            );
        }
    }
    assert_eq!(
        fs::read(fixture.path().join("files/hello.txt")).unwrap(),
        b"new contents"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn cancel_cleans_partial_files_and_leaves_browsing_and_other_jobs_usable() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    fs::write(fixture.path().join("slow-transfers"), b"enabled").unwrap();
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote.clone());
    let source = local.path().join("large.bin");
    fs::write(&source, vec![71; 4 * 1024 * 1024]).unwrap();
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            source.to_str().unwrap(),
            "/",
            true,
        )])
        .unwrap();
    assert!(wait_until(
        || queue.snapshot().unwrap().jobs[0].transferred_bytes > 0,
        Duration::from_secs(5)
    ));
    queue.cancel(&jobs[0]).unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Canceled);
    assert!(!fixture.path().join("files/large.bin").exists());
    assert!(
        !fs::read_dir(fixture.path().join("files"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".fileworker-"))
    );
    assert!(remote.list(&session, "/").is_ok());
    fs::remove_file(fixture.path().join("slow-transfers")).unwrap();
    queue.retry(&jobs[0]).unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Completed);
    assert_eq!(
        fs::metadata(fixture.path().join("files/large.bin"))
            .unwrap()
            .len(),
        4 * 1024 * 1024
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn transfer_queue_limits_concurrency_and_disconnect_stops_old_session_jobs() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    fs::write(fixture.path().join("slow-transfers"), b"enabled").unwrap();
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote.clone());
    queue.set_concurrency(1).unwrap();
    let mut requests = Vec::new();
    for name in ["one.bin", "two.bin", "three.bin"] {
        let source = local.path().join(name);
        fs::write(&source, vec![7; 2 * 1024 * 1024]).unwrap();
        requests.push(transfer_request(
            &session,
            source.to_str().unwrap(),
            "/",
            true,
        ));
    }
    let jobs = queue.enqueue(requests).unwrap();
    assert!(wait_until(
        || queue
            .snapshot()
            .unwrap()
            .jobs
            .iter()
            .any(|job| job.transferred_bytes > 0),
        Duration::from_secs(5)
    ));
    let snapshot = queue.snapshot().unwrap();
    assert_eq!(
        snapshot
            .jobs
            .iter()
            .filter(|job| job.state == TransferState::Running)
            .count(),
        1
    );
    assert_eq!(
        snapshot
            .jobs
            .iter()
            .filter(|job| job.state == TransferState::Queued)
            .count(),
        2
    );
    remote.disconnect(&session).unwrap();
    for job in &jobs {
        wait_for_job(&queue, job, TransferState::Canceled);
    }
    assert!(queue.retry(&jobs[0]).is_err());
    assert!(
        queue
            .enqueue(vec![transfer_request(
                &session,
                "/hello.txt",
                local.path().to_str().unwrap(),
                false
            )])
            .is_err()
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn unsupported_sources_fail_independently_and_download_conflicts_preserve_originals() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    fs::write(local.path().join("hello.txt"), b"local original").unwrap();
    let jobs = queue
        .enqueue(vec![
            transfer_request(&session, "/folder", local.path().to_str().unwrap(), false),
            transfer_request(
                &session,
                "/hello.txt",
                local.path().to_str().unwrap(),
                false,
            ),
            transfer_request(&session, "/中文.txt", local.path().to_str().unwrap(), false),
        ])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Failed);
    wait_for_job(&queue, &jobs[1], TransferState::Conflict);
    wait_for_job(&queue, &jobs[2], TransferState::Completed);
    assert_eq!(
        fs::read(local.path().join("hello.txt")).unwrap(),
        b"local original"
    );
    queue
        .resolve_conflict(&jobs[1], ConflictPolicy::KeepBoth)
        .unwrap();
    wait_for_job(&queue, &jobs[1], TransferState::Completed);
    assert_eq!(
        fs::read(local.path().join("hello (1).txt")).unwrap(),
        b"hello"
    );
    assert_eq!(
        fs::read(local.path().join("hello.txt")).unwrap(),
        b"local original"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn targets_created_during_upload_and_download_are_not_overwritten() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    let source = local.path().join("raced.bin");
    fs::write(&source, vec![71; 2 * 1024 * 1024]).unwrap();
    fs::write(fixture.path().join("race-target"), b"raced.bin").unwrap();
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            source.to_str().unwrap(),
            "/",
            true,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Conflict);
    assert_eq!(
        fs::read(fixture.path().join("files/raced.bin")).unwrap(),
        b"created by another writer"
    );
    assert!(
        !fs::read_dir(fixture.path().join("files"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".fileworker-"))
    );
    queue.cancel(&jobs[0]).unwrap();

    fs::write(
        fixture.path().join("files/download.bin"),
        vec![37; 2 * 1024 * 1024],
    )
    .unwrap();
    fs::write(fixture.path().join("slow-transfers"), b"enabled").unwrap();
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            "/download.bin",
            local.path().to_str().unwrap(),
            false,
        )])
        .unwrap();
    assert!(wait_until(
        || queue
            .snapshot()
            .unwrap()
            .jobs
            .iter()
            .any(|job| job.id == jobs[0] && job.transferred_bytes > 0),
        Duration::from_secs(5)
    ));
    fs::write(local.path().join("download.bin"), b"local late writer").unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Conflict);
    assert_eq!(
        fs::read(local.path().join("download.bin")).unwrap(),
        b"local late writer"
    );
    assert!(
        !fs::read_dir(local.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".fileworker-"))
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn failed_remote_overwrite_restores_original_and_download_overwrite_is_explicit() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    let source = local.path().join("hello.txt");
    fs::write(&source, b"replacement").unwrap();
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            source.to_str().unwrap(),
            "/",
            true,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Conflict);
    fs::write(fixture.path().join("fail-commit"), b"enabled").unwrap();
    queue
        .resolve_conflict(&jobs[0], ConflictPolicy::Overwrite)
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Failed);
    assert_eq!(
        fs::read(fixture.path().join("files/hello.txt")).unwrap(),
        b"hello"
    );
    assert!(
        !fs::read_dir(fixture.path().join("files"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".fileworker-"))
    );
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            "/hello.txt",
            local.path().to_str().unwrap(),
            false,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Conflict);
    queue
        .resolve_conflict(&jobs[0], ConflictPolicy::Overwrite)
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Completed);
    assert_eq!(fs::read(&source).unwrap(), b"hello");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn source_changes_and_download_cancellation_do_not_commit_partial_targets() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    fs::write(fixture.path().join("slow-transfers"), b"enabled").unwrap();
    for cancel in [false, true] {
        let source = fixture.path().join("files/changing.bin");
        fs::write(&source, vec![37; 4 * 1024 * 1024]).unwrap();
        let jobs = queue
            .enqueue(vec![transfer_request(
                &session,
                "/changing.bin",
                local.path().to_str().unwrap(),
                false,
            )])
            .unwrap();
        assert!(wait_until(
            || queue
                .snapshot()
                .unwrap()
                .jobs
                .iter()
                .any(|job| job.id == jobs[0] && job.transferred_bytes > 0),
            Duration::from_secs(5)
        ));
        if cancel {
            queue.cancel(&jobs[0]).unwrap();
        } else {
            fs::write(&source, b"changed source").unwrap();
        }
        wait_for_job(
            &queue,
            &jobs[0],
            if cancel {
                TransferState::Canceled
            } else {
                TransferState::Failed
            },
        );
        assert!(!local.path().join("changing.bin").exists());
        assert_eq!(fs::read_dir(local.path()).unwrap().count(), 0);
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn queue_shutdown_cancels_queued_work_and_cleans_running_uploads() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    queue.set_concurrency(1).unwrap();
    fs::write(fixture.path().join("slow-transfers"), b"enabled").unwrap();
    let first = local.path().join("first.bin");
    let second = local.path().join("second.bin");
    fs::write(&first, vec![19; 2 * 1024 * 1024]).unwrap();
    fs::write(&second, b"queued").unwrap();
    queue
        .enqueue(vec![
            transfer_request(&session, first.to_str().unwrap(), "/", true),
            transfer_request(&session, second.to_str().unwrap(), "/", true),
        ])
        .unwrap();
    assert!(wait_until(
        || queue.snapshot().unwrap().jobs[0].transferred_bytes > 0,
        Duration::from_secs(5)
    ));
    queue.shutdown();
    assert!(
        queue
            .snapshot()
            .unwrap()
            .jobs
            .iter()
            .all(|job| job.state == TransferState::Canceled)
    );
    assert!(!fixture.path().join("files/first.bin").exists());
    assert!(!fixture.path().join("files/second.bin").exists());
    assert!(
        queue
            .enqueue(vec![transfer_request(
                &session,
                second.to_str().unwrap(),
                "/",
                true
            )])
            .is_err()
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn transfer_transport_rechecks_changed_host_before_any_authentication() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host-a");
    let port = server.port;
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    let authentication = fs::read(fixture.path().join("auth-events")).unwrap();
    drop(server);
    let _changed = Server::start(fixture.path(), port, "host-b");
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            "/hello.txt",
            local.path().to_str().unwrap(),
            false,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Failed);
    let snapshot = queue.snapshot().unwrap();
    assert!(snapshot.jobs[0].error.as_deref().unwrap().contains("指纹"));
    assert_eq!(
        fs::read(fixture.path().join("auth-events")).unwrap(),
        authentication
    );
    assert_eq!(fs::read_dir(local.path()).unwrap().count(), 0);
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; run under ASan for bounds checking"]
fn repeated_server_signature_algorithms_do_not_corrupt_private_key_authentication() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start_with_algorithms(fixture.path(), 0, "host", true);
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
    );
    let mut profile = server.profile();
    profile.auth_method = AuthMethod::PrivateKey;
    profile.private_key_path = Some(server.key_path.clone());
    let attempt = id();
    manager.probe(attempt.clone(), profile).unwrap();
    manager.trust(&attempt).unwrap();
    let session = manager
        .authenticate(&attempt, secret("test-key-passphrase"), false)
        .unwrap();
    assert!(
        manager
            .list(&session.session_id, "/")
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.name == "hello.txt")
    );
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn trust_authentication_browsing_credentials_and_changed_host_are_real_protocol_operations() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host-a");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::new(
        config.path().into(),
        PathBuf::from("/"),
        credentials.clone(),
    );
    let profile = server.profile();

    let attempt = id();
    let probe = manager.probe(attempt.clone(), profile.clone()).unwrap();
    assert!(!probe.trusted);
    assert!(probe.identity.fingerprint.starts_with("SHA256:"));
    assert_eq!(
        manager
            .authenticate(&attempt, None, false)
            .unwrap_err()
            .code,
        "host_not_trusted"
    );
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
    assert!(!fixture.path().join("auth-events").exists());
    manager.cancel(&attempt).unwrap();
    assert_eq!(manager.trust(&attempt).unwrap_err().code, "attempt_expired");
    assert!(!config.path().join("known_hosts.json").exists());

    let attempt = id();
    manager.probe(attempt.clone(), profile.clone()).unwrap();
    manager.trust(&attempt).unwrap();
    let wrong = manager
        .authenticate(&attempt, secret("wrong-test-password"), false)
        .unwrap_err();
    assert_eq!(wrong.code, "authentication_failed");
    assert!(!wrong.message.contains("wrong-test-password"));
    assert!(credentials.values.lock().unwrap().is_empty());
    let connected = manager
        .authenticate(&attempt, secret("test-password-only"), true)
        .unwrap();
    assert!(connected.warning.is_none());
    let listing = manager.list(&connected.session_id, "/.").unwrap();
    assert_eq!(listing.path, "/");
    assert_eq!(listing.parent_path, None);
    assert!(
        listing
            .entries
            .iter()
            .any(|item| item.name == "hello.txt" && item.size == Some(5))
    );
    assert!(
        listing
            .entries
            .iter()
            .any(|item| item.name == ".hidden" && item.hidden)
    );
    assert!(listing.entries.iter().any(|item| item.name == "中文.txt"));
    assert!(
        listing
            .entries
            .iter()
            .any(|item| item.name == "folder-link" && item.is_symlink && item.is_dir)
    );
    assert!(
        listing
            .entries
            .iter()
            .any(|item| item.name == r"dir\name" && item.path == r"/dir\name")
    );
    assert!(listing.entries[0].is_dir);
    let child = manager.list(&connected.session_id, "/folder").unwrap();
    assert_eq!(child.parent_path, Some("/".into()));
    assert_eq!(
        manager
            .list(&connected.session_id, "/missing")
            .unwrap_err()
            .code,
        "remote_directory"
    );
    assert_eq!(
        manager
            .list(&connected.session_id, "/denied")
            .unwrap_err()
            .code,
        "remote_directory"
    );
    assert_eq!(
        manager
            .list(&connected.session_id, "child.txt")
            .unwrap_err()
            .code,
        "invalid_remote_path"
    );
    // Each request carries its base explicitly; the backend has no mutable working directory.
    assert_eq!(
        manager
            .list(&connected.session_id, "/folder/.")
            .unwrap()
            .path,
        "/folder"
    );
    assert_eq!(
        manager
            .list(&connected.session_id, "/alias/..")
            .unwrap()
            .path,
        "/physical"
    );
    manager.disconnect(&connected.session_id).unwrap();
    assert_eq!(
        manager.list(&connected.session_id, "/").unwrap_err().code,
        "session_closed"
    );

    let attempt = id();
    assert!(
        manager
            .probe(attempt.clone(), profile.clone())
            .unwrap()
            .trusted
    );
    let saved = manager.authenticate(&attempt, None, false).unwrap();
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 2);
    let late_canceled = id();
    manager.cancel(&late_canceled).unwrap();
    assert_eq!(
        manager
            .probe(late_canceled, profile.clone())
            .unwrap_err()
            .code,
        "attempt_expired",
    );
    assert_eq!(manager.list(&saved.session_id, "/").unwrap().path, "/");
    manager.disconnect(&saved.session_id).unwrap();

    let mut key_profile = profile.clone();
    key_profile.auth_method = AuthMethod::PrivateKey;
    key_profile.private_key_path = Some(server.key_path.clone());
    let attempt = id();
    manager.probe(attempt.clone(), key_profile).unwrap();
    assert_eq!(
        manager
            .authenticate(&attempt, secret("wrong-passphrase"), false)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    let previous_connections = fs::read_to_string(fixture.path().join("connections"))
        .unwrap()
        .lines()
        .count();
    let by_key = manager
        .authenticate(&attempt, secret("test-key-passphrase"), false)
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.path().join("connections"))
            .unwrap()
            .lines()
            .count(),
        previous_connections + 1,
        "authentication retry must use a fresh SSH transport",
    );
    assert!(
        !manager
            .list(&by_key.session_id, "/")
            .unwrap()
            .entries
            .is_empty()
    );
    let port = server.port;
    drop(server);
    assert_eq!(
        manager.list(&by_key.session_id, "/").unwrap_err().code,
        "connection_lost"
    );
    let replacement = Server::start(fixture.path(), port, "host-b");
    assert_eq!(
        manager.probe(id(), replacement.profile()).unwrap_err().code,
        "host_key_changed"
    );
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 2);
    drop(replacement);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            fixture.path().join("files/denied"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn canceled_expired_and_superseded_attempts_cannot_authenticate() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::with_timeouts(
        config.path().into(),
        PathBuf::from("/"),
        credentials.clone(),
        Duration::from_secs(3),
        Duration::from_millis(100),
    );
    let old = id();
    manager.probe(old.clone(), server.profile()).unwrap();
    let new = id();
    manager.probe(new.clone(), server.profile()).unwrap();
    assert_eq!(
        manager.authenticate(&old, None, false).unwrap_err().code,
        "attempt_expired"
    );
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(manager.trust(&new).unwrap_err().code, "attempt_expired");
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh and ssh-keygen; see README"]
fn openssh_encrypted_and_plain_keys_work_and_credential_storage_failure_is_nonfatal() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    );
    for (path, passphrase) in [
        ("~/client-ed25519", "test-ed25519-passphrase"),
        ("~/client-plain", ""),
    ] {
        let mut profile = server.profile();
        profile.auth_method = AuthMethod::PrivateKey;
        profile.private_key_path = Some(path.into());
        let attempt = id();
        let probe = manager.probe(attempt.clone(), profile).unwrap();
        if !probe.trusted {
            manager.trust(&attempt).unwrap();
        }
        let session = manager
            .authenticate(&attempt, secret(passphrase), false)
            .unwrap();
        assert_eq!(manager.list(&session.session_id, "/").unwrap().path, "/");
        manager.disconnect(&session.session_id).unwrap();
    }
    credentials.fail_writes.store(true, Ordering::SeqCst);
    let attempt = id();
    manager.probe(attempt.clone(), server.profile()).unwrap();
    let session = manager
        .authenticate(&attempt, secret("test-password-only"), true)
        .unwrap();
    assert!(session.warning.is_some());
    assert!(credentials.values.lock().unwrap().is_empty());
    assert_eq!(manager.list(&session.session_id, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn changed_host_during_authentication_retry_is_blocked_before_reading_saved_credentials() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "before");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::new(
        config.path().into(),
        PathBuf::from("/"),
        credentials.clone(),
    );
    let attempt = id();
    manager.probe(attempt.clone(), server.profile()).unwrap();
    manager.trust(&attempt).unwrap();
    assert_eq!(
        manager
            .authenticate(&attempt, secret("wrong"), false)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    let port = server.port;
    drop(server);
    let _replacement = Server::start(fixture.path(), port, "after");
    assert_eq!(
        manager
            .authenticate(&attempt, None, false)
            .unwrap_err()
            .code,
        "host_key_changed"
    );
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn expiry_closes_the_socket_and_prevents_authentication_after_a_credential_read_wait() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (credentials, started, release) = BlockingCredentials::new(true);
    let profile = server.profile();
    credentials
        .memory
        .set(&credential_account(&profile), "test-password-only")
        .unwrap();
    let manager = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        PathBuf::from("/"),
        credentials,
        Duration::from_secs(3),
        Duration::from_millis(300),
    ));
    let attempt = id();
    manager.probe(attempt.clone(), profile).unwrap();
    manager.trust(&attempt).unwrap();
    let worker = {
        let manager = manager.clone();
        std::thread::spawn(move || manager.authenticate(&attempt, None, false))
    };
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    let disconnected = wait_until(
        || fixture.path().join("disconnect-events").exists(),
        Duration::from_secs(1),
    );
    release.send(()).unwrap();
    let result = worker.join().unwrap();
    assert!(
        disconnected,
        "expired attempts must close even without another manager call"
    );
    assert_eq!(result.unwrap_err().code, "attempt_expired");
    assert!(
        !fixture.path().join("auth-events").exists(),
        "expired credentials must never be sent"
    );
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn forgetting_credentials_cancels_in_flight_saves_without_a_separate_cancel() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (credentials, started, release) = BlockingCredentials::new(false);
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        PathBuf::from("/"),
        credentials.clone(),
    ));
    let profile = server.profile();
    let attempt = id();
    manager.probe(attempt.clone(), profile.clone()).unwrap();
    manager.trust(&attempt).unwrap();
    let auth = {
        let manager = manager.clone();
        let attempt = attempt.clone();
        std::thread::spawn(move || {
            manager.authenticate(&attempt, secret("test-password-only"), true)
        })
    };
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    let (done, finished) = mpsc::channel();
    let forget = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let result = manager.forget_credential(&profile);
            done.send(()).unwrap();
            result
        })
    };
    let _ = finished.recv_timeout(Duration::from_millis(100));
    release.send(()).unwrap();
    assert_eq!(auth.join().unwrap().unwrap_err().code, "attempt_expired");
    forget.join().unwrap().unwrap();
    assert!(
        credentials.memory.values.lock().unwrap().is_empty(),
        "a late save must not restore credentials after forgetting completes",
    );
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn canceled_credential_saves_restore_the_previous_value_without_touching_the_new_session() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    for previous in [None, Some("previous-saved-value")] {
        let (credentials, started, release) = BlockingCredentials::new(false);
        let profile = server.profile();
        let account = credential_account(&profile);
        if let Some(previous) = previous {
            credentials.memory.set(&account, previous).unwrap();
        }
        let manager = Arc::new(ConnectionManager::new(
            config.path().into(),
            fixture.path().into(),
            credentials.clone(),
        ));
        let attempt = id();
        let probe = manager.probe(attempt.clone(), profile.clone()).unwrap();
        if !probe.trusted {
            manager.trust(&attempt).unwrap();
        }
        let old_auth = {
            let manager = manager.clone();
            let attempt = attempt.clone();
            std::thread::spawn(move || {
                manager.authenticate(&attempt, secret("test-password-only"), true)
            })
        };
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        manager.cancel(&attempt).unwrap();
        let next = id();
        manager.probe(next.clone(), profile).unwrap();
        let connected = manager
            .authenticate(&next, secret("test-password-only"), false)
            .unwrap();
        release.send(()).unwrap();
        assert_eq!(
            old_auth.join().unwrap().unwrap_err().code,
            "attempt_expired"
        );
        assert_eq!(
            credentials
                .memory
                .values
                .lock()
                .unwrap()
                .get(&account)
                .map(String::as_str),
            previous,
            "a canceled save must restore the exact previous state"
        );
        assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
    }
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn a_canceled_credential_read_does_not_block_another_credential_identity() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (credentials, started, release) = BlockingCredentials::new(true);
    let first_profile = server.profile();
    let mut next_profile = first_profile.clone();
    next_profile.id = id();
    for profile in [&first_profile, &next_profile] {
        credentials
            .memory
            .set(&credential_account(profile), "test-password-only")
            .unwrap();
    }
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials,
    ));
    let attempt = id();
    manager.probe(attempt.clone(), first_profile).unwrap();
    manager.trust(&attempt).unwrap();
    let old_auth = {
        let manager = manager.clone();
        let attempt = attempt.clone();
        std::thread::spawn(move || manager.authenticate(&attempt, None, false))
    };
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    manager.cancel(&attempt).unwrap();
    let next = id();
    manager.probe(next.clone(), next_profile).unwrap();
    let (done, finished) = mpsc::channel();
    let next_auth = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let result = manager.authenticate(&next, None, false);
            done.send(()).unwrap();
            result
        })
    };
    let independent = finished.recv_timeout(Duration::from_millis(500)).is_ok();
    release.send(()).unwrap();
    assert_eq!(
        old_auth.join().unwrap().unwrap_err().code,
        "attempt_expired"
    );
    let connected = next_auth.join().unwrap().unwrap();
    assert!(
        independent,
        "an unrelated credential must not wait for an old credential read"
    );
    assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn failed_retry_handshake_closes_its_new_socket_without_another_cancel() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let manager = ConnectionManager::with_timeouts(
        config.path().into(),
        PathBuf::from("/"),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(250),
        Duration::from_secs(120),
    );
    let profile = server.profile();
    let attempt = id();
    manager.probe(attempt.clone(), profile.clone()).unwrap();
    manager.trust(&attempt).unwrap();
    assert_eq!(
        manager
            .authenticate(&attempt, secret("wrong"), false)
            .unwrap_err()
            .code,
        "authentication_failed",
    );
    drop(server);
    let listener = TcpListener::bind(("127.0.0.1", profile.port)).unwrap();
    let (closed, received) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut buffer = [0; 256];
        let eof = loop {
            match socket.read(&mut buffer) {
                Ok(0) => break true,
                Ok(_) => {}
                Err(_) => break false,
            }
        };
        closed.send(eof).unwrap();
    });
    assert_eq!(
        manager
            .authenticate(&attempt, secret("test-password-only"), false)
            .unwrap_err()
            .code,
        "ssh_handshake",
    );
    let closed_without_cancel = received.recv_timeout(Duration::from_millis(500));
    manager.cancel(&attempt).unwrap();
    peer.join().unwrap();
    assert_eq!(
        closed_without_cancel.ok(),
        Some(true),
        "retry sockets must be closed on failure"
    );
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn a_contended_trust_file_lock_does_not_block_connection_cancellation() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        PathBuf::from("/"),
        Arc::new(MemoryCredentials::default()),
    ));
    let attempt = id();
    manager.probe(attempt.clone(), server.profile()).unwrap();
    let lock = fs::File::create(config.path().join("known_hosts.lock")).unwrap();
    lock.lock().unwrap();
    let (started, entered) = mpsc::channel();
    let trust = {
        let manager = manager.clone();
        let attempt = attempt.clone();
        std::thread::spawn(move || {
            started.send(()).unwrap();
            manager.trust(&attempt)
        })
    };
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let (done, finished) = mpsc::channel();
    let cancel = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let result = manager.cancel(&attempt);
            done.send(()).unwrap();
            result
        })
    };
    let canceled_before_unlock = finished.recv_timeout(Duration::from_millis(200)).is_ok();
    lock.unlock().unwrap();
    let trust_result = trust.join().unwrap();
    cancel.join().unwrap().unwrap();
    assert!(
        canceled_before_unlock,
        "filesystem contention must not hold the lifecycle lock"
    );
    assert_eq!(trust_result.unwrap_err().code, "attempt_expired");
    assert!(
        !config.path().join("known_hosts.json").exists(),
        "a canceled confirmation must not persist after waiting for the file lock"
    );
}

#[test]
fn unresponsive_ssh_server_times_out_without_blocking_forever() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::with_timeouts(
        config.path().into(),
        PathBuf::from("/"),
        Arc::new(MemoryCredentials::default()),
        Duration::from_millis(200),
        Duration::from_secs(120),
    );
    let hold = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        drop(socket);
    });
    let profile = ConnectionProfile {
        id: id(),
        name: "timeout".into(),
        host: "127.0.0.1".into(),
        port,
        username: "test".into(),
        auth_method: AuthMethod::Password,
        private_key_path: None,
        remote_path: ".".into(),
        group_id: None,
    };
    let start = std::time::Instant::now();
    assert!(manager.probe(id(), profile).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    hold.join().unwrap();
}

#[test]
fn cancel_interrupts_an_in_progress_ssh_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = tempfile::tempdir().unwrap();
    let manager = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        PathBuf::from("/"),
        Arc::new(MemoryCredentials::default()),
        Duration::from_secs(3),
        Duration::from_secs(120),
    ));
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        accepted_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
        drop(socket);
    });
    let attempt = id();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let worker = {
        let manager = manager.clone();
        let attempt = attempt.clone();
        std::thread::spawn(move || {
            let _ = finished_tx.send(manager.probe(
                attempt,
                ConnectionProfile {
                    id: id(),
                    name: "cancel".into(),
                    host: "127.0.0.1".into(),
                    port,
                    username: "test".into(),
                    auth_method: AuthMethod::Password,
                    private_key_path: None,
                    remote_path: ".".into(),
                    group_id: None,
                },
            ));
        })
    };
    accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    manager.cancel(&attempt).unwrap();
    let outcome = finished_rx.recv_timeout(Duration::from_millis(400));
    release_tx.send(()).unwrap();
    server.join().unwrap();
    worker.join().unwrap();
    assert!(
        outcome.is_ok(),
        "cancel should interrupt the socket instead of waiting for the network timeout"
    );
    assert!(outcome.unwrap().is_err());
}

fn pasted_profile(server: &Server) -> ConnectionProfile {
    let mut profile = server.profile();
    profile.id = id();
    profile.auth_method = AuthMethod::PrivateKeyContent;
    profile
}

fn pasted_secret(root: &Path, name: &str, passphrase: &str) -> String {
    serde_json::to_string(&serde_json::json!({
        "version": 1,
        "privateKey": fs::read_to_string(root.join(name)).unwrap(),
        "passphrase": passphrase
    }))
    .unwrap()
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn pasted_encrypted_and_plain_keys_remember_reconnect_and_transfer() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    ));
    for (name, passphrase) in [
        ("client.pem", "test-key-passphrase"),
        ("client-ed25519", "test-ed25519-passphrase"),
        ("client-plain", ""),
    ] {
        let profile = pasted_profile(&server);
        let envelope = pasted_secret(fixture.path(), name, passphrase);
        let attempt = id();
        let probe = manager.probe(attempt.clone(), profile.clone()).unwrap();
        assert!(!manager.credential_status(&profile).unwrap().available);
        if !probe.trusted {
            manager.trust(&attempt).unwrap();
        }
        let connected = manager
            .authenticate(&attempt, secret(&envelope), true)
            .unwrap();
        assert!(connected.warning.is_none());
        assert!(manager.credential_status(&profile).unwrap().available);
        assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
        assert_eq!(
            credentials
                .values
                .lock()
                .unwrap()
                .get(&credential_account(&profile)),
            Some(&envelope)
        );
        let serialized = serde_json::to_string(&connected).unwrap();
        assert!(!serialized.contains("PRIVATE KEY"));
        assert!(!serialized.contains("privateKey"));
        manager.disconnect(&connected.session_id).unwrap();

        let attempt = id();
        assert!(
            manager
                .probe(attempt.clone(), profile.clone())
                .unwrap()
                .trusted
        );
        let saved = manager.authenticate(&attempt, None, false).unwrap();
        assert!(manager.credential_status(&profile).unwrap().available);
        assert_eq!(manager.list(&saved.session_id, "/").unwrap().path, "/");
        let downloads = tempfile::tempdir().unwrap();
        let queue = TransferManager::new(manager.clone());
        let jobs = queue
            .enqueue(vec![transfer_request(
                &saved.session_id,
                "/hello.txt",
                downloads.path().to_str().unwrap(),
                false,
            )])
            .unwrap();
        wait_for_job(&queue, &jobs[0], TransferState::Completed);
        assert_eq!(
            fs::read(downloads.path().join("hello.txt")).unwrap(),
            b"hello"
        );
        manager.forget_credential(&profile).unwrap();
        assert!(!manager.credential_status(&profile).unwrap().available);
        assert_eq!(manager.list(&saved.session_id, "/").unwrap().path, "/");
        manager.disconnect(&saved.session_id).unwrap();
    }
    for file in fs::read_dir(config.path()).unwrap() {
        let bytes = fs::read(file.unwrap().path()).unwrap();
        let content = String::from_utf8_lossy(&bytes);
        assert!(!content.contains("PRIVATE KEY"));
        assert!(!content.contains("test-key-passphrase"));
        assert!(!content.contains("test-ed25519-passphrase"));
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn pasted_wrong_passphrases_retry_on_a_fresh_transport_without_saving_or_leaking() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    );
    for (name, passphrase) in [
        ("client.pem", "test-key-passphrase"),
        ("client-ed25519", "test-ed25519-passphrase"),
    ] {
        let profile = pasted_profile(&server);
        let attempt = id();
        let probe = manager.probe(attempt.clone(), profile.clone()).unwrap();
        if !probe.trusted {
            manager.trust(&attempt).unwrap();
        }
        let envelope = pasted_secret(fixture.path(), name, "sensitive-wrong-passphrase");
        let error = manager
            .authenticate(&attempt, secret(&envelope), true)
            .unwrap_err();
        assert_eq!(error.code, "authentication_failed");
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("sensitive-wrong-passphrase"));
        assert!(!serialized.contains("PRIVATE KEY"));
        assert!(!manager.credential_status(&profile).unwrap().available);
        assert!(credentials.values.lock().unwrap().is_empty());
        let connections = fs::read_to_string(fixture.path().join("connections"))
            .unwrap()
            .lines()
            .count();
        let envelope = pasted_secret(fixture.path(), name, passphrase);
        let connected = manager
            .authenticate(&attempt, secret(&envelope), false)
            .unwrap();
        assert_eq!(
            fs::read_to_string(fixture.path().join("connections"))
                .unwrap()
                .lines()
                .count(),
            connections + 1
        );
        assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
        manager.disconnect(&connected.session_id).unwrap();
    }
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn pasted_key_envelopes_are_strict_bounded_and_retryable() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    );
    let profile = pasted_profile(&server);
    let attempt = id();
    manager.probe(attempt.clone(), profile).unwrap();
    manager.trust(&attempt).unwrap();
    let valid = pasted_secret(fixture.path(), "client.pem", "test-key-passphrase");
    let valid_value: serde_json::Value = serde_json::from_str(&valid).unwrap();
    let invalid_values = [
        serde_json::json!({"version": 2, "privateKey": valid_value["privateKey"], "passphrase": "sensitive-passphrase"}),
        serde_json::json!({"version": 1, "passphrase": "sensitive-passphrase"}),
        serde_json::json!({"version": 1, "privateKey": "", "passphrase": ""}),
        serde_json::json!({"version": 1, "privateKey": " \n ", "passphrase": ""}),
        serde_json::json!({"version": 1, "privateKey": "K".repeat(1024 * 1024 + 1), "passphrase": ""}),
        serde_json::json!({"version": 1, "privateKey": null, "passphrase": ""}),
        serde_json::json!({"version": 1, "privateKey": valid_value["privateKey"], "passphrase": 17}),
        serde_json::json!({"version": 1, "privateKey": valid_value["privateKey"]}),
        serde_json::json!({"version": 1, "privateKey": valid_value["privateKey"], "passphrase": "", "password": "sensitive-passphrase"}),
        serde_json::json!({"version": "1", "privateKey": valid_value["privateKey"], "passphrase": ""}),
        serde_json::json!({"version": 1, "privateKey": "key\0sensitive-key", "passphrase": ""}),
        serde_json::json!({"version": 1, "privateKey": valid_value["privateKey"], "passphrase": "sensitive-passphrase\0"}),
    ];
    let mut invalid_envelopes: Vec<String> = invalid_values
        .iter()
        .map(|value| serde_json::to_string(value).unwrap())
        .collect();
    invalid_envelopes.extend([
        "malformed-sensitive-key".into(),
        r#"{"version":1,"privateKey":"sensitive-key","privateKey":"duplicate","passphrase":""}"#
            .into(),
        format!("{valid} trailing-sensitive-key"),
    ]);
    for envelope in invalid_envelopes {
        let error = manager
            .authenticate(&attempt, secret(&envelope), true)
            .unwrap_err();
        assert_eq!(error.code, "invalid_private_key");
        let serialized = serde_json::to_string(&error).unwrap();
        for sensitive in [
            "sensitive-passphrase",
            "sensitive-key",
            "PRIVATE KEY",
            "duplicate",
        ] {
            assert!(!serialized.contains(sensitive));
        }
        assert!(credentials.values.lock().unwrap().is_empty());
        assert!(!fixture.path().join("auth-events").exists());
    }
    let exact_limit = serde_json::to_string(&serde_json::json!({
        "version": 1, "privateKey": "K".repeat(1024 * 1024), "passphrase": ""
    }))
    .unwrap();
    assert_eq!(
        manager
            .authenticate(&attempt, secret(&exact_limit), false)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    let connected = manager
        .authenticate(&attempt, secret(&valid), false)
        .unwrap();
    assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn pasted_saved_credentials_are_not_read_or_sent_before_host_trust() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    );
    let profile = pasted_profile(&server);
    let envelope = pasted_secret(fixture.path(), "client.pem", "test-key-passphrase");
    credentials
        .set(&credential_account(&profile), &envelope)
        .unwrap();
    let attempt = id();
    assert!(
        !manager
            .probe(attempt.clone(), profile.clone())
            .unwrap()
            .trusted
    );
    assert!(manager.credential_status(&profile).unwrap().available);
    for input in [None, secret(&envelope), secret("malformed-sensitive-key")] {
        assert_eq!(
            manager
                .authenticate(&attempt, input, true)
                .unwrap_err()
                .code,
            "host_not_trusted"
        );
    }
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
    assert!(!fixture.path().join("auth-events").exists());
    assert!(!config.path().join("known_hosts.json").exists());
    manager.trust(&attempt).unwrap();
    let connected = manager.authenticate(&attempt, None, false).unwrap();
    assert_eq!(manager.list(&connected.session_id, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn checks_in_a_separate_manager_preserve_the_live_session_and_transfers() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let downloads = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (live, session) = connected_manager(fixture.path(), config.path(), &server);
    let test_manager = ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        Arc::new(MemoryCredentials::default()),
    );
    let profile = pasted_profile(&server);
    let attempt = id();
    assert!(
        test_manager
            .probe(attempt.clone(), profile.clone())
            .unwrap()
            .trusted
    );
    assert!(!live.credential_status(&profile).unwrap().available);
    assert_eq!(live.list(&session, "/").unwrap().path, "/");
    assert_eq!(
        test_manager
            .authenticate(&attempt, secret("malformed-sensitive-key"), false)
            .unwrap_err()
            .code,
        "invalid_private_key"
    );
    let wrong = pasted_secret(fixture.path(), "client.pem", "wrong-passphrase");
    assert_eq!(
        test_manager
            .authenticate(&attempt, secret(&wrong), false)
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    let valid = pasted_secret(fixture.path(), "client.pem", "test-key-passphrase");
    let checked = test_manager
        .authenticate(&attempt, secret(&valid), false)
        .unwrap();
    assert_eq!(
        test_manager.list(&checked.session_id, "/").unwrap().path,
        "/"
    );
    test_manager.cancel(&attempt).unwrap();
    assert!(live.is_session_active(&session));
    assert_eq!(live.list(&session, "/").unwrap().path, "/");
    let queue = TransferManager::new(live.clone());
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            "/hello.txt",
            downloads.path().to_str().unwrap(),
            false,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Completed);
    assert_eq!(
        fs::read(downloads.path().join("hello.txt")).unwrap(),
        b"hello"
    );
    assert_eq!(live.list(&session, "/").unwrap().path, "/");
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn deleting_or_reidentifying_a_profile_cannot_leave_a_late_saved_credential() {
    let fixture = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    for deleting in [true, false] {
        let config = tempfile::tempdir().unwrap();
        let (credentials, started, release) = BlockingCredentials::new(false);
        let manager = Arc::new(ConnectionManager::new(
            config.path().into(),
            fixture.path().into(),
            credentials.clone(),
        ));
        let service = Arc::new(ProfileService::new(
            ProfileStore::new(config.path().into()),
            manager.clone(),
        ));
        let profile = service.save(server.profile()).unwrap();
        let attempt = id();
        service.probe(&profile.id, attempt.clone()).unwrap();
        manager.trust(&attempt).unwrap();
        let auth = {
            let manager = manager.clone();
            std::thread::spawn(move || {
                manager.authenticate(&attempt, secret("test-password-only"), true)
            })
        };
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let (entered, waiting) = mpsc::channel();
        let closed_before = fs::read_to_string(fixture.path().join("disconnect-events"))
            .unwrap_or_default()
            .lines()
            .count();
        let mutation = {
            let service = service.clone();
            let profile = profile.clone();
            std::thread::spawn(move || {
                entered.send(()).unwrap();
                if deleting {
                    service.delete(&profile.id)
                } else {
                    let mut changed = profile;
                    changed.username = "changed-account".into();
                    service.save(changed).map(|_| ())
                }
            })
        };
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        let canceled = wait_until(
            || {
                fs::read_to_string(fixture.path().join("disconnect-events"))
                    .unwrap_or_default()
                    .lines()
                    .count()
                    > closed_before
            },
            Duration::from_secs(1),
        );
        release.send(()).unwrap();
        let result = auth.join().unwrap();
        mutation.join().unwrap().unwrap();
        assert!(
            canceled,
            "configuration mutation must cancel authentication before waiting for the vault"
        );
        assert_eq!(result.unwrap_err().code, "attempt_expired");
        assert!(credentials.memory.values.lock().unwrap().is_empty());
        let stored = service.store().list().unwrap();
        if deleting {
            assert!(stored.is_empty());
            assert_eq!(
                service.probe(&profile.id, id()).unwrap_err().code,
                "profile_missing"
            );
        } else {
            assert_eq!(stored[0].username, "changed-account");
        }
    }
}

#[test]
#[ignore = "requires target/sftp-test-venv with asyncssh; see README"]
fn rename_group_changes_and_forgetting_preserve_a_live_session_but_identity_changes_close_it() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let credentials = Arc::new(MemoryCredentials::default());
    let manager = Arc::new(ConnectionManager::new(
        config.path().into(),
        fixture.path().into(),
        credentials.clone(),
    ));
    let service = ProfileService::new(ProfileStore::new(config.path().into()), manager.clone());
    let mut profile = service.save(server.profile()).unwrap();
    let attempt = id();
    service.probe(&profile.id, attempt.clone()).unwrap();
    manager.trust(&attempt).unwrap();
    let session = manager
        .authenticate(&attempt, secret("test-password-only"), true)
        .unwrap();
    let group = service
        .store()
        .save_group(ConnectionGroup {
            id: id(),
            name: "生产".into(),
        })
        .unwrap();
    profile.name = "重命名".into();
    profile.group_id = Some(group.id.clone());
    profile.remote_path = "/".into();
    profile = service.save(profile).unwrap();
    service.store().delete_group(&group.id).unwrap();
    assert!(manager.credential_status(&profile).unwrap().available);
    service.forget_credential(&profile.id).unwrap();
    assert!(credentials.values.lock().unwrap().is_empty());
    assert!(
        !manager
            .list(&session.session_id, "/")
            .unwrap()
            .path
            .is_empty()
    );
    profile.group_id = None;
    profile.username = "changed-account".into();
    service.save(profile).unwrap();
    assert_eq!(
        manager.list(&session.session_id, "/").unwrap_err().code,
        "session_closed"
    );
}

#[test]
fn deleting_a_profile_interrupts_its_pending_handshake_and_prevents_stale_reprobes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = tempfile::tempdir().unwrap();
    let manager = Arc::new(ConnectionManager::with_timeouts(
        config.path().into(),
        config.path().into(),
        Arc::new(MemoryCredentials::default()),
        Duration::from_secs(3),
        Duration::from_secs(120),
    ));
    let service = Arc::new(ProfileService::new(
        ProfileStore::new(config.path().into()),
        manager,
    ));
    let profile = service
        .save(ConnectionProfile {
            id: id(),
            name: "handshake".into(),
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth_method: AuthMethod::Password,
            private_key_path: None,
            remote_path: ".".into(),
            group_id: None,
        })
        .unwrap();
    let (accepted, received) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        accepted.send(()).unwrap();
        let _ = wait.recv_timeout(Duration::from_secs(5));
        drop(socket);
    });
    let probe = {
        let service = service.clone();
        let profile_id = profile.id.clone();
        std::thread::spawn(move || service.probe(&profile_id, id()))
    };
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    let start = Instant::now();
    let result = service.delete(&profile.id);
    let elapsed = start.elapsed();
    release.send(()).unwrap();
    server.join().unwrap();
    let probe = probe.join().unwrap();
    result.unwrap();
    assert!(probe.is_err());
    assert!(
        elapsed < Duration::from_millis(600),
        "deletion must cancel the network wait"
    );
    assert_eq!(
        service.probe(&profile.id, id()).unwrap_err().code,
        "profile_missing"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_files_preview_is_bounded_read_only_and_bound_to_the_live_session() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let files = fixture.path().join("files");
    fs::write(files.join("app.log"), "第一行\nsecond line\tok").unwrap();
    fs::write(files.join("binary.bin"), [0_u8, 1, 2, 255]).unwrap();
    fs::write(files.join("large.log"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    fs::write(files.join("oversized.bin"), vec![0_u8; 8 * 1024 * 1024 + 1]).unwrap();
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==").unwrap();
    fs::write(files.join("pixel.png"), &png).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("app.log", files.join("log-link")).unwrap();
    let properties = remote.file_properties(&session, "/app.log").unwrap();
    assert_eq!(properties.kind, "file");
    assert_eq!(
        properties.size,
        Some("第一行\nsecond line\tok".len() as u64)
    );
    match remote.preview_file(&session, "/app.log").unwrap() {
        RemotePreview::Text { text, .. } => assert_eq!(text, "第一行\nsecond line\tok"),
        _ => panic!("expected text preview"),
    }
    match remote.preview_file(&session, "/pixel.png").unwrap() {
        RemotePreview::Image { mime, data, .. } => {
            assert_eq!(mime, "image/png");
            assert_eq!(STANDARD.decode(data).unwrap(), png);
        }
        _ => panic!("expected raster preview"),
    }
    for path in [
        "/binary.bin",
        "/large.log",
        "/oversized.bin",
        "/folder",
        "/folder-link",
    ] {
        assert!(remote.preview_file(&session, path).is_err(), "{path}");
    }
    #[cfg(unix)]
    assert!(remote.preview_file(&session, "/log-link").is_err());
    assert_eq!(
        fs::read_to_string(files.join("app.log")).unwrap(),
        "第一行\nsecond line\tok"
    );
    remote.disconnect(&session).unwrap();
    assert_eq!(
        remote
            .file_properties(&session, "/hello.txt")
            .unwrap_err()
            .code,
        "session_closed"
    );
    assert_eq!(
        remote
            .preview_file(&session, "/hello.txt")
            .unwrap_err()
            .code,
        "session_closed"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_files_mutations_are_private_nonrecursive_and_never_overwrite() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let files = fixture.path().join("files");
    let queue = TransferManager::new(remote.clone());
    queue
        .mutate_remote_file(
            &session,
            "/",
            RemoteFileAction::CreateDirectory {
                name: "new-folder".into(),
            },
        )
        .unwrap();
    assert!(files.join("new-folder").is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(files.join("new-folder"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    queue
        .mutate_remote_file(
            &session,
            "/hello.txt",
            RemoteFileAction::Rename {
                name: "renamed.txt".into(),
            },
        )
        .unwrap();
    assert!(!files.join("hello.txt").exists());
    assert_eq!(fs::read(files.join("renamed.txt")).unwrap(), b"hello");
    fs::write(files.join("occupied.txt"), b"keep original").unwrap();
    assert!(
        queue
            .mutate_remote_file(
                &session,
                "/renamed.txt",
                RemoteFileAction::Rename {
                    name: "occupied.txt".into()
                }
            )
            .is_err()
    );
    assert_eq!(
        fs::read(files.join("occupied.txt")).unwrap(),
        b"keep original"
    );
    assert_eq!(fs::read(files.join("renamed.txt")).unwrap(), b"hello");
    assert!(
        queue
            .mutate_remote_file(&session, "/folder", RemoteFileAction::Delete {})
            .is_err()
    );
    assert_eq!(fs::read(files.join("folder/child.txt")).unwrap(), b"child");
    queue
        .mutate_remote_file(&session, "/new-folder", RemoteFileAction::Delete {})
        .unwrap();
    queue
        .mutate_remote_file(&session, "/renamed.txt", RemoteFileAction::Delete {})
        .unwrap();
    assert!(!files.join("new-folder").exists());
    assert!(!files.join("renamed.txt").exists());
    for path in [
        "/",
        "/folder/..",
        "/folder-link",
        "hello.txt",
        "/folder//child.txt",
    ] {
        assert!(
            queue
                .mutate_remote_file(&session, path, RemoteFileAction::Delete {})
                .is_err(),
            "{path}"
        );
    }
    for name in ["", ".", "..", "bad/name", "bad\nname"] {
        assert!(
            queue
                .mutate_remote_file(
                    &session,
                    "/",
                    RemoteFileAction::CreateDirectory { name: name.into() }
                )
                .is_err(),
            "{name:?}"
        );
    }
    remote.disconnect(&session).unwrap();
    assert_eq!(
        queue
            .mutate_remote_file(&session, "/occupied.txt", RemoteFileAction::Delete {})
            .unwrap_err()
            .code,
        "session_closed"
    );
    assert_eq!(
        fs::read(files.join("occupied.txt")).unwrap(),
        b"keep original"
    );
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_files_mutations_are_blocked_until_transfers_and_conflicts_finish() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = TransferManager::new(remote);
    let source = local.path().join("hello.txt");
    fs::write(&source, b"new data").unwrap();
    let jobs = queue
        .enqueue(vec![transfer_request(
            &session,
            source.to_str().unwrap(),
            "/",
            true,
        )])
        .unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Conflict);
    let error = queue
        .mutate_remote_file(&session, "/hello.txt", RemoteFileAction::Delete {})
        .unwrap_err();
    assert_eq!(error.code, "transfers_active");
    assert_eq!(
        fs::read(fixture.path().join("files/hello.txt")).unwrap(),
        b"hello"
    );
    queue.cancel(&jobs[0]).unwrap();
    queue
        .mutate_remote_file(&session, "/hello.txt", RemoteFileAction::Delete {})
        .unwrap();
    assert!(!fixture.path().join("files/hello.txt").exists());
}

#[test]
#[ignore = "requires isolated asyncssh fixture"]
fn remote_files_mutation_reservation_blocks_concurrent_enqueue_and_releases_afterward() {
    let fixture = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = Server::start(fixture.path(), 0, "host");
    let (remote, session) = connected_manager(fixture.path(), config.path(), &server);
    let queue = Arc::new(TransferManager::new(remote));
    fs::write(fixture.path().join("pause-mutation"), b"enabled").unwrap();
    let mutation = {
        let queue = queue.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            queue.mutate_remote_file(
                &session,
                "/",
                RemoteFileAction::CreateDirectory {
                    name: "reserved".into(),
                },
            )
        })
    };
    let entered = wait_until(
        || fixture.path().join("mutation-entered").exists(),
        Duration::from_secs(3),
    );
    let request = transfer_request(
        &session,
        "/hello.txt",
        local.path().to_str().unwrap(),
        false,
    );
    let result = queue.enqueue(vec![request.clone()]);
    fs::remove_file(fixture.path().join("pause-mutation")).unwrap();
    mutation.join().unwrap().unwrap();
    assert!(entered);
    assert_eq!(result.unwrap_err().code, "remote_file_busy");
    assert!(queue.snapshot().unwrap().jobs.is_empty());
    let jobs = queue.enqueue(vec![request]).unwrap();
    wait_for_job(&queue, &jobs[0], TransferState::Completed);
    assert_eq!(fs::read(local.path().join("hello.txt")).unwrap(), b"hello");
}
