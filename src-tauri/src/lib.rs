mod commands;
mod credentials;
mod remote;
mod transfers;

use commands::AppState;
use fileworker_core::profiles::ProfileStore;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let home = app.path().home_dir()?;
            let root = app.path().app_data_dir()?;
            let remote = Arc::new(fileworker_core::connections::ConnectionManager::new(
                root.clone(),
                home.clone(),
                Arc::new(credentials::NativeCredentialStore),
            ));
            let transfers = Arc::new(fileworker_core::transfers::TransferManager::new(
                remote.clone(),
            ));
            app.manage(AppState {
                home,
                profiles: Arc::new(Mutex::new(ProfileStore::new(root))),
                remote,
                transfers,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_environment,
            commands::list_local_directory,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            remote::probe_connection,
            remote::trust_connection,
            remote::authenticate_connection,
            remote::cancel_connection,
            remote::list_remote_directory,
            remote::disconnect_session,
            remote::forget_credential,
            transfers::enqueue_transfers,
            transfers::transfer_snapshot,
            transfers::cancel_transfer,
            transfers::retry_transfer,
            transfers::resolve_transfer_conflict,
            transfers::set_transfer_concurrency,
            transfers::clear_finished_transfers,
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 FileWorker")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. })
                && let Some(state) = app.try_state::<AppState>()
            {
                state.transfers.shutdown();
            }
        });
}
