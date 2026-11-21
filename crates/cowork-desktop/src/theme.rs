//! Cowork desktop design tokens and `rune_kit::Kit` construction.
//!
//! Ported from `apps/desktop/src/styles/tokens/base.css`,
//! `apps/desktop/src/styles/tokens/platform.css`, and
//! `apps/desktop/src/styles/tokens/theme-bridge.css`.

use rune::{Color, TextStyle};
use rune_kit::{Kit, PaletteSeed};
use serde::{Deserialize, Serialize};

/// User theme preference persisted with desktop settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    /// Resolves whether dark mode is active given the OS appearance.
    pub fn is_dark(self, system_dark: bool) -> bool {
        match self {
            ThemePreference::System => system_dark,
            ThemePreference::Light => false,
            ThemePreference::Dark => true,
        }
    }
}

/// User-selectable warm accent palette persisted with desktop settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccentPalette {
    KhakiSand,
    OchreAmber,
    #[default]
    BurntOrange,
}

impl AccentPalette {
    /// All candidate accent palettes in Settings display order.
    pub const ALL: [AccentPalette; 3] = [
        AccentPalette::KhakiSand,
        AccentPalette::OchreAmber,
        AccentPalette::BurntOrange,
    ];

    /// Stable kebab-case identifier used for persistence and CLI overrides.
    pub const fn id(self) -> &'static str {
        match self {
            AccentPalette::KhakiSand => "khaki-sand",
            AccentPalette::OchreAmber => "ochre-amber",
            AccentPalette::BurntOrange => "burnt-orange",
        }
    }

    /// Human-facing label shown in Settings.
    pub const fn label(self) -> &'static str {
        match self {
            AccentPalette::KhakiSand => "Khaki Sand",
            AccentPalette::OchreAmber => "Ochre Amber",
            AccentPalette::BurntOrange => "Burnt Orange",
        }
    }

    /// Short description of the palette tone.
    pub const fn description(self) -> &'static str {
        match self {
            AccentPalette::KhakiSand => "Warm limestone and muted brass sand.",
            AccentPalette::OchreAmber => "Burnished golden ochre and warm amber.",
            AccentPalette::BurntOrange => "Muted terracotta and warm burnt orange.",
        }
    }

    /// Parses a palette id or alias (case-insensitive).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "khaki-sand" | "khaki_sand" | "khaki" | "sand" => Some(Self::KhakiSand),
            "ochre-amber" | "ochre_amber" | "ochre" | "amber" => Some(Self::OchreAmber),
            "burnt-orange" | "burnt_orange" | "terracotta" | "orange" => Some(Self::BurntOrange),
            _ => None,
        }
    }
}

/// Accent token set for a single `(AccentPalette, dark, high_contrast)` configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AccentTokenSet {
    pub accent: Color,
    pub accent_hover: Color,
    pub accent_pressed: Color,
    pub accent_on: Color,
    pub accent_soft: Color,
    pub focus_ring: Color,
    pub cta_bg: Color,
    pub cta_hover: Color,
    pub cta_pressed: Color,
    pub cta_on: Color,
    pub send_bg: Color,
    pub send_hover: Color,
    pub send_on: Color,
    /// Straight-alpha overlays painted by `rune_kit` (`contrast_hover`, `contrast_pressed`, `submit_hover`).
    pub hover_overlay: Color,
    pub pressed_overlay: Color,
}

/// Standard spacing and layout constants used across views.
pub mod layout {
    pub const TITLEBAR_HEIGHT: f32 = 38.0;
    /// Main window toolbar band (traffic lights, sidebar toggle, nav, title, actions).
    pub const SHELL_TOOLBAR_HEIGHT: f32 = 40.0;
    /// How much of the sidebar's tint sits over the native vibrancy material: high enough to
    /// keep text legible and the look restrained, low enough that the desktop shows through.
    pub const SIDEBAR_TINT_ALPHA_LIGHT: f32 = 0.82;
    pub const SIDEBAR_TINT_ALPHA_DARK: f32 = 0.84;
    pub const SIDEBAR_DEFAULT_WIDTH: f32 = 268.0;
    pub const SIDEBAR_MIN_WIDTH: f32 = 210.0;
    pub const SIDEBAR_MAX_WIDTH: f32 = 420.0;
    pub const CONTEXT_SIDEBAR_DEFAULT_WIDTH: f32 = 340.0;
    pub const CONTEXT_SIDEBAR_MIN_WIDTH: f32 = 260.0;
    pub const CONTEXT_SIDEBAR_MAX_WIDTH: f32 = 520.0;

    pub const SPACE_XS: f32 = 4.0;
    pub const SPACE_SM: f32 = 8.0;
    pub const SPACE_MD: f32 = 12.0;
    pub const SPACE_LG: f32 = 16.0;
    pub const SPACE_XL: f32 = 24.0;

