//! OS shell actions (reveal in file manager, open in default app with launchable warning,
//! trash path, external URL opening, and bounded remote/data image fetching).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cowork_config::{
    canonicalize_sync, cowork_home, env_map_from_process, get_one_off_chats_root, host_platform,
    resolve_home_dir,
};
use reqwest::header::{CONTENT_TYPE, LOCATION};
use url::Host;

use super::launchable_files::is_launchable_file;
use super::path_boundary::is_path_equal_or_inside;
use super::security::assert_allowed_external_url;
use super::validation::{assert_directory_entry_within_roots, assert_path_within_roots};

pub const DEFAULT_IMAGE_FETCH_MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenInDefaultAppOutcome {
    Opened,
    ConfirmationRequired { path: PathBuf, reason: String },
}

/// Computes directories allowed for reveal-in-OS (active workspaces + `~/.cowork` + bundled dist).
pub fn resolve_allowed_reveal_roots(workspace_roots: &[PathBuf]) -> Vec<PathBuf> {
    let env = env_map_from_process();
    let platform = host_platform();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let resources_dir = super::resolve_packaged_resources_dir_for(platform, exe_dir.as_deref());
    resolve_allowed_reveal_roots_with(workspace_roots, &env, platform, resources_dir.as_deref())
}

pub(crate) fn resolve_allowed_reveal_roots_with(
    workspace_roots: &[PathBuf],
    env: &HashMap<String, String>,
    platform: &str,
    resources_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = workspace_roots.to_vec();
    let home = resolve_home_dir(env, platform);
    let chats_dir = get_one_off_chats_root(&home);
    if !roots.iter().any(|r| is_path_equal_or_inside(r, &chats_dir)) {
        roots.push(chats_dir);
    }
    roots.push(cowork_home(env));
    if let Some(builtin) = env.get("COWORK_BUILTIN_DIR").map(|s| s.trim())
        && !builtin.is_empty()
    {
        roots.push(PathBuf::from(builtin));
    }
    if let Some(res) = resources_dir {
        let bundled_dist = res.join("dist");
        if bundled_dist.join("config").join("defaults.json").is_file()
            && !roots
                .iter()
                .any(|r| is_path_equal_or_inside(r, &bundled_dist))
        {
            roots.push(bundled_dist);
        }
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
    let safe_path = assert_path_within_roots(workspace_roots, requested_path, "path")?;

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
    let safe_path = assert_directory_entry_within_roots(workspace_roots, requested_path, "path")?;
    let is_root = workspace_roots
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
        if !mime.starts_with("image/") || mime == "image/svg+xml" {
            bail!("Blocked unsupported data URL image MIME type");
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

    let mut current_url =
        url::Url::parse(trimmed).map_err(|err| anyhow::anyhow!("Invalid image URL: {err}"))?;
    let mut hops = 0usize;

    let mut resp = loop {
        let pinned = validate_public_http_image_url(&current_url).await?;
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none());
        if let Some((domain, addr)) = pinned {
            builder = builder.resolve(&domain, addr);
        }
        let client = builder
            .build()
            .context("Failed to initialize HTTP client")?;
        let response = client
            .get(current_url.clone())
            .send()
            .await
            .context("Failed to fetch image URL")?;

        if response.status().is_redirection() {
            if hops >= MAX_IMAGE_REDIRECTS {
                bail!("Too many redirects while fetching image URL");
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Redirect missing Location header"))?;
            current_url = current_url
                .join(location)
                .map_err(|err| anyhow::anyhow!("Invalid redirect target URL: {err}"))?;
            hops += 1;
            continue;
        }

        break response;
    };

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
    let Some(ref mime) = mime_type else {
        bail!("Blocked image response without Content-Type header");
    };
    if !mime.starts_with("image/") || mime == "image/svg+xml" {
        bail!("Blocked non-raster image Content-Type: {mime}");
    }

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

fn is_publicly_routable_ipv4(v4: Ipv4Addr) -> bool {
    if v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
    {
        return false;
    }
    let [a, b, c, _d] = v4.octets();
    // Shared address space / CGNAT (100.64.0.0/10)
    if a == 100 && (64..=127).contains(&b) {
        return false;
    }
    // IETF protocol assignments (192.0.0.0/24)
    if a == 192 && b == 0 && c == 0 {
        return false;
    }
    // Benchmarking (198.18.0.0/15)
    if a == 198 && (b == 18 || b == 19) {
        return false;
    }
    // Reserved / future use (240.0.0.0/4)
    if a >= 240 {
        return false;
    }
    true
}

fn is_publicly_routable_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_publicly_routable_ipv4(v4),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_publicly_routable_ipv4(mapped);
            }
            if let Some(compat) = v6.to_ipv4() {
                return !v6.is_loopback()
                    && !v6.is_unspecified()
                    && is_publicly_routable_ipv4(compat);
            }
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return false;
            }
            let segs = v6.segments();
            // Unique Local Addresses (fc00::/7)
            if (segs[0] & 0xfe00) == 0xfc00 {
                return false;
            }
            // Link-local unicast (fe80::/10) and deprecated site-local (fec0::/10)
            if (segs[0] & 0xffc0) == 0xfe80 || (segs[0] & 0xffc0) == 0xfec0 {
                return false;
            }
            // Documentation prefix (2001:db8::/32)
            if segs[0] == 0x2001 && segs[1] == 0x0db8 {
                return false;
            }
            true
        }
    }
}

