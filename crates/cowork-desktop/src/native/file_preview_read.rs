//! Capped, symlink-safe file preview reader and rich web-only document fallback
//! matching `src/utils/filePreviewRead.ts` and `apps/desktop/src/lib/filePreviewKind.ts`.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail};
use cowork_config::canonicalize_sync;

use super::validation::assert_path_within_roots;
use crate::state::FilePreviewState;

pub const DEFAULT_PREVIEW_MAX_BYTES: usize = 15 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilePreviewKind {
    Markdown,
    Text,
    Pdf,
    Image,
    Docx,
    Csv,
    Xlsx,
    Pptx,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChangeVersion {
    pub modified_ms: u128,
    pub change_ms: u128,
    pub size: u64,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CappedFilePreview {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub version: FileChangeVersion,
}

pub fn file_change_version_from_meta(meta: &Metadata) -> FileChangeVersion {
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    #[cfg(unix)]
    let change_ms = {
        use std::os::unix::fs::MetadataExt;
        let secs = meta.ctime();
        let nsec = meta.ctime_nsec();
        if secs >= 0 && nsec >= 0 {
            (secs as u128) * 1_000 + (nsec as u128) / 1_000_000
        } else {
            modified_ms
        }
    };
    #[cfg(not(unix))]
    let change_ms = modified_ms;

    let size = meta.len();
    #[cfg(unix)]
    let fingerprint = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{modified_ms}:{change_ms}:{size}",
            meta.dev(),
            meta.ino()
        )
    };
    #[cfg(not(unix))]
    let fingerprint = format!("{modified_ms}:{change_ms}:{size}");

    FileChangeVersion {
        modified_ms,
        change_ms,
        size,
        fingerprint,
    }
}

pub fn get_extension_lower(file_path: &Path) -> String {
    let base = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let Some(dot) = base.rfind('.') else {
        return String::new();
    };
    if dot == 0 || dot + 1 >= base.len() {
        return String::new();
    }
    base[dot..].to_ascii_lowercase()
}

pub fn classify_file_preview_kind(file_path: &Path) -> FilePreviewKind {
    let ext = get_extension_lower(file_path);
    match ext.as_str() {
        ".pdf" => FilePreviewKind::Pdf,
        ".md" | ".mdx" => FilePreviewKind::Markdown,
        ".docx" => FilePreviewKind::Docx,
        ".doc" | ".odt" | ".rtf" => FilePreviewKind::Unsupported,
        ".csv" => FilePreviewKind::Csv,
        ".xlsx" | ".xls" | ".xlsm" | ".xlsb" | ".ods" => FilePreviewKind::Xlsx,
        ".pptx" | ".ppt" | ".odp" => FilePreviewKind::Pptx,
        ".png" | ".jpg" | ".jpeg" | ".webp" | ".gif" | ".bmp" | ".ico" | ".avif" | ".svg" => {
            FilePreviewKind::Image
        }
        ".txt" | ".log" | ".json" | ".jsonc" | ".ts" | ".tsx" | ".js" | ".jsx" | ".mjs"
        | ".cjs" | ".css" | ".scss" | ".html" | ".htm" | ".xml" | ".yaml" | ".yml" | ".toml"
        | ".ini" | ".cfg" | ".env" | ".sh" | ".bash" | ".zsh" | ".ps1" | ".bat" | ".cmd"
        | ".sql" | ".graphql" | ".gql" | ".rs" | ".go" | ".py" | ".rb" | ".php" | ".java"
        | ".kt" | ".swift" | ".c" | ".h" | ".cpp" | ".hpp" | ".cs" | ".vue" | ".svelte" => {
            FilePreviewKind::Text
        }
        _ => FilePreviewKind::Unknown,
    }
}

pub fn is_web_only_rich_document(kind: FilePreviewKind) -> bool {
    matches!(
        kind,
        FilePreviewKind::Docx | FilePreviewKind::Pptx | FilePreviewKind::Unsupported
    )
}

pub fn mime_for_preview_kind(kind: FilePreviewKind, ext: &str) -> &'static str {
    match kind {
        FilePreviewKind::Pdf => "application/pdf",
        FilePreviewKind::Image => match ext {
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".jpg" | ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".avif" => "image/avif",
            ".bmp" => "image/bmp",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream",
        },
        _ => "application/octet-stream",
    }
}

fn assert_authorized_file_path(abs_path: &Path, expected_canonical_path: &Path) -> Result<()> {
    let current = canonicalize_sync(abs_path);
    if current != expected_canonical_path {
        bail!("File path no longer matches the authorized file path.");
    }
    Ok(())
}

