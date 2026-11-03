use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use cowork_config::ModelRegistry;
use cowork_inference::{MediaKind, MediaSource, ToolResultPart};
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    assert_read_path_allowed, assert_write_path_allowed, lexical_tool_path,
    normalize_and_validate_args, resolve_tool_path,
};
use crate::mutation::{ExistingRead, StagedContent, with_file_mutation, with_file_mutation_staged};
use crate::text_codec::{
    LineEnding, TextEncoding, decode_text_buffer, detect_bom, detect_dominant_eol,
    encode_text_buffer, normalize_to_lf, replace_respecting_eol,
};

const DEFAULT_READ_LIMIT: usize = 2_000;
const MAX_READ_LIMIT: usize = 20_000;
/// `MAX_READ_LINE_CHARS` in TS `src/tools/read.ts`.
const MAX_CHARS_PER_LINE_WINDOW: usize = 2_000;
/// `MAX_ATTACHMENT_INLINE_BYTE_SIZE` in TS `src/shared/attachments.ts`.
const MAX_MEDIA_BYTES: u64 = 25 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;
/// Leading bytes sniffed for NUL to classify an un-BOM'd file as binary.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// `write.ts`: `content: z.string().max(2_000_000)`.
const MAX_WRITE_CONTENT_CHARS: usize = 2_000_000;
/// `edit.ts`: `MAX_EDIT_STRING_LENGTH`.
const MAX_EDIT_STRING_CHARS: usize = 2_000_000;
/// `edit.ts`: `MAX_EDIT_FILE_BYTES`.
const MAX_EDIT_FILE_BYTES: u64 = 10_000_000;

pub struct ReadTool;

impl ReadTool {
    /// TS `mimeTypeFromPath` (`src/shared/multimodalMime.ts`).
    fn media_mime_for_ext(ext: &str) -> Option<&'static str> {
        match ext {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "webp" => Some("image/webp"),
            "gif" => Some("image/gif"),
            "mp3" => Some("audio/mpeg"),
            "wav" => Some("audio/wav"),
            "ogg" => Some("audio/ogg"),
            "m4a" => Some("audio/mp4"),
            "aac" => Some("audio/aac"),
            "flac" => Some("audio/flac"),
            "mp4" => Some("video/mp4"),
            "webm" => Some("video/webm"),
            "mov" => Some("video/quicktime"),
            "avi" => Some("video/x-msvideo"),
            "mkv" => Some("video/x-matroska"),
            "pdf" => Some("application/pdf"),
            _ => None,
        }
    }

    /// Rust-only guard for common non-media binary formats (TS would decode these as text).
    fn known_binary_mime_for_ext(ext: &str) -> Option<&'static str> {
        match ext {
            "zip" => Some("application/zip"),
            "gz" | "tgz" => Some("application/gzip"),
            "tar" => Some("application/x-tar"),
            "wasm" => Some("application/wasm"),
            "sqlite" | "db" => Some("application/vnd.sqlite3"),
            "exe" | "dll" | "so" | "dylib" => Some("application/octet-stream"),
            "docx" => {
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            }
            "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            "pptx" => {
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
            }
            _ => None,
        }
    }
}

/// TS `binaryMediaGuardMessage` (`src/tools/read.ts`).
fn binary_media_guard_message(file_name: &str, mime: &str) -> String {
    format!(
        "Cannot read {file_name} as text ({mime}). This file is binary media (image, audio, video, or PDF). The read tool does not return audio, video, or PDF bytes because large tool results can exceed provider response limits. If the file was attached to the turn, use the already-attached media content; otherwise use a dedicated transcription or extraction workflow and write large output to a workspace file."
    )
}

