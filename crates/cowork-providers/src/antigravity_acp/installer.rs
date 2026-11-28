//! Cowork-managed Antigravity ACP runtime installer & isolation (`antigravity-acp`).
//!
//! Fetches the official release manifest (`{manifest_base_url}/manifests/{platform}.json`),
//! downloads the pinned archive/executable (`1.5.14`), verifies its SHA-512 digest against the
//! repo-pinned checksum table BEFORE extraction/promotion/execution, promotes it atomically into
//! `~/.cowork/antigravity-acp`, and isolates all runtime auth/config state under
//! `~/.cowork/auth/antigravity-acp`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use uuid::Uuid;

use crate::credential_proxy::merge_loopback_no_proxy;
use crate::managed_runtime::{
    ChecksumAlgorithm, DEFAULT_MAX_METADATA_BYTES, DEFAULT_METADATA_TIMEOUT,
    InstalledManagedBinary, ManagedRuntimeInstallStatus, ManagedRuntimeTarget,
    atomic_promote_managed_runtime, build_install_http_client, build_isolated_runtime_env,
    download_and_verify, extract_executable_from_tar_gz, fetch_bounded_bytes,
    in_flight_install_lock, managed_executable_path, managed_runtime_root,
    promote_existing_managed_runtime, resolve_managed_runtime_status, validate_download_limits,
};

pub const ANTIGRAVITY_ACP_MANAGED_VERSION: &str = "1.5.14";
const DEFAULT_ANTIGRAVITY_MANIFEST_BASE_URL: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const ANTIGRAVITY_RUNTIME_DIR: &str = "antigravity-acp";
const ANTIGRAVITY_DISPLAY_NAME: &str = "Antigravity ACP";
const ANTIGRAVITY_EXE_BASENAME: &str = "antigravity";
const ANTIGRAVITY_USER_AGENT: &str = "agent-coworker-antigravity-acp-runtime";

