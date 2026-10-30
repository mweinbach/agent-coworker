use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::http::{HeaderValue, Response, StatusCode, header};
use bytes::Bytes;
use cowork_config::{canonicalize_sync, is_inside};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAX_FS_READ_BYTES: usize = 256 * 1024;
const MAX_FS_PREVIEW_BYTES: usize = 15 * 1024 * 1024;

#[derive(Debug)]
pub struct FsRouteError {
    pub status: StatusCode,
    pub message: String,
}

impl FsRouteError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.into(),
        }
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: msg.into(),
        }
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: msg.into(),
        }
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: msg.into(),
        }
    }

    pub fn from_io(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            Self::not_found(err.to_string())
        } else if err.kind() == std::io::ErrorKind::PermissionDenied {
            Self::forbidden(err.to_string())
        } else {
            Self::bad_request(err.to_string())
        }
    }

    pub fn into_response(self) -> Response<Body> {
        Response::builder()
            .status(self.status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from(self.message))
            .unwrap()
    }
}

fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'!'
            | b'\''
            | b'('
            | b')'
            | b'*' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn resolve_input_path(default_cwd: &Path, raw: &str) -> Result<PathBuf, FsRouteError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(FsRouteError::bad_request("Missing or invalid path"));
    }
    let candidate = Path::new(trimmed);
    Ok(if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        default_cwd.join(candidate)
    })
}

/// Validates that `target` resolves strictly inside at least one of `allowed_roots` (blocking `..` and symlink escapes).
pub fn assert_path_within_roots(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    raw_target: &str,
) -> Result<PathBuf, FsRouteError> {
    let resolved = resolve_input_path(default_cwd, raw_target)?;
    let canonical_target = canonicalize_sync(&resolved);
    let canonical_roots: Vec<PathBuf> =
        allowed_roots.iter().map(|p| canonicalize_sync(p)).collect();

    if canonical_roots
        .iter()
        .any(|root| is_inside(root, &canonical_target))
    {
        Ok(canonical_target)
    } else {
        Err(FsRouteError::forbidden(
            "Path is outside allowed workspace roots",
        ))
    }
}

/// Validates a mutation target (`rename` / `trash`) so final symlinks inside workspace can be renamed/trashed without mutating external targets or workspace roots.
pub fn assert_mutation_path_within_roots(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    raw_target: &str,
) -> Result<(PathBuf, PathBuf), FsRouteError> {
    let resolved = resolve_input_path(default_cwd, raw_target)?;
    // Reject explicit parent traversal segments after lexical normalization
    let normalized = cowork_config::normalize_lexical_path(&resolved);
    let Some(file_name) = normalized.file_name() else {
        return Err(FsRouteError::bad_request(
            "Cannot rename or trash a workspace root",
        ));
    };
    let Some(parent) = normalized.parent() else {
        return Err(FsRouteError::bad_request(
            "Cannot rename or trash a workspace root",
        ));
    };

    let canonical_parent = canonicalize_sync(parent);
    let canonical_roots: Vec<PathBuf> =
        allowed_roots.iter().map(|p| canonicalize_sync(p)).collect();

    let Some(containing_root) = canonical_roots
        .iter()
        .find(|root| is_inside(root, &canonical_parent))
        .cloned()
    else {
        return Err(FsRouteError::forbidden(
            "Path is outside allowed workspace roots",
        ));
    };

    let entry_path = canonical_parent.join(file_name);
    if canonical_roots.iter().any(|root| root == &entry_path) {
        return Err(FsRouteError::bad_request(
            "Cannot rename or trash a workspace root",
        ));
    }

    Ok((entry_path, containing_root))
}

fn validate_single_entry_name(name: &str) -> Result<String, FsRouteError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(FsRouteError::bad_request("Invalid file or directory name"));
    }
    let mut comps = Path::new(trimmed).components();
    if !matches!(comps.next(), Some(Component::Normal(_))) || comps.next().is_some() {
        return Err(FsRouteError::bad_request("Invalid file or directory name"));
    }
    Ok(trimmed.to_owned())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_hidden: bool,
    pub size_bytes: Option<u64>,
    pub modified_at_ms: Option<u128>,
}

fn query_map(query: Option<&str>) -> HashMap<String, String> {
    query
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default()
}

