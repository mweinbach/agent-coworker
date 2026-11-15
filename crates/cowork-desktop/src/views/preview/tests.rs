use std::path::{Path, PathBuf};

use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer, write_png};
use rune::{Cx, El, Env, Runtime, el, row};

use super::decoder::{decode_spreadsheet_preview, excel_column_name};
use super::spreadsheet::render_spreadsheet_preview;
use super::state::{
    MAX_PREVIEW_CELLS, MAX_PREVIEW_COLS, MAX_PREVIEW_ROWS, PreviewUiState, SpreadsheetCellAlign,
};
use crate::state::{AppState, FilePreviewState};
use crate::theme;

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Builds a valid uncompressed (STORE) ZIP archive in memory for testing `.xlsx` parsing.
fn build_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central_dir = Vec::new();

    for &(name, data) in entries {
        let local_offset = out.len() as u32;
        let name_bytes = name.as_bytes();
        let name_len = name_bytes.len() as u16;
        let size = data.len() as u32;
        let sum = crc32(data);

        // Local file header
        out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // compression: STORE
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0u16.to_le_bytes()); // mod date
        out.extend_from_slice(&sum.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        // Central directory file header
        central_dir.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // flags
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // STORE
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&sum.to_le_bytes());
        central_dir.extend_from_slice(&size.to_le_bytes());
        central_dir.extend_from_slice(&size.to_le_bytes());
        central_dir.extend_from_slice(&name_len.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central_dir.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central_dir.extend_from_slice(&local_offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central_dir.len() as u32;
    let count = entries.len() as u16;
    out.extend_from_slice(&central_dir);

    // End of central directory
    out.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Builds a minimal multi-sheet `.xlsx` archive with inline strings, numbers, dates, booleans, and errors.
fn build_minimal_xlsx(sheets: &[(&str, &str)], include_date_style: bool) -> Vec<u8> {
    let mut sheet_overrides = String::new();
    let mut wb_sheets = String::new();
    let mut wb_rels = String::new();
    let mut sheet_files: Vec<(String, Vec<u8>)> = Vec::new();

    for (idx, (name, body_xml)) in sheets.iter().enumerate() {
        let n = idx + 1;
        sheet_overrides.push_str(&format!(
            "<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        ));
        wb_sheets.push_str(&format!(
            "<sheet name=\"{name}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>"
        ));
        wb_rels.push_str(&format!(
            "<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"
        ));
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>{body_xml}</sheetData></worksheet>"
        );
        sheet_files.push((format!("xl/worksheets/sheet{n}.xml"), xml.into_bytes()));
    }

    if include_date_style {
        sheet_overrides.push_str(
            "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>",
        );
        let style_rid = sheets.len() + 1;
        wb_rels.push_str(&format!(
            "<Relationship Id=\"rId{style_rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
        ));
    }

    let content_types = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>{sheet_overrides}</Types>"
    );
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>";
    let workbook = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>{wb_sheets}</sheets></workbook>"
    );
    let workbook_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{wb_rels}</Relationships>"
    );
    let styles_xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"0\"/><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"1\"><fill><patternFill patternType=\"none\"/></fill></fills><borders count=\"1\"><border/></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"14\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs></styleSheet>";

    let mut entries: Vec<(String, Vec<u8>)> = vec![
        (
            "[Content_Types].xml".to_string(),
            content_types.into_bytes(),
        ),
        ("_rels/.rels".to_string(), root_rels.as_bytes().to_vec()),
        ("xl/workbook.xml".to_string(), workbook.into_bytes()),
        (
            "xl/_rels/workbook.xml.rels".to_string(),
            workbook_rels.into_bytes(),
        ),
    ];
    if include_date_style {
        entries.push(("xl/styles.xml".to_string(), styles_xml.as_bytes().to_vec()));
    }
    entries.extend(sheet_files);

    let refs: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();
    build_stored_zip(&refs)
}

#[test]
fn excel_column_letters_convert_accurately() {
    assert_eq!(excel_column_name(0), "A");
    assert_eq!(excel_column_name(25), "Z");
    assert_eq!(excel_column_name(26), "AA");
    assert_eq!(excel_column_name(27), "AB");
    assert_eq!(excel_column_name(51), "AZ");
    assert_eq!(excel_column_name(52), "BA");
}

