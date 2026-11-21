//! Read-only spreadsheet preview decoder for `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.ods`, and `.csv`.
//!
//! File bytes must be supplied by `native::file_preview_read` after workspace path-boundary,
//! canonical identity, and `O_NOFOLLOW` checks.

use std::io::Cursor;
use std::path::Path;

use calamine::{
    Data, ExcelDateTime, Ods, Range, Reader, Sheets, Xls, Xlsb, Xlsx, open_workbook_auto_from_rs,
    open_workbook_from_rs,
};

use super::state::{
    MAX_PREVIEW_CELLS, MAX_PREVIEW_COLS, MAX_PREVIEW_ROWS, MAX_SHEET_TABS, SpreadsheetCellAlign,
    SpreadsheetPreviewData, SpreadsheetSheetData,
};

const MIN_DATA_COL_WIDTH: usize = 84;
const MAX_DATA_COL_WIDTH: usize = 240;

/// Decodes bounded bytes from an authorized spreadsheet file into [`SpreadsheetPreviewData`].
pub fn decode_spreadsheet_preview(
    safe_path: &Path,
    bytes: &[u8],
    byte_truncated: bool,
) -> Result<SpreadsheetPreviewData, String> {
    let ext = safe_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if ext == "csv" {
        return decode_csv_preview(safe_path, bytes, byte_truncated);
    }

    if byte_truncated {
        return Err(
            "Spreadsheet exceeds the 15 MiB inline preview limit. Open it in your default app instead."
                .to_string(),
        );
    }

    let mut workbook = open_workbook_for_extension(&ext, bytes)?;
    let sheet_names = workbook.sheet_names();
    let total_sheets = sheet_names.len();
    let sheets_truncated = total_sheets > MAX_SHEET_TABS;

    let mut sheets = Vec::with_capacity(total_sheets.min(MAX_SHEET_TABS));
    for name in sheet_names.into_iter().take(MAX_SHEET_TABS) {
        let range = workbook.worksheet_range(&name).map_err(|err| {
            format!(
                "Unable to preview sheet \"{name}\" ({err}). Open it in your default app instead."
            )
        })?;
        sheets.push(extract_calamine_sheet(name, &range));
    }

    let format = match ext.as_str() {
        "xlsx" | "xlsm" | "xlam" => ext.to_ascii_uppercase(),
        "xls" | "xla" => "XLS".to_string(),
        "xlsb" => "XLSB".to_string(),
        "ods" => "ODS".to_string(),
        _ => "XLSX".to_string(),
    };

    Ok(SpreadsheetPreviewData {
        format,
        sheets,
        total_sheets,
        sheets_truncated,
        max_rows_cap: MAX_PREVIEW_ROWS,
        max_cols_cap: MAX_PREVIEW_COLS,
        max_cells_cap: MAX_PREVIEW_CELLS,
    })
}

fn open_workbook_for_extension<'a>(
    ext: &str,
    bytes: &'a [u8],
) -> Result<Sheets<Cursor<&'a [u8]>>, String> {
    let cur = Cursor::new(bytes);
    let opened = match ext {
        "xls" | "xla" => open_workbook_from_rs::<Xls<_>, _>(cur)
            .map(Sheets::Xls)
            .map_err(|e| e.to_string()),
        "xlsx" | "xlsm" | "xlam" => open_workbook_from_rs::<Xlsx<_>, _>(cur)
            .map(Sheets::Xlsx)
            .map_err(|e| e.to_string()),
        "xlsb" => open_workbook_from_rs::<Xlsb<_>, _>(cur)
            .map(Sheets::Xlsb)
            .map_err(|e| e.to_string()),
        "ods" => open_workbook_from_rs::<Ods<_>, _>(cur)
            .map(Sheets::Ods)
            .map_err(|e| e.to_string()),
        _ => open_workbook_auto_from_rs(cur).map_err(|e| e.to_string()),
    };

    opened.map_err(|err| {
        format!("Unable to preview spreadsheet ({err}). Open it in your default app instead.")
    })
}