/// TS `modelSupportsImageInputSync`: resolves the session model through the bundled
/// registry, the provider discovery cache and the custom-model store.
pub(crate) fn model_supports_image_input(ctx: &ToolExecutionContext) -> bool {
    static REGISTRIES: OnceLock<Mutex<HashMap<PathBuf, Arc<ModelRegistry>>>> = OnceLock::new();
    let built_in_dir = ctx.built_in_dir.clone().or_else(|| {
        ctx.agent_config
            .as_ref()
            .map(|config| config.built_in_dir.clone())
    });
    let registry = match built_in_dir {
        Some(dir) => {
            let cache = REGISTRIES.get_or_init(|| Mutex::new(HashMap::new()));
            let mut guard = cache.lock().unwrap_or_else(|poison| poison.into_inner());
            Arc::clone(
                guard
                    .entry(dir.clone())
                    .or_insert_with(|| Arc::new(ModelRegistry::load_from_builtin_dir(&dir))),
            )
        }
        None => Arc::new(ModelRegistry::default()),
    };
    registry
        .resolve_model_for_config(ctx.provider, Some(&ctx.model), &ctx.homedir, &ctx.env)
        .supports_image_input
}

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// Opens `path` for reading without following a symlink in its final component, requires the
/// opened handle to be a regular file, and re-validates the handle's real path through
/// [`assert_read_path_allowed`].
///
/// `path` should be the canonical path an earlier `assert_read_path_allowed` returned. Between
/// that check and the open, another process can replace the file with a symlink (refused by
/// `O_NOFOLLOW`), a FIFO (opened non-blocking, then refused by the handle's `fstat`), or swap a
/// parent directory for a symlink (caught by re-validating the path the kernel actually
/// opened). Fails closed when the real path cannot be determined. Blocking; call it from a
/// blocking context for slow filesystems.
pub fn open_read_checked(ctx: &ToolExecutionContext, path: &Path) -> ToolResult<File> {
    open_checked_with(path, &|real| assert_read_path_allowed(real, ctx).map(|_| ())).map_err(
        |err| match err {
            CheckedOpenError::Open(err) if err.kind() == std::io::ErrorKind::NotFound => {
                ToolError::Execution(format!("File not found: {}", path.display()))
            }
            CheckedOpenError::Open(err) if is_symlink_open_error(&err) => {
                ToolError::PathDenied(format!(
                    "Refusing to read '{}': the path is a symbolic link (it changed after it was checked).",
                    path.display()
                ))
            }
            CheckedOpenError::Open(err) => {
                ToolError::Execution(format!("Failed to open '{}': {err}", path.display()))
            }
            CheckedOpenError::Stat(err) => {
                ToolError::Execution(format!("Failed to stat '{}': {err}", path.display()))
            }
            CheckedOpenError::NotRegular => ToolError::Execution(format!(
                "Cannot read {}: not a regular file.",
                display_file_name(path)
            )),
            CheckedOpenError::RealPath(err) => ToolError::PathDenied(format!(
                "Refusing to read '{}': could not verify the opened file's real path ({err}).",
                path.display()
            )),
            CheckedOpenError::Denied(err) => err,
        },
    )
}

/// Why [`open_checked_with`] refused a path.
pub(crate) enum CheckedOpenError {
    /// The no-follow open failed (missing file, a symlink final component, permissions).
    Open(std::io::Error),
    /// `fstat` on the opened handle failed.
    Stat(std::io::Error),
    /// The opened handle is not a regular file (directory, FIFO, device, socket, reparse point).
    NotRegular,
    /// The handle's real path could not be determined (fails closed).
    RealPath(std::io::Error),
    /// `verify_real` refused the handle's real path.
    Denied(ToolError),
}

/// The shared checked open behind [`open_read_checked`] and grep's per-file open: opens `path`
/// without following a final-component symlink (`O_NOFOLLOW | O_NONBLOCK` on Unix,
/// `FILE_FLAG_OPEN_REPARSE_POINT` on Windows), requires the handle to be a regular file, passes
/// the handle's real path (`/proc/self/fd`, `F_GETPATH`, `GetFinalPathNameByHandleW`) to
/// `verify_real` (failing closed when it cannot be determined), and restores blocking mode.
pub(crate) fn open_checked_with(
    path: &Path,
    verify_real: &dyn Fn(&Path) -> ToolResult<()>,
) -> Result<File, CheckedOpenError> {
    let file = open_no_follow(path).map_err(CheckedOpenError::Open)?;
    let meta = file.metadata().map_err(CheckedOpenError::Stat)?;
    if !meta.is_file() {
        return Err(CheckedOpenError::NotRegular);
    }
    let real = opened_file_real_path(&file, path).map_err(CheckedOpenError::RealPath)?;
    verify_real(&real).map_err(CheckedOpenError::Denied)?;
    restore_blocking_mode(&file);
    Ok(file)
}

#[cfg(unix)]
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NONBLOCK: a FIFO swapped in after the check must not block the open; the handle's
    // fstat then rejects it. It has no effect on regular-file reads and is cleared afterwards.
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(windows)]
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Open a reparse point (symlink/junction) itself instead of its target; its metadata is
    // then not a regular file and the read is refused.
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::Error::other("symbolic link"));
    }
    File::open(path)
}

pub(crate) fn is_symlink_open_error(err: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        // Linux/macOS report ELOOP for O_NOFOLLOW on a symlink; FreeBSD reports EMLINK.
        matches!(err.raw_os_error(), Some(code) if code == libc::ELOOP || (cfg!(target_os = "freebsd") && code == libc::EMLINK))
    }
    #[cfg(not(unix))]
    {
        let _ = err;
        false
    }
}