#[test]
fn decodes_csv_with_bom_quotes_numeric_alignment_and_truncation() {
    let raw = "\u{FEFF}Department,Budget,Notes\n\"Engineering, Core\",\"-$1,250.50\",\"Line 1\nLine 2\"\nOps,900,OK\n";
    let parsed = decode_spreadsheet_preview(Path::new("/ws/budget.csv"), raw.as_bytes(), false)
        .expect("csv should decode");
    assert_eq!(parsed.format, "CSV");
    assert_eq!(parsed.sheets.len(), 1);
    let sheet = &parsed.sheets[0];
    assert_eq!(sheet.name, "budget");
    assert_eq!(sheet.headers, vec!["A", "B", "C"]);
    assert_eq!(sheet.total_rows, 3);
    assert_eq!(sheet.total_cols, 3);
    assert_eq!(
        sheet.rows[1],
        vec!["Engineering, Core", "-$1,250.50", "Line 1 Line 2"]
    );
    assert_eq!(
        sheet.col_alignments,
        vec![
            SpreadsheetCellAlign::Left,
            SpreadsheetCellAlign::Right,
            SpreadsheetCellAlign::Left
        ]
    );
    assert!(!sheet.is_truncated());

    // Byte-truncated CSV drops incomplete trailing line/UTF-8 safely and marks truncated.
    let truncated_bytes = b"A,B\n1,2\n3,incomplete_line";
    let trunc = decode_spreadsheet_preview(Path::new("/ws/large.csv"), truncated_bytes, true)
        .expect("truncated csv should still preview");
    assert!(trunc.sheets[0].rows_truncated);
    assert_eq!(trunc.sheets[0].rows.len(), 2);

    // Binary file claiming .csv extension is rejected cleanly.
    let bin_err = decode_spreadsheet_preview(Path::new("/ws/fake.csv"), b"a,b\x00c", false)
        .expect_err("binary nul in csv must fail");
    assert!(bin_err.contains("binary"));
}

#[test]
fn decodes_multisheet_xlsx_and_enforces_row_col_and_cell_caps() {
    let sheet1_xml = concat!(
        "<row r=\"1\">",
        "<c r=\"A1\" t=\"inlineStr\"><is><t>Item</t></is></c>",
        "<c r=\"B1\" t=\"inlineStr\"><is><t>Cost</t></is></c>",
        "<c r=\"C1\" t=\"inlineStr\"><is><t>Active</t></is></c>",
        "<c r=\"D1\" t=\"inlineStr\"><is><t>Date</t></is></c>",
        "</row>",
        "<row r=\"2\">",
        "<c r=\"A2\" t=\"inlineStr\"><is><t>Servers</t></is></c>",
        "<c r=\"B2\"><v>1250.5</v></c>",
        "<c r=\"C2\" t=\"b\"><v>1</v></c>",
        "<c r=\"D2\" s=\"1\"><v>46341</v></c>",
        "</row>",
        "<row r=\"3\">",
        "<c r=\"A3\" t=\"inlineStr\"><is><t>Whole</t></is></c>",
        "<c r=\"B3\"><v>42.0</v></c>",
        "<c r=\"C3\" t=\"e\"><v>#DIV/0!</v></c>",
        "</row>",
    );
    let sheet2_xml = "";
    let xlsx_bytes = build_minimal_xlsx(&[("Summary", sheet1_xml), ("EmptyTab", sheet2_xml)], true);

    let parsed = decode_spreadsheet_preview(Path::new("/ws/report.xlsx"), &xlsx_bytes, false)
        .expect("xlsx should decode");
    assert_eq!(parsed.format, "XLSX");
    assert_eq!(parsed.total_sheets, 2);
    assert_eq!(parsed.sheets.len(), 2);
    assert!(!parsed.sheets_truncated);

    let s1 = &parsed.sheets[0];
    assert_eq!(s1.name, "Summary");
    assert_eq!(s1.headers, vec!["A", "B", "C", "D"]);
    assert_eq!(s1.rows[0], vec!["Item", "Cost", "Active", "Date"]);
    assert_eq!(s1.rows[1][0], "Servers");
    assert_eq!(s1.rows[1][1], "1250.5");
    assert_eq!(s1.rows[1][2], "TRUE");
    assert_eq!(s1.rows[1][3], "2026-11-15");
    assert_eq!(s1.rows[2][1], "42");
    assert_eq!(s1.rows[2][2], "#DIV/0!");
    assert_eq!(s1.col_alignments[0], SpreadsheetCellAlign::Left);
    assert_eq!(s1.col_alignments[1], SpreadsheetCellAlign::Right);

    let s2 = &parsed.sheets[1];
    assert_eq!(s2.name, "EmptyTab");
    assert!(s2.rows.is_empty());

    // Truncated binary .xlsx must refuse partial unzip cleanly.
    let too_big = decode_spreadsheet_preview(Path::new("/ws/huge.xlsx"), &xlsx_bytes, true)
        .expect_err("truncated binary workbook should fail gracefully");
    assert!(too_big.contains("15 MiB"));

    // Row cap: 505 rows x 2 cols -> capped at MAX_PREVIEW_ROWS (500).
    let mut big_rows = String::from("ColA,ColB\n");
    for i in 1..=504 {
        big_rows.push_str(&format!("k{i},{i}\n"));
    }
    let row_capped =
        decode_spreadsheet_preview(Path::new("/ws/rows.csv"), big_rows.as_bytes(), false)
            .expect("row-capped csv");
    assert_eq!(row_capped.sheets[0].total_rows, 505);
    assert_eq!(row_capped.sheets[0].rows.len(), MAX_PREVIEW_ROWS);
    assert!(row_capped.sheets[0].rows_truncated);
    assert!(!row_capped.sheets[0].cols_truncated);

    // Col + cell cap: 45 cols x 400 rows -> 40 cols max, rows capped at MAX_PREVIEW_CELLS / 40 = 250.
    let mut wide_grid = String::new();
    for r in 0..400 {
        for c in 0..45 {
            if c > 0 {
                wide_grid.push(',');
            }
            wide_grid.push_str(&format!("{r}:{c}"));
        }
        wide_grid.push('\n');
    }
    let wide_capped =
        decode_spreadsheet_preview(Path::new("/ws/wide.csv"), wide_grid.as_bytes(), false)
            .expect("col+cell capped csv");
    let ws = &wide_capped.sheets[0];
    assert_eq!(ws.total_cols, 45);
    assert_eq!(ws.headers.len(), MAX_PREVIEW_COLS);
    assert!(ws.cols_truncated);
    assert!(ws.cells_truncated);
    assert_eq!(ws.rows.len(), MAX_PREVIEW_CELLS / MAX_PREVIEW_COLS);
}

