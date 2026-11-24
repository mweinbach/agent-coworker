//! Shared layout primitives ported from `apps/desktop/src/ui/settings/SettingsPrimitives.tsx`.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use base64::Engine;
use rune::{Color, El, Icon, ImageCache, Pixels, TextEdit, Tx, col, el, icon, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Dialog, Kit, SegmentedControl, Switch, TextInput,
};

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, DesktopSettings};
use crate::theme::{self, ThemeTokens};
use crate::views::settings::icons;

/// Maximum inner width matching Settings content column layout.
const SETTINGS_PAGE_MAX_WIDTH: f32 = 1040.0;

/// Centered vertical settings container (`gap: 20pt`, `max_w: 1040pt`).
pub fn settings_page(children: Vec<El>) -> El {
    col().w_full().items_center().child(
        col()
            .w_full()
            .max_w(SETTINGS_PAGE_MAX_WIDTH)
            .gap(20.0)
            .children(children),
    )
}

/// Builder for a titled card section with hairline row dividers.
pub struct Section {
    title: Option<String>,
    description: Option<String>,
    action: Option<El>,
    rows: Vec<El>,
}

impl Default for Section {
    fn default() -> Self {
        Self::new()
    }
}

impl Section {
    /// Creates an empty `Section` builder.
    pub fn new() -> Self {
        Self {
            title: None,
            description: None,
            action: None,
            rows: Vec::new(),
        }
    }

    /// Sets the section heading.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Sets secondary guidance text under the heading.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets an optional trailing header control (e.g., Add button).
    pub fn action(mut self, action: El) -> Self {
        self.action = Some(action);
        self
    }

    /// Appends a single row/item inside the rounded section card.
    pub fn child(mut self, row_el: El) -> Self {
        self.rows.push(row_el);
        self
    }

    /// Appends multiple rows/items inside the rounded section card.
    pub fn children(mut self, items: impl IntoIterator<Item = El>) -> Self {
        self.rows.extend(items);
        self
    }

    /// Builds the `SettingsSection` container with 1px row hairlines.
    pub fn build(self, k: &Kit, t: &ThemeTokens) -> El {
        let mut children = Vec::new();
        if self.title.is_some() || self.description.is_some() || self.action.is_some() {
            let mut title_col = col().grow(1.0).min_w(0.0).gap(2.0);
            if let Some(title) = self.title {
                title_col =
                    title_col.child(text(title).font(k.ty.ui_medium).color(t.text_base).wrap());
            }
            if let Some(desc) = self.description {
                title_col = title_col.child(
                    text(desc)
                        .font(k.ty.small)
                        .color(t.text_muted)
                        .max_w(560.0)
                        .wrap(),
                );
            }
            let mut header = row()
                .w_full()
                .justify_between()
                .items_end()
                .gap(12.0)
                .child(title_col);
            if let Some(action) = self.action {
                header = header.child(row().shrink().items_center().gap(8.0).child(action));
            }
            children.push(header);
        }

        let mut card_children = Vec::with_capacity(self.rows.len());
        for (idx, item) in self.rows.into_iter().enumerate() {
            let styled = if idx > 0 {
                item.border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
            } else {
                item
            };
            card_children.push(styled);
        }

        let card = col()
            .w_full()
            .min_w(0.0)
            .radius(k.radius.lg)
            .clip_rounded(k.radius.lg)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .children(card_children);

        children.push(card);
        col().w_full().gap(10.0).children(children)
    }
}

/// Builder for a single horizontal setting row inside a `Section`.
pub struct SettingsRow {
    title: String,
    description: Option<String>,
    meta: Option<String>,
    control: Option<El>,
    body: Option<El>,
    danger: bool,
    leading: Option<El>,
}

