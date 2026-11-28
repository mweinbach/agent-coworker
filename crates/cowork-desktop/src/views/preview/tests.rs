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

    renderer.upload_images(&gpu.device, &gpu.queue, &mut rt.images);
    renderer.prepare_surfaces(&gpu.device, &gpu.queue, &rt.surfaces, (dw, dh));
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
            spreadsheet: Some(data.clone()),
            ..Default::default()
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
        spreadsheet: Some(data),
        ..Default::default()
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
    let mut rt = Runtime::new(
        wide_workbook_state(),
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

/// A column past the right edge of a wide sheet must be reachable: the table keeps each column
/// at its own width and scrolls sideways, with the row-index column pinned.
#[test]
fn wide_spreadsheet_scrolls_sideways_to_reach_every_column() {
    let mut rt = Runtime::new(
        wide_workbook_state(),
        render_preview_root,
        PREVIEW_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt.frame(0.0);

    macro_rules! header {
        ($title:expr) => {
            rt.elements()
                .iter()
                .find(|e| e.text.as_deref() == Some($title))
                .map(|e| e.rect)
        };
    }

    let index_before = header!("#").expect("row index header");
    let first = header!("C1").expect("first column header");
    let last = header!("C12").expect("last column header is laid out");
    assert!(
        last[0] > first[0] && last[0] >= PREVIEW_VIEWPORT.0,
        "columns keep their own width past the pane edge: first {first:?}, last {last:?}"
    );

    // A horizontal wheel gesture over the middle of the table scrolls it toward its last columns.
    let table = rt
        .elements()
        .iter()
        .find(|e| e.key.as_deref() == Some("spreadsheet-table-scroll-0"))
        .expect("table viewport")
        .rect;
    let (cx, cy) = (table[0] + table[2] / 2.0, table[1] + table[3] / 2.0);
    rt.pointer_move(cx, cy);
    rt.wheel_began();
    rt.wheel_xy(cx, cy, -600.0, 0.0);
    rt.wheel_ended();
    for step in 1..=60u32 {
        rt.frame(f64::from(step) * 0.05);
    }

    let last_after = header!("C12").expect("last column header after scrolling");
    let index_after = header!("#").expect("row index header after scrolling");
    assert!(
        last_after[0] >= index_after[0] + index_after[2]
            && last_after[0] + last_after[2] <= PREVIEW_VIEWPORT.0 + 1.0,
        "last column must scroll fully into view beside the pinned row index: {last_after:?}"
    );
    assert!(
        (index_after[0] - index_before[0]).abs() < 0.5,
        "row index column stays pinned while the sheet scrolls: {index_before:?} -> {index_after:?}"
    );
}

/// A two-sheet workbook with twelve columns and forty rows: wider and taller than the pane.
fn wide_workbook_state() -> AppState {
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
        spreadsheet: Some(data),
        ..Default::default()
    });
    state.sync_preview_ui();
    state
}

fn escape_xml_text(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn encode_svg_slide_data_url(title: &str, subtitle: &str, accent_hex: &str) -> String {
    use base64::Engine as _;

    let title = escape_xml_text(title);
    let subtitle = escape_xml_text(subtitle);
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#ffffff"/><rect x="0" y="0" width="1600" height="36" fill="{accent_hex}"/><text x="96" y="180" font-family="Arial,sans-serif" font-size="64" font-weight="bold" fill="#18181b">{title}</text><text x="96" y="280" font-family="Arial,sans-serif" font-size="34" fill="#52525b">{subtitle}</text><rect x="96" y="360" width="640" height="360" rx="16" fill="#f4f4f5" stroke="#e4e4e7" stroke-width="2"/><rect x="780" y="360" width="720" height="360" rx="16" fill="#f4f4f5" stroke="#e4e4e7" stroke-width="2"/></svg>"##
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
    )
}

fn encode_png_slide_data_url(width: u32, height: u32, top_rgb: [u8; 3]) -> String {
    use base64::Engine as _;

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            if y < 14 {
                rgba.extend_from_slice(&[top_rgb[0], top_rgb[1], top_rgb[2], 255]);
            } else if x > 28 && x < width - 28 && y > 36 && y < height - 24 {
                rgba.extend_from_slice(&[244, 244, 248, 255]);
            } else {
                rgba.extend_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
    let dir = tempfile::tempdir().expect("tempdir for test png");
    let file = dir.path().join("slide.png");
    write_png(&file, width, height, &rgba).expect("write slide png");
    let png_bytes = std::fs::read(&file).expect("read slide png");
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png_bytes)
    )
}