pub fn handle_fs_list(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    query: Option<&str>,
) -> Result<Response<Body>, FsRouteError> {
    let params = query_map(query);
    let raw_path = params
        .get("path")
        .map(String::as_str)
        .ok_or_else(|| FsRouteError::bad_request("Missing path parameter"))?;
    let include_hidden = params.get("includeHidden").map(String::as_str) == Some("true");

    let safe_dir = assert_path_within_roots(allowed_roots, default_cwd, raw_path)?;
    let read_dir = std::fs::read_dir(&safe_dir).map_err(FsRouteError::from_io)?;

    let mut entries = Vec::new();
    for item in read_dir {
        let Ok(entry) = item else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_hidden = name.starts_with('.') || name.starts_with("~$");
        if is_hidden && !include_hidden {
            continue;
        }
        let full_path = entry.path();
        let meta = std::fs::metadata(&full_path).ok();
        let is_directory = meta.as_ref().is_some_and(|m| m.is_dir());
        let size_bytes = meta.as_ref().and_then(|m| (!m.is_dir()).then_some(m.len()));
        let modified_at_ms = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis());

        entries.push(FsListEntry {
            name,
            path: full_path.to_string_lossy().into_owned(),
            is_directory,
            is_hidden,
            size_bytes,
            modified_at_ms,
        });
    }

    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a
            .name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.name.cmp(&b.name)),
    });

    let body = serde_json::to_vec(&entries).unwrap_or_default();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap())
}

pub fn handle_fs_read(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    query: Option<&str>,
) -> Result<Response<Body>, FsRouteError> {
    let params = query_map(query);
    let raw_path = params
        .get("path")
        .map(String::as_str)
        .ok_or_else(|| FsRouteError::bad_request("Missing path parameter"))?;

    let safe_file = assert_path_within_roots(allowed_roots, default_cwd, raw_path)?;
    // Re-canonicalize existing file to defeat broken/external symlinks
    let real_file = std::fs::canonicalize(&safe_file).map_err(FsRouteError::from_io)?;
    let canonical_roots: Vec<PathBuf> =
        allowed_roots.iter().map(|p| canonicalize_sync(p)).collect();
    if !canonical_roots.iter().any(|r| is_inside(r, &real_file)) {
        return Err(FsRouteError::forbidden(
            "Path is outside allowed workspace roots",
        ));
    }

    let mut file = std::fs::File::open(&real_file).map_err(FsRouteError::from_io)?;
    let meta = file.metadata().map_err(FsRouteError::from_io)?;
    if !meta.is_file() {
        return Err(FsRouteError::bad_request("Path is not a regular file"));
    }

    let mut buf = Vec::with_capacity((meta.len() as usize).min(MAX_FS_READ_BYTES));
    (&mut file)
        .take(MAX_FS_READ_BYTES as u64)
        .read_to_end(&mut buf)
        .map_err(FsRouteError::from_io)?;
    let content = String::from_utf8_lossy(&buf).into_owned();

    let body = serde_json::to_vec(&json!({ "content": content })).unwrap_or_default();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap())
}

#[cfg(unix)]
fn metadata_fingerprint(meta: &std::fs::Metadata) -> (u64, u64, i64, i64, u64) {
    use std::os::unix::fs::MetadataExt;
    let mtime_ms = meta.mtime() * 1000 + (meta.mtime_nsec() / 1_000_000);
    let ctime_ms = meta.ctime() * 1000 + (meta.ctime_nsec() / 1_000_000);
    (meta.dev(), meta.ino(), mtime_ms, ctime_ms, meta.len())
}

#[cfg(not(unix))]
fn metadata_fingerprint(meta: &std::fs::Metadata) -> (u64, u64, i64, i64, u64) {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (0, 0, mtime_ms, mtime_ms, meta.len())
}

