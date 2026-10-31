//! Native Rust Spreadsheet (`CSV` & `XLSX`) snapshot reader, version inspector, and lossless batch patcher
//! (`src/server/spreadsheet/{read,write,util}.ts` parity).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Write};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;

use cowork_config::{
    ConfigError, FileLockOptions, file_lock_root_for_cowork_home, with_file_lock_sync,
};
use quick_xml::Reader;
use quick_xml::Writer;
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::xlsx::{
    CellCoords, CellRangeCoords, MAX_COLUMN_WIDTH_PX, MAX_OOXML_COLUMN_WIDTH, MAX_SPREADSHEET_COLS,
    SpreadsheetCellStyle, SpreadsheetChartSummary, SpreadsheetTableSummary, decode_column_width,
    encode_cell_address, encode_cell_range, encode_column_width, parse_cell_range,
    parse_strict_a1_address, parse_xlsx_workbook,
};
use super::zip_guard::{
    local_tag_name, open_bounded_zip, read_relationships, read_zip_bytes, read_zip_text,
    resolve_relationship_target, unescape_xml_str,
};

pub const OUTSIDE_WORKSPACE_MESSAGE: &str = "Path is outside the workspace root.";
pub const FILE_CHANGED_MESSAGE: &str = "Spreadsheet file changed on disk; reload before saving.";
pub const MAX_WORKBOOK_SNAPSHOT_CELLS: usize = 50_000;
pub const MAX_SNAPSHOT_ROWS_PER_SHEET: usize = 2_000;
pub const MAX_SNAPSHOT_COLS_PER_SHEET: usize = 200;
pub const MAX_BATCH_PATCH_OPERATIONS: usize = 50_000;
pub const MAX_CSV_EXPANSION_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChangeVersion {
    pub modified_at_ms: f64,
    pub change_time_ms: f64,
    pub size: u64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpreadsheetFileKind {
    Csv,
    Xlsx,
}

impl SpreadsheetFileKind {
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "csv" => Some(Self::Csv),
            "xlsx" => Some(Self::Xlsx),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetPreviewCell {
    pub row: usize,
    pub col: usize,
    pub address: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub cell_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<SpreadsheetCellStyle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetMergedRange {
    #[serde(rename = "ref")]
    pub range_ref: String,
    pub start_row: usize,
    pub start_col: usize,
    pub end_row: usize,
    pub end_col: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetColumnWidth {
    pub col: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_chars: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_px: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetWorkbookSnapshotSheet {
    pub id: String,
    pub name: String,
    pub row_count: usize,
    pub col_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded_row_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded_col_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_rows: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_cols: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    pub cells: Vec<SpreadsheetPreviewCell>,
    pub merged_cells: Vec<SpreadsheetMergedRange>,
    pub column_widths: Vec<SpreadsheetColumnWidth>,
    pub tables: Vec<SpreadsheetTableSummary>,
    pub charts: Vec<SpreadsheetChartSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetWorkbookSnapshot {
    pub kind: SpreadsheetFileKind,
    pub path: String,
    pub filename: String,
    pub file_version: FileChangeVersion,
    pub sheets: Vec<SpreadsheetWorkbookSnapshotSheet>,
    pub active_sheet_name: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetErrorPayload {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SpreadsheetWorkbookSnapshotResult {
    Ok {
        ok: bool,
        workbook: SpreadsheetWorkbookSnapshot,
    },
    Err {
        ok: bool,
        error: SpreadsheetErrorPayload,
        warnings: Vec<String>,
    },
}

impl SpreadsheetWorkbookSnapshotResult {
    pub fn ok(workbook: SpreadsheetWorkbookSnapshot) -> Self {
        Self::Ok { ok: true, workbook }
    }

    pub fn err(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            error: SpreadsheetErrorPayload {
                kind: kind.into(),
                message: message.into(),
            },
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SpreadsheetFileVersionResult {
    Ok {
        ok: bool,
        version: FileChangeVersion,
    },
    Err {
        ok: bool,
        error: SpreadsheetErrorPayload,
        warnings: Vec<String>,
    },
}

impl SpreadsheetFileVersionResult {
    pub fn ok(version: FileChangeVersion) -> Self {
        Self::Ok { ok: true, version }
    }

    pub fn err(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            error: SpreadsheetErrorPayload {
                kind: kind.into(),
                message: message.into(),
            },
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SpreadsheetEditResult {
    Ok {
        ok: bool,
    },
    Err {
        ok: bool,
        error: SpreadsheetErrorPayload,
    },
}

impl SpreadsheetEditResult {
    pub fn ok() -> Self {
        Self::Ok { ok: true }
    }

    pub fn err(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            error: SpreadsheetErrorPayload {
                kind: kind.into(),
                message: message.into(),
            },
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { ok: true })
    }
}

fn deserialize_optional_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetCellStylePatch {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub bold: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub italic: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub font_size: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub horizontal_align: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill_color: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub text_color: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub number_format: Option<Option<String>>,
}

impl SpreadsheetCellStylePatch {
    pub fn has_any_change(&self) -> bool {
        self.bold.is_some()
            || self.italic.is_some()
            || self.font_size.is_some()
            || self.horizontal_align.is_some()
            || self.fill_color.is_some()
            || self.text_color.is_some()
            || self.number_format.is_some()
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.has_any_change() {
            return Err("style must include at least one change".to_owned());
        }
        if let Some(Some(sz)) = self.font_size
            && (!sz.is_finite() || sz <= 0.0)
        {
            return Err("fontSize must be a positive number".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SpreadsheetBatchPatchOperation {
    #[serde(rename_all = "camelCase")]
    Cell {
        #[serde(skip_serializing_if = "Option::is_none")]
        sheet_name: Option<String>,
        address: String,
        raw_input: String,
    },
    #[serde(rename_all = "camelCase")]
    Format {
        #[serde(skip_serializing_if = "Option::is_none")]
        sheet_name: Option<String>,
        range: String,
        style: SpreadsheetCellStylePatch,
    },
    #[serde(rename_all = "camelCase")]
    Merge {
        #[serde(skip_serializing_if = "Option::is_none")]
        sheet_name: Option<String>,
        range: String,
        merged: bool,
    },
    #[serde(rename_all = "camelCase")]
    ColumnWidth {
        #[serde(skip_serializing_if = "Option::is_none")]
        sheet_name: Option<String>,
        col: usize,
        width_px: Option<f64>,
    },
}

#[derive(Debug, Clone)]
pub struct SpreadsheetWorkbookRequest {
    pub cwd: PathBuf,
    pub file_path: String,
    pub sheet_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpreadsheetBatchPatchRequest {
    pub cwd: PathBuf,
    pub cowork_home: PathBuf,
    pub file_path: String,
    pub operations: Vec<SpreadsheetBatchPatchOperation>,
    pub expected_file_version: Option<FileChangeVersion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStatIdentity {
    dev: u64,
    ino: u64,
    size: u64,
    mtime_ns: i128,
    ctime_ns: i128,
}

fn stat_identity(meta: &fs::Metadata) -> FileStatIdentity {
    #[cfg(unix)]
    {
        FileStatIdentity {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.len(),
            mtime_ns: (meta.mtime() as i128) * 1_000_000_000 + (meta.mtime_nsec() as i128),
            ctime_ns: (meta.ctime() as i128) * 1_000_000_000 + (meta.ctime_nsec() as i128),
        }
    }
    #[cfg(not(unix))]
    {
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos() as i128);
        FileStatIdentity {
            dev: 0,
            ino: 0,
            size: meta.len(),
            mtime_ns,
            ctime_ns: mtime_ns,
        }
    }
}

pub fn file_change_version_from_metadata(meta: &fs::Metadata) -> FileChangeVersion {
    #[cfg(unix)]
    {
        let modified_at_ms =
            (meta.mtime() as f64) * 1000.0 + (meta.mtime_nsec() as f64) / 1_000_000.0;
        let change_time_ms =
            (meta.ctime() as f64) * 1000.0 + (meta.ctime_nsec() as f64) / 1_000_000.0;
        let size = meta.len();
        let dev = meta.dev();
        let ino = meta.ino();
        let fingerprint = format!("{dev}:{ino}:{modified_at_ms}:{change_time_ms}:{size}");
        FileChangeVersion {
            modified_at_ms,
            change_time_ms,
            size,
            fingerprint,
        }
    }
    #[cfg(not(unix))]
    {
        let modified_at_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        let size = meta.len();
        let fingerprint = format!("{modified_at_ms}:{modified_at_ms}:{size}");
        FileChangeVersion {
            modified_at_ms,
            change_time_ms: modified_at_ms,
            size,
            fingerprint,
        }
    }
}

pub fn read_file_change_version(path: &Path) -> Result<FileChangeVersion, std::io::Error> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Path is not a file",
        ));
    }
    Ok(file_change_version_from_metadata(&meta))
}

#[derive(Debug, Clone)]
pub enum WorkspacePathError {
    NotFound,
    OutsideWorkspace,
    Io(String),
}

pub fn resolve_workspace_file_path(
    cwd: &Path,
    file_path: &str,
) -> Result<PathBuf, WorkspacePathError> {
    let workspace_root = fs::canonicalize(cwd).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspacePathError::NotFound
        } else {
            WorkspacePathError::Io(e.to_string())
        }
    })?;
    let p = Path::new(file_path);
    let candidate = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let joined = workspace_root.join(p);
        let lexical = cowork_config::normalize_lexical_path(&joined);
        if !lexical.starts_with(&workspace_root) {
            return Err(WorkspacePathError::OutsideWorkspace);
        }
        joined
    };
    let resolved = match fs::canonicalize(&candidate) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let lexical = cowork_config::normalize_lexical_path(&candidate);
            let mut ancestor = lexical.as_path();
            while let Some(parent) = ancestor.parent() {
                if let Ok(canon_parent) = fs::canonicalize(parent) {
                    if !canon_parent.starts_with(&workspace_root) {
                        return Err(WorkspacePathError::OutsideWorkspace);
                    }
                    break;
                }
                ancestor = parent;
            }
            return Err(WorkspacePathError::NotFound);
        }
        Err(e) => return Err(WorkspacePathError::Io(e.to_string())),
    };
    if !resolved.starts_with(&workspace_root) {
        return Err(WorkspacePathError::OutsideWorkspace);
    }
    Ok(resolved)
}

fn path_failure_payload(err: WorkspacePathError) -> (&'static str, String) {
    match err {
        WorkspacePathError::OutsideWorkspace => {
            ("outside_workspace", OUTSIDE_WORKSPACE_MESSAGE.to_owned())
        }
        WorkspacePathError::NotFound | WorkspacePathError::Io(_) => {
            ("not_found", "Spreadsheet file was not found.".to_owned())
        }
    }
}

pub fn validate_xlsx_zip_signature(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() >= 4 && bytes[0] == 0x50 && bytes[1] == 0x4b {
        return Ok(());
    }
    Err("XLSX file is not a valid Office Open XML zip package.".to_owned())
}

pub fn read_spreadsheet_file_version(cwd: &Path, file_path: &str) -> SpreadsheetFileVersionResult {
    let resolved = match resolve_workspace_file_path(cwd, file_path) {
        Ok(p) => p,
        Err(err) => {
            let (kind, msg) = path_failure_payload(err);
            return SpreadsheetFileVersionResult::err(kind, msg);
        }
    };
    if SpreadsheetFileKind::from_path(&resolved).is_none() {
        return SpreadsheetFileVersionResult::err(
            "unsupported_format",
            "Spreadsheet file versions support CSV and XLSX files.",
        );
    }
    match fs::metadata(&resolved) {
        Ok(meta) => SpreadsheetFileVersionResult::ok(file_change_version_from_metadata(&meta)),
        Err(e) => {
            let kind = if e.kind() == std::io::ErrorKind::NotFound {
                "not_found"
            } else {
                "parse_error"
            };
            SpreadsheetFileVersionResult::err(kind, e.to_string())
        }
    }
}

pub fn read_spreadsheet_workbook_snapshot(
    req: &SpreadsheetWorkbookRequest,
) -> SpreadsheetWorkbookSnapshotResult {
    let resolved = match resolve_workspace_file_path(&req.cwd, &req.file_path) {
        Ok(p) => p,
        Err(err) => {
            let (kind, msg) = path_failure_payload(err);
            return SpreadsheetWorkbookSnapshotResult::err(kind, msg);
        }
    };
    let Some(kind) = SpreadsheetFileKind::from_path(&resolved) else {
        return SpreadsheetWorkbookSnapshotResult::err(
            "unsupported_format",
            "Spreadsheet workbook snapshots support CSV and XLSX files.",
        );
    };
    let meta = match fs::metadata(&resolved) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return SpreadsheetWorkbookSnapshotResult::err(
                "not_found",
                "Spreadsheet file was not found.",
            );
        }
        Err(e) => return SpreadsheetWorkbookSnapshotResult::err("parse_error", e.to_string()),
    };
    let bytes = match fs::read(&resolved) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return SpreadsheetWorkbookSnapshotResult::err(
                "not_found",
                "Spreadsheet file was not found.",
            );
        }
        Err(e) => return SpreadsheetWorkbookSnapshotResult::err("parse_error", e.to_string()),
    };
    let file_version = file_change_version_from_metadata(&meta);
    let filename = resolved
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workbook")
        .to_owned();
    let path_str = resolved.to_string_lossy().into_owned();

    match kind {
        SpreadsheetFileKind::Csv => {
            let text = match std::str::from_utf8(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return SpreadsheetWorkbookSnapshotResult::err(
                        "parse_error",
                        format!("Invalid UTF-8 CSV content: {e}"),
                    );
                }
            };
            if let Err(msg) = validate_csv_quote_balance(text) {
                return SpreadsheetWorkbookSnapshotResult::err("parse_error", msg);
            }
            let dialect = read_csv_dialect(text);
            let rows = parse_csv(dialect.content, dialect.delimiter);
            let row_count = rows.len();
            let col_count = rows.iter().map(Vec::len).max().unwrap_or(0);
            let vp = build_bounded_viewport(row_count, col_count, MAX_WORKBOOK_SNAPSHOT_CELLS);
            let mut warnings = Vec::new();
            if vp.truncated_rows || vp.truncated_cols {
                warnings.push(format!(
                    "CSV: workbook canvas snapshot is limited to {} rows x {} columns of {} rows x {} columns.",
                    vp.row_count, vp.col_count, row_count, col_count
                ));
            }
            let mut cells = Vec::new();
            for (r_idx, row) in rows.iter().take(vp.row_count).enumerate() {
                for (c_idx, val) in row.iter().take(vp.col_count).enumerate() {
                    if val.is_empty() {
                        continue;
                    }
                    cells.push(SpreadsheetPreviewCell {
                        row: r_idx,
                        col: c_idx,
                        address: encode_cell_address(CellCoords {
                            row: r_idx,
                            col: c_idx,
                        }),
                        value: val.clone(),
                        formatted_value: None,
                        raw_value: Some(Value::String(val.clone())),
                        formula: None,
                        cell_type: Some("s".to_owned()),
                        style: None,
                    });
                }
            }
            let sheet = SpreadsheetWorkbookSnapshotSheet {
                id: "sheet-1".to_owned(),
                name: "CSV".to_owned(),
                row_count,
                col_count,
                loaded_row_count: Some(vp.row_count),
                loaded_col_count: Some(vp.col_count),
                truncated_rows: Some(vp.truncated_rows),
                truncated_cols: Some(vp.truncated_cols),
                hidden: None,
                cells,
                merged_cells: Vec::new(),
                column_widths: Vec::new(),
                tables: Vec::new(),
                charts: Vec::new(),
            };
            SpreadsheetWorkbookSnapshotResult::ok(SpreadsheetWorkbookSnapshot {
                kind: SpreadsheetFileKind::Csv,
                path: path_str,
                filename,
                file_version,
                sheets: vec![sheet],
                active_sheet_name: "CSV".to_owned(),
                warnings,
            })
        }
        SpreadsheetFileKind::Xlsx => {
            if let Err(msg) = validate_xlsx_zip_signature(&bytes) {
                return SpreadsheetWorkbookSnapshotResult::err("parse_error", msg);
            }
            let parsed = match parse_xlsx_workbook(&bytes, None) {
                Ok(p) => p,
                Err(msg) => {
                    if msg.contains("does not contain any worksheets") {
                        return SpreadsheetWorkbookSnapshotResult::err("empty_workbook", msg);
                    }
                    return SpreadsheetWorkbookSnapshotResult::err("parse_error", msg);
                }
            };
            let sheet_names: Vec<String> = parsed.sheets.iter().map(|s| s.name.clone()).collect();
            let active_sheet_name = req
                .sheet_name
                .as_ref()
                .filter(|name| sheet_names.contains(name))
                .cloned()
                .or_else(|| sheet_names.first().cloned())
                .unwrap_or_else(|| "Sheet1".to_owned());

            let sheet_dims: Vec<(String, usize, usize)> = parsed
                .sheets
                .iter()
                .map(|s| {
                    let (rc, cc) = compute_sheet_bounds(s);
                    (s.name.clone(), rc, cc)
                })
                .collect();

            let mut prioritized: Vec<&(String, usize, usize)> = sheet_dims
                .iter()
                .filter(|(n, _, _)| n == &active_sheet_name)
                .chain(
                    sheet_dims
                        .iter()
                        .filter(|(n, _, _)| n != &active_sheet_name),
                )
                .collect();

            let mut remaining = MAX_WORKBOOK_SNAPSHOT_CELLS;
            let mut viewports = BTreeMap::new();
            let mut warnings = Vec::new();
            for (name, rc, cc) in prioritized.drain(..) {
                let vp = build_bounded_viewport(*rc, *cc, remaining);
                remaining = remaining.saturating_sub(vp.row_count.saturating_mul(vp.col_count));
                if vp.truncated_rows || vp.truncated_cols {
                    warnings.push(format!(
                        "{name}: workbook canvas snapshot is limited to {} rows x {} columns of {} rows x {} columns.",
                        vp.row_count, vp.col_count, rc, cc
                    ));
                }
                viewports.insert(name.clone(), vp);
            }

            let mut out_sheets = Vec::with_capacity(parsed.sheets.len());
            for (idx, sheet) in parsed.sheets.into_iter().enumerate() {
                let (row_count, col_count) = compute_sheet_bounds(&sheet);
                let vp = viewports
                    .get(&sheet.name)
                    .copied()
                    .unwrap_or_else(|| build_bounded_viewport(row_count, col_count, 0));

                let mut cells = Vec::new();
                if vp.row_count > 0 && vp.col_count > 0 {
                    for (coords, cell) in &sheet.cells {
                        if coords.row > vp.end_row || coords.col > vp.end_col {
                            continue;
                        }
                        if cell.raw_value.is_none()
                            && cell.formula.is_none()
                            && cell.style.is_none()
                        {
                            continue;
                        }
                        cells.push(SpreadsheetPreviewCell {
                            row: coords.row,
                            col: coords.col,
                            address: cell.address.clone(),
                            value: cell.display_value.clone(),
                            formatted_value: None,
                            raw_value: cell.raw_value.clone(),
                            formula: cell.formula.clone(),
                            cell_type: cell.cell_type.clone(),
                            style: cell.style.clone(),
                        });
                    }
                }

                let mut merged_cells = Vec::new();
                if vp.row_count > 0 && vp.col_count > 0 {
                    for m in &sheet.merges {
                        if m.start.row > vp.end_row || m.start.col > vp.end_col {
                            continue;
                        }
                        merged_cells.push(SpreadsheetMergedRange {
                            range_ref: encode_cell_range(*m),
                            start_row: m.start.row,
                            start_col: m.start.col,
                            end_row: m.end.row,
                            end_col: m.end.col,
                        });
                    }
                }

                let mut column_widths = Vec::new();
                if vp.col_count > 0 {
                    for col in 0..=vp.end_col {
                        if let Some(&w) = sheet.raw_col_widths.get(&col)
                            && w.is_finite()
                            && (0.0..=MAX_OOXML_COLUMN_WIDTH).contains(&w)
                        {
                            let (width_px, width_chars) = decode_column_width(w);
                            column_widths.push(SpreadsheetColumnWidth {
                                col,
                                width_chars: Some(width_chars),
                                width_px: Some(width_px),
                            });
                        }
                    }
                }

                out_sheets.push(SpreadsheetWorkbookSnapshotSheet {
                    id: format!("sheet-{}", idx + 1),
                    name: sheet.name,
                    row_count,
                    col_count,
                    loaded_row_count: Some(vp.row_count),
                    loaded_col_count: Some(vp.col_count),
                    truncated_rows: Some(vp.truncated_rows),
                    truncated_cols: Some(vp.truncated_cols),
                    hidden: sheet.hidden.then_some(true),
                    cells,
                    merged_cells,
                    column_widths,
                    tables: sheet.tables,
                    charts: sheet.charts,
                });
            }

            SpreadsheetWorkbookSnapshotResult::ok(SpreadsheetWorkbookSnapshot {
                kind: SpreadsheetFileKind::Xlsx,
                path: path_str,
                filename,
                file_version,
                sheets: out_sheets,
                active_sheet_name,
                warnings,
            })
        }
    }
}

fn compute_sheet_bounds(sheet: &super::xlsx::ParsedXlsxSheet) -> (usize, usize) {
    let mut max_row: Option<usize> = None;
    let mut max_col: Option<usize> = None;
    if let Some(dim) = sheet.dimension {
        // Note: if dimension is "A1" on an empty sheet with no cells, check whether sheet is empty.
        if !sheet.cells.is_empty() || !sheet.merges.is_empty() || dim.end.row > 0 || dim.end.col > 0
        {
            max_row = Some(dim.end.row);
            max_col = Some(dim.end.col);
        }
    }
    for coords in sheet.cells.keys() {
        max_row = Some(max_row.map_or(coords.row, |r| r.max(coords.row)));
        max_col = Some(max_col.map_or(coords.col, |c| c.max(coords.col)));
    }
    for m in &sheet.merges {
        max_row = Some(max_row.map_or(m.end.row, |r| r.max(m.end.row)));
        max_col = Some(max_col.map_or(m.end.col, |c| c.max(m.end.col)));
    }
    match (max_row, max_col) {
        (Some(r), Some(c)) => (r + 1, c + 1),
        _ => (0, 0),
    }
}

#[derive(Debug, Clone, Copy)]
struct SheetViewport {
    row_count: usize,
    col_count: usize,
    end_row: usize,
    end_col: usize,
    truncated_rows: bool,
    truncated_cols: bool,
}

fn build_bounded_viewport(
    total_rows: usize,
    total_cols: usize,
    remaining_cells: usize,
) -> SheetViewport {
    let mut col_count = total_cols
        .min(MAX_SNAPSHOT_COLS_PER_SHEET)
        .min(remaining_cells);
    let mut row_count = 0usize;
    if total_rows > 0 && col_count > 0 {
        row_count = total_rows
            .min(MAX_SNAPSHOT_ROWS_PER_SHEET)
            .min(remaining_cells / col_count);
        if row_count == 0 {
            row_count = 1;
            col_count = col_count.min(remaining_cells);
        }
    }
    SheetViewport {
        row_count,
        col_count,
        end_row: row_count.saturating_sub(1),
        end_col: col_count.saturating_sub(1),
        truncated_rows: row_count < total_rows,
        truncated_cols: col_count < total_cols,
    }
}

// --- CSV Dialect & Parser ---

pub struct CsvDialect<'a> {
    pub delimiter: char,
    pub preamble: &'a str,
    pub content: &'a str,
}

