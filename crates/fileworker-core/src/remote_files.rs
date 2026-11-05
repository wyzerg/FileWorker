use crate::{error::CoreError, remote_path};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use ssh2::{ErrorCode, FileStat, RenameFlags, Sftp};
use std::{io::Read, path::Path};

const TEXT_LIMIT: u64 = 1024 * 1024;
const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;
const PIXEL_LIMIT: u64 = 40_000_000;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RemoteFileAction {
    CreateDirectory { name: String },
    Rename { name: String },
    Delete {},
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileProperties {
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub permissions: Option<String>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemotePreview {
    Text {
        path: String,
        text: String,
    },
    Image {
        path: String,
        mime: String,
        data: String,
    },
}

pub(crate) fn properties(sftp: &Sftp, path: &str) -> Result<RemoteFileProperties, CoreError> {
    validate_path(path)?;
    let stat = sftp.lstat(Path::new(path)).map_err(remote_error)?;
    Ok(RemoteFileProperties {
        path: path.into(),
        kind: if stat.is_file() {
            "file"
        } else if stat.is_dir() {
            "directory"
        } else if stat.file_type().is_symlink() {
            "symlink"
        } else {
            "special"
        }
        .into(),
        size: stat.size,
        modified_ms: stat.mtime.and_then(|time| time.checked_mul(1000)),
        permissions: stat.perm.map(|mode| format!("{:04o}", mode & 0o7777)),
        uid: stat.uid,
        gid: stat.gid,
    })
}

pub(crate) fn preview(sftp: &Sftp, path: &str) -> Result<RemotePreview, CoreError> {
    validate_path(path)?;
    let before = sftp.lstat(Path::new(path)).map_err(remote_error)?;
    if !before.is_file() {
        return Err(failed("只能预览普通文件，不能预览目录、符号链接或特殊文件"));
    }
    let size = before
        .size
        .ok_or_else(|| failed("服务器未提供文件大小，无法安全预览"))?;
    if size > IMAGE_LIMIT {
        return Err(too_large());
    }
    let mut input = sftp.open(Path::new(path)).map_err(remote_error)?;
    if !same_file(&before, &input.stat().map_err(remote_error)?) {
        return Err(changed());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    (&mut input)
        .take(IMAGE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CoreError::new("connection_lost", "预览读取失败或超时，请重新连接"))?;
    if bytes.len() as u64 != size
        || !same_file(&before, &input.stat().map_err(remote_error)?)
        || !same_file(&before, &sftp.lstat(Path::new(path)).map_err(remote_error)?)
    {
        return Err(changed());
    }
    input.close().map_err(remote_error)?;
    classify(path, bytes)
}

fn classify(path: &str, bytes: Vec<u8>) -> Result<RemotePreview, CoreError> {
    if let Some((mime, width, height)) = raster_dimensions(&bytes) {
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > PIXEL_LIMIT {
            return Err(failed("图片像素尺寸过大或无效，请下载后查看"));
        }
        return Ok(RemotePreview::Image {
            path: path.into(),
            mime: mime.into(),
            data: STANDARD.encode(bytes),
        });
    }
    if bytes.len() as u64 > TEXT_LIMIT {
        return Err(too_large());
    }
    let text = String::from_utf8(bytes).map_err(|_| unsupported())?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(unsupported());
    }
    Ok(RemotePreview::Text {
        path: path.into(),
        text,
    })
}

// Read only bounded raster headers. Active formats (HTML/SVG) are never rendered as images.
fn raster_dimensions(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
        return Some((
            "image/png",
            u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
            u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
        ));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some((
            "image/gif",
            u16::from_le_bytes(bytes.get(6..8)?.try_into().ok()?) as u32,
            u16::from_le_bytes(bytes.get(8..10)?.try_into().ok()?) as u32,
        ));
    }
    if bytes.starts_with(b"\xff\xd8") {
        let mut offset = 2;
        while offset + 4 <= bytes.len() {
            if bytes[offset] != 0xff {
                return None;
            }
            let marker = bytes[offset + 1];
            if marker == 0xff {
                offset += 1;
                continue;
            }
            if marker == 0xda || marker == 0xd9 {
                return None;
            }
            let length =
                u16::from_be_bytes(bytes.get(offset + 2..offset + 4)?.try_into().ok()?) as usize;
            if length < 2 || offset + 2 + length > bytes.len() {
                return None;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
                && length >= 7
            {
                return Some((
                    "image/jpeg",
                    u16::from_be_bytes(bytes.get(offset + 7..offset + 9)?.try_into().ok()?) as u32,
                    u16::from_be_bytes(bytes.get(offset + 5..offset + 7)?.try_into().ok()?) as u32,
                ));
            }
            offset += 2 + length;
        }
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        let le24 = |start| -> Option<u32> {
            let part = bytes.get(start..start + 3)?;
            Some(u32::from(part[0]) | u32::from(part[1]) << 8 | u32::from(part[2]) << 16)
        };
        return match bytes.get(12..16)? {
            b"VP8X" => Some(("image/webp", le24(24)? + 1, le24(27)? + 1)),
            b"VP8L" if bytes.get(20) == Some(&0x2f) => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                Some((
                    "image/webp",
                    (bits & 0x3fff) + 1,
                    ((bits >> 14) & 0x3fff) + 1,
                ))
            }
            b"VP8 " if bytes.get(23..26) == Some(b"\x9d\x01\x2a") => Some((
                "image/webp",
                u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?) as u32 & 0x3fff,
                u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?) as u32 & 0x3fff,
            )),
            _ => None,
        };
    }
    None
}