async fn validate_public_http_image_url(url: &url::Url) -> Result<Option<(String, SocketAddr)>> {
    if !matches!(url.scheme(), "http" | "https") {
        bail!("Unsupported image URL scheme: {}", url.scheme());
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("Blocked image URL containing embedded credentials");
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("Image URL missing valid port"))?;

    match url.host() {
        Some(Host::Ipv4(v4)) => {
            if !is_publicly_routable_ip(IpAddr::V4(v4)) {
                bail!("Blocked image fetch to private or reserved IP address");
            }
            Ok(None)
        }
        Some(Host::Ipv6(v6)) => {
            if !is_publicly_routable_ip(IpAddr::V6(v6)) {
                bail!("Blocked image fetch to private or reserved IP address");
            }
            Ok(None)
        }
        Some(Host::Domain(domain)) => {
            let trimmed = domain.trim_end_matches('.').to_ascii_lowercase();
            if trimmed == "localhost" || trimmed.ends_with(".localhost") {
                bail!("Blocked image fetch to localhost");
            }
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((domain, port))
                .await
                .with_context(|| format!("Failed to resolve image host {domain}"))?
                .collect();
            if resolved.is_empty() {
                bail!("Image host resolved to no addresses");
            }
            for addr in &resolved {
                if !is_publicly_routable_ip(addr.ip()) {
                    bail!(
                        "Blocked image fetch to non-public resolved address {}",
                        addr.ip()
                    );
                }
            }
            let preferred = resolved
                .iter()
                .copied()
                .find(|a| a.is_ipv4())
                .unwrap_or(resolved[0]);
            Ok(Some((domain.to_string(), preferred)))
        }
        None => bail!("Image URL missing host"),
    }
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

    #[tokio::test]
    async fn blocks_ssrf_private_loopback_and_svg_data_urls() {
        use std::net::Ipv6Addr;

        assert!(!is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::new(
            10, 0, 0, 1
        ))));
        assert!(!is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::new(
            172, 16, 0, 1
        ))));
        assert!(!is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::new(
            192, 168, 1, 1
        ))));
        assert!(!is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
        assert!(!is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::new(
            100, 64, 0, 1
        ))));
        assert!(!is_publicly_routable_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_publicly_routable_ip(IpAddr::V6(
            "fc00::1".parse().unwrap()
        )));
        assert!(!is_publicly_routable_ip(IpAddr::V6(
            "fe80::1".parse().unwrap()
        )));
        assert!(!is_publicly_routable_ip(IpAddr::V6(
            "::ffff:127.0.0.1".parse().unwrap()
        )));
        assert!(is_publicly_routable_ip(IpAddr::V4(Ipv4Addr::new(
            8, 8, 8, 8
        ))));
        assert!(is_publicly_routable_ip(IpAddr::V6(
            "2606:4700:4700::1111".parse().unwrap()
        )));

        for blocked in [
            "http://127.0.0.1:8080/a.png",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:8080/a.png",
            "http://localhost:7337/a.png",
            "https://user:pass@8.8.8.8/a.png",
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        ] {
            assert!(
                fetch_image_bytes(blocked, 1024).await.is_err(),
                "expected {blocked} to be rejected"
            );
        }
    }

    #[test]
    fn resolve_allowed_reveal_roots_includes_packaged_dist_when_present() {
        let dir = tempdir().unwrap();
        let res = dir.path().join("Resources");
        let dist_cfg = res.join("dist").join("config");
        std::fs::create_dir_all(&dist_cfg).unwrap();
        std::fs::write(dist_cfg.join("defaults.json"), "{}").unwrap();

        let env = HashMap::from([(
            "HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        let roots = resolve_allowed_reveal_roots_with(&[], &env, "linux", Some(&res));
        assert!(roots.contains(&res.join("dist")));
    }
}
