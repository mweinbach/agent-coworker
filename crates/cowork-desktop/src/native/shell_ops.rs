//! OS shell actions (reveal in file manager, open in default app with launchable warning,
//! trash path, external URL opening, and bounded remote/data image fetching).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cowork_config::{canonicalize_sync, cowork_home, env_map_from_process, host_platform};
use reqwest::header::CONTENT_TYPE;

use super::explorer::explorer_allowed_roots;
use super::launchable_files::is_launchable_file;
use super::security::assert_allowed_external_url;
use super::validation::{assert_directory_entry_within_roots, assert_path_within_roots};

pub const DEFAULT_IMAGE_FETCH_MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenInDefaultAppOutcome {
    Opened,
    ConfirmationRequired { path: PathBuf, reason: String },
}

/// Computes directories allowed for reveal-in-OS (active workspaces + `~/.cowork` + bundled dist).
pub fn resolve_allowed_reveal_roots(workspace_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = explorer_allowed_roots(workspace_roots);
    let env = env_map_from_process();
    roots.push(cowork_home(&env));
    if let Some(builtin) = env.get("COWORK_BUILTIN_DIR").map(|s| s.trim())
        && !builtin.is_empty()
    {
        roots.push(PathBuf::from(builtin));
    }
    roots
}

fn spawn_detached_os_command(program: &str, args: &[String]) -> Result<()> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("Failed to launch {program}"))?;
    Ok(())
}

/// Opens the OS file manager highlighting `requested_path`.
pub fn reveal_in_os(workspace_roots: &[PathBuf], requested_path: &Path) -> Result<()> {
    let roots = resolve_allowed_reveal_roots(workspace_roots);
    let safe_path = assert_path_within_roots(&roots, requested_path, "path")?;
    let path_str = safe_path.to_string_lossy().into_owned();

    match host_platform() {
        "darwin" => spawn_detached_os_command("open", &["-R".to_string(), path_str]),
        "win32" => spawn_detached_os_command("explorer", &[format!("/select,{path_str}")]),
        _ => {
            let target = if safe_path.is_dir() {
                path_str
            } else {
                safe_path
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or(path_str)
            };
            spawn_detached_os_command("xdg-open", &[target])
        }
    }
}

/// Opens a workspace file in the OS default application.
/// Refuses to silently execute launchable scripts/binaries unless `confirmed_launchable` is true.
pub fn open_in_default_app(
    workspace_roots: &[PathBuf],
    requested_path: &Path,
    confirmed_launchable: bool,
) -> Result<OpenInDefaultAppOutcome> {
    let roots = explorer_allowed_roots(workspace_roots);
    let safe_path = assert_path_within_roots(&roots, requested_path, "path")?;

    if is_launchable_file(&safe_path) && !confirmed_launchable {
        let name = safe_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("This file");
        return Ok(OpenInDefaultAppOutcome::ConfirmationRequired {
            path: safe_path.clone(),
            reason: format!(
                "\"{name}\" can run programs on this computer. Opening it runs it outside Cowork's sandbox."
            ),
        });
    }

    let path_str = safe_path.to_string_lossy().into_owned();
    match host_platform() {
        "darwin" => spawn_detached_os_command("open", &[path_str])?,
        "win32" => {
            spawn_detached_os_command("cmd", &["/C".into(), "start".into(), "".into(), path_str])?
        }
        _ => spawn_detached_os_command("xdg-open", &[path_str])?,
    }

    Ok(OpenInDefaultAppOutcome::Opened)
}

/// Moves a workspace file or folder (never a workspace root itself) to the OS trash.
pub fn trash_workspace_entry(workspace_roots: &[PathBuf], requested_path: &Path) -> Result<()> {
    let roots = explorer_allowed_roots(workspace_roots);
    let safe_path = assert_directory_entry_within_roots(&roots, requested_path, "path")?;
    let is_root = roots
        .iter()
        .any(|root| canonicalize_sync(root) == safe_path);
    if is_root {
        bail!("Cannot move an approved workspace root to Trash.");
    }
    trash::delete(&safe_path).map_err(|err| anyhow::anyhow!("Unable to move to Trash: {err}"))?;
    Ok(())
}

/// Opens an allowlisted external URL (`http:`, `https:`, `mailto:`) via the OS handler.
pub fn open_external_url_os(raw_url: &str) -> Result<()> {
    let parsed = assert_allowed_external_url(raw_url)?;
    let url_str = parsed.to_string();
    match host_platform() {
        "darwin" => spawn_detached_os_command("open", &[url_str]),
        "win32" => {
            spawn_detached_os_command("cmd", &["/C".into(), "start".into(), "".into(), url_str])
        }
        _ => spawn_detached_os_command("xdg-open", &[url_str]),
    }
}