pub fn read_csv_dialect(raw: &str) -> CsvDialect<'_> {
    let content = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if let Some(after_sep) = content.strip_prefix("sep=") {
        let mut chars = after_sep.chars();
        if let Some(delim) = chars.next() {
            let rest = chars.as_str();
            if let Some(body) = rest.strip_prefix("\r\n") {
                let pre_len = content.len() - body.len();
                return CsvDialect {
                    delimiter: delim,
                    preamble: &content[..pre_len],
                    content: body,
                };
            } else if let Some(body) = rest.strip_prefix('\n').or_else(|| rest.strip_prefix('\r')) {
                let pre_len = content.len() - body.len();
                return CsvDialect {
                    delimiter: delim,
                    preamble: &content[..pre_len],
                    content: body,
                };
            }
        }
    }

    let candidates = [',', '\t', ';', '|'];
    let mut counts = [0usize; 4];
    let mut in_quotes = false;
    for ch in content.chars().take(1_024) {
        if ch == '"' {
            in_quotes = !in_quotes;
        } else if !in_quotes && let Some(pos) = candidates.iter().position(|&c| c == ch) {
            counts[pos] += 1;
        }
    }
    let mut delimiter = ',';
    let mut largest = 0usize;
    for (idx, &count) in counts.iter().enumerate() {
        if count > largest {
            largest = count;
            delimiter = candidates[idx];
        }
    }
    CsvDialect {
        delimiter,
        preamble: "",
        content,
    }
}

