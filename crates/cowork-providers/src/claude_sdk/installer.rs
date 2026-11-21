//! Cowork-managed Claude Code SDK runtime installer & isolation (`claude-sdk`).
//!
//! Downloads the pinned native `claude` binary from Anthropic's official release mirror
//! (`https://downloads.claude.ai/claude-code-releases/{version}/{platform}/{binary}`), verifies
//! its SHA-256 digest against the repo-pinned checksum table BEFORE chmod/promotion/execution,
//! promotes it atomically into `~/.cowork/claude-sdk`, and isolates all runtime auth/config state
//! under `~/.cowork/auth/claude-sdk` (`CLAUDE_CONFIG_DIR`) without touching `~/.claude`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use uuid::Uuid;

use crate::managed_runtime::{
    ChecksumAlgorithm, InstalledManagedBinary, ManagedRuntimeInstallStatus, ManagedRuntimeTarget,
    atomic_promote_managed_runtime, build_install_http_client, build_isolated_runtime_env,
    download_and_verify, in_flight_install_lock, managed_executable_path, managed_runtime_root,
    promote_existing_managed_runtime, resolve_managed_runtime_status, validate_download_limits,
};

pub const CLAUDE_SDK_MANAGED_VERSION: &str = "2.1.330";
const DEFAULT_CLAUDE_RELEASE_BASE_URL: &str = "https://downloads.claude.ai/claude-code-releases";
const CLAUDE_SDK_RUNTIME_DIR: &str = "claude-sdk";
const CLAUDE_SDK_DISPLAY_NAME: &str = "Claude SDK";
const CLAUDE_SDK_EXE_BASENAME: &str = "claude";
const CLAUDE_SDK_USER_AGENT: &str = "agent-coworker-claude-sdk-runtime";

/// Repo-pinned SHA-256 checksums for the official Claude Code release `2.1.330`.
/// Verified against `https://downloads.claude.ai/claude-code-releases/2.1.330/manifest.json`.
const CLAUDE_SDK_MANAGED_CHECKSUMS: &[(&str, &[(&str, &str)])] = &[(
    "2.1.330",
    &[
        (
            "darwin-arm64",
            "f7c5093b9dd6560d08af28bc27b123fb55091deae3180ac39df199522da86815",
        ),
        (
            "darwin-x64",
            "bbed99bb8a39bb3f94389c5c99d3d02cb75f3f983b5d1bc40b1b0d1efca84713",
        ),
        (
            "linux-arm64",
            "6016f90cac783e367fb1aa97c768a2efb94a0128a5b46b70fb3d8fcbbd9dd444",
        ),
        (
            "linux-x64",
            "f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb",
        ),
        (
            "linux-arm64-musl",
            "986b83557cbd428273c37f35fc08a44fc786077deeb391660884833bc581348a",
        ),
        (
            "linux-x64-musl",
            "510d57bbf077b49288b9f3b53b11324048f4c2da5dcb980563be82534980d621",
        ),
        (
            "win32-x64",
            "fa797c1bc7d4a3511da42622bae53a2b7f1276ae328c668f2bfef44635301caa",
        ),
        (
            "win32-arm64",
            "782519c6241a2bedfd4c0d225d59d5095b895037ae7cd2a14a12f5bc5dcba1c3",
        ),
    ],
)];

#[derive(Debug, Clone)]
pub struct ClaudeSdkInstallOptions {
    pub release_base_url: String,
    pub target: Option<ManagedRuntimeTarget>,
    /// Test-only replacement for pinned SHA-256 checksums keyed by platform key (`darwin-arm64`, etc.).
    pub expected_checksums: Option<HashMap<String, String>>,
    pub download_timeout: Option<Duration>,
    pub max_download_bytes: Option<u64>,
}

impl ClaudeSdkInstallOptions {
    pub fn from_env(env: &HashMap<String, String>) -> Self {
        let base = env
            .get("COWORK_CLAUDE_RELEASE_BASE_URL")
            .map(|v| v.trim().trim_end_matches('/').to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_CLAUDE_RELEASE_BASE_URL.to_owned());
        Self {
            release_base_url: base,
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
        pinned_claude_checksum(version, platform_key).map(str::to_owned)
    }
}

pub fn claude_platform_key(target: &ManagedRuntimeTarget) -> Result<&'static str, String> {
    match (
        target.platform.as_str(),
        target.arch.as_str(),
        target.is_musl,
    ) {
        ("darwin", "arm64", _) => Ok("darwin-arm64"),
        ("darwin", "x64", _) => Ok("darwin-x64"),
        ("linux", "arm64", false) => Ok("linux-arm64"),
        ("linux", "x64", false) => Ok("linux-x64"),
        ("linux", "arm64", true) => Ok("linux-arm64-musl"),
        ("linux", "x64", true) => Ok("linux-x64-musl"),
        ("win32", "x64", _) => Ok("win32-x64"),
        ("win32", "arm64", _) => Ok("win32-arm64"),
        (p, a, _) => Err(format!("Unsupported Claude SDK target: {p}/{a}")),
    }
}

