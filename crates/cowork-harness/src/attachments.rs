use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use cowork_config::{ModelRegistry, ProviderName};
use cowork_inference::{ContentBlock, MediaKind, MediaSource, ProviderOpaqueMeta};
use cowork_protocol::{ExtractedTurnInput, TurnAttachmentInputPart};
use data_encoding::{BASE64, BASE64_NOPAD};

/// TS `MAX_TURN_ATTACHMENT_COUNT` (`src/shared/attachments.ts`).
pub const MAX_TURN_ATTACHMENT_COUNT: usize = 8;
/// TS `MAX_ATTACHMENT_INLINE_BYTE_SIZE`.
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
/// TS `MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE`.
const MAX_TURN_ATTACHMENT_TOTAL_BYTES: usize = 25 * 1024 * 1024;
/// TS `MAX_ATTACHMENT_BASE64_SIZE`.
const MAX_ATTACHMENT_BASE64_SIZE: usize = base64_size_from_byte_length(MAX_ATTACHMENT_BYTES);
/// TS `MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE`.
const MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE: usize =
    base64_size_from_byte_length(MAX_TURN_ATTACHMENT_TOTAL_BYTES);

const INLINE_FILE_TOO_LARGE: &str = "File too large to send inline (max 25MB)";
const INLINE_TOTAL_TOO_LARGE: &str = "Inline attachments too large in total (max 25MB combined)";
const UPLOADED_MULTIMODAL_TOTAL_TOO_LARGE: &str =
    "Uploaded multimodal attachments too large to send to the model (max 25MB combined)";

/// TS `LARGE_MULTIMODAL_OUTPUT_GUIDANCE` (`attachmentGuidancePolicy.ts`).
pub const LARGE_MULTIMODAL_OUTPUT_GUIDANCE: &str = "[System: For large audio, video, or PDF transcription/extraction tasks, do not stream the full transcript, extracted text, or detailed summary in chat. The uploaded media is already attached to this message, so do not call read on the uploaded media path just to inspect, transcribe, or summarize it. Create the requested file in the workspace with the write tool. Use mode=\"overwrite\" for the first chunk and mode=\"append\" for later chunks, keeping each chunk bounded. Return only the file path and a concise summary in chat.]";

/// What the session model can receive as attachment content (`googleMultimodalPartTypeForMime`
/// options): images only when the model accepts image input, audio/video/PDF only for Google.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentModelCapabilities {
    pub provider: ProviderName,
    pub supports_image_input: bool,
}

impl AttachmentModelCapabilities {
    /// TS `modelSupportsImageInputSync(config)`: the session model resolved through the bundled
    /// registry, the provider discovery cache and the custom-model store.
    pub fn resolve(
        registry: &ModelRegistry,
        provider: ProviderName,
        model_id: &str,
        homedir: &Path,
        env: &HashMap<String, String>,
    ) -> Self {
        Self {
            provider,
            supports_image_input: registry
                .resolve_model_for_config(provider, Some(model_id), homedir, env)
                .supports_image_input,
        }
    }

    fn is_google(self) -> bool {
        self.provider == ProviderName::Google
    }
}

const fn base64_size_from_byte_length(byte_length: usize) -> usize {
    byte_length.div_ceil(3) * 4
}

/// Node `Buffer.byteLength(value, "base64")`.
fn base64_decoded_byte_length(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut len = bytes.len();
    if len > 0 && bytes[len - 1] == b'=' {
        len -= 1;
    }
    if len > 1 && bytes[len - 1] == b'=' {
        len -= 1;
    }
    len * 3 / 4
}

/// TS `getAttachmentCountValidationMessage`.
fn attachment_count_validation_message(count: usize) -> Option<String> {
    (count > MAX_TURN_ATTACHMENT_COUNT)
        .then(|| format!("Too many file attachments (max {MAX_TURN_ATTACHMENT_COUNT})"))
}