    pub const RADIUS_XS: f32 = 2.0;
    pub const RADIUS_SM: f32 = 4.0;
    pub const RADIUS_MD: f32 = 6.0;
    pub const RADIUS_BASE: f32 = 8.0;
    pub const RADIUS_LG: f32 = 12.0;
    pub const RADIUS_PILL: f32 = 9999.0;

    pub const MOTION_FAST_MS: u64 = 120;
    pub const MOTION_BASE_MS: u64 = 200;
    pub const MOTION_SLOW_MS: u64 = 280;
}

/// Complete semantic color and typography tokens for Cowork desktop views.
#[derive(Clone, Copy, Debug)]
pub struct ThemeTokens {
    pub dark: bool,
    pub app_bg: Color,
    pub sidebar_bg: Color,
    pub panel_bg: Color,
    pub elevated_bg: Color,
    pub card_bg: Color,
    pub popover_bg: Color,
    pub input_bg: Color,
    pub glass_bg: Color,
    pub glass_hover: Color,
    pub glass_active: Color,
    pub glass_border: Color,
    pub text_base: Color,
    pub text_muted: Color,
    pub text_faint: Color,
    pub primary_fg: Color,
    pub accent: Color,
    pub accent_hover: Color,
    pub accent_pressed: Color,
    pub accent_on: Color,
    pub accent_soft: Color,
    pub cta_bg: Color,
    pub cta_hover: Color,
    pub cta_pressed: Color,
    pub cta_on: Color,
    pub send_bg: Color,
    pub send_hover: Color,
    pub send_on: Color,
    pub accent_hover_overlay: Color,
    pub accent_pressed_overlay: Color,
    pub danger: Color,
    pub danger_hover: Color,
    pub danger_fg: Color,
    pub success: Color,
    pub warning: Color,
    pub info: Color,
    pub border: Color,
    pub border_muted: Color,
    pub border_strong: Color,
    pub focus_ring: Color,
    pub hover: Color,
    pub pressed: Color,
    pub scrim: Color,
    pub code_bg: Color,
    pub selection_bg: Color,
    pub search_badges: [Color; 7],
    pub caption: TextStyle,
    pub label: TextStyle,
    pub body: TextStyle,
    pub body_lg: TextStyle,
    pub title: TextStyle,
    pub code: TextStyle,
}

