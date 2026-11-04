use fileworker_core::{
    error::CoreError,
    local::{DirectoryListing, list_directory},
    profiles::{ConnectionProfile, ProfileStore},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::State;

pub struct AppState {
    pub home: PathBuf,
    pub profiles: Arc<Mutex<ProfileStore>>,
    pub remote: Arc<fileworker_core::connections::ConnectionManager>,
    pub transfers: Arc<fileworker_core::transfers::TransferManager>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    name: &'static str,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    home_path: String,
    shortcuts: Vec<Shortcut>,
    runtime: &'static str,
}

#[tauri::command]
pub fn get_environment(state: State<'_, AppState>) -> Result<Environment, CoreError> {
    let home_path = state
        .home
        .to_str()
        .ok_or_else(|| CoreError::new("unsupported_path", "主目录路径无法表示为 UTF-8"))?
        .to_owned();
    let candidates = [
        ("主目录", state.home.clone()),
        ("桌面", state.home.join("Desktop")),
        ("下载", state.home.join("Downloads")),
        ("文稿", state.home.join("Documents")),
    ];
    Ok(Environment {
        home_path,
        shortcuts: candidates
            .into_iter()
            .filter_map(|(name, path)| {
                if path.is_dir() {
                    path.to_str().map(|path| Shortcut {
                        name,
                        path: path.to_owned(),
                    })
                } else {
                    None
                }
            })
            .collect(),
        runtime: "desktop",
    })
}

#[tauri::command]
pub async fn list_local_directory(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<DirectoryListing, CoreError> {
    let path = match path.as_deref() {
        None | Some("") | Some("~") => state.home.clone(),
        Some(value) if value.starts_with("~/") => state.home.join(&value[2..]),
        Some(value) => PathBuf::from(value),
    };
    if !path.is_absolute() {
        return Err(CoreError::new(
            "invalid_path",
            "请输入绝对路径，或以 ~/ 开头的路径",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || list_directory(&path))
        .await
        .map_err(|_| CoreError::new("worker_failed", "目录读取任务意外结束"))?
}

#[tauri::command]
pub async fn list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, CoreError> {
    with_store(&state, |store| store.list()).await
}

#[tauri::command]
pub async fn save_profile(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> Result<ConnectionProfile, CoreError> {
    with_store(&state, move |store| store.save(profile)).await
}

#[tauri::command]
pub async fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), CoreError> {
    with_store(&state, move |store| store.delete(&id)).await
}

pub(crate) async fn with_store<T, F>(state: &AppState, operation: F) -> Result<T, CoreError>
where
    T: Send + 'static,
    F: FnOnce(&ProfileStore) -> Result<T, CoreError> + Send + 'static,
{
    let profiles = Arc::clone(&state.profiles);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = profiles.lock().map_err(|_| {
            CoreError::new("storage_unavailable", "配置存储暂时不可用，请重新启动应用")
        })?;
        operation(&guard)
    })
    .await
    .map_err(|_| CoreError::new("worker_failed", "配置操作意外结束"))?
}
