use crate::{
    credentials::{CredentialStore, credential_account},
    error::CoreError,
    known_hosts::{HostIdentity, KnownHostStore},
    local::DirectoryListing,
    profiles::ConnectionProfile,
    remote_files::{self, RemoteFileAction, RemoteFileProperties, RemotePreview},
    sftp::{SftpConnection, connection_lost},
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    net::{Shutdown, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, MutexGuard, TryLockError, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    pub attempt_id: String,
    pub host: String,
    pub port: u16,
    pub identity: HostIdentity,
    pub trusted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedSession {
    pub session_id: String,
    pub profile_id: String,
    pub initial_path: String,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub available: bool,
    pub supported: bool,
}

pub struct ConnectionManager {
    inner: Arc<Mutex<Inner>>,
    expiration: Arc<Condvar>,
    expiry_worker: Option<JoinHandle<()>>,
    credential_operations: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    known_hosts: KnownHostStore,
    credentials: Arc<dyn CredentialStore>,
    home: PathBuf,
    timeout: Duration,
    attempt_lifetime: Duration,
}

#[derive(Default)]
struct Inner {
    stopped: bool,
    pending: Option<Pending>,
    active: HashMap<String, Active>,
    canceled_attempts: HashSet<String>,
}

struct Pending {
    id: String,
    profile: ConnectionProfile,
    created: Instant,
    canceled: Arc<AtomicBool>,
    handle: Option<Handle>,
    socket: Option<Arc<TcpStream>>,
    authenticating: bool,
    needs_reconnect: bool,
}

#[derive(Clone)]
struct Handle {
    identity: HostIdentity,
    connection: Arc<Mutex<SftpConnection>>,
    socket: Arc<TcpStream>,
    canceled: Arc<AtomicBool>,
}

struct Active {
    attempt_id: String,
    handle: Handle,
    profile: ConnectionProfile,
    secret: Arc<Zeroizing<String>>,
    operation_started: Option<Instant>,
}

impl Handle {
    fn close(&self) {
        self.canceled.store(true, Ordering::SeqCst);
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

impl ConnectionManager {
    pub fn new(root: PathBuf, home: PathBuf, credentials: Arc<dyn CredentialStore>) -> Self {
        Self::with_timeouts(
            root,
            home,
            credentials,
            Duration::from_secs(15),
            Duration::from_secs(120),
        )
    }

    pub fn with_timeouts(
        root: PathBuf,
        home: PathBuf,
        credentials: Arc<dyn CredentialStore>,
        timeout: Duration,
        attempt_lifetime: Duration,
    ) -> Self {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let expiration = Arc::new(Condvar::new());
        let expiry_worker = {
            let inner = inner.clone();
            let expiration = expiration.clone();
            thread::spawn(move || expire_connections(inner, expiration, attempt_lifetime, timeout))
        };
        Self {
            inner,
            expiration,
            expiry_worker: Some(expiry_worker),
            credential_operations: Mutex::new(HashMap::new()),
            known_hosts: KnownHostStore::new(root),
            credentials,
            home,
            timeout,
            attempt_lifetime,
        }
    }

    pub fn probe(
        &self,
        attempt_id: String,
        profile: ConnectionProfile,
    ) -> Result<HostProbe, CoreError> {
        self.probe_with_registration(attempt_id, profile, || {})
    }

    pub(crate) fn probe_with_registration(
        &self,
        attempt_id: String,
        profile: ConnectionProfile,
        registered: impl FnOnce(),
    ) -> Result<HostProbe, CoreError> {
        Uuid::parse_str(&attempt_id).map_err(|_| expired())?;
        let profile = profile.validated()?;
        let canceled = Arc::new(AtomicBool::new(false));
        {
            let mut inner = self.lock()?;
            if inner.stopped {
                return Err(closed());
            }
            if inner.canceled_attempts.contains(&attempt_id) {
                return Err(expired());
            }
            if let Some(old) = inner.pending.take() {
                close_pending(old);
            }
            inner.pending = Some(Pending {
                id: attempt_id.clone(),
                profile: profile.clone(),
                created: Instant::now(),
                canceled: canceled.clone(),
                handle: None,
                socket: None,
                authenticating: false,
                needs_reconnect: false,
            });
            self.expiration.notify_all();
        }
        registered();
        let result = SftpConnection::probe(profile.clone(), self.timeout, |socket| {
            let mut inner = self.lock()?;
            let pending = valid_pending(&mut inner, &attempt_id, self.attempt_lifetime)?;
            if !Arc::ptr_eq(&pending.canceled, &canceled) {
                return Err(expired());
            }
            pending.socket = Some(socket);
            Ok(())
        });
        let mut inner = self.lock()?;
        if canceled.load(Ordering::SeqCst) {
            return Err(expired());
        }
        let connection = match result {
            Ok(connection) => connection,
            Err(error) => {
                inner.pending.take();
                return Err(error);
            }
        };
        let trusted =
            match self
                .known_hosts
                .check(&profile.host, profile.port, &connection.identity)
            {
                Ok(trusted) => trusted,
                Err(error) => {
                    inner.pending.take();
                    return Err(error);
                }
            };
        let probe = HostProbe {
            attempt_id: attempt_id.clone(),
            host: profile.host,
            port: profile.port,
            identity: connection.identity.clone(),
            trusted,
        };
        let pending = valid_pending(&mut inner, &attempt_id, self.attempt_lifetime)?;
        pending.created = Instant::now();
        pending.handle = Some(Handle {
            identity: connection.identity.clone(),
            socket: connection.socket.clone(),
            connection: Arc::new(Mutex::new(connection)),
            canceled,
        });
        self.expiration.notify_all();
        Ok(probe)
    }

    pub fn trust(&self, attempt_id: &str) -> Result<(), CoreError> {
        let (profile, handle) = {
            let mut inner = self.lock()?;
            let pending = valid_pending(&mut inner, attempt_id, self.attempt_lifetime)?;
            if pending.authenticating {
                return Err(expired());
            }
            (
                pending.profile.clone(),
                pending.handle.clone().ok_or_else(expired)?,
            )
        };
        self.known_hosts
            .trust_checked(&profile.host, profile.port, &handle.identity, || {
                self.current_attempt(attempt_id, &handle.canceled)
            })?;
        self.check_attempt(attempt_id, &handle.canceled)
    }

    pub fn authenticate(
        &self,
        attempt_id: &str,
        secret: Option<Zeroizing<String>>,
        remember: bool,
    ) -> Result<ConnectedSession, CoreError> {
        let (profile, mut handle, reconnect) = {
            let mut inner = self.lock()?;
            let pending = valid_pending(&mut inner, attempt_id, self.attempt_lifetime)?;
            if pending.authenticating {
                return Err(CoreError::new("connection_busy", "认证正在进行，请稍候"));
            }
            let handle = pending.handle.clone().ok_or_else(expired)?;
            if !self.known_hosts.check(
                &pending.profile.host,
                pending.profile.port,
                &handle.identity,
            )? {
                return Err(CoreError::new("host_not_trusted", "请先确认服务器主机指纹"));
            }
            pending.authenticating = true;
            (pending.profile.clone(), handle, pending.needs_reconnect)
        };
        let account = credential_account(&profile);
        let result = (|| {
            if reconnect {
                let canceled = handle.canceled.clone();
                let connection = SftpConnection::probe(profile.clone(), self.timeout, |socket| {
                    let mut inner = self.lock()?;
                    let pending = valid_pending(&mut inner, attempt_id, self.attempt_lifetime)?;
                    if !Arc::ptr_eq(&pending.canceled, &canceled) {
                        return Err(expired());
                    }
                    pending.socket = Some(socket);
                    Ok(())
                })?;
                if !self
                    .known_hosts
                    .check(&profile.host, profile.port, &connection.identity)?
                {
                    return Err(CoreError::new(
                        "host_not_trusted",
                        "服务器身份尚未确认，请重新连接并核对指纹",
                    ));
                }
                let refreshed = Handle {
                    identity: connection.identity.clone(),
                    socket: connection.socket.clone(),
                    connection: Arc::new(Mutex::new(connection)),
                    canceled,
                };
                let mut inner = self.lock()?;
                let pending = valid_pending(&mut inner, attempt_id, self.attempt_lifetime)?;
                if !Arc::ptr_eq(&pending.canceled, &refreshed.canceled) {
                    return Err(expired());
                }
                pending.handle = Some(refreshed.clone());
                pending.needs_reconnect = false;
                handle = refreshed;
            }
            let secret = match secret {
                Some(secret) => secret,
                None => {
                    let operation = self.credential_operation(&account)?;
                    let _operation = operation.lock().map_err(|_| unavailable())?;
                    self.check_attempt(attempt_id, &handle.canceled)?;
                    self.credentials.get(&account)?
                }
            };
            self.check_attempt(attempt_id, &handle.canceled)?;
            let initial_path = handle
                .connection
                .lock()
                .map_err(|_| unavailable())?
                .authenticate(&secret, &self.home)?;
            if handle.canceled.load(Ordering::SeqCst) {
                return Err(expired());
            }
            // Storage I/O may wait; never hold the lifecycle lock during credential access.
            let operation = remember
                .then(|| self.credential_operation(&account))
                .transpose()?;
            let _operation = operation
                .as_ref()
                .map(|operation| operation.lock().map_err(|_| unavailable()))
                .transpose()?;
            let mut saved = None;
            let warning = if remember {
                self.check_attempt(attempt_id, &handle.canceled)?;
                let previous = match self.credentials.get(&account) {
                    Ok(previous) => Ok(Some(previous)),
                    Err(error) if error.code == "credential_missing" => Ok(None),
                    Err(error) => Err(error),
                };
                self.check_attempt(attempt_id, &handle.canceled)?;
                match previous {
                    Ok(previous) => {
                        // A failed write may already have replaced the file before sync failed.
                        saved = Some(previous);
                        self.credentials
                            .set(&account, &secret)
                            .err()
                            .map(|_| "已连接，但凭据未能保存到本地加密存储，本次仍可使用".into())
                    }
                    Err(_) => Some("已连接，但凭据未能保存到本地加密存储，本次仍可使用".into()),
                }
            } else {
                None
            };
            let connected = (|| {
                let mut inner = self.lock()?;
                let pending = valid_pending(&mut inner, attempt_id, self.attempt_lifetime)?;
                if !Arc::ptr_eq(&pending.canceled, &handle.canceled) {
                    return Err(expired());
                }
                let session_id = Uuid::new_v4().to_string();
                inner.pending.take();
                self.expiration.notify_all();
                inner.active.retain(|_, active| {
                    if active.profile.id == profile.id {
                        active.handle.close();
                        false
                    } else {
                        true
                    }
                });
                inner.active.insert(
                    session_id.clone(),
                    Active {
                        attempt_id: attempt_id.into(),
                        handle: handle.clone(),
                        profile: profile.clone(),
                        secret: Arc::new(secret),
                        operation_started: None,
                    },
                );
                Ok(ConnectedSession {
                    session_id,
                    profile_id: profile.id,
                    initial_path,
                    warning,
                })
            })();
            if connected.is_err()
                && let Some(previous) = saved
            {
                let restored = match previous {
                    Some(previous) => self.credentials.set(&account, &previous),
                    None => self.credentials.delete(&account),
                };
                if restored.is_err() {
                    return Err(CoreError::new(
                        "attempt_expired",
                        "连接已取消或过期，但未能恢复原来的本地凭据，请从连接菜单忘记已存凭据",
                    ));
                }
            }
            connected
        })();
        if result.is_err() {
            let mut inner = self.lock()?;
            if let Some(pending) = inner
                .pending
                .as_mut()
                .filter(|pending| Arc::ptr_eq(&pending.canceled, &handle.canceled))
            {
                pending.authenticating = false;
                pending.needs_reconnect = true;
                if let Some(socket) = pending.socket.take() {
                    let _ = socket.shutdown(Shutdown::Both);
                }
                let _ = handle.socket.shutdown(Shutdown::Both);
            }
        }
        result
    }

    pub fn list(&self, session_id: &str, path: &str) -> Result<DirectoryListing, CoreError> {
        self.with_active(session_id, |connection| connection.list_directory(path))
    }

    pub fn check_session(&self, session_id: &str) -> Result<(), CoreError> {
        let started = Instant::now();
        let handle = self.active_handle(session_id)?;
        match handle.connection.try_lock() {
            Ok(connection) => self.run_operation(
                session_id,
                &handle,
                connection,
                started,
                SftpConnection::check_health,
            ),
            // The running operation has its own deadline; never queue a health check behind it.
            Err(TryLockError::WouldBlock) => {
                if handle.canceled.load(Ordering::SeqCst) {
                    Err(closed())
                } else {
                    Ok(())
                }
            }
            Err(TryLockError::Poisoned(_)) => Err(unavailable()),
        }
    }

    pub fn file_properties(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<RemoteFileProperties, CoreError> {
        self.with_active(session_id, |connection| {
            remote_files::properties(connection.filesystem()?, path)
        })
    }

    pub fn preview_file(&self, session_id: &str, path: &str) -> Result<RemotePreview, CoreError> {
        self.with_active(session_id, |connection| {
            remote_files::preview(connection.filesystem()?, path)
        })
    }

    pub(crate) fn mutate_file(
        &self,
        session_id: &str,
        path: &str,
        action: RemoteFileAction,
    ) -> Result<(), CoreError> {
        self.with_active(session_id, |connection| {
            remote_files::mutate(connection.filesystem()?, path, action)
        })
    }

    fn with_active<T>(
        &self,
        session_id: &str,
        operation: impl FnOnce(&SftpConnection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let started = Instant::now();
        let handle = self.active_handle(session_id)?;
        let mut inner = self.lock()?;
        let connection = loop {
            if handle.canceled.load(Ordering::SeqCst) || !inner.active.contains_key(session_id) {
                return Err(closed());
            }
            let remaining = self.timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(operation_not_started());
            }
            match handle.connection.try_lock() {
                Ok(connection) => break connection,
                Err(TryLockError::Poisoned(_)) => return Err(unavailable()),
                Err(TryLockError::WouldBlock) => {
                    inner = self
                        .expiration
                        .wait_timeout(inner, remaining)
                        .map_err(|_| unavailable())?
                        .0;
                }
            }
        };
        drop(inner);
        self.run_operation(session_id, &handle, connection, started, operation)
    }

    fn active_handle(&self, session_id: &str) -> Result<Handle, CoreError> {
        self.lock()?
            .active
            .get(session_id)
            .map(|active| active.handle.clone())
            .ok_or_else(closed)
    }

    fn run_operation<T>(
        &self,
        session_id: &str,
        handle: &Handle,
        connection: MutexGuard<'_, SftpConnection>,
        started: Instant,
        operation: impl FnOnce(&SftpConnection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        {
            let mut inner = self.lock()?;
            let active = inner
                .active
                .get_mut(session_id)
                .filter(|active| Arc::ptr_eq(&active.handle.canceled, &handle.canceled))
                .ok_or_else(closed)?;
            if handle.canceled.load(Ordering::SeqCst) {
                return Err(closed());
            }
            if started.elapsed() >= self.timeout {
                drop(connection);
                self.expiration.notify_all();
                return Err(operation_not_started());
            }
            active.operation_started = Some(started);
            self.expiration.notify_all();
        }
        let result = operation(&connection);
        let result = if started.elapsed() >= self.timeout {
            self.disconnect(session_id)?;
            Err(connection_lost())
        } else if handle.canceled.load(Ordering::SeqCst) {
            Err(closed())
        } else {
            if result
                .as_ref()
                .is_err_and(|error| error.code == "connection_lost")
            {
                self.disconnect(session_id)?;
            }
            result
        };
        {
            let mut inner = self.lock()?;
            if let Some(active) = inner
                .active
                .get_mut(session_id)
                .filter(|active| Arc::ptr_eq(&active.handle.canceled, &handle.canceled))
            {
                active.operation_started = None;
            }
            // Publish completion and unlock together so queued requests cannot miss the wake-up.
            drop(connection);
            self.expiration.notify_all();
        }
        result
    }

    pub fn is_session_active(&self, session_id: &str) -> bool {
        self.lock().is_ok_and(|inner| {
            inner
                .active
                .get(session_id)
                .is_some_and(|active| !active.handle.canceled.load(Ordering::SeqCst))
        })
    }

    pub(crate) fn transfer_connection(
        &self,
        session_id: &str,
        canceled: &AtomicBool,
    ) -> Result<(SftpConnection, Arc<AtomicBool>), CoreError> {
        let (profile, secret, identity, session_canceled) = {
            let inner = self.lock()?;
            let active = inner.active.get(session_id).ok_or_else(closed)?;
            (
                active.profile.clone(),
                active.secret.clone(),
                active.handle.identity.clone(),
                active.handle.canceled.clone(),
            )
        };
        let check = || {
            if canceled.load(Ordering::SeqCst) || session_canceled.load(Ordering::SeqCst) {
                Err(closed())
            } else {
                Ok(())
            }
        };
        check()?;
        let mut connection = SftpConnection::probe(profile.clone(), self.timeout, |_| check())?;
        check()?;
        if connection.identity != identity
            || !self
                .known_hosts
                .check(&profile.host, profile.port, &connection.identity)?
        {
            return Err(CoreError::new(
                "host_key_changed",
                "传输连接的服务器指纹已变化，已阻止认证",
            ));
        }
        connection.authenticate(&secret, &self.home)?;
        check()?;
        Ok((connection, session_canceled))
    }

    pub fn cancel(&self, attempt_id: &str) -> Result<(), CoreError> {
        Uuid::parse_str(attempt_id).map_err(|_| expired())?;
        let mut inner = self.lock()?;
        // Cancellation may arrive before the queued probe starts; retain it for this app run.
        inner.canceled_attempts.insert(attempt_id.to_owned());
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == attempt_id)
            && let Some(pending) = inner.pending.take()
        {
            close_pending(pending);
            self.expiration.notify_all();
        }
        inner.active.retain(|_, active| {
            if active.attempt_id == attempt_id {
                active.handle.close();
                false
            } else {
                true
            }
        });
        self.expiration.notify_all();
        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> Result<(), CoreError> {
        let mut inner = self.lock()?;
        if let Some(active) = inner.active.remove(session_id) {
            active.handle.close();
        }
        self.expiration.notify_all();
        Ok(())
    }

    pub fn disconnect_profile(&self, profile_id: &str) -> Result<(), CoreError> {
        let mut inner = self.lock()?;
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.profile.id == profile_id)
            && let Some(pending) = inner.pending.take()
        {
            close_pending(pending);
            self.expiration.notify_all();
        }
        inner.active.retain(|_, active| {
            if active.profile.id == profile_id {
                active.handle.close();
                false
            } else {
                true
            }
        });
        self.expiration.notify_all();
        Ok(())
    }

    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.stopped = true;
        if let Some(pending) = inner.pending.take() {
            close_pending(pending);
        }
        for (_, active) in inner.active.drain() {
            active.handle.close();
        }
        self.expiration.notify_all();
    }

    pub fn credential_storage_supported(&self) -> bool {
        self.credentials.supported()
    }

    pub fn forget_credential(&self, profile: &ConnectionProfile) -> Result<(), CoreError> {
        {
            let mut inner = self.lock()?;
            if inner
                .pending
                .as_ref()
                .is_some_and(|pending| pending.profile.id == profile.id && pending.authenticating)
                && let Some(pending) = inner.pending.take()
            {
                close_pending(pending);
                self.expiration.notify_all();
            }
        }
        let account = credential_account(profile);
        let operation = self.credential_operation(&account)?;
        let _operation = operation.lock().map_err(|_| unavailable())?;
        self.credentials.delete(&account)
    }

    pub fn credential_status(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<CredentialStatus, CoreError> {
        let profile = profile.clone().validated()?;
        let supported = self.credentials.supported();
        let available = supported && self.credentials.exists(&credential_account(&profile))?;
        Ok(CredentialStatus {
            available,
            supported,
        })
    }

    fn credential_operation(&self, account: &str) -> Result<Arc<Mutex<()>>, CoreError> {
        let mut operations = self
            .credential_operations
            .lock()
            .map_err(|_| unavailable())?;
        operations.retain(|_, operation| operation.strong_count() > 0);
        if let Some(operation) = operations.get(account).and_then(Weak::upgrade) {
            return Ok(operation);
        }
        let operation = Arc::new(Mutex::new(()));
        operations.insert(account.to_owned(), Arc::downgrade(&operation));
        Ok(operation)
    }

    fn check_attempt(&self, id: &str, canceled: &Arc<AtomicBool>) -> Result<(), CoreError> {
        self.current_attempt(id, canceled).map(|_| ())
    }

    fn current_attempt(
        &self,
        id: &str,
        canceled: &Arc<AtomicBool>,
    ) -> Result<MutexGuard<'_, Inner>, CoreError> {
        let mut inner = self.lock()?;
        let pending = valid_pending(&mut inner, id, self.attempt_lifetime)?;
        if !Arc::ptr_eq(&pending.canceled, canceled) {
            return Err(expired());
        }
        Ok(inner)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Inner>, CoreError> {
        self.inner.lock().map_err(|_| unavailable())
    }
}

fn expire_connections(
    inner: Arc<Mutex<Inner>>,
    expiration: Arc<Condvar>,
    lifetime: Duration,
    operation_timeout: Duration,
) {
    let Ok(mut state) = inner.lock() else { return };
    loop {
        if state.stopped {
            return;
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.created.elapsed() >= lifetime)
            && let Some(pending) = state.pending.take()
        {
            close_pending(pending);
        }
        let active_before = state.active.len();
        state.active.retain(|_, active| {
            if active
                .operation_started
                .is_some_and(|started| started.elapsed() >= operation_timeout)
            {
                active.handle.close();
                false
            } else {
                true
            }
        });
        if state.active.len() != active_before {
            expiration.notify_all();
        }
        let remaining = state
            .pending
            .as_ref()
            .map(|pending| lifetime.saturating_sub(pending.created.elapsed()))
            .into_iter()
            .chain(state.active.values().filter_map(|active| {
                active
                    .operation_started
                    .map(|started| operation_timeout.saturating_sub(started.elapsed()))
            }))
            .min();
        let result = match remaining {
            Some(remaining) => expiration
                .wait_timeout(state, remaining)
                .map(|(state, _)| state)
                .map_err(|_| ()),
            None => expiration.wait(state).map_err(|_| ()),
        };
        match result {
            Ok(next) => state = next,
            Err(_) => return,
        }
    }
}

fn valid_pending<'a>(
    inner: &'a mut Inner,
    id: &str,
    lifetime: Duration,
) -> Result<&'a mut Pending, CoreError> {
    if inner
        .pending
        .as_ref()
        .is_some_and(|pending| pending.created.elapsed() >= lifetime)
        && let Some(pending) = inner.pending.take()
    {
        close_pending(pending);
    }
    inner
        .pending
        .as_mut()
        .filter(|pending| pending.id == id && !pending.canceled.load(Ordering::SeqCst))
        .ok_or_else(expired)
}

fn close_pending(pending: Pending) {
    pending.canceled.store(true, Ordering::SeqCst);
    if let Some(socket) = pending.socket {
        let _ = socket.shutdown(Shutdown::Both);
    }
    if let Some(handle) = pending.handle {
        handle.close();
    }
}

impl Drop for ConnectionManager {
    fn drop(&mut self) {
        self.shutdown();
        if let Some(worker) = self.expiry_worker.take() {
            let _ = worker.join();
        }
    }
}

fn expired() -> CoreError {
    CoreError::new("attempt_expired", "连接尝试已取消或过期，请重新连接")
}
fn closed() -> CoreError {
    CoreError::new("session_closed", "连接已关闭，请重新连接")
}
fn operation_not_started() -> CoreError {
    CoreError::new(
        "remote_file_busy",
        "等待当前连接超时，操作尚未执行，请稍后重试",
    )
}
fn unavailable() -> CoreError {
    CoreError::new("connection_unavailable", "连接状态不可用，请重新启动应用")
}