fn encode_server_text_svg_data_url(slide_num: usize, body_lines: &[&str]) -> String {
    use base64::Engine as _;

    let tspans: String = body_lines
        .iter()
        .enumerate()
        .map(|(idx, line)| {
            let dy = if idx == 0 { 0 } else { 38 };
            format!(
                r#"<tspan x="80" dy="{dy}">{}</tspan>"#,
                escape_xml_text(line)
            )
        })
        .collect();

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><text x="80" y="70" font-family="Arial,sans-serif" font-size="24" fill="#666">Slide {slide_num} · Text-only preview</text><text x="80" y="132" font-family="Arial,sans-serif" font-size="30" fill="#202124">{tspans}</text></svg>"##
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
    )
}

fn sample_presentation_slides() -> Vec<super::state::PresentationSlideData> {
    use super::state::PresentationSlideData;

    vec![
        PresentationSlideData {
            slide_index: 0,
            slide_id: Some("s1".to_string()),
            title: Some("Q4 Architecture & Goals".to_string()),
            png_base64: encode_svg_slide_data_url(
                "Q4 Architecture & Goals",
                "Local-first AI coworker on native Rune desktop",
                "#2563eb",
            ),
        },
        PresentationSlideData {
            slide_index: 1,
            slide_id: Some("s2".to_string()),
            title: Some("Throughput Benchmarks".to_string()),
            png_base64: encode_png_slide_data_url(320, 180, [16, 185, 129]),
        },
        PresentationSlideData {
            slide_index: 2,
            slide_id: Some("s3".to_string()),
            title: Some("Rollout Timeline".to_string()),
            png_base64: encode_svg_slide_data_url(
                "Rollout Timeline",
                "Phase 1 canary • Phase 2 general availability",
                "#d97706",
            ),
        },
    ]
}

fn maybe_save_snap_sized(name: &str, size: (f32, f32), rgba: &[u8], scale: f32) {
    let Ok(dir) = std::env::var("COWORK_PREVIEW_SNAP_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create preview snap dir");
    let dw = (size.0 * scale) as u32;
    let dh = (size.1 * scale) as u32;
    write_png(&dir.join(format!("{name}.png")), dw, dh, rgba).expect("write presentation png");
}

struct HeadlessCanvas {
    gpu: Gpu,
    renderer: Renderer,
    target: Offscreen,
    dw: u32,
    dh: u32,
    clear: [f32; 4],
}

impl HeadlessCanvas {
    fn new(size: (f32, f32), scale: f32, dark: bool) -> Self {
        let gpu = Gpu::headless();
        let renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
        let dw = (size.0 * scale) as u32;
        let dh = (size.1 * scale) as u32;
        let target = Offscreen::new(&gpu.device, dw, dh);
        let tokens = theme::resolve_tokens(dark, false, false);
        let clear = [
            tokens.panel_bg.r,
            tokens.panel_bg.g,
            tokens.panel_bg.b,
            tokens.panel_bg.a,
        ];
        Self {
            gpu,
            renderer,
            target,
            dw,
            dh,
            clear,
        }
    }

    fn draw(&mut self, rt: &mut Runtime<AppState>) -> Vec<u8> {
        self.renderer
            .upload_images(&self.gpu.device, &self.gpu.queue, &mut rt.images);
        self.renderer.prepare_surfaces(
            &self.gpu.device,
            &self.gpu.queue,
            &rt.surfaces,
            (self.dw, self.dh),
        );
        self.renderer.prepare(
            &self.gpu.device,
            &self.gpu.queue,
            &mut rt.text.atlas,
            &rt.instances,
            (self.dw, self.dh),
        );
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        self.renderer.draw(&mut enc, &self.target.view, self.clear);
        self.target.copy(&mut enc);
        self.renderer.submit(&self.gpu.queue, enc);
        self.target.read(&self.gpu.device)
    }
}

fn render_offscreen_rgba_sized(
    rt: &mut Runtime<AppState>,
    size: (f32, f32),
    dark: bool,
) -> Vec<u8> {
    let mut canvas = HeadlessCanvas::new(size, rt.env.scale, dark);
    canvas.draw(rt)
}