fn validate_csv_quote_balance(input: &str) -> Result<(), String> {
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '"' {
            continue;
        }
        if in_quotes && chars.peek() == Some(&'"') {
            chars.next();
            continue;
        }
        in_quotes = !in_quotes;
    }
    if in_quotes {
        return Err("CSV has an unterminated quoted field.".to_owned());
    }
    Ok(())
}

fn parse_csv(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        if ch == '"' {
            in_quotes = true;
            continue;
        }
        if ch == delimiter {
            row.push(std::mem::take(&mut field));
            continue;
        }
        if ch == '\r' || ch == '\n' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
            continue;
        }
        field.push(ch);
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn csv_quote_field(value: &str, delimiter: char) -> String {
    if value.contains('"')
        || value.contains('\r')
        || value.contains('\n')
        || value.contains(delimiter)
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

// --- Batch Patching ---

#[derive(Debug)]
struct BatchOpFailure {
    index: Option<usize>,
    kind: &'static str,
    message: String,
}

impl From<ConfigError> for BatchOpFailure {
    fn from(e: ConfigError) -> Self {
        Self {
            index: None,
            kind: "write_error",
            message: e.to_string(),
        }
    }
}

pub fn patch_spreadsheet_batch(req: &SpreadsheetBatchPatchRequest) -> SpreadsheetEditResult {
    if req.operations.len() > MAX_BATCH_PATCH_OPERATIONS {
        return SpreadsheetEditResult::err(
            "parse_error",
            format!(
                "Spreadsheet patch batches are limited to {MAX_BATCH_PATCH_OPERATIONS} operations."
            ),
        );
    }
    for (idx, op) in req.operations.iter().enumerate() {
        if let SpreadsheetBatchPatchOperation::Format { style, .. } = op
            && let Err(msg) = style.validate()
        {
            return SpreadsheetEditResult::err(
                "parse_error",
                format!("Operation {} failed: {msg}", idx + 1),
            );
        }
    }
    if req.operations.is_empty() {
        return SpreadsheetEditResult::ok();
    }

    let resolved = match resolve_workspace_file_path(&req.cwd, &req.file_path) {
        Ok(p) => p,
        Err(err) => {
            let (kind, msg) = path_failure_payload(err);
            return SpreadsheetEditResult::err(kind, msg);
        }
    };

    let lock_opts = FileLockOptions {
        lock_root: Some(file_lock_root_for_cowork_home(&req.cowork_home)),
        ..Default::default()
    };

    let res = with_file_lock_sync(
        &resolved,
        || {
            execute_locked_ops(
                &resolved,
                &req.operations,
                req.expected_file_version.as_ref(),
            )
        },
        lock_opts,
    );

    match res {
        Ok(()) => SpreadsheetEditResult::ok(),
        Err(fail) => {
            let msg = match fail.index {
                Some(idx) => format!("Operation {} failed: {}", idx + 1, fail.message),
                None => fail.message,
            };
            SpreadsheetEditResult::err(fail.kind, msg)
        }
    }
}

fn execute_locked_ops(
    resolved_path: &Path,
    operations: &[SpreadsheetBatchPatchOperation],
    expected_version: Option<&FileChangeVersion>,
) -> Result<(), BatchOpFailure> {
    let source_meta = fs::metadata(resolved_path).map_err(|e| BatchOpFailure {
        index: None,
        kind: if e.kind() == std::io::ErrorKind::NotFound {
            "not_found"
        } else {
            "write_error"
        },
        message: e.to_string(),
    })?;
    if let Some(expected) = expected_version {
        let current = file_change_version_from_metadata(&source_meta);
        if current.fingerprint != expected.fingerprint {
            return Err(BatchOpFailure {
                index: None,
                kind: "write_error",
                message: FILE_CHANGED_MESSAGE.to_owned(),
            });
        }
    }
    let source_id = stat_identity(&source_meta);

    match SpreadsheetFileKind::from_path(resolved_path) {
        Some(SpreadsheetFileKind::Csv) => run_csv_ops(resolved_path, operations, source_id),
        Some(SpreadsheetFileKind::Xlsx) => run_xlsx_ops(resolved_path, operations, source_id),
        None => {
            let msg = match operations.first() {
                Some(SpreadsheetBatchPatchOperation::Format { .. }) => {
                    "Formatting supports XLSX files."
                }
                Some(SpreadsheetBatchPatchOperation::Merge { .. }) => {
                    "Merging supports XLSX files."
                }
                _ => "Editing supports CSV and XLSX files.",
            };
            Err(BatchOpFailure {
                index: None,
                kind: "unsupported_format",
                message: msg.to_owned(),
            })
        }
    }
}

fn write_file_atomic_checked(
    file_path: &Path,
    data: &[u8],
    source_id: FileStatIdentity,
) -> Result<(), BatchOpFailure> {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let base = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("spreadsheet");
    let tmp = parent.join(format!(".{base}.{}.tmp", Uuid::new_v4()));
    let write_res = (|| -> Result<(), String> {
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        let current_meta = fs::symlink_metadata(file_path).map_err(|e| e.to_string())?;
        let current_id = stat_identity(&current_meta);
        if !current_meta.is_file() || current_id != source_id {
            return Err(FILE_CHANGED_MESSAGE.to_owned());
        }
        fs::rename(&tmp, file_path).map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(msg) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(BatchOpFailure {
            index: None,
            kind: "write_error",
            message: msg,
        });
    }
    Ok(())
}

fn run_csv_ops(
    file_path: &Path,
    operations: &[SpreadsheetBatchPatchOperation],
    source_id: FileStatIdentity,
) -> Result<(), BatchOpFailure> {
    let raw_bytes = fs::read(file_path).map_err(|e| BatchOpFailure {
        index: None,
        kind: "write_error",
        message: e.to_string(),
    })?;
    let raw = std::str::from_utf8(&raw_bytes).map_err(|e| BatchOpFailure {
        index: None,
        kind: "parse_error",
        message: format!("Invalid UTF-8 CSV: {e}"),
    })?;
    let has_bom = raw.starts_with('\u{feff}');
    let dialect = read_csv_dialect(raw);
    let eol = if dialect.content.contains("\r\n") {
        "\r\n"
    } else if dialect.content.contains('\r') {
        "\r"
    } else {
        "\n"
    };
    let has_trailing_newline = dialect.content.ends_with('\n') || dialect.content.ends_with('\r');

    let mut rows = parse_csv(dialect.content, dialect.delimiter);
    let mut expansion_entries = 0usize;

    for (idx, op) in operations.iter().enumerate() {
        match op {
            SpreadsheetBatchPatchOperation::Format { .. } => {
                return Err(BatchOpFailure {
                    index: Some(idx),
                    kind: "unsupported_format",
                    message: "Formatting supports XLSX files.".to_owned(),
                });
            }
            SpreadsheetBatchPatchOperation::Merge { .. } => {
                return Err(BatchOpFailure {
                    index: Some(idx),
                    kind: "unsupported_format",
                    message: "Merging supports XLSX files.".to_owned(),
                });
            }
            SpreadsheetBatchPatchOperation::ColumnWidth { .. } => {
                return Err(BatchOpFailure {
                    index: Some(idx),
                    kind: "unsupported_format",
                    message: "Column widths support XLSX files.".to_owned(),
                });
            }
            SpreadsheetBatchPatchOperation::Cell {
                address, raw_input, ..
            } => {
                let Some(addr) = parse_strict_a1_address(address) else {
                    return Err(BatchOpFailure {
                        index: Some(idx),
                        kind: "parse_error",
                        message: format!("Invalid cell address: {address}"),
                    });
                };
                let added_rows = (addr.row + 1).saturating_sub(rows.len());
                let cur_row_len = rows.get(addr.row).map_or(0, Vec::len);
                let added_cols = (addr.col + 1).saturating_sub(cur_row_len);
                expansion_entries = expansion_entries
                    .saturating_add(added_rows)
                    .saturating_add(added_cols);
                if expansion_entries > MAX_CSV_EXPANSION_ENTRIES {
                    return Err(BatchOpFailure {
                        index: Some(idx),
                        kind: "parse_error",
                        message: format!(
                            "CSV edits may add at most {MAX_CSV_EXPANSION_ENTRIES} rows and cells per batch."
                        ),
                    });
                }
                while rows.len() <= addr.row {
                    rows.push(Vec::new());
                }
                let row = &mut rows[addr.row];
                while row.len() <= addr.col {
                    row.push(String::new());
                }
                row[addr.col] = raw_input.clone();
            }
        }
    }

    let delim_str = dialect.delimiter.to_string();
    let mut out = rows
        .iter()
        .map(|cells| {
            cells
                .iter()
                .map(|c| csv_quote_field(c, dialect.delimiter))
                .collect::<Vec<_>>()
                .join(&delim_str)
        })
        .collect::<Vec<_>>()
        .join(eol);
    if has_trailing_newline {
        out.push_str(eol);
    }
    if !dialect.preamble.is_empty() {
        out = format!("{}{out}", dialect.preamble);
    }
    if has_bom {
        out = format!("\u{feff}{out}");
    }

    write_file_atomic_checked(file_path, out.as_bytes(), source_id)
}

// --- Lossless XLSX Session & Patcher ---

const OOXML_SPREADSHEET_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OOXML_RELATIONSHIPS_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OOXML_STYLES_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
const OOXML_STYLES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";

struct XlsxPatchSession {
    part_order: Vec<String>,
    raw_parts: BTreeMap<String, Vec<u8>>,
    text_overrides: BTreeMap<String, String>,
    removed_parts: BTreeSet<String>,
    sheet_parts_by_name: Vec<(String, String)>,
    dirty_sheets: BTreeSet<String>,
    styles_editor: Option<StylesheetEditor>,
    styles_dirty: bool,
    workbook_dirty: bool,
}

impl XlsxPatchSession {
    fn from_bytes(bytes: &[u8]) -> Result<Self, BatchOpFailure> {
        validate_xlsx_zip_signature(bytes).map_err(|message| BatchOpFailure {
            index: None,
            kind: "write_error",
            message,
        })?;
        let mut archive = open_bounded_zip(bytes).map_err(|message| BatchOpFailure {
            index: None,
            kind: "parse_error",
            message,
        })?;
        let wb_xml =
            read_zip_text(&mut archive, "xl/workbook.xml").map_err(|message| BatchOpFailure {
                index: None,
                kind: "parse_error",
                message,
            })?;
        let wb_rels = read_relationships(&mut archive, "xl/workbook.xml").map_err(|message| {
            BatchOpFailure {
                index: None,
                kind: "parse_error",
                message,
            }
        })?;
        let sheet_parts_by_name = resolve_all_worksheet_parts(&wb_xml, &wb_rels)?;

        let names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let f = archive.by_index_raw(i).ok()?;
                let name = f.name().ok()?.into_owned();
                if f.is_dir() || name.ends_with('/') {
                    None
                } else {
                    Some(name)
                }
            })
            .collect();
        let mut raw_parts = BTreeMap::new();
        for name in &names {
            let b = read_zip_bytes(&mut archive, name).map_err(|message| BatchOpFailure {
                index: None,
                kind: "parse_error",
                message,
            })?;
            raw_parts.insert(name.clone(), b);
        }

        Ok(Self {
            part_order: names,
            raw_parts,
            text_overrides: BTreeMap::new(),
            removed_parts: BTreeSet::new(),
            sheet_parts_by_name,
            dirty_sheets: BTreeSet::new(),
            styles_editor: None,
            styles_dirty: false,
            workbook_dirty: false,
        })
    }

    fn resolve_sheet_part(&self, sheet_name: Option<&str>) -> Option<String> {
        match sheet_name {
            Some(target) => self
                .sheet_parts_by_name
                .iter()
                .find(|(name, _)| name == target)
                .map(|(_, part)| part.clone()),
            None => self
                .sheet_parts_by_name
                .first()
                .map(|(_, part)| part.clone()),
        }
    }

    fn get_text_part(&self, part: &str) -> Result<Option<String>, String> {
        if self.removed_parts.contains(part) {
            return Ok(None);
        }
        if let Some(txt) = self.text_overrides.get(part) {
            return Ok(Some(txt.clone()));
        }
        let Some(bytes) = self.raw_parts.get(part) else {
            return Ok(None);
        };
        let s = std::str::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8 in {part}: {e}"))?;
        Ok(Some(s.strip_prefix('\u{feff}').unwrap_or(s).to_owned()))
    }

    fn set_text_part(&mut self, part: &str, content: String) {
        self.removed_parts.remove(part);
        if !self.raw_parts.contains_key(part) && !self.part_order.iter().any(|p| p == part) {
            self.part_order.push(part.to_owned());
        }
        self.text_overrides.insert(part.to_owned(), content);
    }

    fn ensure_styles(&mut self) -> Result<&mut StylesheetEditor, String> {
        if self.styles_editor.is_none() {
            let xml = match self.get_text_part("xl/styles.xml")? {
                Some(existing) => existing,
                None => default_styles_xml(),
            };
            self.styles_editor = Some(StylesheetEditor::parse(&xml)?);
        }
        Ok(self.styles_editor.as_mut().unwrap())
    }
}