fn srgb_unit_to_linear(channel: f32) -> f32 {
    let c = channel.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb_channel(linear: f32) -> f32 {
    let c = linear.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_to_linear(channel: u8) -> f32 {
    srgb_unit_to_linear(channel as f32 / 255.0)
}

fn srgba(r: u8, g: u8, b: u8, a: f32) -> Color {
    Color {
        r: srgb_to_linear(r),
        g: srgb_to_linear(g),
        b: srgb_to_linear(b),
        a,
    }
}

fn srgb(r: u8, g: u8, b: u8) -> Color {
    srgba(r, g, b, 1.0)
}

/// Composites straight-alpha `top` over opaque `bottom` in sRGB perceptual space (matching Rune's `srgb_blend`).
pub fn composite_srgb_over(top: Color, bottom: Color) -> Color {
    let a = top.a.clamp(0.0, 1.0);
    if a <= 0.0 {
        return bottom;
    }
    if a >= 0.999 {
        return Color { a: 1.0, ..top };
    }
    let mix = |t: f32, b: f32| {
        let s = linear_to_srgb_channel(t) * a + linear_to_srgb_channel(b) * (1.0 - a);
        srgb_unit_to_linear(s)
    };
    Color {
        r: mix(top.r, bottom.r),
        g: mix(top.g, bottom.g),
        b: mix(top.b, bottom.b),
        a: 1.0,
    }
}

/// Relative luminance of an opaque linear `rune::Color` per WCAG 2.1.
pub fn relative_luminance(color: Color) -> f32 {
    0.2126 * color.r.clamp(0.0, 1.0)
        + 0.7152 * color.g.clamp(0.0, 1.0)
        + 0.0722 * color.b.clamp(0.0, 1.0)
}

/// WCAG 2.1 contrast ratio between `fg` and `bg` (compositing semi-transparent `fg` over `bg` first).
pub fn contrast_ratio(fg: Color, bg: Color) -> f32 {
    let resolved_bg = if bg.a < 0.999 {
        composite_srgb_over(bg, Color::BLACK)
    } else {
        bg
    };
    let resolved_fg = if fg.a < 0.999 {
        composite_srgb_over(fg, resolved_bg)
    } else {
        fg
    };
    let l1 = relative_luminance(resolved_fg);
    let l2 = relative_luminance(resolved_bg);
    let (hi, lo) = if l1 >= l2 { (l1, l2) } else { (l2, l1) };
    (hi + 0.05) / (lo + 0.05)
}

struct AccentSeed {
    accent: Color,
    accent_on: Color,
    accent_hover_overlay: Color,
    accent_pressed_overlay: Color,
    cta_bg: Color,
    send_bg: Color,
    cta_on: Color,
    focus_ring: Color,
    soft_alpha: f32,
    hover_overlay: Color,
    pressed_overlay: Color,
}

fn build_accent_set(seed: AccentSeed) -> AccentTokenSet {
    AccentTokenSet {
        accent: seed.accent,
        accent_hover: composite_srgb_over(seed.accent_hover_overlay, seed.accent),
        accent_pressed: composite_srgb_over(seed.accent_pressed_overlay, seed.accent),
        accent_on: seed.accent_on,
        accent_soft: seed.accent.alpha(seed.soft_alpha),
        focus_ring: seed.focus_ring,
        cta_bg: seed.cta_bg,
        cta_hover: composite_srgb_over(seed.hover_overlay, seed.cta_bg),
        cta_pressed: composite_srgb_over(seed.pressed_overlay, seed.cta_bg),
        cta_on: seed.cta_on,
        send_bg: seed.send_bg,
        send_hover: composite_srgb_over(seed.hover_overlay, seed.send_bg),
        send_on: seed.cta_on,
        hover_overlay: seed.hover_overlay,
        pressed_overlay: seed.pressed_overlay,
    }
}

/// Resolves the named [`AccentTokenSet`] for a palette, appearance mode, and high-contrast setting.
pub fn accent_tokens(palette: AccentPalette, dark: bool, high_contrast: bool) -> AccentTokenSet {
    let h = if high_contrast { 0.14 } else { 0.12 };
    let p = if high_contrast { 0.24 } else { 0.22 };
    // Filled CTA/Send surfaces always pair with white ink so dark-mode disabled Contrast buttons
    // stay light-on-dark instead of collapsing into dark ink on muddy brown, and hover/press
    // consistently darken the fill.
    let hover_overlay = srgba(0x00, 0x00, 0x00, h);
    let pressed_overlay = srgba(0x00, 0x00, 0x00, p);
    let (accent_hover_overlay, accent_pressed_overlay, soft_alpha) = if dark {
        let s = if high_contrast { 0.17 } else { 0.12 };
        (srgba(0xff, 0xff, 0xff, h), srgba(0xff, 0xff, 0xff, p), s)
    } else {
        let s = if high_contrast { 0.14 } else { 0.10 };
        (hover_overlay, pressed_overlay, s)
    };

    let seed = match (palette, dark, high_contrast) {
        (AccentPalette::KhakiSand, false, false) => AccentSeed {
            accent: srgb(0x6d, 0x56, 0x30),
            accent_on: Color::WHITE,
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x65, 0x4f, 0x2b),
            send_bg: srgb(0x5d, 0x48, 0x27),
            cta_on: Color::WHITE,
            focus_ring: srgb(0x6d, 0x56, 0x30),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::KhakiSand, false, true) => AccentSeed {
            accent: srgb(0x5a, 0x46, 0x23),
            accent_on: Color::WHITE,
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x52, 0x3f, 0x1f),
            send_bg: srgb(0x4c, 0x3a, 0x1c),
            cta_on: Color::WHITE,
            focus_ring: srgb(0x4c, 0x3a, 0x1c),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::KhakiSand, true, false) => AccentSeed {
            accent: srgb(0xcb, 0xb2, 0x7d),
            accent_on: srgb(0x18, 0x14, 0x0d),
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x8b, 0x70, 0x42),
            send_bg: srgb(0x80, 0x67, 0x3b),
            cta_on: Color::WHITE,
            focus_ring: srgb(0xcb, 0xb2, 0x7d),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::KhakiSand, true, true) => AccentSeed {
            accent: srgb(0xe0, 0xca, 0x98),
            accent_on: srgb(0x10, 0x0d, 0x08),
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x7a, 0x62, 0x38),
            send_bg: srgb(0x70, 0x59, 0x33),
            cta_on: Color::WHITE,
            focus_ring: srgb(0xe0, 0xca, 0x98),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::OchreAmber, false, false) => AccentSeed {
            accent: srgb(0x85, 0x4e, 0x07),
            accent_on: Color::WHITE,
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x7b, 0x47, 0x05),
            send_bg: srgb(0x73, 0x42, 0x04),
            cta_on: Color::WHITE,
            focus_ring: srgb(0x85, 0x4e, 0x07),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::OchreAmber, false, true) => AccentSeed {
            accent: srgb(0x70, 0x40, 0x04),
            accent_on: Color::WHITE,
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x66, 0x3a, 0x03),
            send_bg: srgb(0x5e, 0x35, 0x02),
            cta_on: Color::WHITE,
            focus_ring: srgb(0x5e, 0x35, 0x02),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::OchreAmber, true, false) => AccentSeed {
            accent: srgb(0xde, 0x9e, 0x35),
            accent_on: srgb(0x19, 0x12, 0x06),
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0xa6, 0x66, 0x11),
            send_bg: srgb(0x99, 0x5c, 0x0c),
            cta_on: Color::WHITE,
            focus_ring: srgb(0xde, 0x9e, 0x35),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::OchreAmber, true, true) => AccentSeed {
            accent: srgb(0xee, 0xb6, 0x55),
            accent_on: srgb(0x12, 0x0c, 0x03),
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x95, 0x59, 0x0a),
            send_bg: srgb(0x8a, 0x52, 0x08),
            cta_on: Color::WHITE,
            focus_ring: srgb(0xee, 0xb6, 0x55),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::BurntOrange, false, false) => AccentSeed {
            accent: srgb(0x9b, 0x40, 0x1e),
            accent_on: Color::WHITE,
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x90, 0x3b, 0x1b),
            send_bg: srgb(0x86, 0x36, 0x18),
            cta_on: Color::WHITE,
            focus_ring: srgb(0x9b, 0x40, 0x1e),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::BurntOrange, false, true) => AccentSeed {
            accent: srgb(0x82, 0x33, 0x14),
            accent_on: Color::WHITE,
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0x78, 0x2e, 0x11),
            send_bg: srgb(0x6f, 0x2a, 0x0f),
            cta_on: Color::WHITE,
            focus_ring: srgb(0x6f, 0x2a, 0x0f),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::BurntOrange, true, false) => AccentSeed {
            accent: srgb(0xea, 0x8c, 0x64),
            accent_on: srgb(0x18, 0x0d, 0x08),
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0xc2, 0x52, 0x27),
            send_bg: srgb(0xb6, 0x49, 0x1f),
            cta_on: Color::WHITE,
            focus_ring: srgb(0xea, 0x8c, 0x64),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
        (AccentPalette::BurntOrange, true, true) => AccentSeed {
            accent: srgb(0xf5, 0xa2, 0x7d),
            accent_on: srgb(0x11, 0x08, 0x05),
            accent_hover_overlay,
            accent_pressed_overlay,
            cta_bg: srgb(0xb1, 0x47, 0x1f),
            send_bg: srgb(0xa5, 0x41, 0x1b),
            cta_on: Color::WHITE,
            focus_ring: srgb(0xf5, 0xa2, 0x7d),
            soft_alpha,
            hover_overlay,
            pressed_overlay,
        },
    };
    build_accent_set(seed)
}

