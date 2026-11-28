//! Read-only spreadsheet preview renderer powered by `rune_kit::Table`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rune::{Align, El, GrowthSpec, ScrollSpec, col, el, icon, memo, row, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, Cell, ControlSize, Kit, SegmentedControl, Table,
    TableColumn, TableStyle,
};

use super::decoder::looks_numeric_text;
use super::state::{SpreadsheetCellAlign, SpreadsheetPreviewData, SpreadsheetSheetData};
use crate::state::{AppState, FilePreviewState};
use crate::theme::ThemeTokens;
use crate::views::chat::icons;

const ROW_INDEX_COL_ID: &str = "__row";
const MAX_RAW_CSV_LINE_CACHE_ENTRIES: usize = 4;

type CsvLineRanges = Arc<Vec<(usize, usize)>>;

#[derive(Clone)]
struct CachedCsvLines {
    rev: u64,
    raw: Arc<str>,
    ranges: CsvLineRanges,
}

#[derive(Default)]
struct RawCsvLineCacheState {
    next_rev: u64,
    entries: HashMap<(u64, usize), CachedCsvLines>,
}

thread_local! {
    static RAW_CSV_LINE_CACHE: RefCell<RawCsvLineCacheState> =
        RefCell::new(RawCsvLineCacheState::default());
}

/// Fast O(1) bucket hash for raw CSV buffers (always paired with exact string equality on lookup).
fn fast_text_fingerprint(raw: &str) -> u64 {
    let bytes = raw.as_bytes();
    let mut h = DefaultHasher::new();
    bytes.len().hash(&mut h);
    if bytes.len() <= 1024 {
        bytes.hash(&mut h);
    } else {
        bytes[..512].hash(&mut h);
        let mid = bytes.len() / 2;
        bytes[mid.saturating_sub(128)..(mid + 128).min(bytes.len())].hash(&mut h);
        bytes[bytes.len() - 512..].hash(&mut h);
    }
    h.finish()
}

/// Indexes line byte ranges `(start, end)` once per exact raw CSV string so Raw CSV mode
/// virtualizes by line safely without hash-collision slicing bugs.
fn cached_csv_line_ranges(raw: &str) -> CachedCsvLines {
    let key = (fast_text_fingerprint(raw), raw.len());
    RAW_CSV_LINE_CACHE.with(|slot| {
        let mut state = slot.borrow_mut();
        if let Some(existing) = state.entries.get(&key)
            && existing.raw.as_ref() == raw
        {
            return existing.clone();
        }
        if state.entries.len() >= MAX_RAW_CSV_LINE_CACHE_ENTRIES {
            state.entries.clear();
        }
        let bytes = raw.as_bytes();
        let mut ranges = Vec::new();
        if !bytes.is_empty() {
            let mut line_start = 0usize;
            for (idx, &b) in bytes.iter().enumerate() {
                if b == b'\n' {
                    let line_end = if idx > line_start && bytes[idx - 1] == b'\r' {
                        idx - 1
                    } else {
                        idx
                    };
                    ranges.push((line_start, line_end));
                    line_start = idx + 1;
                }
            }
            if line_start < bytes.len() {
                let mut line_end = bytes.len();
                if line_end > line_start && bytes[line_end - 1] == b'\r' {
                    line_end -= 1;
                }
                ranges.push((line_start, line_end));
            }
        }
        state.next_rev = state.next_rev.wrapping_add(1).max(1);
        let entry = CachedCsvLines {
            rev: state.next_rev,
            raw: Arc::from(raw),
            ranges: Arc::new(ranges),
        };
        state.entries.insert(key, entry.clone());
        entry
    })
}

/// Zero-allocation decimal parser for `c{N}` spreadsheet column identifiers.
#[inline]
fn parse_col_index(col_id: &str) -> Option<usize> {
    let bytes = col_id.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'c' {
        return None;
    }
    let mut idx: usize = 0;
    for &b in &bytes[1..] {
        if !b.is_ascii_digit() {
            return None;
        }
        idx = idx.checked_mul(10)?.checked_add((b - b'0') as usize)?;
    }
    Some(idx)
}