fn resolve_all_worksheet_parts(
    wb_xml: &str,
    wb_rels: &BTreeMap<String, super::zip_guard::OoxmlRelationship>,
) -> Result<Vec<(String, String)>, BatchOpFailure> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(wb_xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e))
                if local_tag_name(e.name().as_ref()) == "sheet" =>
            {
                let mut name = None;
                let mut rid = None;
                for attr in e.attributes().flatten() {
                    let v = unescape_xml_str(&attr.value);
                    match local_tag_name(attr.key.as_ref()).as_str() {
                        "name" => name = Some(v),
                        "id" => rid = Some(v),
                        _ => {}
                    }
                }
                if let (Some(name), Some(rid)) = (name, rid)
                    && let Some(rel) = wb_rels.get(&rid)
                {
                    out.push((
                        name,
                        resolve_relationship_target("xl/workbook.xml", &rel.target),
                    ));
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(BatchOpFailure {
                    index: None,
                    kind: "parse_error",
                    message: format!("Workbook XML parse error: {e}"),
                });
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn run_xlsx_ops(
    file_path: &Path,
    operations: &[SpreadsheetBatchPatchOperation],
    source_id: FileStatIdentity,
) -> Result<(), BatchOpFailure> {
    let bytes = fs::read(file_path).map_err(|e| BatchOpFailure {
        index: None,
        kind: "write_error",
        message: e.to_string(),
    })?;
    let mut session = XlsxPatchSession::from_bytes(&bytes)?;

    for (idx, op) in operations.iter().enumerate() {
        let step_res = match op {
            SpreadsheetBatchPatchOperation::Cell {
                sheet_name,
                address,
                raw_input,
            } => apply_xlsx_cell_op(&mut session, sheet_name.as_deref(), address, raw_input),
            SpreadsheetBatchPatchOperation::Format {
                sheet_name,
                range,
                style,
            } => apply_xlsx_format_op(&mut session, sheet_name.as_deref(), range, style),
            SpreadsheetBatchPatchOperation::Merge {
                sheet_name,
                range,
                merged,
            } => apply_xlsx_merge_op(&mut session, sheet_name.as_deref(), range, *merged),
            SpreadsheetBatchPatchOperation::ColumnWidth {
                sheet_name,
                col,
                width_px,
            } => apply_xlsx_col_width_op(&mut session, sheet_name.as_deref(), *col, *width_px),
        };
        if let Err((kind, message)) = step_res {
            return Err(BatchOpFailure {
                index: Some(idx),
                kind,
                message,
            });
        }
    }

    if operations
        .iter()
        .any(|op| matches!(op, SpreadsheetBatchPatchOperation::Cell { .. }))
    {
        invalidate_formula_caches(&mut session).map_err(|message| BatchOpFailure {
            index: None,
            kind: "parse_error",
            message,
        })?;
    }

    // Validate all mutated worksheet XML parts and styles XML before writing.
    for part in session.dirty_sheets.clone() {
        if let Some(xml) = session.text_overrides.get(&part) {
            validate_xml_well_formed(xml).map_err(|err| BatchOpFailure {
                index: None,
                kind: "parse_error",
                message: format!("Edited worksheet XML is invalid: {err}"),
            })?;
        }
    }

    if session.styles_dirty
        && let Some(editor) = session.styles_editor.as_ref()
    {
        let new_styles = editor.to_xml();
        validate_xml_well_formed(&new_styles).map_err(|err| BatchOpFailure {
            index: None,
            kind: "parse_error",
            message: format!("Formatted styles XML is invalid: {err}"),
        })?;
        let registered = register_styles_part(&mut session).map_err(|message| BatchOpFailure {
            index: None,
            kind: "parse_error",
            message,
        })?;
        session.workbook_dirty = session.workbook_dirty || registered;
        session.set_text_part("xl/styles.xml", new_styles);
    }

    if session.dirty_sheets.is_empty() && !session.styles_dirty && !session.workbook_dirty {
        return Ok(());
    }

    let encoded = serialize_xlsx_session(&session).map_err(|message| BatchOpFailure {
        index: None,
        kind: "write_error",
        message,
    })?;
    write_file_atomic_checked(file_path, &encoded, source_id)
}

fn serialize_xlsx_session(session: &XlsxPatchSession) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for part in &session.part_order {
            if session.removed_parts.contains(part) {
                continue;
            }
            writer
                .start_file(part, opts)
                .map_err(|e| format!("Failed creating ZIP entry {part}: {e}"))?;
            if let Some(txt) = session.text_overrides.get(part) {
                writer
                    .write_all(txt.as_bytes())
                    .map_err(|e| format!("Failed writing ZIP entry {part}: {e}"))?;
            } else if let Some(raw) = session.raw_parts.get(part) {
                writer
                    .write_all(raw)
                    .map_err(|e| format!("Failed writing ZIP entry {part}: {e}"))?;
            }
        }
        writer
            .finish()
            .map_err(|e| format!("Failed finalizing XLSX ZIP: {e}"))?;
    }
    Ok(cursor.into_inner())
}

fn validate_xml_well_formed(xml: &str) -> Result<(), String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => stack.push(e.name().as_ref().to_owned()),
            Ok(Event::End(e)) => {
                let Some(open) = stack.pop() else {
                    return Err("Unexpected closing tag".to_owned());
                };
                if open.as_str() != e.name().as_ref() {
                    return Err("Mismatched XML closing tag".to_owned());
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }
    if !stack.is_empty() {
        return Err("Unclosed XML element".to_owned());
    }
    Ok(())
}

