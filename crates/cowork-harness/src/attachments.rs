use std::fs;
use std::path::{Path, PathBuf};

use cowork_inference::{ContentBlock, MediaKind, MediaSource, ProviderOpaqueMeta};
use cowork_protocol::{ExtractedTurnInput, TurnAttachmentInputPart};
use cowork_tools::canonicalize_with_missing_tail;
use data_encoding::{BASE64, BASE64_NOPAD};

const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug)]
pub struct MaterializedTurnInput {
    pub display_text: String,
    pub content_blocks: Vec<ContentBlock>,
    pub staged_files: Vec<PathBuf>,
}

impl MaterializedTurnInput {
    /// Removes newly staged files in `User Uploads/` if pre-turn validation aborts.
    pub fn rollback(&self) {
        for f in &self.staged_files {
            let _ = fs::remove_file(f);
        }
    }
}

fn sanitize_upload_filename(raw: &str) -> String {
    // Treat both separator styles as separators on every platform, keep the last component.
    let base = raw.trim().rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "attachment.bin".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Write an inline attachment into `<uploads>/User Uploads/` under a collision-free name.
///
/// When the uploads directory lives inside the workspace (the server default
/// `<workspace>/uploads`), every directory below the workspace is opened without following
/// symlinks, so a workspace-controlled `uploads` or `User Uploads` symlink cannot redirect the
/// write. An uploads directory configured outside the workspace is trusted as the root itself.
fn stage_user_upload(
    uploads_directory: &Path,
    working_directory: &Path,
    user_uploads_dir: &Path,
    safe_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    use std::io::Write;

    let inside_ws = uploads_directory
        .strip_prefix(working_directory)
        .ok()
        .filter(|rel| {
            rel.components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        });
    let (root, mut subdirs): (&Path, Vec<String>) = match inside_ws {
        Some(rel) => (
            working_directory,
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect(),
        ),
        None => {
            fs::create_dir_all(uploads_directory)
                .map_err(|e| format!("Failed to create uploads directory: {e}"))?;
            (uploads_directory, Vec::new())
        }
    };
    subdirs.push("User Uploads".to_owned());
    let subdir_refs: Vec<&str> = subdirs.iter().map(String::as_str).collect();

    let p = Path::new(safe_name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_owned());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let candidates = std::iter::once(safe_name.to_owned())
        .chain((1..10_000).map(|idx| format!("{stem}-{idx}{ext}")))
        .chain(std::iter::once(format!("{stem}-{}", uuid::Uuid::new_v4())));

    for name in candidates {
        let mut file = match create_new_file_no_follow(root, &subdir_refs, &name) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to save attachment '{safe_name}': {e}")),
        };
        let dest = user_uploads_dir.join(&name);
        if let Err(e) = file.write_all(bytes) {
            drop(file);
            let _ = fs::remove_file(&dest);
            return Err(format!(
                "Failed to save attachment '{}': {e}",
                dest.display()
            ));
        }
        return Ok(dest);
    }
    Err(format!(
        "Failed to save attachment '{safe_name}': no free filename"
    ))
}

fn is_single_safe_component(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

fn not_real_dir_error(name: &str) -> std::io::Error {
    std::io::Error::other(format!("'{name}' must be a real directory, not a symlink"))
}

/// Exclusively create `root/<subdirs...>/<file_name>` without following symlinks below `root`.
///
/// `root` itself is trusted (callers pass a canonical workspace or configured directory). Each
/// entry of `subdirs` must be a real directory (created with mode 0700 when missing); a symlink,
/// reparse point or non-directory is refused instead of followed. The file is created with
/// `O_CREAT|O_EXCL|O_NOFOLLOW` (mode 0600) relative to the already-opened parent directory on
/// Unix, so swapping path components concurrently cannot redirect the write. An existing file
/// yields `ErrorKind::AlreadyExists`. Shared by inline turn attachments and
/// `cowork/session/file/upload`.
pub fn create_new_file_no_follow(
    root: &Path,
    subdirs: &[&str],
    file_name: &str,
) -> std::io::Result<fs::File> {
    if !subdirs.iter().all(|s| is_single_safe_component(s)) || !is_single_safe_component(file_name)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unsafe path component",
        ));
    }
    create_new_file_no_follow_impl(root, subdirs, file_name)
}