/// The running per-file / combined check shared by TS `getAttachmentValidationMessage` and
/// `getAttachmentByteLengthValidationMessage`: per file first, then the running total.
fn size_validation_message(
    sizes: impl IntoIterator<Item = usize>,
    max_each: usize,
    max_total: usize,
    each_message: impl Fn(usize) -> String,
    total_message: &str,
) -> Option<String> {
    let mut total = 0usize;
    for (index, size) in sizes.into_iter().enumerate() {
        if size > max_each {
            return Some(each_message(index));
        }
        total = total.saturating_add(size);
        if total > max_total {
            return Some(total_message.to_owned());
        }
    }
    None
}

/// TS `getTurnAttachmentValidationMessage` (count, then inline base64 sizes per file and
/// combined). Runs before anything is staged.
pub fn turn_attachment_validation_message(
    attachments: &[TurnAttachmentInputPart],
) -> Option<String> {
    if let Some(message) = attachment_count_validation_message(attachments.len()) {
        return Some(message);
    }
    let inline_base64_sizes = attachments.iter().filter_map(|a| match a {
        TurnAttachmentInputPart::InlineFile { content_base64, .. } => Some(content_base64.len()),
        TurnAttachmentInputPart::UploadedFile { .. } => None,
    });
    size_validation_message(
        inline_base64_sizes,
        MAX_ATTACHMENT_BASE64_SIZE,
        MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
        |_| INLINE_FILE_TOO_LARGE.to_owned(),
        INLINE_TOTAL_TOO_LARGE,
    )
}

fn large_multimodal_output_request_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(transcribe|transcribed|transcribing|transcript|transcription|markdown|file|document|extract|extraction|extracting|ocr|caption|captions|subtitle|subtitles|srt|notes|minutes)\b",
        )
        .expect("static regex")
    })
}

fn is_large_output_media_kind(kind: MediaKind) -> bool {
    matches!(
        kind,
        MediaKind::Audio | MediaKind::Video | MediaKind::Document
    )
}

fn effective_mime(mime_type: &str) -> &str {
    if mime_type.trim().is_empty() {
        "application/octet-stream"
    } else {
        mime_type
    }
}

fn attachment_name_hint(att: &TurnAttachmentInputPart) -> String {
    match att {
        TurnAttachmentInputPart::InlineFile { filename, .. } => sanitize_upload_filename(filename),
        TurnAttachmentInputPart::UploadedFile { filename, path, .. } => {
            if filename.trim().is_empty() {
                path.clone()
            } else {
                filename.clone()
            }
        }
    }
}

/// TS `shouldInjectLargeMultimodalOutputGuidance`: Google only, when the user text asks for a
/// transcript/extraction-style output and at least one attachment is sent as audio, video or PDF.
fn should_inject_large_multimodal_output_guidance(
    text: &str,
    attachments: &[TurnAttachmentInputPart],
    caps: AttachmentModelCapabilities,
) -> bool {
    if !caps.is_google() || attachments.is_empty() {
        return false;
    }
    if !large_multimodal_output_request_pattern().is_match(text) {
        return false;
    }
    attachments.iter().any(|att| {
        let mime = match att {
            TurnAttachmentInputPart::InlineFile { mime_type, .. }
            | TurnAttachmentInputPart::UploadedFile { mime_type, .. } => effective_mime(mime_type),
        };
        classify_media_kind(mime, &attachment_name_hint(att), caps)
            .is_some_and(|(kind, _)| is_large_output_media_kind(kind))
    })
}

/// The targeted note TS emits for an attachment covered by the large-output guidance.
fn already_attached_media_note(disk_path: &Path, kind: MediaKind) -> String {
    format!(
        "[System: The user uploaded a file which has been saved to {}. The file is already attached as {} content below; do not call read on this uploaded media path just to inspect, transcribe, or summarize it. Use the attached media content and write the requested output file directly.]",
        disk_path.display(),
        kind.as_wire_str()
    )
}

/// TS `isOversizedUploadedAudioAttachment` (plus audio classified from the filename).
fn is_oversized_uploaded_audio(mime: &str, media: Option<&(MediaKind, String)>, len: u64) -> bool {
    let is_audio = mime.trim().to_ascii_lowercase().starts_with("audio/")
        || matches!(media, Some((MediaKind::Audio, _)));
    is_audio && len > MAX_ATTACHMENT_BYTES as u64
}