fn apply_xlsx_cell_op(
    session: &mut XlsxPatchSession,
    sheet_name: Option<&str>,
    address: &str,
    raw_input: &str,
) -> Result<(), (&'static str, String)> {
    let Some(addr) = parse_strict_a1_address(address) else {
        return Err(("parse_error", format!("Invalid cell address: {address}")));
    };
    let Some(part_path) = session.resolve_sheet_part(sheet_name) else {
        return Err((
            "not_found",
            format!("Sheet not found: {}", sheet_name.unwrap_or("(first sheet)")),
        ));
    };
    let sheet_xml = session
        .get_text_part(&part_path)
        .map_err(|m| ("parse_error", m))?
        .ok_or_else(|| {
            (
                "parse_error",
                format!("Worksheet part missing: {part_path}"),
            )
        })?;

    let cell_ref = encode_cell_address(addr);
    let style_attr = read_cell_style_attr(&sheet_xml, &cell_ref);
    let cell_xml = encode_cell_xml(&cell_ref, &style_attr, raw_input);
    let next_xml =
        apply_cell_edit(&sheet_xml, addr, &cell_ref, &cell_xml).map_err(|m| ("parse_error", m))?;
    session.set_text_part(&part_path, next_xml);
    session.dirty_sheets.insert(part_path);
    Ok(())
}

fn apply_xlsx_format_op(
    session: &mut XlsxPatchSession,
    sheet_name: Option<&str>,
    range_str: &str,
    patch: &SpreadsheetCellStylePatch,
) -> Result<(), (&'static str, String)> {
    let Some(range) = parse_cell_range(range_str) else {
        return Err(("parse_error", format!("Invalid cell range: {range_str}")));
    };
    let cell_count =
        (range.end.row - range.start.row + 1).saturating_mul(range.end.col - range.start.col + 1);
    if cell_count > 50_000 {
        return Err((
            "parse_error",
            "Formatting ranges are limited to 50,000 cells per request.".to_owned(),
        ));
    }
    let Some(part_path) = session.resolve_sheet_part(sheet_name) else {
        return Err((
            "not_found",
            format!("Sheet not found: {}", sheet_name.unwrap_or("(first sheet)")),
        ));
    };
    let mut sheet_xml = session
        .get_text_part(&part_path)
        .map_err(|m| ("parse_error", m))?
        .ok_or_else(|| {
            (
                "parse_error",
                format!("Worksheet part missing: {part_path}"),
            )
        })?;

    session.ensure_styles().map_err(|m| ("parse_error", m))?;
    let mut style_cache: BTreeMap<usize, usize> = BTreeMap::new();

    for row in range.start.row..=range.end.row {
        for col in range.start.col..=range.end.col {
            let coords = CellCoords { row, col };
            let cell_ref = encode_cell_address(coords);
            let base_style = read_cell_style_index(&sheet_xml, &cell_ref).unwrap_or(0);
            let next_style = if let Some(&cached) = style_cache.get(&base_style) {
                cached
            } else {
                let computed = session
                    .styles_editor
                    .as_mut()
                    .unwrap()
                    .apply_patch(base_style, patch)
                    .map_err(|m| ("write_error", m))?;
                style_cache.insert(base_style, computed);
                computed
            };
            sheet_xml = apply_cell_style(&sheet_xml, coords, &cell_ref, next_style)
                .map_err(|m| ("parse_error", m))?;
        }
    }

    session.set_text_part(&part_path, sheet_xml);
    session.dirty_sheets.insert(part_path);
    session.styles_dirty = true;
    Ok(())
}

fn apply_xlsx_merge_op(
    session: &mut XlsxPatchSession,
    sheet_name: Option<&str>,
    range_str: &str,
    merged: bool,
) -> Result<(), (&'static str, String)> {
    let Some(range) = parse_cell_range(range_str) else {
        return Err(("parse_error", format!("Invalid cell range: {range_str}")));
    };
    let Some(part_path) = session.resolve_sheet_part(sheet_name) else {
        return Err((
            "not_found",
            format!("Sheet not found: {}", sheet_name.unwrap_or("(first sheet)")),
        ));
    };
    let sheet_xml = session
        .get_text_part(&part_path)
        .map_err(|m| ("parse_error", m))?
        .ok_or_else(|| {
            (
                "parse_error",
                format!("Worksheet part missing: {part_path}"),
            )
        })?;

    let updated =
        apply_worksheet_merge(&sheet_xml, range, merged).map_err(|m| ("parse_error", m))?;
    session.set_text_part(&part_path, updated);
    session.dirty_sheets.insert(part_path);
    Ok(())
}

fn apply_xlsx_col_width_op(
    session: &mut XlsxPatchSession,
    sheet_name: Option<&str>,
    col: usize,
    width_px: Option<f64>,
) -> Result<(), (&'static str, String)> {
    if col >= MAX_SPREADSHEET_COLS {
        return Err(("parse_error", format!("Invalid column index: {col}")));
    }
    if let Some(w) = width_px
        && (!w.is_finite() || w <= 0.0 || w > MAX_COLUMN_WIDTH_PX)
    {
        return Err(("parse_error", format!("Invalid column width: {w}")));
    }
    let Some(part_path) = session.resolve_sheet_part(sheet_name) else {
        return Err((
            "not_found",
            format!("Sheet not found: {}", sheet_name.unwrap_or("(first sheet)")),
        ));
    };
    let sheet_xml = session
        .get_text_part(&part_path)
        .map_err(|m| ("parse_error", m))?
        .ok_or_else(|| {
            (
                "parse_error",
                format!("Worksheet part missing: {part_path}"),
            )
        })?;

    let updated =
        apply_worksheet_col_width(&sheet_xml, col, width_px).map_err(|m| ("parse_error", m))?;
    session.set_text_part(&part_path, updated);
    session.dirty_sheets.insert(part_path);
    Ok(())
}

fn invalidate_formula_caches(session: &mut XlsxPatchSession) -> Result<(), String> {
    let mut found_formula = false;
    let ws_parts: Vec<String> = session
        .part_order
        .iter()
        .filter(|p| {
            p.starts_with("xl/worksheets/")
                && p.ends_with(".xml")
                && !p["xl/worksheets/".len()..].contains('/')
        })
        .cloned()
        .collect();

    for part in ws_parts {
        let Some(sheet_xml) = session.get_text_part(&part)? else {
            continue;
        };
        let (updated, had_f) = clear_formula_cached_values(&sheet_xml);
        found_formula = found_formula || had_f;
        if updated != sheet_xml {
            session.set_text_part(&part, updated);
            session.dirty_sheets.insert(part);
        }
    }

    let had_calc_chain = session.raw_parts.contains_key("xl/calcChain.xml")
        && !session.removed_parts.contains("xl/calcChain.xml");
    if had_calc_chain {
        session.removed_parts.insert("xl/calcChain.xml".to_owned());
        session.text_overrides.remove("xl/calcChain.xml");
        session.workbook_dirty = true;
    }

    if !found_formula && !had_calc_chain {
        return Ok(());
    }

    if let Some(ct_xml) = session.get_text_part("[Content_Types].xml")? {
        let next = remove_calc_chain_content_type(&ct_xml);
        if next != ct_xml {
            session.set_text_part("[Content_Types].xml", next);
            session.workbook_dirty = true;
        }
    }
    if let Some(rels_xml) = session.get_text_part("xl/_rels/workbook.xml.rels")? {
        let next = remove_calc_chain_relationship(&rels_xml);
        if next != rels_xml {
            session.set_text_part("xl/_rels/workbook.xml.rels", next);
            session.workbook_dirty = true;
        }
    }
    if let Some(wb_xml) = session.get_text_part("xl/workbook.xml")? {
        let next = mark_workbook_calc_pr(&wb_xml);
        if next != wb_xml {
            session.set_text_part("xl/workbook.xml", next);
            session.workbook_dirty = true;
        }
    }
    Ok(())
}

fn clear_formula_cached_values(xml: &str) -> (String, bool) {
    static CELL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static F_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static V_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let cell_re = CELL_RE.get_or_init(|| Regex::new(r"(?s)<c\b[^>]*>.*?</c>").unwrap());
    let f_re = F_RE.get_or_init(|| Regex::new(r"<f\b").unwrap());
    let v_re = V_RE.get_or_init(|| Regex::new(r"(?s)<v>.*?</v>").unwrap());

    let mut found = false;
    let out = cell_re.replace_all(xml, |caps: &regex::Captures<'_>| {
        let cell_xml = &caps[0];
        if !f_re.is_match(cell_xml) {
            return cell_xml.to_owned();
        }
        found = true;
        v_re.replace_all(cell_xml, "").into_owned()
    });
    (out.into_owned(), found)
}

fn remove_calc_chain_content_type(xml: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r#"(?s)<Override\b[^>]*PartName="/xl/calcChain\.xml"[^>]*(?:/>|>.*?</Override>)"#,
        )
        .unwrap()
    });
    re.replace_all(xml, "").into_owned()
}

fn remove_calc_chain_relationship(xml: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"<Relationship\b[^>]*/>"#).unwrap());
    re.replace_all(xml, |caps: &regex::Captures<'_>| {
        let tag = &caps[0];
        if tag.contains("/calcChain\"") || tag.contains("Target=\"calcChain.xml\"") {
            String::new()
        } else {
            tag.to_owned()
        }
    })
    .into_owned()
}

fn mark_workbook_calc_pr(xml: &str) -> String {
    const CALC_PR: &str = r#"<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>"#;
    static SELF_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static FULL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let self_re = SELF_RE.get_or_init(|| Regex::new(r"<calcPr\b[^>]*/>").unwrap());
    if self_re.is_match(xml) {
        return self_re.replace(xml, CALC_PR).into_owned();
    }
    let full_re = FULL_RE.get_or_init(|| Regex::new(r"(?s)<calcPr\b[^>]*>.*?</calcPr>").unwrap());
    if full_re.is_match(xml) {
        return full_re.replace(xml, CALC_PR).into_owned();
    }
    xml.replacen("</workbook>", &format!("{CALC_PR}</workbook>"), 1)
}