fn spreadsheet_memo_version(
    s: &AppState,
    preview: &FilePreviewState,
    data: &SpreadsheetPreviewData,
    active_idx: usize,
    raw_csv_rev: Option<u64>,
    t: &ThemeTokens,
) -> u64 {
    let mut h = DefaultHasher::new();
    (
        t.dark,
        t.accent.r.to_bits(),
        t.accent.g.to_bits(),
        t.accent.b.to_bits(),
        t.panel_bg.r.to_bits(),
        t.border_muted.a.to_bits(),
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        s.ui_scale.to_bits(),
    )
        .hash(&mut h);
    (
        preview.workspace_id.as_str(),
        preview.path.as_str(),
        preview.truncated,
        preview.content.is_some(),
        raw_csv_rev,
    )
        .hash(&mut h);
    (
        data.format.as_str(),
        data.total_sheets,
        data.sheets_truncated,
        data.max_rows_cap,
        data.max_cols_cap,
        data.max_cells_cap,
        data.sheets.len(),
        active_idx,
        s.preview_ui.raw_csv_mode,
        s.preview_ui.table_rev,
    )
        .hash(&mut h);
    for sheet in &data.sheets {
        (
            sheet.name.as_str(),
            sheet.headers.len(),
            sheet.rows.len(),
            sheet.total_rows,
            sheet.total_cols,
            sheet.start_row,
            sheet.start_col,
            sheet.rows_truncated,
            sheet.cols_truncated,
            sheet.cells_truncated,
        )
            .hash(&mut h);
    }
    if let Some(sheet) = data.sheets.get(active_idx) {
        sheet.headers.hash(&mut h);
        sheet.col_widths.hash(&mut h);
        for align in &sheet.col_alignments {
            matches!(align, SpreadsheetCellAlign::Right).hash(&mut h);
        }
        let row_len = sheet.rows.len();
        if row_len <= 16 {
            for r in &sheet.rows {
                r.hash(&mut h);
            }
        } else {
            for step in 0..16 {
                let idx = (step * (row_len - 1)) / 15;
                sheet.rows[idx].hash(&mut h);
            }
        }
    }
    h.finish()
}

fn active_sheet_from_state<'a>(
    s: &'a AppState,
    data: &'a SpreadsheetPreviewData,
) -> Option<&'a SpreadsheetSheetData> {
    if data.sheets.is_empty() {
        return None;
    }
    let idx = s.preview_ui.active_sheet.min(data.sheets.len() - 1);
    data.sheets.get(idx)
}

fn active_sheet_on_app(s: &AppState) -> Option<&SpreadsheetSheetData> {
    let sp = s
        .active_file_preview
        .as_ref()
        .and_then(|p| p.spreadsheet.as_ref())?;
    if sp.sheets.is_empty() {
        return None;
    }
    let idx = s.preview_ui.active_sheet.min(sp.sheets.len() - 1);
    sp.sheets.get(idx)
}

fn sheet_row_count(s: &AppState) -> usize {
    active_sheet_on_app(s).map_or(0, |sheet| sheet.rows.len())
}

fn sheet_row_id(_s: &AppState, i: usize) -> Cow<'_, str> {
    Cow::Owned(format!("r{i}"))
}

/// Renders the read-only spreadsheet preview body inside `inline-file-preview`.
pub fn render_spreadsheet_preview(
    s: &AppState,
    preview: &FilePreviewState,
    data: &SpreadsheetPreviewData,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let active_idx = if data.sheets.is_empty() {
        0
    } else {
        s.preview_ui.active_sheet.min(data.sheets.len() - 1)
    };
    let raw_csv_cache = if data.format == "CSV"
        && s.preview_ui.raw_csv_mode
        && let Some(raw_text) = preview.content.as_deref()
    {
        Some(cached_csv_line_ranges(raw_text))
    } else {
        None
    };
    let raw_csv_rev = raw_csv_cache.as_ref().map(|entry| entry.rev);
    let version = spreadsheet_memo_version(s, preview, data, active_idx, raw_csv_rev, t);
    memo("spreadsheet-preview-root", version, || {
        render_spreadsheet_preview_inner(s, preview, data, active_idx, raw_csv_cache, k, t)
    })
}

