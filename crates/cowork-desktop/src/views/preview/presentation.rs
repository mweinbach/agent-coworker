//! Read-only PowerPoint presentation preview renderer (`PptxPreview.tsx` parity).
//!
//! Renders slides returned by JSON-RPC `cowork/workspace/presentation/preview`
//! (verified LibreOffice PNGs or deterministic text-only SVGs) in Deck or Grid
//! mode with thumbnail strip, prev/next controls, keyboard navigation, and notices.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use base64::Engine as _;
use rune::{
    Align, Color, Cursor, El, GrowthSpec, Icon, ImageCache, Pixels, ScrollSpec, SurfaceFit,
    TextStyle, col, el, icon, memo, row, text,
};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit,
    Spinner,
};

use super::state::{PresentationLayoutMode, PresentationPreviewData, PresentationSlideData};
use crate::actions::{Action, NativeAction};
use crate::state::{AppState, FilePreviewState};
use crate::theme::ThemeTokens;
use crate::views::chat::icons as chat_icons;
use crate::views::shell::helpers::{RightRailKind, resolve_adaptive_layout};

const fn lucide_icon(name: &'static str, body: &'static str) -> Icon {
    Icon {
        name,
        view: 24.0,
        body,
    }
}

static ICON_PRESENTATION: Icon = lucide_icon(
    "preview-presentation",
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/></g>"#,
);

static ICON_COLUMNS: Icon = lucide_icon(
    "preview-columns",
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></g>"#,
);

static ICON_LAYOUT_GRID: Icon = lucide_icon(
    "preview-layout-grid",
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></g>"#,
);

static ICON_REFRESH_CW: Icon = lucide_icon(
    "preview-refresh-cw",
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></g>"#,
);

static ICON_CHEVRON_LEFT: Icon = lucide_icon(
    "preview-chevron-left",
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></g>"#,
);

const MAX_DECODED_SLIDES_CACHE: usize = 128;
const MAX_PIXELS_SLIDES_CACHE: usize = 256;
const MAX_PENDING_SLIDE_LOADS: usize = 64;

type UriFingerprint = (u64, u64, usize);
type PixelsCacheKey = (UriFingerprint, u32);

#[derive(Clone)]
struct CachedDecodedSlide {
    mime: String,
    bytes: Arc<[u8]>,
    text_overlay: Option<SvgTextOverlay>,
}

struct PendingSlideLoad {
    key: PixelsCacheKey,
    entry: Arc<CachedDecodedSlide>,
    size_pt: f32,
    scale: f32,
}

#[derive(Default)]
struct PresentationCacheState {
    image_cache: Option<ImageCache>,
    has_real_waker: bool,
    decoded: HashMap<UriFingerprint, Option<Arc<CachedDecodedSlide>>>,
    pixels: HashMap<PixelsCacheKey, Pixels>,
    pending: VecDeque<PendingSlideLoad>,
    ready_gen: u64,
}

fn is_text_only_rendering_mode(mode: Option<&str>) -> bool {
    matches!(mode, Some("text" | "text-fallback"))
}

/// Returns `(cache_bucket_id, decode_size_pt, decode_scale)` so slides are decoded once
/// across thumbnail, deck stage, grid card, and viewport resizes:
/// - Raster bitmaps (PNG/JPEG/WebP): size-independent `(0, 512.0, 1.0)`, scaled on GPU.
/// - Text-only fallback SVGs (native `text()` overlay on plain backdrop): compact `(320, 320.0, 1.0)`.
/// - Graphic SVGs (including SVGs with `<text>` labels): two coarse buckets
///   (`<= 320pt` -> `256@1.5x`, `> 320pt` -> `640@1.5x`).
fn slide_raster_spec(
    entry: &CachedDecodedSlide,
    text_only_deck: bool,
    requested_size_pt: f32,
) -> (u32, f32, f32) {
    if !entry.mime.eq_ignore_ascii_case("image/svg+xml") {
        (0, 512.0, 1.0)
    } else if text_only_deck && entry.text_overlay.is_some() {
        (320, 320.0, 1.0)
    } else if requested_size_pt <= 320.0 {
        (256, 256.0, 1.5)
    } else {
        (640, 640.0, 1.5)
    }
}

thread_local! {
    static PRESENTATION_IMAGE_CACHE: RefCell<PresentationCacheState> =
        RefCell::new(PresentationCacheState::default());
}

fn current_slide_ready_gen() -> u64 {
    PRESENTATION_IMAGE_CACHE.with(|slot| slot.borrow().ready_gen)
}

fn fnv1a_update(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Computes a fast O(1) 128-bit + length fingerprint for slide data URIs.
///
/// Small URIs (<= 4 KiB, e.g. SVG fallbacks and unit test fixtures) are hashed in full.
/// Multi-megabyte rasterized PNG data URIs hash header, 4 interior windows, and tail
/// (covering PNG headers, IDAT payload regions, and CRC/IEND chunks) in <1µs.
fn uri_fingerprint(uri: &str) -> UriFingerprint {
    let bytes = uri.as_bytes();
    let len = bytes.len();
    let mut h1 = DefaultHasher::new();
    let mut h2 = 0xcbf29ce484222325_u64;
    len.hash(&mut h1);
    h2 = fnv1a_update(h2, &len.to_le_bytes());
    if len <= 4096 {
        bytes.hash(&mut h1);
        h2 = fnv1a_update(h2, bytes);
    } else {
        let head = &bytes[..512];
        let tail = &bytes[len - 512..];
        head.hash(&mut h1);
        h2 = fnv1a_update(h2, head);
        for step in 1..=4 {
            let start = ((len - 128) * step) / 5;
            let slice = &bytes[start..start + 128];
            slice.hash(&mut h1);
            h2 = fnv1a_update(h2, slice);
        }
        tail.hash(&mut h1);
        h2 = fnv1a_update(h2, tail);
    }
    (h1.finish(), h2, len)
}

fn ensure_presentation_image_cache<'a>(
    state: &'a mut PresentationCacheState,
    s: &AppState,
) -> &'a mut ImageCache {
    if !state.has_real_waker
        && let Some(waker) = s.services.waker.clone()
    {
        state.image_cache = Some(ImageCache::new(waker));
        state.has_real_waker = true;
        state.pixels.clear();
        state.pending.clear();
        state.ready_gen = state.ready_gen.wrapping_add(1);
    }
    state.image_cache.get_or_insert_with(|| {
        let waker = s.services.waker.clone().unwrap_or_else(|| Arc::new(|| {}));
        ImageCache::new(waker)
    })
}

