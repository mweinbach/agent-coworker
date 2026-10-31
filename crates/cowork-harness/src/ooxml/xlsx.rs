//! Native Rust `.xlsx` OOXML parser (`src/server/artifacts/xlsx.ts` & `src/server/spreadsheet/ooxml.ts` parity).

use std::collections::BTreeMap;
use std::io::Cursor;

use quick_xml::Reader;
use quick_xml::events::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use zip::ZipArchive;

use super::zip_guard::{
    decode_general_ref, decode_xml_text, local_tag_name, normalize_whitespace, open_bounded_zip,
    read_relationships, read_zip_text, resolve_relationship_target, try_read_zip_text,
    unescape_xml_str,
};

pub const MAX_XLSX_CELLS: usize = 1_000_000;
pub const MAX_SPREADSHEET_ROWS: usize = 1_048_576;
pub const MAX_SPREADSHEET_COLS: usize = 16_384;

pub const MAX_DIGIT_WIDTH_PX: f64 = 7.0;
pub const COLUMN_PADDING_PX: f64 = 5.0;
pub const WIDTH_UNITS: f64 = 256.0;
pub const MAX_OOXML_COLUMN_WIDTH: f64 = 255.0;
pub const MAX_COLUMN_WIDTH_PX: f64 = MAX_OOXML_COLUMN_WIDTH * MAX_DIGIT_WIDTH_PX;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CellCoords {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRangeCoords {
    pub start: CellCoords,
    pub end: CellCoords,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetCellStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal_align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
}

impl SpreadsheetCellStyle {
    pub fn is_empty(&self) -> bool {
        self.bold.is_none()
            && self.italic.is_none()
            && self.font_size.is_none()
            && self.horizontal_align.is_none()
            && self.fill_color.is_none()
            && self.text_color.is_none()
            && self.number_format.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetTableSummary {
    pub name: String,
    #[serde(rename = "ref")]
    pub range_ref: String,
    pub start_row: usize,
    pub start_col: usize,
    pub end_row: usize,
    pub end_col: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetChartAnchor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_row: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_col: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_row: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_col: Option<usize>,
}

impl SpreadsheetChartAnchor {
    pub fn is_empty(&self) -> bool {
        self.from_row.is_none()
            && self.from_col.is_none()
            && self.to_row.is_none()
            && self.to_col.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpreadsheetChartSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub chart_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<SpreadsheetChartAnchor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxCell {
    pub address: String,
    pub value: Value,
    pub formula: Option<String>,
    pub style: Option<SpreadsheetCellStyle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxColumnWidth {
    pub column: usize,
    pub width_chars: Option<f64>,
    pub width_pixels: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxSheet {
    pub name: String,
    pub index: usize,
    pub hidden: bool,
    pub cells: Vec<XlsxCell>,
    pub merges: Vec<String>,
    pub column_widths: Vec<XlsxColumnWidth>,
    pub tables: Vec<SpreadsheetTableSummary>,
    pub charts: Vec<SpreadsheetChartSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxSnapshot {
    pub sheets: Vec<XlsxSheet>,
}

/// Internal parsed representation of a workbook shared between `ArtifactPreviewService`
/// and `SpreadsheetWorkbookSnapshot`.
#[derive(Debug, Clone)]
pub struct ParsedXlsxWorkbook {
    pub date1904: bool,
    pub sheets: Vec<ParsedXlsxSheet>,
}

#[derive(Debug, Clone)]
pub struct ParsedXlsxSheet {
    pub name: String,
    pub index: usize,
    pub part_path: String,
    pub hidden: bool,
    pub dimension: Option<CellRangeCoords>,
    pub cells: BTreeMap<CellCoords, ParsedXlsxCell>,
    pub merges: Vec<CellRangeCoords>,
    /// Map of 0-based column index -> raw OOXML `<col width="..."/>` value.
    pub raw_col_widths: BTreeMap<usize, f64>,
    pub tables: Vec<SpreadsheetTableSummary>,
    pub charts: Vec<SpreadsheetChartSummary>,
}

#[derive(Debug, Clone)]
pub struct ParsedXlsxCell {
    pub coords: CellCoords,
    pub address: String,
    pub cell_type: Option<String>,
    pub raw_value: Option<Value>,
    pub display_value: String,
    pub formula: Option<String>,
    pub style: Option<SpreadsheetCellStyle>,
    pub is_date: bool,
}

pub fn encode_column_width(width_px: f64) -> f64 {
    (((width_px.round() / MAX_DIGIT_WIDTH_PX) * WIDTH_UNITS).trunc()) / WIDTH_UNITS
}

pub fn decode_column_width(width: f64) -> (f64, f64) {
    let pad_units = (128.0_f64 / MAX_DIGIT_WIDTH_PX).trunc();
    let width_px = (((WIDTH_UNITS * width + pad_units) / WIDTH_UNITS) * MAX_DIGIT_WIDTH_PX).trunc();
    let chars_raw = (((width_px - COLUMN_PADDING_PX) / MAX_DIGIT_WIDTH_PX) * 100.0).round() / 100.0;
    let width_chars = chars_raw.max(0.0);
    (width_px, width_chars)
}

pub fn parse_cell_address(address: &str) -> Option<CellCoords> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let mut idx = 0usize;
    let mut col_1based: usize = 0;
    let mut col_letters = 0usize;
    while idx < bytes.len() && bytes[idx] == b'$' {
        idx += 1;
    }
    while idx < bytes.len() && bytes[idx].is_ascii_alphabetic() {
        col_letters += 1;
        if col_letters > 3 {
            return None;
        }
        let upper = bytes[idx].to_ascii_uppercase();
        col_1based = col_1based
            .checked_mul(26)?
            .checked_add((upper - b'A' + 1) as usize)?;
        idx += 1;
    }
    if col_letters == 0 {
        return None;
    }
    while idx < bytes.len() && bytes[idx] == b'$' {
        idx += 1;
    }
    let row_str = &trimmed[idx..];
    if row_str.is_empty() || row_str.len() > 7 || row_str.starts_with('0') {
        return None;
    }
    if !row_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let row_1based: usize = row_str.parse().ok()?;
    let row = row_1based.checked_sub(1)?;
    let col = col_1based.checked_sub(1)?;
    if row >= MAX_SPREADSHEET_ROWS || col >= MAX_SPREADSHEET_COLS {
        return None;
    }
    Some(CellCoords { row, col })
}

pub fn parse_strict_a1_address(address: &str) -> Option<CellCoords> {
    let trimmed = address.trim();
    if trimmed.contains('$') {
        return None;
    }
    parse_cell_address(trimmed)
}

pub fn encode_col_name(mut col_0based: usize) -> String {
    let mut chars = Vec::new();
    loop {
        let rem = col_0based % 26;
        chars.push((b'A' + rem as u8) as char);
        if col_0based < 26 {
            break;
        }
        col_0based = (col_0based / 26) - 1;
    }
    chars.into_iter().rev().collect()
}

pub fn encode_cell_address(coords: CellCoords) -> String {
    format!("{}{}", encode_col_name(coords.col), coords.row + 1)
}

pub fn parse_cell_range(range_ref: &str) -> Option<CellRangeCoords> {
    let trimmed = range_ref.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed
        .split(':')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() || parts.len() > 2 {
        return None;
    }
    let start = parse_strict_a1_address(parts[0])?;
    let end = parse_strict_a1_address(parts.get(1).copied().unwrap_or(parts[0]))?;
    Some(CellRangeCoords {
        start: CellCoords {
            row: start.row.min(end.row),
            col: start.col.min(end.col),
        },
        end: CellCoords {
            row: start.row.max(end.row),
            col: start.col.max(end.col),
        },
    })
}

pub fn encode_cell_range(range: CellRangeCoords) -> String {
    if range.start == range.end {
        encode_cell_address(range.start)
    } else {
        format!(
            "{}:{}",
            encode_cell_address(range.start),
            encode_cell_address(range.end)
        )
    }
}

pub fn extract_xlsx_snapshot(bytes: &[u8]) -> Result<XlsxSnapshot, String> {
    let parsed = parse_xlsx_workbook(bytes, Some(MAX_XLSX_CELLS))?;
    if parsed.sheets.is_empty() {
        return Err("XLSX package does not contain any worksheets.".to_owned());
    }
    let mut sheets = Vec::with_capacity(parsed.sheets.len());
    for sheet in parsed.sheets {
        let mut cells = Vec::with_capacity(sheet.cells.len());
        for (_, cell) in sheet.cells {
            // Skip completely empty unstyled cells (`<c r="B4"/>`).
            if cell.raw_value.is_none() && cell.formula.is_none() && cell.style.is_none() {
                continue;
            }
            let value = match (&cell.raw_value, cell.is_date) {
                (Some(Value::Number(num)), true) => {
                    if let Some(serial) = num.as_f64() {
                        Value::String(excel_serial_to_iso_string(serial, parsed.date1904))
                    } else {
                        Value::Null
                    }
                }
                (Some(v), _) => v.clone(),
                (None, _) => Value::Null,
            };
            cells.push(XlsxCell {
                address: cell.address,
                value,
                formula: cell.formula,
                style: cell.style,
            });
        }

        let mut merges: Vec<String> = sheet.merges.into_iter().map(encode_cell_range).collect();
        merges.sort();

        let mut column_widths = Vec::new();
        for (col, raw_width) in sheet.raw_col_widths {
            if raw_width.is_finite() && raw_width >= 0.0 {
                let (width_px, width_chars) = decode_column_width(raw_width);
                column_widths.push(XlsxColumnWidth {
                    column: col,
                    width_chars: Some(width_chars),
                    width_pixels: Some(width_px),
                });
            }
        }

        let mut tables = sheet.tables;
        tables.sort_by(|a, b| a.name.cmp(&b.name));
        let mut charts = sheet.charts;
        charts.sort_by(|a, b| a.id.cmp(&b.id));

        sheets.push(XlsxSheet {
            name: sheet.name,
            index: sheet.index,
            hidden: sheet.hidden,
            cells,
            merges,
            column_widths,
            tables,
            charts,
        });
    }
    Ok(XlsxSnapshot { sheets })
}

pub fn parse_xlsx_workbook(
    bytes: &[u8],
    max_total_cells: Option<usize>,
) -> Result<ParsedXlsxWorkbook, String> {
    let mut archive = open_bounded_zip(bytes)?;
    let workbook_xml = read_zip_text(&mut archive, "xl/workbook.xml")
        .map_err(|_| "XLSX package is missing xl/workbook.xml.".to_owned())?;
    let (date1904, wb_sheets) = parse_workbook_meta(&workbook_xml)?;
    if wb_sheets.is_empty() {
        return Err("XLSX package does not contain any worksheets.".to_owned());
    }

    let wb_rels = read_relationships(&mut archive, "xl/workbook.xml")?;
    let shared_strings = match try_read_zip_text(&mut archive, "xl/sharedStrings.xml")? {
        Some(xml) => parse_shared_strings(&xml)?,
        None => Vec::new(),
    };
    let styles = match try_read_zip_text(&mut archive, "xl/styles.xml")? {
        Some(xml) => Some(parse_styles_tables(&xml)?),
        None => None,
    };

    let mut total_cells = 0usize;
    let mut sheets = Vec::with_capacity(wb_sheets.len());
    for (index, meta) in wb_sheets.into_iter().enumerate() {
        let part_path = meta
            .rel_id
            .as_deref()
            .and_then(|rid| wb_rels.get(rid))
            .map(|rel| resolve_relationship_target("xl/workbook.xml", &rel.target))
            .unwrap_or_else(|| format!("xl/worksheets/sheet{}.xml", index + 1));

        let Some(sheet_xml) = try_read_zip_text(&mut archive, &part_path)? else {
            continue;
        };

        let parsed_ws = parse_worksheet_xml(
            &sheet_xml,
            &shared_strings,
            styles.as_ref(),
            date1904,
            max_total_cells.map(|cap| cap.saturating_sub(total_cells)),
        )?;
        total_cells = total_cells.saturating_add(parsed_ws.cells.len());
        if let Some(cap) = max_total_cells
            && total_cells > cap
        {
            return Err(format!(
                "XLSX package exceeds the {cap}-cell parsing limit."
            ));
        }

        let sheet_rels = read_relationships(&mut archive, &part_path).unwrap_or_default();
        let tables = read_sheet_tables(
            &mut archive,
            &part_path,
            &sheet_rels,
            &parsed_ws.table_rel_ids,
        );
        let charts = read_sheet_charts(
            &mut archive,
            &part_path,
            &sheet_rels,
            &parsed_ws.drawing_rel_ids,
        );

        sheets.push(ParsedXlsxSheet {
            name: meta.name,
            index,
            part_path,
            hidden: meta.hidden,
            dimension: parsed_ws.dimension,
            cells: parsed_ws.cells,
            merges: parsed_ws.merges,
            raw_col_widths: parsed_ws.raw_col_widths,
            tables,
            charts,
        });
    }

    if sheets.is_empty() {
        return Err("XLSX package does not contain any worksheets.".to_owned());
    }

    Ok(ParsedXlsxWorkbook { date1904, sheets })
}

#[derive(Debug, Clone)]
struct WorkbookSheetMeta {
    name: String,
    rel_id: Option<String>,
    hidden: bool,
}

fn parse_workbook_meta(xml: &str) -> Result<(bool, Vec<WorkbookSheetMeta>), String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut date1904 = false;
    let mut sheets = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if tag == "workbookPr" {
                    for attr in e.attributes().flatten() {
                        if local_tag_name(attr.key.as_ref()) == "date1904" {
                            let val = unescape_xml_str(&attr.value);
                            date1904 = val == "1" || val.eq_ignore_ascii_case("true");
                        }
                    }
                } else if tag == "sheet" {
                    let mut name = None;
                    let mut rel_id = None;
                    let mut hidden = false;
                    for attr in e.attributes().flatten() {
                        let k = local_tag_name(attr.key.as_ref());
                        let v = unescape_xml_str(&attr.value);
                        match k.as_str() {
                            "name" => name = Some(v),
                            "id" => rel_id = Some(v),
                            "state" => {
                                hidden = v == "hidden" || v == "veryHidden";
                            }
                            _ => {}
                        }
                    }
                    if let Some(name) = name {
                        sheets.push(WorkbookSheetMeta {
                            name,
                            rel_id,
                            hidden,
                        });
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Workbook XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok((date1904, sheets))
}

fn parse_shared_strings(xml: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut in_si = false;
    let mut in_t = false;
    let mut phonetic_depth = 0usize;
    let mut cur = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match local_tag_name(e.name().as_ref()).as_str() {
                "si" => {
                    in_si = true;
                    cur.clear();
                }
                "rPh" if in_si => {
                    phonetic_depth += 1;
                }
                "t" if in_si && phonetic_depth == 0 => {
                    in_t = true;
                }
                _ => {}
            },
            Ok(Event::Empty(_)) => {}
            Ok(Event::Text(t)) if in_si && in_t && phonetic_depth == 0 => {
                cur.push_str(&decode_xml_text(&t));
            }
            Ok(Event::CData(c)) if in_si && in_t && phonetic_depth == 0 => {
                cur.push_str(c.as_ref());
            }
            Ok(Event::GeneralRef(g)) if in_si && in_t && phonetic_depth == 0 => {
                cur.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) => match local_tag_name(e.name().as_ref()).as_str() {
                "t" => in_t = false,
                "rPh" if phonetic_depth > 0 => phonetic_depth -= 1,
                "si" if in_si => {
                    out.push(std::mem::take(&mut cur));
                    in_si = false;
                    in_t = false;
                    phonetic_depth = 0;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Shared strings XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

#[derive(Debug, Clone, Default)]
struct StyleFont {
    bold: bool,
    italic: bool,
    size: Option<f64>,
    color: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct StyleFill {
    color: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct StyleXf {
    num_fmt_id: Option<u32>,
    font_id: Option<usize>,
    fill_id: Option<usize>,
    horizontal_align: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct XlsxStyleTables {
    num_fmts: BTreeMap<u32, String>,
    fonts: Vec<StyleFont>,
    fills: Vec<StyleFill>,
    cell_xfs: Vec<StyleXf>,
}

impl XlsxStyleTables {
    fn style_for_xf(
        &self,
        idx: usize,
    ) -> (Option<SpreadsheetCellStyle>, Option<String>, Option<u32>) {
        let Some(xf) = self.cell_xfs.get(idx) else {
            return (None, None, None);
        };
        let font = xf.font_id.and_then(|id| self.fonts.get(id));
        let fill = xf.fill_id.and_then(|id| self.fills.get(id));
        let custom_or_builtin_fmt = xf.num_fmt_id.and_then(|id| {
            self.num_fmts
                .get(&id)
                .cloned()
                .or_else(|| builtin_excel_number_format(id).map(str::to_owned))
        });

        let style = SpreadsheetCellStyle {
            bold: font.and_then(|f| f.bold.then_some(true)),
            italic: font.and_then(|f| f.italic.then_some(true)),
            font_size: font.and_then(|f| f.size),
            horizontal_align: xf.horizontal_align.clone(),
            fill_color: fill.and_then(|fl| fl.color.clone()),
            text_color: font.and_then(|f| f.color.clone()),
            number_format: custom_or_builtin_fmt.clone(),
        };
        let opt_style = if style.is_empty() { None } else { Some(style) };
        (opt_style, custom_or_builtin_fmt, xf.num_fmt_id)
    }
}

fn builtin_excel_number_format(id: u32) -> Option<&'static str> {
    match id {
        1 => Some("0"),
        2 => Some("0.00"),
        3 => Some("#,##0"),
        4 => Some("#,##0.00"),
        9 => Some("0%"),
        10 => Some("0.00%"),
        11 => Some("0.00E+00"),
        12 => Some("# ?/?"),
        13 => Some("# ??/??"),
        14 => Some("m/d/yy"),
        15 => Some("d-mmm-yy"),
        16 => Some("d-mmm"),
        17 => Some("mmm-yy"),
        18 => Some("h:mm AM/PM"),
        19 => Some("h:mm:ss AM/PM"),
        20 => Some("h:mm"),
        21 => Some("h:mm:ss"),
        22 => Some("m/d/yy h:mm"),
        37 => Some("#,##0 ;(#,##0)"),
        38 => Some("#,##0 ;[Red](#,##0)"),
        39 => Some("#,##0.00;(#,##0.00)"),
        40 => Some("#,##0.00;[Red](#,##0.00)"),
        45 => Some("mm:ss"),
        46 => Some("[h]:mm:ss"),
        47 => Some("mmss.0"),
        48 => Some("##0.0E+0"),
        49 => Some("@"),
        _ => None,
    }
}

fn is_date_number_format(num_fmt_id: Option<u32>, format_code: Option<&str>) -> bool {
    if let Some(id) = num_fmt_id
        && matches!(id, 14..=22 | 27..=36 | 45..=47 | 50..=58)
    {
        return true;
    }
    let Some(code) = format_code else {
        return false;
    };
    // Strip quoted literals and bracketed color/locale tokens before looking for date tokens.
    static STRIP_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let strip_re = STRIP_RE
        .get_or_init(|| Regex::new(r#""[^"]*"|\[[^\]]*\]|\\."#).expect("valid format strip regex"));
    let cleaned = strip_re.replace_all(code, "");
    let lower = cleaned.to_ascii_lowercase();
    if lower.contains('0') || lower.contains('#') || lower.contains('@') {
        return false;
    }
    lower.contains('y') || lower.contains('d') || lower.contains('h') || lower.contains('s')
}

fn parse_styles_tables(xml: &str) -> Result<XlsxStyleTables, String> {
    let mut tables = XlsxStyleTables::default();
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    let mut in_num_fmts = false;
    let mut in_fonts = false;
    let mut cur_font: Option<StyleFont> = None;
    let mut in_fills = false;
    let mut cur_fill: Option<StyleFill> = None;
    let mut cur_fill_fg: Option<String> = None;
    let mut cur_fill_bg: Option<String> = None;
    let mut in_cell_xfs = false;
    let mut cur_xf: Option<StyleXf> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "numFmts" => in_num_fmts = true,
                    "numFmt" if in_num_fmts => {
                        parse_num_fmt_attrs(&e, &mut tables.num_fmts);
                    }
                    "fonts" => in_fonts = true,
                    "font" if in_fonts => cur_font = Some(StyleFont::default()),
                    "b" | "i" | "sz" | "color" if cur_font.is_some() => {
                        apply_font_child_tag(&tag, &e, cur_font.as_mut().unwrap());
                    }
                    "fills" => in_fills = true,
                    "fill" if in_fills => {
                        cur_fill = Some(StyleFill::default());
                        cur_fill_fg = None;
                        cur_fill_bg = None;
                    }
                    "fgColor" if cur_fill.is_some() => {
                        cur_fill_fg = read_ooxml_color_from_tag(&e);
                    }
                    "bgColor" if cur_fill.is_some() => {
                        cur_fill_bg = read_ooxml_color_from_tag(&e);
                    }
                    "cellXfs" => in_cell_xfs = true,
                    "xf" if in_cell_xfs => {
                        cur_xf = Some(parse_xf_attrs(&e));
                    }
                    "alignment" if cur_xf.is_some() => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "horizontal" {
                                let v = unescape_xml_str(&attr.value);
                                if !v.is_empty() {
                                    cur_xf.as_mut().unwrap().horizontal_align = Some(v);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "numFmt" if in_num_fmts => {
                        parse_num_fmt_attrs(&e, &mut tables.num_fmts);
                    }
                    "font" if in_fonts => tables.fonts.push(StyleFont::default()),
                    "b" | "i" | "sz" | "color" if cur_font.is_some() => {
                        apply_font_child_tag(&tag, &e, cur_font.as_mut().unwrap());
                    }
                    "fill" if in_fills => tables.fills.push(StyleFill::default()),
                    "fgColor" if cur_fill.is_some() => {
                        cur_fill_fg = read_ooxml_color_from_tag(&e);
                    }
                    "bgColor" if cur_fill.is_some() => {
                        cur_fill_bg = read_ooxml_color_from_tag(&e);
                    }
                    "xf" if in_cell_xfs => {
                        tables.cell_xfs.push(parse_xf_attrs(&e));
                    }
                    "alignment" if cur_xf.is_some() => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "horizontal" {
                                let v = unescape_xml_str(&attr.value);
                                if !v.is_empty() {
                                    cur_xf.as_mut().unwrap().horizontal_align = Some(v);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => match local_tag_name(e.name().as_ref()).as_str() {
                "numFmts" => in_num_fmts = false,
                "fonts" => in_fonts = false,
                "font" if in_fonts => {
                    if let Some(font) = cur_font.take() {
                        tables.fonts.push(font);
                    }
                }
                "fills" => in_fills = false,
                "fill" if in_fills => {
                    if let Some(mut fill) = cur_fill.take() {
                        fill.color = cur_fill_fg.take().or_else(|| cur_fill_bg.take());
                        tables.fills.push(fill);
                    }
                }
                "cellXfs" => in_cell_xfs = false,
                "xf" if in_cell_xfs => {
                    if let Some(xf) = cur_xf.take() {
                        tables.cell_xfs.push(xf);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Styles XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(tables)
}

fn parse_num_fmt_attrs(e: &quick_xml::events::BytesStart<'_>, out: &mut BTreeMap<u32, String>) {
    let mut id = None;
    let mut code = None;
    for attr in e.attributes().flatten() {
        match local_tag_name(attr.key.as_ref()).as_str() {
            "numFmtId" => id = unescape_xml_str(&attr.value).parse::<u32>().ok(),
            "formatCode" => {
                let v = unescape_xml_str(&attr.value);
                if !v.is_empty() {
                    code = Some(v);
                }
            }
            _ => {}
        }
    }
    if let (Some(id), Some(code)) = (id, code) {
        out.insert(id, code);
    }
}

fn apply_font_child_tag(tag: &str, e: &quick_xml::events::BytesStart<'_>, font: &mut StyleFont) {
    match tag {
        "b" => font.bold = xml_toggle_attr_is_on(e),
        "i" => font.italic = xml_toggle_attr_is_on(e),
        "sz" => {
            for attr in e.attributes().flatten() {
                if local_tag_name(attr.key.as_ref()) == "val"
                    && let Ok(sz) = unescape_xml_str(&attr.value).parse::<f64>()
                    && sz.is_finite()
                    && sz > 0.0
                {
                    font.size = Some(sz);
                }
            }
        }
        "color" => {
            font.color = read_ooxml_color_from_tag(e);
        }
        _ => {}
    }
}

fn xml_toggle_attr_is_on(e: &quick_xml::events::BytesStart<'_>) -> bool {
    for attr in e.attributes().flatten() {
        if local_tag_name(attr.key.as_ref()) == "val" {
            let v = unescape_xml_str(&attr.value);
            return v != "0" && !v.eq_ignore_ascii_case("false");
        }
    }
    true
}

fn parse_xf_attrs(e: &quick_xml::events::BytesStart<'_>) -> StyleXf {
    let mut xf = StyleXf::default();
    for attr in e.attributes().flatten() {
        let v = unescape_xml_str(&attr.value);
        match local_tag_name(attr.key.as_ref()).as_str() {
            "numFmtId" => xf.num_fmt_id = v.parse::<u32>().ok(),
            "fontId" => xf.font_id = v.parse::<usize>().ok(),
            "fillId" => xf.fill_id = v.parse::<usize>().ok(),
            _ => {}
        }
    }
    xf
}

pub fn read_ooxml_color(
    rgb: Option<&str>,
    indexed: Option<usize>,
    theme: Option<usize>,
    tint: Option<f64>,
) -> Option<String> {
    if let Some(rgb_str) = rgb {
        let normalized = if rgb_str.len() == 8 {
            &rgb_str[2..]
        } else {
            rgb_str
        };
        if normalized.len() == 6 && normalized.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(format!("#{}", normalized.to_ascii_uppercase()));
        }
        return None;
    }
    if let Some(idx) = indexed {
        return excel_indexed_color(idx).map(str::to_owned);
    }
    if let Some(theme_idx) = theme {
        let base = default_excel_theme_color(theme_idx)?;
        return match tint {
            Some(t) if t.is_finite() => Some(apply_color_tint(base, t)),
            _ => Some(base.to_owned()),
        };
    }
    None
}

fn read_ooxml_color_from_tag(e: &quick_xml::events::BytesStart<'_>) -> Option<String> {
    let mut rgb = None;
    let mut indexed = None;
    let mut theme = None;
    let mut tint = None;
    for attr in e.attributes().flatten() {
        let v = unescape_xml_str(&attr.value);
        match local_tag_name(attr.key.as_ref()).as_str() {
            "rgb" => rgb = Some(v),
            "indexed" => indexed = v.trim().parse::<usize>().ok(),
            "theme" => theme = v.trim().parse::<usize>().ok(),
            "tint" => tint = v.trim().parse::<f64>().ok(),
            _ => {}
        }
    }
    read_ooxml_color(rgb.as_deref(), indexed, theme, tint)
}

fn default_excel_theme_color(idx: usize) -> Option<&'static str> {
    const THEME: [&str; 10] = [
        "#FFFFFF", "#000000", "#EEECE1", "#1F497D", "#4F81BD", "#C0504D", "#9BBB59", "#8064A2",
        "#4BACC6", "#F79646",
    ];
    THEME.get(idx).copied()
}

fn excel_indexed_color(idx: usize) -> Option<&'static str> {
    match idx {
        0 | 8 => Some("#000000"),
        1 | 9 => Some("#FFFFFF"),
        2 | 10 => Some("#FF0000"),
        3 | 11 => Some("#00FF00"),
        4 | 12 | 39 => Some("#0000FF"),
        5 | 13 | 34 => Some("#FFFF00"),
        6 | 14 | 33 => Some("#FF00FF"),
        7 | 15 | 35 => Some("#00FFFF"),
        16 | 37 => Some("#800000"),
        17 => Some("#008000"),
        18 | 32 => Some("#000080"),
        19 => Some("#808000"),
        20 | 36 => Some("#800080"),
        21 | 38 => Some("#008080"),
        22 => Some("#C0C0C0"),
        23 => Some("#808080"),
        24 => Some("#9999FF"),
        25 | 61 => Some("#993366"),
        26 => Some("#FFFFCC"),
        27 | 41 => Some("#CCFFFF"),
        28 => Some("#660066"),
        29 => Some("#FF8080"),
        30 => Some("#0066CC"),
        31 => Some("#CCCCFF"),
        40 => Some("#00CCFF"),
        42 => Some("#CCFFCC"),
        43 => Some("#FFFF99"),
        44 => Some("#99CCFF"),
        45 => Some("#FF99CC"),
        46 => Some("#CC99FF"),
        47 => Some("#FFCC99"),
        48 => Some("#3366FF"),
        49 => Some("#33CCCC"),
        50 => Some("#99CC00"),
        51 => Some("#FFCC00"),
        52 => Some("#FF9900"),
        53 => Some("#FF6600"),
        54 => Some("#666699"),
        55 => Some("#969696"),
        56 => Some("#003366"),
        57 => Some("#339966"),
        58 => Some("#003300"),
        59 => Some("#333300"),
        60 => Some("#993300"),
        62 => Some("#333399"),
        63 => Some("#333333"),
        _ => None,
    }
}

fn apply_color_tint(hex_color: &str, tint: f64) -> String {
    let rgb = hex_color.strip_prefix('#').unwrap_or(hex_color);
    let mut out = String::with_capacity(7);
    out.push('#');
    for start in [0usize, 2, 4] {
        let byte = u8::from_str_radix(&rgb[start..start + 2], 16).unwrap_or(0) as f64;
        let next = if tint < 0.0 {
            byte * (1.0 + tint)
        } else {
            byte + (255.0 - byte) * tint
        };
        let clamped = next.round().clamp(0.0, 255.0) as u8;
        out.push_str(&format!("{clamped:02X}"));
    }
    out
}

struct ParsedWorksheetXml {
    dimension: Option<CellRangeCoords>,
    cells: BTreeMap<CellCoords, ParsedXlsxCell>,
    merges: Vec<CellRangeCoords>,
    raw_col_widths: BTreeMap<usize, f64>,
    table_rel_ids: Vec<String>,
    drawing_rel_ids: Vec<String>,
}

fn parse_worksheet_xml(
    xml: &str,
    shared_strings: &[String],
    styles: Option<&XlsxStyleTables>,
    date1904: bool,
    cell_cap: Option<usize>,
) -> Result<ParsedWorksheetXml, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut dimension = None;
    let mut cells = BTreeMap::new();
    let mut merges = Vec::new();
    let mut raw_col_widths = BTreeMap::new();
    let mut table_rel_ids = Vec::new();
    let mut drawing_rel_ids = Vec::new();

    let mut cur_row_0based = 0usize;
    let mut next_col_0based = 0usize;
    let mut in_cell = false;
    let mut cur_coords = CellCoords { row: 0, col: 0 };
    let mut cur_addr = String::new();
    let mut cur_type = String::new();
    let mut cur_style_idx: Option<usize> = None;
    let mut in_v = false;
    let mut in_f = false;
    let mut in_is_t = false;
    let mut phonetic_depth = 0usize;
    let mut val_buf = String::new();
    let mut has_v = false;
    let mut formula_buf: Option<String> = None;
    let mut inline_buf = String::new();
    let mut has_inline = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "dimension" => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "ref" {
                                dimension = parse_cell_range(&unescape_xml_str(&attr.value));
                            }
                        }
                    }
                    "col" => parse_col_width_tag(&e, &mut raw_col_widths),
                    "row" => {
                        next_col_0based = 0;
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "r"
                                && let Ok(r1) = unescape_xml_str(&attr.value).parse::<usize>()
                                && r1 >= 1
                            {
                                cur_row_0based = r1 - 1;
                            }
                        }
                    }
                    "c" => {
                        in_cell = true;
                        cur_type.clear();
                        cur_style_idx = None;
                        val_buf.clear();
                        has_v = false;
                        formula_buf = None;
                        inline_buf.clear();
                        has_inline = false;
                        phonetic_depth = 0;
                        let mut explicit_coords = None;
                        for attr in e.attributes().flatten() {
                            let k = local_tag_name(attr.key.as_ref());
                            let v = unescape_xml_str(&attr.value);
                            match k.as_str() {
                                "r" => explicit_coords = parse_cell_address(&v),
                                "t" => cur_type = v,
                                "s" => cur_style_idx = v.parse::<usize>().ok(),
                                _ => {}
                            }
                        }
                        let coords = explicit_coords.unwrap_or(CellCoords {
                            row: cur_row_0based,
                            col: next_col_0based,
                        });
                        next_col_0based = coords.col + 1;
                        cur_coords = coords;
                        cur_addr = encode_cell_address(coords);
                    }
                    "v" if in_cell => {
                        in_v = true;
                        has_v = true;
                    }
                    "f" if in_cell => {
                        // Array/shared child `<f>` without text should only set formula if non-empty or normal.
                        in_f = true;
                        formula_buf.get_or_insert_with(String::new);
                    }
                    "rPh" if in_cell => {
                        phonetic_depth += 1;
                    }
                    "t" if in_cell && phonetic_depth == 0 => {
                        in_is_t = true;
                        has_inline = true;
                    }
                    "mergeCell" => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "ref"
                                && let Some(r) = parse_cell_range(&unescape_xml_str(&attr.value))
                            {
                                merges.push(r);
                            }
                        }
                    }
                    "tablePart" => {
                        if let Some(id) = attr_id(&e) {
                            table_rel_ids.push(id);
                        }
                    }
                    "drawing" => {
                        if let Some(id) = attr_id(&e) {
                            drawing_rel_ids.push(id);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "dimension" => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "ref" {
                                dimension = parse_cell_range(&unescape_xml_str(&attr.value));
                            }
                        }
                    }
                    "col" => parse_col_width_tag(&e, &mut raw_col_widths),
                    "c" => {
                        let mut explicit_coords = None;
                        let mut style_idx = None;
                        for attr in e.attributes().flatten() {
                            let k = local_tag_name(attr.key.as_ref());
                            let v = unescape_xml_str(&attr.value);
                            match k.as_str() {
                                "r" => explicit_coords = parse_cell_address(&v),
                                "s" => style_idx = v.parse::<usize>().ok(),
                                _ => {}
                            }
                        }
                        let coords = explicit_coords.unwrap_or(CellCoords {
                            row: cur_row_0based,
                            col: next_col_0based,
                        });
                        next_col_0based = coords.col + 1;
                        let style = style_idx
                            .and_then(|idx| styles.map(|st| st.style_for_xf(idx).0))
                            .flatten();
                        if style.is_some() {
                            if let Some(cap) = cell_cap
                                && cells.len() + 1 > cap
                            {
                                return Err(format!(
                                    "XLSX package exceeds the {MAX_XLSX_CELLS}-cell parsing limit."
                                ));
                            }
                            cells.insert(
                                coords,
                                ParsedXlsxCell {
                                    coords,
                                    address: encode_cell_address(coords),
                                    cell_type: None,
                                    raw_value: None,
                                    display_value: String::new(),
                                    formula: None,
                                    style,
                                    is_date: false,
                                },
                            );
                        }
                    }
                    "mergeCell" => {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "ref"
                                && let Some(r) = parse_cell_range(&unescape_xml_str(&attr.value))
                            {
                                merges.push(r);
                            }
                        }
                    }
                    "tablePart" => {
                        if let Some(id) = attr_id(&e) {
                            table_rel_ids.push(id);
                        }
                    }
                    "drawing" => {
                        if let Some(id) = attr_id(&e) {
                            drawing_rel_ids.push(id);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_cell => {
                let s = decode_xml_text(&t);
                if in_v {
                    val_buf.push_str(&s);
                } else if in_f {
                    if let Some(f) = formula_buf.as_mut() {
                        f.push_str(&s);
                    }
                } else if in_is_t && phonetic_depth == 0 {
                    inline_buf.push_str(&s);
                }
            }
            Ok(Event::CData(c)) if in_cell => {
                let s = c.as_ref();
                if in_v {
                    val_buf.push_str(s);
                } else if in_f {
                    if let Some(f) = formula_buf.as_mut() {
                        f.push_str(s);
                    }
                } else if in_is_t && phonetic_depth == 0 {
                    inline_buf.push_str(s);
                }
            }
            Ok(Event::GeneralRef(g)) if in_cell => {
                let s = decode_general_ref(&g);
                if in_v {
                    val_buf.push_str(&s);
                } else if in_f {
                    if let Some(f) = formula_buf.as_mut() {
                        f.push_str(&s);
                    }
                } else if in_is_t && phonetic_depth == 0 {
                    inline_buf.push_str(&s);
                }
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "v" => in_v = false,
                    "f" => in_f = false,
                    "t" => in_is_t = false,
                    "rPh" if phonetic_depth > 0 => phonetic_depth -= 1,
                    "row" => cur_row_0based += 1,
                    "c" if in_cell => {
                        in_cell = false;
                        in_v = false;
                        in_f = false;
                        in_is_t = false;
                        let (style, fmt_code, num_fmt_id) = cur_style_idx
                            .and_then(|idx| styles.map(|st| st.style_for_xf(idx)))
                            .unwrap_or((None, None, None));
                        let formula = formula_buf.take().filter(|f| !f.is_empty());
                        let (cell_type, raw_value, display_value, is_date) = decode_cell_content(
                            &cur_type,
                            has_v,
                            &val_buf,
                            has_inline,
                            &inline_buf,
                            shared_strings,
                            num_fmt_id,
                            fmt_code.as_deref(),
                            date1904,
                        );
                        if raw_value.is_some() || formula.is_some() || style.is_some() {
                            if let Some(cap) = cell_cap
                                && cells.len() + 1 > cap
                            {
                                return Err(format!(
                                    "XLSX package exceeds the {MAX_XLSX_CELLS}-cell parsing limit."
                                ));
                            }
                            cells.insert(
                                cur_coords,
                                ParsedXlsxCell {
                                    coords: cur_coords,
                                    address: std::mem::take(&mut cur_addr),
                                    cell_type,
                                    raw_value,
                                    display_value,
                                    formula,
                                    style,
                                    is_date,
                                },
                            );
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Worksheet XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(ParsedWorksheetXml {
        dimension,
        cells,
        merges,
        raw_col_widths,
        table_rel_ids,
        drawing_rel_ids,
    })
}

fn attr_id(e: &quick_xml::events::BytesStart<'_>) -> Option<String> {
    for attr in e.attributes().flatten() {
        if local_tag_name(attr.key.as_ref()) == "id" {
            let v = unescape_xml_str(&attr.value);
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn parse_col_width_tag(e: &quick_xml::events::BytesStart<'_>, out: &mut BTreeMap<usize, f64>) {
    let mut min_1 = None;
    let mut max_1 = None;
    let mut width = None;
    for attr in e.attributes().flatten() {
        let v = unescape_xml_str(&attr.value);
        match local_tag_name(attr.key.as_ref()).as_str() {
            "min" => min_1 = v.parse::<usize>().ok(),
            "max" => max_1 = v.parse::<usize>().ok(),
            "width" => width = v.parse::<f64>().ok(),
            _ => {}
        }
    }
    let (Some(min_1), Some(max_1), Some(w)) = (min_1, max_1, width) else {
        return;
    };
    if min_1 == 0 || max_1 < min_1 || !w.is_finite() {
        return;
    }
    let capped_max = max_1.min(MAX_SPREADSHEET_COLS);
    for col_1 in min_1..=capped_max {
        out.insert(col_1 - 1, w);
    }
}

#[allow(clippy::too_many_arguments)]
fn decode_cell_content(
    cell_t: &str,
    has_v: bool,
    val_buf: &str,
    has_inline: bool,
    inline_buf: &str,
    shared_strings: &[String],
    num_fmt_id: Option<u32>,
    fmt_code: Option<&str>,
    date1904: bool,
) -> (Option<String>, Option<Value>, String, bool) {
    match cell_t {
        "s" => {
            if !has_v {
                return (None, None, String::new(), false);
            }
            let s = val_buf
                .trim()
                .parse::<usize>()
                .ok()
                .and_then(|idx| shared_strings.get(idx).cloned())
                .unwrap_or_default();
            (
                Some("s".to_owned()),
                Some(Value::String(s.clone())),
                s,
                false,
            )
        }
        "inlineStr" => {
            if !has_inline && !has_v {
                return (None, None, String::new(), false);
            }
            let s = if has_inline {
                inline_buf.to_owned()
            } else {
                val_buf.to_owned()
            };
            (
                Some("s".to_owned()),
                Some(Value::String(s.clone())),
                s,
                false,
            )
        }
        "str" | "e" => {
            if !has_v {
                return (None, None, String::new(), false);
            }
            let typ = if cell_t == "e" { "e" } else { "s" };
            (
                Some(typ.to_owned()),
                Some(Value::String(val_buf.to_owned())),
                val_buf.to_owned(),
                false,
            )
        }
        "b" => {
            if !has_v {
                return (None, None, String::new(), false);
            }
            let b = val_buf.trim() == "1" || val_buf.trim().eq_ignore_ascii_case("true");
            let disp = if b { "TRUE" } else { "FALSE" }.to_owned();
            (Some("b".to_owned()), Some(Value::Bool(b)), disp, false)
        }
        "d" => {
            if !has_v {
                return (None, None, String::new(), false);
            }
            let trimmed = val_buf.trim();
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
                let serial = timestamp_ms_to_excel_serial(dt.timestamp_millis(), date1904);
                let num = json_number_from_f64(serial);
                let iso = dt
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                return (Some("d".to_owned()), num, iso, true);
            }
            if let Ok(nd) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
                && let Some(ndt) = nd.and_hms_opt(0, 0, 0)
            {
                let ms = ndt.and_utc().timestamp_millis();
                let serial = timestamp_ms_to_excel_serial(ms, date1904);
                let num = json_number_from_f64(serial);
                let iso = ndt
                    .and_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                return (Some("d".to_owned()), num, iso, true);
            }
            (
                Some("s".to_owned()),
                Some(Value::String(trimmed.to_owned())),
                trimmed.to_owned(),
                false,
            )
        }
        _ => {
            // Default / "n"
            if !has_v || val_buf.trim().is_empty() {
                if has_inline {
                    return (
                        Some("s".to_owned()),
                        Some(Value::String(inline_buf.to_owned())),
                        inline_buf.to_owned(),
                        false,
                    );
                }
                return (None, None, String::new(), false);
            }
            let trimmed = val_buf.trim();
            if let Ok(f) = trimmed.parse::<f64>()
                && f.is_finite()
            {
                let is_date = is_date_number_format(num_fmt_id, fmt_code);
                let num = json_number_from_f64(f);
                let disp = if is_date {
                    excel_serial_to_iso_string(f, date1904)
                } else {
                    format_numeric_value(f)
                };
                let typ = if is_date { "d" } else { "n" };
                return (Some(typ.to_owned()), num, disp, is_date);
            }
            (
                Some("s".to_owned()),
                Some(Value::String(trimmed.to_owned())),
                trimmed.to_owned(),
                false,
            )
        }
    }
}

fn json_number_from_f64(v: f64) -> Option<Value> {
    if v.fract() == 0.0 && v >= (i64::MIN as f64) && v <= (i64::MAX as f64) {
        Some(Value::Number(Number::from(v as i64)))
    } else {
        Number::from_f64(v).map(Value::Number)
    }
}

fn format_numeric_value(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        v.to_string()
    }
}

pub fn timestamp_ms_to_excel_serial(timestamp_ms: i64, date1904: bool) -> f64 {
    // 1899-12-30T00:00:00Z in Unix ms is -2209161600000.
    const EPOCH_1900_MS: f64 = -2_209_161_600_000.0;
    const MS_PER_DAY: f64 = 86_400_000.0;
    let serial_1900 = (timestamp_ms as f64 - EPOCH_1900_MS) / MS_PER_DAY;
    if date1904 {
        serial_1900 - 1462.0
    } else {
        serial_1900
    }
}

pub fn excel_serial_to_iso_string(serial: f64, date1904: bool) -> String {
    const EPOCH_1900_MS: f64 = -2_209_161_600_000.0;
    const MS_PER_DAY: f64 = 86_400_000.0;
    let serial_1900 = if date1904 { serial + 1462.0 } else { serial };
    let ms = (serial_1900 * MS_PER_DAY + EPOCH_1900_MS).round() as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| serial.to_string())
}

fn read_sheet_tables(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    worksheet_part: &str,
    rels: &BTreeMap<String, super::zip_guard::OoxmlRelationship>,
    table_rel_ids: &[String],
) -> Vec<SpreadsheetTableSummary> {
    let mut tables = Vec::new();
    for rid in table_rel_ids {
        let Some(rel) = rels.get(rid) else {
            continue;
        };
        if !rel.rel_type.contains("/table") {
            continue;
        }
        let target_part = resolve_relationship_target(worksheet_part, &rel.target);
        let Ok(Some(xml)) = try_read_zip_text(archive, &target_part) else {
            continue;
        };
        if let Some(summary) = parse_table_summary(&xml, &target_part) {
            tables.push(summary);
        }
    }
    tables
}

fn parse_table_summary(xml: &str, table_part: &str) -> Option<SpreadsheetTableSummary> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e))
                if local_tag_name(e.name().as_ref()) == "table" =>
            {
                let mut display_name = None;
                let mut name = None;
                let mut range_ref = None;
                for attr in e.attributes().flatten() {
                    let v = unescape_xml_str(&attr.value);
                    match local_tag_name(attr.key.as_ref()).as_str() {
                        "displayName" if !v.is_empty() => display_name = Some(v),
                        "name" if !v.is_empty() => name = Some(v),
                        "ref" if !v.is_empty() => range_ref = Some(v),
                        _ => {}
                    }
                }
                let ref_str = range_ref?;
                let range = parse_cell_range(&ref_str)?;
                let fallback = table_part
                    .rsplit('/')
                    .next()
                    .unwrap_or(table_part)
                    .to_owned();
                return Some(SpreadsheetTableSummary {
                    name: display_name.or(name).unwrap_or(fallback),
                    range_ref: ref_str,
                    start_row: range.start.row,
                    start_col: range.start.col,
                    end_row: range.end.row,
                    end_col: range.end.col,
                });
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

fn read_sheet_charts(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    worksheet_part: &str,
    rels: &BTreeMap<String, super::zip_guard::OoxmlRelationship>,
    drawing_rel_ids: &[String],
) -> Vec<SpreadsheetChartSummary> {
    let mut charts = Vec::new();
    for rid in drawing_rel_ids {
        let Some(rel) = rels.get(rid) else {
            continue;
        };
        if !rel.rel_type.contains("/drawing") {
            continue;
        }
        let drawing_part = resolve_relationship_target(worksheet_part, &rel.target);
        let Ok(Some(drawing_xml)) = try_read_zip_text(archive, &drawing_part) else {
            continue;
        };
        let Ok(drawing_rels) = read_relationships(archive, &drawing_part) else {
            continue;
        };
        for anchor in parse_drawing_chart_anchors(&drawing_xml) {
            let Some(chart_rel) = drawing_rels.get(&anchor.chart_rel_id) else {
                continue;
            };
            if !chart_rel.rel_type.contains("/chart") {
                continue;
            }
            let chart_part = resolve_relationship_target(&drawing_part, &chart_rel.target);
            let id = chart_part
                .rsplit('/')
                .next()
                .unwrap_or(&chart_part)
                .strip_suffix(".xml")
                .unwrap_or(&chart_part)
                .to_owned();
            let (title, chart_type) = match try_read_zip_text(archive, &chart_part) {
                Ok(Some(cxml)) => parse_chart_metadata(&cxml),
                _ => (None, None),
            };
            charts.push(SpreadsheetChartSummary {
                id,
                title,
                chart_type,
                anchor: if anchor.coords.is_empty() {
                    None
                } else {
                    Some(anchor.coords)
                },
            });
        }
    }
    charts
}

struct DrawingChartRef {
    chart_rel_id: String,
    coords: SpreadsheetChartAnchor,
}

fn parse_drawing_chart_anchors(xml: &str) -> Vec<DrawingChartRef> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut in_anchor: Option<String> = None;
    let mut cur_coords = SpreadsheetChartAnchor::default();
    let mut cur_chart_rel: Option<String> = None;
    let mut in_from = false;
    let mut in_to = false;
    let mut cur_num_tag: Option<String> = None;
    let mut num_buf = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {
                        in_anchor = Some(tag);
                        cur_coords = SpreadsheetChartAnchor::default();
                        cur_chart_rel = None;
                    }
                    "from" if in_anchor.is_some() => in_from = true,
                    "to" if in_anchor.is_some() => in_to = true,
                    "row" | "col" if in_from || in_to => {
                        cur_num_tag = Some(tag);
                        num_buf.clear();
                    }
                    "chart" if in_anchor.is_some() && cur_chart_rel.is_none() => {
                        cur_chart_rel = attr_id(&e);
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if in_anchor.is_some()
                    && cur_chart_rel.is_none()
                    && local_tag_name(e.name().as_ref()) == "chart"
                {
                    cur_chart_rel = attr_id(&e);
                }
            }
            Ok(Event::Text(t)) if cur_num_tag.is_some() => {
                num_buf.push_str(&decode_xml_text(&t));
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if cur_num_tag.as_deref() == Some(tag.as_str()) {
                    if let Ok(val) = num_buf.trim().parse::<usize>() {
                        match (in_from, in_to, tag.as_str()) {
                            (true, _, "row") => cur_coords.from_row = Some(val),
                            (true, _, "col") => cur_coords.from_col = Some(val),
                            (_, true, "row") => cur_coords.to_row = Some(val),
                            (_, true, "col") => cur_coords.to_col = Some(val),
                            _ => {}
                        }
                    }
                    cur_num_tag = None;
                } else if tag == "from" {
                    in_from = false;
                } else if tag == "to" {
                    in_to = false;
                } else if in_anchor.as_deref() == Some(tag.as_str()) {
                    if let Some(chart_rel_id) = cur_chart_rel.take() {
                        out.push(DrawingChartRef {
                            chart_rel_id,
                            coords: std::mem::take(&mut cur_coords),
                        });
                    }
                    in_anchor = None;
                    in_from = false;
                    in_to = false;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn parse_chart_metadata(xml: &str) -> (Option<String>, Option<String>) {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut chart_depth = 0usize;
    let mut title_depth = 0usize;
    let mut in_title_t = false;
    let mut title_parts: Vec<String> = Vec::new();
    let mut cur_t = String::new();
    let mut plot_area_depth = 0usize;
    let mut chart_type: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if chart_depth == 0 && tag == "chart" {
                    chart_depth = 1;
                } else if chart_depth > 0 {
                    chart_depth += 1;
                    if chart_depth == 2 && tag == "title" {
                        title_depth = 1;
                    } else if title_depth > 0 {
                        title_depth += 1;
                        if tag == "t" {
                            in_title_t = true;
                            cur_t.clear();
                        }
                    } else if chart_depth == 2 && tag == "plotArea" {
                        plot_area_depth = 1;
                    } else if plot_area_depth > 0 {
                        if plot_area_depth == 1
                            && chart_type.is_none()
                            && tag != "date1904"
                            && tag.ends_with("Chart")
                        {
                            chart_type = Some(tag.trim_end_matches("Chart").to_owned());
                        }
                        plot_area_depth += 1;
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if plot_area_depth == 1
                    && chart_type.is_none()
                    && tag != "date1904"
                    && tag.ends_with("Chart")
                {
                    chart_type = Some(tag.trim_end_matches("Chart").to_owned());
                }
            }
            Ok(Event::Text(t)) if in_title_t => {
                cur_t.push_str(&decode_xml_text(&t));
            }
            Ok(Event::CData(c)) if in_title_t => {
                cur_t.push_str(c.as_ref());
            }
            Ok(Event::GeneralRef(g)) if in_title_t => {
                cur_t.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if in_title_t && tag == "t" {
                    in_title_t = false;
                    if !cur_t.is_empty() {
                        title_parts.push(std::mem::take(&mut cur_t));
                    }
                }
                if title_depth > 0 {
                    title_depth -= 1;
                } else {
                    plot_area_depth = plot_area_depth.saturating_sub(1);
                }
                chart_depth = chart_depth.saturating_sub(1);
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    let title = normalize_whitespace(&title_parts.join(" "));
    let title_opt = if title.is_empty() { None } else { Some(title) };
    (title_opt, chart_type)
}
