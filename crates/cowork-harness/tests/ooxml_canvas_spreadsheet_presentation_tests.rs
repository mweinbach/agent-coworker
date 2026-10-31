use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_env::{SofficeRunner, SofficeRunnerConfig};
use cowork_harness::canvas::{
    CanvasDocumentOpenRequest, CanvasDocumentOpenResult, CanvasDocumentPersistenceService,
    CanvasDocumentRevisionResult, CanvasDocumentSaveAsRequest, CanvasDocumentSaveRequest,
    CanvasDocumentSaveResult, CanvasDocumentSessionRef,
};
use cowork_harness::ooxml::{
    MAX_OOXML_ENTRY_BYTES, SpreadsheetBatchPatchOperation, SpreadsheetBatchPatchRequest,
    SpreadsheetCellStylePatch, SpreadsheetEditResult, SpreadsheetFileKind,
    SpreadsheetFileVersionResult, SpreadsheetWorkbookRequest, SpreadsheetWorkbookSnapshotResult,
    open_bounded_zip, patch_spreadsheet_batch, read_spreadsheet_file_version,
    read_spreadsheet_workbook_snapshot, validate_zip_entry_name,
};
use cowork_harness::presentation::{
    PresentationPreviewRequest, PresentationPreviewResult, preview_presentation_file,
};
use cowork_harness::tasks::{ArtifactBlobInput, ArtifactComparisonService, ArtifactPreviewService};
use cowork_sandbox::SandboxManager;
use data_encoding::BASE64;
use serde_json::json;
use tempfile::TempDir;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create tempdir in /private/tmp");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default();
        for (name, body) in entries {
            writer.start_file(*name, opts).expect("start zip entry");
            writer.write_all(body).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

const TINY_PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D', b'R',
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, b'I', b'D', b'A', b'T', 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, b'I', b'E', b'N',
    b'D', 0xae, 0x42, 0x60, 0x82,
];

#[test]
fn zip_guard_rejects_path_traversal_absolute_drive_and_spoofed_zip_bombs() {
    assert!(validate_zip_entry_name("../secret.xml").is_err());
    assert!(validate_zip_entry_name("word/../../etc/passwd").is_err());
    assert!(validate_zip_entry_name("/abs/document.xml").is_err());
    assert!(validate_zip_entry_name("C:/windows/system.ini").is_err());
    assert!(validate_zip_entry_name("word\\document.xml").is_err());
    assert!(validate_zip_entry_name("word/doc\0.xml").is_err());
    assert!(validate_zip_entry_name("word/document.xml").is_ok());

    let traversal_zip = build_zip(&[("../outside.xml", b"<x/>")]);
    let err = open_bounded_zip(&traversal_zip).expect_err("traversal entry must fail");
    assert!(err.contains("path traversal"), "unexpected error: {err}");

    // Spoof declared uncompressed size in both local file header (offset 22) and central directory (offset 24 from CD start)
    let mut bomb_zip = build_zip(&[("word/document.xml", b"<w:document/>")]);
    let spoofed_size = (MAX_OOXML_ENTRY_BYTES as u32) + 1024;
    bomb_zip[22..26].copy_from_slice(&spoofed_size.to_le_bytes());
    if let Some(cd_pos) = bomb_zip
        .windows(4)
        .position(|w| w == [0x50, 0x4b, 0x01, 0x02])
    {
        bomb_zip[cd_pos + 24..cd_pos + 28].copy_from_slice(&spoofed_size.to_le_bytes());
    }
    let bomb_err = open_bounded_zip(&bomb_zip).expect_err("oversized entry must fail");
    assert!(bomb_err.contains("limit"), "unexpected error: {bomb_err}");
}

