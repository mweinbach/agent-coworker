//! Regression: inserting the first cell into an empty `<sheetData/>` must splice the cell XML
//! literally. A regex replacement template would expand `$100` / `$A$1` as capture-group
//! references and silently corrupt the saved value or formula.

use std::io::{Cursor, Write};

use cowork_harness::ooxml::{
    SpreadsheetBatchPatchOperation, SpreadsheetBatchPatchRequest, SpreadsheetEditResult,
    SpreadsheetWorkbookRequest, SpreadsheetWorkbookSnapshotResult, patch_spreadsheet_batch,
    read_spreadsheet_workbook_snapshot,
};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

fn empty_sheet_xlsx() -> Vec<u8> {
    let entries: [(&str, &[u8]); 3] = [
        (
            "xl/workbook.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#,
        ),
    ];
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// Writes `raw_input` as the first cell of an empty sheet and returns `(value, formula)` of A1.
fn first_cell_round_trip(raw_input: &str) -> (String, Option<String>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("workspace");
    let cowork_home = dir.path().join("cowork-home");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&cowork_home).unwrap();
    std::fs::write(ws.join("book.xlsx"), empty_sheet_xlsx()).unwrap();

    let result = patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
        cwd: ws.clone(),
        cowork_home,
        file_path: "book.xlsx".to_owned(),
        operations: vec![SpreadsheetBatchPatchOperation::Cell {
            sheet_name: Some("Sheet1".to_owned()),
            address: "A1".to_owned(),
            raw_input: raw_input.to_owned(),
        }],
        expected_file_version: None,
    });
    assert_eq!(result, SpreadsheetEditResult::Ok { ok: true });

    let workbook = match read_spreadsheet_workbook_snapshot(&SpreadsheetWorkbookRequest {
        cwd: ws,
        file_path: "book.xlsx".to_owned(),
        sheet_name: None,
    }) {
        SpreadsheetWorkbookSnapshotResult::Ok { workbook, .. } => workbook,
        other => panic!("expected workbook snapshot, got {other:?}"),
    };
    let a1 = workbook.sheets[0]
        .cells
        .iter()
        .find(|c| c.address == "A1")
        .expect("A1 was written");
    (a1.value.clone(), a1.formula.clone())
}

#[test]
fn first_cell_in_empty_sheet_data_keeps_dollar_signs_literally() {
    let (value, formula) = first_cell_round_trip("$100");
    assert_eq!(value, "$100");
    assert_eq!(formula, None);

    let (_, formula) = first_cell_round_trip("=$A$1");
    assert_eq!(formula.as_deref(), Some("$A$1"));
}
