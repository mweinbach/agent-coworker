//! Shared layout primitives ported from `apps/desktop/src/ui/settings/SettingsPrimitives.tsx`.

use std::cell::RefCell;
use std::sync::Arc;

use base64::Engine;
use rune::{Color, El, Icon, ImageCache, Pixels, col, el, icon, row, text};
use rune_kit::Kit;

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, DesktopSettings};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;

/// Maximum inner width matching `.settings-page { max-width: 1160px }`.
const SETTINGS_PAGE_MAX_WIDTH: f32 = 1160.0;

/// Centered vertical settings container (`gap: 20pt`, `max_w: 1160pt`).
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
                    title_col.child(text(title).font(k.ty.body_medium).color(t.text_base).wrap());
            }
            if let Some(desc) = self.description {
                title_col = title_col.child(
                    text(desc)
                        .font(k.ty.text_xsmall)
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
            .radius(12.0)
            .clip_rounded(12.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .children(card_children);

        children.push(card);
        col().w_full().gap(12.0).children(children)
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
        let mut text_col = col().grow(1.0).min_w(0.0).gap(4.0);
        text_col = text_col.child(
            text(self.title)
                .font(k.ty.body_medium)
                .color(if self.danger { t.danger } else { t.text_base })
                .wrap(),
        );
        if let Some(desc) = self.description {
            text_col = text_col.child(
                text(desc)
                    .font(k.ty.text_xsmall)
                    .color(t.text_muted)
                    .max_w(580.0)
                    .wrap(),
            );
        }
        if let Some(meta) = self.meta {
            text_col = text_col.child(
                text(meta)
                    .pt(2.0)
                    .font(k.ty.text_xsmall)
                    .color(t.text_faint)
                    .wrap(),
            );
        }
        if let Some(body) = self.body {
            text_col = text_col.child(el().pt(6.0).w_full().child(body));
        }

        let mut line = row().w_full().items_center().gap(12.0);
        if let Some(leading) = self.leading {
            line = line.child(el().shrink().child(leading));
        }
        line = line.child(text_col);
        if let Some(control) = self.control {
            line = line.child(row().shrink().items_center().gap(8.0).child(control));
        }

        let mut wrapper = el()
            .w_full()
            .px(16.0)
            .py(14.0)
            .hover(t.text_base.alpha(0.04))
            .child(line);

        if self.danger {
            wrapper = wrapper.fill(t.danger.alpha(0.06));
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
            .py(36.0)
            .items_center()
            .justify_center()
            .gap(12.0);

        if let Some(glyph) = self.icon_glyph {
            stack = stack.child(icon(glyph, 32.0).color(t.text_muted));
        }

        let mut copy = col().items_center().gap(4.0);
        copy = copy.child(
            text(self.title)
                .font(k.ty.body_medium)
                .color(t.text_base)
                .center(),
        );
        if let Some(desc) = self.description {
            copy = copy.child(
                text(desc)
                    .font(k.ty.text_xsmall)
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
        .radius(8.0)
        .fill(t.elevated_bg)
        .px(16.0)
        .py(12.0)
        .gap(4.0)
        .child(
            text(label.into().to_uppercase())
                .font(t.label)
                .color(t.text_muted),
        )
        .child(text(value.into()).font(k.ty.body_medium).color(t.text_base));

    if let Some(hint_text) = hint {
        tile = tile.child(text(hint_text).font(k.ty.text_xsmall).color(t.text_muted));
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

/// Compact outlined status badge matching `SettingsStatusPill`.
pub fn status_pill(label: impl Into<String>, tone: StatusTone, k: &Kit, t: &ThemeTokens) -> El {
    let (bg, border, fg) = match tone {
        StatusTone::Success => (t.success.alpha(0.12), t.success.alpha(0.30), t.text_base),
        StatusTone::Warning => (t.warning.alpha(0.14), t.warning.alpha(0.35), t.warning),
        StatusTone::Danger => (t.danger.alpha(0.12), t.danger.alpha(0.30), t.danger),
        StatusTone::Neutral => (t.card_bg.alpha(0.65), t.border_muted, t.text_muted),
    };
    row()
        .h(24.0)
        .px(8.0)
        .radius(6.0)
        .fill(bg)
        .border(1.0, border)
        .center_y()
        .shrink()
        .child(text(label.into()).font(k.ty.text_xsmall_medium).color(fg))
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
            t.danger.alpha(0.10),
            t.danger.alpha(0.28),
            &icons::ALERT_TRIANGLE,
            t.danger,
        ),
        StatusTone::Warning => (
            t.warning.alpha(0.12),
            t.warning.alpha(0.32),
            &icons::ALERT_TRIANGLE,
            t.warning,
        ),
        StatusTone::Success => (
            t.success.alpha(0.10),
            t.success.alpha(0.28),
            &icons::CHECK_CIRCLE,
            t.success,
        ),
        StatusTone::Neutral => (t.elevated_bg, t.border_muted, &icons::INFO, t.accent),
    };
    row()
        .w_full()
        .radius(10.0)
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
                .font(k.ty.text_xsmall)
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

thread_local! {
    static ENTITY_IMAGE_CACHE: RefCell<Option<ImageCache>> = const { RefCell::new(None) };
}

fn cached_image_pixels(s: &AppState, bytes: Arc<[u8]>, mime: &str, size_pt: f32) -> Option<Pixels> {
    ENTITY_IMAGE_CACHE.with(|slot| {
        let mut guard = slot.borrow_mut();
        let cache = guard.get_or_insert_with(|| {
            let waker = s.services.waker.clone().unwrap_or_else(|| Arc::new(|| {}));
            ImageCache::new(waker)
        });
        let img = cache.load_mime(bytes, mime, size_pt, 2.0);
        if img.error().is_some() {
            return None;
        }
        Some(img.pixels().clone())
    })
}

fn decode_data_image(s: &AppState, src: &str, size_pt: f32) -> Option<Pixels> {
    let payload = src.strip_prefix("data:")?;
    let (meta, raw) = payload.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("image/png");
    let bytes = if meta.ends_with(";base64") {
        base64::engine::general_purpose::STANDARD.decode(raw).ok()?
    } else {
        raw.as_bytes().to_vec()
    };
    cached_image_pixels(s, Arc::from(bytes), mime, size_pt)
}

fn lookup_cached_remote_image(s: &AppState, url: &str, size_pt: f32) -> Option<Pixels> {
    let (mime, bytes) = s.image_bytes_by_request.get(url)?;
    let mime = mime.as_deref().unwrap_or("image/png");
    cached_image_pixels(s, Arc::from(bytes.as_slice()), mime, size_pt)
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
    if trimmed.starts_with("data:image/")
        && let Some(px) = decode_data_image(s, trimmed, dim)
    {
        return el()
            .size(dim, dim)
            .radius(6.0)
            .clip_rounded(6.0)
            .fill(t.panel_bg)
            .border(1.0, t.border_muted)
            .pixels(&px)
            .shrink();
    }
    if (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
        && let Some(px) = lookup_cached_remote_image(s, trimmed, dim)
    {
        return el()
            .size(dim, dim)
            .radius(6.0)
            .clip_rounded(6.0)
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
            .radius(6.0)
            .center()
            .shrink()
            .child(text(trimmed).font(emoji_style).color(t.text_base));
    }

    let (bg, fg): (Color, Color) = match entity_palette_index(name) {
        0 => (t.accent.alpha(0.12), t.accent),
        1 => (t.success.alpha(0.12), t.success),
        2 => (t.warning.alpha(0.14), t.warning),
        3 => (t.elevated_bg, t.text_muted),
        _ => (t.accent.alpha(0.16), t.accent),
    };
    let font = match size {
        EntityIconSize::Lg => k.ty.body_medium,
        _ => k.ty.text_xsmall_medium,
    };

    el().size(dim, dim)
        .radius(6.0)
        .fill(bg)
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