#[test]
fn presentation_rpc_payload_parses_rendered_text_notice_and_errors() {
    use super::state::PresentationPreviewData;
    use serde_json::json;

    let rendered = PresentationPreviewData::from_rpc_payload(&json!({
        "ok": true,
        "path": "/ws/deck.pptx",
        "renderingMode": "rendered",
        "warnings": [],
        "slides": [
            {
                "slideIndex": 0,
                "slideId": "1",
                "title": "Intro",
                "pngBase64": "data:image/png;base64,AAAA"
            }
        ]
    }));
    assert!(!rendered.loading);
    assert!(rendered.error_message.is_none());
    assert_eq!(rendered.slides.len(), 1);
    assert_eq!(rendered.slides[0].title.as_deref(), Some("Intro"));
    assert_eq!(rendered.notice_details(), (false, Vec::new()));

    let text_only = PresentationPreviewData::from_rpc_payload(&json!({
        "ok": true,
        "path": "/ws/deck.pptx",
        "renderingMode": "text",
        "warnings": [
            "The verified native presentation renderer is unavailable.",
            "Text-only preview: images, charts, layout, and original styling are not shown. Long slide text may be shortened."
        ],
        "slides": [
            {
                "slideIndex": 0,
                "pngBase64": "data:image/svg+xml;base64,PHN2Zy8+"
            }
        ]
    }));
    let (is_text, details) = text_only.notice_details();
    assert!(is_text);
    assert_eq!(
        details,
        vec!["The verified native presentation renderer is unavailable.".to_string()]
    );

    let err_payload = PresentationPreviewData::from_rpc_payload(&json!({
        "ok": false,
        "error": {
            "kind": "unsupported_format",
            "message": "Export this legacy .ppt deck to .pptx for a text-only preview."
        }
    }));
    assert_eq!(
        err_payload.error_kind.as_deref(),
        Some("unsupported_format")
    );
    assert!(
        err_payload
            .error_message
            .as_deref()
            .unwrap()
            .contains(".pptx")
    );

    let malformed = PresentationPreviewData::from_rpc_payload(&json!({ "unexpected": 123 }));
    assert_eq!(malformed.error_kind.as_deref(), Some("compile_error"));

    let svg_sample = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><text x="80" y="70" font-size="24" fill="#666">Slide 1 &#183; Text &amp; Notes</text><text x="80" y="132" font-size="30" fill="#202124"><tspan x="80" dy="0">First point</tspan><tspan x="80" dy="38">Second point &lt;alpha&gt;</tspan></text></svg>"##;
    let overlay = super::presentation::extract_svg_text_overlay(svg_sample)
        .expect("SVG text overlay should extract <text> and <tspan> nodes");
    assert_eq!(overlay.view_w, 1600.0);
    assert_eq!(overlay.view_h, 900.0);
    assert_eq!(overlay.lines.len(), 3);
    assert_eq!(overlay.lines[0].text, "Slide 1 · Text & Notes");
    assert_eq!(overlay.lines[1].text, "First point");
    assert_eq!(overlay.lines[2].text, "Second point <alpha>");
    assert!(overlay.lines[2].top_vb > overlay.lines[1].top_vb);
}

