use crate::commands::{AppState, with_profiles, with_store};
use fileworker_core::{
    connections::{ConnectedSession, ConnectionManager, CredentialStatus, HostProbe},
    error::CoreError,
    local::DirectoryListing,
    profiles::ConnectionProfile,
    remote_files::{RemoteFileAction, RemoteFileProperties, RemotePreview},
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

async fn run_test<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&ConnectionManager) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    let manager = Arc::clone(&state.connection_tests);
    tauri::async_runtime::spawn_blocking(move || operation(&manager))
        .await
        .map_err(|_| CoreError::new("worker_failed", "连接测试任务意外结束"))?
}

#[tauri::command]
pub async fn credential_status(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<CredentialStatus, CoreError> {
    let profile = profile(&state, profile_id).await?;
    run(&state, move |manager| manager.credential_status(&profile)).await
}

#[tauri::command]
pub async fn probe_draft_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    attempt_id: String,
) -> Result<HostProbe, CoreError> {
    run_test(&state, move |manager| manager.probe(attempt_id, profile)).await
}

#[tauri::command]
pub async fn trust_test_connection(
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<(), CoreError> {
    run_test(&state, move |manager| manager.trust(&attempt_id)).await
}

#[tauri::command]
pub async fn authenticate_test_connection(
    state: State<'_, AppState>,
    attempt_id: String,
    secret: Option<String>,
) -> Result<ConnectedSession, CoreError> {
    let secret = secret.map(Zeroizing::new);
    run_test(&state, move |manager| {
        let result = manager.authenticate(&attempt_id, secret, false);
        manager.cancel(&attempt_id)?;
        result
    })
    .await
}

#[tauri::command]
pub async fn cancel_test_connection(
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<(), CoreError> {
    run_test(&state, move |manager| manager.cancel(&attempt_id)).await
}

#[tauri::command]
pub async fn probe_connection(
    state: State<'_, AppState>,
    profile_id: String,
    attempt_id: String,
) -> Result<HostProbe, CoreError> {
    with_profiles(&state, move |service| {
        service.probe(&profile_id, attempt_id)
    })
    .await
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
pub async fn check_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CoreError> {
    run(&state, move |manager| manager.check_session(&session_id)).await
}

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CoreError> {
    run(&state, move |manager| manager.disconnect(&session_id)).await
}

#[tauri::command]
pub async fn remote_file_properties(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<RemoteFileProperties, CoreError> {
    run(&state, move |manager| {
        manager.file_properties(&session_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn preview_remote_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<RemotePreview, CoreError> {
    run(&state, move |manager| {
        manager.preview_file(&session_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn mutate_remote_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    action: RemoteFileAction,
) -> Result<(), CoreError> {
    let transfers = Arc::clone(&state.transfers);
    tauri::async_runtime::spawn_blocking(move || {
        transfers.mutate_remote_file(&session_id, &path, action)
    })
    .await
    .map_err(|_| CoreError::new("worker_failed", "远程文件任务意外结束，请刷新确认"))?
}

#[tauri::command]
pub async fn forget_credential(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), CoreError> {
    with_profiles(&state, move |service| {
        service.forget_credential(&profile_id)
    })
    .await
}
