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

/// Standard spacing and layout constants used across views.
pub mod layout {
    pub const TITLEBAR_HEIGHT: f32 = 38.0;
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
    pub accent_soft: Color,
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

fn srgb_to_linear(channel: u8) -> f32 {
    let c = channel as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
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

/// Returns Cowork's semantic tokens for light or dark appearance.
pub fn tokens(dark: bool) -> ThemeTokens {
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

    if dark {
        let accent = srgb(0xa8, 0xb9, 0x63);
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
            primary_fg: srgb(0x1f, 0x1f, 0x1c),
            accent,
            accent_hover: srgb(0xb7, 0xc8, 0x73),
            accent_soft: accent.alpha(0.16),
            danger: srgb(0xe8, 0x60, 0x60),
            danger_hover: srgb(0xf2, 0x70, 0x70),
            danger_fg: srgb(0x14, 0x14, 0x15),
            success: srgb(0x5e, 0xcc, 0x7e),
            warning: srgb(0xf3, 0xb0, 0x1d),
            info: srgb(0x4f, 0x9c, 0xf9),
            border: srgba(0xff, 0xff, 0xff, 0.10),
            border_muted: srgba(0xff, 0xff, 0xff, 0.06),
            border_strong: srgba(0xff, 0xff, 0xff, 0.18),
            focus_ring: accent,
            hover: srgba(0xff, 0xff, 0xff, 0.06),
            pressed: srgba(0xff, 0xff, 0xff, 0.11),
            scrim: srgba(0x00, 0x00, 0x00, 0.56),
            code_bg: srgba(0x00, 0x00, 0x00, 0.30),
            selection_bg: accent.alpha(0.28),
            search_badges,
            caption,
            label,
            body,
            body_lg,
            title,
            code,
        }
    } else {
        let accent = srgb(0x66, 0x76, 0x3d);
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
            primary_fg: Color::WHITE,
            accent,
            accent_hover: srgb(0x5b, 0x6a, 0x35),
            accent_soft: accent.alpha(0.14),
            danger: srgb(0xbb, 0x3e, 0x3e),
            danger_hover: srgb(0xa7, 0x35, 0x35),
            danger_fg: Color::WHITE,
            success: srgb(0x3a, 0xb6, 0x65),
            warning: srgb(0xec, 0xaa, 0x0b),
            info: srgb(0x00, 0x7a, 0xff),
            border: srgba(0x1f, 0x1f, 0x1c, 0.12),
            border_muted: srgba(0x1f, 0x1f, 0x1c, 0.07),
            border_strong: srgba(0x1f, 0x1f, 0x1c, 0.22),
            focus_ring: accent,
            hover: srgba(0x1f, 0x1f, 0x1c, 0.05),
            pressed: srgba(0x1f, 0x1f, 0x1c, 0.10),
            scrim: srgba(0x1f, 0x1f, 0x1c, 0.36),
            code_bg: srgba(0x1f, 0x1f, 0x1c, 0.05),
            selection_bg: accent.alpha(0.24),
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

/// Builds a `rune_kit::Kit` configured with Cowork's semantic palette, typography, and radii,
/// paired with `ThemeTokens` for Cowork-specific tokens (such as `sidebar_bg` and search badges).
pub fn build_kit(
    dark: bool,
    reduced_transparency: bool,
    high_contrast: bool,
) -> (Kit, ThemeTokens) {
    let mut tok = tokens(dark);
    if reduced_transparency {
        tok.glass_bg = tok.panel_bg;
    }
    if high_contrast {
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
    kit.c.bg_accent = tok.accent;
    kit.c.submit_fg = tok.primary_fg;
    kit.c.submit_icon = tok.primary_fg;
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