#[cfg(unix)]
fn create_new_file_no_follow_impl(
    root: &Path,
    subdirs: &[&str],
    file_name: &str,
) -> std::io::Result<fs::File> {
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    fn cstr(s: &[u8]) -> std::io::Result<CString> {
        CString::new(s).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    }
    fn open_dir(dirfd: libc::c_int, name: &CStr, nofollow: bool) -> std::io::Result<OwnedFd> {
        let mut flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
        if nofollow {
            flags |= libc::O_NOFOLLOW;
        }
        // SAFETY: `name` is a valid NUL-terminated C string; the fd is owned below.
        let fd = unsafe { libc::openat(dirfd, name.as_ptr(), flags) };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: `fd` was just returned by a successful `openat` and is owned nowhere else.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }

    let mut dir = open_dir(libc::AT_FDCWD, &cstr(root.as_os_str().as_bytes())?, false)?;
    for sub in subdirs {
        let name = cstr(sub.as_bytes())?;
        dir = match open_dir(dir.as_raw_fd(), &name, true) {
            Ok(fd) => fd,
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {
                // SAFETY: valid dirfd and NUL-terminated name.
                let rc = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
                if rc != 0 {
                    let err = std::io::Error::last_os_error();
                    if err.raw_os_error() != Some(libc::EEXIST) {
                        return Err(err);
                    }
                }
                open_dir(dir.as_raw_fd(), &name, true).map_err(|_| not_real_dir_error(sub))?
            }
            Err(e) if matches!(e.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) => {
                return Err(not_real_dir_error(sub));
            }
            Err(e) => return Err(e),
        };
    }

    let name = cstr(file_name.as_bytes())?;
    // SAFETY: valid dirfd and NUL-terminated name; mode is passed as the variadic `mode_t`.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `fd` was just returned by a successful `openat` and is owned nowhere else.
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(not(unix))]
fn create_new_file_no_follow_impl(
    root: &Path,
    subdirs: &[&str],
    file_name: &str,
) -> std::io::Result<fs::File> {
    #[cfg(windows)]
    fn is_reparse_point(meta: &fs::Metadata) -> bool {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    fn is_reparse_point(_meta: &fs::Metadata) -> bool {
        false
    }
    let check = |p: &Path, sub: &str| -> std::io::Result<()> {
        let meta = fs::symlink_metadata(p)?;
        if meta.file_type().is_symlink() || is_reparse_point(&meta) || !meta.is_dir() {
            return Err(not_real_dir_error(sub));
        }
        Ok(())
    };

    let mut dir = root.to_path_buf();
    for sub in subdirs {
        dir.push(sub);
        match fs::symlink_metadata(&dir) {
            Ok(_) => check(&dir, sub)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => check(&dir, sub)?,
                Err(e) => return Err(e),
            },
            Err(e) => return Err(e),
        }
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    opts.open(dir.join(file_name))
}

fn decode_strict_base64(raw: &str) -> Result<Vec<u8>, String> {
    let trimmed = raw.trim();
    let payload = trimmed
        .split_once(";base64,")
        .map(|(_, b)| b)
        .unwrap_or(trimmed);
    let no_ws: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64
        .decode(no_ws.as_bytes())
        .or_else(|_| BASE64_NOPAD.decode(no_ws.as_bytes()))
        .map_err(|e| format!("Invalid base64 file attachment: {e}"))
}

fn classify_media_kind(mime_type: &str, filename: &str) -> Option<(MediaKind, String)> {
    let lower_mime = mime_type.trim().to_ascii_lowercase();
    if matches!(
        lower_mime.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Some((MediaKind::Image, lower_mime));
    }
    if lower_mime == "application/pdf" {
        return Some((MediaKind::Document, lower_mime));
    }

    let ext = Path::new(filename)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => Some((MediaKind::Image, "image/png".to_owned())),
        "jpg" | "jpeg" => Some((MediaKind::Image, "image/jpeg".to_owned())),
        "gif" => Some((MediaKind::Image, "image/gif".to_owned())),
        "webp" => Some((MediaKind::Image, "image/webp".to_owned())),
        "pdf" => Some((MediaKind::Document, "application/pdf".to_owned())),
        _ => None,
    }
}