fn render_spreadsheet_preview_inner(
    s: &AppState,
    preview: &FilePreviewState,
    data: &SpreadsheetPreviewData,
    active_idx: usize,
    raw_csv_cache: Option<CachedCsvLines>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let active_sheet = active_sheet_from_state(s, data);

    let dim_summary = if let Some(sheet) = active_sheet {
        let rows_part = if sheet.rows_truncated {
            format!("{} of {} rows", sheet.rows.len(), sheet.total_rows)
        } else {
            format!(
                "{} {}",
                sheet.total_rows,
                if sheet.total_rows == 1 { "row" } else { "rows" }
            )
        };
        let cols_part = if sheet.cols_truncated {
            format!("{} of {} cols", sheet.headers.len(), sheet.total_cols)
        } else {
            format!(
                "{} {}",
                sheet.total_cols,
                if sheet.total_cols == 1 { "col" } else { "cols" }
            )
        };
        if data.total_sheets > 1 {
            format!("{} sheets · {rows_part} · {cols_part}", data.total_sheets)
        } else {
            format!("{rows_part} · {cols_part}")
        }
    } else {
        "Empty workbook".to_string()
    };

    let mut meta_bar = row()
        .key("spreadsheet-preview-meta")
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(8.0)
        .center_y()
        .child(icon(&icons::SPREADSHEET, 14.0).color(t.text_muted))
        .child(
            Badge::new(data.format.as_str())
                .variant(BadgeVariant::Subtle)
                .build(k),
        )
        .child(
            text(dim_summary)
                .font(t.caption)
                .color(t.text_muted)
                .truncate(),
        )
        .child(
            text(preview.path.as_str())
                .font(t.caption)
                .color(t.text_faint)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );

    if data.format == "CSV" && preview.content.is_some() {
        let mode_idx = usize::from(s.preview_ui.raw_csv_mode);
        meta_bar = meta_bar.child(
            SegmentedControl::new(&["Table", "Raw"], Some(mode_idx))
                .label("CSV view mode")
                .fit()
                .on_pick(|s: &mut AppState, idx, _tx| {
                    s.preview_ui.raw_csv_mode = idx == 1;
                })
                .build(k),
        );
    }

    let mut root = col()
        .w_full()
        .h_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .child(meta_bar)
        .child(el().w_full().h(1.0).fill(t.border_muted));

    if let Some(warning_msg) = build_cap_notice(preview, data, active_sheet) {
        root = root
            .child(
                row()
                    .key("spreadsheet-preview-cap-banner")
                    .w_full()
                    .px(12.0)
                    .py(6.0)
                    .gap(8.0)
                    .center_y()
                    .fill(t.warning.alpha(if t.dark { 0.14 } else { 0.10 }))
                    .child(icon(&icons::ALERT, 13.0).color(t.warning))
                    .child(
                        text(warning_msg)
                            .font(t.caption)
                            .color(t.warning)
                            .wrap()
                            .grow(1.0)
                            .min_w(0.0),
                    ),
            )
            .child(el().w_full().h(1.0).fill(t.border_muted));
    }

    if let Some(CachedCsvLines {
        raw: raw_arc,
        ranges: line_ranges,
        ..
    }) = raw_csv_cache
    {
        let line_count = line_ranges.len();
        let code_font = t.code;
        let text_color = t.text_base;
        let lines_col = col()
            .key("spreadsheet-preview-raw-csv-lines")
            .w_full()
            .padding(12.0)
            .gap(2.0)
            .growth(GrowthSpec::default())
            .virtual_rows(
                line_count,
                18.0,
                |_: &AppState, i| Cow::Owned(format!("csv-raw-line-{i}")),
                move |_: &AppState, i| {
                    let line = line_ranges
                        .get(i)
                        .and_then(|&(start, end)| raw_arc.get(start..end))
                        .unwrap_or("");
                    text(line).font(code_font).color(text_color).w_full()
                },
            );
        root = root.child(
            col()
                .key("spreadsheet-preview-raw-csv")
                .w_full()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .fill(t.panel_bg)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(lines_col),
        );
        return root;
    }

    let main_area = match active_sheet {
        None => el()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .center()
            .padding(20.0)
            .child(
                text("This workbook contains no worksheets.")
                    .font(t.body)
                    .color(t.text_muted),
            ),
        Some(sheet) if sheet.rows.is_empty() || sheet.headers.is_empty() => el()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .center()
            .padding(20.0)
            .child(
                text(format!("Sheet \"{}\" has no cells.", sheet.name))
                    .font(t.body)
                    .color(t.text_muted),
            ),
        Some(sheet) => render_sheet_table(s, active_idx, sheet, k),
    };

    root = root.child(main_area);

    if data.sheets.len() > 1 {
        let mut tabs_row = row()
            .key("spreadsheet-sheet-tabs")
            .w_full()
            .h(36.0)
            .px(8.0)
            .gap(4.0)
            .center_y()
            .fill(t.sidebar_bg)
            .scroll_x();

        for (idx, sheet) in data.sheets.iter().enumerate() {
            let selected = idx == active_idx;
            let btn = Button::new(sheet.name.clone())
                .variant(if selected {
                    ButtonVariant::Outline
                } else {
                    ButtonVariant::GhostMuted
                })
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.preview_ui.select_sheet(idx);
                })
                .build(k);
            tabs_row = tabs_row.child(el().key(format!("sheet-tab-{idx}")).child(btn));
        }

        if data.sheets_truncated {
            tabs_row = tabs_row.child(
                text(format!(
                    "+{} more",
                    data.total_sheets.saturating_sub(data.sheets.len())
                ))
                .font(t.caption)
                .color(t.text_faint)
                .px(6.0),
            );
        }

        root = root
            .child(el().w_full().h(1.0).fill(t.border_muted))
            .child(tabs_row);
    }

    root
}