fn same_regular_identity(left: &Metadata, right: &Metadata) -> bool {
    if !left.is_file() || !right.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len()
    }
}

/// Opens a regular non-symlink file after verifying its identity against `expected_canonical_path`.
pub fn open_authorized_file(
    abs_path: &Path,
    expected_canonical_path: &Path,
) -> Result<(File, Metadata)> {
    assert_authorized_file_path(abs_path, expected_canonical_path)?;

    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }

    let file = opts
        .open(abs_path)
        .with_context(|| format!("Unable to open {}", abs_path.display()))?;
    assert_authorized_file_path(abs_path, expected_canonical_path)?;

    let fd_meta = file.metadata()?;
    if !fd_meta.is_file() {
        bail!("Path is not a file");
    }
    let path_meta = fs::symlink_metadata(abs_path)?;
    assert_authorized_file_path(abs_path, expected_canonical_path)?;

    if path_meta.file_type().is_symlink() || !same_regular_identity(&fd_meta, &path_meta) {
        bail!("File changed while it was being opened.");
    }
    Ok((file, fd_meta))
}

/// Reads up to `max_bytes` from `abs_path` while verifying the file did not race mid-read.
pub fn read_capped_file_preview(
    abs_path: &Path,
    max_bytes: usize,
    expected_canonical_path: Option<&Path>,
) -> Result<CappedFilePreview> {
    let fallback_canonical;
    let expected = match expected_canonical_path {
        Some(path) => path,
        None => {
            fallback_canonical = canonicalize_sync(abs_path);
            &fallback_canonical
        }
    };

    for attempt in 0..2 {
        let (before_meta, after_meta, bytes, truncated) = {
            let (file, before_meta) = open_authorized_file(abs_path, expected)?;
            let to_read = (before_meta.len() as usize).min(max_bytes);
            let mut buffer = Vec::with_capacity(to_read);
            let mut limited = file.take(to_read as u64);
            limited.read_to_end(&mut buffer)?;
            let file = limited.into_inner();
            let after_meta = file.metadata()?;
            let truncated = after_meta.len() > buffer.len() as u64;
            (before_meta, after_meta, buffer, truncated)
        };

        let path_meta = match fs::symlink_metadata(abs_path) {
            Ok(meta) => meta,
            Err(err) if attempt == 0 => {
                let _ = err;
                continue;
            }
            Err(err) => return Err(err.into()),
        };
        assert_authorized_file_path(abs_path, expected)?;
        if path_meta.file_type().is_symlink() || !path_meta.is_file() {
            if attempt == 0 {
                continue;
            }
            bail!("Preview path was replaced while it was being read.");
        }

        let before_ver = file_change_version_from_meta(&before_meta);
        let after_ver = file_change_version_from_meta(&after_meta);
        let path_ver = file_change_version_from_meta(&path_meta);
        if before_ver != after_ver || after_ver != path_ver {
            if attempt == 0 {
                continue;
            }
            bail!("File changed or was replaced while the preview was being read.");
        }

        return Ok(CappedFilePreview {
            path: abs_path.to_path_buf(),
            bytes,
            truncated,
            version: path_ver,
        });
    }

    bail!("Unable to read a stable file preview.")
}

fn decode_utf8_preview(bytes: &[u8], truncated: bool) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text.to_string()),
        Err(err) => {
            // If we truncated at an exact byte cap inside a multi-byte UTF-8 sequence,
            // trim only that incomplete trailing character rather than falsely marking it binary.
            if truncated && err.error_len().is_none() && err.valid_up_to() > 0 {
                std::str::from_utf8(&bytes[..err.valid_up_to()])
                    .ok()
                    .map(str::to_string)
            } else {
                None
            }
        }
    }
}