#[test]
fn docx_pptx_and_xlsx_preview_and_structural_comparison_cover_all_ooxml_surfaces() {
    // 1. DOCX v1 vs v2 (Title/Heading1, paragraphs skipping <w:del>, tables, headers, footers, trackedChanges, media)
    let docx_v1 = build_zip(&[
        (
            "word/document.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Board Memo</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Q1 Plan</w:t></w:r></w:p>
    <w:p><w:r><w:t>Visible intro</w:t></w:r><w:del w:author="Alice"><w:r><w:delText>removed words</w:delText></w:r></w:del></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>"#,
        ),
        (
            "word/header1.xml",
            br#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential v1</w:t></w:r></w:p></w:hdr>"#,
        ),
        (
            "word/footer1.xml",
            br#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page 1</w:t></w:r></w:p></w:ftr>"#,
        ),
        ("word/media/image1.png", TINY_PNG),
    ]);

    let docx_v2 = build_zip(&[
        (
            "word/document.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Board Memo</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Q2 Plan</w:t></w:r></w:p>
    <w:p><w:r><w:t>Visible intro</w:t></w:r><w:ins w:author="Bob" w:date="2026-04-01T00:00:00Z"><w:r><w:t>approved</w:t></w:r></w:ins></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>250</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>"#,
        ),
        (
            "word/header1.xml",
            br#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential v2</w:t></w:r></w:p></w:hdr>"#,
        ),
        (
            "word/footer1.xml",
            br#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page 2</w:t></w:r></w:p></w:ftr>"#,
        ),
        ("word/media/image1.png", &[TINY_PNG, &[0x00]].concat()),
    ]);

    let docx_prev = ArtifactPreviewService::preview(&ArtifactBlobInput {
        bytes: &docx_v1,
        filename: "memo.docx",
        mime_type: None,
    });
    assert_eq!(docx_prev["kind"], json!("docx"));
    assert_eq!(
        docx_prev["document"]["headings"][0]["text"],
        json!("Board Memo")
    );
    assert!(docx_prev["document"]["headings"][0]["level"].is_null());
    assert_eq!(docx_prev["document"]["headings"][1]["level"], json!(1));
    assert_eq!(
        docx_prev["document"]["paragraphs"][0]["text"],
        json!("Visible intro")
    );
    assert_eq!(docx_prev["document"]["paragraphs"][0]["index"], json!(2));
    assert_eq!(
        docx_prev["document"]["trackedChanges"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        docx_prev["document"]["media"][0]["mimeType"],
        json!("image/png")
    );

    let docx_diff = ArtifactComparisonService::compare(
        &ArtifactBlobInput {
            bytes: &docx_v1,
            filename: "memo.docx",
            mime_type: None,
        },
        &ArtifactBlobInput {
            bytes: &docx_v2,
            filename: "memo.docx",
            mime_type: None,
        },
        None,
    );
    assert_eq!(docx_diff["kind"], json!("docx"));
    let docx_types: Vec<&str> = docx_diff["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["type"].as_str())
        .collect();
    assert!(docx_types.contains(&"heading_changed"));
    assert!(docx_types.contains(&"paragraph_changed"));
    assert!(docx_types.contains(&"table_changed"));
    assert!(docx_types.contains(&"header_changed"));
    assert!(docx_types.contains(&"footer_changed"));
    assert!(docx_types.contains(&"tracked_change_added"));
    assert!(docx_types.contains(&"tracked_change_removed"));
    assert!(docx_types.contains(&"media_changed"));

    // 2. PPTX v1 vs v2 (custom sldId order, notes, shapes with geometry, slide media)
    let pptx_v1 = build_zip(&[
        (
            "ppt/presentation.xml",
            br#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>"#,
        ),
        (
            "ppt/_rels/presentation.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>"#,
        ),
        (
            "ppt/slides/slide2.xml",
            br#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="800"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Opening Slide</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>"#,
        ),
        (
            "ppt/slides/_rels/slide2.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/>
</Relationships>"#,
        ),
        (
            "ppt/notesSlides/notesSlide1.xml",
            br#"<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note v1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>"#,
        ),
        ("ppt/media/logo.png", TINY_PNG),
    ]);

    let pptx_v2 = build_zip(&[
        (
            "ppt/presentation.xml",
            br#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId3"/>
  </p:sldIdLst>
</p:presentation>"#,
        ),
        (
            "ppt/_rels/presentation.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>"#,
        ),
        (
            "ppt/slides/slide2.xml",
            br#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="500" y="200"/><a:ext cx="3000" cy="800"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Updated Opening Slide</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>"#,
        ),
        (
            "ppt/slides/_rels/slide2.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"#,
        ),
        (
            "ppt/notesSlides/notesSlide1.xml",
            br#"<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note v2</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>"#,
        ),
        (
            "ppt/slides/slide1.xml",
            br#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Appendix Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#,
        ),
    ]);

    let pptx_prev = ArtifactPreviewService::preview(&ArtifactBlobInput {
        bytes: &pptx_v1,
        filename: "deck.pptx",
        mime_type: None,
    });
    assert_eq!(pptx_prev["kind"], json!("pptx"));
    assert_eq!(pptx_prev["presentation"]["slides"][0]["id"], json!("256"));
    assert_eq!(
        pptx_prev["presentation"]["slides"][0]["notes"],
        json!("Speaker note v1")
    );
    assert_eq!(
        pptx_prev["presentation"]["slides"][0]["shapes"][0]["x"].as_f64(),
        Some(100.0)
    );

    let pptx_diff = ArtifactComparisonService::compare(
        &ArtifactBlobInput {
            bytes: &pptx_v1,
            filename: "deck.pptx",
            mime_type: None,
        },
        &ArtifactBlobInput {
            bytes: &pptx_v2,
            filename: "deck.pptx",
            mime_type: None,
        },
        None,
    );
    assert_eq!(pptx_diff["kind"], json!("pptx"));
    assert_eq!(pptx_diff["summary"]["modified"], json!(1));
    assert_eq!(pptx_diff["summary"]["added"], json!(1));
    let mod_slide = &pptx_diff["changes"][0];
    assert_eq!(mod_slide["type"], json!("slide_changed"));
    let changed_fields: Vec<&str> = mod_slide["changedFields"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(changed_fields.contains(&"text"));
    assert!(changed_fields.contains(&"notes"));
    assert!(changed_fields.contains(&"shapes"));
    assert!(changed_fields.contains(&"media"));

    // 3. XLSX v1 vs v2 (sharedStrings skipping <rPh>, styles, tables, charts, merges, formulas)
    let xlsx_v1 = build_zip(&[
        (
            "xl/workbook.xml",
            br#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
        ),
        (
            "xl/sharedStrings.xml",
            br#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>ARR</t><rPh sb="0" eb="3"><t>PHONETIC</t></rPh></si>
</sst>"#,
        ),
        (
            "xl/styles.xml",
            br#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/></font><font><b/><sz val="12"/><color rgb="FF112233"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellXfs count="2"><xf fontId="0" fillId="0" numFmtId="0"/><xf fontId="1" fillId="0" numFmtId="14" applyFont="1" applyNumberFormat="1"/></cellXfs>
</styleSheet>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols><col min="1" max="2" width="14" customWidth="1"/></cols>
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>46023</v></c></row>
    <row r="2"><c r="A2"><v>10</v></c><c r="B2"><f>A2*2</f><v>20</v></c></row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>
  <drawing r:id="rIdDraw1"/>
  <tableParts count="1"><tablePart r:id="rIdTbl1"/></tableParts>
</worksheet>"#,
        ),
        (
            "xl/worksheets/_rels/sheet1.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdTbl1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
  <Relationship Id="rIdDraw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#,
        ),
        (
            "xl/tables/table1.xml",
            br#"<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="RevTable" displayName="RevTable" ref="A1:B2"/>"#,
        ),
        (
            "xl/drawings/drawing1.xml",
            br#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>0</xdr:col><xdr:row>4</xdr:row></xdr:from>
    <xdr:to><xdr:col>5</xdr:col><xdr:row>14</xdr:row></xdr:to>
    <xdr:graphicFrame><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><c:chart r:id="rIdChart1"/></a:graphicData></a:graphic></xdr:graphicFrame>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#,
        ),
        (
            "xl/drawings/_rels/drawing1.xml.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>"#,
        ),
        (
            "xl/charts/chart1.xml",
            br#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>ARR Growth</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart/></c:plotArea></c:chart>
</c:chartSpace>"#,
        ),
    ]);

    let xlsx_prev = ArtifactPreviewService::preview(&ArtifactBlobInput {
        bytes: &xlsx_v1,
        filename: "model.xlsx",
        mime_type: None,
    });
    assert_eq!(xlsx_prev["kind"], json!("xlsx"));
    assert_eq!(
        xlsx_prev["workbook"]["sheets"][0]["cells"][0]["value"],
        json!("ARR")
    );
    assert_eq!(
        xlsx_prev["workbook"]["sheets"][0]["cells"][1]["value"],
        json!("2026-01-01T00:00:00.000Z")
    );
    assert_eq!(
        xlsx_prev["workbook"]["sheets"][0]["tables"][0]["name"],
        json!("RevTable")
    );
    assert_eq!(
        xlsx_prev["workbook"]["sheets"][0]["charts"][0]["title"],
        json!("ARR Growth")
    );
    assert_eq!(
        xlsx_prev["workbook"]["sheets"][0]["charts"][0]["type"],
        json!("bar")
    );

    let xlsx_v2 = build_zip(&[
        (
            "xl/workbook.xml",
            br#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets>
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
            br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols><col min="1" max="2" width="22" customWidth="1"/></cols>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>ARR</t></is></c><c r="B1"><v>999</v></c></row>
    <row r="2"><c r="A2"><v>10</v></c><c r="B2"><f>A2*3</f><v>30</v></c></row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A4:C4"/></mergeCells>
</worksheet>"#,
        ),
    ]);
    let xlsx_diff = ArtifactComparisonService::compare(
        &ArtifactBlobInput {
            bytes: &xlsx_v1,
            filename: "model.xlsx",
            mime_type: None,
        },
        &ArtifactBlobInput {
            bytes: &xlsx_v2,
            filename: "model.xlsx",
            mime_type: None,
        },
        None,
    );
    assert_eq!(xlsx_diff["kind"], json!("xlsx"));
    let xlsx_types: Vec<&str> = xlsx_diff["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["type"].as_str())
        .collect();
    assert!(xlsx_types.contains(&"cell_changed"));
    assert!(xlsx_types.contains(&"merge_added"));
    assert!(xlsx_types.contains(&"merge_removed"));
    assert!(xlsx_types.contains(&"column_width_changed"));
    assert!(xlsx_types.contains(&"table_removed"));
    assert!(xlsx_types.contains(&"chart_removed"));
}

#[test]
fn spreadsheet_csv_and_lossless_xlsx_batch_patching_enforce_versions_and_preserve_parts() {
    let (_guard, root) = canonical_temp_dir("cowork-spreadsheet-");
    let ws = root.join("workspace");
    let cowork_home = root.join("cowork-home");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&cowork_home).unwrap();

    // 1. CSV dialect + patch + expectedFileVersion conflict
    let csv_path = ws.join("metrics.csv");
    std::fs::write(&csv_path, "sep=;\r\nName;Score\r\nAlice;42\r\n").unwrap();

    let snap = read_spreadsheet_workbook_snapshot(&SpreadsheetWorkbookRequest {
        cwd: ws.clone(),
        file_path: "metrics.csv".to_owned(),
        sheet_name: None,
    });
    let wb = match snap {
        SpreadsheetWorkbookSnapshotResult::Ok { workbook, .. } => workbook,
        other => panic!("expected CSV workbook ok, got {other:?}"),
    };
    assert_eq!(wb.kind, SpreadsheetFileKind::Csv);
    assert_eq!(wb.sheets[0].cells[0].value, "Name");
    assert_eq!(wb.sheets[0].cells[3].value, "42");

    let patch_ok = patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
        cwd: ws.clone(),
        cowork_home: cowork_home.clone(),
        file_path: "metrics.csv".to_owned(),
        operations: vec![SpreadsheetBatchPatchOperation::Cell {
            sheet_name: None,
            address: "B2".to_owned(),
            raw_input: "99".to_owned(),
        }],
        expected_file_version: Some(wb.file_version.clone()),
    });
    assert_eq!(patch_ok, SpreadsheetEditResult::Ok { ok: true });
    let updated_csv = std::fs::read_to_string(&csv_path).unwrap();
    assert_eq!(updated_csv, "sep=;\r\nName;Score\r\nAlice;99\r\n");

    // Stale expectedFileVersion MUST reject with conflict write_error
    let stale_res = patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
        cwd: ws.clone(),
        cowork_home: cowork_home.clone(),
        file_path: "metrics.csv".to_owned(),
        operations: vec![SpreadsheetBatchPatchOperation::Cell {
            sheet_name: None,
            address: "B2".to_owned(),
            raw_input: "100".to_owned(),
        }],
        expected_file_version: Some(wb.file_version),
    });
    match stale_res {
        SpreadsheetEditResult::Err { error, .. } => {
            assert_eq!(error.kind, "write_error");
            assert!(error.message.contains("changed on disk"));
        }
        other => panic!("expected stale version error, got {other:?}"),
    }

    // Outside-workspace path rejected
    let outside_ver = read_spreadsheet_file_version(&ws, "../outside.csv");
    match outside_ver {
        SpreadsheetFileVersionResult::Err { error, .. } => {
            assert_eq!(error.kind, "outside_workspace");
        }
        other => panic!("expected outside_workspace, got {other:?}"),
    }

    // 2. Lossless XLSX batch patch (cell formula + format + merge + columnWidth + calcChain removal + custom part preserved)
    let xlsx_path = ws.join("budget.xlsx");
    let initial_xlsx = build_zip(&[
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
        ("xl/calcChain.xml", br#"<calcChain><c r="B1" i="1"/></calcChain>"#),
        ("customXml/item1.xml", br#"<preserveMe flag="true"/>"#),
        (
            "xl/worksheets/sheet1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B1"/>
  <cols><col min="1" max="3" width="12" customWidth="1"/></cols>
  <sheetData>
    <row r="1"><c r="A1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c></row>
  </sheetData>
</worksheet>"#,
        ),
    ]);
    std::fs::write(&xlsx_path, initial_xlsx).unwrap();

    let patch_xlsx = patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
        cwd: ws.clone(),
        cowork_home: cowork_home.clone(),
        file_path: "budget.xlsx".to_owned(),
        operations: vec![
            SpreadsheetBatchPatchOperation::Cell {
                sheet_name: Some("Sheet1".to_owned()),
                address: "A2".to_owned(),
                raw_input: "25".to_owned(),
            },
            SpreadsheetBatchPatchOperation::Cell {
                sheet_name: Some("Sheet1".to_owned()),
                address: "B2".to_owned(),
                raw_input: "=SUM(A1:A2)".to_owned(),
            },
            SpreadsheetBatchPatchOperation::Format {
                sheet_name: Some("Sheet1".to_owned()),
                range: "A1:B2".to_owned(),
                style: SpreadsheetCellStylePatch {
                    bold: Some(Some(true)),
                    fill_color: Some(Some("#FFEEAA".to_owned())),
                    ..Default::default()
                },
            },
            SpreadsheetBatchPatchOperation::Merge {
                sheet_name: Some("Sheet1".to_owned()),
                range: "C1:D1".to_owned(),
                merged: true,
            },
            SpreadsheetBatchPatchOperation::ColumnWidth {
                sheet_name: Some("Sheet1".to_owned()),
                col: 1,
                width_px: Some(180.0),
            },
        ],
        expected_file_version: None,
    });
    assert_eq!(patch_xlsx, SpreadsheetEditResult::Ok { ok: true });

    let patched_bytes = std::fs::read(&xlsx_path).unwrap();
    let mut patched_zip = open_bounded_zip(&patched_bytes).unwrap();
    // calcChain.xml removed so Excel recalculates, and customXml/item1.xml preserved losslessly!
    assert!(patched_zip.by_name("xl/calcChain.xml").is_err());
    assert!(patched_zip.by_name("customXml/item1.xml").is_ok());

    let reloaded = read_spreadsheet_workbook_snapshot(&SpreadsheetWorkbookRequest {
        cwd: ws,
        file_path: "budget.xlsx".to_owned(),
        sheet_name: None,
    });
    let wb_after = match reloaded {
        SpreadsheetWorkbookSnapshotResult::Ok { workbook, .. } => workbook,
        other => panic!("expected patched XLSX workbook ok, got {other:?}"),
    };
    let sheet = &wb_after.sheets[0];
    let b2 = sheet
        .cells
        .iter()
        .find(|c| c.address == "B2")
        .expect("B2 exists");
    assert_eq!(b2.formula.as_deref(), Some("SUM(A1:A2)"));
    assert_eq!(b2.style.as_ref().and_then(|s| s.bold), Some(true));
    assert_eq!(
        b2.style.as_ref().and_then(|s| s.fill_color.as_deref()),
        Some("#FFEEAA")
    );
    assert_eq!(sheet.merged_cells.len(), 1);
    assert_eq!(sheet.merged_cells[0].range_ref, "C1:D1");
    assert!(sheet.column_widths.iter().any(|cw| cw.col == 1));
}

