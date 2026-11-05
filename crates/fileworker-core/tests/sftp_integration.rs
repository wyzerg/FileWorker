use fileworker_core::{
    connections::ConnectionManager,
    credentials::{CredentialStore, credential_account},
    error::CoreError,
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
    }
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn secret(value: &str) -> Option<Zeroizing<String>> {
    Some(Zeroizing::new(value.into()))
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
fn expiry_closes_the_socket_and_prevents_authentication_after_a_keychain_wait() {
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
fn a_canceled_keychain_prompt_does_not_block_another_credential_identity() {
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
        "an unrelated credential must not wait for an old Keychain prompt"
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
