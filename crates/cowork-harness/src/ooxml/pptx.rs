//! Native Rust `.pptx` snapshot extractor (`src/server/artifacts/pptx.ts` parity).

use std::collections::BTreeSet;
use std::io::Cursor;
use std::path::Path;

use cowork_storage::sha256_hex;
use quick_xml::Reader;
use quick_xml::events::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use zip::ZipArchive;

use super::zip_guard::{
    OoxmlMedia, archive_file_names, decode_general_ref, decode_xml_text, local_tag_name,
    normalize_whitespace, open_bounded_zip, read_media, read_relationships, read_zip_text,
    resolve_relationship_target, try_read_zip_text, unescape_xml_str,
};

pub const MAX_PPTX_SLIDES: usize = 10_000;
pub const MAX_PPTX_SHAPES_PER_SLIDE: usize = 50_000;

#[derive(Debug, Clone, Default)]
pub struct PptxExtractOptions {
    pub max_slides: Option<usize>,
    pub include_media: bool,
}

impl PptxExtractOptions {
    pub fn full() -> Self {
        Self {
            max_slides: None,
            include_media: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxShape {
    #[serde(rename = "type")]
    pub shape_type: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub text: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxSlide {
    pub id: String,
    pub part: String,
    pub index: usize,
    pub text: String,
    pub notes: String,
    pub shapes: Vec<PptxShape>,
    pub media: Vec<OoxmlMedia>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxSnapshot {
    pub slides: Vec<PptxSlide>,
    pub media: Vec<OoxmlMedia>,
}

#[derive(Debug, Clone)]
struct OrderedSlidePart {
    id: String,
    part: String,
}

pub fn extract_pptx_snapshot(bytes: &[u8]) -> Result<PptxSnapshot, String> {
    extract_pptx_snapshot_with_options(bytes, &PptxExtractOptions::full())
}

pub fn extract_pptx_snapshot_with_options(
    bytes: &[u8],
    options: &PptxExtractOptions,
) -> Result<PptxSnapshot, String> {
    let mut archive = open_bounded_zip(bytes)?;
    let ordered = read_ordered_slide_parts(&mut archive)?;
    if ordered.is_empty() {
        return Err("PPTX package does not contain any slides.".to_owned());
    }
    let max_slides = options
        .max_slides
        .unwrap_or(MAX_PPTX_SLIDES)
        .min(MAX_PPTX_SLIDES);
    if max_slides < 1 {
        return Err("PPTX slide limit must be a positive integer.".to_owned());
    }
    if ordered.len() > max_slides {
        return Err(format!(
            "PPTX package exceeds the {max_slides}-slide limit."
        ));
    }

    let mut slides = Vec::with_capacity(ordered.len());
    for (index, entry) in ordered.into_iter().enumerate() {
        slides.push(read_slide(&mut archive, entry, index, options)?);
    }

    let media = if options.include_media {
        read_media(&mut archive, "ppt/media/", None)?
    } else {
        Vec::new()
    };

    Ok(PptxSnapshot { slides, media })
}

fn read_ordered_slide_parts(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
) -> Result<Vec<OrderedSlidePart>, String> {
    if let Some(pres_xml) = try_read_zip_text(archive, "ppt/presentation.xml")? {
        let rels = read_relationships(archive, "ppt/presentation.xml")?;
        let mut ordered = Vec::new();
        let mut reader = Reader::from_str(&pres_xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e) | Event::Empty(e))
                    if local_tag_name(e.name().as_ref()) == "sldId" =>
                {
                    let mut stable_id: Option<String> = None;
                    let mut rel_id: Option<String> = None;
                    for attr in e.attributes().flatten() {
                        let raw_key = attr.key.as_ref();
                        let val = unescape_xml_str(&attr.value);
                        if raw_key.ends_with(":id") {
                            rel_id = Some(val);
                        } else if raw_key == "id" {
                            stable_id = Some(val);
                        }
                    }
                    if let Some(r_id) = rel_id
                        && let Some(rel) = rels.get(&r_id)
                        && rel.rel_type.contains("/slide")
                    {
                        ordered.push(OrderedSlidePart {
                            id: stable_id.unwrap_or_else(|| r_id.clone()),
                            part: resolve_relationship_target("ppt/presentation.xml", &rel.target),
                        });
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(format!("PPTX presentation.xml parse error: {e}")),
                _ => {}
            }
            buf.clear();
        }
        if !ordered.is_empty() {
            return Ok(ordered);
        }
    }

    static SLIDE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let slide_re = SLIDE_RE.get_or_init(|| {
        Regex::new(r"(?i)^ppt/slides/slide(\d+)\.xml$").expect("valid slide regex")
    });
    let mut fallback: Vec<(usize, String)> = archive_file_names(archive)
        .into_iter()
        .filter_map(|name| {
            let num = slide_re
                .captures(&name)?
                .get(1)?
                .as_str()
                .parse::<usize>()
                .unwrap_or(usize::MAX);
            Some((num, name))
        })
        .collect();
    fallback.sort_by_key(|(num, _)| *num);

    Ok(fallback
        .into_iter()
        .map(|(_, part)| {
            let id = Path::new(&part)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("slide")
                .to_owned();
            OrderedSlidePart { id, part }
        })
        .collect())
}

fn read_slide(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    entry: OrderedSlidePart,
    index: usize,
    options: &PptxExtractOptions,
) -> Result<PptxSlide, String> {
    let slide_xml = read_zip_text(archive, &entry.part)?;
    let rels = read_relationships(archive, &entry.part)?;

    let mut media_paths = BTreeSet::new();
    let mut notes_part: Option<String> = None;
    for rel in rels.values() {
        if rel.rel_type.contains("/notesSlide") {
            notes_part = Some(resolve_relationship_target(&entry.part, &rel.target));
        } else if rel.rel_type.contains("/image")
            || rel.rel_type.contains("/audio")
            || rel.rel_type.contains("/video")
            || rel.rel_type.contains("/media")
        {
            let target = resolve_relationship_target(&entry.part, &rel.target);
            if target.starts_with("ppt/media/") {
                media_paths.insert(target);
            }
        }
    }

    let shapes = parse_slide_shapes(&slide_xml, &entry.part)?;
    if shapes.len() > MAX_PPTX_SHAPES_PER_SLIDE {
        return Err(format!(
            "PPTX slide exceeds the {MAX_PPTX_SHAPES_PER_SLIDE}-shape limit: {}",
            entry.part
        ));
    }

    let notes = if let Some(np) = notes_part {
        match try_read_zip_text(archive, &np)? {
            Some(notes_xml) => collect_drawing_text(&notes_xml)?,
            None => String::new(),
        }
    } else {
        String::new()
    };

    let media = if options.include_media && !media_paths.is_empty() {
        read_media(archive, "ppt/media/", Some(&media_paths))?
    } else {
        Vec::new()
    };

    let text = normalize_whitespace(
        &shapes
            .iter()
            .map(|s| s.text.as_str())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    );

    let fp_payload = json!({
        "text": text,
        "notes": notes,
        "shapes": shapes.iter().map(|s| json!({
            "type": s.shape_type,
            "id": s.id,
            "name": s.name,
            "text": s.text,
            "x": s.x,
            "y": s.y,
            "width": s.width,
            "height": s.height,
        })).collect::<Vec<_>>(),
        "media": media.iter().map(|m| json!({
            "path": m.path,
            "sha256": m.sha256,
        })).collect::<Vec<_>>(),
    });
    let fingerprint = sha256_hex(
        serde_json::to_string(&fp_payload)
            .unwrap_or_default()
            .as_bytes(),
    );

    Ok(PptxSlide {
        id: entry.id,
        part: entry.part,
        index,
        text,
        notes,
        shapes,
        media,
        fingerprint,
    })
}

fn shape_type_for_tag(tag: &str) -> Option<&'static str> {
    match tag {
        "sp" => Some("shape"),
        "pic" => Some("picture"),
        "graphicFrame" => Some("graphic"),
        "cxnSp" => Some("connector"),
        "grpSp" => Some("group"),
        _ => None,
    }
}

fn parse_slide_shapes(xml: &str, part: &str) -> Result<Vec<PptxShape>, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut has_sld = false;

    struct ActiveShape {
        tag: String,
        shape_type: &'static str,
        depth: usize,
        id: Option<String>,
        name: Option<String>,
        tokens: Vec<String>,
        x: Option<f64>,
        y: Option<f64>,
        width: Option<f64>,
        height: Option<f64>,
        in_nv_pr: bool,
        in_xfrm: bool,
    }

    let mut stack: Vec<ActiveShape> = Vec::new();
    // Preserve TS ordering: ["sp", "pic", "graphicFrame", "cxnSp", "grpSp"]
    let mut by_kind: [Vec<PptxShape>; 5] = Default::default();
    let mut in_text_tag = false;
    let mut cur_token = String::new();

    let kind_slot = |shape_type: &str| -> usize {
        match shape_type {
            "shape" => 0,
            "picture" => 1,
            "graphic" => 2,
            "connector" => 3,
            _ => 4,
        }
    };

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if tag == "sld" {
                    has_sld = true;
                }
                for active in &mut stack {
                    active.depth += 1;
                }
                if let Some(st) = shape_type_for_tag(&tag) {
                    stack.push(ActiveShape {
                        tag: tag.clone(),
                        shape_type: st,
                        depth: 1,
                        id: None,
                        name: None,
                        tokens: Vec::new(),
                        x: None,
                        y: None,
                        width: None,
                        height: None,
                        in_nv_pr: false,
                        in_xfrm: false,
                    });
                } else if let Some(top) = stack.last_mut() {
                    match tag.as_str() {
                        "nvSpPr" | "nvPicPr" | "nvGraphicFramePr" | "nvCxnSpPr" | "nvGrpSpPr"
                            if top.depth == 2 =>
                        {
                            top.in_nv_pr = true;
                        }
                        "cNvPr" if top.in_nv_pr && top.id.is_none() && top.name.is_none() => {
                            for attr in e.attributes().flatten() {
                                let k = local_tag_name(attr.key.as_ref());
                                let v = unescape_xml_str(&attr.value);
                                if k == "id" {
                                    top.id = Some(v);
                                } else if k == "name" {
                                    top.name = Some(v);
                                }
                            }
                        }
                        "xfrm" if top.depth <= 3 => {
                            top.in_xfrm = true;
                        }
                        "off" if top.in_xfrm => {
                            for attr in e.attributes().flatten() {
                                let k = local_tag_name(attr.key.as_ref());
                                let v = unescape_xml_str(&attr.value);
                                if k == "x" {
                                    top.x = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                } else if k == "y" {
                                    top.y = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                }
                            }
                        }
                        "ext" if top.in_xfrm => {
                            for attr in e.attributes().flatten() {
                                let k = local_tag_name(attr.key.as_ref());
                                let v = unescape_xml_str(&attr.value);
                                if k == "cx" {
                                    top.width = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                } else if k == "cy" {
                                    top.height = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if !stack.is_empty() && tag == "t" {
                    in_text_tag = true;
                    cur_token.clear();
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if tag == "sld" {
                    has_sld = true;
                }
                if let Some(st) = shape_type_for_tag(&tag) {
                    by_kind[kind_slot(st)].push(PptxShape {
                        shape_type: st.to_owned(),
                        id: None,
                        name: None,
                        text: String::new(),
                        x: None,
                        y: None,
                        width: None,
                        height: None,
                    });
                } else if let Some(top) = stack.last_mut() {
                    match tag.as_str() {
                        "cNvPr" if top.in_nv_pr && top.id.is_none() && top.name.is_none() => {
                            for attr in e.attributes().flatten() {
                                let k = local_tag_name(attr.key.as_ref());
                                let v = unescape_xml_str(&attr.value);
                                if k == "id" {
                                    top.id = Some(v);
                                } else if k == "name" {
                                    top.name = Some(v);
                                }
                            }
                        }
                        "off" if top.in_xfrm => {
                            for attr in e.attributes().flatten() {
                                let k = local_tag_name(attr.key.as_ref());
                                let v = unescape_xml_str(&attr.value);
                                if k == "x" {
                                    top.x = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                } else if k == "y" {
                                    top.y = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                }
                            }
                        }
                        "ext" if top.in_xfrm => {
                            for attr in e.attributes().flatten() {
                                let k = local_tag_name(attr.key.as_ref());
                                let v = unescape_xml_str(&attr.value);
                                if k == "cx" {
                                    top.width = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                } else if k == "cy" {
                                    top.height = v.parse::<f64>().ok().filter(|n| n.is_finite());
                                }
                            }
                        }
                        _ => {}
                    }
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
                if in_text_tag && tag == "t" {
                    in_text_tag = false;
                    if !cur_token.is_empty() {
                        let tok = std::mem::take(&mut cur_token);
                        for active in &mut stack {
                            active.tokens.push(tok.clone());
                        }
                    }
                }
                let should_pop = stack
                    .last()
                    .is_some_and(|top| top.depth == 1 && top.tag == tag);
                if should_pop {
                    if let Some(done) = stack.pop() {
                        by_kind[kind_slot(done.shape_type)].push(PptxShape {
                            shape_type: done.shape_type.to_owned(),
                            id: done.id,
                            name: done.name,
                            text: normalize_whitespace(&done.tokens.join(" ")),
                            x: done.x,
                            y: done.y,
                            width: done.width,
                            height: done.height,
                        });
                    }
                } else if let Some(top) = stack.last_mut() {
                    if matches!(
                        tag.as_str(),
                        "nvSpPr" | "nvPicPr" | "nvGraphicFramePr" | "nvCxnSpPr" | "nvGrpSpPr"
                    ) {
                        top.in_nv_pr = false;
                    } else if tag == "xfrm" {
                        top.in_xfrm = false;
                    }
                }
                for active in &mut stack {
                    active.depth = active.depth.saturating_sub(1);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("PPTX slide XML parse error ({part}): {e}")),
            _ => {}
        }
        buf.clear();
    }

    if !has_sld {
        return Err(format!("PPTX slide part is invalid: {part}"));
    }

    let mut all = Vec::new();
    for group in by_kind {
        all.extend(group);
    }
    Ok(all)
}

fn collect_drawing_text(xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut tokens = Vec::new();
    let mut in_t = false;
    let mut cur = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if local_tag_name(e.name().as_ref()) == "t" => {
                in_t = true;
                cur.clear();
            }
            Ok(Event::Text(t)) if in_t => {
                cur.push_str(&decode_xml_text(&t));
            }
            Ok(Event::GeneralRef(g)) if in_t => {
                cur.push_str(&decode_general_ref(&g));
            }
            Ok(Event::End(e)) if in_t && local_tag_name(e.name().as_ref()) == "t" => {
                in_t = false;
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("PPTX notes XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(normalize_whitespace(&tokens.join(" ")))
}

pub fn same_media(left: &[OoxmlMedia], right: &[OoxmlMedia]) -> bool {
    let mut l: Vec<(&str, &str)> = left
        .iter()
        .map(|m| (m.path.as_str(), m.sha256.as_str()))
        .collect();
    let mut r: Vec<(&str, &str)> = right
        .iter()
        .map(|m| (m.path.as_str(), m.sha256.as_str()))
        .collect();
    l.sort_by_key(|(p, _)| *p);
    r.sort_by_key(|(p, _)| *p);
    l == r
}