impl SettingsRow {
    /// Creates a `SettingsRow` with a required title.
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            description: None,
            meta: None,
            control: None,
            body: None,
            danger: false,
            leading: None,
        }
    }

    /// Sets secondary helper text under the row title.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets secondary metadata under the description.
    pub fn meta(mut self, meta: impl Into<String>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// Sets an optional leading icon or avatar before the title stack.
    pub fn leading(mut self, leading: El) -> Self {
        self.leading = Some(leading);
        self
    }

    /// Sets the right-aligned control slot (Switch, Button, Select, Pill, etc.).
    pub fn control(mut self, control: El) -> Self {
        self.control = Some(control);
        self
    }

    /// Sets nested body content rendered under the title/description stack.
    pub fn body(mut self, body: El) -> Self {
        self.body = Some(body);
        self
    }

    /// Styles the row with destructive tint and danger title color.
    pub fn danger(mut self, danger: bool) -> Self {
        self.danger = danger;
        self
    }

    /// Builds the `SettingsRow` element.
    pub fn build(self, k: &Kit, t: &ThemeTokens) -> El {
        let mut text_col = col().grow(1.0).min_w(0.0).gap(3.0);
        text_col = text_col.child(
            text(self.title)
                .font(k.ty.ui_medium)
                .color(if self.danger { t.danger } else { t.text_base })
                .wrap(),
        );
        if let Some(desc) = self.description {
            text_col = text_col.child(
                text(desc)
                    .font(k.ty.small)
                    .color(t.text_muted)
                    .max_w(580.0)
                    .wrap(),
            );
        }
        if let Some(meta) = self.meta {
            text_col = text_col.child(
                text(meta)
                    .pt(2.0)
                    .font(k.ty.small)
                    .color(t.text_faint)
                    .wrap(),
            );
        }
        if let Some(body) = self.body {
            text_col = text_col.child(el().pt(6.0).w_full().min_w(0.0).child(body));
        }

        let mut line = row().w_full().min_w(0.0).items_center().gap(12.0);
        if let Some(leading) = self.leading {
            line = line.child(el().shrink().child(leading));
        }
        line = line.child(text_col);
        if let Some(control) = self.control {
            line = line.child(row().shrink().items_center().gap(8.0).child(control));
        }

        let mut wrapper = el()
            .w_full()
            .min_w(0.0)
            .px(16.0)
            .py(13.0)
            .hover(t.hover)
            .child(line);

        if self.danger {
            wrapper = wrapper.fill(k.alpha(t.danger, 0.08));
        }

        wrapper
    }
}

/// Builder for a centered empty-state placeholder inside a section card.
pub struct EmptyState {
    icon_glyph: Option<&'static Icon>,
    title: String,
    description: Option<String>,
    action: Option<El>,
}

impl EmptyState {
    /// Creates an empty state placeholder.
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            icon_glyph: None,
            title: title.into(),
            description: None,
            action: None,
        }
    }

    /// Sets the centered 32pt icon above the title.
    pub fn icon(mut self, glyph: &'static Icon) -> Self {
        self.icon_glyph = Some(glyph);
        self
    }

    /// Sets secondary descriptive copy.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets a primary action button below the text.
    pub fn action(mut self, action: El) -> Self {
        self.action = Some(action);
        self
    }

    /// Builds the centered empty state element.
    pub fn build(self, k: &Kit, t: &ThemeTokens) -> El {
        let mut stack = col()
            .w_full()
            .min_h(160.0)
            .px(24.0)
            .py(32.0)
            .items_center()
            .justify_center()
            .gap(12.0);

        if let Some(glyph) = self.icon_glyph {
            stack = stack.child(
                el().size(40.0, 40.0)
                    .radius(10.0)
                    .fill(k.c.layer_02)
                    .border(1.0, t.border_muted)
                    .center()
                    .child(icon(glyph, 18.0).color(t.text_muted)),
            );
        }

        let mut copy = col().items_center().gap(4.0);
        copy = copy.child(
            text(self.title)
                .font(k.ty.ui_medium)
                .color(t.text_base)
                .center(),
        );
        if let Some(desc) = self.description {
            copy = copy.child(
                text(desc)
                    .font(k.ty.small)
                    .color(t.text_muted)
                    .max_w(420.0)
                    .wrap()
                    .center(),
            );
        }
        stack = stack.child(copy);

        if let Some(action) = self.action {
            stack = stack.child(el().pt(4.0).child(action));
        }
        stack
    }
}

