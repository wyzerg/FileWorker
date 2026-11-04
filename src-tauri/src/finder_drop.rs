use crate::commands::AppState;
use fileworker_core::{
    error::CoreError,
    transfers::{TransferDirection, TransferRequest},
};
use std::{collections::HashSet, fs, path::PathBuf};
use tauri::State;

const MAX_FILES: usize = 256;

fn validate_sources(paths: Vec<String>) -> Result<Vec<String>, CoreError> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(CoreError::new(
            "invalid_drop_batch",
            "每次请拖入 1 到 256 个普通文件",
        ));
    }
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|text| {
            let path = PathBuf::from(&text);
            if !path.is_absolute() || text.len() > 32_768 || text.chars().any(char::is_control) {
                return Err(CoreError::new(
                    "unsupported_path",
                    "拖入文件的路径无法用于传输",
                ));
            }
            if !seen.insert(path.clone()) {
                return Err(CoreError::new(
                    "duplicate_drop_file",
                    "拖入批次包含重复文件，请重新选择",
                ));
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                CoreError::new(
                    "drop_source_unavailable",
                    format!("无法读取拖入文件「{}」：{error}", path.display()),
                )
            })?;
            if !metadata.file_type().is_file() {
                return Err(CoreError::new(
                    "unsupported_drop_source",
                    "只能拖入普通文件，目录和符号链接不受支持",
                ));
            }
            Ok(text)
        })
        .collect()
}

#[tauri::command]
pub async fn enqueue_finder_upload(
    state: State<'_, AppState>,
    paths: Vec<String>,
    session_id: String,
    destination_dir: String,
) -> Result<Vec<String>, CoreError> {
    let queue = state.transfers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let requests = validate_sources(paths)?
            .into_iter()
            .map(|source_path| TransferRequest {
                session_id: session_id.clone(),
                direction: TransferDirection::Upload,
                source_path,
                destination_dir: destination_dir.clone(),
            })
            .collect();
        queue.enqueue(requests)
    })
    .await
    .map_err(|_| CoreError::new("worker_failed", "拖入文件校验意外结束，请重新拖入"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    #[test]
    fn rejects_empty_oversized_relative_and_duplicate_batches() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file.txt");
        fs::write(&file, b"untouched").unwrap();
        let file = file.to_str().unwrap().to_owned();
        assert!(validate_sources(Vec::new()).is_err());
        assert!(validate_sources(vec![file.clone(); 257]).is_err());
        assert!(validate_sources(vec!["relative.txt".into()]).is_err());
        assert!(validate_sources(vec![file.clone(), file]).is_err());
    }

    #[test]
    fn validates_all_sources_before_queueing_and_preserves_contents() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("a.txt");
        let second = root.path().join("报告.txt");
        fs::write(&first, b"one").unwrap();
        fs::write(&second, b"two").unwrap();
        let first_text = first.to_str().unwrap().to_owned();
        let second_text = second.to_str().unwrap().to_owned();
        assert_eq!(
            validate_sources(vec![first_text.clone(), second_text.clone()]).unwrap(),
            vec![first_text, second_text]
        );
        assert_eq!(fs::read(&first).unwrap(), b"one");
        assert_eq!(fs::read(&second).unwrap(), b"two");
    }

    #[test]
    fn rejects_directory_missing_file_and_symlink_as_a_whole_batch() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file.txt");
        fs::write(&file, b"untouched").unwrap();
        let file_text = file.to_str().unwrap().to_owned();
        let directory_text = root.path().to_str().unwrap().to_owned();
        let missing_text = root.path().join("missing").to_str().unwrap().to_owned();
        for invalid in [directory_text, missing_text] {
            assert!(validate_sources(vec![file_text.clone(), invalid]).is_err());
        }
        #[cfg(unix)]
        {
            let link = root.path().join("link.txt");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(
                validate_sources(vec![file_text.clone(), link.to_str().unwrap().to_owned()])
                    .is_err()
            );
        }
        assert_eq!(fs::read(Path::new(&file_text)).unwrap(), b"untouched");
    }
}
