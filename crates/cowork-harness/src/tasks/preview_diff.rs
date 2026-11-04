//! `ArtifactPreviewService` and `ArtifactComparisonService` for `task/artifact/version/preview`
//! and `task/artifact/version/compare`.
//!
//! Produces payloads matching `artifactPreviewSchema` and `artifactDiffSchema` (`.strict()`)
//! in `src/server/artifacts/types.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use cowork_storage::sha256_hex;
use data_encoding::BASE64;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use similar::{Algorithm, DiffOp, capture_diff_slices};

pub use crate::ooxml::{
    DocxHeading, DocxParagraph, DocxSectionText, DocxSnapshot, DocxTable, DocxTrackedChange,
    OoxmlMedia, PptxShape, PptxSlide, PptxSnapshot, SpreadsheetCellStyle, SpreadsheetChartAnchor,
    SpreadsheetChartSummary, SpreadsheetTableSummary, XlsxCell, XlsxColumnWidth, XlsxSheet,
    XlsxSnapshot,
};
use crate::ooxml::{
    extract_docx_snapshot, extract_pptx_snapshot, extract_xlsx_snapshot, open_bounded_zip,
    read_zip_text,
};

pub const MAX_ARTIFACT_DIFF_CHANGES: usize = 10_000;
pub const MAX_PREVIEW_TEXT_CHARS: usize = 1024 * 1024;
pub const MAX_INLINE_PREVIEW_BYTES: usize = 16 * 1024 * 1024;
const MAX_PDF_METADATA_SCAN_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT_DIFF_LINE_CHARS: usize = 4_096;
const MAX_TEXT_DIFF_DETAIL_CHARS: usize = 4 * 1024 * 1024;
const MAX_UNIFIED_DIFF_CHARS: usize = 4 * 1024 * 1024;
const MAX_LCS_MATRIX_CELLS: usize = 4_000_000;

#[derive(Debug, Clone)]
pub struct ArtifactBlobInput<'a> {
    pub bytes: &'a [u8],
    pub filename: &'a str,
    pub mime_type: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    Text,
    Image,
    Pdf,
    Docx,
    Pptx,
    Xlsx,
    Binary,
}