#[cfg(unix)]
pub(crate) fn restore_blocking_mode(file: &File) {
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
pub(crate) fn restore_blocking_mode(_file: &File) {}

/// The real path of the file `file` has open (`/proc/self/fd` on Linux, `F_GETPATH` on macOS,
/// `GetFinalPathNameByHandleW` on Windows; elsewhere the canonical `requested` path, only if it
/// still names the opened inode). Callers re-check it against their allowed roots after opening
/// and fail closed on an error.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn opened_file_real_path(file: &File, _requested: &Path) -> std::io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn opened_file_real_path(file: &File, _requested: &Path) -> std::io::Result<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0 as libc::c_char; libc::PATH_MAX as usize + 1];
    // SAFETY: F_GETPATH writes a NUL-terminated path of at most MAXPATHLEN bytes into `buf`.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: on success the buffer holds a NUL-terminated C string.
    let path = unsafe { CStr::from_ptr(buf.as_ptr()) };
    Ok(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
}

#[cfg(windows)]
pub fn opened_file_real_path(file: &File, _requested: &Path) -> std::io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };
    let handle = file.as_raw_handle();
    let mut buf = vec![0u16; 1024];
    loop {
        // SAFETY: `handle` is a valid open file handle and `buf` is writable for its length.
        let len = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buf.as_mut_ptr(),
                buf.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if len == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if len < buf.len() {
            // Same spelling as `canonicalize_sync` (which callers use for their roots): drop a
            // safe `\\?\` prefix so `C:\` roots and opened paths compare equal.
            let raw = OsString::from_wide(&buf[..len]);
            let plain = raw
                .to_str()
                .and_then(cowork_config::strip_windows_verbatim_prefix);
            return Ok(plain
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(raw)));
        }
        buf.resize(len + 1, 0);
    }
}

/// Other Unixes: no fd-to-path API, so require the canonical path to name the opened inode.
#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
pub fn opened_file_real_path(file: &File, requested: &Path) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let canonical = fs::canonicalize(requested)?;
    let (opened, named) = (file.metadata()?, fs::metadata(&canonical)?);
    if opened.dev() != named.dev() || opened.ino() != named.ino() {
        return Err(std::io::Error::other(
            "the path no longer names the opened file",
        ));
    }
    Ok(canonical)
}

#[cfg(not(any(unix, windows)))]
pub fn opened_file_real_path(_file: &File, _requested: &Path) -> std::io::Result<PathBuf> {
    Err(std::io::Error::other("unsupported platform"))
}

/// Incremental lossy decoder, the Rust counterpart of TS `createFileTextDecoder`
/// (`StringDecoder`): invalid sequences become U+FFFD, and multi-byte sequences split
/// across chunk boundaries are carried over.
enum StreamDecoder {
    Utf8 {
        pending: Vec<u8>,
    },
    Utf16 {
        big_endian: bool,
        odd_byte: Option<u8>,
        high_surrogate: Option<u16>,
    },
}

impl StreamDecoder {
    fn for_encoding(encoding: TextEncoding) -> Self {
        match encoding {
            TextEncoding::Utf16LeBom | TextEncoding::Utf16BeBom => Self::Utf16 {
                big_endian: encoding == TextEncoding::Utf16BeBom,
                odd_byte: None,
                high_surrogate: None,
            },
            TextEncoding::Utf8 | TextEncoding::Utf8Bom => Self::Utf8 {
                pending: Vec::new(),
            },
        }
    }

    fn write(&mut self, bytes: &[u8], out: &mut String) {
        match self {
            Self::Utf8 { pending } => {
                let joined;
                let data: &[u8] = if pending.is_empty() {
                    bytes
                } else {
                    let mut buf = std::mem::take(pending);
                    buf.extend_from_slice(bytes);
                    joined = buf;
                    &joined
                };
                let mut chunks = data.utf8_chunks().peekable();
                while let Some(chunk) = chunks.next() {
                    out.push_str(chunk.valid());
                    let invalid = chunk.invalid();
                    if invalid.is_empty() {
                        continue;
                    }
                    let truncated_tail = chunks.peek().is_none()
                        && std::str::from_utf8(invalid)
                            .err()
                            .is_some_and(|e| e.error_len().is_none());
                    if truncated_tail {
                        pending.extend_from_slice(invalid);
                    } else {
                        out.push(char::REPLACEMENT_CHARACTER);
                    }
                }
            }
            Self::Utf16 {
                big_endian,
                odd_byte,
                high_surrogate,
            } => {
                let unit = |a: u8, b: u8| {
                    if *big_endian {
                        u16::from_be_bytes([a, b])
                    } else {
                        u16::from_le_bytes([a, b])
                    }
                };
                let mut rest = bytes;
                let mut units = Vec::with_capacity(bytes.len() / 2 + 1);
                if let Some(first) = odd_byte.take() {
                    match rest.split_first() {
                        Some((&second, tail)) => {
                            units.push(unit(first, second));
                            rest = tail;
                        }
                        None => *odd_byte = Some(first),
                    }
                }
                let mut pairs = rest.chunks_exact(2);
                units.extend(pairs.by_ref().map(|pair| unit(pair[0], pair[1])));
                if let [last] = pairs.remainder() {
                    *odd_byte = Some(*last);
                }
                for u in units {
                    if let Some(high) = high_surrogate.take() {
                        if (0xDC00..0xE000).contains(&u) {
                            let code = 0x10000
                                + ((u32::from(high) - 0xD800) << 10)
                                + (u32::from(u) - 0xDC00);
                            out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
                            continue;
                        }
                        out.push(char::REPLACEMENT_CHARACTER);
                    }
                    if (0xD800..0xDC00).contains(&u) {
                        *high_surrogate = Some(u);
                    } else {
                        out.push(
                            char::from_u32(u32::from(u)).unwrap_or(char::REPLACEMENT_CHARACTER),
                        );
                    }
                }
            }
        }
    }