#[tokio::test]
async fn canvas_document_service_enforces_workspace_confinement_conflicts_superseded_and_save_as() {
    let (_guard, root) = canonical_temp_dir("cowork-canvas-");
    let ws = root.join("workspace");
    let cowork_home = root.join("cowork-home");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&cowork_home).unwrap();

    // Rejects `cwd` in params via deny_unknown_fields
    let bad_req = serde_json::from_value::<CanvasDocumentOpenRequest>(json!({
        "cwd": "/tmp",
        "path": "draft.md",
        "documentId": "doc-1",
        "generation": 1
    }));
    assert!(bad_req.is_err());

    let doc_path = ws.join("draft.md");
    std::fs::write(&doc_path, "# Initial\n").unwrap();

    let service = CanvasDocumentPersistenceService::new(&cowork_home);
    let opened = service
        .open(
            &ws,
            CanvasDocumentOpenRequest {
                path: "draft.md".to_owned(),
                document_id: "doc-1".to_owned(),
                generation: 1,
                max_bytes: None,
            },
        )
        .await;
    let snap = match opened {
        CanvasDocumentOpenResult::Ok { document, .. } => document,
        other => panic!("expected open ok, got {other:?}"),
    };
    assert_eq!(snap.content, "# Initial\n");

    // Save editRevision 2 -> saved
    let saved = service
        .save(
            &ws,
            CanvasDocumentSaveRequest {
                document_id: "doc-1".to_owned(),
                generation: 1,
                edit_revision: 2,
                content: "# Revision 2\n".to_owned(),
            },
        )
        .await;
    match saved {
        CanvasDocumentSaveResult::Ok { status, .. } => assert_eq!(status, "saved"),
        other => panic!("expected save ok, got {other:?}"),
    }

    // Older editRevision 1 -> superseded without touching disk
    let superseded = service
        .save(
            &ws,
            CanvasDocumentSaveRequest {
                document_id: "doc-1".to_owned(),
                generation: 1,
                edit_revision: 1,
                content: "# Stale\n".to_owned(),
            },
        )
        .await;
    match superseded {
        CanvasDocumentSaveResult::Ok { status, .. } => assert_eq!(status, "superseded"),
        other => panic!("expected superseded, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(&doc_path).unwrap(),
        "# Revision 2\n"
    );

    // External modification triggers conflict on next save
    std::fs::write(&doc_path, "# Externally edited on disk!\n").unwrap();
    let conflict = service
        .save(
            &ws,
            CanvasDocumentSaveRequest {
                document_id: "doc-1".to_owned(),
                generation: 1,
                edit_revision: 3,
                content: "# Would clobber\n".to_owned(),
            },
        )
        .await;
    match conflict {
        CanvasDocumentSaveResult::Err { error, .. } => assert_eq!(error.kind, "conflict"),
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(&doc_path).unwrap(),
        "# Externally edited on disk!\n"
    );

    // saveAs to existing target returns conflict; saveAs to new path succeeds atomically via hard_link
    let existing_other = ws.join("existing.md");
    std::fs::write(&existing_other, "keep me").unwrap();
    let save_as_conflict = service
        .save_as(
            &ws,
            CanvasDocumentSaveAsRequest {
                document_id: "doc-1".to_owned(),
                generation: 1,
                edit_revision: 4,
                content: "# Forked\n".to_owned(),
                path: "existing.md".to_owned(),
            },
        )
        .await;
    match save_as_conflict {
        CanvasDocumentSaveResult::Err { error, .. } => assert_eq!(error.kind, "conflict"),
        other => panic!("expected saveAs conflict, got {other:?}"),
    }

    let save_as_ok = service
        .save_as(
            &ws,
            CanvasDocumentSaveAsRequest {
                document_id: "doc-1".to_owned(),
                generation: 1,
                edit_revision: 5,
                content: "# Forked cleanly\n".to_owned(),
                path: "forked.md".to_owned(),
            },
        )
        .await;
    match save_as_ok {
        CanvasDocumentSaveResult::Ok { status, path, .. } => {
            assert_eq!(status, "saved");
            assert!(path.ends_with("forked.md"));
        }
        other => panic!("expected saveAs ok, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(ws.join("forked.md")).unwrap(),
        "# Forked cleanly\n"
    );

    let closed = service
        .close(
            &ws,
            CanvasDocumentSessionRef {
                document_id: "doc-1".to_owned(),
                generation: 1,
            },
        )
        .await
        .expect("close succeeds");
    assert!(closed.ok);

    let rev_after_close = service
        .revision(
            &ws,
            CanvasDocumentSessionRef {
                document_id: "doc-1".to_owned(),
                generation: 1,
            },
        )
        .await;
    match rev_after_close {
        CanvasDocumentRevisionResult::Err { error, .. } => {
            assert_eq!(error.kind, "session_not_found");
        }
        other => panic!("expected session_not_found after close, got {other:?}"),
    }
}

fn write_executable(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, body).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[tokio::test]
async fn presentation_preview_renders_via_sandboxed_soffice_and_falls_back_to_svg_text() {
    let (_guard, root) = canonical_temp_dir("cowork-pres-");
    let ws = root.join("workspace");
    let home = root.join("home");
    let runtime_bin = root.join("runtime-bin");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_bin).unwrap();

    let pptx = build_zip(&[(
        "ppt/slides/slide1.xml",
        br#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly Strategy &amp; Roadmap</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#,
    )]);
    std::fs::write(ws.join("strategy.pptx"), &pptx).unwrap();

    // 1. Without runtime binaries -> text-only SVG fallback
    let empty_env = HashMap::new();
    let fallback = preview_presentation_file(PresentationPreviewRequest {
        cwd: &ws,
        file_path: "strategy.pptx",
        soffice_runner: None,
        env: &empty_env,
        timeout_ms: Some(5_000),
    })
    .await;
    match fallback {
        PresentationPreviewResult::Ok {
            slides,
            rendering_mode,
            warnings,
            ..
        } => {
            assert_eq!(rendering_mode.as_deref(), Some("text"));
            assert_eq!(slides.len(), 1);
            assert!(
                slides[0]
                    .png_base64
                    .starts_with("data:image/svg+xml;base64,")
            );
            let svg_bytes = BASE64
                .decode(
                    slides[0]
                        .png_base64
                        .trim_start_matches("data:image/svg+xml;base64,")
                        .as_bytes(),
                )
                .unwrap();
            let svg_str = String::from_utf8(svg_bytes).unwrap();
            assert!(svg_str.contains("Quarterly Strategy &amp; Roadmap"));
            assert!(!warnings.unwrap_or_default().is_empty());
        }
        other => panic!("expected text fallback ok, got {other:?}"),
    }

    // 2. With managed sandboxed SofficeRunner + pdftoppm -> native PNG rendering (`renderingMode: "rendered"`)
    let soffice_bin = runtime_bin.join("soffice");
    write_executable(
        &soffice_bin,
        r#"#!/bin/bash
set -euo pipefail
outdir=""
input_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --outdir) outdir="$2"; shift 2 ;;
    --convert-to) shift 2 ;;
    --*|-env:*) shift ;;
    *) input_file="$1"; shift ;;
  esac