fn render_sheet_table(s: &AppState, sheet_idx: usize, sheet: &SpreadsheetSheetData, k: &Kit) -> El {
    let mut style = TableStyle::from_kit(k);
    style.row_height = 26.0;
    style.header_height = 28.0;
    style.cell_pad = 10.0;

    let mut table = Table::new(
        |s: &AppState| &s.preview_ui.table,
        |s: &mut AppState| s.preview_ui.table_mut(),
        sheet_row_count,
        sheet_row_id,
    )
    .name(format!("Spreadsheet preview: {}", sheet.name))
    .zebra(true)
    .style(style)
    // Keep every column at its own width and scroll the header with the rows when they are wider
    // than the pane, so the columns past the right edge stay reachable; pin the row index.
    .scroll_wide(true)
    .frozen_columns(1)
    .column(
        TableColumn::new(ROW_INDEX_COL_ID, "#")
            .width(52.0)
            .min(44.0)
            .max(84.0)
            .align(Align::End),
    );

    let narrow_sheet = sheet.headers.len() <= 3;
    for (col_idx, header) in sheet.headers.iter().enumerate() {
        let base_w = sheet
            .col_widths
            .get(col_idx)
            .copied()
            .map(f32::from)
            .unwrap_or(110.0);
        let align = match sheet
            .col_alignments
            .get(col_idx)
            .copied()
            .unwrap_or_default()
        {
            SpreadsheetCellAlign::Right => Align::End,
            SpreadsheetCellAlign::Left => Align::Start,
        };
        let mut col_def = TableColumn::new(format!("c{col_idx}"), header.as_str())
            .align(align)
            .min(64.0);
        col_def = if narrow_sheet {
            col_def.flex(1.0).min(base_w.min(120.0))
        } else {
            col_def.width(base_w).max(360.0)
        };
        table = table.column(col_def);
    }

    table = table.cell(|s: &AppState, row_idx, col_id| {
        let Some(sheet) = active_sheet_on_app(s) else {
            return Cell::text("");
        };
        if col_id == ROW_INDEX_COL_ID {
            return Cell::text((sheet.start_row + row_idx + 1).to_string())
                .mono()
                .muted();
        }
        let Some(col_idx) = parse_col_index(col_id) else {
            return Cell::text("");
        };
        let val = sheet
            .rows
            .get(row_idx)
            .and_then(|r| r.get(col_idx))
            .map(String::as_str)
            .unwrap_or("");
        if val.is_empty() {
            return Cell::text("");
        }
        let align = sheet
            .col_alignments
            .get(col_idx)
            .copied()
            .unwrap_or_default();
        if align == SpreadsheetCellAlign::Right && looks_numeric_text(val) {
            Cell::text(val).mono()
        } else {
            Cell::text(val)
        }
    });

    col()
        .key(format!("spreadsheet-table-scroll-{sheet_idx}"))
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .child(el().w_full().h_full().min_h(0.0).child(table.build(s, k)))
}

fn build_cap_notice(
    preview: &FilePreviewState,
    data: &SpreadsheetPreviewData,
    active_sheet: Option<&SpreadsheetSheetData>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if preview.truncated {
        parts.push("file capped at 15 MiB".to_string());
    }
    if data.sheets_truncated {
        parts.push(format!(
            "showing {} of {} sheets",
            data.sheets.len(),
            data.total_sheets
        ));
    }
    if let Some(sheet) = active_sheet {
        if sheet.rows_truncated {
            parts.push(format!(
                "showing {} of {} rows",
                sheet.rows.len(),
                sheet.total_rows
            ));
        }
        if sheet.cols_truncated {
            parts.push(format!(
                "showing {} of {} columns",
                sheet.headers.len(),
                sheet.total_cols
            ));
        }
        if sheet.cells_truncated {
            parts.push(format!("{} cell limit", data.max_cells_cap));
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "Preview truncated ({}). Open in default app to inspect the full file.",
        parts.join(", ")
    ))
}