#[test]
fn preview_ui_state_syncs_and_selects_sheets() {
    let mut ui = PreviewUiState::default();
    let parsed = decode_spreadsheet_preview(
        Path::new("/ws/data.xlsx"),
        &build_minimal_xlsx(
            &[
                ("One", "<row r=\"1\"><c r=\"A1\"><v>1</v></c></row>"),
                ("Two", ""),
            ],
            false,
        ),
        false,
    )
    .unwrap();

    // Initial sync opens the workbook at sheet 0.
    ui.sync_for_preview_data(Some("/ws/data.xlsx"), Some(&parsed));
    assert_eq!(ui.active_sheet, 0);

    ui.select_sheet(1);
    assert_eq!(ui.active_sheet, 1);

    // Same path preserves selected sheet within bounds.
    ui.sync_for_preview_data(Some("/ws/data.xlsx"), Some(&parsed));
    assert_eq!(ui.active_sheet, 1);

    // Out-of-range active_sheet is clamped when fewer sheets exist.
    ui.select_sheet(5);
    ui.sync_for_preview_data(Some("/ws/data.xlsx"), Some(&parsed));
    assert_eq!(ui.active_sheet, 1);

    // New path resets selected sheet back to 0.
    ui.sync_for_preview_data(Some("/ws/other.xlsx"), Some(&parsed));
    assert_eq!(ui.active_sheet, 0);

    ui.sync_for_preview_data(None, None);
    assert!(ui.active_path.is_empty());
}

const PREVIEW_VIEWPORT: (f32, f32) = (620.0, 480.0);

fn render_preview_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
    let dark = state.effective_dark(cx.system_dark());
    let (kit, tokens) = theme::build_kit(dark, false, false);
    cx.foreground(tokens.text_base);
    cx.focus_ring(2.0, 2.5, tokens.focus_ring);
    let preview = state
        .active_file_preview
        .as_ref()
        .expect("active preview present");
    let data = preview
        .spreadsheet
        .as_ref()
        .expect("spreadsheet preview present");
    el().w_full()
        .h_full()
        .fill(tokens.panel_bg)
        .child(row().w_full().h_full().child(render_spreadsheet_preview(
            state, preview, data, &kit, &tokens,
        )))
}

