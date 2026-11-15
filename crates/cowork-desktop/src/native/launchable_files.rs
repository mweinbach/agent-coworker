//! Launchable/executable file detection matching
//! `apps/desktop/electron/services/launchableFiles.ts` so opening workspace files
//! in the OS default handler warns before executing scripts or installers.

use std::fs;
use std::path::Path;

use cowork_config::host_platform;

const WINDOWS_LAUNCHABLE_EXTENSIONS: &[&str] = &[
    ".appref-ms",
    ".application",
    ".bat",
    ".cmd",
    ".com",
    ".cpl",
    ".exe",
    ".gadget",
    ".hta",
    ".inf",
    ".jar",
    ".js",
    ".jse",
    ".library-ms",
    ".lnk",
    ".msc",
    ".msi",
    ".msix",
    ".msp",
    ".pif",
    ".ps1",
    ".reg",
    ".scf",
    ".scr",
    ".search-ms",
    ".settingcontent-ms",
    ".url",
    ".vbe",
    ".vbs",
    ".ws",
    ".wsc",
    ".wsf",
    ".wsh",
];

const DARWIN_LAUNCHABLE_EXTENSIONS: &[&str] = &[
    ".action",
    ".app",
    ".applescript",
    ".command",
    ".fileloc",
    ".inetloc",
    ".jar",
    ".mpkg",
    ".pkg",
    ".prefpane",
    ".scpt",
    ".scptd",
    ".terminal",
    ".tool",
    ".webloc",
    ".workflow",
];

const LINUX_LAUNCHABLE_EXTENSIONS: &[&str] = &[".appimage", ".desktop", ".jar", ".run"];

const SCRIPT_EXTENSIONS: &[&str] = &[
    ".ahk", ".au3", ".bash", ".csh", ".fish", ".ksh", ".lua", ".php", ".pl", ".pm", ".psm1", ".py",
    ".pyc", ".pyw", ".pyz", ".r", ".rb", ".sh", ".tcl", ".zsh",
];

fn launchable_extensions_for(platform: &str) -> &'static [&'static str] {
    match platform {
        "win32" | "windows" => WINDOWS_LAUNCHABLE_EXTENSIONS,
        "darwin" | "macos" => DARWIN_LAUNCHABLE_EXTENSIONS,
        _ => LINUX_LAUNCHABLE_EXTENSIONS,
    }
}

fn extract_basename(file_path: &Path) -> String {
    let raw = file_path.to_string_lossy();
    raw.rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string()
}

fn extract_lower_extension(file_name: &str) -> Option<String> {
    let dot = file_name.rfind('.')?;
    if dot == 0 || dot + 1 >= file_name.len() {
        return None;
    }
    Some(file_name[dot..].to_ascii_lowercase())
}

fn strip_windows_ads_and_trailing(name: &str) -> &str {
    // Strip NTFS alternate data stream `:stream:$DATA` if present, then trailing dots/spaces.
    let without_ads = name.split(':').next().unwrap_or(name);
    without_ads.trim_end_matches(['.', ' '])
}

fn launch_check_extensions(file_path: &Path, platform: &str) -> Vec<String> {
    let name = extract_basename(file_path);
    let mut out = Vec::new();
    if let Some(raw) = extract_lower_extension(&name) {
        out.push(raw);
    }
    if matches!(platform, "win32" | "windows") {
        let stripped = strip_windows_ads_and_trailing(&name);
        if let Some(cleaned) = extract_lower_extension(stripped)
            && !out.contains(&cleaned)
        {
            out.push(cleaned);
        }
    }
    out
}

/// Returns true if handing `file_path` to the OS default opener could execute code
/// rather than passively open a document. Fails closed if POSIX permissions cannot be read.
pub fn is_launchable_file(file_path: &Path) -> bool {
    is_launchable_file_for_platform(file_path, host_platform())
}

pub fn is_launchable_file_for_platform(file_path: &Path, platform: &str) -> bool {
    let launchable = launchable_extensions_for(platform);
    for ext in launch_check_extensions(file_path, platform) {
        if SCRIPT_EXTENSIONS.contains(&ext.as_str()) || launchable.contains(&ext.as_str()) {
            return true;
        }
    }

    if matches!(platform, "win32" | "windows") {
        return false;
    }

    match fs::metadata(file_path) {
        Ok(meta) => {
            if !meta.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                (meta.permissions().mode() & 0o111) != 0
            }
            #[cfg(not(unix))]
            {
                false
            }
        }
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn detects_platform_launchables_and_windows_ads() {
        assert!(is_launchable_file_for_platform(
            Path::new("/tmp/install.pkg"),
            "darwin"
        ));
        assert!(is_launchable_file_for_platform(
            Path::new("/tmp/script.sh"),
            "darwin"
        ));
        assert!(is_launchable_file_for_platform(
            Path::new("C:\\temp\\payload.bat::$DATA"),
            "win32"
        ));
        assert!(is_launchable_file_for_platform(
            Path::new("C:\\temp\\run.exe.  "),
            "win32"
        ));
        assert!(!is_launchable_file_for_platform(
            Path::new("C:\\temp\\readme.txt"),
            "win32"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn checks_posix_execute_bit_and_fails_closed_on_missing() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempdir().unwrap();
        let plain = tmp.path().join("notes.txt");
        let exec = tmp.path().join("tool");
        fs::write(&plain, "plain").unwrap();
        fs::write(&exec, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&exec, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(!is_launchable_file_for_platform(&plain, "darwin"));
        assert!(is_launchable_file_for_platform(&exec, "darwin"));
        assert!(is_launchable_file_for_platform(
            &tmp.path().join("missing-after-race"),
            "darwin"
        ));
    }
}
