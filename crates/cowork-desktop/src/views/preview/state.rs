//! Spreadsheet and presentation preview payload types and ephemeral preview UI state.

use rune::{Key, Tx};
use rune_kit::TableState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// Layout mode for multi-slide presentation previews (`PptxPreview.tsx` parity).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PresentationLayoutMode {
    #[default]
    Deck,
    Grid,
}

/// Single rendered PNG or text-fallback SVG slide from `cowork/workspace/presentation/preview`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationSlideData {
    pub slide_index: usize,
    #[serde(default)]
    pub slide_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Data URL (`data:image/png;base64,...` or `data:image/svg+xml;base64,...`).
    pub png_base64: String,
}

/// Presentation preview payload backed by `cowork/workspace/presentation/preview`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationPreviewData {
    #[serde(default)]
    pub loading: bool,
    #[serde(default)]
    pub slides: Vec<PresentationSlideData>,
    #[serde(default)]
    pub rendering_mode: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub error_kind: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

impl PresentationPreviewData {
    /// Initial placeholder state while an RPC render request is in flight.
    pub fn loading() -> Self {
        Self {
            loading: true,
            ..Default::default()
        }
    }

    /// Error payload shown with the retry card and header "Open in default app" fallback.
    pub fn from_error(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            loading: false,
            error_kind: Some(kind.into()),
            error_message: Some(message.into()),
            ..Default::default()
        }
    }

    /// Parses a JSON-RPC `cowork/workspace/presentation/preview` response payload.
    pub fn from_rpc_payload(payload: &Value) -> Self {
        let Some(ok) = payload.get("ok").and_then(Value::as_bool) else {
            return Self::from_error(
                "compile_error",
                "Invalid response received from rendering engine.",
            );
        };

        if !ok {
            let err_obj = payload.get("error");
            let kind = err_obj
                .and_then(|e| e.get("kind"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("compile_error");
            let message = err_obj
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Failed to render PowerPoint deck.");
            return Self::from_error(kind, message);
        }

        let slides: Vec<PresentationSlideData> = payload
            .get("slides")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .enumerate()
                    .filter_map(|(fallback_idx, item)| {
                        let png_base64 = item
                            .get("pngBase64")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())?
                            .to_string();
                        let slide_index = item
                            .get("slideIndex")
                            .and_then(Value::as_u64)
                            .and_then(|v| usize::try_from(v).ok())
                            .unwrap_or(fallback_idx);
                        let slide_id = item
                            .get("slideId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let title = item
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        Some(PresentationSlideData {
                            slide_index,
                            slide_id,
                            title,
                            png_base64,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let rendering_mode = payload
            .get("renderingMode")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let warnings = payload
            .get("warnings")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        Self {
            loading: false,
            slides,
            rendering_mode,
            warnings,
            error_kind: None,
            error_message: None,
        }
    }

    /// Computes notice banner visibility (`is_text_only`, filtered warning details),
    /// matching `PresentationPreviewNotice.tsx`.
    pub fn notice_details(&self) -> (bool, Vec<String>) {
        let text_only = self.rendering_mode.as_deref() == Some("text");
        let details: Vec<String> = self
            .warnings
            .iter()
            .filter(|w| {
                let trimmed = w.trim();
                !trimmed.is_empty() && !(text_only && trimmed.starts_with("Text-only preview:"))
            })
            .cloned()
            .collect();
        (text_only, details)
    }
}

/// Ephemeral UI state owned by `views/preview` and attached once on `AppState`.
pub struct PreviewUiState {
    pub active_path: String,
    pub active_sheet: usize,
    pub raw_csv_mode: bool,
    pub table: TableState,
    pub(crate) table_rev: u64,
    pub active_slide: usize,
    pub presentation_layout: PresentationLayoutMode,
}

impl Default for PreviewUiState {
    fn default() -> Self {
        Self {
            active_path: String::new(),
            active_sheet: 0,
            raw_csv_mode: false,
            table: TableState::new().key("spreadsheet-preview-table-s0"),
            table_rev: 0,
            active_slide: 0,
            presentation_layout: PresentationLayoutMode::Deck,
        }
    }
}

impl std::fmt::Debug for PreviewUiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewUiState")
            .field("active_path", &self.active_path)
            .field("active_sheet", &self.active_sheet)
            .field("raw_csv_mode", &self.raw_csv_mode)
            .field("table_rev", &self.table_rev)
            .field("active_slide", &self.active_slide)
            .field("presentation_layout", &self.presentation_layout)
            .finish()
    }
}

impl PreviewUiState {
    /// Mutable accessor for `Table` callbacks that bumps `table_rev` so spreadsheet memoization
    /// invalidates whenever table selection, sorting, or column widths change.
    pub(crate) fn table_mut(&mut self) -> &mut TableState {
        self.table_rev = self.table_rev.wrapping_add(1);
        &mut self.table
    }

    fn reset_for_path(&mut self, path: Option<&str>) {
        let Some(path) = path else {
            self.active_path.clear();
            self.active_sheet = 0;
            self.raw_csv_mode = false;
            self.table = TableState::new().key("spreadsheet-preview-table-s0");
            self.table_rev = self.table_rev.wrapping_add(1);
            self.active_slide = 0;
            self.presentation_layout = PresentationLayoutMode::Deck;
            return;
        };

        if self.active_path != path {
            self.active_path = path.to_string();
            self.active_sheet = 0;
            self.raw_csv_mode = false;
            self.table = TableState::new().key("spreadsheet-preview-table-s0");
            self.table_rev = self.table_rev.wrapping_add(1);
            self.active_slide = 0;
            self.presentation_layout = PresentationLayoutMode::Deck;
        }
    }

    /// Resets or clamps active sheet and table state when a file preview opens, updates, or closes.
    pub fn sync_for_preview_data(
        &mut self,
        preview_path: Option<&str>,
        data: Option<&SpreadsheetPreviewData>,
    ) {
        self.reset_for_path(preview_path);
        if preview_path.is_none() {
            return;
        }

        if let Some(sp) = data {
            self.table_rev = self.table_rev.wrapping_add(1);
            if sp.sheets.is_empty() {
                self.active_sheet = 0;
            } else if self.active_sheet >= sp.sheets.len() {
                self.select_sheet(sp.sheets.len() - 1);
            }
        }
    }

    /// Resets or clamps active slide selection when a presentation preview opens, updates, or closes.
    pub fn sync_for_presentation_data(
        &mut self,
        preview_path: Option<&str>,
        data: Option<&PresentationPreviewData>,
    ) {
        self.reset_for_path(preview_path);
        if preview_path.is_none() {
            return;
        }

        if let Some(pres) = data {
            if pres.slides.is_empty() {
                self.active_slide = 0;
            } else if self.active_slide >= pres.slides.len() {
                self.active_slide = pres.slides.len() - 1;
            }
        }
    }

    /// Synchronizes both spreadsheet and presentation UI state for the active preview.
    pub fn sync_for_all_previews(
        &mut self,
        preview_path: Option<&str>,
        spreadsheet: Option<&SpreadsheetPreviewData>,
        presentation: Option<&PresentationPreviewData>,
    ) {
        self.sync_for_preview_data(preview_path, spreadsheet);
        self.sync_for_presentation_data(preview_path, presentation);
    }

    /// Switches the visible worksheet tab and resets per-sheet table selection/column widths.
    pub fn select_sheet(&mut self, index: usize) {
        self.active_sheet = index;
        self.raw_csv_mode = false;
        self.table = TableState::new().key(format!("spreadsheet-preview-table-s{index}"));
        self.table_rev = self.table_rev.wrapping_add(1);
    }

    fn reveal_selected_slide(&self, tx: &mut Tx) {
        let index = self.active_slide;
        tx.scroll_into_view_in("pptx-thumb-strip", format!("pptx-thumb-{index}"));
        tx.scroll_into_view_in("pptx-grid-scroll", format!("pptx-grid-card-{index}"));
    }

    /// Selects a slide index clamped within `0..total_slides` and reveals it in either layout.
    pub fn select_slide(&mut self, index: usize, total_slides: usize, tx: &mut Tx) {
        if total_slides == 0 {
            self.active_slide = 0;
        } else {
            self.active_slide = index.min(total_slides - 1);
        }
        self.reveal_selected_slide(tx);
    }

    /// Advances to the previous slide if not already on the first slide and reveals it.
    pub fn prev_slide(&mut self, tx: &mut Tx) {
        self.active_slide = self.active_slide.saturating_sub(1);
        self.reveal_selected_slide(tx);
    }

    /// Advances to the next slide if not already on the last slide and reveals it.
    pub fn next_slide(&mut self, total_slides: usize, tx: &mut Tx) {
        if self.active_slide + 1 < total_slides {
            self.active_slide += 1;
        }
        self.reveal_selected_slide(tx);
    }

    /// Switches between Deck and Grid presentation preview layouts.
    pub fn set_presentation_layout(&mut self, mode: PresentationLayoutMode) {
        self.presentation_layout = mode;
    }

    /// Handles slide navigation keys and reveals the selected slide.
    pub fn handle_presentation_key_tx(
        &mut self,
        key: &Key,
        total_slides: usize,
        tx: &mut Tx,
    ) -> bool {
        if total_slides == 0 {
            return false;
        }
        match key {
            Key::Left | Key::Up | Key::PageUp => {
                self.prev_slide(tx);
                true
            }
            Key::Right | Key::Down | Key::PageDown => {
                self.next_slide(total_slides, tx);
                true
            }
            Key::Home => {
                self.select_slide(0, total_slides, tx);
                true
            }
            Key::End => {
                self.select_slide(total_slides - 1, total_slides, tx);
                true
            }
            _ => false,
        }
    }

    /// Handles slide navigation keys for callers without a transaction.
    ///
    /// Preview event handlers use `handle_presentation_key_tx` so the selection is revealed.
    pub fn handle_presentation_key(&mut self, key: &Key, total_slides: usize) -> bool {
        self.handle_presentation_key_tx(key, total_slides, &mut Tx::default())
    }
}