/// Validates workspace path containment and builds a native [`FilePreviewState`].
/// Decodes spreadsheet formats (`.csv`, `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.ods`) into inline
/// preview grids, while rich web-only document formats (`.pptx`, `.docx`, `.doc`, etc.) return a
/// clean "open in default app" fallback.
pub fn load_file_preview_state(
    workspace_roots: &[PathBuf],
    workspace_id: &str,
    requested_path: &Path,
    max_bytes: usize,
) -> Result<FilePreviewState> {
    let safe_path = assert_path_within_roots(workspace_roots, requested_path, "path")?;
    let title = safe_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("File preview")
        .to_string();
    let kind = classify_file_preview_kind(&safe_path);

    if matches!(kind, FilePreviewKind::Csv | FilePreviewKind::Xlsx) {
        let read = read_authorized_preview_bytes(workspace_roots, &safe_path, max_bytes)?;
        let raw_text = if kind == FilePreviewKind::Csv {
            decode_utf8_preview(&read.bytes, read.truncated)
        } else {
            None
        };
        let path_str = read.safe_path.to_string_lossy().into_owned();
        return match crate::views::preview::decode_spreadsheet_preview(
            &read.safe_path,
            &read.bytes,
            read.truncated,
        ) {
            Ok(spreadsheet) => {
                let truncated = read.truncated
                    || spreadsheet.sheets_truncated
                    || spreadsheet.sheets.iter().any(|s| s.is_truncated());
                Ok(FilePreviewState {
                    workspace_id: workspace_id.to_string(),
                    path: path_str,
                    title,
                    content: raw_text,
                    is_binary: kind == FilePreviewKind::Xlsx,
                    is_markdown: false,
                    truncated,
                    error: None,
                    spreadsheet: Some(spreadsheet),
                    presentation: None,
                })
            }
            Err(err) => {
                let is_binary = kind == FilePreviewKind::Xlsx || raw_text.is_none();
                let message = if err.contains("default app") {
                    err
                } else {
                    format!("{err} Open it in your default app instead.")
                };
                Ok(FilePreviewState {
                    workspace_id: workspace_id.to_string(),
                    path: path_str,
                    title,
                    content: raw_text,
                    is_binary,
                    is_markdown: false,
                    truncated: read.truncated,
                    error: Some(message),
                    spreadsheet: None,
                    presentation: None,
                })
            }
        };
    }

    if is_web_only_rich_document(kind) {
        let _ = open_authorized_file(&safe_path, &safe_path)?;
        let ext = get_extension_lower(&safe_path);
        let label = if ext.is_empty() {
            "rich document".to_string()
        } else {
            ext.to_ascii_uppercase()
        };
        return Ok(FilePreviewState {
            workspace_id: workspace_id.to_string(),
            path: safe_path.to_string_lossy().into_owned(),
            title,
            content: None,
            is_binary: true,
            is_markdown: false,
            truncated: false,
            error: Some(format!(
                "Rich preview for {label} documents is not available in the native app yet. Open it in your default app instead."
            )),
            spreadsheet: None,
            presentation: None,
        });
    }

    if matches!(kind, FilePreviewKind::Pdf | FilePreviewKind::Image) {
        let (file, meta) = open_authorized_file(&safe_path, &safe_path)?;
        drop(file);
        return Ok(FilePreviewState {
            workspace_id: workspace_id.to_string(),
            path: safe_path.to_string_lossy().into_owned(),
            title,
            content: None,
            is_binary: true,
            is_markdown: false,
            truncated: meta.len() > max_bytes as u64,
            error: Some("Previewing media/PDF files inline is unavailable here. Open it in your default app instead.".to_string()),
            spreadsheet: None,
            presentation: None,
        });
    }

    let capped = read_capped_file_preview(&safe_path, max_bytes, Some(&safe_path))?;
    if let Some(text) = decode_utf8_preview(&capped.bytes, capped.truncated) {
        Ok(FilePreviewState {
            workspace_id: workspace_id.to_string(),
            path: safe_path.to_string_lossy().into_owned(),
            title,
            content: Some(text),
            is_binary: false,
            is_markdown: kind == FilePreviewKind::Markdown,
            truncated: capped.truncated,
            error: None,
            spreadsheet: None,
            presentation: None,
        })
    } else {
        Ok(FilePreviewState {
            workspace_id: workspace_id.to_string(),
            path: safe_path.to_string_lossy().into_owned(),
            title,
            content: None,
            is_binary: true,
            is_markdown: false,
            truncated: capped.truncated,
            error: None,
            spreadsheet: None,
            presentation: None,
        })
    }
}

/// Result of a workspace-bounded raw byte preview read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedPreviewRead {
    pub safe_path: PathBuf,
    pub kind: FilePreviewKind,
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub file_size: u64,
}

