use crate::commands::{AppState, with_store};
use fileworker_core::{
    connections::{ConnectedSession, ConnectionManager, HostProbe},
    error::CoreError,
    local::DirectoryListing,
    profiles::ConnectionProfile,
};
use std::sync::Arc;
use tauri::State;
use zeroize::Zeroizing;

async fn profile(state: &AppState, id: String) -> Result<ConnectionProfile, CoreError> {
    with_store(state, move |store| {
        store
            .list()?
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| CoreError::new("profile_missing", "连接配置已不存在，请重新选择"))
    })
    .await
}

async fn run<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&ConnectionManager) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    let remote = Arc::clone(&state.remote);
    tauri::async_runtime::spawn_blocking(move || operation(&remote))
        .await
        .map_err(|_| CoreError::new("worker_failed", "远程连接任务意外结束"))?
}

#[tauri::command]
pub async fn probe_connection(
    state: State<'_, AppState>,
    profile_id: String,
    attempt_id: String,
) -> Result<HostProbe, CoreError> {
    let profile = profile(&state, profile_id).await?;
    run(&state, move |manager| manager.probe(attempt_id, profile)).await
}

#[tauri::command]
pub async fn trust_connection(
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<(), CoreError> {
    run(&state, move |manager| manager.trust(&attempt_id)).await
}

#[tauri::command]
pub async fn authenticate_connection(
    state: State<'_, AppState>,
    attempt_id: String,
    secret: Option<String>,
    remember: bool,
) -> Result<ConnectedSession, CoreError> {
    let secret = secret.map(Zeroizing::new);
    run(&state, move |manager| {
        manager.authenticate(&attempt_id, secret, remember)
    })
    .await
}

#[tauri::command]
pub async fn cancel_connection(
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<(), CoreError> {
    run(&state, move |manager| manager.cancel(&attempt_id)).await
}

#[tauri::command]
pub async fn list_remote_directory(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<DirectoryListing, CoreError> {
    run(&state, move |manager| manager.list(&session_id, &path)).await
}

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CoreError> {
    run(&state, move |manager| manager.disconnect(&session_id)).await
}

#[tauri::command]
pub async fn forget_credential(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), CoreError> {
    let profile = profile(&state, profile_id).await?;
    run(&state, move |manager| manager.forget_credential(&profile)).await
}