    fn end(&mut self, out: &mut String) {
        match self {
            Self::Utf8 { pending } => {
                if !pending.is_empty() {
                    pending.clear();
                    out.push(char::REPLACEMENT_CHARACTER);
                }
            }
            Self::Utf16 {
                odd_byte,
                high_surrogate,
                ..
            } => {
                if high_surrogate.take().is_some() {
                    out.push(char::REPLACEMENT_CHARACTER);
                }
                if odd_byte.take().is_some() {
                    out.push(char::REPLACEMENT_CHARACTER);
                }
            }
        }
    }
}

/// Port of TS `readTextRange`: keeps only the requested character window of each line, never
/// a whole unbounded source line. Columns count Unicode scalar values. `columnOffset` applies
/// to the first requested line only.
struct LineWindowReader {
    offset: usize,
    column_offset: usize,
    last_line: usize,
    line_no: usize,
    line_len: usize,
    window: String,
    window_chars: usize,
    skip_leading_lf: bool,
    saw_text: bool,
    /// The last requested line was terminated; any further text means more lines exist.
    after_last: bool,
    has_more: bool,
    done: bool,
    numbered: Vec<String>,
}

impl LineWindowReader {
    fn new(offset: usize, column_offset: usize, limit: usize) -> Self {
        let offset = offset.max(1);
        Self {
            offset,
            column_offset: column_offset.max(1),
            last_line: offset.saturating_add(limit.max(1)) - 1,
            line_no: 1,
            line_len: 0,
            window: String::new(),
            window_chars: 0,
            skip_leading_lf: false,
            saw_text: false,
            after_last: false,
            has_more: false,
            done: false,
            numbered: Vec::new(),
        }
    }

    fn column_start(&self) -> usize {
        if self.line_no == self.offset {
            self.column_offset - 1
        } else {
            0
        }
    }

    fn in_range(&self) -> bool {
        self.line_no >= self.offset && self.line_no <= self.last_line
    }

    fn emit_line(&mut self) {
        if !self.in_range() {
            return;
        }
        let line_no = self.line_no;
        let next_column = self.column_start() + self.window_chars + 1;
        let continuation = if self.line_len >= next_column {
            format!(
                "... [line {line_no} continues; read offset={line_no} columnOffset={next_column} limit=1]"
            )
        } else {
            String::new()
        };
        self.numbered
            .push(format!("{line_no}\t{}{continuation}", self.window));
    }

    /// Feeds decoded text; returns true once nothing later can change the result.
    fn consume(&mut self, text: &str) -> bool {
        if self.done || text.is_empty() {
            return self.done;
        }
        self.saw_text = true;
        for c in text.chars() {
            if self.skip_leading_lf {
                self.skip_leading_lf = false;
                if c == '\n' {
                    continue;
                }
            }
            if self.after_last {
                self.has_more = true;
                self.done = true;
                return true;
            }
            if c == '\r' || c == '\n' {
                self.emit_line();
                self.skip_leading_lf = c == '\r';
                if self.line_no == self.last_line {
                    self.after_last = true;
                    continue;
                }
                self.line_no += 1;
                self.line_len = 0;
                self.window.clear();
                self.window_chars = 0;
                continue;
            }
            if self.in_range() {
                let start = self.column_start();
                if self.line_len >= start && self.line_len < start + MAX_CHARS_PER_LINE_WINDOW {
                    self.window.push(c);
                    self.window_chars += 1;
                }
            }
            self.line_len += 1;
            // Once the last requested line has a continuation, nothing after this window can
            // affect the result: stop even if that line spans gigabytes.
            if self.line_no == self.last_line
                && self.line_len > self.column_start() + MAX_CHARS_PER_LINE_WINDOW
            {
                self.emit_line();
                self.done = true;
                return true;
            }
        }
        false
    }

    fn finish(mut self) -> String {
        if !self.done
            && !self.after_last
            && (self.line_len > 0 || (self.line_no == 1 && !self.saw_text))
        {
            self.emit_line();
        }
        let mut out = self.numbered.join("\n");
        if self.has_more {
            let next = self.last_line + 1;
            out.push_str(&format!(
                "\n\n[Showing lines {}-{}; pass offset={next} to continue]",
                self.offset, self.last_line
            ));
        }
        out
    }
}

