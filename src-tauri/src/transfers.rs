use crate::commands::AppState;
use fileworker_core::{
    error::CoreError,
    transfers::{ConflictPolicy, TransferManager, TransferRequest, TransferSnapshot},
};
use tauri::State;

async fn run<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&TransferManager) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    let transfers = state.transfers.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&transfers))
        .await
        .map_err(|_| CoreError::new("worker_failed", "传输队列操作意外结束"))?
}

#[tauri::command]
pub async fn enqueue_transfers(
    state: State<'_, AppState>,
    requests: Vec<TransferRequest>,
) -> Result<Vec<String>, CoreError> {
    run(&state, move |queue| queue.enqueue(requests)).await
}

#[tauri::command]
pub async fn transfer_snapshot(state: State<'_, AppState>) -> Result<TransferSnapshot, CoreError> {
    run(&state, |queue| queue.snapshot()).await
}

#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, id: String) -> Result<(), CoreError> {
    run(&state, move |queue| queue.cancel(&id)).await
}

#[tauri::command]
pub async fn retry_transfer(state: State<'_, AppState>, id: String) -> Result<(), CoreError> {
    run(&state, move |queue| queue.retry(&id)).await
}

#[tauri::command]
pub async fn resolve_transfer_conflict(
    state: State<'_, AppState>,
    id: String,
    policy: ConflictPolicy,
) -> Result<(), CoreError> {
    run(&state, move |queue| queue.resolve_conflict(&id, policy)).await
}

#[tauri::command]
pub async fn set_transfer_concurrency(
    state: State<'_, AppState>,
    concurrency: usize,
) -> Result<(), CoreError> {
    run(&state, move |queue| queue.set_concurrency(concurrency)).await
}

#[tauri::command]
pub async fn clear_finished_transfers(state: State<'_, AppState>) -> Result<(), CoreError> {
    run(&state, |queue| queue.clear_finished()).await
}