/// An `uploadedFile` opened (and confined) during pre-turn validation; its bytes are read later
/// from this same handle.
struct OpenedUpload {
    resolved: PathBuf,
    file: fs::File,
    len: u64,
}

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

/// Classifies an attachment into a model media block, or `None` when it is only referenced by
/// its saved path (`googleMultimodalPartTypeForMime` parity): images only when the model accepts
/// image input; audio, video and PDF only for Google, whose transport carries those kinds.
fn classify_media_kind(
    mime_type: &str,
    filename: &str,
    caps: AttachmentModelCapabilities,
) -> Option<(MediaKind, String)> {
    let lower_mime = mime_type.trim().to_ascii_lowercase();
    let google = caps.is_google();
    if lower_mime.starts_with("image/") && !caps.supports_image_input {
        return None;
    }
    if matches!(
        lower_mime.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Some((MediaKind::Image, lower_mime));
    }
    if !google
        && (lower_mime == "application/pdf"
            || lower_mime.starts_with("audio/")
            || lower_mime.starts_with("video/"))
    {
        return None;
    }
    if lower_mime == "application/pdf" {
        return Some((MediaKind::Document, lower_mime));
    }
    if google && lower_mime.starts_with("audio/") {
        return Some((MediaKind::Audio, lower_mime));
    }
    if google && lower_mime.starts_with("video/") {
        return Some((MediaKind::Video, lower_mime));
    }

    let ext = Path::new(filename)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let (kind, mime) = match ext.as_str() {
        "png" => (MediaKind::Image, "image/png"),
        "jpg" | "jpeg" => (MediaKind::Image, "image/jpeg"),
        "gif" => (MediaKind::Image, "image/gif"),
        "webp" => (MediaKind::Image, "image/webp"),
        "pdf" => (MediaKind::Document, "application/pdf"),
        // `mimeTypeFromPath` audio/video extensions.
        "mp3" => (MediaKind::Audio, "audio/mpeg"),
        "wav" => (MediaKind::Audio, "audio/wav"),
        "ogg" => (MediaKind::Audio, "audio/ogg"),
        "m4a" => (MediaKind::Audio, "audio/mp4"),
        "aac" => (MediaKind::Audio, "audio/aac"),
        "flac" => (MediaKind::Audio, "audio/flac"),
        "mp4" => (MediaKind::Video, "video/mp4"),
        "webm" => (MediaKind::Video, "video/webm"),
        "mov" => (MediaKind::Video, "video/quicktime"),
        "avi" => (MediaKind::Video, "video/x-msvideo"),
        "mkv" => (MediaKind::Video, "video/x-matroska"),
        _ => return None,
    };
    let allowed = match kind {
        MediaKind::Image => caps.supports_image_input,
        MediaKind::Audio | MediaKind::Video | MediaKind::Document => google,
    };
    allowed.then(|| (kind, mime.to_owned()))
}

/// `buildOversizedUploadedAudioHint` parity: an uploaded audio file above the model attachment
/// limit is referenced by path only, with guidance not to `read` it.
fn oversized_uploaded_audio_hint(disk_path: &Path) -> String {
    format!(
        "[System: The user uploaded an audio file which has been copied to {}. \
         It is larger than the 25MB model attachment limit, so it is not attached as audio content. \
         Do not call read on this uploaded audio path because read will not return audio bytes. \
         Use a dedicated transcription workflow or local audio tooling if transcription is needed, \
         and write any large requested output file in the workspace.]",
        disk_path.display()
    )
}

fn uploaded_outside_error(path: &Path) -> String {
    format!(
        "Uploaded file '{}' is outside the uploads directory.",
        path.display()
    )
}

/// Lexically folds `.` and `..` components (`path.resolve` semantics) without touching the
/// filesystem; a `..` above the root is dropped.
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::RootDir | Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Component-wise containment of two already-resolved paths (case-insensitive on Windows).
/// Never re-resolves either path, so a check on an opened handle's real path cannot be
/// redirected by a concurrent rename.
fn real_path_within(root: &Path, child: &Path) -> bool {
    #[cfg(windows)]
    {
        let lower = |p: &Path| PathBuf::from(cowork_config::windows_path_compare_key(p));
        lower(child).starts_with(lower(root))
    }
    #[cfg(not(windows))]
    {
        child.starts_with(root)
    }
}