impl ArtifactKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Xlsx => "xlsx",
            Self::Binary => "binary",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBinaryMetadata {
    pub filename: String,
    pub mime_type: String,
    pub extension: Option<String>,
    pub size_bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDiffSummary {
    pub total_changes: usize,
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub moved: usize,
    pub by_category: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLineChange {
    #[serde(rename = "type")]
    pub change_type: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

pub struct ArtifactPreviewService;

impl ArtifactPreviewService {
    pub fn preview(input: &ArtifactBlobInput<'_>) -> Value {
        let metadata = binary_metadata(input);
        let kind = detect_artifact_kind(input);
        let mime_type = mime_type_for_artifact(input);
        let size_bytes = input.bytes.len();
        let sha256 = metadata.sha256.clone();

        let result: Result<Value, String> = match kind {
            ArtifactKind::Text => read_bounded_text_preview(input.bytes).map(|(text, warnings)| {
                json!({
                    "kind": "text",
                    "filename": input.filename,
                    "mimeType": mime_type,
                    "sizeBytes": size_bytes,
                    "sha256": sha256,
                    "warnings": warnings,
                    "text": text,
                    "encoding": "utf-8",
                })
            }),
            ArtifactKind::Image => {
                if size_bytes > MAX_INLINE_PREVIEW_BYTES {
                    Ok(json!({
                        "kind": "binary",
                        "filename": input.filename,
                        "mimeType": mime_type,
                        "sizeBytes": size_bytes,
                        "sha256": sha256,
                        "warnings": [format!("Image preview was not inlined because it exceeds {MAX_INLINE_PREVIEW_BYTES} bytes.")],
                        "metadata": metadata,
                    }))
                } else {
                    let img_mime =
                        detect_image_mime_type(input.bytes).unwrap_or_else(|| mime_type.clone());
                    let dims = read_image_dimensions(input.bytes, &img_mime);
                    let data_url = format!("data:{img_mime};base64,{}", BASE64.encode(input.bytes));
                    Ok(json!({
                        "kind": "image",
                        "filename": input.filename,
                        "mimeType": img_mime,
                        "sizeBytes": size_bytes,
                        "sha256": sha256,
                        "warnings": [],
                        "dataUrl": data_url,
                        "width": dims.map(|(w, _)| w),
                        "height": dims.map(|(_, h)| h),
                    }))
                }
            }
            ArtifactKind::Pdf => {
                if size_bytes > MAX_INLINE_PREVIEW_BYTES {
                    Ok(json!({
                        "kind": "binary",
                        "filename": input.filename,
                        "mimeType": mime_type,
                        "sizeBytes": size_bytes,
                        "sha256": sha256,
                        "warnings": [format!("PDF preview was not inlined because it exceeds {MAX_INLINE_PREVIEW_BYTES} bytes.")],
                        "metadata": metadata,
                    }))
                } else {
                    let data_url =
                        format!("data:application/pdf;base64,{}", BASE64.encode(input.bytes));
                    let page_count = estimate_pdf_page_count(input.bytes);
                    Ok(json!({
                        "kind": "pdf",
                        "filename": input.filename,
                        "mimeType": "application/pdf",
                        "sizeBytes": size_bytes,
                        "sha256": sha256,
                        "warnings": [],
                        "dataUrl": data_url,
                        "pageCount": page_count,
                    }))
                }
            }
            ArtifactKind::Docx => extract_docx_snapshot(input.bytes).map(|doc| {
                json!({
                    "kind": "docx",
                    "filename": input.filename,
                    "mimeType": mime_type,
                    "sizeBytes": size_bytes,
                    "sha256": sha256,
                    "warnings": [],
                    "document": doc,
                })
            }),
            ArtifactKind::Pptx => extract_pptx_snapshot(input.bytes).map(|pres| {
                json!({
                    "kind": "pptx",
                    "filename": input.filename,
                    "mimeType": mime_type,
                    "sizeBytes": size_bytes,
                    "sha256": sha256,
                    "warnings": [],
                    "presentation": pres,
                })
            }),
            ArtifactKind::Xlsx => extract_xlsx_snapshot(input.bytes).map(|wb| {
                json!({
                    "kind": "xlsx",
                    "filename": input.filename,
                    "mimeType": mime_type,
                    "sizeBytes": size_bytes,
                    "sha256": sha256,
                    "warnings": [],
                    "workbook": wb,
                })
            }),
            ArtifactKind::Binary => Ok(json!({
                "kind": "binary",
                "filename": input.filename,
                "mimeType": mime_type,
                "sizeBytes": size_bytes,
                "sha256": sha256,
                "warnings": ["No typed preview is available for this binary artifact."],
                "metadata": metadata,
            })),
        };

        result.unwrap_or_else(|err| {
            json!({
                "kind": "binary",
                "filename": input.filename,
                "mimeType": mime_type,
                "sizeBytes": size_bytes,
                "sha256": sha256,
                "warnings": [format!("The {} artifact could not be parsed safely; showing binary metadata instead: {err}", kind.as_str())],
                "metadata": metadata,
            })
        })
    }
}

pub struct ArtifactComparisonService;

impl ArtifactComparisonService {
    pub fn compare(
        before: &ArtifactBlobInput<'_>,
        after: &ArtifactBlobInput<'_>,
        max_detailed_changes: Option<usize>,
    ) -> Value {
        let before_kind = detect_artifact_kind(before);
        let after_kind = detect_artifact_kind(after);
        if before_kind != after_kind {
            return binary_diff_fallback(
                before,
                after,
                max_detailed_changes,
                vec![format!(
                    "Artifact formats differ ({} → {}); comparison is limited to binary metadata.",
                    before_kind.as_str(),
                    after_kind.as_str()
                )],
            );
        }

        let res: Result<Value, String> = (|| match before_kind {
            ArtifactKind::Text => compare_text(before.bytes, after.bytes, max_detailed_changes),
            ArtifactKind::Docx => {
                let b = extract_docx_snapshot(before.bytes)?;
                let a = extract_docx_snapshot(after.bytes)?;
                Ok(compare_docx(&b, &a, max_detailed_changes))
            }
            ArtifactKind::Pptx => {
                let b = extract_pptx_snapshot(before.bytes)?;
                let a = extract_pptx_snapshot(after.bytes)?;
                Ok(compare_pptx(&b, &a, max_detailed_changes))
            }
            ArtifactKind::Xlsx => {
                let b = extract_xlsx_snapshot(before.bytes)?;
                let a = extract_xlsx_snapshot(after.bytes)?;
                Ok(compare_xlsx(&b, &a, max_detailed_changes))
            }
            _ => Ok(binary_diff_fallback(
                before,
                after,
                max_detailed_changes,
                vec![format!(
                    "No structural comparer is available for {}; comparison is limited to binary metadata.",
                    before_kind.as_str()
                )],
            )),
        })();

        res.unwrap_or_else(|err| {
            binary_diff_fallback(
                before,
                after,
                max_detailed_changes,
                vec![format!(
                    "The {} artifact could not be parsed safely; comparison is limited to binary metadata: {err}",
                    before_kind.as_str()
                )],
            )
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum ChangeAction {
    Added,
    Removed,
    Modified,
    Moved,
}

struct ChangeCollector<T> {
    changes: Vec<T>,
    summary: ArtifactDiffSummary,
    limit: usize,
}

impl<T> ChangeCollector<T> {
    fn new(requested_limit: Option<usize>) -> Self {
        let limit = requested_limit
            .unwrap_or(MAX_ARTIFACT_DIFF_CHANGES)
            .min(MAX_ARTIFACT_DIFF_CHANGES);
        Self {
            changes: Vec::new(),
            summary: ArtifactDiffSummary {
                total_changes: 0,
                added: 0,
                removed: 0,
                modified: 0,
                moved: 0,
                by_category: BTreeMap::new(),
            },
            limit,
        }
    }

    fn add(&mut self, change: T, action: ChangeAction, categories: &[&str], include_detail: bool) {
        self.summary.total_changes += 1;
        match action {
            ChangeAction::Added => self.summary.added += 1,
            ChangeAction::Removed => self.summary.removed += 1,
            ChangeAction::Modified => self.summary.modified += 1,
            ChangeAction::Moved => self.summary.moved += 1,
        }
        for cat in categories {
            *self
                .summary
                .by_category
                .entry((*cat).to_owned())
                .or_insert(0) += 1;
        }
        if include_detail && self.changes.len() < self.limit {
            self.changes.push(change);
        }
    }

    fn truncated(&self) -> bool {
        self.summary.total_changes > self.changes.len()
    }

    fn truncation_warning(&self) -> Option<String> {
        if self.truncated() {
            Some(format!(
                "Detailed artifact changes were capped at {} of {}.",
                self.changes.len(),
                self.summary.total_changes
            ))
        } else {
            None
        }
    }
}

fn binary_diff_fallback(
    before_in: &ArtifactBlobInput<'_>,
    after_in: &ArtifactBlobInput<'_>,
    max_detailed_changes: Option<usize>,
    mut warnings: Vec<String>,
) -> Value {
    let before = binary_metadata(before_in);
    let after = binary_metadata(after_in);
    let mut collector = ChangeCollector::<Value>::new(max_detailed_changes);
    let changed = before.sha256 != after.sha256;
    if changed {
        collector.add(
            json!({
                "type": "binary_changed",
                "before": before,
                "after": after,
            }),
            ChangeAction::Modified,
            &["binary"],
            true,
        );
    }
    if let Some(w) = collector.truncation_warning() {
        warnings.push(w);
    }
    json!({
        "kind": "binary",
        "before": before,
        "after": after,
        "changed": changed,
        "summary": collector.summary,
        "changes": collector.changes,
        "truncated": collector.truncated(),
        "changeLimit": collector.limit,
        "warnings": warnings,
    })
}

fn extension_for_filename(filename: &str) -> Option<String> {
    Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))
}

fn mime_type_for_artifact(input: &ArtifactBlobInput<'_>) -> String {
    if let Some(m) = input
        .mime_type
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "application/octet-stream")
    {
        return m.to_owned();
    }
    match extension_for_filename(input.filename).as_deref() {
        Some(".docx") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_owned()
        }
        Some(".pptx") => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_owned()
        }
        Some(".xlsx") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_owned()
        }
        Some(".pdf") => "application/pdf".to_owned(),
        Some(".png") => "image/png".to_owned(),
        Some(".jpg" | ".jpeg") => "image/jpeg".to_owned(),
        Some(".gif") => "image/gif".to_owned(),
        Some(".webp") => "image/webp".to_owned(),
        Some(".svg") => "image/svg+xml".to_owned(),
        Some(".json") => "application/json".to_owned(),
        Some(".html" | ".htm") => "text/html".to_owned(),
        Some(".md" | ".markdown") => "text/markdown".to_owned(),
        Some(".csv") => "text/csv".to_owned(),
        Some(ext) if is_text_extension(ext) => "text/plain".to_owned(),
        _ => detect_image_mime_type(input.bytes)
            .unwrap_or_else(|| "application/octet-stream".to_owned()),
    }
}

fn binary_metadata(input: &ArtifactBlobInput<'_>) -> ArtifactBinaryMetadata {
    ArtifactBinaryMetadata {
        filename: input.filename.to_owned(),
        mime_type: mime_type_for_artifact(input),
        extension: extension_for_filename(input.filename),
        size_bytes: input.bytes.len(),
        sha256: sha256_hex(input.bytes),
    }
}

fn is_text_extension(ext: &str) -> bool {
    matches!(
        ext,
        ".txt"
            | ".md"
            | ".markdown"
            | ".json"
            | ".jsonl"
            | ".yaml"
            | ".yml"
            | ".toml"
            | ".xml"
            | ".html"
            | ".htm"
            | ".css"
            | ".js"
            | ".mjs"
            | ".cjs"
            | ".ts"
            | ".tsx"
            | ".jsx"
            | ".py"
            | ".rs"
            | ".go"
            | ".java"
            | ".c"
            | ".cpp"
            | ".h"
            | ".hpp"
            | ".sh"
            | ".sql"
            | ".csv"
            | ".tsv"
            | ".svg"
    )
}

fn is_image_extension(ext: &str) -> bool {
    matches!(ext, ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".bmp")
}

fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/typescript"
                | "image/svg+xml"
        )
}

