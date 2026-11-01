//! Regression: shared formulas (`<f t="shared" si="…"/>` followers) must be expanded into
//! per-cell formulas, translated by the follower's offset from the master cell, mirroring
//! SheetJS `shift_formula_xlsx` (the TypeScript reference parser). Editing a shared-formula
//! master must not orphan its followers when the workbook is saved.

use std::io::{Cursor, Read, Write};

use cowork_harness::ooxml::{
    SpreadsheetBatchPatchOperation, SpreadsheetBatchPatchRequest, SpreadsheetEditResult,
    SpreadsheetWorkbookRequest, SpreadsheetWorkbookSnapshotResult, patch_spreadsheet_batch,
    read_spreadsheet_workbook_snapshot,
};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

fn xlsx_with_sheet(sheet_data: &str) -> Vec<u8> {
    let sheet_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_data}</sheetData></worksheet>"#
    );
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
        ("xl/worksheets/sheet1.xml", sheet_xml.as_bytes()),
    ];
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

struct Workspace {
    _dir: tempfile::TempDir,
    ws: std::path::PathBuf,
    cowork_home: std::path::PathBuf,
}

fn workspace_with(bytes: &[u8]) -> Workspace {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("workspace");
    let cowork_home = dir.path().join("cowork-home");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&cowork_home).unwrap();
    std::fs::write(ws.join("book.xlsx"), bytes).unwrap();
    Workspace {
        _dir: dir,
        ws,
        cowork_home,
    }
}

/// Returns `(address, value, formula)` for every cell in the first sheet.
fn read_cells(w: &Workspace) -> Vec<(String, String, Option<String>)> {
    let workbook = match read_spreadsheet_workbook_snapshot(&SpreadsheetWorkbookRequest {
        cwd: w.ws.clone(),
        file_path: "book.xlsx".to_owned(),
        sheet_name: None,
    }) {
        SpreadsheetWorkbookSnapshotResult::Ok { workbook, .. } => workbook,
        other => panic!("expected workbook snapshot, got {other:?}"),
    };
    workbook.sheets[0]
        .cells
        .iter()
        .map(|c| (c.address.clone(), c.value.clone(), c.formula.clone()))
        .collect()
}

fn formula_of(cells: &[(String, String, Option<String>)], address: &str) -> Option<String> {
    cells
        .iter()
        .find(|(a, _, _)| a == address)
        .unwrap_or_else(|| panic!("cell {address} missing from snapshot: {cells:?}"))
        .2
        .clone()
}

fn read_sheet_xml(w: &Workspace) -> String {
    let bytes = std::fs::read(w.ws.join("book.xlsx")).unwrap();
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = String::new();
    archive
        .by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    out
}

fn shared_formula_column() -> &'static str {
    // Column C: C1 is the master `A1*$B$1`, C2:C4 are followers. Mixed `$` markers, a range,
    // sheet-qualified refs, a string literal and a function name that looks like a ref.
    r#"<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>10</v></c><c r="C1"><f t="shared" ref="C1:C4" si="0">A1*$B$1</f><v>10</v></c><c r="D1"><f t="shared" ref="D1:E3" si="1">SUM(A$1:A1)+Sheet1!B1+'My Sheet'!$A1+LOG10(A1)&amp;"A1"</f><v>0</v></c><c r="E1"><f t="shared" si="1"/><v>0</v></c></row>
<row r="2"><c r="A2"><v>2</v></c><c r="C2"><f t="shared" si="0"/><v>20</v></c><c r="D2"><f t="shared" si="1"></f><v>0</v></c><c r="E2"><f t="shared" si="1"/><v>0</v></c></row>
<row r="3"><c r="A3"><v>3</v></c><c r="C3"><f t="shared" si="0"/><v>30</v></c><c r="D3"><f t="shared" si="1"/><v>0</v></c><c r="E3"><f t="shared" si="1"/><v>0</v></c></row>
<row r="4"><c r="A4"><v>4</v></c><c r="C4"><f t="shared" si="0"/></c></row>"#
}