pub fn pinned_claude_checksum(version: &str, platform_key: &str) -> Option<&'static str> {
    CLAUDE_SDK_MANAGED_CHECKSUMS
        .iter()
        .find(|(v, _)| *v == version)
        .and_then(|(_, entries)| entries.iter().find(|(k, _)| *k == platform_key))
        .map(|(_, sum)| *sum)
}

/// Isolated Cowork-managed Claude SDK config home (`<cowork_home>/auth/claude-sdk`).
/// Never resolves to or touches `~/.claude`.
pub fn resolve_claude_sdk_home(cowork_home: &Path) -> PathBuf {
    cowork_home.join("auth").join("claude-sdk")
}

/// Builds the isolated environment for the managed `claude` subprocess:
/// - Creates `<cowork_home>/auth/claude-sdk` (`0700`).
/// - Strips inherited `CLAUDE_*`, `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, and
///   `COWORK_DESKTOP_PARENT_MANAGED`.
/// - Pins `CLAUDE_CONFIG_DIR` to `<cowork_home>/auth/claude-sdk` and disables telemetry/auto-updater.
/// - Injects the saved API key or OAuth token (`sk-ant-oat*` -> `CLAUDE_CODE_OAUTH_TOKEN`,
///   otherwise `ANTHROPIC_API_KEY`).
pub fn build_claude_sdk_spawn_env(
    cowork_home: &Path,
    parent_env: &HashMap<String, String>,
    api_key: Option<&str>,
) -> HashMap<String, String> {
    let config_dir = resolve_claude_sdk_home(cowork_home);
    let mut set_vars = vec![
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            config_dir.to_string_lossy().into_owned(),
        ),
        ("DISABLE_AUTOUPDATER".to_owned(), "1".to_owned()),
        ("DISABLE_TELEMETRY".to_owned(), "1".to_owned()),
        (
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_owned(),
            "1".to_owned(),
        ),
    ];
    if let Some(secret) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
        if secret.starts_with("sk-ant-oat") {
            set_vars.push(("CLAUDE_CODE_OAUTH_TOKEN".to_owned(), secret.to_owned()));
        } else {
            set_vars.push(("ANTHROPIC_API_KEY".to_owned(), secret.to_owned()));
        }
    }
    let (_, spawn_env) = build_isolated_runtime_env(
        cowork_home,
        "claude-sdk",
        &["CLAUDE_", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
        &set_vars,
        parent_env,
    );
    spawn_env
}

