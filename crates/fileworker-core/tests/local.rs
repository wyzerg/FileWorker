use fileworker_core::local::list_directory;
use std::fs;

#[test]
fn directories_are_listed_before_files() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("a.txt"), b"hello").unwrap();
    fs::create_dir(root.path().join("Z-folder")).unwrap();
    let listing = list_directory(root.path()).unwrap();
    assert_eq!(listing.entries[0].name, "Z-folder");
    assert_eq!(listing.entries[1].name, "a.txt");
    assert_eq!(listing.entries[1].size, Some(5));
}

#[test]
fn empty_directory_is_distinct_from_an_unreadable_path() {
    let root = tempfile::tempdir().unwrap();
    assert!(list_directory(root.path()).unwrap().entries.is_empty());
    assert!(list_directory(&root.path().join("missing")).is_err());
}

#[test]
fn regular_file_cannot_be_opened_as_a_directory() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file.txt");
    fs::write(&path, b"content").unwrap();
    assert!(list_directory(&path).is_err());
}

#[test]
fn hidden_files_remain_identifiable_without_being_removed_by_backend() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join(".env"), b"hidden").unwrap();
    let listing = list_directory(root.path()).unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert!(listing.entries[0].hidden);
}

#[test]
fn navigation_resolves_parent_segments() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("child")).unwrap();
    let listing = list_directory(&root.path().join("child/..")).unwrap();
    assert_eq!(
        listing.path,
        fs::canonicalize(root.path()).unwrap().to_str().unwrap()
    );
    assert!(listing.parent_path.is_some());
}

#[test]
fn serialization_uses_frontend_field_names() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("note"), b"a").unwrap();
    let value = serde_json::to_value(list_directory(root.path()).unwrap()).unwrap();
    assert!(value["entries"][0]["isDir"].is_boolean());
    assert!(value["entries"][0]["modifiedMs"].is_number());
}

#[cfg(unix)]
#[test]
fn symlinked_directories_can_be_browsed_but_keep_their_link_identity() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("destination")).unwrap();
    std::os::unix::fs::symlink(root.path().join("destination"), root.path().join("link")).unwrap();
    let listing = list_directory(root.path()).unwrap();
    let link = listing
        .entries
        .iter()
        .find(|entry| entry.name == "link")
        .unwrap();
    assert!(link.is_dir);
    assert!(link.is_symlink);
    assert!(list_directory(&root.path().join("link")).is_ok());
}

// macOS rejects non-UTF-8 filenames before a directory entry can be created.
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn invalid_utf8_filename_is_not_mapped_to_a_lossy_operation_path() {
    use std::os::unix::ffi::OsStringExt;
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join(std::ffi::OsString::from_vec(vec![0xff])),
        b"data",
    )
    .unwrap();
    let listing = list_directory(root.path()).unwrap();
    assert!(listing.entries.is_empty());
    assert_eq!(listing.warnings.len(), 1);
}
