mod file_ops;

use crate::{connections::ConnectionManager, error::CoreError};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Queued,
    Running,
    Canceling,
    Conflict,
    Completed,
    Failed,
    Canceled,
    Skipped,
}

impl TransferState {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Canceled | Self::Skipped
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Ask,
    Skip,
    Overwrite,
    KeepBoth,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    pub session_id: String,
    pub direction: TransferDirection,
    pub source_path: String,
    pub destination_dir: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub name: String,
    pub attempt: u64,
    pub source_path: String,
    pub destination_dir: String,
    pub destination_path: Option<String>,
    pub state: TransferState,
    pub transferred_bytes: u64,
    pub total_bytes: Option<u64>,
    pub bytes_per_second: u64,
    pub eta_seconds: Option<u64>,
    pub error: Option<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub revision: u64,
    pub concurrency: usize,
    pub jobs: Vec<TransferJob>,
}

pub struct TransferManager {
    shared: Arc<Shared>,
    remote: Arc<ConnectionManager>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    targets: file_ops::TargetLocks,
}
struct State {
    jobs: Vec<Record>,
    revision: u64,
    running: usize,
    concurrency: usize,
    stopped: bool,
}
struct Record {
    job: TransferJob,
    request: TransferRequest,
    policy: ConflictPolicy,
    canceled: Arc<AtomicBool>,
    started: Option<Instant>,
}