pub(crate) fn mutate(sftp: &Sftp, path: &str, action: RemoteFileAction) -> Result<(), CoreError> {
    validate_path(path)?;
    match action {
        RemoteFileAction::CreateDirectory { name } => {
            validate_name(&name)?;
            if !sftp.lstat(Path::new(path)).map_err(remote_error)?.is_dir() {
                return Err(failed("新建文件夹需要普通目录，不能使用符号链接"));
            }
            let target = remote_path::resolve(path, &name)?;
            sftp.mkdir(Path::new(&target), 0o700).map_err(remote_error)
        }
        action => {
            if path == "/" {
                return Err(failed("不能修改远程根目录"));
            }
            let stat = sftp.lstat(Path::new(path)).map_err(remote_error)?;
            if !stat.is_file() && !stat.is_dir() {
                return Err(failed("不能修改符号链接或特殊文件"));
            }
            match action {
                RemoteFileAction::Rename { name } => {
                    validate_name(&name)?;
                    let parent =
                        remote_path::parent(path).ok_or_else(|| failed("远程父目录无效"))?;
                    let target = remote_path::resolve(&parent, &name)?;
                    if target == path {
                        return Ok(());
                    }
                    // SFTP v3 rename without flags must fail when the destination exists.
                    sftp.rename(
                        Path::new(path),
                        Path::new(&target),
                        Some(RenameFlags::empty()),
                    )
                    .map_err(remote_error)
                }
                RemoteFileAction::Delete {} => if stat.is_dir() {
                    sftp.rmdir(Path::new(path))
                } else {
                    sftp.unlink(Path::new(path))
                }
                .map_err(remote_error),
                RemoteFileAction::CreateDirectory { .. } => unreachable!(),
            }
        }
    }
}

fn validate_path(path: &str) -> Result<(), CoreError> {
    remote_path::resolve("/", path)?;
    if !path.starts_with('/')
        || path.len() > 32_768
        || (path != "/"
            && path[1..]
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | "..")))
    {
        return Err(failed("请使用已打开目录中的有效绝对路径"));
    }
    #[cfg(windows)]
    if path.contains('\\') {
        return Err(failed("此平台暂不支持包含反斜杠的远程路径"));
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.len() > 255
        || name.chars().any(char::is_control)
    {
        return Err(failed(
            "名称不能为空、不能是 . 或 ..，也不能包含斜杠或控制字符",
        ));
    }
    #[cfg(windows)]
    if name.contains('\\') {
        return Err(failed("此平台暂不支持包含反斜杠的远程名称"));
    }
    Ok(())
}

