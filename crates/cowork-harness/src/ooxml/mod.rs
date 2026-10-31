//! Native Rust OOXML (`.docx`, `.pptx`, `.xlsx`) archive guard, snapshot extractors, and spreadsheet engine.

pub mod docx;
pub mod pptx;
pub mod spreadsheet;
pub mod xlsx;
pub mod zip_guard;

pub use docx::{
    DocxHeading, DocxParagraph, DocxSectionText, DocxSnapshot, DocxTable, DocxTrackedChange,
    MAX_DOCX_STRUCTURAL_ITEMS, extract_docx_snapshot,
};
pub use pptx::{
    MAX_PPTX_SHAPES_PER_SLIDE, MAX_PPTX_SLIDES, PptxExtractOptions, PptxShape, PptxSlide,
    PptxSnapshot, extract_pptx_snapshot, extract_pptx_snapshot_with_options,
};
pub use spreadsheet::{
    FILE_CHANGED_MESSAGE, FileChangeVersion, MAX_BATCH_PATCH_OPERATIONS, MAX_CSV_EXPANSION_ENTRIES,
    MAX_SNAPSHOT_COLS_PER_SHEET, MAX_SNAPSHOT_ROWS_PER_SHEET, MAX_WORKBOOK_SNAPSHOT_CELLS,
    OUTSIDE_WORKSPACE_MESSAGE, SpreadsheetBatchPatchOperation, SpreadsheetBatchPatchRequest,
    SpreadsheetCellStylePatch, SpreadsheetColumnWidth, SpreadsheetEditResult,
    SpreadsheetErrorPayload, SpreadsheetFileKind, SpreadsheetFileVersionResult,
    SpreadsheetMergedRange, SpreadsheetPreviewCell, SpreadsheetWorkbookRequest,
    SpreadsheetWorkbookSnapshot, SpreadsheetWorkbookSnapshotResult,
    SpreadsheetWorkbookSnapshotSheet, WorkspacePathError, file_change_version_from_metadata,
    patch_spreadsheet_batch, read_csv_dialect, read_file_change_version,
    read_spreadsheet_file_version, read_spreadsheet_workbook_snapshot, resolve_workspace_file_path,
    validate_xlsx_zip_signature,
};
pub use xlsx::{
    COLUMN_PADDING_PX, CellCoords, CellRangeCoords, MAX_COLUMN_WIDTH_PX, MAX_DIGIT_WIDTH_PX,
    MAX_OOXML_COLUMN_WIDTH, MAX_SPREADSHEET_COLS, MAX_SPREADSHEET_ROWS, MAX_XLSX_CELLS,
    ParsedXlsxCell, ParsedXlsxSheet, ParsedXlsxWorkbook, SpreadsheetCellStyle,
    SpreadsheetChartAnchor, SpreadsheetChartSummary, SpreadsheetTableSummary, WIDTH_UNITS,
    XlsxCell, XlsxColumnWidth, XlsxSheet, XlsxSnapshot, decode_column_width, encode_cell_address,
    encode_cell_range, encode_col_name, encode_column_width, excel_serial_to_iso_string,
    extract_xlsx_snapshot, parse_cell_address, parse_cell_range, parse_strict_a1_address,
    parse_xlsx_workbook, read_ooxml_color, timestamp_ms_to_excel_serial,
};
pub use zip_guard::{
    MAX_OOXML_COMPRESSED_BYTES, MAX_OOXML_ENTRIES, MAX_OOXML_ENTRY_BYTES, MAX_OOXML_TEXT_CHARS,
    MAX_OOXML_UNCOMPRESSED_BYTES, OoxmlMedia, OoxmlRelationship, detect_media_mime,
    open_bounded_zip, read_media, read_relationships, read_zip_bytes, read_zip_text,
    relationship_part_path, resolve_relationship_target, try_read_zip_text,
    validate_zip_entry_name,
};