/// Polls any in-flight async slide image decodes and returns a monotonic generation counter
/// that advances whenever a newly-decoded slide becomes ready or errors (invalidating `rune::memo`).
fn poll_pending_slide_visuals(s: &AppState) -> u64 {
    PRESENTATION_IMAGE_CACHE.with(|slot| {
        let mut state = slot.borrow_mut();
        let _ = ensure_presentation_image_cache(&mut state, s);
        if state.pending.is_empty() {
            return state.ready_gen;
        }
        let mut still_pending = VecDeque::with_capacity(state.pending.len());
        let pending = std::mem::take(&mut state.pending);
        for job in pending {
            if state.pixels.contains_key(&job.key) {
                continue;
            }
            let Some(cache) = state.image_cache.as_mut() else {
                still_pending.push_back(job);
                continue;
            };
            let img = cache.load_mime(
                Arc::clone(&job.entry.bytes),
                &job.entry.mime,
                job.size_pt,
                job.scale,
            );
            if img.error().is_some() {
                state.ready_gen = state.ready_gen.wrapping_add(1);
                continue;
            }
            if img.is_ready() {
                if state.pixels.len() >= MAX_PIXELS_SLIDES_CACHE {
                    state.pixels.clear();
                }
                state.pixels.insert(job.key, img.pixels().clone());
                state.ready_gen = state.ready_gen.wrapping_add(1);
            } else {
                still_pending.push_back(job);
            }
        }
        state.pending = still_pending;
        state.ready_gen
    })
}

fn decode_data_uri_payload(uri: &str) -> Option<Arc<CachedDecodedSlide>> {
    let trimmed = uri.trim();
    let payload = trimmed
        .get(..5)
        .filter(|prefix| prefix.eq_ignore_ascii_case("data:"))
        .and_then(|_| trimmed.get(5..))?;
    let (meta, raw) = payload.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("").trim();
    if !mime
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("image/"))
    {
        return None;
    }

    let is_base64 = meta
        .split(';')
        .skip(1)
        .any(|p| p.trim().eq_ignore_ascii_case("base64"));

    let bytes: Vec<u8> = if is_base64 {
        if raw.as_bytes().iter().any(u8::is_ascii_whitespace) {
            let mut compact = Vec::with_capacity(raw.len());
            for &b in raw.as_bytes() {
                if !b.is_ascii_whitespace() {
                    compact.push(b);
                }
            }
            base64::engine::general_purpose::STANDARD
                .decode(&compact)
                .ok()?
        } else {
            base64::engine::general_purpose::STANDARD
                .decode(raw.as_bytes())
                .ok()?
        }
    } else if raw.contains('%') {
        decode_percent_encoded_bytes(raw)
    } else {
        raw.as_bytes().to_vec()
    };

    if bytes.is_empty() {
        return None;
    }

    let text_overlay = if mime.eq_ignore_ascii_case("image/svg+xml") {
        extract_svg_text_overlay(&bytes)
    } else {
        None
    };

    Some(Arc::new(CachedDecodedSlide {
        mime: mime.to_string(),
        bytes: Arc::<[u8]>::from(bytes),
        text_overlay,
    }))
}

fn decode_percent_encoded_bytes(raw: &str) -> Vec<u8> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub(super) struct SvgTextLine {
    pub text: String,
    pub x_vb: f32,
    pub top_vb: f32,
    pub font_size_vb: f32,
    pub bold: bool,
    pub color: Color,
}

#[derive(Clone, Debug)]
pub(super) struct SvgTextOverlay {
    pub view_w: f32,
    pub view_h: f32,
    pub lines: Vec<SvgTextLine>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct DecodedSlideVisual {
    pub pixels: Option<Pixels>,
    pub text_overlay: Option<SvgTextOverlay>,
    pub loading: bool,
}

fn svg_srgb_channel(ch: u8) -> f32 {
    let c = ch as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn svg_srgb(r: u8, g: u8, b: u8) -> Color {
    Color {
        r: svg_srgb_channel(r),
        g: svg_srgb_channel(g),
        b: svg_srgb_channel(b),
        a: 1.0,
    }
}

fn parse_svg_color(raw: &str) -> Option<Color> {
    let v = raw.trim();
    if let Some(hex) = v.strip_prefix('#') {
        let bytes = hex.as_bytes();
        return match bytes.len() {
            3 => {
                let r = hex_nibble(bytes[0])? * 17;
                let g = hex_nibble(bytes[1])? * 17;
                let b = hex_nibble(bytes[2])? * 17;
                Some(svg_srgb(r, g, b))
            }
            6 | 8 => {
                let r = (hex_nibble(bytes[0])? << 4) | hex_nibble(bytes[1])?;
                let g = (hex_nibble(bytes[2])? << 4) | hex_nibble(bytes[3])?;
                let b = (hex_nibble(bytes[4])? << 4) | hex_nibble(bytes[5])?;
                Some(svg_srgb(r, g, b))
            }
            _ => None,
        };
    }
    match v.to_ascii_lowercase().as_str() {
        "black" => Some(svg_srgb(0x18, 0x18, 0x1b)),
        "white" => Some(Color::WHITE),
        "gray" | "grey" => Some(svg_srgb(0x66, 0x66, 0x66)),
        _ => None,
    }
}

fn unescape_xml_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after_amp = &rest[amp + 1..];
        if let Some(semi) = after_amp.find(';') {
            let entity = &after_amp[..semi];
            let replacement = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                    u32::from_str_radix(&entity[2..], 16)
                        .ok()
                        .and_then(char::from_u32)
                }
                _ if entity.starts_with('#') => {
                    entity[1..].parse::<u32>().ok().and_then(char::from_u32)
                }
                _ => None,
            };
            if let Some(ch) = replacement {
                out.push(ch);
                rest = &after_amp[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = after_amp;
    }
    out.push_str(rest);
    out
}

fn strip_xml_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    unescape_xml_entities(out.trim())
}

fn svg_attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let mut i = 0;
    let bytes = attrs.as_bytes();
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let key = &attrs[key_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let quote = bytes[i];
        if quote == b'"' || quote == b'\'' {
            i += 1;
            let val_start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            let val = &attrs[val_start..i];
            if i < bytes.len() {
                i += 1;
            }
            if key.eq_ignore_ascii_case(name) {
                return Some(val);
            }
        } else {
            let val_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let val = &attrs[val_start..i];
            if key.eq_ignore_ascii_case(name) {
                return Some(val);
            }
        }
    }
    None
}