/// Compact summary stat tile used on Usage, Providers, and Backups pages.
pub fn stat_tile(
    label: impl Into<String>,
    value: impl Into<String>,
    hint: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let mut tile = col()
        .grow(1.0)
        .min_w(0.0)
        .radius(k.radius.lg)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .px(16.0)
        .py(12.0)
        .gap(4.0)
        .child(
            text(label.into())
                .font(k.ty.small_medium)
                .color(t.text_muted),
        )
        .child(text(value.into()).font(t.title).color(t.text_base));

    if let Some(hint_text) = hint {
        tile = tile.child(text(hint_text).font(k.ty.small).color(t.text_muted));
    }
    tile
}

/// Semantic tone for `status_pill`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusTone {
    Neutral,
    Success,
    Warning,
    Danger,
}

/// Compact outlined status pill matching `views::chat::components::status_pill`.
pub fn status_pill(label: impl Into<String>, tone: StatusTone, k: &Kit, t: &ThemeTokens) -> El {
    let (bg, border, fg) = match tone {
        StatusTone::Success => (
            k.alpha(t.success, 0.14),
            k.alpha(t.success, 0.35),
            t.success,
        ),
        StatusTone::Warning => (
            k.alpha(t.warning, 0.14),
            k.alpha(t.warning, 0.35),
            t.warning,
        ),
        StatusTone::Danger => (k.alpha(t.danger, 0.14), k.alpha(t.danger, 0.35), t.danger),
        // A wash and a real hairline rather than an elevated fill, so the neutral pill keeps its
        // outline on white cards as well as on the page.
        StatusTone::Neutral => (t.hover, t.border, t.text_muted),
    };
    row()
        .px(8.0)
        .py(2.0)
        .radius(theme::layout::RADIUS_PILL)
        .fill(bg)
        .border(1.0, border)
        .center_y()
        .shrink()
        .child(text(label.into()).font(k.ty.small_medium).color(fg))
}

/// Informational or warning callout banner matching `Settings` inline alerts.
pub fn callout_banner(
    tone: StatusTone,
    message: impl Into<String>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let (bg, border, icon_glyph, icon_color) = match tone {
        StatusTone::Danger => (
            k.alpha(t.danger, 0.08),
            k.alpha(t.danger, 0.28),
            &icons::ALERT_TRIANGLE,
            t.danger,
        ),
        StatusTone::Warning => (
            k.alpha(t.warning, 0.10),
            k.alpha(t.warning, 0.32),
            &icons::ALERT_TRIANGLE,
            t.warning,
        ),
        StatusTone::Success => (
            k.alpha(t.success, 0.08),
            k.alpha(t.success, 0.28),
            &icons::CHECK_CIRCLE,
            t.success,
        ),
        StatusTone::Neutral => (
            k.alpha(t.elevated_bg, 0.55),
            t.border_muted,
            &icons::INFO,
            t.text_muted,
        ),
    };
    row()
        .w_full()
        .radius(k.radius.lg)
        .fill(bg)
        .border(1.0, border)
        .px(14.0)
        .py(10.0)
        .gap(10.0)
        .items_center()
        .child(icon(icon_glyph, 16.0).color(icon_color))
        .child(
            text(message.into())
                .grow(1.0)
                .min_w(0.0)
                .font(k.ty.small)
                .color(t.text_base)
                .wrap(),
        )
}

/// Renders an inline spinner/error notice if `s.operations_by_key` tracks `op_key`.
pub fn operation_banner(s: &AppState, op_key: &str, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let op = s.operations_by_key.get(op_key)?;
    if let Some(err) = op.error.as_deref().filter(|msg| !msg.trim().is_empty()) {
        return Some(callout_banner(StatusTone::Danger, err, k, t));
    }
    if op.busy {
        return Some(callout_banner(StatusTone::Neutral, op.label.clone(), k, t));
    }
    None
}