fn decode_csv_preview(
    safe_path: &Path,
    bytes: &[u8],
    byte_truncated: bool,
) -> Result<SpreadsheetPreviewData, String> {
    if bytes.contains(&0) {
        return Err(
            "CSV file contains binary data and cannot be previewed as a table. Open it in your default app instead."
                .to_string(),
        );
    }

    let utf8 = decode_utf8_prefix_for_csv(bytes, byte_truncated)?;
    let trimmed_bom = utf8.strip_prefix('\u{FEFF}').unwrap_or(utf8);
    let csv_text = if byte_truncated && !trimmed_bom.ends_with('\n') {
        match trimmed_bom.rfind('\n') {
            Some(idx) => &trimmed_bom[..=idx],
            None => trimmed_bom,
        }
    } else {
        trimmed_bom
    };

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(csv_text.as_bytes());

    let mut parsed_rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows: usize = 0;
    let mut total_cols: usize = 0;

    for result in reader.records() {
        let record = result.map_err(|err| format!("Unable to parse CSV preview: {err}"))?;
        total_rows += 1;
        total_cols = total_cols.max(record.len());

        let capped_cols = total_cols.clamp(1, MAX_PREVIEW_COLS);
        let max_kept_rows = MAX_PREVIEW_ROWS.min(MAX_PREVIEW_CELLS / capped_cols).max(1);
        if parsed_rows.len() < max_kept_rows {
            let row_vals = record
                .iter()
                .take(MAX_PREVIEW_COLS)
                .map(normalize_cell_whitespace)
                .collect();
            parsed_rows.push(row_vals);
        }
    }

    let col_count = total_cols.min(MAX_PREVIEW_COLS);
    let row_cap = MAX_PREVIEW_ROWS
        .min(MAX_PREVIEW_CELLS / col_count.max(1))
        .max(1);
    if parsed_rows.len() > row_cap {
        parsed_rows.truncate(row_cap);
    }
    for row_vals in &mut parsed_rows {
        row_vals.truncate(col_count);
        if row_vals.len() < col_count {
            row_vals.resize(col_count, String::new());
        }
    }

    let headers: Vec<String> = (0..col_count).map(excel_column_name).collect();
    let (col_alignments, col_widths) =
        compute_sheet_metrics(&headers, &parsed_rows, |_r, _c, val| {
            looks_numeric_text(val)
        });
    let rows_truncated = byte_truncated || total_rows > parsed_rows.len();
    let cols_truncated = total_cols > col_count;
    let cells_truncated = total_rows > parsed_rows.len() && parsed_rows.len() < MAX_PREVIEW_ROWS;

    let sheet_name = safe_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Sheet1")
        .to_string();

    Ok(SpreadsheetPreviewData {
        format: "CSV".to_string(),
        sheets: vec![SpreadsheetSheetData {
            name: sheet_name,
            headers,
            rows: parsed_rows,
            col_alignments,
            col_widths,
            total_rows,
            total_cols,
            start_row: 0,
            start_col: 0,
            rows_truncated,
            cols_truncated,
            cells_truncated,
        }],
        total_sheets: 1,
        sheets_truncated: false,
        max_rows_cap: MAX_PREVIEW_ROWS,
        max_cols_cap: MAX_PREVIEW_COLS,
        max_cells_cap: MAX_PREVIEW_CELLS,
    })
}

fn decode_utf8_prefix_for_csv(bytes: &[u8], byte_truncated: bool) -> Result<&str, String> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s),
        Err(err) if byte_truncated && err.error_len().is_none() && err.valid_up_to() > 0 => {
            std::str::from_utf8(&bytes[..err.valid_up_to()])
                .map_err(|_| "CSV file is not valid UTF-8.".to_string())
        }
        Err(_) => Err(
            "CSV file is not valid UTF-8 and cannot be previewed inline. Open it in your default app instead."
                .to_string(),
        ),
    }
}

fn extract_calamine_sheet(name: String, range: &Range<Data>) -> SpreadsheetSheetData {
    let (Some((sr_u32, sc_u32)), Some((er_u32, ec_u32))) = (range.start(), range.end()) else {
        return SpreadsheetSheetData {
            name,
            ..Default::default()
        };
    };

    let sr = sr_u32 as usize;
    let sc = sc_u32 as usize;
    let er = er_u32 as usize;
    let ec = ec_u32 as usize;

    // Anchor near A1 when leading empty margin is modest so row/column coords match Excel.
    let start_row = if sr <= 20 { 0 } else { sr };
    let start_col = if sc <= 10 { 0 } else { sc };

    let total_rows = er.saturating_sub(start_row) + 1;
    let total_cols = ec.saturating_sub(start_col) + 1;
    let col_count = total_cols.min(MAX_PREVIEW_COLS);
    let max_rows = MAX_PREVIEW_ROWS
        .min(MAX_PREVIEW_CELLS / col_count.max(1))
        .max(1);
    let row_count = total_rows.min(max_rows);

    let headers: Vec<String> = (0..col_count)
        .map(|c| excel_column_name(start_col + c))
        .collect();

    let mut rows = Vec::with_capacity(row_count);
    let mut cell_numeric = Vec::with_capacity(row_count);
    for r in 0..row_count {
        let abs_r = (start_row + r) as u32;
        let mut row_vals = Vec::with_capacity(col_count);
        let mut row_nums = Vec::with_capacity(col_count);
        for c in 0..col_count {
            let abs_c = (start_col + c) as u32;
            let cell = range.get_value((abs_r, abs_c));
            row_vals.push(cell.map(format_calamine_cell).unwrap_or_default());
            row_nums.push(cell.is_some_and(is_calamine_numeric));
        }
        rows.push(row_vals);
        cell_numeric.push(row_nums);
    }

    let (col_alignments, col_widths) = compute_sheet_metrics(&headers, &rows, |r, c, _val| {
        cell_numeric
            .get(r)
            .and_then(|row_nums| row_nums.get(c))
            .copied()
            .unwrap_or(false)
    });

    SpreadsheetSheetData {
        name,
        headers,
        rows,
        col_alignments,
        col_widths,
        total_rows,
        total_cols,
        start_row,
        start_col,
        rows_truncated: total_rows > row_count,
        cols_truncated: total_cols > col_count,
        cells_truncated: total_rows > row_count && row_count < MAX_PREVIEW_ROWS,
    }
}