pub fn claude_sdk_override(env: &HashMap<String, String>) -> Option<&str> {
    env.get("COWORK_CLAUDE_SDK_BIN")
        .or_else(|| env.get("COWORK_CLAUDE_SDK_COMMAND"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn claude_sdk_override_configured(env: &HashMap<String, String>) -> bool {
    claude_sdk_override(env).is_some()
}

pub fn resolve_claude_sdk_status(
    cowork_home: &Path,
    env: &HashMap<String, String>,
) -> ManagedRuntimeInstallStatus {
    resolve_managed_runtime_status(
        cowork_home,
        CLAUDE_SDK_RUNTIME_DIR,
        CLAUDE_SDK_DISPLAY_NAME,
        CLAUDE_SDK_MANAGED_VERSION,
        CLAUDE_SDK_EXE_BASENAME,
        claude_sdk_override(env),
        env.get("COWORK_CLAUDE_SDK_ARGS").map(String::as_str),
    )
}

pub async fn update_managed_claude_sdk(
    cowork_home: &Path,
    force: bool,
    opts: &ClaudeSdkInstallOptions,
) -> Result<ManagedRuntimeInstallStatus, String> {
    let installed =
        install_claude_sdk(cowork_home, CLAUDE_SDK_MANAGED_VERSION, force, opts).await?;
    let command = installed.command.to_string_lossy().into_owned();
    Ok(ManagedRuntimeInstallStatus {
        available: true,
        source: "managed".to_owned(),
        command: Some(command.clone()),
        args: Some(Vec::new()),
        version: Some(installed.version.clone()),
        pinned_version: Some(CLAUDE_SDK_MANAGED_VERSION.to_owned()),
        pin_matches_current: Some(installed.version == CLAUDE_SDK_MANAGED_VERSION),
        managed_path: Some(command),
        message: format!(
            "Installed Cowork-managed Claude SDK runtime {}.",
            installed.version
        ),
    })
}

pub async fn install_claude_sdk(
    cowork_home: &Path,
    version: &str,
    force: bool,
    opts: &ClaudeSdkInstallOptions,
) -> Result<InstalledManagedBinary, String> {
    let version = version.trim();
    if version.is_empty()
        || version.contains('/')
        || version.contains('\\')
        || version.contains("..")
    {
        return Err(format!("Invalid Claude SDK version: {version}"));
    }
    let target = opts.resolved_target()?;
    let platform_key = claude_platform_key(&target)?;
    let (download_timeout, max_download_bytes) = validate_download_limits(
        CLAUDE_SDK_DISPLAY_NAME,
        opts.download_timeout,
        opts.max_download_bytes,
    )?;

    let key = format!(
        "claude-sdk-{}-{}-{}-{version}",
        cowork_home.display(),
        target.platform,
        target.arch
    );
    let gate = in_flight_install_lock(&key);
    let _in_flight = gate.lock().await;

    let existing = managed_executable_path(
        cowork_home,
        CLAUDE_SDK_RUNTIME_DIR,
        version,
        &target,
        CLAUDE_SDK_EXE_BASENAME,
    );
    if existing.is_file() && !force {
        return promote_existing_managed_runtime(
            cowork_home,
            CLAUDE_SDK_RUNTIME_DIR,
            version,
            &target,
            CLAUDE_SDK_EXE_BASENAME,
            CLAUDE_SDK_DISPLAY_NAME,
        )
        .await;
    }

    let Some(expected_sha256) = opts.expected_checksum(version, platform_key) else {
        return Err(format!(
            "Refusing to install Claude SDK {version}: no pinned SHA-256 checksum for {platform_key}."
        ));
    };

    let binary_name = format!("{CLAUDE_SDK_EXE_BASENAME}{}", target.exe_suffix());
    let url = format!(
        "{}/{version}/{platform_key}/{binary_name}",
        opts.release_base_url.trim_end_matches('/')
    );
    let client = build_install_http_client(CLAUDE_SDK_DISPLAY_NAME)?;

    let staging_root = managed_runtime_root(cowork_home, CLAUDE_SDK_RUNTIME_DIR).join(".staging");
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("Failed to create {}: {e}", staging_root.display()))?;
    let temp_root = staging_root.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&temp_root)
        .map_err(|e| format!("Failed to create {}: {e}", temp_root.display()))?;

    let staged_exe = temp_root.join(&binary_name);
    let result = async {
        download_and_verify(
            &client,
            &url,
            CLAUDE_SDK_USER_AGENT,
            CLAUDE_SDK_DISPLAY_NAME,
            &staged_exe,
            ChecksumAlgorithm::Sha256,
            &expected_sha256,
            download_timeout,
            max_download_bytes,
        )
        .await?;
        atomic_promote_managed_runtime(
            cowork_home,
            CLAUDE_SDK_RUNTIME_DIR,
            version,
            &target,
            &staged_exe,
            CLAUDE_SDK_EXE_BASENAME,
            CLAUDE_SDK_DISPLAY_NAME,
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
    fn every_pinned_claude_target_has_sha256_checksum() {
        for (platform, arch, musl) in [
            ("darwin", "arm64", false),
            ("darwin", "x64", false),
            ("linux", "arm64", false),
            ("linux", "x64", false),
            ("linux", "arm64", true),
            ("linux", "x64", true),
            ("win32", "x64", false),
            ("win32", "arm64", false),
        ] {
            let target = ManagedRuntimeTarget::new(platform, arch, musl).unwrap();
            let key = claude_platform_key(&target).unwrap();
            let sum = pinned_claude_checksum(CLAUDE_SDK_MANAGED_VERSION, key).unwrap();
            assert_eq!(sum.len(), 64, "SHA-256 hex length for {key}");
        }
    }
}