/// Size preset for `entity_icon`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityIconSize {
    Sm,
    Md,
    Lg,
}

impl EntityIconSize {
    const fn points(self) -> f32 {
        match self {
            EntityIconSize::Sm => 24.0,
            EntityIconSize::Md => 32.0,
            EntityIconSize::Lg => 40.0,
        }
    }
}

/// Computes deterministic palette index (`0..5`) matching Electron `entityIconPaletteClass`.
pub fn entity_palette_index(seed: &str) -> usize {
    let mut hash: i32 = 0;
    for unit in seed.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    (hash.wrapping_abs() as usize) % 5
}

/// Derives up to two uppercase initials from a provider/plugin/skill/MCP name.
pub fn name_initials(name: &str) -> String {
    let initials: String = name
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_' || c == '/')
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| part.chars().next())
        .map(|ch| ch.to_ascii_uppercase())
        .collect();
    if initials.is_empty() {
        "?".to_string()
    } else {
        initials
    }
}

const MAX_ENTITY_DECODED_CACHE: usize = 256;
const MAX_ENTITY_PIXELS_CACHE: usize = 256;
const MAX_TIMESTAMP_CACHE: usize = 512;

type DecodedEntityPayload = Arc<(String, Arc<[u8]>)>;
type DecodedEntityCache = HashMap<(u64, usize), Option<DecodedEntityPayload>>;

#[derive(Default)]
struct EntityImageCacheState {
    cache: Option<ImageCache>,
    has_real_waker: bool,
    decoded_data: DecodedEntityCache,
    remote_arcs: HashMap<(u64, u64, usize), Arc<[u8]>>,
    pixels: HashMap<(u64, usize, u32), Pixels>,
}

thread_local! {
    static ENTITY_IMAGE_CACHE: RefCell<EntityImageCacheState> =
        RefCell::new(EntityImageCacheState::default());
    static TIMESTAMP_FORMAT_CACHE: RefCell<HashMap<(i64, i32), String>> =
        RefCell::new(HashMap::new());
}

fn fast_bytes_hash(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.len().hash(&mut h);
    if bytes.len() <= 4096 {
        bytes.hash(&mut h);
    } else {
        bytes[..512].hash(&mut h);
        let mid = bytes.len() / 2;
        bytes[mid.saturating_sub(128)..(mid + 128).min(bytes.len())].hash(&mut h);
        bytes[bytes.len() - 512..].hash(&mut h);
    }
    h.finish()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
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

fn ensure_entity_image_cache<'a>(
    state: &'a mut EntityImageCacheState,
    s: &AppState,
) -> &'a mut ImageCache {
    if !state.has_real_waker
        && let Some(waker) = s.services.waker.clone()
    {
        state.cache = Some(ImageCache::new(waker));
        state.has_real_waker = true;
        state.pixels.clear();
    }
    state.cache.get_or_insert_with(|| {
        let waker = s.services.waker.clone().unwrap_or_else(|| Arc::new(|| {}));
        ImageCache::new(waker)
    })
}