/// Directories an `uploadedFile` may reference (`resolveUploadedAttachmentPath`
/// parity): the effective uploads directory and `<workspace>/uploads`, where
/// `cowork/session/file/upload` writes regardless of a configured uploads directory.
///
/// Like `resolvePathInsideRootForBoundaryCheck`, each must lie lexically and canonically inside
/// the workspace. A root reached through a symlink below the workspace is dropped (the write
/// paths refuse such roots too), and an uploads directory that resolves to the workspace root
/// itself (`resolveDir`'s fallback for an out-of-workspace setting) narrows to its
/// `User Uploads/` staging directory so it never exposes the whole workspace. Missing roots are
/// skipped: nothing can have been uploaded there.
fn uploaded_file_roots(
    uploads_directory: &Path,
    working_directory: &Path,
) -> Result<Vec<UploadRoot>, String> {
    let canonical_ws = fs::canonicalize(working_directory).map_err(|e| {
        format!(
            "Invalid workspace directory '{}': {e}",
            working_directory.display()
        )
    })?;
    let confine = |dir: &Path| -> Option<UploadRoot> {
        let lexical = normalize_lexically(dir);
        let rel = lexical
            .strip_prefix(normalize_lexically(working_directory))
            .or_else(|_| lexical.strip_prefix(&canonical_ws))
            .ok()?;
        if !rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        let canonical = fs::canonicalize(&lexical).ok()?;
        let expected = canonical_ws.join(rel);
        let unredirected =
            real_path_within(&expected, &canonical) && real_path_within(&canonical, &expected);
        (unredirected && canonical.is_dir()).then_some(UploadRoot { lexical, canonical })
    };
    let mut roots = Vec::<UploadRoot>::new();
    for dir in [
        uploads_directory.to_path_buf(),
        canonical_ws.join("uploads"),
    ] {
        let Some(mut root) = confine(&dir) else {
            continue;
        };
        if real_path_within(&root.canonical, &canonical_ws) {
            let Some(staging) = confine(&dir.join("User Uploads")) else {
                continue;
            };
            root = staging;
        }
        if !roots
            .iter()
            .any(|r| real_path_within(&r.canonical, &root.canonical))
        {
            roots.push(root);
        }
    }
    Ok(roots)
}

/// An upload directory as requested (lexically normalized) and as resolved on disk.
struct UploadRoot {
    lexical: PathBuf,
    canonical: PathBuf,
}

#[cfg(unix)]
fn open_upload_no_follow(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NONBLOCK: a FIFO swapped in after the lstat must not block the open; the handle's
    // fstat then rejects it. Cleared again before reading.
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(windows)]
fn open_upload_no_follow(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Open a reparse point itself instead of its target; it is then not a regular file.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_upload_no_follow(path: &Path) -> std::io::Result<fs::File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::Error::other("symbolic link"));
    }
    fs::File::open(path)
}

#[cfg(unix)]
fn restore_upload_blocking_mode(file: &fs::File) {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    // SAFETY: `fd` is a valid open descriptor owned by `file` for the duration of these calls.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 && flags & libc::O_NONBLOCK != 0 {
            libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
    }
}

#[cfg(not(unix))]
fn restore_upload_blocking_mode(_file: &fs::File) {}

#[cfg(unix)]
fn same_upload_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_upload_identity(_a: &fs::Metadata, _b: &fs::Metadata) -> bool {
    // The reparse-point-preserving open plus the handle's final-path check confine the read.
    true
}