fn has_zip_signature(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == 0x50
        && bytes[1] == 0x4b
        && matches!(
            (bytes[2], bytes[3]),
            (0x03, 0x04) | (0x05, 0x06) | (0x07, 0x08)
        )
}

fn has_pdf_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

fn detect_image_mime_type(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png".to_owned());
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg".to_owned());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif".to_owned());
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp".to_owned());
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp".to_owned());
    }
    None
}

fn detect_artifact_kind(input: &ArtifactBlobInput<'_>) -> ArtifactKind {
    let ext = extension_for_filename(input.filename);
    let mime = mime_type_for_artifact(input);
    if ext.as_deref() == Some(".docx") || mime.contains("wordprocessingml") {
        return ArtifactKind::Docx;
    }
    if ext.as_deref() == Some(".pptx") || mime.contains("presentationml") {
        return ArtifactKind::Pptx;
    }
    if ext.as_deref() == Some(".xlsx") || mime.contains("spreadsheetml") {
        return ArtifactKind::Xlsx;
    }
    if ext.as_deref() == Some(".pdf") || mime == "application/pdf" {
        return ArtifactKind::Pdf;
    }
    if ext.as_deref().is_some_and(is_image_extension) || mime.starts_with("image/") {
        return ArtifactKind::Image;
    }
    if ext.as_deref().is_some_and(is_text_extension) || is_text_mime(&mime) {
        return ArtifactKind::Text;
    }

    if has_pdf_signature(input.bytes) {
        return ArtifactKind::Pdf;
    }
    if detect_image_mime_type(input.bytes).is_some() {
        return ArtifactKind::Image;
    }
    if has_zip_signature(input.bytes)
        && let Ok(mut archive) = open_bounded_zip(input.bytes)
        && let Ok(ct) = read_zip_text(&mut archive, "[Content_Types].xml")
    {
        if ct.contains("wordprocessingml.document") {
            return ArtifactKind::Docx;
        }
        if ct.contains("presentationml.presentation") {
            return ArtifactKind::Pptx;
        }
        if ct.contains("spreadsheetml.sheet") {
            return ArtifactKind::Xlsx;
        }
    }
    if looks_like_utf8_text(input.bytes) {
        return ArtifactKind::Text;
    }
    ArtifactKind::Binary
}

fn looks_like_utf8_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let head = &bytes[..bytes.len().min(8_192)];
    if head.contains(&0) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

fn decode_utf8(bytes: &[u8]) -> Result<String, String> {
    let s = std::str::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8 text: {e}"))?;
    Ok(s.strip_prefix('\u{feff}').unwrap_or(s).to_owned())
}

fn read_bounded_text_preview(bytes: &[u8]) -> Result<(String, Vec<String>), String> {
    let scan_limit = bytes.len().min(MAX_PREVIEW_TEXT_CHARS * 4 + 4);
    let mut decoded: Option<String> = None;
    let mut consumed = scan_limit;
    for trim in 0..=4usize {
        if scan_limit < trim {
            break;
        }
        if let Ok(s) = decode_utf8(&bytes[..scan_limit - trim]) {
            decoded = Some(s);
            consumed = scan_limit - trim;
            break;
        }
    }
    let full = match decoded {
        Some(s) => s,
        None => decode_utf8(bytes)?,
    };
    let char_count = full.chars().count();
    let truncated = char_count > MAX_PREVIEW_TEXT_CHARS || consumed < bytes.len();
    let text: String = full.chars().take(MAX_PREVIEW_TEXT_CHARS).collect();
    let warnings = if truncated {
        vec![format!(
            "Text preview was capped at {MAX_PREVIEW_TEXT_CHARS} characters."
        )]
    } else {
        Vec::new()
    };
    Ok((text, warnings))
}