fn render_offscreen_rgba(rt: &mut Runtime<AppState>, dark: bool) -> Vec<u8> {
    let gpu = Gpu::headless();
    let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
    let scale = rt.env.scale;
    let dw = (PREVIEW_VIEWPORT.0 * scale) as u32;
    let dh = (PREVIEW_VIEWPORT.1 * scale) as u32;
    let target = Offscreen::new(&gpu.device, dw, dh);

    renderer.prepare(
        &gpu.device,
        &gpu.queue,
        &mut rt.text.atlas,
        &rt.instances,
        (dw, dh),
    );
    let tokens = theme::resolve_tokens(dark, false, false);
    let clear = [
        tokens.panel_bg.r,
        tokens.panel_bg.g,
        tokens.panel_bg.b,
        tokens.panel_bg.a,
    ];
    let mut enc = gpu.device.create_command_encoder(&Default::default());
    renderer.draw(&mut enc, &target.view, clear);
    target.copy(&mut enc);
    renderer.submit(&gpu.queue, enc);
    target.read(&gpu.device)
}

fn maybe_save_snap(name: &str, rgba: &[u8], scale: f32) {
    let Ok(dir) = std::env::var("COWORK_PREVIEW_SNAP_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create preview snap dir");
    let dw = (PREVIEW_VIEWPORT.0 * scale) as u32;
    let dh = (PREVIEW_VIEWPORT.1 * scale) as u32;
    write_png(&dir.join(format!("{name}.png")), dw, dh, rgba).expect("write preview png");
}

#[test]
fn renders_spreadsheet_table_and_sheet_tabs_headlessly_in_light_and_dark() {
    let sheet1_xml = concat!(
        "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Account</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>Q1</t></is></c><c r=\"C1\" t=\"inlineStr\"><is><t>Q2</t></is></c><c r=\"D1\" t=\"inlineStr\"><is><t>Owner</t></is></c></row>",
        "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>Compute</t></is></c><c r=\"B2\"><v>12000</v></c><c r=\"C2\"><v>14500.75</v></c><c r=\"D2\" t=\"inlineStr\"><is><t>Platform</t></is></c></row>",
        "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>Storage</t></is></c><c r=\"B3\"><v>3200</v></c><c r=\"C3\"><v>3100</v></c><c r=\"D3\" t=\"inlineStr\"><is><t>Infra</t></is></c></row>"
    );
    let sheet2_xml = concat!(
        "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Metric</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>Target</t></is></c></row>",
        "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>Uptime</t></is></c><c r=\"B2\"><v>99.95</v></c></row>"
    );
    let xlsx_bytes = build_minimal_xlsx(
        &[("Summary", sheet1_xml), ("Assumptions", sheet2_xml)],
        false,
    );
    let mut data =
        decode_spreadsheet_preview(Path::new("/ws/budget.xlsx"), &xlsx_bytes, false).unwrap();
    // Mark first sheet row-capped so the cap notice banner renders in parity snapshots too.
    data.sheets[0].total_rows = 840;
    data.sheets[0].rows_truncated = true;

    for dark in [false, true] {
        let mut state = AppState {
            scene_mode: true,
            system_dark_override: Some(dark),
            ..Default::default()
        };
        state.desktop_settings.theme = if dark {
            theme::ThemePreference::Dark
        } else {
            theme::ThemePreference::Light
        };
        let preview = FilePreviewState {
            workspace_id: "ws-1".to_string(),
            path: "/ws/budget.xlsx".to_string(),
            title: "budget.xlsx".to_string(),
            content: None,
            is_binary: false,
            is_markdown: false,
            truncated: false,
            error: None,
            spreadsheet: Some(data.clone()),
        };
        state.active_file_preview = Some(preview);
        state.sync_preview_ui();

        let mut rt = Runtime::new(
            state,
            render_preview_root,
            PREVIEW_VIEWPORT,
            Env::new(true, 2.0),
        );
        rt.frame(0.0);

        let rgba = render_offscreen_rgba(&mut rt, dark);
        assert!(
            rgba.chunks_exact(4).any(|px| px[..3] != rgba[..3]),
            "rendered spreadsheet preview must not be blank (dark={dark})"
        );
        let label = if dark {
            "spreadsheet-preview-dark"
        } else {
            "spreadsheet-preview-light"
        };
        maybe_save_snap(label, &rgba, 2.0);

        let els = rt.elements();
        for key in [
            "spreadsheet-preview-root",
            "spreadsheet-preview-meta",
            "spreadsheet-preview-cap-banner",
            "spreadsheet-table-scroll-0",
            "spreadsheet-sheet-tabs",
            "sheet-tab-0",
            "sheet-tab-1",
        ] {
            assert!(
                els.iter().any(|e| e.key.as_deref() == Some(key)),
                "expected key `{key}` in rendered spreadsheet preview"
            );
        }

        // Verify clicking the second sheet tab switches active_sheet cleanly.
        let tab1_rect = els
            .iter()
            .find(|e| e.key.as_deref() == Some("sheet-tab-1"))
            .unwrap()
            .rect;
        let cx = tab1_rect[0] + tab1_rect[2] * 0.5;
        let cy = tab1_rect[1] + tab1_rect[3] * 0.5;
        rt.pointer_down(cx, cy);
        rt.pointer_up(cx, cy);
        rt.frame(0.05);
        assert_eq!(rt.state.preview_ui.active_sheet, 1);
    }
}

