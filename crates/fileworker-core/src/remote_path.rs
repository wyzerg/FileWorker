use crate::error::CoreError;

pub fn resolve(base: &str, input: &str) -> Result<String, CoreError> {
    if !base.starts_with('/')
        || base.chars().any(char::is_control)
        || input.is_empty()
        || input.chars().any(char::is_control)
    {
        return Err(CoreError::new(
            "invalid_remote_path",
            "请输入有效的远程路径，路径不能包含控制字符",
        ));
    }
    // REALPATH must resolve symlinks before ".."; lexical normalization changes the target.
    Ok(if input.starts_with('/') {
        input.to_owned()
    } else {
        format!("{}/{input}", base.trim_end_matches('/'))
    })
}

pub fn parent(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let (parent, _) = path.trim_end_matches('/').rsplit_once('/')?;
    Some(if parent.is_empty() { "/" } else { parent }.into())
}