done
base="$(basename "$input_file")"
stem="${base%.*}"
printf '%%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%%%EOF\n' > "${outdir}/${stem}.pdf"
"#,
    );
    let pdftoppm_bin = runtime_bin.join("pdftoppm");
    write_executable(
        &pdftoppm_bin,
        r#"#!/bin/bash
set -euo pipefail
prefix="${@: -1}"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x00IEND\xaeB`\x82' > "${prefix}-1.png"
"#,
    );

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        soffice_bin.to_string_lossy().into_owned(),
    );
    env.insert(
        "COWORK_RUNTIME_PDFTOPPM".to_owned(),
        pdftoppm_bin.to_string_lossy().into_owned(),
    );

    let runner = SofficeRunner::new(SofficeRunnerConfig {
        max_concurrent: 2,
        default_timeout: Duration::from_secs(10),
        sandbox_manager: SandboxManager::new(),
        homedir: home,
    });

    let rendered = preview_presentation_file(PresentationPreviewRequest {
        cwd: &ws,
        file_path: "strategy.pptx",
        soffice_runner: Some(&runner),
        env: &env,
        timeout_ms: Some(10_000),
    })
    .await;
    match rendered {
        PresentationPreviewResult::Ok {
            slides,
            rendering_mode,
            warnings,
            ..
        } => {
            assert_eq!(rendering_mode.as_deref(), Some("rendered"));
            assert_eq!(slides.len(), 1);
            assert!(slides[0].png_base64.starts_with("data:image/png;base64,"));
            assert!(warnings.unwrap_or_default().is_empty());
        }
        other => panic!("expected native rendered ok, got {other:?}"),
    }
}