#[test]
fn renders_csv_preview_with_raw_toggle() {
    let raw_csv = "Name,Amount\nCompute,1200\nStorage,350\n";
    let data = decode_spreadsheet_preview(Path::new("/ws/costs.csv"), raw_csv.as_bytes(), false)
        .expect("csv should decode");
    let mut state = AppState {
        scene_mode: true,
        system_dark_override: Some(false),
        ..Default::default()
    };
    state.active_file_preview = Some(FilePreviewState {
        workspace_id: "ws-1".to_string(),
        path: "/ws/costs.csv".to_string(),
        title: "costs.csv".to_string(),
        content: Some(raw_csv.to_string()),
        is_binary: false,
        is_markdown: false,
        truncated: false,
        error: None,
        spreadsheet: Some(data),
    });
    state.sync_preview_ui();

    let mut rt = Runtime::new(
        state,
        render_preview_root,
        PREVIEW_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt.frame(0.0);
    let rgba_table = render_offscreen_rgba(&mut rt, false);
    maybe_save_snap("spreadsheet-preview-csv-table-light", &rgba_table, 2.0);
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.key.as_deref() == Some("spreadsheet-table-scroll-0"))
    );

    rt.state.preview_ui.raw_csv_mode = true;
    rt.frame(0.6);
    rt.frame(1.2);
    let rgba_raw = render_offscreen_rgba(&mut rt, false);
    maybe_save_snap("spreadsheet-preview-csv-raw-light", &rgba_raw, 2.0);
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.key.as_deref() == Some("spreadsheet-preview-raw-csv"))
    );
}

#[test]
fn wide_and_tall_spreadsheet_preserves_sheet_tabs_without_vertical_overflow() {
    let mut csv = String::from("C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11,C12\n");
    for r in 1..=40 {
        csv.push_str(&format!(
            "Row-{r},100,200,300,Alpha,Beta,Gamma,Delta,Epsilon,Zeta,Eta,Theta\n"
        ));
    }
    let sheet = decode_spreadsheet_preview(Path::new("/ws/wide.csv"), csv.as_bytes(), false)
        .expect("wide csv should decode")
        .sheets
        .into_iter()
        .next()
        .unwrap();

    let mut sheet2 = sheet.clone();
    sheet2.name = "Second".to_string();
    let data = super::state::SpreadsheetPreviewData {
        format: "XLSX".to_string(),
        sheets: vec![sheet, sheet2],
        total_sheets: 2,
        sheets_truncated: false,
        max_rows_cap: MAX_PREVIEW_ROWS,
        max_cols_cap: MAX_PREVIEW_COLS,
        max_cells_cap: MAX_PREVIEW_CELLS,
    };

    let mut state = AppState {
        scene_mode: true,
        system_dark_override: Some(false),
        ..Default::default()
    };
    state.active_file_preview = Some(FilePreviewState {
        workspace_id: "ws-1".to_string(),
        path: "/ws/wide_and_tall_financial_summary_2026.xlsx".to_string(),
        title: "wide_and_tall_financial_summary_2026.xlsx".to_string(),
        content: None,
        is_binary: false,
        is_markdown: false,
        truncated: false,
        error: None,
        spreadsheet: Some(data),
    });
    state.sync_preview_ui();

    let mut rt = Runtime::new(
        state,
        render_preview_root,
        PREVIEW_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt.frame(0.0);
    let rgba = render_offscreen_rgba(&mut rt, false);
    maybe_save_snap("spreadsheet-preview-wide-light", &rgba, 2.0);

    let els = rt.elements();
    let tabs_rect = els
        .iter()
        .find(|e| e.key.as_deref() == Some("spreadsheet-sheet-tabs"))
        .expect("sheet tabs should render on multi-sheet wide/tall workbook")
        .rect;
    assert!(
        tabs_rect[1] + tabs_rect[3] <= PREVIEW_VIEWPORT.1 + 0.5,
        "sheet tabs must stay inside viewport bottom: {tabs_rect:?}"
    );
}
