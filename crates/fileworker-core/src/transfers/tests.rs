use super::*;
use crate::credentials::CredentialStore;
use std::fs;
use zeroize::Zeroizing;

struct UnusedCredentials;
impl CredentialStore for UnusedCredentials {
    fn get(&self, _: &str) -> Result<Zeroizing<String>, CoreError> {
        panic!("queue record removal must not read credentials");
    }

    fn set(&self, _: &str, _: &str) -> Result<(), CoreError> {
        panic!("queue record removal must not write credentials");
    }

    fn delete(&self, _: &str) -> Result<(), CoreError> {
        panic!("queue record removal must not delete credentials");
    }
}

fn record(id: &str, state: TransferState) -> Record {
    let request = TransferRequest {
        session_id: "closed-session".into(),
        direction: TransferDirection::Upload,
        source_path: format!("/local/{id}.txt"),
        destination_dir: "/remote".into(),
    };
    Record {
        job: TransferJob {
            id: id.into(),
            session_id: request.session_id.clone(),
            direction: request.direction,
            name: format!("{id}.txt"),
            attempt: 1,
            source_path: request.source_path.clone(),
            destination_dir: request.destination_dir.clone(),
            destination_path: Some(format!("/remote/{id}.txt")),
            state,
            transferred_bytes: 4,
            total_bytes: Some(4),
            bytes_per_second: 0,
            eta_seconds: None,
            error: None,
            warning: None,
        },
        request,
        policy: ConflictPolicy::Ask,
        canceled: Arc::new(AtomicBool::new(false)),
        started: None,
    }
}

fn queue(jobs: Vec<Record>) -> (TransferManager, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let remote = Arc::new(ConnectionManager::new(
        root.path().to_owned(),
        root.path().to_owned(),
        Arc::new(UnusedCredentials),
    ));
    let manager = TransferManager {
        shared: Arc::new(Shared {
            state: Mutex::new(State {
                jobs,
                revision: 10,
                running: 0,
                concurrency: 3,
                stopped: false,
                mutating: HashSet::new(),
            }),
            changed: Condvar::new(),
            targets: file_ops::TargetLocks::default(),
        }),
        remote,
        workers: Mutex::new(Vec::new()),
    };
    (manager, root)
}

#[test]
fn remove_finished_only_removes_the_selected_terminal_record_in_enqueue_order() {
    for state in [
        TransferState::Completed,
        TransferState::Failed,
        TransferState::Canceled,
        TransferState::Skipped,
    ] {
        let (queue, _root) = queue(vec![
            record("older", TransferState::Completed),
            record("selected", state),
            record("newer", TransferState::Canceled),
        ]);
        queue.remove_finished("selected").unwrap();
        let snapshot = queue.snapshot().unwrap();
        assert_eq!(snapshot.revision, 11);
        assert_eq!(snapshot.concurrency, 3);
        assert_eq!(
            snapshot
                .jobs
                .iter()
                .map(|job| job.id.as_str())
                .collect::<Vec<_>>(),
            ["older", "newer"]
        );
        assert_eq!(snapshot.jobs[0].state, TransferState::Completed);
        assert_eq!(snapshot.jobs[1].state, TransferState::Canceled);
    }
}

#[test]
fn remove_finished_rejects_all_active_states_without_losing_worker_records() {
    for transfer_state in [
        TransferState::Queued,
        TransferState::Running,
        TransferState::Canceling,
        TransferState::Conflict,
    ] {
        let (queue, _root) = queue(vec![record("active", transfer_state)]);
        queue.lock().unwrap().running = 1;
        let error = queue.remove_finished("active").unwrap_err();
        assert_eq!(error.code, "invalid_transfer_state");
        let state = queue.lock().unwrap();
        assert_eq!(state.revision, 10);
        assert_eq!(state.running, 1);
        assert_eq!(state.jobs.len(), 1);
        assert_eq!(state.jobs[0].job.id, "active");
        assert_eq!(state.jobs[0].job.state, transfer_state);
        assert!(!state.jobs[0].canceled.load(Ordering::SeqCst));
    }
}

