//! Bounded OOXML ZIP & XML readers enforcing entry count, compressed/uncompressed byte caps,
//! XML text length limits, and path-traversal confinement.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};
use std::path::Path;

use cowork_storage::sha256_hex;
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

pub const MAX_OOXML_COMPRESSED_BYTES: usize = 100 * 1024 * 1024;
pub const MAX_OOXML_ENTRIES: usize = 10_000;
pub const MAX_OOXML_UNCOMPRESSED_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_OOXML_ENTRY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OOXML_TEXT_CHARS: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OoxmlMedia {
    pub path: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OoxmlRelationship {
    pub id: String,
    pub rel_type: String,
    pub target: String,
    pub target_mode: Option<String>,
}

/// Validates and opens an OOXML ZIP archive, enforcing entry count, path confinement,
/// cumulative uncompressed size, per-entry byte limits, and XML/rels text limits before extraction.
pub fn open_bounded_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
    if bytes.len() > MAX_OOXML_COMPRESSED_BYTES {
        return Err(format!(
            "Office package exceeds the {MAX_OOXML_COMPRESSED_BYTES}-byte compressed-size limit."
        ));
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Invalid Office ZIP package: {e}"))?;

    let mut non_dir_entries = 0usize;
    let mut total_uncompressed: u64 = 0;

    for idx in 0..archive.len() {
        let entry = archive
            .by_index_raw(idx)
            .map_err(|e| format!("Invalid Office ZIP entry at index {idx}: {e}"))?;
        let raw_name = entry
            .name()
            .map_err(|e| format!("Invalid Office ZIP entry name at index {idx}: {e}"))?;
        validate_zip_entry_name(&raw_name)?;
        if entry.is_dir() || raw_name.ends_with('/') {
            continue;
        }
        non_dir_entries += 1;
        if non_dir_entries > MAX_OOXML_ENTRIES {
            return Err(format!(
                "Office package exceeds the {MAX_OOXML_ENTRIES}-entry limit."
            ));
        }

        let declared = entry.size();
        if declared > MAX_OOXML_ENTRY_BYTES as u64 {
            return Err(format!(
                "Office package part {raw_name} exceeds the {MAX_OOXML_ENTRY_BYTES}-byte limit."
            ));
        }
        if is_xml_or_rels_part(&raw_name) && declared > MAX_OOXML_TEXT_CHARS as u64 {
            return Err(format!(
                "Office package XML part {raw_name} exceeds the {MAX_OOXML_TEXT_CHARS}-character text limit."
            ));
        }
        total_uncompressed = total_uncompressed.saturating_add(declared);
        if total_uncompressed > MAX_OOXML_UNCOMPRESSED_BYTES as u64 {
            return Err(format!(
                "Office package exceeds the {MAX_OOXML_UNCOMPRESSED_BYTES}-byte uncompressed-size limit."
            ));
        }
    }

    Ok(archive)
}

pub fn archive_file_names(archive: &ZipArchive<Cursor<&[u8]>>) -> Vec<String> {
    archive
        .file_names()
        .filter_map(|n| n.ok().map(|c| c.into_owned()))
        .collect()
}

pub fn validate_zip_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('\0') {
        return Err("Office package contains an empty or NUL-terminated entry path.".to_owned());
    }
    if name.starts_with('/') || name.starts_with('\\') || name.contains('\\') {
        return Err(format!(
            "Office package contains unsafe path separator or root prefix: {name}"
        ));
    }
    if name.as_bytes().get(1) == Some(&b':') {
        return Err(format!(
            "Office package contains drive-prefixed entry path: {name}"
        ));
    }
    for seg in name.split('/') {
        if seg == ".." {
            return Err(format!(
                "Office package contains path traversal segment in entry: {name}"
            ));
        }
    }
    Ok(())
}

fn is_xml_or_rels_part(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".xml") || lower.ends_with(".rels")
}

/// Reads a bounded binary part from the ZIP archive, capping actual decompressed bytes via `Read::take`.
pub fn read_zip_bytes(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    part: &str,
) -> Result<Vec<u8>, String> {
    validate_zip_entry_name(part)?;
    let file = archive
        .by_name(part)
        .map_err(|_| format!("Missing Office package part: {part}"))?;
    let declared = file.size();
    if declared > MAX_OOXML_ENTRY_BYTES as u64 {
        return Err(format!(
            "Office package part {part} exceeds the {MAX_OOXML_ENTRY_BYTES}-byte limit."
        ));
    }
    let cap = (MAX_OOXML_ENTRY_BYTES + 1) as u64;
    let mut buf = Vec::with_capacity((declared as usize).min(4 * 1024 * 1024));
    file.take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed reading Office part {part}: {e}"))?;
    if buf.len() > MAX_OOXML_ENTRY_BYTES {
        return Err(format!(
            "Office package part {part} exceeds the {MAX_OOXML_ENTRY_BYTES}-byte decompressed limit."
        ));
    }
    Ok(buf)
}