/// Streams a text file through a lossy decoder into a bounded line window: memory stays
/// O(chunk + window) however long the file or its lines are.
fn read_text_window_streaming(
    mut file: File,
    display_name: &str,
    file_size: u64,
    offset_1based: usize,
    column_offset_1based: usize,
    limit: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> ToolResult<ToolOutput> {
    let read_err =
        |e: std::io::Error| ToolError::Execution(format!("Failed to read {display_name}: {e}"));
    let mut head = vec![0u8; BINARY_SNIFF_BYTES];
    let mut head_n = 0;
    while head_n < head.len() {
        let n = file.read(&mut head[head_n..]).map_err(read_err)?;
        if n == 0 {
            break;
        }
        head_n += n;
    }
    let (encoding, bom_len) = detect_bom(&head[..head_n]);
    // Same rule as `looks_binary_without_utf16_bom`: a NUL in the leading 8 KiB of a file
    // without a UTF-16 BOM marks it binary. NULs later in the file are decoded as text.
    if matches!(encoding, TextEncoding::Utf8 | TextEncoding::Utf8Bom)
        && head[bom_len..head_n].contains(&0)
    {
        return Ok(ToolOutput::Text(format!(
            "Cannot read {display_name} as text (application/octet-stream, {file_size} bytes). Use dedicated tools or python/bash scripts to inspect binary files."
        )));
    }

    let mut decoder = StreamDecoder::for_encoding(encoding);
    let mut lines = LineWindowReader::new(offset_1based, column_offset_1based, limit);
    let mut text = String::with_capacity(READ_CHUNK_BYTES + 4);
    decoder.write(&head[bom_len..head_n], &mut text);
    if lines.consume(&text) {
        return Ok(ToolOutput::Text(lines.finish()));
    }
    if head_n == head.len() {
        let mut raw = vec![0u8; READ_CHUNK_BYTES];
        loop {
            if is_cancelled() {
                return Err(ToolError::Execution(format!(
                    "Read of {display_name} cancelled."
                )));
            }
            let n = file.read(&mut raw).map_err(read_err)?;
            if n == 0 {
                break;
            }
            text.clear();
            decoder.write(&raw[..n], &mut text);
            if lines.consume(&text) {
                return Ok(ToolOutput::Text(lines.finish()));
            }
        }
    }
    text.clear();
    decoder.end(&mut text);
    lines.consume(&text);
    Ok(ToolOutput::Text(lines.finish()))
}

#[async_trait]
impl BuiltinTool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }

    fn description(&self) -> &str {
        "Read a concrete file from the filesystem, not a directory. Returns line-numbered text for text files (UTF-8 and UTF-16 BOM). Use offset/limit for large files and columnOffset to continue a source line longer than 2,000 characters. For images, returns visual content when the model supports image input. Audio, video, and PDF files are binary media and are not returned through read; use attached media or dedicated extraction/transcription workflows."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filePath": {
                    "type": "string",
                    "description": "Path to the file to read (absolute or relative to the working directory)."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "1-based starting line number (default: 1)."
                },
                "columnOffset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "1-based starting character in the first returned line (default: 1)."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_READ_LIMIT,
                    "description": "Maximum number of lines to return (default: 2000, max: 20000)."
                }
            },
            "required": ["filePath"]
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("filePath")
            && let Some(alias) = raw_args
                .remove("file_path")
                .or_else(|| raw_args.remove("path"))
        {
            raw_args.insert("filePath".to_owned(), alias);
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let raw_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("filePath is required".to_owned()))?;
        let offset = args
            .get("offset")
            .and_then(Value::as_u64)
            .map_or(1usize, |v| v as usize);
        let column_offset = args
            .get("columnOffset")
            .and_then(Value::as_u64)
            .map_or(1usize, |v| v as usize);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_READ_LIMIT, |v| (v as usize).min(MAX_READ_LIMIT));

        // Lexical form, so the credential deny also sees the path as spelled before symlinks.
        let candidate = lexical_tool_path(raw_path, &ctx.working_directory)?;
        let path = assert_read_path_allowed(&candidate, ctx)?;

        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(ToolError::Execution(format!(
                    "File not found: {}",
                    path.display()
                )));
            }
            Err(err) => {
                return Err(ToolError::Execution(format!(
                    "Cannot access '{}': {err}",
                    path.display()
                )));
            }
        };

        if meta.is_dir() {
            return Ok(ToolOutput::Text(read_directory_guard_message(
                &path, raw_path,
            )));
        }

        // `fs::metadata` follows symlinks, so this rejects FIFOs, sockets, and devices
        // reached directly or via a link. Opening a FIFO with no writer blocks forever
        // (outside cancellation), which would wedge the turn. `open_read_checked` re-checks
        // the opened handle in case the file is swapped after this point.
        if !meta.is_file() {
            return Err(ToolError::Execution(format!(
                "Cannot read {}: not a regular file.",
                display_file_name(&path)
            )));
        }

        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw_path.to_owned());
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();

        if let Some(mime) = Self::media_mime_for_ext(&ext) {
            if mime.starts_with("image/") && model_supports_image_input(ctx) {
                // Reject by size BEFORE reading the file into memory (TS parity).
                if meta.len() > MAX_MEDIA_BYTES {
                    return Err(ToolError::Execution(
                        "File too large to send inline (max 25MB)".to_owned(),
                    ));
                }
                let file = open_read_checked(ctx, &path)?;
                let bytes = tokio::task::spawn_blocking(move || {
                    let mut bytes = Vec::new();
                    file.take(MAX_MEDIA_BYTES + 1)
                        .read_to_end(&mut bytes)
                        .map(|_| bytes)
                })
                .await
                .map_err(|e| ToolError::Execution(format!("Read task failed: {e}")))?
                .map_err(|e| ToolError::Execution(format!("Failed to read {file_name}: {e}")))?;
                if bytes.len() as u64 > MAX_MEDIA_BYTES {
                    return Err(ToolError::Execution(
                        "File too large to send inline (max 25MB)".to_owned(),
                    ));
                }
                return Ok(ToolOutput::Content(vec![
                    ToolResultPart::Text {
                        text: format!("Image file: {file_name}"),
                    },
                    ToolResultPart::Media {
                        kind: MediaKind::Image,
                        source: MediaSource::Base64 {
                            mime_type: mime.to_owned(),
                            data: data_encoding::BASE64.encode(&bytes),
                        },
                    },
                ]));
            }
            // Images the model cannot see, audio, video and PDF.
            return Ok(ToolOutput::Text(binary_media_guard_message(
                &file_name, mime,
            )));
        }

        let file_size = meta.len();
        if let Some(mime) = Self::known_binary_mime_for_ext(&ext) {
            return Ok(ToolOutput::Text(format!(
                "Cannot read {file_name} as text ({mime}, {file_size} bytes). Use dedicated tools or python/bash scripts to inspect this file."
            )));
        }

        let file = open_read_checked(ctx, &path)?;
        let cancel_rx = ctx.cancel_rx.clone();
        tokio::task::spawn_blocking(move || {
            let is_cancelled = || cancel_rx.as_ref().is_some_and(|rx| *rx.borrow());
            read_text_window_streaming(
                file,
                &file_name,
                file_size,
                offset,
                column_offset,
                limit,
                &is_cancelled,
            )
        })
        .await
        .map_err(|e| ToolError::Execution(format!("Read task failed: {e}")))?
    }
}