fn register_styles_part(session: &mut XlsxPatchSession) -> Result<bool, String> {
    let mut changed = false;
    if let Some(ct_xml) = session.get_text_part("[Content_Types].xml")?
        && !ct_xml.contains(r#"PartName="/xl/styles.xml""#)
    {
        let next = ct_xml.replacen(
                "</Types>",
                &format!(
                    r#"<Override PartName="/xl/styles.xml" ContentType="{OOXML_STYLES_CONTENT_TYPE}"/></Types>"#
                ),
                1,
            );
        if next != ct_xml {
            session.set_text_part("[Content_Types].xml", next);
            changed = true;
        }
    }
    if let Some(rels_xml) = session.get_text_part("xl/_rels/workbook.xml.rels")?
        && !rels_xml.contains(&format!(r#"Type="{OOXML_STYLES_REL_TYPE}""#))
        && !rels_xml.contains(r#"Target="styles.xml""#)
    {
        static RID_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let rid_re = RID_RE.get_or_init(|| Regex::new(r#"\bId="rId(\d+)""#).unwrap());
        let max_id = rid_re
            .captures_iter(&rels_xml)
            .filter_map(|c| c.get(1)?.as_str().parse::<usize>().ok())
            .max()
            .unwrap_or(0);
        let rel_tag = format!(
            r#"<Relationship Id="rId{}" Type="{OOXML_STYLES_REL_TYPE}" Target="styles.xml"/>"#,
            max_id + 1
        );
        let next = if rels_xml.contains("</Relationships>") {
            rels_xml.replacen("</Relationships>", &format!("{rel_tag}</Relationships>"), 1)
        } else {
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{OOXML_RELATIONSHIPS_NS}">{rel_tag}</Relationships>"#
            )
        };
        session.set_text_part("xl/_rels/workbook.xml.rels", next);
        changed = true;
    }
    Ok(changed)
}

// --- Worksheet XML Surgical Edits ---

fn find_cell_span(xml: &str, cell_ref: &str) -> Option<(usize, usize, bool)> {
    let pattern = format!(
        r#"<c\b[^>]*\br="{}"(?:\s[^>]*)?(?:/>|>[\s\S]*?</c>)"#,
        regex::escape(cell_ref)
    );
    let re = Regex::new(&pattern).ok()?;
    let m = re.find(xml)?;
    let self_closing = m.as_str().ends_with("/>");
    Some((m.start(), m.end(), self_closing))
}

fn read_cell_style_attr(sheet_xml: &str, cell_ref: &str) -> String {
    read_cell_style_index_raw(sheet_xml, cell_ref)
        .map(|s| format!(r#"s="{s}""#))
        .unwrap_or_default()
}

fn read_cell_style_index(sheet_xml: &str, cell_ref: &str) -> Option<usize> {
    read_cell_style_index_raw(sheet_xml, cell_ref)?.parse().ok()
}

fn read_cell_style_index_raw(sheet_xml: &str, cell_ref: &str) -> Option<String> {
    let (start, end, _) = find_cell_span(sheet_xml, cell_ref)?;
    let cell_slice = &sheet_xml[start..end];
    let open_end = cell_slice.find('>')?;
    get_xml_attr(&cell_slice[..=open_end], "s")
}

fn get_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let re = Regex::new(&format!(
        r#"\b{}\s*=\s*"([^"]*)""#,
        regex::escape(attr_name)
    ))
    .ok()?;
    re.captures(tag)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn encode_cell_xml(cell_ref: &str, style_attr: &str, raw_input: &str) -> String {
    let s = if style_attr.is_empty() {
        String::new()
    } else {
        format!(" {style_attr}")
    };
    if raw_input.is_empty() {
        return format!(r#"<c r="{cell_ref}"{s}/>"#);
    }
    if let Some(formula) = raw_input.strip_prefix('=') {
        return format!(
            r#"<c r="{cell_ref}"{s}><f>{}</f></c>"#,
            escape_xml_text(formula)
        );
    }
    let trimmed = raw_input.trim();
    static NUM_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let num_re = NUM_RE.get_or_init(|| Regex::new(r"^-?(?:\d+(?:\.\d+)?|\.\d+)$").unwrap());
    if num_re.is_match(trimmed) {
        return format!(r#"<c r="{cell_ref}"{s}><v>{trimmed}</v></c>"#);
    }
    let needs_preserve = raw_input.starts_with(char::is_whitespace)
        || raw_input.ends_with(char::is_whitespace)
        || raw_input.contains('\r')
        || raw_input.contains('\n');
    let space = if needs_preserve {
        r#" xml:space="preserve""#
    } else {
        ""
    };
    format!(
        r#"<c r="{cell_ref}"{s} t="inlineStr"><is><t{space}>{}</t></is></c>"#,
        escape_xml_text(raw_input)
    )
}

fn apply_cell_edit(
    xml: &str,
    addr: CellCoords,
    cell_ref: &str,
    cell_xml: &str,
) -> Result<String, String> {
    if let Some((start, end, _)) = find_cell_span(xml, cell_ref) {
        let mut out = String::with_capacity(xml.len() + cell_xml.len());
        out.push_str(&xml[..start]);
        out.push_str(cell_xml);
        out.push_str(&xml[end..]);
        return Ok(maybe_expand_dimension(&out, addr));
    }
    let inserted = insert_cell_sorted(xml, addr, cell_xml)?;
    Ok(maybe_expand_dimension(&inserted, addr))
}

fn apply_cell_style(
    xml: &str,
    addr: CellCoords,
    cell_ref: &str,
    style_index: usize,
) -> Result<String, String> {
    if let Some((start, end, _)) = find_cell_span(xml, cell_ref) {
        let updated_cell = set_cell_style_on_fragment(&xml[start..end], style_index);
        let mut out = String::with_capacity(xml.len() + 16);
        out.push_str(&xml[..start]);
        out.push_str(&updated_cell);
        out.push_str(&xml[end..]);
        return Ok(maybe_expand_dimension(&out, addr));
    }
    let inserted = insert_cell_sorted(
        xml,
        addr,
        &format!(r#"<c r="{cell_ref}" s="{style_index}"/>"#),
    )?;
    Ok(maybe_expand_dimension(&inserted, addr))
}

fn set_cell_style_on_fragment(cell_xml: &str, style_index: usize) -> String {
    let Some(open_end) = cell_xml.find('>') else {
        return cell_xml.to_owned();
    };
    let open_tag = &cell_xml[..=open_end];
    static S_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let s_re = S_RE.get_or_init(|| Regex::new(r#"\s+s="[^"]*""#).unwrap());
    let without_s = s_re.replace(open_tag, "");
    let styled_open = if let Some(prefix) = without_s.strip_suffix("/>") {
        format!(r#"{prefix} s="{style_index}"/>"#)
    } else if let Some(prefix) = without_s.strip_suffix('>') {
        format!(r#"{prefix} s="{style_index}">"#)
    } else {
        without_s.into_owned()
    };
    format!("{styled_open}{}", &cell_xml[open_end + 1..])
}

fn insert_cell_sorted(xml: &str, addr: CellCoords, cell_xml: &str) -> Result<String, String> {
    let row_num = addr.row + 1;
    let row_re = Regex::new(&format!(r#"<row\b[^>]*\br="{row_num}"(?:\s[^>]*)?/?>"#)).unwrap();
    if let Some(m) = row_re.find(xml) {
        let open_tag = m.as_str();
        if let Some(prefix) = open_tag.strip_suffix("/>") {
            let expanded = format!("{prefix}>{cell_xml}</row>");
            return Ok(format!(
                "{}{expanded}{}",
                &xml[..m.start()],
                &xml[m.end()..]
            ));
        }
        let inner_start = m.end();
        let Some(rel_end) = xml[inner_start..].find("</row>") else {
            return Err(format!("Row {row_num} is not closed."));
        };
        let inner_end = inner_start + rel_end;
        let inner = &xml[inner_start..inner_end];
        let offset = find_cell_insert_offset(inner, addr.col);
        let mut out = String::with_capacity(xml.len() + cell_xml.len());
        out.push_str(&xml[..inner_start + offset]);
        out.push_str(cell_xml);
        out.push_str(&xml[inner_start + offset..]);
        return Ok(out);
    }

    let new_row = format!(r#"<row r="{row_num}">{cell_xml}</row>"#);
    static EMPTY_SD_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let empty_sd_re = EMPTY_SD_RE.get_or_init(|| Regex::new(r"<sheetData\s*/>").unwrap());
    if empty_sd_re.is_match(xml) {
        return Ok(empty_sd_re
            .replace(xml, format!("<sheetData>{new_row}</sheetData>"))
            .into_owned());
    }
    static SD_OPEN_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let sd_open_re = SD_OPEN_RE.get_or_init(|| Regex::new(r"<sheetData\b[^>]*>").unwrap());
    let Some(sd_m) = sd_open_re.find(xml) else {
        return Err("Worksheet has no <sheetData> element.".to_owned());
    };
    let inner_start = sd_m.end();
    let Some(rel_end) = xml[inner_start..].find("</sheetData>") else {
        return Err("Worksheet <sheetData> is not closed.".to_owned());
    };
    let inner_end = inner_start + rel_end;
    let inner = &xml[inner_start..inner_end];
    let offset = find_row_insert_offset(inner, row_num);
    let mut out = String::with_capacity(xml.len() + new_row.len());
    out.push_str(&xml[..inner_start + offset]);
    out.push_str(&new_row);
    out.push_str(&xml[inner_start + offset..]);
    Ok(out)
}

fn find_cell_insert_offset(row_inner: &str, col: usize) -> usize {
    static CELL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let cell_re = CELL_RE.get_or_init(|| {
        Regex::new(r#"(?s)<c\b[^>]*?\br="([A-Z]+\d+)"[^>]*?(?:/>|>.*?</c>)"#).unwrap()
    });
    for caps in cell_re.captures_iter(row_inner) {
        if let Some(r_attr) = caps.get(1)
            && let Some(coords) = parse_strict_a1_address(r_attr.as_str())
            && coords.col > col
        {
            return caps.get(0).unwrap().start();
        }
    }
    row_inner.len()
}

fn find_row_insert_offset(sheet_data_inner: &str, row_num: usize) -> usize {
    static ROW_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let row_re = ROW_RE.get_or_init(|| Regex::new(r#"<row\b[^>]*?\br="(\d+)"[^>]*?>"#).unwrap());
    for caps in row_re.captures_iter(sheet_data_inner) {
        if let Some(r_attr) = caps.get(1)
            && let Ok(r) = r_attr.as_str().parse::<usize>()
            && r > row_num
        {
            return caps.get(0).unwrap().start();
        }
    }
    sheet_data_inner.len()
}

fn maybe_expand_dimension(xml: &str, addr: CellCoords) -> String {
    static DIM_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let dim_re =
        DIM_RE.get_or_init(|| Regex::new(r#"<dimension\b[^>]*\bref="([^"]+)"[^>]*/>"#).unwrap());
    let Some(caps) = dim_re.captures(xml) else {
        return xml.to_owned();
    };
    let Some(mut range) = parse_cell_range(&caps[1]) else {
        return xml.to_owned();
    };
    let mut changed = false;
    if addr.row < range.start.row {
        range.start.row = addr.row;
        changed = true;
    }
    if addr.col < range.start.col {
        range.start.col = addr.col;
        changed = true;
    }
    if addr.row > range.end.row {
        range.end.row = addr.row;
        changed = true;
    }
    if addr.col > range.end.col {
        range.end.col = addr.col;
        changed = true;
    }
    if !changed {
        return xml.to_owned();
    }
    let m = caps.get(0).unwrap();
    format!(
        r#"{}<dimension ref="{}"/>{}"#,
        &xml[..m.start()],
        encode_cell_range(range),
        &xml[m.end()..]
    )
}

fn apply_worksheet_merge(
    xml: &str,
    range: CellRangeCoords,
    merged: bool,
) -> Result<String, String> {
    let range_ref = encode_cell_range(range);
    static FULL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static SELF_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static ITEM_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let full_re =
        FULL_RE.get_or_init(|| Regex::new(r"(?s)<mergeCells\b[^>]*>(.*?)</mergeCells>").unwrap());
    let self_re = SELF_RE.get_or_init(|| Regex::new(r"<mergeCells\b[^>]*/>").unwrap());
    let item_re =
        ITEM_RE.get_or_init(|| Regex::new(r#"<mergeCell\b[^>]*\bref="([^"]+)"[^>]*/?>"#).unwrap());

    let (existing_span, existing_refs): (Option<(usize, usize)>, Vec<String>) =
        if let Some(caps) = full_re.captures(xml) {
            let m = caps.get(0).unwrap();
            let refs = item_re
                .captures_iter(&caps[1])
                .filter_map(|c| c.get(1).map(|v| v.as_str().to_owned()))
                .collect();
            (Some((m.start(), m.end())), refs)
        } else if let Some(m) = self_re.find(xml) {
            (Some((m.start(), m.end())), Vec::new())
        } else {
            (None, Vec::new())
        };

    let mut next_refs: Vec<String> = existing_refs
        .into_iter()
        .filter(|r| !r.eq_ignore_ascii_case(&range_ref))
        .collect();
    if merged {
        next_refs.push(range_ref);
    }

    let next_xml = if next_refs.is_empty() {
        String::new()
    } else {
        let items: String = next_refs
            .iter()
            .map(|r| format!(r#"<mergeCell ref="{r}"/>"#))
            .collect();
        format!(
            r#"<mergeCells count="{}">{items}</mergeCells>"#,
            next_refs.len()
        )
    };

    let updated = if let Some((s, e)) = existing_span {
        format!("{}{next_xml}{}", &xml[..s], &xml[e..])
    } else if !next_xml.is_empty() {
        let close_tag = "</sheetData>";
        let Some(pos) = xml.find(close_tag) else {
            return Err("Worksheet <sheetData> is not closed.".to_owned());
        };
        let insert_at = pos + close_tag.len();
        format!("{}{next_xml}{}", &xml[..insert_at], &xml[insert_at..])
    } else {
        xml.to_owned()
    };

    if !merged {
        return Ok(updated);
    }
    let exp1 = maybe_expand_dimension(&updated, range.start);
    Ok(maybe_expand_dimension(&exp1, range.end))
}

fn apply_worksheet_col_width(
    xml: &str,
    col: usize,
    width_px: Option<f64>,
) -> Result<String, String> {
    let col_idx = col + 1;
    let col_xml = width_px.map(|px| {
        format!(
            r#"<col min="{col_idx}" max="{col_idx}" width="{}" customWidth="1"/>"#,
            encode_column_width(px)
        )
    });
    static COLS_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let cols_re = COLS_RE.get_or_init(|| Regex::new(r"(?s)<cols\b[^>]*>(.*?)</cols>").unwrap());
    if let Some(caps) = cols_re.captures(xml) {
        let m = caps.get(0).unwrap();
        let next_inner = rewrite_cols_inner(&caps[1], col_idx, col_xml.as_deref());
        let replacement = if next_inner.trim().is_empty() {
            String::new()
        } else {
            format!("<cols>{next_inner}</cols>")
        };
        return Ok(format!(
            "{}{replacement}{}",
            &xml[..m.start()],
            &xml[m.end()..]
        ));
    }
    let Some(col_xml) = col_xml else {
        return Ok(xml.to_owned());
    };
    let Some(insert_at) = xml.find("<sheetData") else {
        return Err("Worksheet has no <sheetData> element.".to_owned());
    };
    Ok(format!(
        "{}<cols>{col_xml}</cols>{}",
        &xml[..insert_at],
        &xml[insert_at..]
    ))
}

fn rewrite_cols_inner(inner: &str, col_idx: usize, col_xml: Option<&str>) -> String {
    static COL_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let col_re = COL_RE.get_or_init(|| Regex::new(r"<col\b[^>]*/?>").unwrap());
    let mut parts = Vec::new();
    let mut cursor = 0usize;
    let mut inserted = false;
    for m in col_re.find_iter(inner) {
        parts.push(inner[cursor..m.start()].to_owned());
        let tag = m.as_str();
        let min_v = get_xml_attr(tag, "min").and_then(|s| s.parse::<usize>().ok());
        let max_v = get_xml_attr(tag, "max").and_then(|s| s.parse::<usize>().ok());
        match (min_v, max_v) {
            (Some(min), Some(max)) => {
                if col_idx < min {
                    if !inserted && let Some(cx) = col_xml {
                        parts.push(cx.to_owned());
                        inserted = true;
                    }
                    parts.push(tag.to_owned());
                } else if col_idx > max {
                    parts.push(tag.to_owned());
                } else {
                    if min < col_idx {
                        parts.push(set_col_range_attrs(tag, min, col_idx - 1));
                    }
                    if !inserted && let Some(cx) = col_xml {
                        parts.push(cx.to_owned());
                        inserted = true;
                    }
                    if col_idx < max {
                        parts.push(set_col_range_attrs(tag, col_idx + 1, max));
                    }
                }
            }
            _ => parts.push(tag.to_owned()),
        }
        cursor = m.end();
    }
    parts.push(inner[cursor..].to_owned());
    if !inserted && let Some(cx) = col_xml {
        parts.push(cx.to_owned());
    }
    parts.join("")
}

fn set_col_range_attrs(tag: &str, min: usize, max: usize) -> String {
    static MIN_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static MAX_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let min_re = MIN_RE.get_or_init(|| Regex::new(r#"\bmin="[^"]*""#).unwrap());
    let max_re = MAX_RE.get_or_init(|| Regex::new(r#"\bmax="[^"]*""#).unwrap());
    let s1 = min_re.replace(tag, format!(r#"min="{min}""#));
    max_re.replace(&s1, format!(r#"max="{max}""#)).into_owned()
}

// --- Stylesheet XML DOM Editor ---

fn default_styles_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{OOXML_SPREADSHEET_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct XmlNode {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<XmlNode>,
    text: String,
}

impl XmlNode {
    fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            attrs: Vec::new(),
            children: Vec::new(),
            text: String::new(),
        }
    }

    fn with_attrs(name: impl Into<String>, attrs: &[(&str, &str)]) -> Self {
        Self {
            name: name.into(),
            attrs: attrs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            children: Vec::new(),
            text: String::new(),
        }
    }

    fn get_attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn set_attr(&mut self, key: &str, val: impl Into<String>) {
        let val = val.into();
        if let Some(pair) = self.attrs.iter_mut().find(|(k, _)| k == key) {
            pair.1 = val;
        } else {
            self.attrs.push((key.to_owned(), val));
        }
    }

    fn remove_attr(&mut self, key: &str) {
        self.attrs.retain(|(k, _)| k != key);
    }

    fn find_child_mut(&mut self, name: &str) -> Option<&mut XmlNode> {
        self.children.iter_mut().find(|c| c.name == name)
    }

    fn ensure_child_mut(&mut self, name: &str) -> &mut XmlNode {
        if !self.children.iter().any(|c| c.name == name) {
            self.children.push(XmlNode::new(name));
        }
        self.find_child_mut(name).unwrap()
    }

    fn remove_children_named(&mut self, name: &str) {
        self.children.retain(|c| c.name != name);
    }

    fn canonical_key(&self) -> String {
        let mut sorted_attrs = self.attrs.clone();
        sorted_attrs.sort();
        let attrs_str = sorted_attrs
            .iter()
            .map(|(k, v)| format!("{k}={v:?}"))
            .collect::<Vec<_>>()
            .join(",");
        let children_str = self
            .children
            .iter()
            .map(Self::canonical_key)
            .collect::<Vec<_>>()
            .join(",");
        format!("{}({attrs_str})[{children_str}]{:?}", self.name, self.text)
    }
}

struct StylesheetEditor {
    root: XmlNode,
    prefix: String,
}

impl StylesheetEditor {
    fn parse(xml: &str) -> Result<Self, String> {
        let root = parse_xml_tree(xml)?;
        if root.name != "styleSheet" && !root.name.ends_with(":styleSheet") {
            return Err("Workbook styles part has no styleSheet element.".to_owned());
        }
        let prefix = root.name[..root.name.len() - "styleSheet".len()].to_owned();
        let mut editor = Self { root, prefix };
        editor.ensure_sections();
        Ok(editor)
    }

    fn tag(&self, local: &str) -> String {
        format!("{}{local}", self.prefix)
    }

    fn ensure_sections(&mut self) {
        let ns_attr = if self.prefix.is_empty() {
            "xmlns".to_owned()
        } else {
            format!("xmlns:{}", self.prefix.trim_end_matches(':'))
        };
        if self.root.get_attr(&ns_attr).is_none() {
            self.root.set_attr(&ns_attr, OOXML_SPREADSHEET_NS);
        }
        let num_fmts_t = self.tag("numFmts");
        let fonts_t = self.tag("fonts");
        let fills_t = self.tag("fills");
        let borders_t = self.tag("borders");
        let csx_t = self.tag("cellStyleXfs");
        let cx_t = self.tag("cellXfs");
        let font_default = self.default_font();
        let fills_default = self.default_fills();
        let border_default = self.default_border();
        let xf_default = Self::default_xf(&self.tag("xf"));

        self.root.ensure_child_mut(&num_fmts_t);
        let fonts = self.root.ensure_child_mut(&fonts_t);
        if fonts.children.is_empty() {
            fonts.children.push(font_default);
        }
        let fills = self.root.ensure_child_mut(&fills_t);
        if fills.children.is_empty() {
            fills.children.extend(fills_default);
        }
        let borders = self.root.ensure_child_mut(&borders_t);
        if borders.children.is_empty() {
            borders.children.push(border_default);
        }
        let csx = self.root.ensure_child_mut(&csx_t);
        if csx.children.is_empty() {
            csx.children.push(xf_default.clone());
        }
        let cx = self.root.ensure_child_mut(&cx_t);
        if cx.children.is_empty() {
            cx.children.push(xf_default);
        }
        // Keep `<numFmts>`, `<fonts>`, `<fills>`, `<borders>`, `<cellStyleXfs>`, `<cellXfs>` in canonical OOXML order.
        let order = [num_fmts_t, fonts_t, fills_t, borders_t, csx_t, cx_t];
        self.root.children.sort_by_key(|c| {
            order
                .iter()
                .position(|n| n == &c.name)
                .unwrap_or(order.len())
        });
        self.sync_counts();
    }

    fn default_font(&self) -> XmlNode {
        let mut f = XmlNode::new(self.tag("font"));
        f.children
            .push(XmlNode::with_attrs(self.tag("sz"), &[("val", "11")]));
        f.children
            .push(XmlNode::with_attrs(self.tag("name"), &[("val", "Calibri")]));
        f
    }

    fn default_fill(&self) -> XmlNode {
        let mut fl = XmlNode::new(self.tag("fill"));
        fl.children.push(XmlNode::with_attrs(
            self.tag("patternFill"),
            &[("patternType", "none")],
        ));
        fl
    }

    fn default_fills(&self) -> Vec<XmlNode> {
        let mut gray = XmlNode::new(self.tag("fill"));
        gray.children.push(XmlNode::with_attrs(
            self.tag("patternFill"),
            &[("patternType", "gray125")],
        ));
        vec![self.default_fill(), gray]
    }

    fn default_border(&self) -> XmlNode {
        let mut b = XmlNode::new(self.tag("border"));
        for side in ["left", "right", "top", "bottom", "diagonal"] {
            b.children.push(XmlNode::new(self.tag(side)));
        }
        b
    }

    fn default_xf(tag_name: &str) -> XmlNode {
        XmlNode::with_attrs(
            tag_name,
            &[
                ("numFmtId", "0"),
                ("fontId", "0"),
                ("fillId", "0"),
                ("borderId", "0"),
                ("xfId", "0"),
            ],
        )
    }

    fn sync_counts(&mut self) {
        for sec in [
            "numFmts",
            "fonts",
            "fills",
            "borders",
            "cellStyleXfs",
            "cellXfs",
        ] {
            let t = self.tag(sec);
            if let Some(node) = self.root.find_child_mut(&t) {
                let len = node.children.len();
                if sec == "numFmts" && len == 0 {
                    node.remove_attr("count");
                } else {
                    node.set_attr("count", len.to_string());
                }
            }
        }
    }

    fn find_or_add(section: &mut XmlNode, candidate: XmlNode) -> usize {
        let key = candidate.canonical_key();
        if let Some(pos) = section
            .children
            .iter()
            .position(|c| c.canonical_key() == key)
        {
            return pos;
        }
        section.children.push(candidate);
        section.children.len() - 1
    }

    fn find_or_add_num_fmt(&mut self, pattern: &str) -> u32 {
        let nf_tag = self.tag("numFmt");
        let sec_tag = self.tag("numFmts");
        let sec = self.root.ensure_child_mut(&sec_tag);
        let mut max_next = 164u32;
        for child in &sec.children {
            if let Some(id) = child
                .get_attr("numFmtId")
                .and_then(|s| s.parse::<u32>().ok())
            {
                if child.get_attr("formatCode") == Some(pattern) {
                    return id;
                }
                max_next = max_next.max(id.saturating_add(1));
            }
        }
        sec.children.push(XmlNode::with_attrs(
            nf_tag,
            &[("numFmtId", &max_next.to_string()), ("formatCode", pattern)],
        ));
        max_next
    }

    fn apply_patch(
        &mut self,
        style_index: usize,
        patch: &SpreadsheetCellStylePatch,
    ) -> Result<usize, String> {
        let cx_tag = self.tag("cellXfs");
        let xf_tag = self.tag("xf");
        let fonts_tag = self.tag("fonts");
        let fills_tag = self.tag("fills");

        let mut base_xf = self
            .root
            .find_child_mut(&cx_tag)
            .and_then(|cx| cx.children.get(style_index).or_else(|| cx.children.first()))
            .cloned()
            .unwrap_or_else(|| Self::default_xf(&xf_tag));

        let font_id = base_xf
            .get_attr("fontId")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let fill_id = base_xf
            .get_attr("fillId")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);

        let default_font = self.default_font();
        let mut font = self
            .root
            .find_child_mut(&fonts_tag)
            .and_then(|f| f.children.get(font_id).or_else(|| f.children.first()))
            .cloned()
            .unwrap_or(default_font);

        let default_fill = self.default_fill();
        let mut fill = self
            .root
            .find_child_mut(&fills_tag)
            .and_then(|f| f.children.get(fill_id).or_else(|| f.children.first()))
            .cloned()
            .unwrap_or_else(|| default_fill.clone());

        let mut font_changed = false;
        let mut fill_changed = false;
        let mut align_changed = false;

        if let Some(bold_opt) = &patch.bold {
            font_changed = true;
            let b_tag = self.tag("b");
            font.remove_children_named(&b_tag);
            if *bold_opt == Some(true) {
                font.children.push(XmlNode::new(b_tag));
            }
        }
        if let Some(italic_opt) = &patch.italic {
            font_changed = true;
            let i_tag = self.tag("i");
            font.remove_children_named(&i_tag);
            if *italic_opt == Some(true) {
                font.children.push(XmlNode::new(i_tag));
            }
        }
        if let Some(sz_opt) = &patch.font_size {
            font_changed = true;
            let sz_tag = self.tag("sz");
            font.remove_children_named(&sz_tag);
            if let Some(sz) = sz_opt {
                font.children.push(XmlNode::with_attrs(
                    sz_tag,
                    &[("val", &format_style_number(*sz))],
                ));
            }
        }
        if let Some(tc_opt) = &patch.text_color {
            font_changed = true;
            let c_tag = self.tag("color");
            font.remove_children_named(&c_tag);
            if let Some(tc) = tc_opt {
                let rgb = normalize_style_color(tc)?;
                font.children
                    .push(XmlNode::with_attrs(c_tag, &[("rgb", &rgb)]));
            }
        }
        if let Some(fc_opt) = &patch.fill_color {
            fill_changed = true;
            match fc_opt {
                None => fill = default_fill,
                Some(fc) => {
                    let rgb = normalize_style_color(fc)?;
                    let mut pf =
                        XmlNode::with_attrs(self.tag("patternFill"), &[("patternType", "solid")]);
                    pf.children
                        .push(XmlNode::with_attrs(self.tag("fgColor"), &[("rgb", &rgb)]));
                    pf.children.push(XmlNode::with_attrs(
                        self.tag("bgColor"),
                        &[("indexed", "64")],
                    ));
                    let mut next_fill = XmlNode::new(self.tag("fill"));
                    next_fill.children.push(pf);
                    fill = next_fill;
                }
            }
        }
        if let Some(ha_opt) = &patch.horizontal_align {
            align_changed = true;
            let al_tag = self.tag("alignment");
            match ha_opt {
                None => {
                    if let Some(al) = base_xf.find_child_mut(&al_tag) {
                        al.remove_attr("horizontal");
                        if al.attrs.is_empty() && al.children.is_empty() {
                            base_xf.remove_children_named(&al_tag);
                        }
                    }
                    base_xf.remove_attr("applyAlignment");
                }
                Some(ha) => {
                    let al = base_xf.ensure_child_mut(&al_tag);
                    al.set_attr("horizontal", ha.clone());
                    base_xf.set_attr("applyAlignment", "1");
                }
            }
        }
        if let Some(nf_opt) = &patch.number_format {
            match nf_opt {
                None => {
                    base_xf.set_attr("numFmtId", "0");
                    base_xf.remove_attr("applyNumberFormat");
                }
                Some(pattern) => {
                    let id = self.find_or_add_num_fmt(pattern);
                    base_xf.set_attr("numFmtId", id.to_string());
                    base_xf.set_attr("applyNumberFormat", "1");
                }
            }
        }

        if font_changed {
            let fonts_sec = self.root.ensure_child_mut(&fonts_tag);
            let next_font_id = Self::find_or_add(fonts_sec, font);
            base_xf.set_attr("fontId", next_font_id.to_string());
            base_xf.set_attr("applyFont", "1");
        }
        if fill_changed {
            let fills_sec = self.root.ensure_child_mut(&fills_tag);
            let next_fill_id = Self::find_or_add(fills_sec, fill);
            base_xf.set_attr("fillId", next_fill_id.to_string());
            base_xf.set_attr("applyFill", "1");
        }
        let al_tag = self.tag("alignment");
        if align_changed && base_xf.find_child_mut(&al_tag).is_some() {
            base_xf.set_attr("applyAlignment", "1");
        }

        let cx_sec = self.root.ensure_child_mut(&cx_tag);
        let next_idx = Self::find_or_add(cx_sec, base_xf);
        self.sync_counts();
        Ok(next_idx)
    }

    fn to_xml(&self) -> String {
        let mut cloned = self.root.clone();
        // Omit empty `<numFmts/>` so Excel/SheetJS never choke on empty numFmts.
        let nf_tag = self.tag("numFmts");
        cloned
            .children
            .retain(|c| !(c.name == nf_tag && c.children.is_empty()));
        let mut writer = Writer::new(Cursor::new(Vec::new()));
        write_xml_node(&mut writer, &cloned);
        let body = String::from_utf8(writer.into_inner().into_inner()).unwrap_or_default();
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{body}"#)
    }
}

fn normalize_style_color(value: &str) -> Result<String, String> {
    let raw = value
        .trim()
        .strip_prefix('#')
        .unwrap_or(value.trim())
        .to_ascii_uppercase();
    if raw.len() == 6 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(format!("FF{raw}"));
    }
    if raw.len() == 8 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(raw);
    }
    Err(format!("Invalid spreadsheet color: {value}"))
}

fn format_style_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let rounded = (value * 100.0).round() / 100.0;
        rounded.to_string()
    }
}

fn parse_xml_tree(xml: &str) -> Result<XmlNode, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut stack: Vec<XmlNode> = Vec::new();
    let mut root: Option<XmlNode> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_owned();
                let mut attrs = Vec::new();
                for attr in e.attributes().flatten() {
                    let k = attr.key.as_ref().to_owned();
                    let v = unescape_xml_str(&attr.value);
                    attrs.push((k, v));
                }
                stack.push(XmlNode {
                    name,
                    attrs,
                    children: Vec::new(),
                    text: String::new(),
                });
            }
            Ok(Event::Empty(e)) => {
                let name = e.name().as_ref().to_owned();
                let mut attrs = Vec::new();
                for attr in e.attributes().flatten() {
                    let k = attr.key.as_ref().to_owned();
                    let v = unescape_xml_str(&attr.value);
                    attrs.push((k, v));
                }
                let node = XmlNode {
                    name,
                    attrs,
                    children: Vec::new(),
                    text: String::new(),
                };
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else {
                    root = Some(node);
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(top) = stack.last_mut() {
                    let s = super::zip_guard::decode_xml_text(&t);
                    if !s.trim().is_empty() {
                        top.text.push_str(&s);
                    }
                }
            }
            Ok(Event::End(_)) => {
                if let Some(node) = stack.pop() {
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(node);
                    } else {
                        root = Some(node);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    root.ok_or_else(|| "Empty XML document".to_owned())
}

fn write_xml_node(writer: &mut Writer<Cursor<Vec<u8>>>, node: &XmlNode) {
    let mut start = BytesStart::new(node.name.as_str());
    for (k, v) in &node.attrs {
        start.push_attribute((k.as_str(), v.as_str()));
    }
    if node.children.is_empty() && node.text.is_empty() {
        let _ = writer.write_event(Event::Empty(start));
    } else {
        let _ = writer.write_event(Event::Start(start));
        if !node.text.is_empty() {
            let _ = writer.write_event(Event::Text(BytesText::new(&node.text)));
        }
        for child in &node.children {
            write_xml_node(writer, child);
        }
        let _ = writer.write_event(Event::End(BytesEnd::new(node.name.as_str())));
    }
}