#[test]
fn remove_finished_missing_or_already_removed_id_does_not_mutate_the_queue() {
    let (queue, _root) = queue(vec![record("selected", TransferState::Failed)]);
    assert_eq!(
        queue.remove_finished("missing").unwrap_err().code,
        "transfer_missing"
    );
    assert_eq!(queue.snapshot().unwrap().revision, 10);
    queue.remove_finished("selected").unwrap();
    assert_eq!(
        queue.remove_finished("selected").unwrap_err().code,
        "transfer_missing"
    );
    let snapshot = queue.snapshot().unwrap();
    assert!(snapshot.jobs.is_empty());
    assert_eq!(snapshot.revision, 11);
}

#[test]
fn remove_finished_preserves_source_and_destination_files() {
    for direction in [TransferDirection::Upload, TransferDirection::Download] {
        let (queue, root) = queue(vec![record("selected", TransferState::Completed)]);
        let source = root.path().join("source.txt");
        let destination = root.path().join("destination.txt");
        fs::write(&source, b"source content").unwrap();
        fs::write(&destination, b"destination content").unwrap();
        {
            let mut state = queue.lock().unwrap();
            let record = &mut state.jobs[0];
            record.job.direction = direction;
            record.request.direction = direction;
            record.job.source_path = source.to_str().unwrap().into();
            record.request.source_path = record.job.source_path.clone();
            record.job.destination_path = Some(destination.to_str().unwrap().into());
            record.request.destination_dir = root.path().to_str().unwrap().into();
            record.job.destination_dir = record.request.destination_dir.clone();
        }
        queue.remove_finished("selected").unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"source content");
        assert_eq!(fs::read(&destination).unwrap(), b"destination content");
        assert!(queue.snapshot().unwrap().jobs.is_empty());
    }
}

#[test]
fn remove_finished_releases_one_full_queue_slot_and_drops_only_its_record() {
    let selected = record("500", TransferState::Failed);
    let released = Arc::downgrade(&selected.canceled);
    let jobs = (0..1000)
        .map(|index| record(&index.to_string(), TransferState::Completed))
        .collect();
    let (queue, _root) = queue(jobs);
    queue.lock().unwrap().jobs[500] = selected;
    queue.remove_finished("500").unwrap();
    assert!(released.upgrade().is_none());
    let snapshot = queue.snapshot().unwrap();
    assert_eq!(snapshot.jobs.len(), 999);
    assert_eq!(snapshot.jobs[499].id, "499");
    assert_eq!(snapshot.jobs[500].id, "501");
    assert_eq!(snapshot.jobs.first().unwrap().id, "0");
    assert_eq!(snapshot.jobs.last().unwrap().id, "999");
    assert_eq!(snapshot.revision, 11);
}

#[test]
fn remove_finished_rechecks_state_under_the_lock_after_a_record_is_requeued() {
    let (queue, _root) = queue(vec![record("selected", TransferState::Failed)]);
    let mut state = queue.lock().unwrap();
    thread::scope(|scope| {
        let (entered, wait) = std::sync::mpsc::sync_channel(0);
        let queue = &queue;
        let removing = scope.spawn(move || {
            entered.send(()).unwrap();
            queue.remove_finished("selected")
        });
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        reset(&mut state.jobs[0], ConflictPolicy::Ask);
        state.revision += 1;
        drop(state);
        assert_eq!(
            removing.join().unwrap().unwrap_err().code,
            "invalid_transfer_state"
        );
    });
    let state = queue.lock().unwrap();
    assert_eq!(state.revision, 11);
    assert_eq!(state.jobs.len(), 1);
    assert_eq!(state.jobs[0].job.state, TransferState::Queued);
    assert_eq!(state.jobs[0].job.attempt, 2);
}