fn decode_data_image(s: &AppState, src: &str, size_pt: f32) -> Option<Pixels> {
    let key = (fast_bytes_hash(src.as_bytes()), src.len());
    let px_key = (key.0, key.1, size_pt.to_bits());
    let sync_wait = s.services.waker.is_none();

    ENTITY_IMAGE_CACHE.with(|slot| {
        let mut state = slot.borrow_mut();
        let _ = ensure_entity_image_cache(&mut state, s);

        if let Some(px) = state.pixels.get(&px_key) {
            return Some(px.clone());
        }

        let decoded = if let Some(cached) = state.decoded_data.get(&key) {
            cached.clone()
        } else {
            let parsed = (|| {
                let payload = src
                    .get(..5)
                    .filter(|prefix| prefix.eq_ignore_ascii_case("data:"))
                    .and_then(|_| src.get(5..))?;
                let (meta, raw) = payload.split_once(',')?;
                let mime = meta.split(';').next().unwrap_or("image/png").trim();
                let is_base64 = meta
                    .split(';')
                    .skip(1)
                    .any(|p| p.trim().eq_ignore_ascii_case("base64"));
                let bytes = if is_base64 {
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
                Some(Arc::new((mime.to_string(), Arc::<[u8]>::from(bytes))))
            })();
            if state.decoded_data.len() >= MAX_ENTITY_DECODED_CACHE {
                state.decoded_data.clear();
            }
            state.decoded_data.insert(key, parsed.clone());
            parsed
        }?;

        let cache = ensure_entity_image_cache(&mut state, s);
        let img = cache.load_mime(Arc::clone(&decoded.1), &decoded.0, size_pt, 2.0);
        if sync_wait && !img.is_ready() {
            let _ = img.wait();
        }
        if img.error().is_some() || !img.is_ready() {
            return None;
        }
        let px = img.pixels().clone();
        if state.pixels.len() >= MAX_ENTITY_PIXELS_CACHE {
            state.pixels.clear();
        }
        state.pixels.insert(px_key, px.clone());
        Some(px)
    })
}

fn lookup_cached_remote_image(s: &AppState, url: &str, size_pt: f32) -> Option<Pixels> {
    let (mime, bytes) = s.image_bytes_by_request.get(url)?;
    let mime = mime.as_deref().unwrap_or("image/png");
    let url_hash = fast_bytes_hash(url.as_bytes());
    let bytes_hash = fast_bytes_hash(bytes.as_slice());
    let combined_hash = url_hash ^ bytes_hash.rotate_left(17);
    let px_key = (combined_hash, bytes.len(), size_pt.to_bits());
    let arc_key = (url_hash, bytes_hash, bytes.len());
    let sync_wait = s.services.waker.is_none();

    ENTITY_IMAGE_CACHE.with(|slot| {
        let mut state = slot.borrow_mut();
        let _ = ensure_entity_image_cache(&mut state, s);

        if let Some(px) = state.pixels.get(&px_key) {
            return Some(px.clone());
        }

        let arc_bytes = if let Some(cached) = state.remote_arcs.get(&arc_key) {
            Arc::clone(cached)
        } else {
            if state.remote_arcs.len() >= MAX_ENTITY_DECODED_CACHE {
                state.remote_arcs.clear();
            }
            let shared = Arc::<[u8]>::from(bytes.as_slice());
            state.remote_arcs.insert(arc_key, Arc::clone(&shared));
            shared
        };

        let cache = ensure_entity_image_cache(&mut state, s);
        let img = cache.load_mime(arc_bytes, mime, size_pt, 2.0);
        if sync_wait && !img.is_ready() {
            let _ = img.wait();
        }
        if img.error().is_some() || !img.is_ready() {
            return None;
        }
        let px = img.pixels().clone();
        if state.pixels.len() >= MAX_ENTITY_PIXELS_CACHE {
            state.pixels.clear();
        }
        state.pixels.insert(px_key, px.clone());
        Some(px)
    })
}

/// Icon badge for providers, plugins, skills, and MCP servers: decodes `data:`
/// URIs or fetched remote image bytes when available, renders short emoji glyphs
/// directly, and otherwise draws a hash-tinted initials avatar.
pub fn entity_icon(
    s: &AppState,
    src: Option<&str>,
    name: &str,
    size: EntityIconSize,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let dim = size.points();
    let trimmed = src.map(str::trim).unwrap_or("");
    if trimmed
        .get(..11)
        .is_some_and(|p| p.eq_ignore_ascii_case("data:image/"))
        && let Some(px) = decode_data_image(s, trimmed, dim)
    {
        return el()
            .size(dim, dim)
            .radius(k.radius.md)
            .clip_rounded(k.radius.md)
            .fill(t.panel_bg)
            .border(1.0, t.border_muted)
            .pixels(&px)
            .shrink();
    }
    if (trimmed
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://"))
        || trimmed
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://")))
        && let Some(px) = lookup_cached_remote_image(s, trimmed, dim)
    {
        return el()
            .size(dim, dim)
            .radius(k.radius.md)
            .clip_rounded(k.radius.md)
            .fill(t.panel_bg)
            .border(1.0, t.border_muted)
            .pixels(&px)
            .shrink();
    }

    let char_count = trimmed.chars().count();
    if !trimmed.is_empty() && !trimmed.contains("://") && char_count <= 3 {
        let emoji_style = match size {
            EntityIconSize::Lg => t.title,
            _ => t.body_lg,
        };
        return el()
            .size(dim, dim)
            .radius(k.radius.md)
            .center()
            .shrink()
            .child(text(trimmed).font(emoji_style).color(t.text_base));
    }

    let (bg, border, fg): (Color, Color, Color) = match entity_palette_index(name) {
        0 => (k.c.layer_02, t.border_muted, t.text_muted),
        1 => (k.alpha(t.accent, 0.12), k.alpha(t.accent, 0.25), t.accent),
        2 => (k.alpha(t.info, 0.12), k.alpha(t.info, 0.25), t.info),
        3 => (
            k.alpha(t.warning, 0.12),
            k.alpha(t.warning, 0.26),
            t.warning,
        ),
        _ => (
            k.alpha(t.search_badges[0], 0.12),
            k.alpha(t.search_badges[0], 0.25),
            t.search_badges[0],
        ),
    };
    let font = match size {
        EntityIconSize::Lg => k.ty.ui_medium,
        _ => k.ty.small_medium,
    };

    el().size(dim, dim)
        .radius(k.radius.md)
        .fill(bg)
        .border(1.0, border)
        .center()
        .shrink()
        .child(text(name_initials(name)).font(font).color(fg))
}

/// Normalized workspace management target with `one_off_chat` folders collapsed
/// into a single `Chats` bucket matching Electron's settings scope rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagementTarget {
    pub id: String,
    pub label: String,
    pub path: String,
    pub is_chats: bool,
}

/// Returns active management targets sorted with non-archived folders, collapsing
/// all non-archived `one_off_chat` workspaces into a single `"Chats"` target.
pub fn management_targets(s: &AppState) -> Vec<ManagementTarget> {
    let mut targets = Vec::new();
    let mut chats_target: Option<ManagementTarget> = None;

    for ws in &s.workspaces {
        if ws.archived {
            continue;
        }
        if ws.one_off_chat {
            if chats_target.is_none() {
                chats_target = Some(ManagementTarget {
                    id: ws.id.clone(),
                    label: "Chats".to_string(),
                    path: ws.path.clone(),
                    is_chats: true,
                });
            }
            continue;
        }
        targets.push(ManagementTarget {
            id: ws.id.clone(),
            label: if ws.name.trim().is_empty() {
                ws.path.clone()
            } else {
                ws.name.clone()
            },
            path: ws.path.clone(),
            is_chats: false,
        });
    }

    if let Some(chats) = chats_target {
        targets.push(chats);
    }
    targets
}

/// Matches a workspace ID to its display [`ManagementTarget`], mapping any
/// non-archived standalone (`one_off_chat`) workspace onto the grouped
/// `"Chats"` target instead of falling back to an unrelated project.
pub fn match_management_target<'a>(
    s: &AppState,
    targets: &'a [ManagementTarget],
    workspace_id: &str,
) -> Option<&'a ManagementTarget> {
    if let Some(target) = targets.iter().find(|entry| entry.id == workspace_id) {
        return Some(target);
    }
    if s.workspaces
        .iter()
        .any(|ws| ws.id == workspace_id && !ws.archived && ws.one_off_chat)
    {
        return targets.iter().find(|entry| entry.is_chats);
    }
    None
}