type AntigravityArtifactEntry = (&'static str, &'static str, &'static str);
type AntigravityVersionArtifacts = (&'static str, &'static [AntigravityArtifactEntry]);

/// Repo-pinned SHA-512 checksums + verified GCS release URLs for Antigravity CLI `1.5.14`.
/// Verified against `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{platform}.json`.
const ANTIGRAVITY_MANAGED_ARTIFACTS: &[AntigravityVersionArtifacts] = &[(
    "1.5.14",
    &[
        (
            "darwin_arm64",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-arm/cli_mac_arm64.tar.gz",
            "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6",
        ),
        (
            "darwin_amd64",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-x64/cli_mac_x64.tar.gz",
            "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7",
        ),
        (
            "linux_amd64",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64/cli_linux_x64.tar.gz",
            "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9",
        ),
        (
            "linux_arm64",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm/cli_linux_arm64.tar.gz",
            "c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463",
        ),
        (
            "linux_amd64_musl",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64-musl/cli_linux_x64_musl.tar.gz",
            "1da24922727c5b4e84369d0843575d7d6f180a1946e2dc4289171ad1e3ca92594e687724d1902a7d83e407f98f0a8d3b7c3e976f03680fd80dbed2d2da00c0ed",
        ),
        (
            "linux_arm64_musl",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
            "f6e35fc3dab2cd49fd4296ddee0841b9cc4c7020b6c6aaea6452c5b3452b0ad8d66451c9098e418ad6b2f6eabcc81cdf13105ed043903248b11d6fb24ae709ab",
        ),
        (
            "windows_amd64",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/windows-x64/cli_windows_x64.exe",
            "785548b23242ec9112759bb4b525d94a3d4d2e9868e5cedb9ea34e5ce01dbb00abf5de66c41d8f4903e8a4379445f685483f999ece91867bfbd9d4812760d835",
        ),
        (
            "windows_arm64",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/windows-arm/cli_windows_arm64.exe",
            "b2ce5462cf1845b25c05ca651b5bd93735fd807f8e7b40c61d0e99445df1a76b97ee24c890d5f5ba0453f848ca174f74d492ad1901a2ddcba5d7a9b4399ddfef",
        ),
    ],
)];

#[derive(Debug, Clone)]
pub struct AntigravityAcpInstallOptions {
    pub manifest_base_url: String,
    pub target: Option<ManagedRuntimeTarget>,
    /// Test-only replacement for pinned SHA-512 checksums keyed by Antigravity platform key.
    pub expected_checksums: Option<HashMap<String, String>>,
    pub download_timeout: Option<Duration>,
    pub max_download_bytes: Option<u64>,
}

impl AntigravityAcpInstallOptions {
    pub fn from_env(env: &HashMap<String, String>) -> Self {
        let base = env
            .get("COWORK_ANTIGRAVITY_MANIFEST_BASE_URL")
            .map(|v| v.trim().trim_end_matches('/').to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_ANTIGRAVITY_MANIFEST_BASE_URL.to_owned());
        Self {
            manifest_base_url: base,
            target: None,
            expected_checksums: None,
            download_timeout: None,
            max_download_bytes: None,
        }
    }

    fn resolved_target(&self) -> Result<ManagedRuntimeTarget, String> {
        match &self.target {
            Some(t) => ManagedRuntimeTarget::new(&t.platform, &t.arch, t.is_musl),
            None => ManagedRuntimeTarget::host(),
        }
    }

    fn expected_checksum(&self, version: &str, platform_key: &str) -> Option<String> {
        if let Some(overrides) = &self.expected_checksums {
            return overrides.get(platform_key).cloned();
        }
        pinned_antigravity_artifact(version, platform_key).map(|(_, sum)| sum.to_owned())
    }
}

pub fn antigravity_platform_key(target: &ManagedRuntimeTarget) -> Result<&'static str, String> {
    match (
        target.platform.as_str(),
        target.arch.as_str(),
        target.is_musl,
    ) {
        ("darwin", "arm64", _) => Ok("darwin_arm64"),
        ("darwin", "x64", _) => Ok("darwin_amd64"),
        ("linux", "x64", false) => Ok("linux_amd64"),
        ("linux", "arm64", false) => Ok("linux_arm64"),
        ("linux", "x64", true) => Ok("linux_amd64_musl"),
        ("linux", "arm64", true) => Ok("linux_arm64_musl"),
        ("win32", "x64", _) => Ok("windows_amd64"),
        ("win32", "arm64", _) => Ok("windows_arm64"),
        (p, a, _) => Err(format!("Unsupported Antigravity ACP target: {p}/{a}")),
    }
}

pub fn pinned_antigravity_artifact(
    version: &str,
    platform_key: &str,
) -> Option<(&'static str, &'static str)> {
    ANTIGRAVITY_MANAGED_ARTIFACTS
        .iter()
        .find(|(v, _)| *v == version)
        .and_then(|(_, entries)| entries.iter().find(|(k, _, _)| *k == platform_key))
        .map(|(_, url, sha512)| (*url, *sha512))
}

/// Isolated Cowork-managed Antigravity ACP auth/config home (`<cowork_home>/auth/antigravity-acp`).
pub fn resolve_antigravity_acp_home(cowork_home: &Path) -> PathBuf {
    cowork_home.join("auth").join("antigravity-acp")
}

/// Ephemeral loopback credential-proxy endpoint and placeholder token supplied to the
/// managed `antigravity acp` subprocess so the real Gemini API key never enters the CLI
/// or native tool child environments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityProxyAuth {
    pub base_url: String,
    pub proxy_token: String,
}