fn estimate_pdf_page_count(bytes: &[u8]) -> Option<usize> {
    if bytes.len() > MAX_PDF_METADATA_SCAN_BYTES {
        return None;
    }
    static PAGE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = PAGE_RE.get_or_init(|| Regex::new(r"/Type\s*/Page\b").expect("valid pdf regex"));
    static PAGES_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let pages_re =
        PAGES_RE.get_or_init(|| Regex::new(r"/Type\s*/Pages\b").expect("valid pdf pages regex"));
    let content: String = bytes.iter().map(|&b| b as char).collect();
    let total = re.find_iter(&content).count();
    let pages = pages_re.find_iter(&content).count();
    let count = total.saturating_sub(pages);
    if count > 0 { Some(count) } else { None }
}

fn read_image_dimensions(bytes: &[u8], mime_type: &str) -> Option<(u32, u32)> {
    if mime_type == "image/png" && bytes.len() >= 24 {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some((w, h));
    }
    if mime_type == "image/gif" && bytes.len() >= 10 {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return Some((w, h));
    }
    if mime_type == "image/jpeg" {
        let mut offset = 2usize;
        while offset + 8 < bytes.len() {
            if bytes[offset] != 0xff {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            if marker == 0xd8 || marker == 0xd9 {
                offset += 2;
                continue;
            }
            let len = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
            if len < 2 || offset + 2 + len > bytes.len() {
                return None;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                let h = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]) as u32;
                return Some((w, h));
            }
            offset += len + 2;
        }
    }
    None
}

// ============================================================================
// Text diffing via `similar` (matches `diffUtils.ts`)
// ============================================================================

#[derive(Debug, Clone)]
enum SeqOp {
    Equal(String),
    Delete { val: String, old_idx: usize },
    Insert { val: String, new_idx: usize },
}

fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(str::to_owned)
        .collect()
}