fn compute_sheet_metrics(
    headers: &[String],
    rows: &[Vec<String>],
    is_numeric: impl Fn(usize, usize, &str) -> bool,
) -> (Vec<SpreadsheetCellAlign>, Vec<u16>) {
    let col_count = headers.len();
    let mut seen_non_empty_after_header = vec![false; col_count];
    let mut all_numeric_after_header = vec![true; col_count];
    let mut first_row_non_empty = vec![false; col_count];
    let mut first_row_numeric = vec![false; col_count];
    let mut max_chars: Vec<usize> = headers.iter().map(|h| h.chars().count()).collect();

    for (r, row_vals) in rows.iter().enumerate() {
        for c in 0..col_count {
            let val = row_vals.get(c).map(String::as_str).unwrap_or("");
            let char_len = val.chars().count();
            if char_len > max_chars[c] {
                max_chars[c] = char_len.min(36);
            }
            if !val.is_empty() {
                let numeric = is_numeric(r, c, val);
                if r == 0 {
                    first_row_non_empty[c] = true;
                    first_row_numeric[c] = numeric;
                } else {
                    seen_non_empty_after_header[c] = true;
                    if !numeric {
                        all_numeric_after_header[c] = false;
                    }
                }
            }
        }
    }

    let aligns = (0..col_count)
        .map(|c| {
            let numeric = if seen_non_empty_after_header[c] {
                all_numeric_after_header[c]
            } else {
                first_row_non_empty[c] && first_row_numeric[c]
            };
            if numeric {
                SpreadsheetCellAlign::Right
            } else {
                SpreadsheetCellAlign::Left
            }
        })
        .collect();

    let widths = max_chars
        .into_iter()
        .map(|chars| (chars * 8 + 26).clamp(MIN_DATA_COL_WIDTH, MAX_DATA_COL_WIDTH) as u16)
        .collect();

    (aligns, widths)
}

/// Returns true if a trimmed cell string represents a number, currency figure, or percentage.
pub(crate) fn looks_numeric_text(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let without_sign = trimmed
        .strip_prefix(['+', '-'])
        .unwrap_or(trimmed)
        .trim_start();
    let without_currency = without_sign
        .strip_prefix(['$', '€', '£', '¥'])
        .unwrap_or(without_sign)
        .trim_start();
    let clean = without_currency
        .strip_prefix(['+', '-'])
        .unwrap_or(without_currency);
    let clean = clean.strip_suffix('%').unwrap_or(clean).trim();
    let normalized = clean.replace(',', "");
    normalized.parse::<f64>().is_ok_and(f64::is_finite)
}

fn is_calamine_numeric(cell: &Data) -> bool {
    matches!(cell, Data::Int(_) | Data::Float(_))
}

fn format_calamine_cell(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => normalize_cell_whitespace(s),
        Data::Int(v) => v.to_string(),
        Data::Float(v) => format_float_cell(*v),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        Data::DateTime(dt) => format_excel_datetime(dt),
        Data::DateTimeIso(s) | Data::DurationIso(s) => normalize_cell_whitespace(s),
        Data::Error(err) => err.to_string(),
    }
}

fn format_float_cell(v: f64) -> String {
    if !v.is_finite() {
        return v.to_string();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    // Avoid noisy ".0" for exact whole Excel numeric floats up to safe integer range.
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{:.0}", v);
    }
    let raw = format!("{v:.10}");
    let trimmed = raw.trim_end_matches('0').trim_end_matches('.');
    trimmed.to_string()
}

fn format_excel_datetime(dt: &ExcelDateTime) -> String {
    if dt.is_duration() {
        let total_secs = (dt.as_f64() * 86_400.0).round() as i64;
        let sign = if total_secs < 0 { "-" } else { "" };
        let abs = total_secs.unsigned_abs();
        let hours = abs / 3600;
        let mins = (abs % 3600) / 60;
        let secs = abs % 60;
        return format!("{sign}{hours:02}:{mins:02}:{secs:02}");
    }

    let (year, month, day, hour, min, sec, _milli) = dt.to_ymd_hms_milli();
    if dt.as_f64() >= 0.0 && dt.as_f64() < 1.0 {
        format!("{hour:02}:{min:02}:{sec:02}")
    } else if hour == 0 && min == 0 && sec == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{min:02}:{sec:02}")
    }
}

fn normalize_cell_whitespace(raw: &str) -> String {
    if !raw.contains(['\r', '\n', '\t']) {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.chars() {
        if matches!(ch, '\r' | '\n' | '\t') {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

/// Converts a zero-based column index into an Excel column header (`0 -> "A"`, `26 -> "AA"`).
pub fn excel_column_name(mut index: usize) -> String {
    let mut chars = Vec::new();
    loop {
        let rem = index % 26;
        chars.push((b'A' + rem as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    chars.into_iter().rev().collect()
}
