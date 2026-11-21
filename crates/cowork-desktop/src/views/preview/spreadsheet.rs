//! Read-only spreadsheet preview renderer powered by `rune_kit::Table`.

use std::borrow::Cow;

use rune::{Align, El, ScrollSpec, col, el, icon, row, text};
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
        .key("spreadsheet-preview-root")
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

    if data.format == "CSV"
        && s.preview_ui.raw_csv_mode
        && let Some(raw_text) = preview.content.as_deref()
    {
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
                .padding(12.0)
                .child(
                    text(raw_text)
                        .font(t.code)
                        .color(t.text_base)
                        .wrap()
                        .w_full(),
                ),
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
        |s: &mut AppState| &mut s.preview_ui.table,
        sheet_row_count,
        sheet_row_id,
    )
    .name(format!("Spreadsheet preview: {}", sheet.name))
    .zebra(true)
    .style(style)
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
            return Cell::text(format!("{}", sheet.start_row + row_idx + 1))
                .mono()
                .muted();
        }
        let Some(col_idx) = col_id
            .strip_prefix('c')
            .and_then(|rest| rest.parse::<usize>().ok())
        else {
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
        .scroll_x()
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