#[test]
fn preview_ui_state_tracks_slide_navigation_layout_and_resets_on_path_change() {
    use super::state::{PresentationLayoutMode, PresentationPreviewData};
    use rune::Key;

    let data = PresentationPreviewData {
        slides: sample_presentation_slides(),
        ..Default::default()
    };
    let mut ui = PreviewUiState::default();
    let mut tx = rune::Tx::default();
    ui.sync_for_presentation_data(Some("/ws/deck.pptx"), Some(&data));
    assert_eq!(ui.active_slide, 0);
    assert_eq!(ui.presentation_layout, PresentationLayoutMode::Deck);

    assert!(ui.handle_presentation_key_tx(&Key::Right, data.slides.len(), &mut tx));
    assert_eq!(ui.active_slide, 1);
    assert!(ui.handle_presentation_key_tx(&Key::End, data.slides.len(), &mut tx));
    assert_eq!(ui.active_slide, 2);
    assert!(ui.handle_presentation_key_tx(&Key::Left, data.slides.len(), &mut tx));
    assert_eq!(ui.active_slide, 1);
    assert!(ui.handle_presentation_key_tx(&Key::Home, data.slides.len(), &mut tx));
    assert_eq!(ui.active_slide, 0);
    ui.prev_slide(&mut tx);
    assert_eq!(ui.active_slide, 0);
    ui.set_presentation_layout(PresentationLayoutMode::Grid);
    assert_eq!(ui.presentation_layout, PresentationLayoutMode::Grid);

    // Same-path refresh preserves active slide if still in range, clamping only if shortened.
    ui.select_slide(2, data.slides.len(), &mut tx);
    ui.sync_for_presentation_data(Some("/ws/deck.pptx"), Some(&data));
    assert_eq!(ui.active_slide, 2);

    // Switching files resets slide and returns to Deck mode.
    ui.sync_for_presentation_data(Some("/ws/other.pptx"), Some(&data));
    assert_eq!(ui.active_slide, 0);
    assert_eq!(ui.presentation_layout, PresentationLayoutMode::Deck);

    ui.sync_for_presentation_data(None, None);
    assert!(ui.active_path.is_empty());
}

fn render_test_presentation_root(s: &AppState, cx: &mut rune::Cx<AppState>) -> rune::El {
    let dark = s.effective_dark(cx.system_dark());
    let (kit, tokens) = theme::build_kit(dark, false, false);
    cx.foreground(tokens.text_base);
    cx.focus_ring(2.0, 2.5, tokens.focus_ring);
    let preview = s.active_file_preview.as_ref().expect("preview present");
    let data = preview
        .presentation
        .as_deref()
        .expect("presentation preview payload present");
    rune::el().w_full().h_full().fill(tokens.panel_bg).child(
        super::presentation::render_presentation_preview(s, preview, data, &kit, &tokens),
    )
}