/// Resolves an optional workspace ID to its display [`ManagementTarget`],
/// resolving any standalone (`one_off_chat`) workspace to the grouped
/// `"Chats"` target before falling back to the first available target.
pub fn find_management_target<'a>(
    s: &AppState,
    targets: &'a [ManagementTarget],
    workspace_id: Option<&str>,
) -> Option<&'a ManagementTarget> {
    workspace_id
        .and_then(|id| match_management_target(s, targets, id))
        .or_else(|| targets.first())
}

/// Label of the active workspace shown in the settings nav header when
/// `per_workspace_settings` is enabled.
pub fn active_workspace_banner_label(s: &AppState) -> Option<String> {
    if !s.desktop_settings.per_workspace_settings {
        return None;
    }
    let active_id = s.active_workspace_id.as_deref()?;
    let ws = s.workspaces.iter().find(|w| w.id == active_id)?;
    if ws.one_off_chat {
        Some("Chats".to_string())
    } else if ws.name.trim().is_empty() {
        Some(ws.path.clone())
    } else {
        Some(ws.name.clone())
    }
}

/// Applies a mutation to a cloned `DesktopSettings` and dispatches
/// `SettingsAction::UpdateDesktopSettings`.
pub fn update_desktop_settings(s: &mut AppState, mutate: impl FnOnce(&mut DesktopSettings)) {
    let mut next = s.desktop_settings.clone();
    mutate(&mut next);
    s.dispatch(Action::Settings(SettingsAction::UpdateDesktopSettings(
        next,
    )));
}