/// Reads up to `max_bytes` from an authorized regular file inside `workspace_roots`.
pub fn read_authorized_preview_bytes(
    workspace_roots: &[PathBuf],
    requested_path: &Path,
    max_bytes: usize,
) -> Result<AuthorizedPreviewRead> {
    let safe_path = assert_path_within_roots(workspace_roots, requested_path, "path")?;
    let kind = classify_file_preview_kind(&safe_path);
    let capped = read_capped_file_preview(&safe_path, max_bytes, Some(&safe_path))?;
    Ok(AuthorizedPreviewRead {
        safe_path,
        kind,
        bytes: capped.bytes,
        truncated: capped.truncated,
        file_size: capped.version.size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn capped_preview_handles_multibyte_truncation_and_markdown() {
        let tmp = tempdir().unwrap();
        let md = tmp.path().join("README.md");
        fs::write(&md, "# Hello\n\n😀😀😀").unwrap();

        // Cut right inside a 4-byte emoji.
        let root = vec![tmp.path().to_path_buf()];
        let preview = load_file_preview_state(&root, "ws-1", &md, 11).unwrap();
        assert!(!preview.is_binary);
        assert!(preview.is_markdown);
        assert!(preview.truncated);
        assert_eq!(preview.content.as_deref(), Some("# Hello\n\n"));
        assert!(preview.error.is_none());
    }

    #[test]
    fn rich_documents_return_open_in_default_app_fallback() {
        let tmp = tempdir().unwrap();
        let slides = tmp.path().join("deck.pptx");
        fs::write(&slides, b"PK\x03\x04dummy-pptx").unwrap();
        let root = vec![tmp.path().to_path_buf()];

        let preview = load_file_preview_state(&root, "ws-1", &slides, 1024).unwrap();
        assert!(preview.is_binary);
        assert!(preview.content.is_none());
        assert!(preview.spreadsheet.is_none());
        assert!(
            preview
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("default app")
        );

        let corrupt_sheet = tmp.path().join("broken.xlsx");
        fs::write(&corrupt_sheet, b"not-a-valid-zip").unwrap();
        let sheet_fallback = load_file_preview_state(&root, "ws-1", &corrupt_sheet, 1024).unwrap();
        assert!(sheet_fallback.is_binary);
        assert!(sheet_fallback.spreadsheet.is_none());
        assert!(
            sheet_fallback
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("default app")
        );
    }

    #[test]
    fn loads_csv_spreadsheet_preview_and_preserves_raw_content() {
        let tmp = tempdir().unwrap();
        let csv_path = tmp.path().join("budget.csv");
        let csv_body = "Item,Amount\nCompute,120.50\nStorage,45\n";
        fs::write(&csv_path, csv_body).unwrap();
        let root = vec![tmp.path().to_path_buf()];

        let preview = load_file_preview_state(&root, "ws-1", &csv_path, 4096).unwrap();
        assert!(!preview.is_binary);
        assert!(preview.error.is_none());
        assert_eq!(preview.content.as_deref(), Some(csv_body));
        let sp = preview.spreadsheet.expect("spreadsheet grid should decode");
        assert_eq!(sp.format, "CSV");
        assert_eq!(sp.sheets.len(), 1);
        assert_eq!(sp.sheets[0].rows[1], vec!["Compute", "120.50"]);
    }

    #[test]
    fn rejects_files_outside_workspace_roots_and_detects_binary_nul() {
        let ws = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "top-secret").unwrap();

        let err = load_file_preview_state(&[ws.path().to_path_buf()], "ws-1", &secret, 1024)
            .unwrap_err()
            .to_string();
        assert!(err.contains("outside allowed workspace roots"));

        let bin = ws.path().join("blob.dat");
        fs::write(&bin, b"abc\0def").unwrap();
        let preview =
            load_file_preview_state(&[ws.path().to_path_buf()], "ws-1", &bin, 1024).unwrap();
        assert!(preview.is_binary);
        assert!(preview.content.is_none());

        // Strict single-workspace isolation: files inside an unauthorized sibling workspace fail closed.
        let sibling_preview =
            load_file_preview_state(&[outside.path().to_path_buf()], "ws-2", &bin, 1024)
                .unwrap_err()
                .to_string();
        assert!(sibling_preview.contains("outside allowed workspace roots"));
    }

    #[test]
    fn reads_authorized_preview_bytes_with_spreadsheet_kind_and_boundary_check() {
        let ws = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let sheet = ws.path().join("budget.xlsx");
        fs::write(&sheet, b"PK\x03\x04spreadsheet-bytes").unwrap();

        let root = vec![ws.path().to_path_buf()];
        let full = read_authorized_preview_bytes(&root, &sheet, 1024).unwrap();
        assert_eq!(full.kind, FilePreviewKind::Xlsx);
        assert_eq!(full.bytes, b"PK\x03\x04spreadsheet-bytes");
        assert!(!full.truncated);
        assert_eq!(full.file_size, b"PK\x03\x04spreadsheet-bytes".len() as u64);

        let capped = read_authorized_preview_bytes(&root, &sheet, 4).unwrap();
        assert_eq!(capped.bytes, b"PK\x03\x04");
        assert!(capped.truncated);
        assert_eq!(capped.file_size, full.file_size);

        let escape = outside.path().join("secret.xlsx");
        fs::write(&escape, b"nope").unwrap();
        let err = read_authorized_preview_bytes(&root, &escape, 1024)
            .unwrap_err()
            .to_string();
        assert!(err.contains("outside allowed workspace roots"));
    }
}