#[test]
fn renders_presentation_deck_grid_notice_and_navigates_headlessly_in_light_and_dark() {
    use super::state::{PresentationLayoutMode, PresentationPreviewData};
    use crate::ws::WsCommand;
    use rune::{Key, KeyEvent, Mods};

    const PRES_VIEWPORT: (f32, f32) = (760.0, 560.0);
    const COMPACT_VIEWPORT: (f32, f32) = (440.0, 540.0);

    let mut slides = sample_presentation_slides();
    let extra_slide = slides[2].clone();
    for idx in slides.len()..18 {
        let mut slide = extra_slide.clone();
        slide.slide_index = idx;
        slide.slide_id = Some(format!("s{}", idx + 1));
        slide.title = Some(format!("Slide {}", idx + 1));
        slides.push(slide);
    }
    let rendered_data = PresentationPreviewData {
        slides: slides.clone(),
        rendering_mode: Some("rendered".to_string()),
        ..Default::default()
    };
    let text_notice_slides = vec![
        super::state::PresentationSlideData {
            slide_index: 0,
            slide_id: Some("t1".to_string()),
            title: Some("Q4 Roadmap Overview".to_string()),
            png_base64: encode_server_text_svg_data_url(
                1,
                &[
                    "Q4 Roadmap & Architecture Overview",
                    "• Native Rune presentation preview powered by cowork/workspace/presentation/preview",
                    "• High-DPI rasterized LibreOffice slides when runtime is installed",
                    "• Deterministic text-only SVG fallback with slide & layout warning banner",
                ],
            ),
        },
        super::state::PresentationSlideData {
            slide_index: 1,
            slide_id: Some("t2".to_string()),
            title: Some("Verification Summary".to_string()),
            png_base64: encode_server_text_svg_data_url(
                2,
                &[
                    "Verification Summary",
                    "All headless light/dark snapshots, Deck/Grid toggles, and keyboard shortcuts tested.",
                ],
            ),
        },
    ];
    let text_notice_data = PresentationPreviewData {
        slides: text_notice_slides,
        rendering_mode: Some("text".to_string()),
        warnings: vec![
            "The verified native presentation renderer is unavailable.".to_string(),
            "Text-only preview: images, charts, layout, and original styling are not shown."
                .to_string(),
        ],
        ..Default::default()
    };
    let error_data = PresentationPreviewData::from_error(
        "unsupported_format",
        "Export this legacy .ppt deck to .pptx for a text-only preview.",
    );

    // 1) Deck view in Light and Dark themes + PNG/SVG slide decoding + interactive navigation.
    for dark in [false, true] {
        let preview = FilePreviewState {
            workspace_id: "ws-1".to_string(),
            path: "/ws/quarterly_review.pptx".to_string(),
            title: "quarterly_review.pptx".to_string(),
            is_binary: true,
            presentation: Some(Box::new(rendered_data.clone())),
            ..Default::default()
        };
        let mut state = AppState {
            scene_mode: true,
            system_dark_override: Some(dark),
            active_file_preview: Some(preview),
            ..Default::default()
        };
        state.desktop_settings.theme = if dark {
            theme::ThemePreference::Dark
        } else {
            theme::ThemePreference::Light
        };
        state.shell_ui.viewport_width = 1280.0;
        state
            .preview_ui
            .sync_for_presentation_data(Some("/ws/quarterly_review.pptx"), Some(&rendered_data));

        let mut rt = Runtime::new(
            state,
            render_test_presentation_root,
            PRES_VIEWPORT,
            Env::new(true, 2.0),
        );
        rt.frame(0.0);

        let mut canvas = HeadlessCanvas::new(PRES_VIEWPORT, rt.env.scale, dark);
        let rgba = canvas.draw(&mut rt);
        assert!(
            rgba.chunks_exact(4).any(|px| px[..3] != rgba[..3]),
            "rendered presentation preview must not be blank (dark={dark})"
        );
        let snap_name = if dark {
            "presentation-preview-deck-dark"
        } else {
            "presentation-preview-deck-light"
        };
        maybe_save_snap_sized(snap_name, PRES_VIEWPORT, &rgba, 2.0);

        let els = rt.elements();
        for key in [
            "pptx-preview-root",
            "pptx-preview-meta",
            "pptx-layout-picker",
            "pptx-refresh-btn",
            "pptx-thumb-strip",
            "pptx-thumb-0",
            "pptx-thumb-1",
            "pptx-thumb-2",
            "pptx-slide-stage",
            "pptx-active-slide-image",
            "pptx-nav-bar",
            "pptx-prev-btn",
            "pptx-slide-counter",
            "pptx-next-btn",
        ] {
            assert!(
                els.iter().any(|e| e.key.as_deref() == Some(key)),
                "expected key `{key}` in Deck presentation preview"
            );
        }

        let nav_rect = els
            .iter()
            .find(|e| e.key.as_deref() == Some("pptx-nav-bar"))
            .unwrap()
            .rect;
        assert!(
            nav_rect[1] + nav_rect[3] <= PRES_VIEWPORT.1 + 0.5,
            "pptx-nav-bar must stay within viewport bottom: {nav_rect:?}"
        );

        if !dark {
            // Click next -> slide 1 (PNG slide), render grid mode snap, click card 2 -> Deck slide 2.
            let click_key = |rt: &mut Runtime<AppState>, key: &str| {
                let rect = rt
                    .elements()
                    .into_iter()
                    .find(|e| e.key.as_deref() == Some(key))
                    .unwrap_or_else(|| panic!("missing clickable key `{key}`"))
                    .rect;
                let cx = rect[0] + rect[2] * 0.5;
                let cy = rect[1] + rect[3] * 0.5;
                rt.pointer_down(cx, cy);
                rt.pointer_up(cx, cy);
                for _ in 0..30 {
                    rt.frame(1.0 / 60.0);
                }
            };

            click_key(&mut rt, "pptx-next-btn");
            assert_eq!(rt.state.preview_ui.active_slide, 1);

            click_key(&mut rt, "segment1");
            assert_eq!(
                rt.state.preview_ui.presentation_layout,
                PresentationLayoutMode::Grid
            );
            rt.update(|_, tx| tx.focus("pptx-preview-root", false));
            rt.key(KeyEvent {
                key: Key::End,
                mods: Mods::default(),
            });
            rt.frame(0.02);
            assert_eq!(rt.state.preview_ui.active_slide, slides.len() - 1);
            let els = rt.elements();
            let grid_rect = els
                .iter()
                .find(|e| e.key.as_deref() == Some("pptx-grid-scroll"))
                .unwrap()
                .rect;
            let selected_rect = els
                .iter()
                .find(|e| e.key.as_deref() == Some("pptx-grid-card-17"))
                .expect("End reveals the selected virtual grid card")
                .rect;
            assert!(
                selected_rect[1] >= grid_rect[1] - 0.5
                    && selected_rect[1] + selected_rect[3] <= grid_rect[1] + grid_rect[3] + 0.5,
                "selected grid card must be revealed: card={selected_rect:?}, grid={grid_rect:?}"
            );
            rt.key(KeyEvent {
                key: Key::Home,
                mods: Mods::default(),
            });
            rt.frame(0.02);

            let grid_rgba = canvas.draw(&mut rt);
            maybe_save_snap_sized(
                "presentation-preview-grid-light",
                PRES_VIEWPORT,
                &grid_rgba,
                2.0,
            );
            assert!(
                rt.elements()
                    .iter()
                    .any(|e| e.key.as_deref() == Some("pptx-grid-card-2"))
            );

            click_key(&mut rt, "pptx-grid-card-2");
            assert_eq!(rt.state.preview_ui.active_slide, 2);
            assert_eq!(
                rt.state.preview_ui.presentation_layout,
                PresentationLayoutMode::Deck
            );

            // Focus root and verify Left / Right / End / Home keyboard navigation.
            click_key(&mut rt, "pptx-preview-root");
            rt.key(KeyEvent {
                key: Key::Left,
                mods: Mods::default(),
            });
            rt.frame(0.02);
            assert_eq!(rt.state.preview_ui.active_slide, 1);
            rt.key(KeyEvent {
                key: Key::Home,
                mods: Mods::default(),
            });
            rt.frame(0.02);
            assert_eq!(rt.state.preview_ui.active_slide, 0);
            rt.key(KeyEvent {
                key: Key::End,
                mods: Mods::default(),
            });
            rt.frame(0.02);
            assert_eq!(rt.state.preview_ui.active_slide, slides.len() - 1);
            let els = rt.elements();
            let strip_rect = els
                .iter()
                .find(|e| e.key.as_deref() == Some("pptx-thumb-strip"))
                .unwrap()
                .rect;
            let selected_rect = els
                .iter()
                .find(|e| e.key.as_deref() == Some("pptx-thumb-17"))
                .expect("End reveals the selected virtual filmstrip tile")
                .rect;
            assert!(
                selected_rect[1] >= strip_rect[1] - 0.5
                    && selected_rect[1] + selected_rect[3] <= strip_rect[1] + strip_rect[3] + 0.5,
                "selected filmstrip tile must be revealed: tile={selected_rect:?}, strip={strip_rect:?}"
            );
        }
    }

    // 2) Text-only fallback warning banner in light mode.
    {
        let mut state = AppState {
            scene_mode: true,
            system_dark_override: Some(false),
            active_file_preview: Some(FilePreviewState {
                workspace_id: "ws-1".to_string(),
                path: "/ws/text_fallback.pptx".to_string(),
                title: "text_fallback.pptx".to_string(),
                is_binary: true,
                presentation: Some(Box::new(text_notice_data)),
                ..Default::default()
            }),
            ..Default::default()
        };
        state.desktop_settings.theme = theme::ThemePreference::Light;
        state.shell_ui.viewport_width = 1280.0;
        let mut rt = Runtime::new(
            state,
            render_test_presentation_root,
            PRES_VIEWPORT,
            Env::new(true, 2.0),
        );
        rt.frame(0.0);
        let rgba = render_offscreen_rgba_sized(&mut rt, PRES_VIEWPORT, false);
        maybe_save_snap_sized(
            "presentation-preview-text-notice-light",
            PRES_VIEWPORT,
            &rgba,
            2.0,
        );
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.key.as_deref() == Some("pptx-preview-notice"))
        );
    }

    // 3) Compact width (<520pt estimated preview width) in dark mode renders bottom strip cleanly.
    {
        let mut state = AppState {
            scene_mode: true,
            system_dark_override: Some(true),
            active_file_preview: Some(FilePreviewState {
                workspace_id: "ws-1".to_string(),
                path: "/ws/compact_deck.pptx".to_string(),
                title: "compact_deck.pptx".to_string(),
                is_binary: true,
                presentation: Some(Box::new(rendered_data)),
                ..Default::default()
            }),
            ..Default::default()
        };
        state.desktop_settings.theme = theme::ThemePreference::Dark;
        state.shell_ui.viewport_width = 860.0;
        let mut rt = Runtime::new(
            state,
            render_test_presentation_root,
            COMPACT_VIEWPORT,
            Env::new(true, 2.0),
        );
        rt.frame(0.0);
        let rgba = render_offscreen_rgba_sized(&mut rt, COMPACT_VIEWPORT, true);
        maybe_save_snap_sized(
            "presentation-preview-compact-dark",
            COMPACT_VIEWPORT,
            &rgba,
            2.0,
        );

        let els = rt.elements();
        let strip_rect = els
            .iter()
            .find(|e| e.key.as_deref() == Some("pptx-thumb-strip"))
            .unwrap()
            .rect;
        let stage_rect = els
            .iter()
            .find(|e| e.key.as_deref() == Some("pptx-slide-stage"))
            .unwrap()
            .rect;
        assert!(
            strip_rect[1] > stage_rect[1],
            "compact layout should place thumbnail strip below stage: strip={strip_rect:?}, stage={stage_rect:?}"
        );
        assert!(
            strip_rect[1] + strip_rect[3] <= COMPACT_VIEWPORT.1 + 0.5,
            "compact thumbnail strip must fit inside viewport: {strip_rect:?}"
        );

        rt.update(|_, tx| tx.focus("pptx-preview-root", false));
        rt.key(KeyEvent {
            key: Key::End,
            mods: Mods::default(),
        });
        rt.frame(0.02);
        let els = rt.elements();
        let strip_rect = els
            .iter()
            .find(|e| e.key.as_deref() == Some("pptx-thumb-strip"))
            .unwrap()
            .rect;
        let selected_rect = els
            .iter()
            .find(|e| e.key.as_deref() == Some("pptx-thumb-17"))
            .expect("End reveals the selected compact filmstrip tile")
            .rect;
        assert!(
            selected_rect[0] >= strip_rect[0] - 0.5
                && selected_rect[0] + selected_rect[2] <= strip_rect[0] + strip_rect[2] + 0.5,
            "selected compact tile must be revealed horizontally: tile={selected_rect:?}, strip={strip_rect:?}"
        );
    }

    // 4) Error fallback card renders cleanly and "Try again" dispatches presentation RPC reload.
    {
        let mut state = AppState {
            scene_mode: true,
            system_dark_override: Some(false),
            active_file_preview: Some(FilePreviewState {
                workspace_id: "ws-1".to_string(),
                path: "/ws/legacy.ppt".to_string(),
                title: "legacy.ppt".to_string(),
                is_binary: true,
                presentation: Some(Box::new(error_data)),
                ..Default::default()
            }),
            ..Default::default()
        };
        state.desktop_settings.theme = theme::ThemePreference::Light;
        state.workspaces.push(crate::state::WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Repo".to_string(),
            path: "/ws".to_string(),
            ..Default::default()
        });
        state.shell_ui.viewport_width = 1280.0;
        let mut rt = Runtime::new(
            state,
            render_test_presentation_root,
            PRES_VIEWPORT,
            Env::new(true, 2.0),
        );
        rt.frame(0.0);
        let rgba = render_offscreen_rgba_sized(&mut rt, PRES_VIEWPORT, false);
        maybe_save_snap_sized(
            "presentation-preview-error-light",
            PRES_VIEWPORT,
            &rgba,
            2.0,
        );
        let retry_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("pptx-retry-btn"))
            .unwrap()
            .rect;
        rt.pointer_down(
            retry_rect[0] + retry_rect[2] * 0.5,
            retry_rect[1] + retry_rect[3] * 0.5,
        );
        rt.pointer_up(
            retry_rect[0] + retry_rect[2] * 0.5,
            retry_rect[1] + retry_rect[3] * 0.5,
        );
        rt.frame(0.02);
        assert!(matches!(
            rt.state.services.emitted_ws_commands.last(),
            Some(WsCommand::SendRequest { method, params, .. })
                if method == "cowork/workspace/presentation/preview"
                    && params.get("path").and_then(|v| v.as_str()) == Some("/ws/legacy.ppt")
        ));
        assert!(
            rt.state
                .active_file_preview
                .as_ref()
                .and_then(|p| p.presentation.as_deref())
                .is_some_and(|p| p.loading)
        );
    }
}