/// Rejects a string argument longer than `max` UTF-16 code units (zod's `.max()` unit, so the
/// cap matches TS exactly) before schema validation, whose error would echo the whole value.
fn assert_string_arg_max(args: &Map<String, Value>, key: &str, max: usize) -> ToolResult<()> {
    if let Some(Value::String(value)) = args.get(key)
        && value.len() > max
        && value.encode_utf16().count() > max
    {
        return Err(ToolError::InvalidArguments(format!(
            "Invalid tool arguments: {key}: Too big: expected string to have <={max} characters"
        )));
    }
    Ok(())
}

pub struct WriteTool;

#[async_trait]
impl BuiltinTool for WriteTool {
    fn name(&self) -> &str {
        "write"
    }

    fn description(&self) -> &str {
        "Create a new file or atomically overwrite an existing file (default), or append a chunk with mode \"append\" (creating the file if needed). Creates parent directories if needed. Preserves an existing text file's BOM/encoding and dominant CRLF/LF line endings."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filePath": {
                    "type": "string",
                    "description": "Path to the file to write (absolute or relative to the working directory)."
                },
                "content": {
                    "type": "string",
                    "maxLength": MAX_WRITE_CONTENT_CHARS,
                    "description": "Content to write: the full file for overwrite, or the chunk to add for append."
                },
                "mode": {
                    "type": "string",
                    "enum": ["overwrite", "append"],
                    "default": "overwrite",
                    "description": "Use overwrite for a full replacement, or append to add a chunk"
                }
            },
            "required": ["filePath", "content"]
        })
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("filePath")
            && let Some(alias) = raw_args
                .remove("file_path")
                .or_else(|| raw_args.remove("path"))
        {
            raw_args.insert("filePath".to_owned(), alias);
        }
        assert_string_arg_max(&raw_args, "content", MAX_WRITE_CONTENT_CHARS)?;
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let raw_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("filePath is required".to_owned()))?;
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("content is required".to_owned()))?
            .to_owned();
        // Schema validation restricts `mode` to the enum; absent means overwrite (TS default).
        let append = args.get("mode").and_then(Value::as_str) == Some("append");

        let target = resolve_tool_path(raw_path, &ctx.working_directory)?;
        let display = target.display().to_string();
        // TS `write.ts` reports `content.length` (UTF-16 code units) for appends.
        let appended_chars = append.then(|| content.encode_utf16().count());

        // Only a bounded prefix of an existing file is read (to keep its encoding and dominant
        // line ending); an append stages a streamed copy instead of buffering the file, as TS
        // `writeFileAtomic` did with `copyFile`.
        let (existed, byte_len) = with_file_mutation_staged(
            &target,
            ctx,
            "write",
            ExistingRead::Prefix(WRITE_SNIFF_PREFIX_BYTES),
            move |snapshot| {
                let decoded = snapshot
                    .bytes
                    .as_deref()
                    .and_then(|prefix| sniff_existing_text(prefix, snapshot.bytes_truncated));
                let (encoding, eol) = if let Some(decoded) = decoded {
                    decoded
                } else {
                    let explicit_eol = detect_dominant_eol(&content);
                    (
                        if content.starts_with('\u{feff}') {
                            TextEncoding::Utf8Bom
                        } else {
                            TextEncoding::Utf8
                        },
                        if explicit_eol == LineEnding::Crlf {
                            LineEnding::Crlf
                        } else {
                            LineEnding::Lf
                        },
                    )
                };
                let staged = if append && snapshot.exists {
                    StagedContent::AppendToExisting(append_chunk(
                        &content,
                        decoded.is_some(),
                        encoding,
                        eol,
                    ))
                } else {
                    StagedContent::Replace(encode_text_buffer(
                        &normalize_to_lf(&content),
                        encoding,
                        eol,
                    ))
                };
                // Only reported for overwrites (appends report the chunk's char count).
                let len = match &staged {
                    StagedContent::Replace(bytes) | StagedContent::AppendToExisting(bytes) => {
                        bytes.len()
                    }
                };
                Ok((staged, (snapshot.exists, len)))
            },
        )
        .await?;

        if let Some(chars) = appended_chars {
            return Ok(ToolOutput::Text(format!(
                "Appended {chars} chars to {display}"
            )));
        }
        let verb = if existed { "Updated" } else { "Created" };
        Ok(ToolOutput::Text(format!(
            "{verb} {display} ({byte_len} bytes)"
        )))
    }
}