/// Reads and UTF-8 decodes a bounded XML/text part, enforcing `MAX_OOXML_TEXT_CHARS`.
pub fn read_zip_text(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    part: &str,
) -> Result<String, String> {
    let bytes = read_zip_bytes(archive, part)?;
    if bytes.len() > MAX_OOXML_TEXT_CHARS * 4 {
        return Err(format!(
            "Office package XML part {part} exceeds the {MAX_OOXML_TEXT_CHARS}-character text limit."
        ));
    }
    let text = decode_utf8(&bytes)?;
    if text.len() > MAX_OOXML_TEXT_CHARS && text.chars().count() > MAX_OOXML_TEXT_CHARS {
        return Err(format!(
            "Office package XML part {part} exceeds the {MAX_OOXML_TEXT_CHARS}-character text limit."
        ));
    }
    Ok(text)
}

pub fn try_read_zip_text(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    part: &str,
) -> Result<Option<String>, String> {
    let exists = archive
        .file_names()
        .any(|n| n.ok().as_deref() == Some(part));
    if !exists {
        return Ok(None);
    }
    read_zip_text(archive, part).map(Some)
}

pub fn decode_utf8(bytes: &[u8]) -> Result<String, String> {
    let s = std::str::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8 text: {e}"))?;
    Ok(s.strip_prefix('\u{feff}').unwrap_or(s).to_owned())
}

pub fn local_tag_name(raw: &str) -> String {
    raw.rsplit(':').next().unwrap_or(raw).to_owned()
}

pub fn unescape_xml_str(raw: &str) -> String {
    quick_xml::escape::unescape(raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.to_owned())
}

pub fn decode_xml_text(t: &quick_xml::events::BytesText<'_>) -> String {
    let raw = t.xml10_content();
    quick_xml::escape::unescape(&raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.into_owned())
}

pub fn decode_general_ref(g: &quick_xml::events::BytesRef<'_>) -> String {
    let content = g.xml10_content();
    let raw = format!("&{content};");
    quick_xml::escape::unescape(&raw)
        .map(|c| c.into_owned())
        .unwrap_or(raw)
}

pub fn normalize_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev_ws = false;
    for ch in value.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() {
                prev_ws = true;
            }
        } else {
            if prev_ws {
                out.push(' ');
                prev_ws = false;
            }
            out.push(ch);
        }
    }
    out
}

pub fn normalize_zip_path(input: &str) -> String {
    let replaced = input.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in replaced.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub fn relationship_part_path(owner_part: &str) -> String {
    if owner_part.is_empty() {
        return "_rels/.rels".to_owned();
    }
    let normalized = normalize_zip_path(owner_part);
    match normalized.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
        None => format!("_rels/{normalized}.rels"),
    }
}

pub fn resolve_relationship_target(owner_part: &str, target: &str) -> String {
    if let Some(stripped) = target.strip_prefix('/') {
        return normalize_zip_path(stripped);
    }
    let normalized_owner = normalize_zip_path(owner_part);
    match normalized_owner.rsplit_once('/') {
        Some((dir, _)) => normalize_zip_path(&format!("{dir}/{target}")),
        None => normalize_zip_path(target),
    }
}

pub fn read_relationships(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    owner_part: &str,
) -> Result<BTreeMap<String, OoxmlRelationship>, String> {
    let rels_path = relationship_part_path(owner_part);
    let Some(xml) = try_read_zip_text(archive, &rels_path)? else {
        return Ok(BTreeMap::new());
    };
    let mut map = BTreeMap::new();
    let mut reader = Reader::from_str(&xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e))
                if local_tag_name(e.name().as_ref()) == "Relationship" =>
            {
                let mut id = None;
                let mut rel_type = None;
                let mut target = None;
                let mut target_mode = None;
                for attr in e.attributes().flatten() {
                    let k = local_tag_name(attr.key.as_ref());
                    let v = unescape_xml_str(&attr.value);
                    match k.as_str() {
                        "Id" => id = Some(v),
                        "Type" => rel_type = Some(v),
                        "Target" => target = Some(v),
                        "TargetMode" => target_mode = Some(v),
                        _ => {}
                    }
                }
                if let (Some(id), Some(rel_type), Some(target)) = (id, rel_type, target)
                    && target_mode.as_deref() != Some("External")
                {
                    map.insert(
                        id.clone(),
                        OoxmlRelationship {
                            id,
                            rel_type,
                            target,
                            target_mode,
                        },
                    );
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Relationships XML parse error ({rels_path}): {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(map)
}

pub fn detect_media_mime(bytes: &[u8], filename: &str) -> String {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return "image/png".to_owned();
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return "image/jpeg".to_owned();
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif".to_owned();
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp".to_owned();
    }
    if bytes.starts_with(b"BM") {
        return "image/bmp".to_owned();
    }
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("mp4") => "video/mp4",
        Some("emf") => "image/emf",
        Some("wmf") => "image/wmf",
        _ => "application/octet-stream",
    }
    .to_owned()
}

pub fn read_media(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    prefix: &str,
    filter: Option<&BTreeSet<String>>,
) -> Result<Vec<OoxmlMedia>, String> {
    let mut names: Vec<String> = archive_file_names(archive)
        .into_iter()
        .filter(|n| {
            n.starts_with(prefix)
                && !n.ends_with('/')
                && filter.is_none_or(|set| set.contains(n.as_str()))
        })
        .collect();
    names.sort();
    let mut media = Vec::new();
    for name in names {
        let bytes = read_zip_bytes(archive, &name)?;
        let mime_type = detect_media_mime(&bytes, &name);
        media.push(OoxmlMedia {
            path: name,
            mime_type,
            size_bytes: bytes.len(),
            sha256: sha256_hex(&bytes),
        });
    }
    Ok(media)
}