/// Opens an `uploadedFile` reference confined to `roots` (see [`uploaded_file_roots`]).
///
/// The request path (relative paths resolve against the uploads directory) must lie lexically
/// inside a root; the final component is opened without following symlinks (non-blocking, so
/// a FIFO cannot stall the turn), the handle must be a regular file with the inode the lstat
/// saw, and the handle's real path (`/proc/self/fd`, `F_GETPATH`, `GetFinalPathNameByHandleW`)
/// must lie inside a root, which defeats a symlinked intermediate directory and a component
/// swapped after the check. Fails closed when the real path cannot be determined. Returns the
/// lexical path, the open handle and its size; no bytes are read here.
fn open_uploaded_file(
    roots: &[UploadRoot],
    uploads_directory: &Path,
    raw_path: &str,
) -> Result<(PathBuf, fs::File, u64), String> {
    let requested = if Path::new(raw_path).is_absolute() {
        PathBuf::from(raw_path)
    } else {
        uploads_directory.join(raw_path)
    };
    let resolved = normalize_lexically(&requested);
    let lexically_inside = roots.iter().any(|r| {
        real_path_within(&r.lexical, &resolved) || real_path_within(&r.canonical, &resolved)
    });
    if !lexically_inside {
        return Err(uploaded_outside_error(&resolved));
    }

    let lstat = fs::symlink_metadata(&resolved)
        .map_err(|e| format!("Uploaded file '{}' not found: {e}", resolved.display()))?;
    if lstat.file_type().is_symlink() {
        return Err(format!(
            "Uploaded file '{}' is a symbolic link; refusing to follow it.",
            resolved.display()
        ));
    }
    if !lstat.is_file() {
        return Err(format!(
            "Uploaded path '{}' is not a regular file.",
            resolved.display()
        ));
    }
    let file = open_upload_no_follow(&resolved)
        .map_err(|e| format!("Failed to open uploaded file '{}': {e}", resolved.display()))?;
    let fstat = file
        .metadata()
        .map_err(|e| format!("Failed to stat uploaded file '{}': {e}", resolved.display()))?;
    if !fstat.is_file() {
        return Err(format!(
            "Uploaded path '{}' is not a regular file.",
            resolved.display()
        ));
    }
    if !same_upload_identity(&lstat, &fstat) {
        return Err(format!(
            "Uploaded file '{}' changed while opening.",
            resolved.display()
        ));
    }
    let real = cowork_tools::fs_tools::opened_file_real_path(&file, &resolved).map_err(|e| {
        format!(
            "Refusing uploaded file '{}': could not verify the opened file's real path ({e}).",
            resolved.display()
        )
    })?;
    if !roots.iter().any(|r| real_path_within(&r.canonical, &real)) {
        return Err(uploaded_outside_error(&resolved));
    }
    restore_upload_blocking_mode(&file);
    Ok((resolved, file, fstat.len()))
}

/// Stages inline attachments and resolves `uploadedFile` references into the user message,
/// assuming an image-capable model. `provider` selects which other media kinds are attached
/// as content (audio/video/PDF: Google only). Turn handlers that know the session model use
/// [`materialize_turn_attachments_for_model`].
pub fn materialize_turn_attachments(
    extracted: &ExtractedTurnInput,
    uploads_directory: &Path,
    working_directory: &Path,
    provider: ProviderName,
) -> Result<MaterializedTurnInput, String> {
    materialize_turn_attachments_for_model(
        extracted,
        uploads_directory,
        working_directory,
        AttachmentModelCapabilities {
            provider,
            supports_image_input: true,
        },
    )
}