/// Builds the isolated environment for `antigravity acp`:
/// - Creates `<cowork_home>/auth/antigravity-acp` (`0700`).
/// - Strips inherited `ANTIGRAVITY_*`, `AGY_*`, `GEMINI_*`, `GOOGLE_API_KEY`,
///   `GOOGLE_GEMINI_*`, cross-provider API keys, and `COWORK_DESKTOP_PARENT_MANAGED`.
/// - Pins `ANTIGRAVITY_HOME`, `ANTIGRAVITY_CONFIG_DIR`, and `XDG_{CONFIG,DATA,CACHE}_HOME`.
/// - When [`AntigravityProxyAuth`] is provided, injects ONLY the ephemeral loopback proxy URL
///   (`GOOGLE_GEMINI_BASE_URL`) and per-turn placeholder key (`GEMINI_API_KEY`/`GOOGLE_API_KEY`)
///   plus loopback `NO_PROXY` entries — never the saved account credential.
pub fn build_antigravity_acp_spawn_env(
    cowork_home: &Path,
    parent_env: &HashMap<String, String>,
    proxy_auth: Option<&AntigravityProxyAuth>,
) -> HashMap<String, String> {
    let auth_home = resolve_antigravity_acp_home(cowork_home);
    let auth_str = auth_home.to_string_lossy().into_owned();
    let mut set_vars = vec![
        ("ANTIGRAVITY_HOME".to_owned(), auth_str.clone()),
        ("ANTIGRAVITY_CONFIG_DIR".to_owned(), auth_str.clone()),
        (
            "XDG_CONFIG_HOME".to_owned(),
            auth_home.join("config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_DATA_HOME".to_owned(),
            auth_home.join("data").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CACHE_HOME".to_owned(),
            auth_home.join("cache").to_string_lossy().into_owned(),
        ),
    ];
    if let Some(proxy) = proxy_auth {
        set_vars.push(("GOOGLE_GEMINI_BASE_URL".to_owned(), proxy.base_url.clone()));
        set_vars.push(("GEMINI_API_KEY".to_owned(), proxy.proxy_token.clone()));
        set_vars.push(("GOOGLE_API_KEY".to_owned(), proxy.proxy_token.clone()));
        let existing_no_proxy = parent_env
            .get("NO_PROXY")
            .or_else(|| parent_env.get("no_proxy"))
            .map(String::as_str);
        let merged_no_proxy = merge_loopback_no_proxy(existing_no_proxy);
        set_vars.push(("NO_PROXY".to_owned(), merged_no_proxy.clone()));
        set_vars.push(("no_proxy".to_owned(), merged_no_proxy));
    }
    let (_, spawn_env) = build_isolated_runtime_env(
        cowork_home,
        "antigravity-acp",
        &[
            "ANTIGRAVITY_",
            "AGY_",
            "GEMINI_",
            "GOOGLE_API_KEY",
            "GOOGLE_GEMINI_",
        ],
        &set_vars,
        parent_env,
    );
    spawn_env
}

pub fn antigravity_acp_override(env: &HashMap<String, String>) -> Option<&str> {
    env.get("COWORK_ANTIGRAVITY_ACP_BIN")
        .or_else(|| env.get("COWORK_ANTIGRAVITY_ACP_COMMAND"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn antigravity_acp_override_configured(env: &HashMap<String, String>) -> bool {
    antigravity_acp_override(env).is_some()
}

pub fn resolve_antigravity_acp_status(
    cowork_home: &Path,
    env: &HashMap<String, String>,
) -> ManagedRuntimeInstallStatus {
    resolve_managed_runtime_status(
        cowork_home,
        ANTIGRAVITY_RUNTIME_DIR,
        ANTIGRAVITY_DISPLAY_NAME,
        ANTIGRAVITY_ACP_MANAGED_VERSION,
        ANTIGRAVITY_EXE_BASENAME,
        antigravity_acp_override(env),
        env.get("COWORK_ANTIGRAVITY_ACP_ARGS").map(String::as_str),
    )
}

#[derive(Debug, Deserialize)]
struct AntigravityManifest {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

pub async fn update_managed_antigravity_acp(
    cowork_home: &Path,
    force: bool,
    opts: &AntigravityAcpInstallOptions,
) -> Result<ManagedRuntimeInstallStatus, String> {
    let installed =
        install_antigravity_acp(cowork_home, ANTIGRAVITY_ACP_MANAGED_VERSION, force, opts).await?;
    let command = installed.command.to_string_lossy().into_owned();
    Ok(ManagedRuntimeInstallStatus {
        available: true,
        source: "managed".to_owned(),
        command: Some(command.clone()),
        args: Some(Vec::new()),
        version: Some(installed.version.clone()),
        pinned_version: Some(ANTIGRAVITY_ACP_MANAGED_VERSION.to_owned()),
        pin_matches_current: Some(installed.version == ANTIGRAVITY_ACP_MANAGED_VERSION),
        managed_path: Some(command),
        message: format!(
            "Installed Cowork-managed Antigravity ACP runtime {}.",
            installed.version
        ),
    })
}

pub async fn install_antigravity_acp(
    cowork_home: &Path,
    version: &str,
    force: bool,
    opts: &AntigravityAcpInstallOptions,
) -> Result<InstalledManagedBinary, String> {
    let version = version.trim();
    if version.is_empty()
        || version.contains('/')
        || version.contains('\\')
        || version.contains("..")
    {
        return Err(format!("Invalid Antigravity ACP version: {version}"));
    }
    let target = opts.resolved_target()?;
    let platform_key = antigravity_platform_key(&target)?;
    let (download_timeout, max_download_bytes) = validate_download_limits(
        ANTIGRAVITY_DISPLAY_NAME,
        opts.download_timeout,
        opts.max_download_bytes,
    )?;

    let key = format!(
        "antigravity-acp-{}-{}-{}-{version}",
        cowork_home.display(),
        target.platform,
        target.arch
    );
    let gate = in_flight_install_lock(&key);
    let _in_flight = gate.lock().await;

    let existing = managed_executable_path(
        cowork_home,
        ANTIGRAVITY_RUNTIME_DIR,
        version,
        &target,
        ANTIGRAVITY_EXE_BASENAME,
    );
    if existing.is_file() && !force {
        return promote_existing_managed_runtime(
            cowork_home,
            ANTIGRAVITY_RUNTIME_DIR,
            version,
            &target,
            ANTIGRAVITY_EXE_BASENAME,
            ANTIGRAVITY_DISPLAY_NAME,
        )
        .await;
    }

    let Some(expected_sha512) = opts.expected_checksum(version, platform_key) else {
        return Err(format!(
            "Refusing to install Antigravity ACP {version}: no pinned SHA-512 checksum for {platform_key}."
        ));
    };

    let client = build_install_http_client(ANTIGRAVITY_DISPLAY_NAME)?;
    let manifest_url = format!(
        "{}/manifests/{platform_key}.json",
        opts.manifest_base_url.trim_end_matches('/')
    );
    let using_custom_base =
        opts.manifest_base_url.trim_end_matches('/') != DEFAULT_ANTIGRAVITY_MANIFEST_BASE_URL;

    // Resolve download URL from the manifest when its version matches our pin (or when using a
    // mock/custom manifest base in tests); otherwise use the repo-pinned GCS URL for the pinned
    // version so upstream bumps never break installation until Cowork bumps its pinned checksum.
    let download_url = match fetch_bounded_bytes(
        &client,
        &manifest_url,
        ANTIGRAVITY_USER_AGENT,
        "Antigravity ACP manifest",
        DEFAULT_METADATA_TIMEOUT,
        DEFAULT_MAX_METADATA_BYTES,
    )
    .await
    {
        Ok(bytes) => {
            let parsed: AntigravityManifest = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Failed to parse Antigravity ACP manifest: {e}"))?;
            let manifest_ver = parsed.version.as_deref().map(str::trim).unwrap_or("");
            if manifest_ver == version
                && let Some(url) = parsed
                    .url
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            {
                url.to_owned()
            } else if !using_custom_base {
                pinned_antigravity_artifact(version, platform_key)
                    .map(|(url, _)| url.to_owned())
                    .ok_or_else(|| {
                        format!(
                            "No pinned download URL for Antigravity ACP {version}/{platform_key}."
                        )
                    })?
            } else {
                return Err(format!(
                    "Antigravity ACP manifest version '{manifest_ver}' did not match pinned version {version}."
                ));
            }
        }
        Err(err) if !using_custom_base => {
            if let Some((pinned_url, _)) = pinned_antigravity_artifact(version, platform_key) {
                tracing::warn!(
                    "[antigravity-acp] manifest lookup failed ({err}); falling back to repo-pinned artifact URL"
                );
                pinned_url.to_owned()
            } else {
                return Err(err);
            }
        }
        Err(err) => return Err(err),
    };

    let staging_root = managed_runtime_root(cowork_home, ANTIGRAVITY_RUNTIME_DIR).join(".staging");
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("Failed to create {}: {e}", staging_root.display()))?;
    let temp_root = staging_root.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&temp_root)
        .map_err(|e| format!("Failed to create {}: {e}", temp_root.display()))?;

    let is_tar_gz = download_url.ends_with(".tar.gz") || !target.is_windows();
    let downloaded_path = temp_root.join(if is_tar_gz {
        format!("antigravity-{platform_key}.tar.gz")
    } else {
        format!("antigravity-{platform_key}.exe")
    });

    let result = async {
        download_and_verify(
            &client,
            &download_url,
            ANTIGRAVITY_USER_AGENT,
            ANTIGRAVITY_DISPLAY_NAME,
            &downloaded_path,
            ChecksumAlgorithm::Sha512,
            &expected_sha512,
            download_timeout,
            max_download_bytes,
        )
        .await?;

        let staged_exe = if is_tar_gz {
            let extracted = temp_root.join("extracted-antigravity");
            let archive = downloaded_path.clone();
            let out = extracted.clone();
            let found = tokio::task::spawn_blocking(move || {
                extract_executable_from_tar_gz(
                    &archive,
                    &["antigravity", "agy"],
                    &out,
                    ANTIGRAVITY_DISPLAY_NAME,
                    max_download_bytes,
                )
            })
            .await
            .map_err(|e| format!("Failed to extract Antigravity ACP archive: {e}"))??;
            if !found {
                return Err(
                    "Unable to find antigravity or agy executable inside Antigravity ACP archive."
                        .to_owned(),
                );
            }
            extracted
        } else {
            downloaded_path.clone()
        };

        atomic_promote_managed_runtime(
            cowork_home,
            ANTIGRAVITY_RUNTIME_DIR,
            version,
            &target,
            &staged_exe,
            ANTIGRAVITY_EXE_BASENAME,
            ANTIGRAVITY_DISPLAY_NAME,
        )
        .await
    }
    .await;

    let _ = std::fs::remove_dir_all(&temp_root);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pinned_antigravity_target_has_sha512_checksum_and_url() {
        for (platform, arch, musl) in [
            ("darwin", "arm64", false),
            ("darwin", "x64", false),
            ("linux", "x64", false),
            ("linux", "arm64", false),
            ("linux", "x64", true),
            ("linux", "arm64", true),
            ("win32", "x64", false),
            ("win32", "arm64", false),
        ] {
            let target = ManagedRuntimeTarget::new(platform, arch, musl).unwrap();
            let key = antigravity_platform_key(&target).unwrap();
            let (url, sum) =
                pinned_antigravity_artifact(ANTIGRAVITY_ACP_MANAGED_VERSION, key).unwrap();
            assert!(url.starts_with("https://storage.googleapis.com/"));
            assert_eq!(sum.len(), 128, "SHA-512 hex length for {key}");
        }
    }
}
