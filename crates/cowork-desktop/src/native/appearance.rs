//! OS appearance detection and `appearance.json` theme preference storage
//! matching `apps/desktop/electron/services/appearance.ts` and `appearancePreferences.ts`.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Result;
use cowork_config::{ensure_private_dir_sync, host_platform, write_text_file_atomic};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::theme::ThemePreference;

const APPEARANCE_FILE_NAME: &str = "appearance.json";
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PersistedThemeSource {
    System,
    Light,
    Dark,
}

impl From<ThemePreference> for PersistedThemeSource {
    fn from(pref: ThemePreference) -> Self {
        match pref {
            ThemePreference::System => Self::System,
            ThemePreference::Light => Self::Light,
            ThemePreference::Dark => Self::Dark,
        }
    }
}

impl From<PersistedThemeSource> for ThemePreference {
    fn from(src: PersistedThemeSource) -> Self {
        match src {
            PersistedThemeSource::System => Self::System,
            PersistedThemeSource::Light => Self::Light,
            PersistedThemeSource::Dark => Self::Dark,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppearanceSnapshot {
    pub platform: String,
    pub theme_source: PersistedThemeSource,
    pub system_dark: bool,
    pub should_use_dark_colors: bool,
    pub prefers_reduced_transparency: bool,
}

impl SystemAppearanceSnapshot {
    pub fn from_preference(pref: ThemePreference, system_dark: bool) -> Self {
        let should_use_dark_colors = match pref {
            ThemePreference::System => system_dark,
            ThemePreference::Light => false,
            ThemePreference::Dark => true,
        };
        Self {
            platform: host_platform().to_string(),
            theme_source: pref.into(),
            system_dark,
            should_use_dark_colors,
            prefers_reduced_transparency: detect_reduced_transparency(),
        }
    }
}

/// Probes whether the host OS currently prefers dark appearance.
/// Runtime theme changes are also delivered automatically via Rune `Cx::system_dark()`.
pub fn detect_system_dark() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                return Some(stdout.trim().eq_ignore_ascii_case("Dark"));
            }
            // Key does not exist when macOS is in Light mode.
            return Some(false);
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .output()
            && output.status.success()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            if text.contains("0x0") {
                return Some(true);
            }
            if text.contains("0x1") {
                return Some(false);
            }
        }
        None
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(gtk_theme) = std::env::var("GTK_THEME") {
            let lower = gtk_theme.to_ascii_lowercase();
            if lower.contains("dark") {
                return Some(true);
            }
        }
        None
    }
}

static REDUCED_TRANSPARENCY: OnceLock<bool> = OnceLock::new();

pub fn detect_reduced_transparency() -> bool {
    *REDUCED_TRANSPARENCY.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            if let Ok(output) = Command::new("defaults")
                .args(["read", "com.apple.universalaccess", "reduceTransparency"])
                .output()
                && output.status.success()
            {
                let out = String::from_utf8_lossy(&output.stdout);
                return matches!(out.trim(), "1" | "true" | "YES");
            }
        }
        false
    })
}

/// Persists `appearance.json` atomically inside `user_data_dir`.
#[derive(Clone, Debug)]
pub struct AppearancePreferences {
    file_path: PathBuf,
    last_saved_theme: Arc<Mutex<Option<ThemePreference>>>,
}

impl AppearancePreferences {
    pub fn new(user_data_dir: &Path) -> Self {
        Self {
            file_path: user_data_dir.join(APPEARANCE_FILE_NAME),
            last_saved_theme: Arc::new(Mutex::new(None)),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    pub fn load_theme_preference(&self) -> ThemePreference {
        match fs::read_to_string(&self.file_path) {
            Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| v.get("themeSource").cloned())
                .and_then(|v| serde_json::from_value::<PersistedThemeSource>(v).ok())
                .map(ThemePreference::from)
                .unwrap_or_else(|| {
                    *self
                        .last_saved_theme
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    ThemePreference::System
                }),
            Err(err) if err.kind() == ErrorKind::NotFound => ThemePreference::System,
            Err(_) => ThemePreference::System,
        }
    }

    pub fn save_theme_preference(&self, pref: ThemePreference) -> Result<()> {
        if *self
            .last_saved_theme
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            == Some(pref)
        {
            return Ok(());
        }
        if let Some(parent) = self.file_path.parent() {
            ensure_private_dir_sync(parent)
                .map_err(|err| anyhow::anyhow!("Unable to create appearance directory: {err}"))?;
        }
        let source: PersistedThemeSource = pref.into();
        let payload = format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "themeSource": source }))?
        );
        write_text_file_atomic(&self.file_path, &payload, Some(PRIVATE_FILE_MODE))
            .map_err(|err| anyhow::anyhow!("Unable to write appearance preferences: {err}"))?;
        *self
            .last_saved_theme
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(pref);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn roundtrips_theme_preference_and_defaults_on_corrupt_file() {
        let tmp = tempdir().unwrap();
        let prefs = AppearancePreferences::new(tmp.path());
        assert_eq!(prefs.load_theme_preference(), ThemePreference::System);

        prefs.save_theme_preference(ThemePreference::Dark).unwrap();
        assert_eq!(prefs.load_theme_preference(), ThemePreference::Dark);

        fs::write(prefs.file_path(), "{corrupt json").unwrap();
        assert_eq!(prefs.load_theme_preference(), ThemePreference::System);
    }

    #[test]
    fn snapshot_resolves_effective_dark_mode() {
        let light = SystemAppearanceSnapshot::from_preference(ThemePreference::Light, true);
        assert!(!light.should_use_dark_colors);
        let dark = SystemAppearanceSnapshot::from_preference(ThemePreference::Dark, false);
        assert!(dark.should_use_dark_colors);
        let sys = SystemAppearanceSnapshot::from_preference(ThemePreference::System, true);
        assert!(sys.should_use_dark_colors);
    }
}
