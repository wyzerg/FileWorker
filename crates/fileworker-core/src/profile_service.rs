use crate::{
    connections::{ConnectionManager, HostProbe},
    credentials::credential_account,
    error::CoreError,
    profiles::{ConnectionProfile, ProfileStore},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

pub struct ProfileService {
    store: ProfileStore,
    remote: Arc<ConnectionManager>,
    operations: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl ProfileService {
    pub fn new(store: ProfileStore, remote: Arc<ConnectionManager>) -> Self {
        Self {
            store,
            remote,
            operations: Mutex::new(HashMap::new()),
        }
    }

    pub fn store(&self) -> &ProfileStore {
        &self.store
    }

    pub fn save(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, CoreError> {
        let profile = self.validate(profile)?;
        let id = profile.id.clone();
        self.with_profile(&id, || {
            let profile = self.validate(profile)?;
            let old = self.find(&profile.id)?;
            let changed = if let Some(old) =
                old.filter(|old| credential_account(old) != credential_account(&profile))
            {
                self.remote.disconnect_profile(&profile.id)?;
                self.cleanup(&old)?;
                true
            } else {
                false
            };
            self.store
                .save(profile)
                .map_err(|error| after_cleanup(error, changed))
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        self.with_profile(id, || {
            self.remote.disconnect_profile(id)?;
            let old = self.find(id)?;
            if let Some(old) = &old {
                self.cleanup(old)?;
            }
            self.store
                .delete(id)
                .map_err(|error| after_cleanup(error, old.is_some()))
        })
    }

    pub fn probe(&self, id: &str, attempt_id: String) -> Result<HostProbe, CoreError> {
        let operation = self.operation(id)?;
        let guard = operation.lock().map_err(|_| unavailable())?;
        let profile = self.find(id)?.ok_or_else(missing)?;
        // Release only after registration: deletion can cancel even a not-yet-connected socket.
        self.remote
            .probe_with_registration(attempt_id, profile, || drop(guard))
    }

    pub fn forget_credential(&self, id: &str) -> Result<(), CoreError> {
        self.with_profile(id, || {
            self.remote
                .forget_credential(&self.find(id)?.ok_or_else(missing)?)
        })
    }

    fn validate(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, CoreError> {
        let profile = profile.validated()?;
        if let Some(group) = &profile.group_id
            && !self
                .store
                .list_groups()?
                .iter()
                .any(|item| item.id == *group)
        {
            return Err(CoreError::new("invalid_profile", "连接引用的分组不存在"));
        }
        Ok(profile)
    }

    fn find(&self, id: &str) -> Result<Option<ConnectionProfile>, CoreError> {
        Ok(self
            .store
            .list()?
            .into_iter()
            .find(|profile| profile.id == id))
    }

    fn cleanup(&self, profile: &ConnectionProfile) -> Result<(), CoreError> {
        if self.remote.credential_storage_supported() {
            self.remote.forget_credential(profile)?;
        }
        Ok(())
    }

    fn with_profile<T>(
        &self,
        id: &str,
        operation: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let guard = self.operation(id)?;
        let _guard = guard.lock().map_err(|_| unavailable())?;
        operation()
    }

    fn operation(&self, id: &str) -> Result<Arc<Mutex<()>>, CoreError> {
        let mut guards = self.operations.lock().map_err(|_| unavailable())?;
        guards.retain(|_, guard| guard.strong_count() > 0);
        if let Some(guard) = guards.get(id).and_then(Weak::upgrade) {
            return Ok(guard);
        }
        let guard = Arc::new(Mutex::new(()));
        guards.insert(id.to_owned(), Arc::downgrade(&guard));
        Ok(guard)
    }
}

fn missing() -> CoreError {
    CoreError::new("profile_missing", "连接配置已不存在，请重新选择")
}

fn unavailable() -> CoreError {
    CoreError::new("storage_unavailable", "连接配置暂时不可用，请重新启动应用")
}

fn after_cleanup(mut error: CoreError, cleaned: bool) -> CoreError {
    if cleaned {
        error
            .message
            .push_str("；原有凭据可能已移除，下次连接请重新输入");
    }
    error
}