fn apply_accent_set(tok: &mut ThemeTokens, set: AccentTokenSet) {
    tok.primary_fg = set.accent_on;
    tok.accent = set.accent;
    tok.accent_hover = set.accent_hover;
    tok.accent_pressed = set.accent_pressed;
    tok.accent_on = set.accent_on;
    tok.accent_soft = set.accent_soft;
    tok.focus_ring = set.focus_ring;
    tok.cta_bg = set.cta_bg;
    tok.cta_hover = set.cta_hover;
    tok.cta_pressed = set.cta_pressed;
    tok.cta_on = set.cta_on;
    tok.send_bg = set.send_bg;
    tok.send_hover = set.send_hover;
    tok.send_on = set.send_on;
    tok.accent_hover_overlay = set.hover_overlay;
    tok.accent_pressed_overlay = set.pressed_overlay;
    tok.selection_bg = set.accent.alpha(if tok.dark { 0.28 } else { 0.24 });
}

/// Returns Cowork's semantic tokens for light or dark appearance using the default accent palette.
pub fn tokens(dark: bool) -> ThemeTokens {
    tokens_with_accent(dark, AccentPalette::default())
}

/// Returns Cowork's semantic tokens for light or dark appearance with the chosen accent palette.
pub fn tokens_with_accent(dark: bool, accent_palette: AccentPalette) -> ThemeTokens {
    let search_badges = [
        srgb(0xa8, 0x38, 0xff), // purple
        srgb(0x00, 0x7a, 0xff), // blue
        srgb(0xff, 0x8a, 0x00), // orange
        srgb(0x00, 0xc7, 0xbe), // teal
        srgb(0x34, 0xc7, 0x59), // green
        srgb(0xff, 0x2d, 0x55), // pink
        srgb(0x58, 0x56, 0xd6), // indigo
    ];

    let caption = TextStyle::new(12.0, 400.0).lh(16.0);
    let label = TextStyle::new(12.0, 500.0).lh(16.0);
    let body = TextStyle::new(13.0, 400.0).lh(20.0);
    let body_lg = TextStyle::new(15.0, 400.0).lh(24.0);
    let title = TextStyle::new(16.0, 600.0).lh(22.0);
    let code = TextStyle::new(12.0, 400.0).mono().lh(18.0);
    let set = accent_tokens(accent_palette, dark, false);

    if dark {
        let text_base = srgb(0xe9, 0xe9, 0xe7);
        ThemeTokens {
            dark: true,
            app_bg: srgb(0x14, 0x14, 0x15),
            sidebar_bg: srgb(0x1b, 0x1b, 0x1d),
            panel_bg: srgb(0x23, 0x23, 0x25),
            elevated_bg: srgb(0x2b, 0x2b, 0x2e),
            card_bg: srgb(0x23, 0x23, 0x25),
            popover_bg: srgb(0x26, 0x26, 0x29),
            input_bg: srgb(0x1c, 0x1c, 0x1e),
            glass_bg: srgba(0x1b, 0x1b, 0x1d, 0.88),
            glass_hover: srgba(0xff, 0xff, 0xff, 0.08),
            glass_active: srgba(0xff, 0xff, 0xff, 0.14),
            glass_border: srgba(0xff, 0xff, 0xff, 0.12),
            text_base,
            text_muted: srgb(0xa3, 0xa3, 0x9c),
            text_faint: srgba(0xa3, 0xa3, 0x9c, 0.72),
            primary_fg: set.accent_on,
            accent: set.accent,
            accent_hover: set.accent_hover,
            accent_pressed: set.accent_pressed,
            accent_on: set.accent_on,
            accent_soft: set.accent_soft,
            cta_bg: set.cta_bg,
            cta_hover: set.cta_hover,
            cta_pressed: set.cta_pressed,
            cta_on: set.cta_on,
            send_bg: set.send_bg,
            send_hover: set.send_hover,
            send_on: set.send_on,
            accent_hover_overlay: set.hover_overlay,
            accent_pressed_overlay: set.pressed_overlay,
            danger: srgb(0xe8, 0x60, 0x60),
            danger_hover: srgb(0xf2, 0x70, 0x70),
            danger_fg: srgb(0x14, 0x14, 0x15),
            success: srgb(0x5e, 0xcc, 0x7e),
            warning: srgb(0xf3, 0xb0, 0x1d),
            info: srgb(0x4f, 0x9c, 0xf9),
            border: srgba(0xff, 0xff, 0xff, 0.10),
            border_muted: srgba(0xff, 0xff, 0xff, 0.06),
            border_strong: srgba(0xff, 0xff, 0xff, 0.18),
            focus_ring: set.focus_ring,
            hover: srgba(0xff, 0xff, 0xff, 0.06),
            pressed: srgba(0xff, 0xff, 0xff, 0.11),
            scrim: srgba(0x00, 0x00, 0x00, 0.56),
            code_bg: srgba(0x00, 0x00, 0x00, 0.30),
            selection_bg: set.accent.alpha(0.28),
            search_badges,
            caption,
            label,
            body,
            body_lg,
            title,
            code,
        }
    } else {
        let text_base = srgb(0x1f, 0x1f, 0x1c);
        ThemeTokens {
            dark: false,
            app_bg: srgb(0xe8, 0xe8, 0xe5),
            sidebar_bg: srgb(0xee, 0xee, 0xec),
            panel_bg: srgb(0xfa, 0xfa, 0xf8),
            elevated_bg: srgb(0xff, 0xff, 0xff),
            card_bg: srgb(0xfa, 0xfa, 0xf8),
            popover_bg: srgb(0xff, 0xff, 0xff),
            input_bg: srgb(0xff, 0xff, 0xff),
            glass_bg: srgba(0xfa, 0xfa, 0xf8, 0.88),
            glass_hover: srgba(0x1f, 0x1f, 0x1c, 0.06),
            glass_active: srgba(0x1f, 0x1f, 0x1c, 0.11),
            glass_border: srgba(0x1f, 0x1f, 0x1c, 0.14),
            text_base,
            text_muted: srgb(0x61, 0x61, 0x5b),
            text_faint: srgba(0x61, 0x61, 0x5b, 0.72),
            primary_fg: set.accent_on,
            accent: set.accent,
            accent_hover: set.accent_hover,
            accent_pressed: set.accent_pressed,
            accent_on: set.accent_on,
            accent_soft: set.accent_soft,
            cta_bg: set.cta_bg,
            cta_hover: set.cta_hover,
            cta_pressed: set.cta_pressed,
            cta_on: set.cta_on,
            send_bg: set.send_bg,
            send_hover: set.send_hover,
            send_on: set.send_on,
            accent_hover_overlay: set.hover_overlay,
            accent_pressed_overlay: set.pressed_overlay,
            danger: srgb(0xbb, 0x3e, 0x3e),
            danger_hover: srgb(0xa7, 0x35, 0x35),
            danger_fg: Color::WHITE,
            success: srgb(0x3a, 0xb6, 0x65),
            warning: srgb(0xec, 0xaa, 0x0b),
            info: srgb(0x00, 0x7a, 0xff),
            border: srgba(0x1f, 0x1f, 0x1c, 0.12),
            border_muted: srgba(0x1f, 0x1f, 0x1c, 0.07),
            border_strong: srgba(0x1f, 0x1f, 0x1c, 0.22),
            focus_ring: set.focus_ring,
            hover: srgba(0x1f, 0x1f, 0x1c, 0.05),
            pressed: srgba(0x1f, 0x1f, 0x1c, 0.10),
            scrim: srgba(0x1f, 0x1f, 0x1c, 0.36),
            code_bg: srgba(0x1f, 0x1f, 0x1c, 0.05),
            selection_bg: set.accent.alpha(0.24),
            search_badges,
            caption,
            label,
            body,
            body_lg,
            title,
            code,
        }
    }
}