fn parse_svg_number(raw: Option<&str>) -> Option<f32> {
    let s = raw?.trim();
    let trimmed = s.strip_suffix("px").unwrap_or(s).trim();
    trimmed.parse::<f32>().ok().filter(|n| n.is_finite())
}

fn parse_svg_is_bold(attrs: &str, default_bold: bool) -> bool {
    let Some(weight) = svg_attr(attrs, "font-weight") else {
        return default_bold;
    };
    let lower = weight.trim().to_ascii_lowercase();
    if lower == "bold" || lower == "bolder" {
        return true;
    }
    if lower == "normal" || lower == "lighter" {
        return false;
    }
    lower
        .parse::<f32>()
        .ok()
        .map_or(default_bold, |w| w >= 600.0)
}

/// Extracts `<text>` and `<tspan>` text lines from inline SVGs (such as server-generated
/// text-only fallback slides) because `rune::ImageCache::svg` rasterizes with an empty fontdb.
pub(super) fn extract_svg_text_overlay(svg_bytes: &[u8]) -> Option<SvgTextOverlay> {
    let svg = std::str::from_utf8(svg_bytes).ok()?;
    if !svg.contains("<text") {
        return None;
    }

    let (mut view_w, mut view_h) = (1600.0_f32, 900.0_f32);
    if let Some(svg_start) = svg.find("<svg")
        && let Some(svg_end) = svg[svg_start..].find('>')
    {
        let svg_attrs = &svg[svg_start + 4..svg_start + svg_end];
        if let Some(vb) = svg_attr(svg_attrs, "viewBox") {
            let nums: Vec<f32> = vb
                .split(|c: char| c.is_ascii_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .filter_map(|s| s.parse::<f32>().ok())
                .collect();
            if nums.len() == 4 && nums[2] > 0.0 && nums[3] > 0.0 {
                view_w = nums[2];
                view_h = nums[3];
            }
        } else if let (Some(w), Some(h)) = (
            parse_svg_number(svg_attr(svg_attrs, "width")),
            parse_svg_number(svg_attr(svg_attrs, "height")),
        ) && w > 0.0
            && h > 0.0
        {
            view_w = w;
            view_h = h;
        }
    }

    let default_color = svg_srgb(0x20, 0x21, 0x24);
    let mut lines = Vec::new();
    let mut pos = 0;

    while let Some(rel_start) = svg[pos..].find("<text") {
        let tag_start = pos + rel_start;
        let next_ch = svg.as_bytes().get(tag_start + 5).copied();
        if !matches!(next_ch, Some(b' ' | b'\t' | b'\r' | b'\n' | b'>' | b'/')) {
            pos = tag_start + 5;
            continue;
        }
        let Some(rel_gt) = svg[tag_start..].find('>') else {
            break;
        };
        let gt = tag_start + rel_gt;
        if gt > tag_start && svg.as_bytes()[gt - 1] == b'/' {
            pos = gt + 1;
            continue;
        }
        let attrs = &svg[tag_start + 5..gt];
        let body_start = gt + 1;
        let Some(rel_close) = svg[body_start..].find("</text>") else {
            break;
        };
        let body = &svg[body_start..body_start + rel_close];
        pos = body_start + rel_close + 7;

        let base_x = parse_svg_number(svg_attr(attrs, "x")).unwrap_or(0.0);
        let base_y = parse_svg_number(svg_attr(attrs, "y")).unwrap_or(0.0);
        let base_fs = parse_svg_number(svg_attr(attrs, "font-size")).unwrap_or(28.0);
        let base_bold = parse_svg_is_bold(attrs, false);
        let base_color = svg_attr(attrs, "fill")
            .and_then(parse_svg_color)
            .unwrap_or(default_color);

        if body.contains("<tspan") {
            let mut cur_x = base_x;
            let mut cur_y = base_y;
            let mut tpos = 0;
            while let Some(t_rel) = body[tpos..].find("<tspan") {
                let ts = tpos + t_rel;
                let Some(t_gt_rel) = body[ts..].find('>') else {
                    break;
                };
                let t_gt = ts + t_gt_rel;
                let t_attrs = &body[ts + 6..t_gt];
                let t_body_start = t_gt + 1;
                let Some(t_close_rel) = body[t_body_start..].find("</tspan>") else {
                    break;
                };
                let t_body = &body[t_body_start..t_body_start + t_close_rel];
                tpos = t_body_start + t_close_rel + 8;

                if let Some(tx) = parse_svg_number(svg_attr(t_attrs, "x")) {
                    cur_x = tx;
                } else if let Some(tdx) = parse_svg_number(svg_attr(t_attrs, "dx")) {
                    cur_x += tdx;
                }
                if let Some(ty) = parse_svg_number(svg_attr(t_attrs, "y")) {
                    cur_y = ty;
                } else if let Some(tdy) = parse_svg_number(svg_attr(t_attrs, "dy")) {
                    cur_y += tdy;
                }

                let span_fs = parse_svg_number(svg_attr(t_attrs, "font-size")).unwrap_or(base_fs);
                let span_bold = parse_svg_is_bold(t_attrs, base_bold);
                let span_color = svg_attr(t_attrs, "fill")
                    .and_then(parse_svg_color)
                    .unwrap_or(base_color);

                let text_val = strip_xml_tags(t_body);
                if !text_val.is_empty() {
                    lines.push(SvgTextLine {
                        text: text_val,
                        x_vb: cur_x,
                        top_vb: (cur_y - span_fs * 0.85).max(0.0),
                        font_size_vb: span_fs,
                        bold: span_bold,
                        color: span_color,
                    });
                }
            }
        } else {
            let text_val = strip_xml_tags(body);
            if !text_val.is_empty() {
                lines.push(SvgTextLine {
                    text: text_val,
                    x_vb: base_x,
                    top_vb: (base_y - base_fs * 0.85).max(0.0),
                    font_size_vb: base_fs,
                    bold: base_bold,
                    color: base_color,
                });
            }
        }
    }

    if lines.is_empty() {
        None
    } else {
        Some(SvgTextOverlay {
            view_w,
            view_h,
            lines,
        })
    }
}

/// Decodes a `data:image/...` URL (PNG or text-fallback SVG) into cached GPU pixels and
/// optional extracted SVG text lines.
///
/// Decoded bytes, parsed SVG text overlays, and ready GPU `Pixels` are cached per slide
/// fingerprint so repeated commits do zero base64 decoding or XML parsing.
pub(super) fn decode_slide_visual(
    s: &AppState,
    uri: &str,
    size_pt: f32,
    text_only_deck: bool,
) -> DecodedSlideVisual {
    let fp = uri_fingerprint(uri);
    let sync_wait = s.services.waker.is_none();

    PRESENTATION_IMAGE_CACHE.with(|slot| {
        let mut state = slot.borrow_mut();
        let _ = ensure_presentation_image_cache(&mut state, s);

        let decoded_entry = if let Some(cached) = state.decoded.get(&fp) {
            cached.clone()
        } else {
            let parsed = decode_data_uri_payload(uri);
            if state.decoded.len() >= MAX_DECODED_SLIDES_CACHE {
                state.decoded.clear();
            }
            state.decoded.insert(fp, parsed.clone());
            parsed
        };

        let Some(entry) = decoded_entry else {
            return DecodedSlideVisual::default();
        };

        let (bucket_id, decode_size_pt, decode_scale) =
            slide_raster_spec(&entry, text_only_deck, size_pt);
        let px_key: PixelsCacheKey = (fp, bucket_id);

        if let Some(px) = state.pixels.get(&px_key) {
            return DecodedSlideVisual {
                pixels: Some(px.clone()),
                text_overlay: entry.text_overlay.clone(),
                loading: false,
            };
        }

        let cache = ensure_presentation_image_cache(&mut state, s);
        let img = cache.load_mime(
            Arc::clone(&entry.bytes),
            &entry.mime,
            decode_size_pt,
            decode_scale,
        );
        if sync_wait && !img.is_ready() {
            let _ = img.wait();
        }
        let (pixels, loading) = if img.error().is_some() {
            (None, false)
        } else if img.is_ready() {
            let px = img.pixels().clone();
            if state.pixels.len() >= MAX_PIXELS_SLIDES_CACHE {
                state.pixels.clear();
            }
            state.pixels.insert(px_key, px.clone());
            (Some(px), false)
        } else {
            if !state.pending.iter().any(|job| job.key == px_key) {
                while state.pending.len() >= MAX_PENDING_SLIDE_LOADS {
                    state.pending.pop_front();
                }
                state.pending.push_back(PendingSlideLoad {
                    key: px_key,
                    entry: Arc::clone(&entry),
                    size_pt: decode_size_pt,
                    scale: decode_scale,
                });
            }
            (None, true)
        };

        DecodedSlideVisual {
            pixels,
            text_overlay: entry.text_overlay.clone(),
            loading,
        }
    })
}

fn estimated_preview_width(s: &AppState) -> f32 {
    let vp_w = if s.shell_ui.viewport_width > 0.0 {
        s.shell_ui.viewport_width
    } else {
        1280.0
    };
    let adaptive = resolve_adaptive_layout(
        vp_w,
        s.sidebar.is_open(),
        s.sidebar.width(),
        true,
        s.context_sidebar.is_open(),
        s.context_sidebar.width(),
        RightRailKind::Context,
    );
    let content_w = (vp_w - adaptive.left_width - adaptive.right_width).max(320.0);
    if s.shell_ui.preview_maximized {
        content_w
    } else {
        content_w * 0.62
    }
}

fn format_badge_for_path(path: &str) -> &'static str {
    if path.to_ascii_lowercase().ends_with(".ppt") {
        "PPT"
    } else {
        "PPTX"
    }
}

