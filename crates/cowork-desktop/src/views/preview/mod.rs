//! Native read-only file preview decoders and renderers owned by `@settings`.

pub mod decoder;
pub mod presentation;
pub mod spreadsheet;
pub mod state;

#[cfg(test)]
mod tests;

pub use decoder::{decode_spreadsheet_preview, excel_column_name};
pub use presentation::render_presentation_preview;
pub use spreadsheet::render_spreadsheet_preview;
pub use state::{
    MAX_PREVIEW_CELLS, MAX_PREVIEW_COLS, MAX_PREVIEW_ROWS, MAX_SHEET_TABS, PresentationLayoutMode,
    PresentationPreviewData, PresentationSlideData, PreviewUiState, SpreadsheetCellAlign,
    SpreadsheetPreviewData, SpreadsheetSheetData,
};