/// Resolves Cowork's semantic tokens with optional reduced-transparency and high-contrast overrides
/// using the default accent palette.
pub fn resolve_tokens(dark: bool, reduced_transparency: bool, high_contrast: bool) -> ThemeTokens {
    resolve_tokens_with_accent(
        dark,
        reduced_transparency,
        high_contrast,
        AccentPalette::default(),
    )
}

/// Resolves Cowork's semantic tokens with reduced-transparency, high-contrast, and accent overrides.
pub fn resolve_tokens_with_accent(
    dark: bool,
    reduced_transparency: bool,
    high_contrast: bool,
    accent_palette: AccentPalette,
) -> ThemeTokens {
    let mut tok = tokens_with_accent(dark, accent_palette);
    if high_contrast {
        apply_accent_set(&mut tok, accent_tokens(accent_palette, dark, true));
        if dark {
            // Deepen dark HC background neutrals so saturated HC CTAs and switches maintain >= 3:1
            // UI boundary contrast even on elevated cards without sacrificing button text contrast.
            tok.app_bg = srgb(0x06, 0x06, 0x07);
            tok.sidebar_bg = srgb(0x0c, 0x0c, 0x0d);
            tok.panel_bg = srgb(0x11, 0x11, 0x12);
            tok.elevated_bg = srgb(0x16, 0x16, 0x18);
            tok.card_bg = tok.panel_bg;
            tok.popover_bg = tok.elevated_bg;
            tok.input_bg = srgb(0x0b, 0x0b, 0x0c);
            tok.glass_bg = srgba(0x0c, 0x0c, 0x0d, 0.94);
        }
        tok.border = if dark {
            srgba(0xff, 0xff, 0xff, 0.28)
        } else {
            srgba(0x1f, 0x1f, 0x1c, 0.34)
        };
        tok.border_strong = if dark {
            srgba(0xff, 0xff, 0xff, 0.45)
        } else {
            srgba(0x1f, 0x1f, 0x1c, 0.50)
        };
        tok.text_muted = tok.text_base.alpha(0.88);
    }
    if reduced_transparency {
        tok.glass_bg = tok.panel_bg;
    }
    tok
}