fn slide_display_title(slide: &PresentationSlideData, idx: usize) -> String {
    slide
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Slide {}", idx + 1))
}

fn dispatch_reload_presentation(s: &mut AppState, workspace_id: &str, path: &str) {
    s.dispatch(Action::Native(NativeAction::LoadFilePreview {
        workspace_id: workspace_id.to_string(),
        path: path.to_string(),
    }));
}

fn presentation_theme_sig(s: &AppState, t: &ThemeTokens) -> u64 {
    let mut h = DefaultHasher::new();
    (
        t.dark,
        t.accent.r.to_bits(),
        t.accent.g.to_bits(),
        t.accent.b.to_bits(),
        t.panel_bg.r.to_bits(),
        t.sidebar_bg.r.to_bits(),
        t.border_muted.a.to_bits(),
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        s.ui_scale.to_bits(),
    )
        .hash(&mut h);
    h.finish()
}

fn grid_cols_for_width(est_width: f32) -> usize {
    if est_width >= 880.0 {
        3
    } else if est_width >= 540.0 {
        2
    } else {
        1
    }
}

#[allow(clippy::too_many_arguments)]
fn presentation_memo_version(
    s: &AppState,
    preview: &FilePreviewState,
    data: &PresentationPreviewData,
    active_idx: usize,
    compact: bool,
    est_w: f32,
    ready_gen: u64,
    theme_sig: u64,
) -> u64 {
    let mut h = DefaultHasher::new();
    (
        theme_sig,
        s.services.waker.is_some(),
        ready_gen,
        preview.workspace_id.as_str(),
        preview.path.as_str(),
        data.loading,
        data.rendering_mode.as_deref(),
    )
        .hash(&mut h);
    (
        data.warnings.as_slice(),
        data.error_kind.as_deref(),
        data.error_message.as_deref(),
        data.slides.len(),
        active_idx,
        matches!(
            s.preview_ui.presentation_layout,
            PresentationLayoutMode::Grid
        ),
        compact,
    )
        .hash(&mut h);
    match s.preview_ui.presentation_layout {
        PresentationLayoutMode::Deck => {
            let stage_est_w =
                (est_w - if compact { 0.0 } else { 156.0 } - 28.0).clamp(260.0, 960.0);
            ((stage_est_w / 16.0).round() as i32).hash(&mut h);
        }
        PresentationLayoutMode::Grid => {
            let cols = grid_cols_for_width(est_w);
            let card_w =
                ((est_w - 24.0 - 12.0 * (cols as f32 - 1.0)) / cols as f32 - 16.0).max(160.0);
            (cols, (card_w / 16.0).round() as i32).hash(&mut h);
        }
    }
    for slide in &data.slides {
        (
            slide.slide_index,
            slide.slide_id.as_deref(),
            slide.title.as_deref(),
            uri_fingerprint(&slide.png_base64),
        )
            .hash(&mut h);
    }
    h.finish()
}