fn decode_base64_bytes(input: &str) -> Result<Vec<u8>> {
    fn val(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !cleaned.len().is_multiple_of(4) {
        bail!("Invalid base64 payload length");
    }

    let mut out = Vec::with_capacity((cleaned.len() / 4) * 3);
    for chunk in cleaned.chunks_exact(4) {
        let a = val(chunk[0]).ok_or_else(|| anyhow::anyhow!("Invalid base64 character"))?;
        let b = val(chunk[1]).ok_or_else(|| anyhow::anyhow!("Invalid base64 character"))?;
        let c = if chunk[2] == b'=' {
            None
        } else {
            Some(val(chunk[2]).ok_or_else(|| anyhow::anyhow!("Invalid base64 character"))?)
        };
        let d = if chunk[3] == b'=' {
            None
        } else {
            Some(val(chunk[3]).ok_or_else(|| anyhow::anyhow!("Invalid base64 character"))?)
        };

        out.push((a << 2) | (b >> 4));
        if let Some(c_val) = c {
            out.push((b << 4) | (c_val >> 2));
            if let Some(d_val) = d {
                out.push((c_val << 6) | d_val);
            }
        } else if d.is_some() {
            bail!("Invalid base64 padding");
        }
    }
    Ok(out)
}

/// Fetches bounded image bytes for native views from `http:`, `https:`, or `data:image/...;base64,`.
pub async fn fetch_image_bytes(
    raw_url: &str,
    max_bytes: usize,
) -> Result<(Option<String>, Vec<u8>)> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        bail!("Image URL must not be empty");
    }

    if let Some(rest) = trimmed.strip_prefix("data:") {
        let Some((header, payload)) = rest.split_once(',') else {
            bail!("Malformed data URL");
        };
        if !header.ends_with(";base64") {
            bail!("Only base64-encoded image data URLs are supported");
        }
        let mime = header
            .strip_suffix(";base64")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !mime.starts_with("image/") {
            bail!("Blocked non-image data URL MIME type");
        }
        if payload.len() > max_bytes.saturating_mul(2) {
            bail!("Data URL image exceeds maximum byte limit");
        }
        let bytes = decode_base64_bytes(payload)?;
        if bytes.len() > max_bytes {
            bail!("Image exceeds maximum size ({max_bytes} bytes)");
        }
        return Ok((Some(mime), bytes));
    }

    let parsed =
        url::Url::parse(trimmed).map_err(|err| anyhow::anyhow!("Invalid image URL: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("Unsupported image URL scheme: {}", parsed.scheme());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .context("Failed to initialize HTTP client")?;
    let mut resp = client
        .get(parsed)
        .send()
        .await
        .context("Failed to fetch image URL")?;
    if !resp.status().is_success() {
        bail!("Image request returned HTTP {}", resp.status().as_u16());
    }

    let mime_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|s| !s.is_empty());
    if let Some(len) = resp.content_length()
        && len as usize > max_bytes
    {
        bail!("Image exceeds maximum size ({max_bytes} bytes)");
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            bail!("Image exceeds maximum size ({max_bytes} bytes)");
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok((mime_type, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_in_default_app_requires_confirmation_for_launchable_scripts() {
        let ws = tempdir().unwrap();
        let script = ws.path().join("run.sh");
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        let roots = vec![ws.path().to_path_buf()];

        let outcome = open_in_default_app(&roots, &script, false).unwrap();
        assert!(matches!(
            outcome,
            OpenInDefaultAppOutcome::ConfirmationRequired { .. }
        ));
    }

    #[test]
    fn trash_refuses_workspace_root_itself() {
        let ws = tempdir().unwrap();
        let roots = vec![ws.path().to_path_buf()];
        let err = trash_workspace_entry(&roots, ws.path())
            .unwrap_err()
            .to_string();
        assert!(err.contains("workspace root"));
    }

    #[tokio::test]
    async fn fetch_image_bytes_decodes_base64_and_rejects_bad_schemes() {
        let (mime, bytes) = fetch_image_bytes("data:image/png;base64,aGVsbG8=", 1024)
            .await
            .unwrap();
        assert_eq!(mime.as_deref(), Some("image/png"));
        assert_eq!(bytes, b"hello");

        let err = fetch_image_bytes("file:///etc/passwd", 1024)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("Unsupported"));
    }
}
