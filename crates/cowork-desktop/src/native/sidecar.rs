//! Sidecar executable and built-in directory resolution for `cowork-server`.
//!
//! Replaces `apps/desktop/electron/services/{sidecar.ts, desktopBuiltinPaths.ts}`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SIDECAR_BASE_NAME: &str = "cowork-server";
pub const SIDECAR_MANIFEST_NAME: &str = "cowork-server-manifest.json";

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("Unsupported platform/arch for desktop sidecar: {0}/{1}")]
    UnsupportedHost(String, String),
    #[error("Bundled sidecar manifest is unreadable ({path}): {message}")]
    UnreadableManifest { path: PathBuf, message: String },
    #[error("Bundled sidecar manifest is invalid ({path}): {message}")]
    InvalidManifest { path: PathBuf, message: String },
    #[error(
        "Bundled sidecar manifest targets {manifest_target}, but host requires {host_target}: {path}"
    )]
    TargetMismatch {
        manifest_target: String,
        host_target: String,
        path: PathBuf,
    },
    #[error("Bundled sidecar manifest points to missing executable ({manifest_path} -> {target})")]
    MissingManifestTarget {
        manifest_path: PathBuf,
        target: String,
    },
    #[error("{0}")]
    NotFound(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarLaunchSpec {
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarManifest {
    pub target_triple: String,
    pub platform: String,
    pub arch: String,
    pub launch: SidecarLaunchSpec,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarLaunchCommand {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub target_triple: String,
    pub platform: String,
    pub arch: String,
    pub manifest_path: Option<PathBuf>,
}

/// Normalizes Rust `std::env::consts::OS` to Electron/manifest platform names (`win32`, `darwin`, `linux`).
pub fn current_host_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

/// Normalizes Rust `std::env::consts::ARCH` to Node/manifest arch names (`x64`, `arm64`).
pub fn current_host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// Resolves the Rust target triple matching `(platform, arch)`.
pub fn resolve_desktop_target_triple(platform: &str, arch: &str) -> Result<String, SidecarError> {
    let norm_platform = match platform {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let norm_arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };

    match (norm_platform, norm_arch) {
        ("win32", "x64") => Ok("x86_64-pc-windows-msvc".to_string()),
        ("win32", "arm64") => Ok("aarch64-pc-windows-msvc".to_string()),
        ("darwin", "x64") => Ok("x86_64-apple-darwin".to_string()),
        ("darwin", "arm64") => Ok("aarch64-apple-darwin".to_string()),
        ("linux", "x64") => Ok("x86_64-unknown-linux-gnu".to_string()),
        ("linux", "arm64") => Ok("aarch64-unknown-linux-gnu".to_string()),
        _ => Err(SidecarError::UnsupportedHost(
            platform.to_string(),
            arch.to_string(),
        )),
    }
}

/// Returns the packaged sidecar binary filename for `(platform, arch)`.
pub fn resolve_packaged_sidecar_filename(
    platform: &str,
    arch: &str,
) -> Result<String, SidecarError> {
    let triple = resolve_desktop_target_triple(platform, arch)?;
    let ext = if platform == "win32" || platform == "windows" {
        ".exe"
    } else {
        ""
    };
    Ok(format!("{SIDECAR_BASE_NAME}-{triple}{ext}"))
}

/// Finds a packaged sidecar launch command inside `search_dirs` (or `explicit_path`).
pub fn find_packaged_sidecar_launch_command(
    search_dirs: &[PathBuf],
    explicit_path: Option<&Path>,
    platform: &str,
    arch: &str,
) -> Result<SidecarLaunchCommand, SidecarError> {
    let target_triple = resolve_desktop_target_triple(platform, arch)?;
    let mut dirs_to_search: Vec<PathBuf> = Vec::new();

    if let Some(explicit) = explicit_path
        && !explicit.as_os_str().is_empty()
        && explicit.exists()
    {
        if !explicit.is_dir() {
            return Ok(SidecarLaunchCommand {
                command: explicit.to_path_buf(),
                args: Vec::new(),
                target_triple,
                platform: platform.to_string(),
                arch: arch.to_string(),
                manifest_path: None,
            });
        }
        dirs_to_search.push(explicit.to_path_buf());
    }
    dirs_to_search.extend(search_dirs.iter().cloned());

    let expected_filename = resolve_packaged_sidecar_filename(platform, arch)?;
    let mut found_candidates = BTreeSet::new();

    for dir in &dirs_to_search {
        if !dir.is_dir() {
            continue;
        }

        let manifest_path = dir.join(SIDECAR_MANIFEST_NAME);
        if manifest_path.is_file() {
            let raw = std::fs::read_to_string(&manifest_path).map_err(|err| {
                SidecarError::UnreadableManifest {
                    path: manifest_path.clone(),
                    message: err.to_string(),
                }
            })?;
            let manifest: SidecarManifest =
                serde_json::from_str(&raw).map_err(|err| SidecarError::InvalidManifest {
                    path: manifest_path.clone(),
                    message: err.to_string(),
                })?;

            if manifest.launch.kind != "executable" || manifest.launch.path.trim().is_empty() {
                return Err(SidecarError::InvalidManifest {
                    path: manifest_path,
                    message: "launch.kind must be 'executable' with non-empty launch.path".into(),
                });
            }

            if manifest.platform != platform
                || manifest.arch != arch
                || manifest.target_triple != target_triple
            {
                return Err(SidecarError::TargetMismatch {
                    manifest_target: format!(
                        "{}/{} ({})",
                        manifest.platform, manifest.arch, manifest.target_triple
                    ),
                    host_target: format!("{platform}/{arch} ({target_triple})"),
                    path: manifest_path,
                });
            }

            let target = Path::new(&manifest.launch.path);
            let command = if target.is_absolute() {
                target.to_path_buf()
            } else {
                dir.join(target)
            };
            if !command.exists() {
                return Err(SidecarError::MissingManifestTarget {
                    manifest_path,
                    target: manifest.launch.path,
                });
            }

            return Ok(SidecarLaunchCommand {
                command,
                args: manifest.launch.args,
                target_triple: manifest.target_triple,
                platform: manifest.platform,
                arch: manifest.arch,
                manifest_path: Some(manifest_path),
            });
        }

        let exact = dir.join(&expected_filename);
        if exact.is_file() {
            return Ok(SidecarLaunchCommand {
                command: exact,
                args: Vec::new(),
                target_triple,
                platform: platform.to_string(),
                arch: arch.to_string(),
                manifest_path: None,
            });
        }

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str == SIDECAR_BASE_NAME || name_str.starts_with("cowork-server-") {
                    found_candidates.insert(entry.path().to_string_lossy().into_owned());
                }
            }
        }
    }

    let found_summary = if found_candidates.is_empty() {
        String::new()
    } else {
        format!(
            " Found candidates: {}",
            found_candidates.into_iter().collect::<Vec<_>>().join(", ")
        )
    };
    let searched = dirs_to_search
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ");
    Err(SidecarError::NotFound(format!(
        "Server sidecar launch target not found. Expected {expected_filename} in {searched}.{found_summary}"
    )))
}

/// Locates the workspace repository root during dev launches.
pub fn resolve_dev_repo_root(
    env: &HashMap<String, String>,
    current_exe_dir: Option<&Path>,
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(explicit) = env
        .get("COWORK_REPO_ROOT")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let path = PathBuf::from(explicit);
        if path.join("Cargo.toml").is_file() {
            return Some(path);
        }
    }

    let mut seeds = Vec::new();
    if let Some(dir) = cwd {
        seeds.push(dir.to_path_buf());
    }
    if let Some(exe_dir) = current_exe_dir {
        seeds.push(exe_dir.to_path_buf());
    }

    for seed in seeds {
        let mut cursor: Option<&Path> = Some(seed.as_path());
        while let Some(dir) = cursor {
            if dir.join("Cargo.toml").is_file()
                && dir.join("config").join("defaults.json").is_file()
            {
                return Some(dir.to_path_buf());
            }
            cursor = dir.parent();
        }
    }
    None
}