#[test]
fn shared_formula_followers_are_expanded_with_relative_references_shifted() {
    let w = workspace_with(&xlsx_with_sheet(shared_formula_column()));
    let cells = read_cells(&w);

    assert_eq!(formula_of(&cells, "C1").as_deref(), Some("A1*$B$1"));
    assert_eq!(formula_of(&cells, "C2").as_deref(), Some("A2*$B$1"));
    assert_eq!(formula_of(&cells, "C3").as_deref(), Some("A3*$B$1"));
    // A follower with no cached value and no style must still surface its formula.
    assert_eq!(formula_of(&cells, "C4").as_deref(), Some("A4*$B$1"));

    assert_eq!(
        formula_of(&cells, "D1").as_deref(),
        Some(r#"SUM(A$1:A1)+Sheet1!B1+'My Sheet'!$A1+LOG10(A1)&"A1""#)
    );
    assert_eq!(
        formula_of(&cells, "E1").as_deref(),
        Some(r#"SUM(B$1:B1)+Sheet1!C1+'My Sheet'!$A1+LOG10(B1)&"A1""#)
    );
    assert_eq!(
        formula_of(&cells, "D2").as_deref(),
        Some(r#"SUM(A$1:A2)+Sheet1!B2+'My Sheet'!$A2+LOG10(A2)&"A1""#)
    );
    assert_eq!(
        formula_of(&cells, "E3").as_deref(),
        Some(r#"SUM(B$1:B3)+Sheet1!C3+'My Sheet'!$A3+LOG10(B3)&"A1""#)
    );
}

#[test]
fn shared_formula_translation_handles_whole_rows_columns_and_overflow() {
    let sheet = r#"<row r="1"><c r="A1"><f t="shared" ref="A1:B2" si="7">SUM(B:B)+SUM($C:C)+SUM(2:2)+SUM($3:3)+Table1[[#This Row],[A1]]+XFD1</f></c><c r="B1"><f t="shared" si="7"/></c></row>
<row r="2"><c r="A2"><f t="shared" si="7"/></c><c r="B2"><f t="shared" si="7"/></c></row>"#;
    let w = workspace_with(&xlsx_with_sheet(sheet));
    let cells = read_cells(&w);
    assert_eq!(
        formula_of(&cells, "B1").as_deref(),
        Some("SUM(C:C)+SUM($C:D)+SUM(2:2)+SUM($3:3)+Table1[[#This Row],[A1]]+#REF!")
    );
    assert_eq!(
        formula_of(&cells, "A2").as_deref(),
        Some("SUM(B:B)+SUM($C:C)+SUM(3:3)+SUM($3:4)+Table1[[#This Row],[A1]]+XFD2")
    );
    assert_eq!(
        formula_of(&cells, "B2").as_deref(),
        Some("SUM(C:C)+SUM($C:D)+SUM(3:3)+SUM($3:4)+Table1[[#This Row],[A1]]+#REF!")
    );
}

#[test]
fn array_formulas_keep_master_only_formula() {
    let sheet = r#"<row r="1"><c r="A1"><v>1</v></c><c r="C1"><f t="array" ref="C1:C2">A1:A2*2</f><v>2</v></c></row>
<row r="2"><c r="A2"><v>2</v></c><c r="C2"><v>4</v></c></row>"#;
    let w = workspace_with(&xlsx_with_sheet(sheet));
    let cells = read_cells(&w);
    assert_eq!(formula_of(&cells, "C1").as_deref(), Some("A1:A2*2"));
    assert_eq!(formula_of(&cells, "C2"), None);
}

#[test]
fn editing_a_shared_formula_master_keeps_followers_valid() {
    let w = workspace_with(&xlsx_with_sheet(shared_formula_column()));
    let result = patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
        cwd: w.ws.clone(),
        cowork_home: w.cowork_home.clone(),
        file_path: "book.xlsx".to_owned(),
        operations: vec![
            SpreadsheetBatchPatchOperation::Cell {
                sheet_name: Some("Sheet1".to_owned()),
                address: "C1".to_owned(),
                raw_input: "5".to_owned(),
            },
            SpreadsheetBatchPatchOperation::Cell {
                sheet_name: Some("Sheet1".to_owned()),
                address: "A2".to_owned(),
                raw_input: "20".to_owned(),
            },
        ],
        expected_file_version: None,
    });
    assert_eq!(result, SpreadsheetEditResult::Ok { ok: true });

    let cells = read_cells(&w);
    assert_eq!(formula_of(&cells, "C1"), None);
    assert_eq!(formula_of(&cells, "C2").as_deref(), Some("A2*$B$1"));
    assert_eq!(formula_of(&cells, "C3").as_deref(), Some("A3*$B$1"));
    assert_eq!(formula_of(&cells, "C4").as_deref(), Some("A4*$B$1"));
    // The untouched shared group keeps working.
    assert_eq!(
        formula_of(&cells, "E3").as_deref(),
        Some(r#"SUM(B$1:B3)+Sheet1!C3+'My Sheet'!$A3+LOG10(B3)&"A1""#)
    );

    // No follower of group 0 may reference a master that no longer exists.
    let xml = read_sheet_xml(&w);
    assert!(
        !xml.contains(r#"si="0""#),
        "orphaned shared-formula followers remain: {xml}"
    );
    assert!(
        xml.contains(r#"si="1""#),
        "group 1 should be untouched: {xml}"
    );
}

#[test]
fn editing_a_shared_formula_follower_writes_a_plain_formula() {
    let w = workspace_with(&xlsx_with_sheet(shared_formula_column()));
    let result = patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
        cwd: w.ws.clone(),
        cowork_home: w.cowork_home.clone(),
        file_path: "book.xlsx".to_owned(),
        operations: vec![SpreadsheetBatchPatchOperation::Cell {
            sheet_name: Some("Sheet1".to_owned()),
            address: "C2".to_owned(),
            raw_input: "=A2*$B$1+1".to_owned(),
        }],
        expected_file_version: None,
    });
    assert_eq!(result, SpreadsheetEditResult::Ok { ok: true });
    let cells = read_cells(&w);
    assert_eq!(formula_of(&cells, "C1").as_deref(), Some("A1*$B$1"));
    assert_eq!(formula_of(&cells, "C2").as_deref(), Some("A2*$B$1+1"));
    assert_eq!(formula_of(&cells, "C3").as_deref(), Some("A3*$B$1"));
}

#[test]
fn shared_formula_followers_resolve_regardless_of_order_and_preserve_quoted_text() {
    // The follower appears before its master; quoted text, unicode sheet names, 3D references,
    // external-workbook brackets and error literals must survive the translation.
    let sheet = r#"<row r="2"><c r="B2"><f t="shared" si="3"/></c></row>
<row r="1"><c r="A1"><f t="shared" ref="A1:B2" si="3">IF(A1="say ""B2""",'Fünf Ü''s'!A1,SUM(Sheet1:Sheet3!A1)+[1]Data!A1+#REF!+_xlfn.XLOOKUP(A1,C:C,D:D))</f></c></row>"#;
    let w = workspace_with(&xlsx_with_sheet(sheet));
    let cells = read_cells(&w);
    assert_eq!(
        formula_of(&cells, "B2").as_deref(),
        Some(
            r#"IF(B2="say ""B2""",'Fünf Ü''s'!B2,SUM(Sheet1:Sheet3!B2)+[1]Data!B2+#REF!+_xlfn.XLOOKUP(B2,D:D,E:E))"#
        )
    );
}