fn sequence_diff(before: &[String], after: &[String]) -> Vec<SeqOp> {
    if (before.len() + 1).saturating_mul(after.len() + 1) > MAX_LCS_MATRIX_CELLS {
        return coarse_sequence_diff(before, after);
    }
    let ops = capture_diff_slices(Algorithm::Myers, before, after);
    let mut seq = Vec::new();
    for op in ops {
        match op {
            DiffOp::Equal { old_index, len, .. } => {
                for item in &before[old_index..old_index + len] {
                    seq.push(SeqOp::Equal(item.clone()));
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                for offset in 0..old_len {
                    let i = old_index + offset;
                    seq.push(SeqOp::Delete {
                        val: before[i].clone(),
                        old_idx: i,
                    });
                }
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for offset in 0..new_len {
                    let i = new_index + offset;
                    seq.push(SeqOp::Insert {
                        val: after[i].clone(),
                        new_idx: i,
                    });
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                for offset in 0..old_len {
                    let i = old_index + offset;
                    seq.push(SeqOp::Delete {
                        val: before[i].clone(),
                        old_idx: i,
                    });
                }
                for offset in 0..new_len {
                    let i = new_index + offset;
                    seq.push(SeqOp::Insert {
                        val: after[i].clone(),
                        new_idx: i,
                    });
                }
            }
        }
    }
    seq
}

fn coarse_sequence_diff(before: &[String], after: &[String]) -> Vec<SeqOp> {
    let mut prefix = 0usize;
    while prefix < before.len() && prefix < after.len() && before[prefix] == after[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < before.len() - prefix
        && suffix < after.len() - prefix
        && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mut ops = Vec::new();
    for item in before.iter().take(prefix) {
        ops.push(SeqOp::Equal(item.clone()));
    }
    for (i, item) in before
        .iter()
        .enumerate()
        .take(before.len() - suffix)
        .skip(prefix)
    {
        ops.push(SeqOp::Delete {
            val: item.clone(),
            old_idx: i,
        });
    }
    for (i, item) in after
        .iter()
        .enumerate()
        .take(after.len() - suffix)
        .skip(prefix)
    {
        ops.push(SeqOp::Insert {
            val: item.clone(),
            new_idx: i,
        });
    }
    for offset in (0..suffix).rev() {
        ops.push(SeqOp::Equal(before[before.len() - 1 - offset].clone()));
    }
    ops
}

fn clip_diff_line(val: &str) -> (String, bool) {
    let count = val.chars().count();
    if count <= MAX_TEXT_DIFF_LINE_CHARS {
        return (val.to_owned(), false);
    }
    let prefix: String = val.chars().take(MAX_TEXT_DIFF_LINE_CHARS - 22).collect();
    (format!("{prefix}... [line truncated]"), true)
}

fn render_unified_diff(ops: &[SeqOp], change_limit: usize) -> (String, bool) {
    let changed_indices: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter_map(|(idx, op)| (!matches!(op, SeqOp::Equal(_))).then_some(idx))
        .take(change_limit)
        .collect();
    if changed_indices.is_empty() {
        return (String::new(), false);
    }
    let context = 3usize;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for idx in changed_indices {
        let start = idx.saturating_sub(context);
        let end = (idx + context + 1).min(ops.len());
        if let Some(last) = ranges.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
        } else {
            ranges.push((start, end));
        }
    }

    let mut lines = vec!["--- before".to_owned(), "+++ after".to_owned()];
    for (start, end) in ranges {
        let prefix = &ops[..start];
        let hunk = &ops[start..end];
        let old_start = 1 + prefix
            .iter()
            .filter(|op| !matches!(op, SeqOp::Insert { .. }))
            .count();
        let new_start = 1 + prefix
            .iter()
            .filter(|op| !matches!(op, SeqOp::Delete { .. }))
            .count();
        let old_count = hunk
            .iter()
            .filter(|op| !matches!(op, SeqOp::Insert { .. }))
            .count();
        let new_count = hunk
            .iter()
            .filter(|op| !matches!(op, SeqOp::Delete { .. }))
            .count();
        lines.push(format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@"
        ));
        for op in hunk {
            match op {
                SeqOp::Equal(v) => lines.push(format!(" {}", clip_diff_line(v).0)),
                SeqOp::Delete { val, .. } => lines.push(format!("-{}", clip_diff_line(val).0)),
                SeqOp::Insert { val, .. } => lines.push(format!("+{}", clip_diff_line(val).0)),
            }
        }
    }
    let out = lines.join("\n");
    if out.len() <= MAX_UNIFIED_DIFF_CHARS {
        (out, false)
    } else {
        let mut cut = MAX_UNIFIED_DIFF_CHARS - 24;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        (format!("{}\n... [diff truncated]", &out[..cut]), true)
    }
}

fn compare_text(
    before_bytes: &[u8],
    after_bytes: &[u8],
    max_detailed_changes: Option<usize>,
) -> Result<Value, String> {
    let before_text = decode_utf8(before_bytes)?;
    let after_text = decode_utf8(after_bytes)?;
    let before_lines = split_lines(&before_text);
    let after_lines = split_lines(&after_text);
    let ops = sequence_diff(&before_lines, &after_lines);

    let mut collector = ChangeCollector::<TextLineChange>::new(max_detailed_changes);
    let mut detail_chars = 0usize;
    let mut line_content_truncated = false;
    let mut detail_payload_truncated = false;

    for op in &ops {
        match op {
            SeqOp::Delete { val, old_idx } => {
                let (clipped, trunc) = clip_diff_line(val);
                line_content_truncated |= trunc;
                let within_count = collector.changes.len() < collector.limit;
                let within_chars = detail_chars + clipped.len() <= MAX_TEXT_DIFF_DETAIL_CHARS;
                let include = within_count && within_chars;
                if include {
                    detail_chars += clipped.len();
                } else if !within_chars {
                    detail_payload_truncated = true;
                }
                collector.add(
                    TextLineChange {
                        change_type: "line_removed".to_owned(),
                        old_line: Some(old_idx + 1),
                        new_line: None,
                        text: clipped,
                    },
                    ChangeAction::Removed,
                    &["line"],
                    include,
                );
            }
            SeqOp::Insert { val, new_idx } => {
                let (clipped, trunc) = clip_diff_line(val);
                line_content_truncated |= trunc;
                let within_count = collector.changes.len() < collector.limit;
                let within_chars = detail_chars + clipped.len() <= MAX_TEXT_DIFF_DETAIL_CHARS;
                let include = within_count && within_chars;
                if include {
                    detail_chars += clipped.len();
                } else if !within_chars {
                    detail_payload_truncated = true;
                }
                collector.add(
                    TextLineChange {
                        change_type: "line_added".to_owned(),
                        old_line: None,
                        new_line: Some(new_idx + 1),
                        text: clipped,
                    },
                    ChangeAction::Added,
                    &["line"],
                    include,
                );
            }
            SeqOp::Equal(_) => {}
        }
    }

    let (unified_diff, unified_trunc) = render_unified_diff(&ops, collector.limit);
    let mut warnings = Vec::new();
    if line_content_truncated {
        warnings.push(format!(
            "Individual diff lines were capped at {MAX_TEXT_DIFF_LINE_CHARS} characters."
        ));
    }
    if detail_payload_truncated {
        warnings.push(format!(
            "Detailed text changes were capped at {MAX_TEXT_DIFF_DETAIL_CHARS} characters."
        ));
    }
    if unified_trunc {
        warnings.push(format!(
            "Unified diff output was capped at {MAX_UNIFIED_DIFF_CHARS} characters."
        ));
    }
    let content_truncated = !warnings.is_empty();
    if let Some(w) = collector.truncation_warning() {
        warnings.push(w);
    }

    Ok(json!({
        "kind": "text",
        "unifiedDiff": unified_diff,
        "summary": collector.summary,
        "changes": collector.changes,
        "truncated": collector.truncated() || content_truncated,
        "changeLimit": collector.limit,
        "warnings": warnings,
    }))
}

// ============================================================================
// Structural OOXML Comparisons (`.docx`, `.pptx`, `.xlsx`)
// ============================================================================

fn compare_docx(
    before: &DocxSnapshot,
    after: &DocxSnapshot,
    requested_limit: Option<usize>,
) -> Value {
    let mut collector = ChangeCollector::<Value>::new(requested_limit);

    compare_indexed_slice(
        &before.paragraphs,
        &after.paragraphs,
        "paragraph",
        &mut collector,
    );
    compare_indexed_slice(&before.headings, &after.headings, "heading", &mut collector);
    compare_indexed_slice(&before.tables, &after.tables, "table", &mut collector);
    compare_docx_sections(&before.headers, &after.headers, "header", &mut collector);
    compare_docx_sections(&before.footers, &after.footers, "footer", &mut collector);
    compare_tracked_changes(
        &before.tracked_changes,
        &after.tracked_changes,
        &mut collector,
    );
    compare_media(&before.media, &after.media, &mut collector);

    let warnings = collector
        .truncation_warning()
        .into_iter()
        .collect::<Vec<_>>();
    json!({
        "kind": "docx",
        "summary": collector.summary,
        "changes": collector.changes,
        "truncated": collector.truncated(),
        "changeLimit": collector.limit,
        "warnings": warnings,
    })
}

fn compare_indexed_slice<T: PartialEq + Serialize>(
    before: &[T],
    after: &[T],
    category: &str,
    collector: &mut ChangeCollector<Value>,
) {
    let len = before.len().max(after.len());
    for i in 0..len {
        match (before.get(i), after.get(i)) {
            (None, Some(right)) => collector.add(
                json!({
                    "type": format!("{category}_added"),
                    "index": i,
                    "before": null,
                    "after": right,
                }),
                ChangeAction::Added,
                &[category],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({
                    "type": format!("{category}_removed"),
                    "index": i,
                    "before": left,
                    "after": null,
                }),
                ChangeAction::Removed,
                &[category],
                true,
            ),
            (Some(left), Some(right)) if left != right => collector.add(
                json!({
                    "type": format!("{category}_changed"),
                    "index": i,
                    "before": left,
                    "after": right,
                }),
                ChangeAction::Modified,
                &[category],
                true,
            ),
            _ => {}
        }
    }
}

fn compare_docx_sections(
    before: &[DocxSectionText],
    after: &[DocxSectionText],
    category: &str,
    collector: &mut ChangeCollector<Value>,
) {
    let before_map: BTreeMap<&str, &DocxSectionText> =
        before.iter().map(|s| (s.part.as_str(), s)).collect();
    let after_map: BTreeMap<&str, &DocxSectionText> =
        after.iter().map(|s| (s.part.as_str(), s)).collect();
    let mut keys: Vec<&str> = Vec::new();
    let mut seen = BTreeSet::new();
    for s in before {
        if seen.insert(s.part.as_str()) {
            keys.push(s.part.as_str());
        }
    }
    for s in after {
        if seen.insert(s.part.as_str()) {
            keys.push(s.part.as_str());
        }
    }
    for part in keys {
        match (before_map.get(part), after_map.get(part)) {
            (None, Some(right)) => collector.add(
                json!({
                    "type": format!("{category}_added"),
                    "part": part,
                    "before": null,
                    "after": right,
                }),
                ChangeAction::Added,
                &[category],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({
                    "type": format!("{category}_removed"),
                    "part": part,
                    "before": left,
                    "after": null,
                }),
                ChangeAction::Removed,
                &[category],
                true,
            ),
            (Some(left), Some(right)) if left.text != right.text => collector.add(
                json!({
                    "type": format!("{category}_changed"),
                    "part": part,
                    "before": left,
                    "after": right,
                }),
                ChangeAction::Modified,
                &[category],
                true,
            ),
            _ => {}
        }
    }
}

fn compare_tracked_changes(
    before: &[DocxTrackedChange],
    after: &[DocxTrackedChange],
    collector: &mut ChangeCollector<Value>,
) {
    let mut before_counts: Vec<(String, &DocxTrackedChange, usize)> = Vec::new();
    for item in before {
        let key = serde_json::to_string(item).unwrap_or_default();
        if let Some(entry) = before_counts.iter_mut().find(|(k, _, _)| k == &key) {
            entry.2 += 1;
        } else {
            before_counts.push((key, item, 1));
        }
    }
    let mut after_counts: BTreeMap<String, (&DocxTrackedChange, usize)> = BTreeMap::new();
    let mut ordered_keys: Vec<String> = before_counts.iter().map(|(k, _, _)| k.clone()).collect();
    for item in after {
        let key = serde_json::to_string(item).unwrap_or_default();
        if !after_counts.contains_key(&key) && !ordered_keys.contains(&key) {
            ordered_keys.push(key.clone());
        }
        after_counts
            .entry(key)
            .and_modify(|(_, c)| *c += 1)
            .or_insert((item, 1));
    }
    let before_map: BTreeMap<String, (&DocxTrackedChange, usize)> = before_counts
        .into_iter()
        .map(|(k, v, c)| (k, (v, c)))
        .collect();

    for key in ordered_keys {
        let left = before_map.get(&key);
        let right = after_counts.get(&key);
        let l_count = left.map_or(0, |(_, c)| *c);
        let r_count = right.map_or(0, |(_, c)| *c);
        if l_count > r_count {
            let val = left.unwrap().0;
            for _ in 0..(l_count - r_count) {
                collector.add(
                    json!({
                        "type": "tracked_change_removed",
                        "change": val,
                    }),
                    ChangeAction::Removed,
                    &["tracked_change"],
                    true,
                );
            }
        }
        if r_count > l_count {
            let val = right.unwrap().0;
            for _ in 0..(r_count - l_count) {
                collector.add(
                    json!({
                        "type": "tracked_change_added",
                        "change": val,
                    }),
                    ChangeAction::Added,
                    &["tracked_change"],
                    true,
                );
            }
        }
    }
}

fn compare_media(
    before: &[OoxmlMedia],
    after: &[OoxmlMedia],
    collector: &mut ChangeCollector<Value>,
) {
    let before_map: BTreeMap<&str, &OoxmlMedia> =
        before.iter().map(|m| (m.path.as_str(), m)).collect();
    let after_map: BTreeMap<&str, &OoxmlMedia> =
        after.iter().map(|m| (m.path.as_str(), m)).collect();
    let mut keys: Vec<&str> = Vec::new();
    let mut seen = BTreeSet::new();
    for m in before {
        if seen.insert(m.path.as_str()) {
            keys.push(m.path.as_str());
        }
    }
    for m in after {
        if seen.insert(m.path.as_str()) {
            keys.push(m.path.as_str());
        }
    }
    for path in keys {
        match (before_map.get(path), after_map.get(path)) {
            (None, Some(right)) => collector.add(
                json!({
                    "type": "media_added",
                    "path": path,
                    "before": null,
                    "after": right,
                }),
                ChangeAction::Added,
                &["media"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({
                    "type": "media_removed",
                    "path": path,
                    "before": left,
                    "after": null,
                }),
                ChangeAction::Removed,
                &["media"],
                true,
            ),
            (Some(left), Some(right)) if left.sha256 != right.sha256 => collector.add(
                json!({
                    "type": "media_changed",
                    "path": path,
                    "before": left,
                    "after": right,
                }),
                ChangeAction::Modified,
                &["media"],
                true,
            ),
            _ => {}
        }
    }
}

fn compare_pptx(
    before: &PptxSnapshot,
    after: &PptxSnapshot,
    requested_limit: Option<usize>,
) -> Value {
    let mut collector = ChangeCollector::<Value>::new(requested_limit);
    let before_by_id: BTreeMap<&str, &PptxSlide> =
        before.slides.iter().map(|s| (s.id.as_str(), s)).collect();
    let after_by_id: BTreeMap<&str, &PptxSlide> =
        after.slides.iter().map(|s| (s.id.as_str(), s)).collect();

    let mut ordered_ids: Vec<&str> = Vec::new();
    let mut seen = BTreeSet::new();
    for s in &before.slides {
        if seen.insert(s.id.as_str()) {
            ordered_ids.push(s.id.as_str());
        }
    }
    for s in &after.slides {
        if seen.insert(s.id.as_str()) {
            ordered_ids.push(s.id.as_str());
        }
    }

    for id in ordered_ids {
        match (before_by_id.get(id), after_by_id.get(id)) {
            (None, Some(right)) => collector.add(
                json!({ "type": "slide_added", "slideId": id, "index": right.index, "slide": right }),
                ChangeAction::Added,
                &["slide"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({ "type": "slide_removed", "slideId": id, "index": left.index, "slide": left }),
                ChangeAction::Removed,
                &["slide"],
                true,
            ),
            (Some(left), Some(right)) => {
                if left.index != right.index {
                    collector.add(
                        json!({
                            "type": "slide_moved",
                            "slideId": id,
                            "beforeIndex": left.index,
                            "afterIndex": right.index,
                        }),
                        ChangeAction::Moved,
                        &["slide"],
                        true,
                    );
                }
                if left.fingerprint != right.fingerprint {
                    let mut fields = Vec::new();
                    if left.text != right.text {
                        fields.push("text");
                    }
                    if left.notes != right.notes {
                        fields.push("notes");
                    }
                    if left.shapes != right.shapes {
                        fields.push("shapes");
                    }
                    if !same_slide_media(&left.media, &right.media) {
                        fields.push("media");
                    }
                    let mut cats = vec!["slide"];
                    cats.extend(fields.iter().copied());
                    collector.add(
                        json!({
                            "type": "slide_changed",
                            "slideId": id,
                            "index": right.index,
                            "changedFields": fields,
                            "before": left,
                            "after": right,
                        }),
                        ChangeAction::Modified,
                        &cats,
                        true,
                    );
                }
            }
            (None, None) => {}
        }
    }

    compare_media(&before.media, &after.media, &mut collector);

    let warnings = collector
        .truncation_warning()
        .into_iter()
        .collect::<Vec<_>>();
    json!({
        "kind": "pptx",
        "summary": collector.summary,
        "changes": collector.changes,
        "truncated": collector.truncated(),
        "changeLimit": collector.limit,
        "warnings": warnings,
    })
}

fn same_slide_media(left: &[OoxmlMedia], right: &[OoxmlMedia]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(l, r)| l.path == r.path && l.sha256 == r.sha256)
}

fn compare_xlsx(
    before: &XlsxSnapshot,
    after: &XlsxSnapshot,
    requested_limit: Option<usize>,
) -> Value {
    let mut collector = ChangeCollector::<Value>::new(requested_limit);
    let before_by_name: BTreeMap<&str, &XlsxSheet> =
        before.sheets.iter().map(|s| (s.name.as_str(), s)).collect();
    let after_by_name: BTreeMap<&str, &XlsxSheet> =
        after.sheets.iter().map(|s| (s.name.as_str(), s)).collect();

    let mut ordered_names: Vec<&str> = Vec::new();
    let mut seen = BTreeSet::new();
    for s in &before.sheets {
        if seen.insert(s.name.as_str()) {
            ordered_names.push(s.name.as_str());
        }
    }
    for s in &after.sheets {
        if seen.insert(s.name.as_str()) {
            ordered_names.push(s.name.as_str());
        }
    }

    for sheet_name in ordered_names {
        match (
            before_by_name.get(sheet_name),
            after_by_name.get(sheet_name),
        ) {
            (None, Some(right)) => collector.add(
                json!({ "type": "sheet_added", "sheetName": sheet_name, "index": right.index }),
                ChangeAction::Added,
                &["sheet"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({ "type": "sheet_removed", "sheetName": sheet_name, "index": left.index }),
                ChangeAction::Removed,
                &["sheet"],
                true,
            ),
            (Some(left), Some(right)) => {
                if left.index != right.index {
                    collector.add(
                        json!({
                            "type": "sheet_moved",
                            "sheetName": sheet_name,
                            "beforeIndex": left.index,
                            "afterIndex": right.index,
                        }),
                        ChangeAction::Moved,
                        &["sheet"],
                        true,
                    );
                }
                compare_xlsx_sheet(left, right, &mut collector);
            }
            (None, None) => {}
        }
    }

    let warnings = collector
        .truncation_warning()
        .into_iter()
        .collect::<Vec<_>>();
    json!({
        "kind": "xlsx",
        "summary": collector.summary,
        "changes": collector.changes,
        "truncated": collector.truncated(),
        "changeLimit": collector.limit,
        "warnings": warnings,
    })
}

fn compare_xlsx_sheet(
    before: &XlsxSheet,
    after: &XlsxSheet,
    collector: &mut ChangeCollector<Value>,
) {
    let sheet_name = before.name.as_str();

    // 1. Cells
    let l_cells: BTreeMap<&str, &XlsxCell> = before
        .cells
        .iter()
        .map(|c| (c.address.as_str(), c))
        .collect();
    let r_cells: BTreeMap<&str, &XlsxCell> = after
        .cells
        .iter()
        .map(|c| (c.address.as_str(), c))
        .collect();
    let mut addrs: Vec<&str> = Vec::new();
    let mut seen_addrs = BTreeSet::new();
    for c in &before.cells {
        if seen_addrs.insert(c.address.as_str()) {
            addrs.push(c.address.as_str());
        }
    }
    for c in &after.cells {
        if seen_addrs.insert(c.address.as_str()) {
            addrs.push(c.address.as_str());
        }
    }

    for addr in addrs {
        match (l_cells.get(addr), r_cells.get(addr)) {
            (None, Some(rc)) => {
                let mut fields = vec!["value"];
                if rc.formula.is_some() {
                    fields.push("formula");
                }
                if rc.style.is_some() {
                    fields.push("style");
                }
                let mut cats = vec!["cell"];
                cats.extend(fields.iter().copied());
                collector.add(
                    json!({
                        "type": "cell_added",
                        "sheetName": sheet_name,
                        "address": addr,
                        "changedFields": fields,
                        "before": null,
                        "after": rc,
                    }),
                    ChangeAction::Added,
                    &cats,
                    true,
                );
            }
            (Some(lc), None) => {
                let mut fields = vec!["value"];
                if lc.formula.is_some() {
                    fields.push("formula");
                }
                if lc.style.is_some() {
                    fields.push("style");
                }
                let mut cats = vec!["cell"];
                cats.extend(fields.iter().copied());
                collector.add(
                    json!({
                        "type": "cell_removed",
                        "sheetName": sheet_name,
                        "address": addr,
                        "changedFields": fields,
                        "before": lc,
                        "after": null,
                    }),
                    ChangeAction::Removed,
                    &cats,
                    true,
                );
            }
            (Some(lc), Some(rc)) if lc != rc => {
                let mut fields = Vec::new();
                if lc.value != rc.value {
                    fields.push("value");
                }
                if lc.formula != rc.formula {
                    fields.push("formula");
                }
                if lc.style != rc.style {
                    fields.push("style");
                }
                if !fields.is_empty() {
                    let mut cats = vec!["cell"];
                    cats.extend(fields.iter().copied());
                    collector.add(
                        json!({
                            "type": "cell_changed",
                            "sheetName": sheet_name,
                            "address": addr,
                            "changedFields": fields,
                            "before": lc,
                            "after": rc,
                        }),
                        ChangeAction::Modified,
                        &cats,
                        true,
                    );
                }
            }
            _ => {}
        }
    }

    // 2. Merges
    let before_merges: BTreeSet<&str> = before.merges.iter().map(String::as_str).collect();
    let after_merges: BTreeSet<&str> = after.merges.iter().map(String::as_str).collect();
    for m in &before.merges {
        if !after_merges.contains(m.as_str()) {
            collector.add(
                json!({ "type": "merge_removed", "sheetName": sheet_name, "ref": m }),
                ChangeAction::Removed,
                &["merge"],
                true,
            );
        }
    }
    for m in &after.merges {
        if !before_merges.contains(m.as_str()) {
            collector.add(
                json!({ "type": "merge_added", "sheetName": sheet_name, "ref": m }),
                ChangeAction::Added,
                &["merge"],
                true,
            );
        }
    }

    // 3. Column widths
    let before_cw: BTreeMap<usize, &XlsxColumnWidth> = before
        .column_widths
        .iter()
        .map(|cw| (cw.column, cw))
        .collect();
    let after_cw: BTreeMap<usize, &XlsxColumnWidth> = after
        .column_widths
        .iter()
        .map(|cw| (cw.column, cw))
        .collect();
    let mut cw_cols: Vec<usize> = Vec::new();
    let mut seen_cw = BTreeSet::new();
    for cw in &before.column_widths {
        if seen_cw.insert(cw.column) {
            cw_cols.push(cw.column);
        }
    }
    for cw in &after.column_widths {
        if seen_cw.insert(cw.column) {
            cw_cols.push(cw.column);
        }
    }
    for col in cw_cols {
        match (before_cw.get(&col), after_cw.get(&col)) {
            (None, Some(right)) => collector.add(
                json!({
                    "type": "column_width_added",
                    "sheetName": sheet_name,
                    "column": col,
                    "before": null,
                    "after": right,
                }),
                ChangeAction::Added,
                &["column_width"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({
                    "type": "column_width_removed",
                    "sheetName": sheet_name,
                    "column": col,
                    "before": left,
                    "after": null,
                }),
                ChangeAction::Removed,
                &["column_width"],
                true,
            ),
            (Some(left), Some(right)) if left != right => collector.add(
                json!({
                    "type": "column_width_changed",
                    "sheetName": sheet_name,
                    "column": col,
                    "before": left,
                    "after": right,
                }),
                ChangeAction::Modified,
                &["column_width"],
                true,
            ),
            _ => {}
        }
    }

    // 4. Tables
    compare_named_objects(
        &before.tables,
        &after.tables,
        |t| t.name.as_str(),
        |name, l, r, action_str| {
            json!({
                "type": format!("table_{action_str}"),
                "sheetName": sheet_name,
                "name": name,
                "before": l,
                "after": r,
            })
        },
        "table",
        collector,
    );

    // 5. Charts
    compare_named_objects(
        &before.charts,
        &after.charts,
        |c| c.id.as_str(),
        |id, l, r, action_str| {
            json!({
                "type": format!("chart_{action_str}"),
                "sheetName": sheet_name,
                "id": id,
                "before": l,
                "after": r,
            })
        },
        "chart",
        collector,
    );
}

fn compare_named_objects<'a, T: PartialEq + Serialize>(
    before: &'a [T],
    after: &'a [T],
    get_id: impl Fn(&'a T) -> &'a str,
    build: impl Fn(&str, Option<&T>, Option<&T>, &str) -> Value,
    category: &str,
    collector: &mut ChangeCollector<Value>,
) {
    let before_map: BTreeMap<&str, &T> = before.iter().map(|v| (get_id(v), v)).collect();
    let after_map: BTreeMap<&str, &T> = after.iter().map(|v| (get_id(v), v)).collect();
    let mut keys: Vec<&str> = Vec::new();
    let mut seen = BTreeSet::new();
    for v in before {
        let k = get_id(v);
        if seen.insert(k) {
            keys.push(k);
        }
    }
    for v in after {
        let k = get_id(v);
        if seen.insert(k) {
            keys.push(k);
        }
    }
    for key in keys {
        match (before_map.get(key), after_map.get(key)) {
            (None, Some(right)) => collector.add(
                build(key, None, Some(right), "added"),
                ChangeAction::Added,
                &[category],
                true,
            ),
            (Some(left), None) => collector.add(
                build(key, Some(left), None, "removed"),
                ChangeAction::Removed,
                &[category],
                true,
            ),
            (Some(left), Some(right)) if left != right => collector.add(
                build(key, Some(left), Some(right), "changed"),
                ChangeAction::Modified,
                &[category],
                true,
            ),
            _ => {}
        }
    }
}