/// Resolves the sidecar command across explicit override, packaged bundle, sibling binary, and Cargo targets.
pub fn find_sidecar_launch_command(
    is_packaged: bool,
    resources_dir: Option<&Path>,
    current_exe_dir: Option<&Path>,
    repo_root: Option<&Path>,
    env: &HashMap<String, String>,
) -> Result<SidecarLaunchCommand, SidecarError> {
    let platform = current_host_platform();
    let arch = current_host_arch();
    let target_triple = resolve_desktop_target_triple(platform, arch)?;
    let explicit_path = env
        .get("COWORK_DESKTOP_SIDECAR_PATH")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let mut search_dirs = Vec::new();
    if is_packaged {
        if let Some(res) = resources_dir {
            search_dirs.push(res.join("binaries"));
            search_dirs.push(res.to_path_buf());
        }
    } else if let Some(root) = repo_root {
        search_dirs.push(root.join("dist").join("binaries"));
    }
    if let Some(exe_dir) = current_exe_dir
        && !search_dirs.contains(&exe_dir.to_path_buf())
    {
        search_dirs.push(exe_dir.to_path_buf());
    }

    let packaged_result = find_packaged_sidecar_launch_command(
        &search_dirs,
        explicit_path.as_deref(),
        platform,
        arch,
    );
    if packaged_result.is_ok() || is_packaged || explicit_path.is_some() {
        return packaged_result;
    }

    let exe_name = if platform == "win32" {
        "cowork-server.exe"
    } else {
        "cowork-server"
    };

    if let Some(exe_dir) = current_exe_dir {
        let sibling = exe_dir.join(exe_name);
        if sibling.is_file() {
            return Ok(SidecarLaunchCommand {
                command: sibling,
                args: Vec::new(),
                target_triple,
                platform: platform.to_string(),
                arch: arch.to_string(),
                manifest_path: None,
            });
        }
    }

    if let Some(root) = repo_root {
        let cargo_candidates = [
            root.join("target")
                .join(&target_triple)
                .join("release")
                .join(exe_name),
            root.join("target").join("release").join(exe_name),
            root.join("target")
                .join(&target_triple)
                .join("debug")
                .join(exe_name),
            root.join("target").join("debug").join(exe_name),
        ];
        for candidate in cargo_candidates {
            if candidate.is_file() {
                return Ok(SidecarLaunchCommand {
                    command: candidate,
                    args: Vec::new(),
                    target_triple,
                    platform: platform.to_string(),
                    arch: arch.to_string(),
                    manifest_path: None,
                });
            }
        }
    }

    packaged_result
}

