use fileworker_core::remote_path::{parent, resolve};

#[test]
fn paths_keep_server_resolved_segments_and_backslashes_literal() {
    for (base, input, expected) in [
        ("/a/b", "../c", "/a/b/../c"),
        ("/a", "/x//y/./z/..", "/x//y/./z/.."),
        ("/", "../../", "/../../"),
        ("/home", ".", "/home/."),
        ("/a", r"dir\name", r"/a/dir\name"),
        ("/a", "中文 文件", "/a/中文 文件"),
    ] {
        assert_eq!(resolve(base, input).unwrap(), expected);
    }
    assert_eq!(parent("/"), None);
    assert_eq!(parent("/a/b"), Some("/a".into()));
}

#[test]
fn invalid_paths_never_become_different_valid_paths() {
    for input in ["", "a\0b", "a\nb"] {
        assert_eq!(resolve("/", input).unwrap_err().code, "invalid_remote_path");
    }
    assert!(resolve("relative", "child").is_err());
}