/// How much of an existing file `write` reads to keep its encoding and dominant line ending.
const WRITE_SNIFF_PREFIX_BYTES: usize = 1024 * 1024;

/// Encoding and dominant EOL of an existing text file from its first bytes, or `None` for an
/// undecodable (binary / invalid) file. A truncated prefix may end inside a UTF-8 sequence or a
/// UTF-16 code unit / surrogate pair, so up to three trailing bytes are dropped before decoding.
fn sniff_existing_text(prefix: &[u8], truncated: bool) -> Option<(TextEncoding, LineEnding)> {
    let max_cut = if truncated { 3.min(prefix.len()) } else { 0 };
    (0..=max_cut).find_map(|cut| {
        decode_text_buffer(&prefix[..prefix.len() - cut])
            .ok()
            .map(|d| (d.encoding, d.dominant_eol))
    })
}

/// TS `writeFileAtomic(..., { append: true })` stages a copy of the current file and appends to
/// it, so the existing bytes are kept verbatim and the whole result is published atomically. A
/// decodable text file's chunk is encoded like an overwrite (the file's encoding and dominant
/// EOL, never a second BOM); an undecodable file gets the raw UTF-8 chunk, as in TS. Returns the
/// bytes to append.
fn append_chunk(content: &str, is_text: bool, encoding: TextEncoding, eol: LineEnding) -> Vec<u8> {
    if !is_text {
        return content.as_bytes().to_vec();
    }
    let chunk = encode_text_buffer(&normalize_to_lf(content), encoding, eol);
    let bom_len = match encoding {
        TextEncoding::Utf8 => 0,
        TextEncoding::Utf8Bom => 3,
        TextEncoding::Utf16LeBom | TextEncoding::Utf16BeBom => 2,
    };
    chunk[bom_len..].to_vec()
}

/// TS `read.ts` directory guard, plus a concrete `glob` call whose arguments match
/// [`crate::search_tools::GlobTool`]'s schema (the directory goes in `cwd`; glob has no `path`).
pub(crate) fn read_directory_guard_message(path: &Path, raw_path: &str) -> String {
    let glob_args = json!({ "pattern": "*", "cwd": raw_path });
    format!(
        "Cannot read {} because it is a directory. The read tool accepts concrete file paths only. To list it, call glob with {glob_args}; or use grep, or choose a file inside the directory.",
        display_file_name(path)
    )
}

pub struct EditTool;

#[async_trait]
impl BuiltinTool for EditTool {
    fn name(&self) -> &str {
        "edit"
    }