pub fn materialize_turn_attachments(
    extracted: &ExtractedTurnInput,
    uploads_directory: &Path,
    working_directory: &Path,
) -> Result<MaterializedTurnInput, String> {
    let mut staged_files = Vec::<PathBuf>::new();
    let mut content_blocks = Vec::<ContentBlock>::new();
    let mut file_notes = Vec::<String>::new();

    let user_uploads_dir = uploads_directory.join("User Uploads");

    let run = (|| -> Result<(), String> {
        for att in &extracted.attachments {
            match att {
                TurnAttachmentInputPart::InlineFile {
                    filename,
                    content_base64,
                    mime_type,
                } => {
                    let bytes = decode_strict_base64(content_base64)?;
                    if bytes.len() > MAX_ATTACHMENT_BYTES {
                        return Err(format!(
                            "Attachment '{filename}' exceeds 25 MiB limit ({} bytes).",
                            bytes.len()
                        ));
                    }
                    let safe_name = sanitize_upload_filename(filename);
                    let dest = stage_user_upload(
                        uploads_directory,
                        working_directory,
                        &user_uploads_dir,
                        &safe_name,
                        &bytes,
                    )?;
                    staged_files.push(dest.clone());

                    let mime_str = if mime_type.trim().is_empty() {
                        "application/octet-stream"
                    } else {
                        mime_type.as_str()
                    };
                    if let Some((kind, canonical_mime)) = classify_media_kind(mime_str, &safe_name)
                    {
                        content_blocks.push(ContentBlock::Media {
                            kind,
                            source: MediaSource::Base64 {
                                mime_type: canonical_mime.clone(),
                                data: BASE64.encode(&bytes),
                            },
                            provider_meta: ProviderOpaqueMeta::default(),
                        });
                        file_notes.push(format!(
                            "[Attached {}: {} ({}, {} bytes)]",
                            if kind == MediaKind::Image {
                                "image"
                            } else {
                                "document"
                            },
                            dest.display(),
                            canonical_mime,
                            bytes.len()
                        ));
                    } else {
                        file_notes.push(format!(
                            "[Attached file saved to: {} ({}, {} bytes)]",
                            dest.display(),
                            mime_str,
                            bytes.len()
                        ));
                    }
                }
                TurnAttachmentInputPart::UploadedFile {
                    filename,
                    path,
                    mime_type,
                } => {
                    let candidate = if Path::new(path).is_absolute() {
                        PathBuf::from(path)
                    } else {
                        uploads_directory.join(path)
                    };
                    let resolved = canonicalize_with_missing_tail(&candidate);
                    let canon_uploads = canonicalize_with_missing_tail(uploads_directory);
                    let canon_ws = canonicalize_with_missing_tail(working_directory);
                    if !resolved.starts_with(&canon_uploads) && !resolved.starts_with(&canon_ws) {
                        return Err(format!(
                            "Uploaded file '{}' is outside allowed workspace/uploads directories.",
                            resolved.display()
                        ));
                    }
                    let meta = fs::metadata(&resolved).map_err(|e| {
                        format!("Uploaded file '{}' not found: {e}", resolved.display())
                    })?;
                    if !meta.is_file() {
                        return Err(format!(
                            "Uploaded path '{}' is not a regular file.",
                            resolved.display()
                        ));
                    }
                    let len = meta.len() as usize;
                    if len > MAX_ATTACHMENT_BYTES {
                        return Err(format!(
                            "Uploaded file '{}' exceeds 25 MiB limit ({len} bytes).",
                            resolved.display()
                        ));
                    }
                    let name_hint = if !filename.trim().is_empty() {
                        filename.as_str()
                    } else {
                        resolved
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("uploaded")
                    };
                    let mime_str = if mime_type.trim().is_empty() {
                        "application/octet-stream"
                    } else {
                        mime_type.as_str()
                    };
                    if let Some((kind, canonical_mime)) = classify_media_kind(mime_str, name_hint) {
                        let bytes = fs::read(&resolved).map_err(|e| {
                            format!("Failed to read uploaded file '{}': {e}", resolved.display())
                        })?;
                        content_blocks.push(ContentBlock::Media {
                            kind,
                            source: MediaSource::Base64 {
                                mime_type: canonical_mime.clone(),
                                data: BASE64.encode(&bytes),
                            },
                            provider_meta: ProviderOpaqueMeta::default(),
                        });
                    }
                    file_notes.push(format!(
                        "[Attached uploaded file: {} ({mime_str}, {len} bytes)]",
                        resolved.display()
                    ));
                }
            }
        }
        Ok(())
    })();

    if let Err(err) = run {
        for f in &staged_files {
            let _ = fs::remove_file(f);
        }
        return Err(err);
    }

    let mut full_text = extracted.text.clone();
    if !file_notes.is_empty() {
        if !full_text.is_empty() {
            full_text.push_str("\n\n");
        }
        full_text.push_str(&file_notes.join("\n"));
    }

    if !full_text.is_empty() || content_blocks.is_empty() {
        content_blocks.insert(
            0,
            ContentBlock::Text {
                text: full_text.clone(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            },
        );
    }

    Ok(MaterializedTurnInput {
        display_text: full_text,
        content_blocks,
        staged_files,
    })
}