/// Pre-turn `uploadedFile` validation (`validateUploadedFileAttachments` parity): opens and
/// confines every uploaded file, then checks the combined size of everything that will be sent
/// to the model as media (inline media by decoded size, uploads by file size; oversized uploaded
/// audio is path-only and not counted). Returns one slot per attachment, holding the opened
/// handle for uploads. Nothing is staged yet, so a failure leaves no files behind.
fn validate_uploaded_file_attachments(
    attachments: &[TurnAttachmentInputPart],
    uploads_directory: &Path,
    working_directory: &Path,
    caps: AttachmentModelCapabilities,
) -> Result<Vec<Option<OpenedUpload>>, String> {
    let mut opened: Vec<Option<OpenedUpload>> = Vec::with_capacity(attachments.len());
    if !attachments
        .iter()
        .any(|a| matches!(a, TurnAttachmentInputPart::UploadedFile { .. }))
    {
        opened.resize_with(attachments.len(), || None);
        return Ok(opened);
    }

    let roots = uploaded_file_roots(uploads_directory, working_directory)?;
    // (size, path for the per-file message) of each attachment the model receives as media.
    let mut multimodal: Vec<(u64, Option<PathBuf>)> = Vec::new();
    for att in attachments {
        match att {
            TurnAttachmentInputPart::InlineFile {
                content_base64,
                mime_type,
                ..
            } => {
                if classify_media_kind(effective_mime(mime_type), &attachment_name_hint(att), caps)
                    .is_some()
                {
                    multimodal.push((base64_decoded_byte_length(content_base64) as u64, None));
                }
                opened.push(None);
            }
            TurnAttachmentInputPart::UploadedFile {
                path, mime_type, ..
            } => {
                let (resolved, file, len) = open_uploaded_file(&roots, uploads_directory, path)?;
                let mime = effective_mime(mime_type);
                let media = classify_media_kind(mime, &attachment_name_hint(att), caps);
                if media.is_some() && !is_oversized_uploaded_audio(mime, media.as_ref(), len) {
                    multimodal.push((len, Some(resolved.clone())));
                }
                opened.push(Some(OpenedUpload {
                    resolved,
                    file,
                    len,
                }));
            }
        }
    }

    // `getUploadedMultimodalAttachmentValidationMessage`: per file, then the running total.
    let message = size_validation_message(
        multimodal.iter().map(|(len, _)| *len as usize),
        MAX_ATTACHMENT_BYTES,
        MAX_TURN_ATTACHMENT_TOTAL_BYTES,
        |index| {
            let (len, path) = &multimodal[index];
            match path {
                Some(path) => format!(
                    "Uploaded file '{}' exceeds 25 MiB limit ({len} bytes).",
                    path.display()
                ),
                None => INLINE_FILE_TOO_LARGE.to_owned(),
            }
        },
        UPLOADED_MULTIMODAL_TOTAL_TOO_LARGE,
    );
    match message {
        Some(message) => Err(message),
        None => Ok(opened),
    }
}