/// Renders the read-only PowerPoint presentation preview body inside `inline-file-preview`.
pub fn render_presentation_preview(
    s: &AppState,
    preview: &FilePreviewState,
    data: &PresentationPreviewData,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let est_w = estimated_preview_width(s);
    let compact = est_w < 520.0;
    let total_slides = data.slides.len();
    let active_idx = if total_slides == 0 {
        0
    } else {
        s.preview_ui.active_slide.min(total_slides - 1)
    };
    let ready_gen = poll_pending_slide_visuals(s);
    let theme_sig = presentation_theme_sig(s, t);
    let version = presentation_memo_version(
        s, preview, data, active_idx, compact, est_w, ready_gen, theme_sig,
    );

    memo("pptx-preview-root", version, || {
        render_presentation_preview_inner(
            s, preview, data, active_idx, compact, est_w, ready_gen, theme_sig, k, t,
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn render_presentation_preview_inner(
    s: &AppState,
    preview: &FilePreviewState,
    data: &PresentationPreviewData,
    active_idx: usize,
    compact: bool,
    est_w: f32,
    ready_gen: u64,
    theme_sig: u64,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let total_slides = data.slides.len();
    let meta_bar = build_meta_bar(s, preview, data, compact, k, t);

    let mut root = col()
        .w_full()
        .h_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .focusable(true)
        .on_key(move |s: &mut AppState, ev, _| {
            if !ev.mods.cmd && !ev.mods.ctrl && !ev.mods.alt {
                s.preview_ui.handle_presentation_key(&ev.key, total_slides)
            } else {
                false
            }
        })
        .child(meta_bar)
        .child(el().w_full().h(1.0).fill(t.border_muted));

    if !data.loading
        && data.error_message.is_none()
        && let Some(notice_banner) = build_notice_banner(data, t)
    {
        root = root
            .child(notice_banner)
            .child(el().w_full().h(1.0).fill(t.border_muted));
    }

    let body = if data.loading {
        build_loading_view(k, t)
    } else if let Some(err) = data.error_message.as_deref() {
        build_error_view(preview, err, k, t)
    } else if data.slides.is_empty() {
        build_empty_view(t)
    } else {
        match s.preview_ui.presentation_layout {
            PresentationLayoutMode::Deck => build_deck_view(
                s,
                &data.slides,
                active_idx,
                compact,
                est_w,
                ready_gen,
                is_text_only_rendering_mode(data.rendering_mode.as_deref()),
                theme_sig,
                k,
                t,
            ),
            PresentationLayoutMode::Grid => build_grid_view(&data.slides, est_w, theme_sig, t),
        }
    };

    root.child(body)
}

fn build_meta_bar(
    s: &AppState,
    preview: &FilePreviewState,
    data: &PresentationPreviewData,
    compact: bool,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let summary = if data.loading {
        "Rendering slides…".to_string()
    } else if !data.slides.is_empty() {
        let count = data.slides.len();
        format!("{count} slide{}", if count == 1 { "" } else { "s" })
    } else {
        "Presentation".to_string()
    };

    let mut bar = row()
        .key("pptx-preview-meta")
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(8.0)
        .center_y()
        .child(icon(&ICON_PRESENTATION, 14.0).color(t.text_muted))
        .child(
            Badge::new(format_badge_for_path(&preview.path))
                .variant(BadgeVariant::Subtle)
                .build(k),
        )
        .child(text(summary).font(t.caption).color(t.text_muted).truncate())
        .child(
            text(preview.path.as_str())
                .font(t.caption)
                .color(t.text_faint)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );

    if !data.loading && data.error_message.is_none() && !data.slides.is_empty() {
        let layout = s.preview_ui.presentation_layout;
        let deck_btn = el().key("pptx-layout-deck").child(
            IconButton::new(&ICON_COLUMNS)
                .label("Deck view")
                .help("Deck view")
                .control_size(ControlSize::Small)
                .variant(if layout == PresentationLayoutMode::Deck {
                    IconButtonVariant::Neutral
                } else {
                    IconButtonVariant::GhostMuted
                })
                .on_press(|s: &mut AppState| {
                    s.preview_ui
                        .set_presentation_layout(PresentationLayoutMode::Deck);
                })
                .build(k),
        );
        let grid_btn = el().key("pptx-layout-grid").child(
            IconButton::new(&ICON_LAYOUT_GRID)
                .label("Grid view")
                .help("Grid view")
                .control_size(ControlSize::Small)
                .variant(if layout == PresentationLayoutMode::Grid {
                    IconButtonVariant::Neutral
                } else {
                    IconButtonVariant::GhostMuted
                })
                .on_press(|s: &mut AppState| {
                    s.preview_ui
                        .set_presentation_layout(PresentationLayoutMode::Grid);
                })
                .build(k),
        );
        bar = bar.child(
            row()
                .padding(2.0)
                .gap(2.0)
                .radius(6.0)
                .border(1.0, t.border_muted)
                .fill(t.sidebar_bg)
                .child(deck_btn)
                .child(grid_btn),
        );
    }

    let ws_id = preview.workspace_id.clone();
    let path = preview.path.clone();
    let refresh_btn = if compact {
        el().key("pptx-refresh-btn").child(
            IconButton::new(&ICON_REFRESH_CW)
                .label("Refresh presentation")
                .help("Refresh presentation")
                .control_size(ControlSize::Small)
                .variant(IconButtonVariant::GhostMuted)
                .disabled(data.loading)
                .on_press(move |s: &mut AppState| {
                    dispatch_reload_presentation(s, &ws_id, &path);
                })
                .build(k),
        )
    } else {
        el().key("pptx-refresh-btn").child(
            Button::new("Refresh")
                .icon(&ICON_REFRESH_CW)
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(data.loading)
                .on_press(move |s: &mut AppState| {
                    dispatch_reload_presentation(s, &ws_id, &path);
                })
                .build(k),
        )
    };

    bar.child(refresh_btn)
}

fn build_notice_banner(data: &PresentationPreviewData, t: &ThemeTokens) -> Option<El> {
    let (text_only, details) = data.notice_details();
    if !text_only && details.is_empty() {
        return None;
    }

    let title = if text_only {
        "Text-only preview"
    } else {
        "Preview warning"
    };

    let mut body = col()
        .gap(2.0)
        .grow(1.0)
        .min_w(0.0)
        .child(text(title).font(t.label).color(t.warning));

    if text_only {
        body = body.child(
            text("Images, charts, layout, and original styling are not shown. Long slide text may be shortened.")
                .font(t.caption)
                .color(t.text_muted)
                .wrap()
                .w_full(),
        );
    }
    if !details.is_empty() {
        body = body.child(
            text(details.join(" "))
                .font(t.caption)
                .color(t.text_muted)
                .wrap()
                .w_full(),
        );
    }

    Some(
        row()
            .key("pptx-preview-notice")
            .w_full()
            .px(12.0)
            .py(8.0)
            .gap(8.0)
            .fill(t.warning.alpha(if t.dark { 0.14 } else { 0.10 }))
            .child(
                el().pt(2.0)
                    .child(icon(&chat_icons::ALERT, 14.0).color(t.warning)),
            )
            .child(body),
    )
}

fn build_loading_view(k: &Kit, t: &ThemeTokens) -> El {
    el().key("pptx-preview-loading")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .center()
        .padding(20.0)
        .child(
            col()
                .items_center()
                .gap(8.0)
                .child(Spinner::new().size(20.0).color(t.accent).build(k))
                .child(
                    text("Rendering slides…")
                        .font(t.caption)
                        .color(t.text_muted),
                ),
        )
}

fn build_error_view(preview: &FilePreviewState, error_msg: &str, k: &Kit, t: &ThemeTokens) -> El {
    let ws_id = preview.workspace_id.clone();
    let path = preview.path.clone();

    el().key("pptx-preview-error")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .center()
        .padding(16.0)
        .child(
            col()
                .max_w(420.0)
                .items_center()
                .gap(8.0)
                .padding(18.0)
                .radius(10.0)
                .border(1.0, t.border_muted)
                .fill(t.sidebar_bg)
                .child(icon(&chat_icons::ALERT, 22.0).color(t.danger))
                .child(
                    text("Couldn’t render presentation")
                        .font(t.label)
                        .color(t.text_base),
                )
                .child(
                    text(error_msg)
                        .font(t.caption)
                        .color(t.text_muted)
                        .align(Align::Center)
                        .wrap()
                        .w_full(),
                )
                .child(
                    el().key("pptx-retry-btn").pt(4.0).child(
                        Button::new("Try again")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .on_press(move |s: &mut AppState| {
                                dispatch_reload_presentation(s, &ws_id, &path);
                            })
                            .build(k),
                    ),
                ),
        )
}

fn build_empty_view(t: &ThemeTokens) -> El {
    el().key("pptx-preview-empty")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .center()
        .padding(20.0)
        .child(
            text("No slides to preview.")
                .font(t.caption)
                .color(t.text_muted),
        )
}

fn visual_aspect_ratio(visual: &DecodedSlideVisual) -> f32 {
    if let Some(px) = visual.pixels.as_ref()
        && let (w, h) = px.size()
        && w > 0
        && h > 0
    {
        return w as f32 / h as f32;
    }
    if let Some(ov) = visual.text_overlay.as_ref()
        && ov.view_w > 0.0
        && ov.view_h > 0.0
    {
        return ov.view_w / ov.view_h;
    }
    16.0 / 9.0
}

fn render_svg_text_overlay(overlay: &SvgTextOverlay, fit_w_pt: f32, is_thumb: bool) -> El {
    let scale = (fit_w_pt / overlay.view_w.max(1.0)).max(0.05);
    let min_font = if is_thumb {
        6.5
    } else if fit_w_pt < 280.0 {
        7.0
    } else {
        9.0
    };
    let max_font = if is_thumb { 9.5 } else { 24.0 };
    let mut cursor_pt = 0.0_f32;
    let mut layer = col()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .w_full()
        .h_full();

    let max_lines = if is_thumb { 6 } else { usize::MAX };
    for line in overlay.lines.iter().take(max_lines) {
        let font_pt = (line.font_size_vb * scale).clamp(min_font, max_font);
        let target_top = line.top_vb * scale;
        let gap_above = (target_top - cursor_pt).max(0.0);
        let pad_x = (line.x_vb * scale).clamp(if is_thumb { 5.0 } else { 14.0 }, fit_w_pt * 0.25);
        let style = TextStyle::new(font_pt, if line.bold { 600.0 } else { 400.0 });
        let content_w = (fit_w_pt - pad_x * 2.0).max(40.0);
        let approx_chars = (content_w / (font_pt * 0.52)).max(12.0);
        let est_lines = if is_thumb {
            1.0
        } else {
            (line.text.chars().count() as f32 / approx_chars)
                .ceil()
                .max(1.0)
        };

        let txt = text(line.text.as_str()).font(style).color(line.color);
        let txt = if is_thumb {
            txt.truncate().w_full()
        } else {
            txt.wrap().w_full()
        };

        layer = layer.child(el().w_full().pt(gap_above).pl(pad_x).pr(pad_x).child(txt));
        cursor_pt += gap_above + est_lines * font_pt * 1.25;
    }

    layer
}

fn render_slide_frame_with_visual(
    visual: &DecodedSlideVisual,
    image_key: Option<&str>,
    fit_w_pt: f32,
    is_thumb: bool,
    t: &ThemeTokens,
) -> El {
    let mut frame = el()
        .w_full()
        .h_full()
        .radius(6.0)
        .border(1.0, t.border_muted)
        .clip_rounded(6.0)
        .fill(Color::WHITE);

    if let Some(key) = image_key {
        frame = frame.key(key);
    }

    if visual.pixels.is_none() && visual.text_overlay.is_none() {
        if visual.loading {
            return frame.fill(t.sidebar_bg).center().padding(8.0).child(
                text("Loading slide…")
                    .font(t.caption)
                    .color(t.text_faint)
                    .align(Align::Center)
                    .wrap()
                    .w_full(),
            );
        }
        return frame.fill(t.sidebar_bg).center().padding(8.0).child(
            text("Slide preview unavailable.")
                .font(t.caption)
                .color(t.text_muted)
                .align(Align::Center)
                .wrap()
                .w_full(),
        );
    }

    if let Some(px) = visual.pixels.as_ref() {
        frame = frame.child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .pixels_fit(px, SurfaceFit::Fit),
        );
    }
    if let Some(overlay) = visual.text_overlay.as_ref() {
        frame = frame.child(render_svg_text_overlay(overlay, fit_w_pt, is_thumb));
    }
    frame
}

fn render_slide_canvas_frame(
    s: &AppState,
    slide: &PresentationSlideData,
    decode_size_pt: f32,
    box_size: (f32, f32),
    is_thumb: bool,
    text_only_deck: bool,
    t: &ThemeTokens,
) -> El {
    let visual = decode_slide_visual(s, &slide.png_base64, decode_size_pt, text_only_deck);
    let ratio = visual_aspect_ratio(&visual);
    let fit_w_pt = box_size.0.min(box_size.1 * ratio).max(40.0);
    el().aspect_fit(ratio).child(render_slide_frame_with_visual(
        &visual, None, fit_w_pt, is_thumb, t,
    ))
}

fn slide_number_pill(idx: usize, pad_x: f32, pad_y: f32, inset: f32, t: &ThemeTokens) -> El {
    el().pin(None, None, Some(inset), Some(inset))
        .px(pad_x)
        .py(pad_y)
        .radius(if inset >= 6.0 { 4.0 } else { 3.0 })
        .border(1.0, t.border_muted)
        .fill(t.popover_bg)
        .child(
            text(format!("{}", idx + 1))
                .font(t.caption)
                .color(t.text_muted),
        )
}

#[allow(clippy::too_many_arguments)]
fn build_memoized_thumbnail_tile(
    s: &AppState,
    slide: &PresentationSlideData,
    idx: usize,
    total_slides: usize,
    active: bool,
    compact: bool,
    ready_gen: u64,
    text_only_deck: bool,
    theme_sig: u64,
    t: &ThemeTokens,
) -> El {
    let mut h = DefaultHasher::new();
    (
        idx,
        total_slides,
        active,
        compact,
        ready_gen,
        text_only_deck,
    )
        .hash(&mut h);
    (
        theme_sig,
        s.services.waker.is_some(),
        slide.slide_index,
        slide.slide_id.as_deref(),
        slide.title.as_deref(),
        uri_fingerprint(&slide.png_base64),
    )
        .hash(&mut h);
    let key = format!("pptx-thumb-{idx}");
    memo(key.as_str(), h.finish(), || {
        build_thumbnail_tile(
            s,
            slide,
            idx,
            total_slides,
            active,
            compact,
            text_only_deck,
            t,
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn build_thumbnail_tile(
    s: &AppState,
    slide: &PresentationSlideData,
    idx: usize,
    total_slides: usize,
    active: bool,
    compact: bool,
    text_only_deck: bool,
    t: &ThemeTokens,
) -> El {
    let border_col = if active { t.accent } else { t.border_muted };
    let bg_col = if active {
        t.accent.alpha(if t.dark { 0.16 } else { 0.08 })
    } else {
        t.panel_bg
    };

    let (tile_w, thumb_w_pt, thumb_h) = if compact {
        (Some(112.0), 102.0, 58.0)
    } else {
        (None, 130.0, 74.0)
    };

    let thumb_box = el()
        .w_full()
        .h(thumb_h)
        .center()
        .child(render_slide_canvas_frame(
            s,
            slide,
            220.0,
            (thumb_w_pt, thumb_h),
            true,
            text_only_deck,
            t,
        ))
        .child(slide_number_pill(idx, 4.0, 1.0, 4.0, t));

    let title = slide_display_title(slide, idx);
    let mut tile = col()
        .gap(4.0)
        .padding(5.0)
        .radius(6.0)
        .border(if active { 1.5 } else { 1.0 }, border_col)
        .fill(bg_col)
        .cursor(Cursor::Pointer)
        .on_press(move |s: &mut AppState| {
            s.preview_ui.select_slide(idx, total_slides);
        })
        .child(thumb_box)
        .child(
            text(title)
                .font(t.caption)
                .color(if active { t.text_base } else { t.text_muted })
                .truncate()
                .w_full(),
        );

    if let Some(w) = tile_w {
        tile = tile.w(w).shrink();
    } else {
        tile = tile.w_full();
    }
    tile
}

#[allow(clippy::too_many_arguments)]
fn build_deck_view(
    s: &AppState,
    slides: &[PresentationSlideData],
    active_idx: usize,
    compact: bool,
    est_width: f32,
    ready_gen: u64,
    text_only_deck: bool,
    theme_sig: u64,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let total = slides.len();
    let active_slide = &slides[active_idx];

    let thumb_items = if compact {
        let mut strip = row()
            .key("pptx-thumb-strip")
            .w_full()
            .h(98.0)
            .shrink()
            .px(8.0)
            .py(6.0)
            .gap(6.0)
            .center_y()
            .fill(t.sidebar_bg)
            .scroll_x();
        for (idx, slide) in slides.iter().enumerate() {
            strip = strip.child(build_memoized_thumbnail_tile(
                s,
                slide,
                idx,
                total,
                idx == active_idx,
                true,
                ready_gen,
                text_only_deck,
                theme_sig,
                t,
            ));
        }
        strip
    } else {
        let tokens = *t;
        let rows_stack = col()
            .key("pptx-thumb-strip-rows")
            .w_full()
            .padding(8.0)
            .gap(6.0)
            .growth(GrowthSpec::default())
            .virtual_rows(
                total,
                108.0,
                |_: &AppState, idx| Cow::Owned(format!("pptx-thumb-{idx}")),
                move |s: &AppState, idx| {
                    let Some(pres) = s
                        .active_file_preview
                        .as_ref()
                        .and_then(|p| p.presentation.as_deref())
                    else {
                        return el().key(format!("pptx-thumb-{idx}"));
                    };
                    let Some(slide) = pres.slides.get(idx) else {
                        return el().key(format!("pptx-thumb-{idx}"));
                    };
                    let live_total = pres.slides.len();
                    let live_active = s.preview_ui.active_slide.min(live_total.saturating_sub(1));
                    let live_text_only =
                        is_text_only_rendering_mode(pres.rendering_mode.as_deref());
                    let live_ready_gen = current_slide_ready_gen();
                    build_memoized_thumbnail_tile(
                        s,
                        slide,
                        idx,
                        live_total,
                        idx == live_active,
                        false,
                        live_ready_gen,
                        live_text_only,
                        theme_sig,
                        &tokens,
                    )
                },
            );
        col()
            .key("pptx-thumb-strip")
            .w(156.0)
            .h_full()
            .shrink()
            .min_h(0.0)
            .fill(t.sidebar_bg)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(rows_stack)
    };

    let stage_visual = decode_slide_visual(s, &active_slide.png_base64, 900.0, text_only_deck);
    let stage_ratio = visual_aspect_ratio(&stage_visual);
    let stage_est_w = (est_width - if compact { 0.0 } else { 156.0 } - 28.0).clamp(260.0, 960.0);

    let stage_card = el()
        .key("pptx-slide-stage")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .padding(14.0)
        .fill(if t.dark { t.app_bg } else { t.sidebar_bg })
        .center()
        .child(
            el().aspect_fit(stage_ratio)
                .child(render_slide_frame_with_visual(
                    &stage_visual,
                    Some("pptx-active-slide-image"),
                    stage_est_w,
                    false,
                    t,
                )),
        );

    let prev_btn = el().key("pptx-prev-btn").child(
        IconButton::new(&ICON_CHEVRON_LEFT)
            .label("Previous slide")
            .help("Previous slide")
            .control_size(ControlSize::Small)
            .variant(IconButtonVariant::Ghost)
            .disabled(active_idx == 0)
            .on_press(|s: &mut AppState| {
                s.preview_ui.prev_slide();
            })
            .build(k),
    );
    let next_btn = el().key("pptx-next-btn").child(
        IconButton::new(&chat_icons::CHEVRON_RIGHT)
            .label("Next slide")
            .help("Next slide")
            .control_size(ControlSize::Small)
            .variant(IconButtonVariant::Ghost)
            .disabled(active_idx + 1 >= total)
            .on_press(move |s: &mut AppState| {
                s.preview_ui.next_slide(total);
            })
            .build(k),
    );

    let nav_bar = row()
        .key("pptx-nav-bar")
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(8.0)
        .center_y()
        .child(
            text(slide_display_title(active_slide, active_idx))
                .font(t.caption)
                .color(t.text_muted)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(
            row()
                .gap(6.0)
                .center_y()
                .child(prev_btn)
                .child(
                    el().key("pptx-slide-counter").min_w(44.0).center().child(
                        text(format!("{} / {}", active_idx + 1, total))
                            .font(t.caption)
                            .color(t.text_muted),
                    ),
                )
                .child(next_btn),
        );

    let main_pane = col()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .min_h(0.0)
        .h_full()
        .child(stage_card)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(nav_bar);

    if compact {
        col()
            .w_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
            .child(main_pane)
            .child(el().w_full().h(1.0).fill(t.border_muted))
            .child(thumb_items)
    } else {
        row()
            .w_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
            .child(thumb_items)
            .child(el().w(1.0).h_full().fill(t.border_muted))
            .child(main_pane)
    }
}

#[allow(clippy::too_many_arguments)]
fn build_memoized_grid_card(
    s: &AppState,
    slide: &PresentationSlideData,
    idx: usize,
    total: usize,
    active: bool,
    card_w: f32,
    ready_gen: u64,
    text_only_deck: bool,
    theme_sig: u64,
    t: &ThemeTokens,
) -> El {
    let mut h = DefaultHasher::new();
    (
        idx,
        total,
        active,
        (card_w / 16.0).round() as i32,
        ready_gen,
        text_only_deck,
    )
        .hash(&mut h);
    (
        theme_sig,
        s.services.waker.is_some(),
        slide.slide_index,
        slide.slide_id.as_deref(),
        slide.title.as_deref(),
        uri_fingerprint(&slide.png_base64),
    )
        .hash(&mut h);
    let key = format!("pptx-grid-card-{idx}");
    memo(key.as_str(), h.finish(), || {
        let border_col = if active { t.accent } else { t.border_muted };
        let bg_col = if active {
            t.accent.alpha(if t.dark { 0.14 } else { 0.06 })
        } else {
            t.sidebar_bg
        };

        let img_box = el()
            .w_full()
            .h(128.0)
            .center()
            .child(render_slide_canvas_frame(
                s,
                slide,
                320.0,
                (card_w, 128.0),
                false,
                text_only_deck,
                t,
            ))
            .child(slide_number_pill(idx, 5.0, 2.0, 6.0, t));

        col()
            .grow(1.0)
            .shrink()
            .min_w(0.0)
            .gap(6.0)
            .padding(8.0)
            .radius(8.0)
            .border(if active { 1.5 } else { 1.0 }, border_col)
            .fill(bg_col)
            .cursor(Cursor::Pointer)
            .on_press(move |s: &mut AppState| {
                s.preview_ui.select_slide(idx, total);
                s.preview_ui
                    .set_presentation_layout(PresentationLayoutMode::Deck);
            })
            .child(img_box)
            .child(
                text(slide_display_title(slide, idx))
                    .font(t.caption)
                    .color(if active { t.text_base } else { t.text_muted })
                    .truncate()
                    .w_full(),
            )
    })
}

fn build_grid_view(
    slides: &[PresentationSlideData],
    est_width: f32,
    theme_sig: u64,
    t: &ThemeTokens,
) -> El {
    let total = slides.len();
    let cols = grid_cols_for_width(est_width);
    let row_count = total.div_ceil(cols);
    let card_w = ((est_width - 24.0 - 12.0 * (cols as f32 - 1.0)) / cols as f32 - 16.0).max(160.0);
    let tokens = *t;

    let grid_rows = col()
        .key("pptx-grid-rows")
        .w_full()
        .padding(12.0)
        .gap(12.0)
        .growth(GrowthSpec::default())
        .virtual_rows(
            row_count,
            174.0,
            |_: &AppState, row_idx| Cow::Owned(format!("pptx-grid-row-{row_idx}")),
            move |s: &AppState, row_idx| {
                let Some(pres) = s
                    .active_file_preview
                    .as_ref()
                    .and_then(|p| p.presentation.as_deref())
                else {
                    return row()
                        .key(format!("pptx-grid-row-{row_idx}"))
                        .w_full()
                        .gap(12.0);
                };
                let slides = pres.slides.as_slice();
                let live_total = slides.len();
                let live_active = s.preview_ui.active_slide.min(live_total.saturating_sub(1));
                let live_text_only = is_text_only_rendering_mode(pres.rendering_mode.as_deref());
                let live_ready_gen = current_slide_ready_gen();
                let start = row_idx * cols;
                let end = (start + cols).min(slides.len());
                let row_slice = slides.get(start..end).unwrap_or(&[]);
                let mut grid_row = row()
                    .key(format!("pptx-grid-row-{row_idx}"))
                    .w_full()
                    .gap(12.0);
                for (offset, slide) in row_slice.iter().enumerate() {
                    let idx = start + offset;
                    grid_row = grid_row.child(build_memoized_grid_card(
                        s,
                        slide,
                        idx,
                        live_total,
                        idx == live_active,
                        card_w,
                        live_ready_gen,
                        live_text_only,
                        theme_sig,
                        &tokens,
                    ));
                }
                for _ in row_slice.len()..cols {
                    grid_row = grid_row.child(el().grow(1.0).shrink().min_w(0.0));
                }
                grid_row
            },
        );

    col()
        .key("pptx-grid-scroll")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(grid_rows)
}