fn same_file(before: &FileStat, after: &FileStat) -> bool {
    after.is_file()
        && before.size == after.size
        && before.mtime == after.mtime
        && before.perm == after.perm
        && before.uid == after.uid
        && before.gid == after.gid
}
fn remote_error(error: ssh2::Error) -> CoreError {
    match error.code() {
        ErrorCode::SFTP(2 | 10) => failed("远程文件或目录不存在，请刷新目录"),
        ErrorCode::SFTP(3) => failed("没有操作此文件或目录的权限"),
        ErrorCode::SFTP(_) | ErrorCode::Session(-31) => {
            failed("操作未完成；请检查同名项、权限或目录是否为空，然后刷新确认")
        }
        _ => CoreError::new(
            "connection_lost",
            "服务器连接已中断或超时，请重新连接后刷新确认",
        ),
    }
}
fn changed() -> CoreError {
    failed("文件在读取期间发生变化，请刷新后重试")
}
fn too_large() -> CoreError {
    failed("预览仅支持 1 MB 以内的文本和 8 MB 以内的图片，请下载后查看")
}
fn unsupported() -> CoreError {
    failed("此文件不是可预览的 UTF-8 文本或 PNG/JPEG/GIF/WebP 图片，请下载后查看")
}
fn failed(message: impl Into<String>) -> CoreError {
    CoreError::new("remote_file", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_text_is_bounded_and_active_formats_remain_plain_text() {
        for text in [
            "",
            "中文\ntext\tvalue\r\n",
            "<script>alert(1)</script>",
            "<svg onload=\"alert(1)\"/>",
        ] {
            match classify("/text", text.as_bytes().to_vec()).unwrap() {
                RemotePreview::Text { text: result, .. } => assert_eq!(result, text),
                _ => panic!("active content must not become an image"),
            }
        }
        assert!(classify("/text", vec![b'x'; TEXT_LIMIT as usize]).is_ok());
        assert!(classify("/text", vec![b'x'; TEXT_LIMIT as usize + 1]).is_err());
        for bytes in [vec![0], vec![0x1b, b'['], vec![0xff, 0xfe]] {
            assert!(classify("/binary", bytes).is_err());
        }
    }

    #[test]
    fn supported_raster_headers_have_bounded_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(320_u32.to_be_bytes());
        png.extend(200_u32.to_be_bytes());
        let gif = b"GIF89a\x40\x01\xc8\0".to_vec();
        let jpeg = b"\xff\xd8\xff\xc0\0\x07\x08\0\xc8\x01\x40".to_vec();
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend([0x3f, 1, 0, 0xc7, 0, 0]);
        for (bytes, mime) in [
            (&png, "image/png"),
            (&gif, "image/gif"),
            (&jpeg, "image/jpeg"),
            (&webp, "image/webp"),
        ] {
            assert_eq!(raster_dimensions(bytes), Some((mime, 320, 200)));
            assert!(matches!(
                classify("/image", bytes.clone()).unwrap(),
                RemotePreview::Image { .. }
            ));
            for length in 0..bytes.len() {
                assert!(
                    raster_dimensions(&bytes[..length]).is_none(),
                    "truncated {mime}: {length}"
                );
            }
        }
        png[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
        png[20..24].copy_from_slice(&100_000_u32.to_be_bytes());
        assert!(classify("/large-pixels.png", png).is_err());
        assert!(classify("/zero.gif", b"GIF89a\0\0\0\0".to_vec()).is_err());
    }

    #[test]
    fn malformed_jpeg_and_webp_headers_never_escape_the_input_buffer() {
        for length in 0..512 {
            for byte in [0_u8, 1, 0xff] {
                let mut bytes = vec![byte; length];
                bytes.splice(0..0, [0xff, 0xd8]);
                let _ = raster_dimensions(&bytes);
                if length >= 8 {
                    bytes[..8].copy_from_slice(b"RIFF\0\0\0\0");
                    let _ = raster_dimensions(&bytes);
                }
            }
        }
    }

    #[test]
    fn mutation_requests_reject_unknown_fields_and_malformed_names() {
        assert!(matches!(
            serde_json::from_str::<RemoteFileAction>(r#"{"kind":"delete"}"#).unwrap(),
            RemoteFileAction::Delete {}
        ));
        for json in [
            r#"{"kind":"delete","recursive":true}"#,
            r#"{"kind":"rename"}"#,
            r#"{"kind":"createDirectory","name":"ok","mode":511}"#,
            r#"{"kind":"unknown"}"#,
        ] {
            assert!(
                serde_json::from_str::<RemoteFileAction>(json).is_err(),
                "accepted unexpected fields: {json}"
            );
        }
        for name in ["", ".", "..", "bad/name", "bad\0name", "bad\nname"] {
            assert!(validate_name(name).is_err());
        }
        assert!(validate_name("普通文件.log").is_ok());
        for path in [
            "relative",
            "/folder/..",
            "/folder/.",
            "/a//b",
            "/a/",
            "/bad\0path",
        ] {
            assert!(validate_path(path).is_err());
        }
        assert!(validate_path("/").is_ok());
    }
}