/// Stages inline attachments and resolves `uploadedFile` references into the user message for
/// the session model described by `caps` (TS `buildUserMessageContent`, preceded by
/// `getTurnAttachmentValidationMessage` and `validateUploadedFileAttachments`).
///
/// Images are attached only when the model accepts image input and audio/video/PDF only for
/// Google; anything else is referenced by its saved path. At most
/// [`MAX_TURN_ATTACHMENT_COUNT`] attachments are accepted, inline payloads are capped at 25MB
/// each and combined, and media sent to the model is capped at 25MB combined.
pub fn materialize_turn_attachments_for_model(
    extracted: &ExtractedTurnInput,
    uploads_directory: &Path,
    working_directory: &Path,
    caps: AttachmentModelCapabilities,
) -> Result<MaterializedTurnInput, String> {
    if let Some(message) = turn_attachment_validation_message(&extracted.attachments) {
        return Err(message);
    }
    let mut opened_uploads = validate_uploaded_file_attachments(
        &extracted.attachments,
        uploads_directory,
        working_directory,
        caps,
    )?;
    let add_large_output_guidance = should_inject_large_multimodal_output_guidance(
        &extracted.text,
        &extracted.attachments,
        caps,
    );
    let mut large_output_guidance_added = false;

    let mut staged_files = Vec::<PathBuf>::new();
    let mut content_blocks = Vec::<ContentBlock>::new();
    let mut file_notes = Vec::<String>::new();

    let user_uploads_dir = uploads_directory.join("User Uploads");

    let run = (|| -> Result<(), String> {
        // Guidance precedes the first attachment it targets; that attachment's note then says
        // the media is already attached instead of the plain saved-path note.
        let mut targeted_note =
            |kind: MediaKind, disk_path: &Path, file_notes: &mut Vec<String>| -> Option<String> {
                if !add_large_output_guidance || !is_large_output_media_kind(kind) {
                    return None;
                }
                if !large_output_guidance_added {
                    file_notes.push(LARGE_MULTIMODAL_OUTPUT_GUIDANCE.to_owned());
                    large_output_guidance_added = true;
                }
                Some(already_attached_media_note(disk_path, kind))
            };

        for (index, att) in extracted.attachments.iter().enumerate() {
            match att {
                TurnAttachmentInputPart::InlineFile {
                    filename: _,
                    content_base64,
                    mime_type,
                } => {
                    let bytes = decode_strict_base64(content_base64)?;
                    if bytes.len() > MAX_ATTACHMENT_BYTES {
                        return Err(INLINE_FILE_TOO_LARGE.to_owned());
                    }
                    let safe_name = attachment_name_hint(att);
                    let dest = stage_user_upload(
                        uploads_directory,
                        working_directory,
                        &user_uploads_dir,
                        &safe_name,
                        &bytes,
                    )?;
                    staged_files.push(dest.clone());

                    let mime_str = effective_mime(mime_type);
                    if let Some((kind, canonical_mime)) =
                        classify_media_kind(mime_str, &safe_name, caps)
                    {
                        let note =
                            targeted_note(kind, &dest, &mut file_notes).unwrap_or_else(|| {
                                format!(
                                    "[Attached {}: {} ({}, {} bytes)]",
                                    kind.as_wire_str(),
                                    dest.display(),
                                    canonical_mime,
                                    bytes.len()
                                )
                            });
                        file_notes.push(note);
                        content_blocks.push(ContentBlock::Media {
                            kind,
                            source: MediaSource::Base64 {
                                mime_type: canonical_mime,
                                data: BASE64.encode(&bytes),
                            },
                            provider_meta: ProviderOpaqueMeta::default(),
                        });
                    } else {
                        file_notes.push(format!(
                            "[Attached file saved to: {} ({}, {} bytes)]",
                            dest.display(),
                            mime_str,
                            bytes.len()
                        ));
                    }
                }
                TurnAttachmentInputPart::UploadedFile { mime_type, .. } => {
                    let Some(OpenedUpload {
                        resolved,
                        mut file,
                        len,
                    }) = opened_uploads.get_mut(index).and_then(Option::take)
                    else {
                        return Err("Uploaded attachment was not validated.".to_owned());
                    };
                    let mime_str = effective_mime(mime_type);
                    let media = classify_media_kind(mime_str, &attachment_name_hint(att), caps);
                    if is_oversized_uploaded_audio(mime_str, media.as_ref(), len) {
                        file_notes.push(oversized_uploaded_audio_hint(&resolved));
                        continue;
                    }
                    if len > MAX_ATTACHMENT_BYTES as u64 && media.is_some() {
                        return Err(format!(
                            "Uploaded file '{}' exceeds 25 MiB limit ({len} bytes).",
                            resolved.display()
                        ));
                    }
                    let mut note = None;
                    if let Some((kind, canonical_mime)) = media {
                        // Read from the confined handle, never by path again.
                        let mut bytes = Vec::with_capacity(len as usize);
                        std::io::Read::read_to_end(
                            &mut std::io::Read::take(&mut file, MAX_ATTACHMENT_BYTES as u64 + 1),
                            &mut bytes,
                        )
                        .map_err(|e| {
                            format!("Failed to read uploaded file '{}': {e}", resolved.display())
                        })?;
                        if bytes.len() > MAX_ATTACHMENT_BYTES {
                            return Err(format!(
                                "Uploaded file '{}' exceeds 25 MiB limit.",
                                resolved.display()
                            ));
                        }
                        note = targeted_note(kind, &resolved, &mut file_notes);
                        content_blocks.push(ContentBlock::Media {
                            kind,
                            source: MediaSource::Base64 {
                                mime_type: canonical_mime,
                                data: BASE64.encode(&bytes),
                            },
                            provider_meta: ProviderOpaqueMeta::default(),
                        });
                    }
                    file_notes.push(note.unwrap_or_else(|| {
                        format!(
                            "[Attached uploaded file: {} ({mime_str}, {len} bytes)]",
                            resolved.display()
                        )
                    }));
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
