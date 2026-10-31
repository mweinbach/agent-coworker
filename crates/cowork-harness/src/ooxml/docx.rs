//! Native Rust `.docx` snapshot extractor (`src/server/artifacts/docx.ts` parity).

use std::io::Cursor;

use quick_xml::Reader;
use quick_xml::events::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::zip_guard::{
    OoxmlMedia, archive_file_names, decode_general_ref, decode_xml_text, local_tag_name,
    normalize_whitespace, open_bounded_zip, read_media, read_zip_text, unescape_xml_str,
};

pub const MAX_DOCX_STRUCTURAL_ITEMS: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxParagraph {
    pub index: usize,
    pub text: String,
    pub style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxHeading {
    pub index: usize,
    pub text: String,
    pub style: Option<String>,
    pub level: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxTable {
    pub index: usize,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxSectionText {
    pub part: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxTrackedChange {
    #[serde(rename = "type")]
    pub change_type: String,
    pub id: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxSnapshot {
    pub paragraphs: Vec<DocxParagraph>,
    pub headings: Vec<DocxHeading>,
    pub tables: Vec<DocxTable>,
    pub headers: Vec<DocxSectionText>,
    pub footers: Vec<DocxSectionText>,
    pub tracked_changes: Vec<DocxTrackedChange>,
    pub media: Vec<OoxmlMedia>,
}

pub fn extract_docx_snapshot(bytes: &[u8]) -> Result<DocxSnapshot, String> {
    let mut archive = open_bounded_zip(bytes)?;
    let doc_xml = read_zip_text(&mut archive, "word/document.xml")
        .map_err(|_| "DOCX package is missing word/document.xml content.".to_owned())?;

    let (paragraphs, headings, tables) = parse_document_body(&doc_xml)?;
    let headers = read_section_parts(&mut archive, "word/header")?;
    let footers = read_section_parts(&mut archive, "word/footer")?;
    let tracked_changes = read_tracked_changes(&mut archive)?;

    let total_items = paragraphs.len()
        + headings.len()
        + tables.len()
        + headers.len()
        + footers.len()
        + tracked_changes.len();
    if total_items > MAX_DOCX_STRUCTURAL_ITEMS {
        return Err(format!(
            "DOCX structure exceeds the {MAX_DOCX_STRUCTURAL_ITEMS}-item limit."
        ));
    }

    let media = read_media(&mut archive, "word/media/", None)?;
    Ok(DocxSnapshot {
        paragraphs,
        headings,
        tables,
        headers,
        footers,
        tracked_changes,
        media,
    })
}

fn is_heading_style(style: Option<&str>) -> bool {
    let Some(s) = style else {
        return false;
    };
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^(heading\s*\d+|title|subtitle)$").expect("valid heading regex")
    });
    re.is_match(s)
}

fn parse_heading_level(style: Option<&str>) -> Option<u32> {
    let s = style?;
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re =
        RE.get_or_init(|| Regex::new(r"(?i)^heading\s*(\d+)").expect("valid heading level regex"));
    let caps = re.captures(s)?;
    caps.get(1)?.as_str().parse::<u32>().ok().filter(|&n| n > 0)
}

type ParsedDocxBody = (Vec<DocxParagraph>, Vec<DocxHeading>, Vec<DocxTable>);

fn parse_document_body(xml: &str) -> Result<ParsedDocxBody, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    let mut found_body = false;
    let mut body_depth: usize = 0;

    let mut paragraphs = Vec::new();
    let mut headings = Vec::new();
    let mut tables = Vec::new();

    let mut p_index: usize = 0;
    let mut in_body_p = false;
    let mut body_p_depth: usize = 0;
    let mut body_p_style: Option<String> = None;
    let mut body_p_tokens: Vec<String> = Vec::new();

    let mut tbl_depth: usize = 0;
    let mut tbl_index: usize = 0;
    let mut tbl_rows: Vec<Vec<String>> = Vec::new();
    let mut cur_row: Vec<String> = Vec::new();
    let mut in_tc = false;
    let mut tc_depth: usize = 0;
    let mut tc_paragraphs: Vec<String> = Vec::new();
    let mut in_tc_p = false;
    let mut tc_p_tokens: Vec<String> = Vec::new();

    let mut del_depth: usize = 0;
    let mut text_tag_depth: usize = 0;
    let mut current_text_buf = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if !found_body {
                    if tag == "body" {
                        found_body = true;
                        body_depth = 1;
                    }
                } else {
                    body_depth += 1;
                    match tag.as_str() {
                        "del" => {
                            del_depth += 1;
                        }
                        "tbl" => {
                            tbl_depth += 1;
                            if tbl_depth == 1 {
                                tbl_rows.clear();
                            }
                        }
                        "tr" if tbl_depth == 1 => {
                            cur_row.clear();
                        }
                        "tc" if tbl_depth == 1 => {
                            in_tc = true;
                            tc_depth = 1;
                            tc_paragraphs.clear();
                        }
                        "p" if in_tc && tbl_depth == 1 => {
                            in_tc_p = true;
                            tc_p_tokens.clear();
                        }
                        "p" if tbl_depth == 0 && body_depth == 2 => {
                            in_body_p = true;
                            body_p_depth = 1;
                            body_p_style = None;
                            body_p_tokens.clear();
                        }
                        "pStyle" if in_body_p && body_p_depth <= 2 => {
                            for attr in e.attributes().flatten() {
                                if local_tag_name(attr.key.as_ref()) == "val" {
                                    body_p_style = Some(unescape_xml_str(&attr.value));
                                }
                            }
                        }
                        "t" | "instrText" if del_depth == 0 && (in_body_p || in_tc_p) => {
                            text_tag_depth += 1;
                            current_text_buf.clear();
                        }
                        _ => {
                            if in_body_p {
                                body_p_depth += 1;
                            }
                            if in_tc && tbl_depth == 1 {
                                tc_depth += 1;
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                if found_body {
                    let tag = local_tag_name(e.name().as_ref());
                    if tag == "pStyle" && in_body_p {
                        for attr in e.attributes().flatten() {
                            if local_tag_name(attr.key.as_ref()) == "val" {
                                body_p_style = Some(unescape_xml_str(&attr.value));
                            }
                        }
                    } else if tag == "p" && tbl_depth == 0 && body_depth == 1 {
                        let parsed = DocxParagraph {
                            index: p_index,
                            text: String::new(),
                            style: None,
                        };
                        paragraphs.push(parsed);
                        p_index += 1;
                    }
                }
            }
            Ok(Event::Text(t)) if text_tag_depth > 0 => {
                current_text_buf.push_str(&decode_xml_text(&t));
            }
            Ok(Event::GeneralRef(g)) if text_tag_depth > 0 => {
                current_text_buf.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) => {
                if found_body {
                    let tag = local_tag_name(e.name().as_ref());
                    match tag.as_str() {
                        "t" | "instrText" if text_tag_depth > 0 => {
                            text_tag_depth -= 1;
                            if text_tag_depth == 0 && !current_text_buf.is_empty() {
                                if in_tc_p {
                                    tc_p_tokens.push(std::mem::take(&mut current_text_buf));
                                } else if in_body_p {
                                    body_p_tokens.push(std::mem::take(&mut current_text_buf));
                                } else {
                                    current_text_buf.clear();
                                }
                            }
                        }
                        "del" if del_depth > 0 => {
                            del_depth -= 1;
                        }
                        "p" if in_tc_p && tbl_depth == 1 => {
                            in_tc_p = false;
                            let text = normalize_whitespace(&tc_p_tokens.join(" "));
                            if !text.is_empty() {
                                tc_paragraphs.push(text);
                            }
                        }
                        "tc" if in_tc && tbl_depth == 1 => {
                            in_tc = false;
                            tc_depth = 0;
                            let joined = normalize_whitespace(&tc_paragraphs.join("\n"));
                            cur_row.push(joined);
                        }
                        "tr" if tbl_depth == 1 => {
                            tbl_rows.push(cur_row.clone());
                        }
                        "tbl" if tbl_depth > 0 => {
                            if tbl_depth == 1 {
                                tables.push(DocxTable {
                                    index: tbl_index,
                                    rows: tbl_rows.clone(),
                                });
                                tbl_index += 1;
                            }
                            tbl_depth -= 1;
                        }
                        "p" if in_body_p && tbl_depth == 0 && body_depth == 2 => {
                            in_body_p = false;
                            let text = normalize_whitespace(&body_p_tokens.join(" "));
                            if is_heading_style(body_p_style.as_deref()) {
                                let level = parse_heading_level(body_p_style.as_deref());
                                headings.push(DocxHeading {
                                    index: p_index,
                                    text,
                                    style: body_p_style.take(),
                                    level,
                                });
                            } else {
                                paragraphs.push(DocxParagraph {
                                    index: p_index,
                                    text,
                                    style: body_p_style.take(),
                                });
                            }
                            p_index += 1;
                        }
                        "body" if body_depth == 1 => {
                            break;
                        }
                        _ => {
                            if in_body_p && body_p_depth > 1 {
                                body_p_depth -= 1;
                            }
                            if in_tc && tc_depth > 1 {
                                tc_depth -= 1;
                            }
                        }
                    }
                    body_depth = body_depth.saturating_sub(1);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("DOCX XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    if !found_body {
        return Err("DOCX package is missing word/document.xml content.".to_owned());
    }
    Ok((paragraphs, headings, tables))
}

fn read_section_parts(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    prefix: &str,
) -> Result<Vec<DocxSectionText>, String> {
    let mut parts: Vec<String> = archive_file_names(archive)
        .into_iter()
        .filter(|n| {
            let lower = n.to_ascii_lowercase();
            lower.starts_with(prefix) && lower.ends_with(".xml") && !n[prefix.len()..].contains('/')
        })
        .collect();
    parts.sort();

    let mut out = Vec::new();
    for part in parts {
        let xml = read_zip_text(archive, &part)?;
        let paragraphs = collect_paragraphs_text(&xml)?;
        let text = paragraphs
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        out.push(DocxSectionText { part, text });
    }
    Ok(out)
}

fn collect_paragraphs_text(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut paragraphs = Vec::new();
    let mut p_depth = 0usize;
    let mut del_depth = 0usize;
    let mut in_text = false;
    let mut cur_token = String::new();
    let mut tokens: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "p" => {
                        if p_depth == 0 {
                            tokens.clear();
                        }
                        p_depth += 1;
                    }
                    "del" => del_depth += 1,
                    "t" | "instrText" if p_depth > 0 && del_depth == 0 => {
                        in_text = true;
                        cur_token.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => {
                cur_token.push_str(&decode_xml_text(&t));
            }
            Ok(Event::GeneralRef(g)) if in_text => {
                cur_token.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "t" | "instrText" if in_text => {
                        in_text = false;
                        if !cur_token.is_empty() {
                            tokens.push(std::mem::take(&mut cur_token));
                        }
                    }
                    "del" if del_depth > 0 => del_depth -= 1,
                    "p" if p_depth > 0 => {
                        p_depth -= 1;
                        if p_depth == 0 {
                            paragraphs.push(normalize_whitespace(&tokens.join(" ")));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("DOCX section XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(paragraphs)
}

fn read_tracked_changes(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
) -> Result<Vec<DocxTrackedChange>, String> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^word/(document|header[^/]*|footer[^/]*|footnotes|endnotes)\.xml$")
            .expect("valid tracked change part regex")
    });
    let mut parts: Vec<String> = archive_file_names(archive)
        .into_iter()
        .filter(|n| re.is_match(n))
        .collect();
    parts.sort();

    let mut changes = Vec::new();
    for part in parts {
        let xml = read_zip_text(archive, &part)?;
        changes.extend(extract_tracked_changes_for_tag(&xml, "ins", "insertion")?);
        changes.extend(extract_tracked_changes_for_tag(&xml, "del", "deletion")?);
    }
    Ok(changes)
}

fn extract_tracked_changes_for_tag(
    xml: &str,
    target_tag: &str,
    change_type: &str,
) -> Result<Vec<DocxTrackedChange>, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();

    struct ActiveChange {
        id: Option<String>,
        author: Option<String>,
        date: Option<String>,
        tokens: Vec<String>,
    }

    let mut stack: Vec<ActiveChange> = Vec::new();
    let mut in_text_tag = false;
    let mut cur_token = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if tag == target_tag {
                    let mut id = None;
                    let mut author = None;
                    let mut date = None;
                    for attr in e.attributes().flatten() {
                        let k = local_tag_name(attr.key.as_ref());
                        let v = unescape_xml_str(&attr.value);
                        match k.as_str() {
                            "id" => id = Some(v),
                            "author" => author = Some(v),
                            "date" => date = Some(v),
                            _ => {}
                        }
                    }
                    stack.push(ActiveChange {
                        id,
                        author,
                        date,
                        tokens: Vec::new(),
                    });
                } else if !stack.is_empty() && matches!(tag.as_str(), "t" | "instrText" | "delText")
                {
                    in_text_tag = true;
                    cur_token.clear();
                }
            }
            Ok(Event::Empty(e)) => {
                if local_tag_name(e.name().as_ref()) == target_tag {
                    let mut id = None;
                    let mut author = None;
                    let mut date = None;
                    for attr in e.attributes().flatten() {
                        let k = local_tag_name(attr.key.as_ref());
                        let v = unescape_xml_str(&attr.value);
                        match k.as_str() {
                            "id" => id = Some(v),
                            "author" => author = Some(v),
                            "date" => date = Some(v),
                            _ => {}
                        }
                    }
                    out.push(DocxTrackedChange {
                        change_type: change_type.to_owned(),
                        id,
                        author,
                        date,
                        text: String::new(),
                    });
                }
            }
            Ok(Event::Text(t)) if in_text_tag => {
                cur_token.push_str(&decode_xml_text(&t));
            }
            Ok(Event::GeneralRef(g)) if in_text_tag => {
                cur_token.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if in_text_tag && matches!(tag.as_str(), "t" | "instrText" | "delText") {
                    in_text_tag = false;
                    if !cur_token.is_empty() {
                        let token = std::mem::take(&mut cur_token);
                        for active in &mut stack {
                            active.tokens.push(token.clone());
                        }
                    }
                } else if tag == target_tag
                    && let Some(done) = stack.pop()
                {
                    out.push(DocxTrackedChange {
                        change_type: change_type.to_owned(),
                        id: done.id,
                        author: done.author,
                        date: done.date,
                        text: normalize_whitespace(&done.tokens.join(" ")),
                    });
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("DOCX tracked changes XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}
