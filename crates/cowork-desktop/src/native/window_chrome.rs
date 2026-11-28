//! Platform chrome contract, native glass eligibility, and shell background paint colors
//! matching `apps/desktop/electron/services/windowChrome/*` and `windowAppearancePaint.ts`.

use cowork_config::host_platform;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChromePlatform {
    Macos,
    Windows,
    Linux,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowsBackgroundMaterial {
    Mica,
    Acrylic,
    Tabbed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptionSymbolTone {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlatformChromeContract {
    pub platform: ChromePlatform,
    pub titlebar_height: f32,
    pub drag_strip_height: f32,
    pub left_native_reserve: f32,
    pub right_native_reserve: f32,
    pub caption_button_reserve: f32,
    pub collapsed_left_rail_width: f32,
    pub topbar_toolbar_gap: f32,
    pub traffic_light_position: Option<(f32, f32)>,
    pub window_material: Option<WindowsBackgroundMaterial>,
    pub uses_native_glass: bool,
    pub disable_css_blur: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowChromePaint {
    pub background_hex: String,
    pub windows_material: Option<WindowsBackgroundMaterial>,
    pub caption_symbol_tone: CaptionSymbolTone,
}

pub fn current_chrome_platform(platform: &str) -> ChromePlatform {
    match platform {
        "darwin" | "macos" => ChromePlatform::Macos,
        "win32" | "windows" => ChromePlatform::Windows,
        "linux" => ChromePlatform::Linux,
        _ => ChromePlatform::Other,
    }
}

pub fn should_use_macos_native_glass(
    platform: &str,
    env_override: Option<&str>,
    prefers_reduced_transparency: bool,
) -> bool {
    if current_chrome_platform(platform) != ChromePlatform::Macos || prefers_reduced_transparency {
        return false;
    }
    match env_override
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("0" | "false" | "no" | "off") => false,
        Some("1" | "true" | "yes" | "on") | None | Some("") => true,
        Some(_) => true,
    }
}

pub fn platform_chrome_contract(platform: &str) -> PlatformChromeContract {
    match current_chrome_platform(platform) {
        ChromePlatform::Macos => PlatformChromeContract {
            platform: ChromePlatform::Macos,
            titlebar_height: 38.0,
            drag_strip_height: 10.0,
            left_native_reserve: 86.0,
            right_native_reserve: 0.0,
            caption_button_reserve: 0.0,
            collapsed_left_rail_width: 0.0,
            topbar_toolbar_gap: 0.0,
            traffic_light_position: Some((14.0, 14.0)),
            window_material: None,
            uses_native_glass: true,
            disable_css_blur: true,
        },
        ChromePlatform::Windows => PlatformChromeContract {
            platform: ChromePlatform::Windows,
            titlebar_height: 48.0,
            drag_strip_height: 10.0,
            left_native_reserve: 0.0,
            right_native_reserve: 136.0,
            caption_button_reserve: 136.0,
            collapsed_left_rail_width: 84.0,
            topbar_toolbar_gap: 6.0,
            traffic_light_position: None,
            window_material: Some(WindowsBackgroundMaterial::Tabbed),
            uses_native_glass: false,
            disable_css_blur: false,
        },
        ChromePlatform::Linux => PlatformChromeContract {
            platform: ChromePlatform::Linux,
            titlebar_height: 48.0,
            drag_strip_height: 10.0,
            left_native_reserve: 0.0,
            right_native_reserve: 136.0,
            caption_button_reserve: 136.0,
            collapsed_left_rail_width: 84.0,
            topbar_toolbar_gap: 6.0,
            traffic_light_position: None,
            window_material: None,
            uses_native_glass: false,
            disable_css_blur: false,
        },
        ChromePlatform::Other => PlatformChromeContract {
            platform: ChromePlatform::Other,
            titlebar_height: 48.0,
            drag_strip_height: 10.0,
            left_native_reserve: 0.0,
            right_native_reserve: 0.0,
            caption_button_reserve: 0.0,
            collapsed_left_rail_width: 0.0,
            topbar_toolbar_gap: 0.0,
            traffic_light_position: None,
            window_material: None,
            uses_native_glass: false,
            disable_css_blur: false,
        },
    }
}

pub fn desktop_shell_background_hex(use_dark_colors: bool) -> &'static str {
    if use_dark_colors {
        "#121212"
    } else {
        "#fafafa"
    }
}

pub fn resolve_window_chrome_paint(
    platform: &str,
    use_dark_colors: bool,
    use_macos_native_glass: bool,
) -> WindowChromePaint {
    let contract = platform_chrome_contract(platform);
    let background_hex = if contract.platform == ChromePlatform::Macos && use_macos_native_glass {
        "#00000000".to_string()
    } else {
        desktop_shell_background_hex(use_dark_colors).to_string()
    };

    WindowChromePaint {
        background_hex,
        windows_material: contract.window_material,
        caption_symbol_tone: if use_dark_colors {
            CaptionSymbolTone::Light
        } else {
            CaptionSymbolTone::Dark
        },
    }
}

/// Maps Electron `COWORK_MACOS_NATIVE_GLASS` + reduced transparency into Rune window material.
pub fn recommended_rune_system_material(
    prefers_reduced_transparency: bool,
) -> Option<rune::SystemMaterial> {
    let env_glass = std::env::var("COWORK_MACOS_NATIVE_GLASS").ok();
    if should_use_macos_native_glass(
        host_platform(),
        env_glass.as_deref(),
        prefers_reduced_transparency,
    ) {
        Some(rune::SystemMaterial::Glass)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_platform_contracts_and_glass_paint() {
        let mac = platform_chrome_contract("darwin");
        assert_eq!(mac.traffic_light_position, Some((14.0, 14.0)));
        assert!(mac.uses_native_glass);

        let win = platform_chrome_contract("win32");
        assert_eq!(win.window_material, Some(WindowsBackgroundMaterial::Tabbed));
        assert_eq!(win.caption_button_reserve, 136.0);

        let mac_paint = resolve_window_chrome_paint("darwin", true, true);
        assert_eq!(mac_paint.background_hex, "#00000000");

        let linux_paint = resolve_window_chrome_paint("linux", false, false);
        assert_eq!(linux_paint.background_hex, "#fafafa");
        assert_eq!(linux_paint.caption_symbol_tone, CaptionSymbolTone::Dark);
    }
}