pub fn handle_fs_preview(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    query: Option<&str>,
) -> Result<Response<Body>, FsRouteError> {
    let params = query_map(query);
    let raw_path = params
        .get("path")
        .map(String::as_str)
        .ok_or_else(|| FsRouteError::bad_request("Missing path parameter"))?;
    let max_bytes = params
        .get("maxBytes")
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| n.clamp(1, MAX_FS_PREVIEW_BYTES))
        .unwrap_or(MAX_FS_PREVIEW_BYTES);

    let safe_file = assert_path_within_roots(allowed_roots, default_cwd, raw_path)?;
    let real_file = std::fs::canonicalize(&safe_file).map_err(FsRouteError::from_io)?;
    let canonical_roots: Vec<PathBuf> =
        allowed_roots.iter().map(|p| canonicalize_sync(p)).collect();
    if !canonical_roots.iter().any(|r| is_inside(r, &real_file)) {
        return Err(FsRouteError::forbidden(
            "Path is outside allowed workspace roots",
        ));
    }

    let mut open_opts = std::fs::OpenOptions::new();
    open_opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.custom_flags(libc::O_NOFOLLOW);
    }

    let lstat_before = std::fs::symlink_metadata(&real_file).map_err(FsRouteError::from_io)?;
    if !lstat_before.is_file() {
        return Err(FsRouteError::bad_request("Path is not a regular file"));
    }

    let mut file = open_opts.open(&real_file).map_err(FsRouteError::from_io)?;
    let fstat_before = file.metadata().map_err(FsRouteError::from_io)?;
    let fp_before = metadata_fingerprint(&fstat_before);
    if fp_before != metadata_fingerprint(&lstat_before) {
        return Err(FsRouteError::conflict("File changed while opening preview"));
    }

    let mut buf = Vec::with_capacity((fstat_before.len() as usize).min(max_bytes));
    (&mut file)
        .take(max_bytes as u64)
        .read_to_end(&mut buf)
        .map_err(FsRouteError::from_io)?;

    let fstat_after = file.metadata().map_err(FsRouteError::from_io)?;
    let (dev, ino, mtime_ms, ctime_ms, total_size) = metadata_fingerprint(&fstat_after);
    if (dev, ino, mtime_ms, ctime_ms, total_size) != fp_before {
        return Err(FsRouteError::conflict("File changed during preview read"));
    }

    let truncated = if (buf.len() as u64) < total_size {
        "1"
    } else {
        "0"
    };
    let encoded_path = percent_encode_component(&real_file.to_string_lossy());
    let fingerprint = format!("{dev}:{ino}:{mtime_ms}:{ctime_ms}:{total_size}");

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "no-store");

    for (k, v) in [
        ("X-Cowork-File-Path", encoded_path),
        ("X-Cowork-Byte-Length", buf.len().to_string()),
        ("X-Cowork-Truncated", truncated.to_owned()),
        ("X-Cowork-File-Modified-At", mtime_ms.to_string()),
        ("X-Cowork-File-Change-Time", ctime_ms.to_string()),
        ("X-Cowork-File-Size", total_size.to_string()),
        ("X-Cowork-File-Fingerprint", fingerprint),
    ] {
        if let Ok(hv) = HeaderValue::from_str(&v) {
            builder = builder.header(k, hv);
        }
    }

    Ok(builder.body(Body::from(Bytes::from(buf))).unwrap())
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("txt" | "md" | "rs" | "ts" | "tsx" | "js" | "py" | "toml" | "yaml" | "yml") => {
            "text/plain; charset=utf-8"
        }
        Some("json") => "application/json",
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("xhtml") => "application/xhtml+xml",
        Some("xml") => "application/xml",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn render_directory_html(dir: &Path) -> Result<String, FsRouteError> {
    let read_dir = std::fs::read_dir(dir).map_err(FsRouteError::from_io)?;
    let mut names: Vec<String> = read_dir
        .filter_map(|e| {
            e.ok()
                .map(|item| item.file_name().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    let mut html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body><h1>{}</h1><ul>",
        html_escape(&dir.to_string_lossy()),
        html_escape(&dir.to_string_lossy())
    );
    for name in names {
        html.push_str(&format!("<li>{}</li>", html_escape(&name)));
    }
    html.push_str("</ul></body></html>");
    Ok(html)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn handle_fs_open(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    query: Option<&str>,
    reveal_parent_if_file: bool,
) -> Result<Response<Body>, FsRouteError> {
    let params = query_map(query);
    let raw_path = params
        .get("path")
        .map(String::as_str)
        .ok_or_else(|| FsRouteError::bad_request("Missing path parameter"))?;

    let safe_target = assert_path_within_roots(allowed_roots, default_cwd, raw_path)?;
    let real_target = std::fs::canonicalize(&safe_target).map_err(FsRouteError::from_io)?;
    let canonical_roots: Vec<PathBuf> =
        allowed_roots.iter().map(|p| canonicalize_sync(p)).collect();
    if !canonical_roots.iter().any(|r| is_inside(r, &real_target)) {
        return Err(FsRouteError::forbidden(
            "Path is outside allowed workspace roots",
        ));
    }

    let target_to_open = if reveal_parent_if_file && !real_target.is_dir() {
        real_target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(real_target)
    } else {
        real_target
    };

    if target_to_open.is_dir() {
        let html = render_directory_html(&target_to_open)?;
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(html))
            .unwrap());
    }

    let bytes = std::fs::read(&target_to_open).map_err(FsRouteError::from_io)?;
    let mime = guess_mime(&target_to_open);
    let ext = target_to_open
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let force_attachment = matches!(ext.as_str(), "htm" | "html" | "svg" | "xhtml" | "xml");
    let basename = target_to_open
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if force_attachment {
            "attachment"
        } else {
            "inline"
        },
        percent_encode_component(&basename)
    );

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CONTENT_DISPOSITION, disposition)
        .body(Body::from(Bytes::from(bytes)))
        .unwrap())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDirPayload {
    parent_path: String,
    name: String,
}