    fn description(&self) -> &str {
        "Perform exact literal string replacements in an existing text file while preserving UTF-8/UTF-16 BOM and dominant CRLF/LF line endings."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filePath": {
                    "type": "string",
                    "description": "Path to the existing file to edit."
                },
                "oldString": {
                    "type": "string",
                    "maxLength": MAX_EDIT_STRING_CHARS,
                    "description": "Exact text to locate in the file."
                },
                "newString": {
                    "type": "string",
                    "maxLength": MAX_EDIT_STRING_CHARS,
                    "description": "Replacement text."
                },
                "replaceAll": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring oldString to be unique (default: false)."
                }
            },
            "required": ["filePath", "oldString", "newString"]
        })
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("filePath")
            && let Some(alias) = raw_args
                .remove("file_path")
                .or_else(|| raw_args.remove("path"))
        {
            raw_args.insert("filePath".to_owned(), alias);
        }
        if !raw_args.contains_key("oldString")
            && let Some(alias) = raw_args.remove("old_string")
        {
            raw_args.insert("oldString".to_owned(), alias);
        }
        if !raw_args.contains_key("newString")
            && let Some(alias) = raw_args.remove("new_string")
        {
            raw_args.insert("newString".to_owned(), alias);
        }
        if !raw_args.contains_key("replaceAll")
            && let Some(alias) = raw_args.remove("replace_all")
        {
            raw_args.insert("replaceAll".to_owned(), alias);
        }
        assert_string_arg_max(&raw_args, "oldString", MAX_EDIT_STRING_CHARS)?;
        assert_string_arg_max(&raw_args, "newString", MAX_EDIT_STRING_CHARS)?;

        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let raw_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("filePath is required".to_owned()))?;
        let old_string = args
            .get("oldString")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("oldString is required".to_owned()))?
            .to_owned();
        let new_string = args
            .get("newString")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("newString is required".to_owned()))?
            .to_owned();
        let replace_all = args
            .get("replaceAll")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let target = resolve_tool_path(raw_path, &ctx.working_directory)?;
        let display = target.display().to_string();

        // TS `edit.ts`: reject oversized files by stat before reading them into memory. Checked
        // on the authorized path only, so an unauthorized path's size never leaks; the snapshot
        // length is re-checked under the lock in case the file grew meanwhile.
        let authorized = assert_write_path_allowed(&target, ctx)?;
        if let Ok(meta) = fs::metadata(&authorized)
            && meta.is_file()
        {
            assert_edit_file_size(&display, meta.len())?;
        }

        let replacements = with_file_mutation(&target, ctx, "edit", move |snapshot| {
            let prev_bytes = snapshot.bytes.ok_or_else(|| {
                ToolError::Execution(format!(
                    "File '{}' does not exist. Use the write tool to create new files.",
                    display
                ))
            })?;
            assert_edit_file_size(&display, prev_bytes.len() as u64)?;
            let decoded = decode_text_buffer(&prev_bytes)?;
            assert_edit_projection(&decoded.text, &old_string, &new_string, replace_all)?;
            let (updated_lf, count) =
                replace_respecting_eol(&decoded.text, &old_string, &new_string, replace_all)?;
            let encoded = encode_text_buffer(&updated_lf, decoded.encoding, decoded.dominant_eol);
            if encoded.len() as u64 > MAX_EDIT_FILE_BYTES {
                return Err(ToolError::Execution(format!(
                    "edit blocked: encoded result would be {} bytes (max {MAX_EDIT_FILE_BYTES}).",
                    encoded.len()
                )));
            }
            Ok((encoded, count))
        })
        .await?;

        Ok(ToolOutput::Text(format!(
            "Edited {} ({} replacement{})",
            target.display(),
            replacements,
            if replacements == 1 { "" } else { "s" }
        )))
    }
}

fn assert_edit_file_size(display: &str, len: u64) -> ToolResult<()> {
    if len > MAX_EDIT_FILE_BYTES {
        return Err(ToolError::Execution(format!(
            "edit blocked: {display} is {len} bytes (max {MAX_EDIT_FILE_BYTES})."
        )));
    }
    Ok(())
}

/// TS `edit.ts`: a `replaceAll` over many short matches can multiply the result far beyond the
/// input caps, so reject before building the string. Skipped when the match would fail anyway
/// (not found / not unique), so those errors keep precedence as in TS. The LF-normalized
/// projection ignores CRLF re-emission; it is a soft heap guard.
fn assert_edit_projection(
    lf_text: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> ToolResult<()> {
    let needle = normalize_to_lf(old_string);
    if needle.is_empty() {
        return Ok(());
    }
    let occurrences = lf_text.matches(needle.as_str()).count();
    if occurrences == 0 || (occurrences > 1 && !replace_all) {
        return Ok(());
    }
    let replacement_len = normalize_to_lf(new_string).len() as i128;
    let projected =
        lf_text.len() as i128 + occurrences as i128 * (replacement_len - needle.len() as i128);
    if projected > i128::from(MAX_EDIT_FILE_BYTES) {
        return Err(ToolError::Execution(format!(
            "edit blocked: result would be ~{projected} bytes (max {MAX_EDIT_FILE_BYTES})."
        )));
    }
    Ok(())
}
