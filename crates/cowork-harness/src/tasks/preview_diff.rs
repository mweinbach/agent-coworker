//! `ArtifactPreviewService` and `ArtifactComparisonService` for `task/artifact/version/preview`
//! and `task/artifact/version/compare`.
//!
//! Produces payloads matching `artifactPreviewSchema` and `artifactDiffSchema` (`.strict()`)
//! in `src/server/artifacts/types.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};
use std::path::Path;

use cowork_storage::sha256_hex;
use data_encoding::BASE64;
use quick_xml::Reader;
use quick_xml::events::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zip::ZipArchive;

pub const MAX_ARTIFACT_DIFF_CHANGES: usize = 10_000;
pub const MAX_PREVIEW_TEXT_CHARS: usize = 1024 * 1024;
pub const MAX_INLINE_PREVIEW_BYTES: usize = 16 * 1024 * 1024;
const MAX_PDF_METADATA_SCAN_BYTES: usize = 16 * 1024 * 1024;
const MAX_OOXML_COMPRESSED_BYTES: usize = 100 * 1024 * 1024;
const MAX_OOXML_ENTRIES: usize = 10_000;
const MAX_OOXML_ENTRY_BYTES: usize = 64 * 1024 * 1024;
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
pub struct OoxmlMedia {
    pub path: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxParagraph {
    pub index: usize,
    pub text: String,
    pub style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxHeading {
    pub index: usize,
    pub text: String,
    pub style: Option<String>,
    pub level: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxTable {
    pub index: usize,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxSectionText {
    pub part: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxTrackedChange {
    #[serde(rename = "type")]
    pub change_type: String,
    pub id: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxSnapshot {
    pub paragraphs: Vec<DocxParagraph>,
    pub headings: Vec<DocxHeading>,
    pub tables: Vec<DocxTable>,
    pub headers: Vec<DocxSectionText>,
    pub footers: Vec<DocxSectionText>,
    pub tracked_changes: Vec<DocxTrackedChange>,
    pub media: Vec<OoxmlMedia>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxShape {
    #[serde(rename = "type")]
    pub shape_type: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub text: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxSlide {
    pub id: String,
    pub part: String,
    pub index: usize,
    pub text: String,
    pub notes: String,
    pub shapes: Vec<PptxShape>,
    pub media: Vec<OoxmlMedia>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxSnapshot {
    pub slides: Vec<PptxSlide>,
    pub media: Vec<OoxmlMedia>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxCell {
    pub address: String,
    pub value: Value,
    pub formula: Option<String>,
    pub style: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxColumnWidth {
    pub column: usize,
    pub width_chars: Option<f64>,
    pub width_pixels: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSheet {
    pub name: String,
    pub index: usize,
    pub hidden: bool,
    pub cells: Vec<XlsxCell>,
    pub merges: Vec<String>,
    pub column_widths: Vec<XlsxColumnWidth>,
    pub tables: Vec<Value>,
    pub charts: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSnapshot {
    pub sheets: Vec<XlsxSheet>,
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
        .filter(|s| !s.is_empty())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))
}

fn mime_type_for_artifact(input: &ArtifactBlobInput<'_>) -> String {
    if let Some(m) = input.mime_type.map(str::trim).filter(|s| !s.is_empty()) {
        return m.to_ascii_lowercase();
    }
    match extension_for_filename(input.filename).as_deref() {
        Some(".bmp") => "image/bmp",
        Some(".csv") => "text/csv",
        Some(".docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some(".gif") => "image/gif",
        Some(".jpeg" | ".jpg") => "image/jpeg",
        Some(".json") => "application/json",
        Some(".md") => "text/markdown",
        Some(".pdf") => "application/pdf",
        Some(".png") => "image/png",
        Some(".pptx") => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
        Some(".svg") => "image/svg+xml",
        Some(".txt") => "text/plain",
        Some(".webp") => "image/webp",
        Some(".xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some(".xml") => "application/xml",
        _ => "application/octet-stream",
    }
    .to_owned()
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
        ".c" | ".cc"
            | ".conf"
            | ".cpp"
            | ".css"
            | ".csv"
            | ".go"
            | ".h"
            | ".html"
            | ".ini"
            | ".java"
            | ".js"
            | ".json"
            | ".jsx"
            | ".log"
            | ".md"
            | ".mjs"
            | ".py"
            | ".rb"
            | ".rs"
            | ".sh"
            | ".sql"
            | ".svg"
            | ".toml"
            | ".ts"
            | ".tsx"
            | ".txt"
            | ".xml"
            | ".yaml"
            | ".yml"
    )
}

fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext,
        ".bmp" | ".gif" | ".jpeg" | ".jpg" | ".png" | ".svg" | ".webp"
    )
}

fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime == "application/json"
        || mime == "application/xml"
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
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
// Text diffing (matches `diffUtils.ts`)
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
    let width = after.len() + 1;
    let mut matrix = vec![0u32; (before.len() + 1) * width];
    for left in (0..before.len()).rev() {
        for right in (0..after.len()).rev() {
            let idx = left * width + right;
            matrix[idx] = if before[left] == after[right] {
                1 + matrix[(left + 1) * width + right + 1]
            } else {
                matrix[(left + 1) * width + right].max(matrix[left * width + right + 1])
            };
        }
    }
    let mut ops = Vec::new();
    let mut left = 0usize;
    let mut right = 0usize;
    while left < before.len() && right < after.len() {
        if before[left] == after[right] {
            ops.push(SeqOp::Equal(before[left].clone()));
            left += 1;
            right += 1;
        } else if matrix[(left + 1) * width + right] >= matrix[left * width + right + 1] {
            ops.push(SeqOp::Delete {
                val: before[left].clone(),
                old_idx: left,
            });
            left += 1;
        } else {
            ops.push(SeqOp::Insert {
                val: after[right].clone(),
                new_idx: right,
            });
            right += 1;
        }
    }
    while left < before.len() {
        ops.push(SeqOp::Delete {
            val: before[left].clone(),
            old_idx: left,
        });
        left += 1;
    }
    while right < after.len() {
        ops.push(SeqOp::Insert {
            val: after[right].clone(),
            new_idx: right,
        });
        right += 1;
    }
    ops
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
// Bounded OOXML ZIP & XML helpers (`.docx`, `.pptx`, `.xlsx`)
// ============================================================================

fn open_bounded_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
    if bytes.len() > MAX_OOXML_COMPRESSED_BYTES {
        return Err(format!(
            "Office package exceeds the {MAX_OOXML_COMPRESSED_BYTES}-byte compressed-size limit."
        ));
    }
    let archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Invalid Office ZIP package: {e}"))?;
    if archive.len() > MAX_OOXML_ENTRIES {
        return Err(format!(
            "Office package exceeds the {MAX_OOXML_ENTRIES}-entry limit."
        ));
    }
    Ok(archive)
}

fn read_zip_bytes(archive: &mut ZipArchive<Cursor<&[u8]>>, part: &str) -> Result<Vec<u8>, String> {
    let mut file = archive
        .by_name(part)
        .map_err(|_| format!("Missing Office package part: {part}"))?;
    if file.size() as usize > MAX_OOXML_ENTRY_BYTES {
        return Err(format!(
            "Office package part {part} exceeds the {MAX_OOXML_ENTRY_BYTES}-byte limit."
        ));
    }
    let mut buf = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("Failed reading Office part {part}: {e}"))?;
    Ok(buf)
}

fn read_zip_text(archive: &mut ZipArchive<Cursor<&[u8]>>, part: &str) -> Result<String, String> {
    let bytes = read_zip_bytes(archive, part)?;
    decode_utf8(&bytes)
}

fn read_media(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    prefix: &str,
) -> Result<Vec<OoxmlMedia>, String> {
    let mut names: Vec<String> = archive
        .file_names()
        .filter_map(|r| r.ok().map(|c| c.into_owned()))
        .filter(|n| n.starts_with(prefix) && !n.ends_with('/'))
        .collect();
    names.sort();
    let mut media = Vec::new();
    for name in names {
        let bytes = read_zip_bytes(archive, &name)?;
        let mime = mime_type_for_artifact(&ArtifactBlobInput {
            bytes: &bytes,
            filename: &name,
            mime_type: None,
        });
        media.push(OoxmlMedia {
            path: name,
            mime_type: mime,
            size_bytes: bytes.len(),
            sha256: sha256_hex(&bytes),
        });
    }
    Ok(media)
}

fn local_tag_name(raw: &str) -> String {
    raw.rsplit(':').next().unwrap_or(raw).to_owned()
}

fn unescape_xml_str(raw: &str) -> String {
    quick_xml::escape::unescape(raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.to_owned())
}

fn decode_xml_text(t: &quick_xml::events::BytesText<'_>) -> String {
    unescape_xml_str(&t.xml10_content())
}

fn decode_general_ref(g: &quick_xml::events::BytesRef<'_>) -> String {
    let raw = format!("&{};", g.xml10_content());
    unescape_xml_str(&raw)
}

fn extract_docx_snapshot(bytes: &[u8]) -> Result<DocxSnapshot, String> {
    let mut archive = open_bounded_zip(bytes)?;
    let doc_xml = read_zip_text(&mut archive, "word/document.xml")?;

    let mut paragraphs = Vec::new();
    let mut headings = Vec::new();
    let mut tables = Vec::new();

    let mut reader = Reader::from_str(&doc_xml);
    let mut buf = Vec::new();
    let mut in_p = false;
    let mut p_text = String::new();
    let mut p_style: Option<String> = None;
    let mut p_index = 0usize;

    let mut in_tbl = false;
    let mut tbl_rows: Vec<Vec<String>> = Vec::new();
    let mut cur_row: Vec<String> = Vec::new();
    let mut in_tc = false;
    let mut cur_cell = String::new();
    let mut tbl_index = 0usize;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "tbl" => {
                        in_tbl = true;
                        tbl_rows.clear();
                    }
                    "tr" if in_tbl => {
                        cur_row.clear();
                    }
                    "tc" if in_tbl => {
                        in_tc = true;
                        cur_cell.clear();
                    }
                    "p" if !in_tbl => {
                        in_p = true;
                        p_text.clear();
                        p_style = None;
                    }
                    "pStyle" if in_p => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "val" {
                                p_style = Some(unescape_xml_str(&attr.value));
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if tag == "pStyle" && in_p {
                    for attr in e.attributes().flatten() {
                        if local_tag_name(attr.key.as_ref()) == "val" {
                            p_style = Some(unescape_xml_str(&attr.value));
                        }
                    }
                } else if tag == "tab" {
                    if in_tc {
                        cur_cell.push('\t');
                    } else if in_p {
                        p_text.push('\t');
                    }
                } else if tag == "br" {
                    if in_tc {
                        cur_cell.push('\n');
                    } else if in_p {
                        p_text.push('\n');
                    }
                }
            }
            Ok(Event::Text(t)) => {
                let txt = decode_xml_text(&t);
                if in_tc {
                    cur_cell.push_str(&txt);
                } else if in_p {
                    p_text.push_str(&txt);
                }
            }
            Ok(Event::GeneralRef(g)) => {
                let txt = decode_general_ref(&g);
                if in_tc {
                    cur_cell.push_str(&txt);
                } else if in_p {
                    p_text.push_str(&txt);
                }
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "tc" if in_tbl => {
                        in_tc = false;
                        cur_row.push(cur_cell.trim().to_owned());
                    }
                    "tr" if in_tbl => {
                        tbl_rows.push(cur_row.clone());
                    }
                    "tbl" if in_tbl => {
                        in_tbl = false;
                        tables.push(DocxTable {
                            index: tbl_index,
                            rows: tbl_rows.clone(),
                        });
                        tbl_index += 1;
                    }
                    "p" if in_p && !in_tbl => {
                        in_p = false;
                        let is_h = p_style.as_deref().is_some_and(|st| {
                            let low = st.to_ascii_lowercase();
                            low.starts_with("heading") || low == "title" || low == "subtitle"
                        });
                        if is_h {
                            let level = p_style.as_deref().and_then(|st| {
                                let digits: String =
                                    st.chars().filter(|c| c.is_ascii_digit()).collect();
                                digits.parse::<u32>().ok().filter(|&n| n > 0)
                            });
                            headings.push(DocxHeading {
                                index: p_index,
                                text: p_text.clone(),
                                style: p_style.clone(),
                                level,
                            });
                        } else {
                            paragraphs.push(DocxParagraph {
                                index: p_index,
                                text: p_text.clone(),
                                style: p_style.clone(),
                            });
                        }
                        p_index += 1;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("DOCX XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    let media = read_media(&mut archive, "word/media/")?;
    Ok(DocxSnapshot {
        paragraphs,
        headings,
        tables,
        headers: Vec::new(),
        footers: Vec::new(),
        tracked_changes: Vec::new(),
        media,
    })
}

fn collect_xml_text(xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Text(t)) => {
                let s = decode_xml_text(&t);
                if !s.is_empty() {
                    if !out.is_empty() && !out.ends_with('\n') && !out.ends_with(' ') {
                        out.push(' ');
                    }
                    out.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(g)) => {
                out.push_str(&decode_general_ref(&g));
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out.trim().to_owned())
}

fn extract_pptx_snapshot(bytes: &[u8]) -> Result<PptxSnapshot, String> {
    let mut archive = open_bounded_zip(bytes)?;
    let mut slide_parts: Vec<String> = archive
        .file_names()
        .filter_map(|r| r.ok().map(|c| c.into_owned()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();
    slide_parts.sort_by_key(|p| {
        p.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<usize>()
            .unwrap_or(usize::MAX)
    });
    if slide_parts.is_empty() {
        return Err("PPTX package does not contain any slides.".to_owned());
    }
    let mut slides = Vec::new();
    for (index, part) in slide_parts.into_iter().enumerate() {
        let xml = read_zip_text(&mut archive, &part)?;
        let text = collect_xml_text(&xml)?;
        let id = Path::new(&part)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("slide")
            .to_owned();
        let fp = sha256_hex(format!("{text}|").as_bytes());
        slides.push(PptxSlide {
            id,
            part,
            index,
            text,
            notes: String::new(),
            shapes: Vec::new(),
            media: Vec::new(),
            fingerprint: fp,
        });
    }
    let media = read_media(&mut archive, "ppt/media/")?;
    Ok(PptxSnapshot { slides, media })
}

fn extract_xlsx_snapshot(bytes: &[u8]) -> Result<XlsxSnapshot, String> {
    let mut archive = open_bounded_zip(bytes)?;
    let shared_strings = read_zip_text(&mut archive, "xl/sharedStrings.xml")
        .ok()
        .map(|xml| parse_shared_strings(&xml))
        .unwrap_or_default();

    let workbook_xml = read_zip_text(&mut archive, "xl/workbook.xml")?;
    let mut sheet_names = parse_workbook_sheet_names(&workbook_xml);
    if sheet_names.is_empty() {
        sheet_names.push(("Sheet1".to_owned(), false));
    }

    let mut sheet_parts: Vec<String> = archive
        .file_names()
        .filter_map(|r| r.ok().map(|c| c.into_owned()))
        .filter(|n| n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml"))
        .collect();
    sheet_parts.sort_by_key(|p| {
        p.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<usize>()
            .unwrap_or(usize::MAX)
    });
    if sheet_parts.is_empty() {
        return Err("XLSX package does not contain any worksheets.".to_owned());
    }

    let mut sheets = Vec::new();
    for (index, part) in sheet_parts.into_iter().enumerate() {
        let xml = read_zip_text(&mut archive, &part)?;
        let (name, hidden) = sheet_names
            .get(index)
            .cloned()
            .unwrap_or_else(|| (format!("Sheet{}", index + 1), false));
        let cells = parse_worksheet_cells(&xml, &shared_strings)?;
        sheets.push(XlsxSheet {
            name,
            index,
            hidden,
            cells,
            merges: Vec::new(),
            column_widths: Vec::new(),
            tables: Vec::new(),
            charts: Vec::new(),
        });
    }
    Ok(XlsxSnapshot { sheets })
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    let mut in_si = false;
    let mut cur = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if local_tag_name(e.name().as_ref()) == "si" => {
                in_si = true;
                cur.clear();
            }
            Ok(Event::Text(t)) if in_si => {
                cur.push_str(&decode_xml_text(&t));
            }
            Ok(Event::GeneralRef(g)) if in_si => {
                cur.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) if local_tag_name(e.name().as_ref()) == "si" => {
                in_si = false;
                out.push(cur.clone());
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn parse_workbook_sheet_names(xml: &str) -> Vec<(String, bool)> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e))
                if local_tag_name(e.name().as_ref()) == "sheet" =>
            {
                let mut name = None;
                let mut hidden = false;
                for attr in e.attributes().flatten() {
                    let key = local_tag_name(attr.key.as_ref());
                    let val = unescape_xml_str(&attr.value);
                    if key == "name" {
                        name = Some(val);
                    } else if key == "state" && (val == "hidden" || val == "veryHidden") {
                        hidden = true;
                    }
                }
                if let Some(n) = name {
                    out.push((n, hidden));
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn parse_worksheet_cells(xml: &str, shared_strings: &[String]) -> Result<Vec<XlsxCell>, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut cells = Vec::new();
    let mut in_c = false;
    let mut c_ref = String::new();
    let mut c_type = String::new();
    let mut in_v = false;
    let mut in_f = false;
    let mut in_is = false;
    let mut v_text = String::new();
    let mut f_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "c" => {
                        in_c = true;
                        c_ref.clear();
                        c_type.clear();
                        v_text.clear();
                        f_text.clear();
                        for attr in e.attributes().flatten() {
                            let k = local_tag_name(attr.key.as_ref());
                            let val = unescape_xml_str(&attr.value);
                            if k == "r" {
                                c_ref = val.to_uppercase();
                            } else if k == "t" {
                                c_type = val;
                            }
                        }
                    }
                    "v" if in_c => in_v = true,
                    "f" if in_c => in_f = true,
                    "is" if in_c => in_is = true,
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_c => {
                let s = decode_xml_text(&t);
                if in_v || in_is {
                    v_text.push_str(&s);
                } else if in_f {
                    f_text.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(g)) if in_c => {
                let s = decode_general_ref(&g);
                if in_v || in_is {
                    v_text.push_str(&s);
                } else if in_f {
                    f_text.push_str(&s);
                }
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "v" => in_v = false,
                    "f" => in_f = false,
                    "is" => in_is = false,
                    "c" if in_c => {
                        in_c = false;
                        if !c_ref.is_empty() {
                            let value = match c_type.as_str() {
                                "s" => v_text
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                                    .and_then(|idx| shared_strings.get(idx).cloned())
                                    .map(Value::String)
                                    .unwrap_or(Value::Null),
                                "b" => Value::Bool(v_text.trim() == "1" || v_text.trim() == "true"),
                                "str" | "inlineStr" | "e" => Value::String(v_text.clone()),
                                _ => {
                                    if v_text.is_empty() {
                                        Value::Null
                                    } else if let Ok(n) = v_text.trim().parse::<f64>() {
                                        serde_json::Number::from_f64(n)
                                            .map(Value::Number)
                                            .unwrap_or_else(|| Value::String(v_text.clone()))
                                    } else {
                                        Value::String(v_text.clone())
                                    }
                                }
                            };
                            let formula = if f_text.is_empty() {
                                None
                            } else {
                                Some(f_text.clone())
                            };
                            if !value.is_null() || formula.is_some() {
                                cells.push(XlsxCell {
                                    address: c_ref.clone(),
                                    value,
                                    formula,
                                    style: None,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XLSX XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(cells)
}

fn compare_docx(
    before: &DocxSnapshot,
    after: &DocxSnapshot,
    requested_limit: Option<usize>,
) -> Value {
    let mut collector = ChangeCollector::<Value>::new(requested_limit);
    let max_p = before.paragraphs.len().max(after.paragraphs.len());
    for i in 0..max_p {
        let l = before.paragraphs.get(i);
        let r = after.paragraphs.get(i);
        match (l, r) {
            (None, Some(right)) => collector.add(
                json!({ "type": "paragraph_added", "index": right.index, "before": null, "after": right }),
                ChangeAction::Added,
                &["paragraph"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({ "type": "paragraph_removed", "index": left.index, "before": left, "after": null }),
                ChangeAction::Removed,
                &["paragraph"],
                true,
            ),
            (Some(left), Some(right)) if left != right => collector.add(
                json!({ "type": "paragraph_changed", "index": right.index, "before": left, "after": right }),
                ChangeAction::Modified,
                &["paragraph"],
                true,
            ),
            _ => {}
        }
    }
    let max_h = before.headings.len().max(after.headings.len());
    for i in 0..max_h {
        let l = before.headings.get(i);
        let r = after.headings.get(i);
        match (l, r) {
            (None, Some(right)) => collector.add(
                json!({ "type": "heading_added", "index": right.index, "before": null, "after": right }),
                ChangeAction::Added,
                &["heading"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({ "type": "heading_removed", "index": left.index, "before": left, "after": null }),
                ChangeAction::Removed,
                &["heading"],
                true,
            ),
            (Some(left), Some(right)) if left != right => collector.add(
                json!({ "type": "heading_changed", "index": right.index, "before": left, "after": right }),
                ChangeAction::Modified,
                &["heading"],
                true,
            ),
            _ => {}
        }
    }
    let max_t = before.tables.len().max(after.tables.len());
    for i in 0..max_t {
        let l = before.tables.get(i);
        let r = after.tables.get(i);
        match (l, r) {
            (None, Some(right)) => collector.add(
                json!({ "type": "table_added", "index": i, "before": null, "after": right }),
                ChangeAction::Added,
                &["table"],
                true,
            ),
            (Some(left), None) => collector.add(
                json!({ "type": "table_removed", "index": i, "before": left, "after": null }),
                ChangeAction::Removed,
                &["table"],
                true,
            ),
            (Some(left), Some(right)) if left != right => collector.add(
                json!({ "type": "table_changed", "index": i, "before": left, "after": right }),
                ChangeAction::Modified,
                &["table"],
                true,
            ),
            _ => {}
        }
    }
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
    let all_ids: BTreeSet<&str> = before_by_id
        .keys()
        .chain(after_by_id.keys())
        .copied()
        .collect();
    for id in all_ids {
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
                        json!({ "type": "slide_moved", "slideId": id, "beforeIndex": left.index, "afterIndex": right.index }),
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
    let all_names: BTreeSet<&str> = before_by_name
        .keys()
        .chain(after_by_name.keys())
        .copied()
        .collect();
    for sheet_name in all_names {
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
                        json!({ "type": "sheet_moved", "sheetName": sheet_name, "beforeIndex": left.index, "afterIndex": right.index }),
                        ChangeAction::Moved,
                        &["sheet"],
                        true,
                    );
                }
                let l_cells: BTreeMap<&str, &XlsxCell> =
                    left.cells.iter().map(|c| (c.address.as_str(), c)).collect();
                let r_cells: BTreeMap<&str, &XlsxCell> = right
                    .cells
                    .iter()
                    .map(|c| (c.address.as_str(), c))
                    .collect();
                let addrs: BTreeSet<&str> = l_cells.keys().chain(r_cells.keys()).copied().collect();
                for addr in addrs {
                    match (l_cells.get(addr), r_cells.get(addr)) {
                        (None, Some(rc)) => collector.add(
                            json!({
                                "type": "cell_added",
                                "sheetName": sheet_name,
                                "address": addr,
                                "changedFields": ["value"],
                                "before": null,
                                "after": rc,
                            }),
                            ChangeAction::Added,
                            &["cell", "value"],
                            true,
                        ),
                        (Some(lc), None) => collector.add(
                            json!({
                                "type": "cell_removed",
                                "sheetName": sheet_name,
                                "address": addr,
                                "changedFields": ["value"],
                                "before": lc,
                                "after": null,
                            }),
                            ChangeAction::Removed,
                            &["cell", "value"],
                            true,
                        ),
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
                        _ => {}
                    }
                }
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