pub fn handle_fs_create_directory(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    body: &[u8],
) -> Result<Response<Body>, FsRouteError> {
    let payload: CreateDirPayload =
        serde_json::from_slice(body).map_err(|_| FsRouteError::bad_request("Invalid JSON body"))?;
    let safe_parent = assert_path_within_roots(allowed_roots, default_cwd, &payload.parent_path)?;
    let valid_name = validate_single_entry_name(&payload.name)?;
    let target = safe_parent.join(valid_name);
    std::fs::create_dir(&target).map_err(FsRouteError::from_io)?;
    Ok(Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenamePayload {
    path: String,
    new_name: String,
}

pub fn handle_fs_rename(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    body: &[u8],
) -> Result<Response<Body>, FsRouteError> {
    let payload: RenamePayload =
        serde_json::from_slice(body).map_err(|_| FsRouteError::bad_request("Invalid JSON body"))?;
    let (src_path, _) =
        assert_mutation_path_within_roots(allowed_roots, default_cwd, &payload.path)?;
    if std::fs::symlink_metadata(&src_path).is_err() {
        return Err(FsRouteError::not_found("Source entry does not exist"));
    }
    let valid_name = validate_single_entry_name(&payload.new_name)?;
    let dst_path = src_path.parent().unwrap().join(valid_name);

    let same_case_only = src_path
        .file_name()
        .zip(dst_path.file_name())
        .is_some_and(|(a, b)| {
            a.to_string_lossy()
                .eq_ignore_ascii_case(&b.to_string_lossy())
        });

    if dst_path != src_path && !same_case_only && std::fs::symlink_metadata(&dst_path).is_ok() {
        return Err(FsRouteError::conflict(
            "An entry with that name already exists",
        ));
    }

    std::fs::rename(&src_path, &dst_path).map_err(FsRouteError::from_io)?;
    Ok(Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashPayload {
    path: String,
}

pub fn handle_fs_trash(
    allowed_roots: &[PathBuf],
    default_cwd: &Path,
    body: &[u8],
) -> Result<Response<Body>, FsRouteError> {
    let payload: TrashPayload =
        serde_json::from_slice(body).map_err(|_| FsRouteError::bad_request("Invalid JSON body"))?;
    let (src_path, containing_root) =
        assert_mutation_path_within_roots(allowed_roots, default_cwd, &payload.path)?;
    if std::fs::symlink_metadata(&src_path).is_err() {
        return Err(FsRouteError::not_found("Entry does not exist"));
    }

    let trash_dir = containing_root.join(".cowork-trash");
    if is_inside(&trash_dir, &src_path) {
        return Err(FsRouteError::bad_request(
            "Cannot trash items already inside .cowork-trash",
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&trash_dir)
        && meta.file_type().is_symlink()
    {
        return Err(FsRouteError::forbidden(
            ".cowork-trash must not be a symlink",
        ));
    }
    std::fs::create_dir_all(&trash_dir).map_err(FsRouteError::from_io)?;

    let ts = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let basename = src_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "item".to_owned());

    let mut dst = trash_dir.join(format!("{ts}-{basename}"));
    let mut suffix = 1u32;
    while std::fs::symlink_metadata(&dst).is_ok() {
        dst = trash_dir.join(format!("{ts}-{basename}-{suffix}"));
        suffix += 1;
    }

    std::fs::rename(&src_path, &dst).map_err(FsRouteError::from_io)?;
    Ok(Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap())
}