/// Configuration for a confirmation modal rendered via `rune_kit::Dialog`.
pub struct ConfirmDialogSpec {
    pub key: &'static str,
    pub open: bool,
    pub title: &'static str,
    pub description: String,
    pub confirm_label: &'static str,
    pub danger: bool,
}

/// Mounts a modal confirmation dialog into `overlays` when `spec.open` is true.
pub fn confirm_dialog(
    spec: ConfirmDialogSpec,
    on_cancel: impl Fn(&mut AppState) + 'static,
    on_confirm: impl Fn(&mut AppState) + 'static,
    k: &Kit,
    overlays: &mut Vec<El>,
) {
    if !spec.open {
        return;
    }
    let cancel_cb = Rc::new(on_cancel);
    let cancel_for_btn = cancel_cb.clone();
    let confirm_cb = Rc::new(on_confirm);

    let footer = row()
        .w_full()
        .justify_end()
        .gap(8.0)
        .pt(8.0)
        .child(
            Button::new("Cancel")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    cancel_for_btn(s);
                })
                .build(k),
        )
        .child(
            Button::new(spec.confirm_label)
                .variant(if spec.danger {
                    ButtonVariant::Danger
                } else {
                    ButtonVariant::Contrast
                })
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    confirm_cb(s);
                })
                .build(k)
                .key(format!("{}-confirm", spec.key)),
        );

    Dialog::new(spec.key, spec.title)
        .open(spec.open)
        .width(440.0)
        .fit()
        .on_close(move |s: &mut AppState| {
            cancel_cb(s);
        })
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(
                    text(spec.description)
                        .font(k.ty.ui)
                        .color(k.c.text_muted)
                        .wrap(),
                )
                .child(footer),
        )
        .build(k, overlays);
}

/// Shared Settings search input with consistent search icon, clear button, and sizing.
pub fn search_input(
    edit: &TextEdit,
    label: impl Into<String>,
    placeholder: impl Into<String>,
    width: Option<f32>,
    on_edit: impl Fn(&mut AppState) -> &mut TextEdit + 'static,
    on_clear: impl Fn(&mut AppState, &mut Tx) + 'static,
    k: &Kit,
) -> El {
    let input = TextInput::new(edit)
        .label(label.into())
        .placeholder(placeholder.into())
        .leading_icon(&icons::SEARCH)
        .clear_button()
        .width(None)
        .on_edit(on_edit)
        .on_action(on_clear)
        .build(k);

    match width {
        Some(max_width) => el()
            .grow(1.0)
            .min_w(max_width.min(160.0))
            .max_w(max_width)
            .child(input),
        None => input,
    }
}