/// Returns a crisp, WCAG-legible amber ink for warning icons/labels on light surfaces
/// while preserving `t.warning` in dark mode.
pub fn warning_ink(t: &ThemeTokens) -> Color {
    if t.dark {
        t.warning
    } else {
        srgb(0xb4, 0x69, 0x06)
    }
}

/// Builds a `rune_kit::Kit` configured with Cowork's semantic palette, typography, and radii
/// using the default accent palette.
pub fn build_kit(
    dark: bool,
    reduced_transparency: bool,
    high_contrast: bool,
) -> (Kit, ThemeTokens) {
    build_kit_with_accent(
        dark,
        reduced_transparency,
        high_contrast,
        AccentPalette::default(),
    )
}

/// Builds a `rune_kit::Kit` configured with Cowork's semantic palette, typography, radii, and
/// selected [`AccentPalette`], paired with `ThemeTokens`.
pub fn build_kit_with_accent(
    dark: bool,
    reduced_transparency: bool,
    high_contrast: bool,
    accent_palette: AccentPalette,
) -> (Kit, ThemeTokens) {
    let tok = resolve_tokens_with_accent(dark, reduced_transparency, high_contrast, accent_palette);

    let mut kit = Kit::from_palette(PaletteSeed {
        bg: tok.panel_bg,
        fg: tok.text_base,
        accent: tok.accent,
    });

    kit.c.page = tok.app_bg;
    kit.c.bg_base = tok.panel_bg;
    kit.c.bg_deep = tok.sidebar_bg;
    kit.c.layer_01 = tok.panel_bg;
    kit.c.layer_02 = tok.elevated_bg;
    kit.c.bg_accent = tok.cta_bg;
    kit.c.bg_contrast = tok.cta_bg;
    kit.c.bg_button_neutral = tok.elevated_bg;
    kit.c.bg_icon_button_contrast = tok.send_bg;
    kit.c.text_contrast = tok.cta_on;
    kit.c.icon_contrast = tok.cta_on;
    kit.c.contrast_hover = tok.accent_hover_overlay;
    kit.c.contrast_pressed = tok.accent_pressed_overlay;
    kit.c.submit_hover = tok.accent_hover_overlay;
    kit.c.submit_fg = tok.send_on;
    kit.c.submit_icon = tok.send_on;
    kit.c.knob_on = tok.cta_on;
    kit.c.text_base = tok.text_base;
    kit.c.text_muted = tok.text_muted;
    kit.c.text_faint = tok.text_faint;
    kit.c.text_accent = tok.accent;
    kit.c.icon_base = tok.text_base;
    kit.c.icon_muted = tok.text_muted;
    kit.c.icon_faint = tok.text_faint;
    kit.c.icon_accent = tok.accent;
    kit.c.border_muted = tok.border_muted;
    kit.c.border_base = tok.border;
    kit.c.border_strong = tok.border_strong;
    kit.c.border_focus = tok.focus_ring;
    kit.c.hover = tok.hover;
    kit.c.pressed = tok.pressed;
    kit.c.scrim = tok.scrim;
    kit.c.surface_base = tok.panel_bg;
    kit.c.surface_weak = tok.sidebar_bg;
    kit.c.surface_hover = tok.hover;
    kit.c.surface_raised = tok.elevated_bg;
    kit.c.surface_raised_base = tok.elevated_bg;
    kit.c.surface_raised_hover = tok.hover;
    kit.c.surface_float = tok.popover_bg;
    kit.c.danger.fg = tok.danger;
    kit.c.danger.icon = tok.danger;
    kit.c.danger.border = tok.danger.alpha(0.35);
    kit.c.danger.bg = tok.danger.alpha(0.12);
    kit.c.success.fg = tok.success;
    kit.c.success.icon = tok.success;
    kit.c.success.border = tok.success.alpha(0.35);
    kit.c.success.bg = tok.success.alpha(0.12);
    kit.c.warning.fg = tok.warning;
    kit.c.warning.icon = tok.warning;
    kit.c.warning.border = tok.warning.alpha(0.35);
    kit.c.warning.bg = tok.warning.alpha(0.12);
    kit.c.info.fg = tok.info;
    kit.c.info.icon = tok.info;
    kit.c.info.border = tok.info.alpha(0.35);
    kit.c.info.bg = tok.info.alpha(0.12);

    kit.ty.ui = tok.body;
    kit.ty.ui_medium = TextStyle {
        weight: 500.0,
        ..tok.body
    };
    kit.ty.ui_compact = tok.body.lh(16.0);
    kit.ty.small = tok.caption;
    kit.ty.small_medium = tok.label;
    kit.ty.mono = tok.code;

    kit.radius.xs = layout::RADIUS_XS;
    kit.radius.sm = layout::RADIUS_SM;
    kit.radius.md = layout::RADIUS_MD;
    kit.radius.lg = layout::RADIUS_BASE;
    kit.radius.xl = layout::RADIUS_LG;

    (kit, tok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_candidate_palettes_meet_wcag_aa_across_all_variants() {
        for palette in AccentPalette::ALL {
            for dark in [false, true] {
                for high_contrast in [false, true] {
                    let (kit, tok) = build_kit_with_accent(dark, false, high_contrast, palette);

                    // Text/icon on accent, CTA, and Send surfaces must meet WCAG AA >= 4.5:1 across all states.
                    for (role, fg, bg) in [
                        ("accent", tok.accent_on, tok.accent),
                        ("accent_hover", tok.accent_on, tok.accent_hover),
                        ("accent_pressed", tok.accent_on, tok.accent_pressed),
                        ("cta_bg", tok.cta_on, tok.cta_bg),
                        ("cta_hover", tok.cta_on, tok.cta_hover),
                        ("cta_pressed", tok.cta_on, tok.cta_pressed),
                        ("send_bg", tok.send_on, tok.send_bg),
                        ("send_hover", tok.send_on, tok.send_hover),
                        ("badge_accent", kit.c.text_contrast, kit.c.bg_accent),
                    ] {
                        let ratio = contrast_ratio(fg, bg);
                        assert!(
                            ratio >= 4.5,
                            "{palette:?} dark={dark} hc={high_contrast} {role} ratio {ratio:.2} < 4.5"
                        );
                    }

                    // Accent used as text/icon and subtle surface foreground must meet WCAG AA >= 4.5:1.
                    for (surf_name, surface) in [
                        ("app_bg", tok.app_bg),
                        ("sidebar_bg", tok.sidebar_bg),
                        ("panel_bg", tok.panel_bg),
                        ("elevated_bg", tok.elevated_bg),
                    ] {
                        let fg_ratio = contrast_ratio(tok.accent, surface);
                        assert!(
                            fg_ratio >= 4.5,
                            "{palette:?} dark={dark} hc={high_contrast} accent on {surf_name} {fg_ratio:.2} < 4.5"
                        );

                        let soft_bg = composite_srgb_over(tok.accent_soft, surface);
                        let soft_ratio = contrast_ratio(tok.accent, soft_bg);
                        assert!(
                            soft_ratio >= 4.5,
                            "{palette:?} dark={dark} hc={high_contrast} accent on soft({surf_name}) {soft_ratio:.2} < 4.5"
                        );

                        let ring_ratio = contrast_ratio(tok.focus_ring, surface);
                        let min_ring = if high_contrast { 6.0 } else { 3.0 };
                        assert!(
                            ring_ratio >= min_ring,
                            "{palette:?} dark={dark} hc={high_contrast} focus_ring on {surf_name} {ring_ratio:.2} < {min_ring:.1}"
                        );
                    }

                    for (surf_name, surface) in
                        [("panel_bg", tok.panel_bg), ("elevated_bg", tok.elevated_bg)]
                    {
                        let ui_ratio = contrast_ratio(tok.cta_bg, surface);
                        assert!(
                            ui_ratio >= 3.0,
                            "{palette:?} dark={dark} hc={high_contrast} cta_bg on {surf_name} {ui_ratio:.2} < 3.0"
                        );
                    }

                    // Disabled Contrast buttons render with rune-kit's 0.4 layer opacity; in dark
                    // mode, white CTA ink composites to light neutral over panel_bg rather than
                    // collapsing near the background luminance.
                    if dark {
                        let disabled_ink = composite_srgb_over(tok.cta_on.alpha(0.4), tok.panel_bg);
                        let dis_panel_ratio = contrast_ratio(disabled_ink, tok.panel_bg);
                        assert!(
                            dis_panel_ratio >= 3.5,
                            "{palette:?} dark={dark} hc={high_contrast} disabled Contrast ink vs panel_bg {dis_panel_ratio:.2} < 3.5"
                        );
                    }

                    assert_eq!(kit.c.bg_accent, tok.cta_bg);
                    assert_eq!(kit.c.bg_contrast, tok.cta_bg);
                    assert_eq!(kit.c.bg_icon_button_contrast, tok.send_bg);
                    assert_eq!(kit.c.text_contrast, tok.cta_on);
                    assert_eq!(kit.c.submit_fg, tok.send_on);
                    assert_eq!(kit.c.knob_on, tok.cta_on);
                    assert_eq!(kit.c.border_focus, tok.focus_ring);
                }
            }
        }
    }

    #[test]
    fn high_contrast_strengthens_accent_contrast() {
        for palette in AccentPalette::ALL {
            for dark in [false, true] {
                let normal = resolve_tokens_with_accent(dark, false, false, palette);
                let hc = resolve_tokens_with_accent(dark, false, true, palette);
                assert!(
                    contrast_ratio(hc.cta_on, hc.cta_bg)
                        > contrast_ratio(normal.cta_on, normal.cta_bg),
                    "{palette:?} dark={dark} high-contrast CTA did not increase text contrast"
                );
                assert!(
                    contrast_ratio(hc.focus_ring, hc.panel_bg)
                        > contrast_ratio(normal.focus_ring, normal.panel_bg),
                    "{palette:?} dark={dark} high-contrast focus ring did not increase contrast"
                );
            }
        }
    }

    #[test]
    fn accent_palette_parse_and_serde_roundtrip() {
        for palette in AccentPalette::ALL {
            assert_eq!(AccentPalette::parse(palette.id()), Some(palette));
            let json = serde_json::to_value(palette).expect("serialize accent palette");
            assert_eq!(json, serde_json::Value::String(palette.id().to_string()));
            let back: AccentPalette = serde_json::from_value(json).expect("deserialize");
            assert_eq!(back, palette);
        }
        assert_eq!(
            AccentPalette::parse("amber"),
            Some(AccentPalette::OchreAmber)
        );
        assert_eq!(AccentPalette::parse("SAND"), Some(AccentPalette::KhakiSand));
        assert_eq!(AccentPalette::parse("unknown"), None);
    }
}
