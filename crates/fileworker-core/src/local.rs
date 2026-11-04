use crate::error::CoreError;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<FileEntry>,
    pub warnings: Vec<String>,
}

pub fn list_directory(path: &Path) -> Result<DirectoryListing, CoreError> {
    let path = fs::canonicalize(path)
        .map_err(|error| CoreError::new("directory_io", format!("无法打开目录：{error}")))?;
    let display_path = path
        .to_str()
        .ok_or_else(|| CoreError::new("unsupported_path", "该目录路径无法表示为 UTF-8"))?
        .to_owned();
    let directory = fs::read_dir(&path)
        .map_err(|error| CoreError::new("directory_io", format!("无法读取目录：{error}")))?;
    let mut entries = Vec::new();
    let mut warnings = Vec::new();

    for result in directory {
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("一个目录项无法读取：{error}"));
                continue;
            }
        };
        let entry_path = entry.path();
        let (Some(name), Some(full_path)) = (
            entry.file_name().to_str().map(str::to_owned),
            entry_path.to_str(),
        ) else {
            warnings.push("已跳过一个非 UTF-8 文件名，未将它转换为其他路径".into());
            continue;
        };
        let metadata = match fs::symlink_metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!("无法读取「{name}」的信息：{error}"));
                continue;
            }
        };
        let is_symlink = metadata.is_symlink();
        let metadata = if is_symlink {
            fs::metadata(&entry_path).unwrap_or(metadata)
        } else {
            metadata
        };
        let is_dir = metadata.is_dir();
        entries.push(FileEntry {
            hidden: name.starts_with('.'),
            name,
            path: full_path.to_owned(),
            is_dir,
            is_symlink,
            size: (!is_dir).then_some(metadata.len()),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .and_then(|duration| duration.as_millis().try_into().ok()),
        });
    }

    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(DirectoryListing {
        path: display_path,
        parent_path: path.parent().and_then(Path::to_str).map(str::to_owned),
        entries,
        warnings,
    })
}