/// Shared compact toggle switch matching all boolean Settings controls.
pub fn mini_switch(
    checked: bool,
    label: impl Into<String>,
    disabled: bool,
    on_toggle: impl Fn(&mut AppState) + 'static,
    k: &Kit,
) -> El {
    Switch::new(checked)
        .label(label.into())
        .hide_label()
        .control_size(ControlSize::Mini)
        .disabled(disabled)
        .on_toggle(on_toggle)
        .build(k)
}

/// Wraps a `SegmentedControl` in a shrink-wrapped row so column stretch cannot distort it.
pub fn compact_tabs(
    labels: &[&str],
    active: usize,
    a11y_label: &'static str,
    on_pick: impl Fn(&mut AppState, usize, &mut Tx) + 'static,
    k: &Kit,
) -> El {
    let cb = Rc::new(on_pick);
    row().w_full().child(
        SegmentedControl::new(labels, Some(active))
            .label(a11y_label)
            .fit()
            .on_pick(move |s: &mut AppState, idx, tx| cb(s, idx, tx))
            .build(k),
    )
}

/// Formats a byte count into human-friendly units (`B`, `KB`, `MB`, `GB`).
pub fn format_byte_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Zero-allocation ASCII case-insensitive substring check matching
/// `haystack.to_ascii_lowercase().contains(needle_lower)` where `needle_lower`
/// is already ASCII-lowercased.
#[inline]
pub(crate) fn contains_ascii_ci(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    let hb = haystack.as_bytes();
    let nb = needle_lower.as_bytes();
    if nb.len() > hb.len() {
        return false;
    }
    let first = nb[0];
    let first_upper = first.to_ascii_uppercase();
    let limit = hb.len() - nb.len();
    let mut i = 0;
    while i <= limit {
        let b = hb[i];
        if (b == first || b == first_upper) && hb[i..i + nb.len()].eq_ignore_ascii_case(nb) {
            return true;
        }
        i += 1;
    }
    false
}

/// Zero-allocation ASCII case-insensitive lexicographical comparison for sort comparators.
#[inline]
pub(crate) fn cmp_ascii_ci(a: &str, b: &str) -> Ordering {
    for (&ab, &bb) in a.as_bytes().iter().zip(b.as_bytes().iter()) {
        let ord = ab.to_ascii_lowercase().cmp(&bb.to_ascii_lowercase());
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

/// Stable hash of visual theme tokens + scale for `rune::memo` keys in Settings views.
pub(crate) fn theme_memo_sig(s: &AppState, t: &ThemeTokens) -> u64 {
    let mut h = DefaultHasher::new();
    (
        t.dark,
        t.accent.r.to_bits(),
        t.accent.g.to_bits(),
        t.accent.b.to_bits(),
        t.panel_bg.r.to_bits(),
        t.card_bg.r.to_bits(),
        t.border_muted.a.to_bits(),
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        s.ui_scale.to_bits(),
    )
        .hash(&mut h);
    h.finish()
}

/// Formats a Unix timestamp in seconds or milliseconds into local `YYYY-MM-DD HH:MM`.
///
/// Results are cached per minute bucket in thread-local storage to avoid repeated
/// `chrono::Local` conversions across table/list rows every frame.
pub fn format_timestamp_friendly(ts: i64) -> String {
    if ts <= 0 {
        return "—".to_string();
    }
    let secs = if ts > 1_000_000_000_000 {
        ts / 1000
    } else {
        ts
    };
    let minute_bucket = secs.div_euclid(60);
    let tz_offset_secs = chrono::Local::now().offset().local_minus_utc();
    let cache_key = (minute_bucket, tz_offset_secs);
    TIMESTAMP_FORMAT_CACHE.with(|slot| {
        let mut cache = slot.borrow_mut();
        if let Some(existing) = cache.get(&cache_key) {
            return existing.clone();
        }
        let formatted = match chrono::DateTime::from_timestamp(minute_bucket * 60, 0) {
            Some(utc) => utc
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string(),
            None => return "—".to_string(),
        };
        if cache.len() >= MAX_TIMESTAMP_CACHE {
            cache.clear();
        }
        cache.insert(cache_key, formatted.clone());
        formatted
    })
}