/// Resolves the `COWORK_BUILTIN_DIR` directory containing `config/defaults.json` and bundled skills.
pub fn resolve_builtin_dir_for_sidecar(
    is_packaged: bool,
    resources_dir: Option<&Path>,
    repo_root: Option<&Path>,
    env: &HashMap<String, String>,
) -> Result<Option<PathBuf>, SidecarError> {
    if is_packaged {
        let Some(res) = resources_dir else {
            return Err(SidecarError::NotFound(
                "Bundled resources directory not configured for packaged build.".into(),
            ));
        };
        let dist = res.join("dist");
        if dist.is_dir() {
            return Ok(Some(dist));
        }
        return Err(SidecarError::NotFound(format!(
            "Bundled dist directory not found: {}",
            dist.display()
        )));
    }

    if let Some(explicit) = env
        .get("COWORK_BUILTIN_DIR")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return Ok(Some(PathBuf::from(explicit)));
    }

    if let Some(root) = repo_root {
        if root.join("config").join("defaults.json").is_file() {
            return Ok(Some(root.to_path_buf()));
        }
        let dist = root.join("dist");
        if dist.join("config").join("defaults.json").is_file() {
            return Ok(Some(dist));
        }
    }

    Ok(cowork_config::resolve_builtin_dir(env).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_target_triples_across_platforms() {
        assert_eq!(
            resolve_desktop_target_triple("darwin", "arm64").unwrap(),
            "aarch64-apple-darwin"
        );
        assert_eq!(
            resolve_desktop_target_triple("win32", "x64").unwrap(),
            "x86_64-pc-windows-msvc"
        );
        assert_eq!(
            resolve_desktop_target_triple("linux", "x64").unwrap(),
            "x86_64-unknown-linux-gnu"
        );
        assert!(resolve_desktop_target_triple("plan9", "mips").is_err());
    }

    #[test]
    fn finds_packaged_sidecar_via_manifest_and_rejects_mismatch() {
        let tmp = tempdir().unwrap();
        let bin_dir = tmp.path().join("binaries");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let exe_path = bin_dir.join("cowork-server-aarch64-apple-darwin");
        std::fs::write(&exe_path, "stub").unwrap();

        let manifest = SidecarManifest {
            target_triple: "aarch64-apple-darwin".into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
            launch: SidecarLaunchSpec {
                kind: "executable".into(),
                path: "cowork-server-aarch64-apple-darwin".into(),
                args: vec!["--flag".into()],
            },
        };
        std::fs::write(
            bin_dir.join(SIDECAR_MANIFEST_NAME),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        let found = find_packaged_sidecar_launch_command(
            std::slice::from_ref(&bin_dir),
            None,
            "darwin",
            "arm64",
        )
        .unwrap();
        assert_eq!(found.command, exe_path);
        assert_eq!(found.args, vec!["--flag"]);

        let mismatch = find_packaged_sidecar_launch_command(&[bin_dir], None, "linux", "x64");
        assert!(matches!(mismatch, Err(SidecarError::TargetMismatch { .. })));
    }

    #[test]
    fn finds_dev_cargo_target_and_builtin_dir() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("config")).unwrap();
        std::fs::write(root.join("config").join("defaults.json"), "{}").unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]").unwrap();

        let debug_dir = root.join("target").join("debug");
        std::fs::create_dir_all(&debug_dir).unwrap();
        let exe_name = if cfg!(target_os = "windows") {
            "cowork-server.exe"
        } else {
            "cowork-server"
        };
        let exe = debug_dir.join(exe_name);
        std::fs::write(&exe, "bin").unwrap();

        let cmd =
            find_sidecar_launch_command(false, None, None, Some(root), &HashMap::new()).unwrap();
        assert_eq!(cmd.command, exe);

        let builtin =
            resolve_builtin_dir_for_sidecar(false, None, Some(root), &HashMap::new()).unwrap();
        assert_eq!(builtin.as_deref(), Some(root));
    }

    #[test]
    fn finds_dev_staged_sidecar_in_neutral_dist_binaries() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let platform = current_host_platform();
        let arch = current_host_arch();
        let triple = resolve_desktop_target_triple(platform, arch).unwrap();
        let filename = resolve_packaged_sidecar_filename(platform, arch).unwrap();

        let staged_dir = root.join("dist").join("binaries");
        std::fs::create_dir_all(&staged_dir).unwrap();
        let staged_bin = staged_dir.join(&filename);
        std::fs::write(&staged_bin, "staged-bin").unwrap();
        let manifest = SidecarManifest {
            target_triple: triple,
            platform: platform.into(),
            arch: arch.into(),
            launch: SidecarLaunchSpec {
                kind: "executable".into(),
                path: filename,
                args: Vec::new(),
            },
        };
        std::fs::write(
            staged_dir.join(SIDECAR_MANIFEST_NAME),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        let cmd =
            find_sidecar_launch_command(false, None, None, Some(root), &HashMap::new()).unwrap();
        assert_eq!(cmd.command, staged_bin);
        assert_eq!(
            cmd.manifest_path,
            Some(staged_dir.join(SIDECAR_MANIFEST_NAME))
        );
    }
}
