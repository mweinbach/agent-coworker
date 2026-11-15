//! Spreadsheet preview payload types and ephemeral preview UI state.

use rune_kit::TableState;
use serde::{Deserialize, Serialize};

/// Hard preview caps keeping large spreadsheets responsive and bounded in memory.
pub const MAX_PREVIEW_ROWS: usize = 500;
pub const MAX_PREVIEW_COLS: usize = 40;
pub const MAX_PREVIEW_CELLS: usize = 10_000;
pub const MAX_SHEET_TABS: usize = 32;

/// Horizontal text alignment inferred for a spreadsheet preview column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpreadsheetCellAlign {
    #[default]
    Left,
    Right,
}

/// Decoded, cap-bounded tabular data for a single worksheet or CSV file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheetData {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    #[serde(default)]
    pub col_alignments: Vec<SpreadsheetCellAlign>,
    #[serde(default)]
    pub col_widths: Vec<u16>,
    pub total_rows: usize,
    pub total_cols: usize,
    #[serde(default)]
    pub start_row: usize,
    #[serde(default)]
    pub start_col: usize,
    #[serde(default)]
    pub rows_truncated: bool,
    #[serde(default)]
    pub cols_truncated: bool,
    #[serde(default)]
    pub cells_truncated: bool,
}

impl SpreadsheetSheetData {
    /// Returns true if any dimension of this sheet hit a preview cap.
    pub fn is_truncated(&self) -> bool {
        self.rows_truncated || self.cols_truncated || self.cells_truncated
    }
}

/// Decoded workbook payload stored on `FilePreviewState::spreadsheet`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetPreviewData {
    pub format: String,
    pub sheets: Vec<SpreadsheetSheetData>,
    pub total_sheets: usize,
    #[serde(default)]
    pub sheets_truncated: bool,
    pub max_rows_cap: usize,
    pub max_cols_cap: usize,
    pub max_cells_cap: usize,
}

/// Ephemeral UI state owned by `views/preview` and attached once on `AppState`.
pub struct PreviewUiState {
    pub active_path: String,
    pub active_sheet: usize,
    pub raw_csv_mode: bool,
    pub table: TableState,
}

impl Default for PreviewUiState {
    fn default() -> Self {
        Self {
            active_path: String::new(),
            active_sheet: 0,
            raw_csv_mode: false,
            table: TableState::new().key("spreadsheet-preview-table-s0"),
        }
    }
}

impl std::fmt::Debug for PreviewUiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewUiState")
            .field("active_path", &self.active_path)
            .field("active_sheet", &self.active_sheet)
            .field("raw_csv_mode", &self.raw_csv_mode)
            .finish()
    }
}

impl PreviewUiState {
    /// Resets or clamps active sheet and table state when a file preview opens, updates, or closes.
    pub fn sync_for_preview_data(
        &mut self,
        preview_path: Option<&str>,
        data: Option<&SpreadsheetPreviewData>,
    ) {
        let Some(path) = preview_path else {
            self.active_path.clear();
            self.active_sheet = 0;
            self.raw_csv_mode = false;
            self.table = TableState::new().key("spreadsheet-preview-table-s0");
            return;
        };

        if self.active_path != path {
            self.active_path = path.to_string();
            self.active_sheet = 0;
            self.raw_csv_mode = false;
            self.table = TableState::new().key("spreadsheet-preview-table-s0");
        }

        if let Some(sp) = data {
            if sp.sheets.is_empty() {
                self.active_sheet = 0;
            } else if self.active_sheet >= sp.sheets.len() {
                self.select_sheet(sp.sheets.len() - 1);
            }
        }
    }

    /// Switches the visible worksheet tab and resets per-sheet table selection/column widths.
    pub fn select_sheet(&mut self, index: usize) {
        self.active_sheet = index;
        self.raw_csv_mode = false;
        self.table = TableState::new().key(format!("spreadsheet-preview-table-s{index}"));
    }
}