impl TransferManager {
    pub fn new(remote: Arc<ConnectionManager>) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                jobs: Vec::new(),
                revision: 0,
                running: 0,
                concurrency: 3,
                stopped: false,
            }),
            changed: Condvar::new(),
            targets: file_ops::TargetLocks::default(),
        });
        let workers = (0..6)
            .map(|_| {
                let shared = shared.clone();
                let remote = remote.clone();
                thread::spawn(move || worker(shared, remote))
            })
            .collect();
        Self {
            shared,
            remote,
            workers: Mutex::new(workers),
        }
    }

    pub fn enqueue(&self, requests: Vec<TransferRequest>) -> Result<Vec<String>, CoreError> {
        if requests.is_empty() || requests.len() > 256 {
            return Err(CoreError::new(
                "invalid_transfer",
                "每次请选择 1 到 256 个文件",
            ));
        }
        let names = requests
            .iter()
            .map(|request| {
                if !self.remote.is_session_active(&request.session_id) {
                    return Err(closed());
                }
                validate_request(request)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut state = self.lock()?;
        if state.stopped || state.jobs.len() + requests.len() > 1000 {
            return Err(CoreError::new(
                "queue_full",
                "传输队列已满，请先清理已结束的任务",
            ));
        }
        let mut ids = Vec::new();
        for (request, name) in requests.into_iter().zip(names) {
            let id = Uuid::new_v4().to_string();
            ids.push(id.clone());
            state.jobs.push(Record {
                job: TransferJob {
                    id,
                    session_id: request.session_id.clone(),
                    direction: request.direction,
                    name,
                    attempt: 1,
                    source_path: request.source_path.clone(),
                    destination_dir: request.destination_dir.clone(),
                    destination_path: None,
                    state: TransferState::Queued,
                    transferred_bytes: 0,
                    total_bytes: None,
                    bytes_per_second: 0,
                    eta_seconds: None,
                    error: None,
                    warning: None,
                },
                request,
                policy: ConflictPolicy::Ask,
                canceled: Arc::new(AtomicBool::new(false)),
                started: None,
            });
        }
        state.revision += 1;
        self.shared.changed.notify_all();
        Ok(ids)
    }

    pub fn snapshot(&self) -> Result<TransferSnapshot, CoreError> {
        let mut state = self.lock()?;
        cancel_closed_sessions(&mut state, &self.remote);
        Ok(TransferSnapshot {
            revision: state.revision,
            concurrency: state.concurrency,
            jobs: state.jobs.iter().map(|record| record.job.clone()).collect(),
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), CoreError> {
        let mut state = self.lock()?;
        let record = record_mut(&mut state, id)?;
        if record.job.state.is_finished() {
            return Ok(());
        }
        record.canceled.store(true, Ordering::SeqCst);
        record.job.state = if matches!(
            record.job.state,
            TransferState::Running | TransferState::Canceling
        ) {
            TransferState::Canceling
        } else {
            TransferState::Canceled
        };
        state.revision += 1;
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn retry(&self, id: &str) -> Result<(), CoreError> {
        let mut state = self.lock()?;
        let record = record_mut(&mut state, id)?;
        if !matches!(
            record.job.state,
            TransferState::Failed | TransferState::Canceled
        ) {
            return Err(CoreError::new(
                "invalid_transfer_state",
                "只有失败或已取消的任务可以重试",
            ));
        }
        if !self.remote.is_session_active(&record.request.session_id) {
            return Err(closed());
        }
        reset(record, ConflictPolicy::Ask);
        state.revision += 1;
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn resolve_conflict(&self, id: &str, policy: ConflictPolicy) -> Result<(), CoreError> {
        if policy == ConflictPolicy::Ask {
            return Err(CoreError::new(
                "invalid_conflict",
                "请选择同名文件的处理方式",
            ));
        }
        let mut state = self.lock()?;
        let record = record_mut(&mut state, id)?;
        if record.job.state != TransferState::Conflict {
            return Err(CoreError::new(
                "invalid_transfer_state",
                "此任务已不再等待同名文件处理",
            ));
        }
        if !self.remote.is_session_active(&record.request.session_id) {
            return Err(closed());
        }
        if policy == ConflictPolicy::Skip {
            record.job.state = TransferState::Skipped;
        } else {
            reset(record, policy);
        }
        state.revision += 1;
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn set_concurrency(&self, concurrency: usize) -> Result<(), CoreError> {
        if !(1..=6).contains(&concurrency) {
            return Err(CoreError::new(
                "invalid_concurrency",
                "同时传输数量必须在 1 到 6 之间",
            ));
        }
        let mut state = self.lock()?;
        state.concurrency = concurrency;
        state.revision += 1;
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn clear_finished(&self) -> Result<(), CoreError> {
        let mut state = self.lock()?;
        state.jobs.retain(|record| !record.job.state.is_finished());
        state.revision += 1;
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.stopped = true;
            for record in &mut state.jobs {
                record.canceled.store(true, Ordering::SeqCst);
                if !record.job.state.is_finished() {
                    record.job.state = if matches!(
                        record.job.state,
                        TransferState::Running | TransferState::Canceling
                    ) {
                        TransferState::Canceling
                    } else {
                        TransferState::Canceled
                    };
                }
            }
            state.revision += 1;
        }
        self.shared.changed.notify_all();
        if let Ok(mut workers) = self.workers.lock() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>, CoreError> {
        self.shared.state.lock().map_err(|_| unavailable())
    }
}

fn reset(record: &mut Record, policy: ConflictPolicy) {
    record.job.attempt = record.job.attempt.saturating_add(1);
    record.policy = policy;
    record.canceled = Arc::new(AtomicBool::new(false));
    record.started = None;
    record.job.state = TransferState::Queued;
    record.job.transferred_bytes = 0;
    record.job.total_bytes = None;
    record.job.bytes_per_second = 0;
    record.job.eta_seconds = None;
    record.job.error = None;
    record.job.warning = None;
}

fn cancel_closed_sessions(state: &mut State, remote: &ConnectionManager) {
    let mut changed = false;
    for record in &mut state.jobs {
        if record.job.state.is_finished() || remote.is_session_active(&record.request.session_id) {
            continue;
        }
        record.canceled.store(true, Ordering::SeqCst);
        let next = if matches!(
            record.job.state,
            TransferState::Running | TransferState::Canceling
        ) {
            TransferState::Canceling
        } else {
            TransferState::Canceled
        };
        changed |= record.job.state != next;
        record.job.state = next;
    }
    if changed {
        state.revision += 1;
    }
}

fn worker(shared: Arc<Shared>, remote: Arc<ConnectionManager>) {
    loop {
        let work = {
            let Ok(mut state) = shared.state.lock() else {
                return;
            };
            loop {
                if state.stopped {
                    return;
                }
                cancel_closed_sessions(&mut state, &remote);
                if state.running < state.concurrency
                    && let Some(record) = state
                        .jobs
                        .iter_mut()
                        .find(|record| record.job.state == TransferState::Queued)
                {
                    record.job.state = TransferState::Running;
                    record.started = Some(Instant::now());
                    let work = (
                        record.job.id.clone(),
                        record.request.clone(),
                        record.policy,
                        record.canceled.clone(),
                    );
                    state.running += 1;
                    state.revision += 1;
                    break work;
                }
                let Ok((next, _)) = shared
                    .changed
                    .wait_timeout(state, Duration::from_millis(200))
                else {
                    return;
                };
                state = next;
            }
        };
        let (id, request, policy, canceled) = work;
        let result = file_ops::execute(
            &remote,
            &shared.targets,
            &request,
            policy,
            &canceled,
            |done, total, target| {
                if let Ok(mut state) = shared.state.lock()
                    && let Ok(record) = record_mut(&mut state, &id)
                {
                    record.job.transferred_bytes = done;
                    record.job.total_bytes = Some(total);
                    record.job.destination_path = Some(target.to_owned());
                    let elapsed = record
                        .started
                        .map(|start| start.elapsed().as_secs_f64())
                        .unwrap_or(0.0);
                    let speed = if elapsed > 0.0 {
                        (done as f64 / elapsed) as u64
                    } else {
                        0
                    };
                    record.job.bytes_per_second = speed;
                    record.job.eta_seconds =
                        (speed > 0).then(|| total.saturating_sub(done).div_ceil(speed));
                    state.revision += 1;
                }
            },
        );
        let Ok(mut state) = shared.state.lock() else {
            return;
        };
        state.running = state.running.saturating_sub(1);
        if let Ok(record) = record_mut(&mut state, &id) {
            record.job.bytes_per_second = 0;
            record.job.eta_seconds = None;
            match result {
                Ok(outcome) => {
                    record.job.state = TransferState::Completed;
                    record.job.destination_path = Some(outcome.path);
                    record.job.warning = outcome.warning;
                }
                Err(error)
                    if error.code == "transfer_conflict"
                        && !canceled.load(Ordering::SeqCst)
                        && remote.is_session_active(&request.session_id) =>
                {
                    record.job.state = TransferState::Conflict;
                    record.job.error = Some(error.message);
                }
                Err(error) => {
                    record.job.state = if canceled.load(Ordering::SeqCst)
                        || !remote.is_session_active(&request.session_id)
                    {
                        TransferState::Canceled
                    } else {
                        TransferState::Failed
                    };
                    record.job.error = Some(error.message);
                }
            }
        }
        state.revision += 1;
        shared.changed.notify_all();
    }
}

fn validate_request(request: &TransferRequest) -> Result<String, CoreError> {
    for value in [&request.source_path, &request.destination_dir] {
        if !value.starts_with('/') || value.chars().any(char::is_control) || value.len() > 32_768 {
            return Err(CoreError::new(
                "invalid_transfer_path",
                "传输需要不含控制字符的绝对路径",
            ));
        }
        #[cfg(windows)]
        if value.contains('\\') {
            return Err(CoreError::new(
                "unsupported_path",
                "此平台暂不支持此传输路径",
            ));
        }
    }
    let name = request.source_path.rsplit('/').next().unwrap_or("");
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(CoreError::new(
            "invalid_transfer_path",
            "请选择一个普通文件",
        ));
    }
    Ok(name.into())
}

fn record_mut<'a>(state: &'a mut State, id: &str) -> Result<&'a mut Record, CoreError> {
    state
        .jobs
        .iter_mut()
        .find(|record| record.job.id == id)
        .ok_or_else(|| CoreError::new("transfer_missing", "此传输任务已不存在"))
}
fn closed() -> CoreError {
    CoreError::new("session_closed", "原连接已关闭，请重新选择文件并传输")
}
fn unavailable() -> CoreError {
    CoreError::new("queue_unavailable", "传输队列不可用，请重新启动应用")
}

impl Drop for TransferManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
