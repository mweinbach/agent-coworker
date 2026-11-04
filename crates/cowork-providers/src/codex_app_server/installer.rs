//! Cowork-managed Codex app-server runtime installer.
//!
//! Port of the TS `updateManagedCodexAppServer` / `installCodexAppServer` flow
//! (`src/providers/codexAppServerResolver.ts`). The app-pinned release
//! ([`CODEX_APP_SERVER_MANAGED_VERSION`]) is read from the `openai/codex` GitHub
//! release metadata, every downloaded asset is verified against the repo-pinned
//! SHA-256 table below BEFORE extraction, promotion, or execution, and the
//! verified set is promoted atomically into `~/.cowork/codex-app-server`:
//!
//! ```text
//! ~/.cowork/codex-app-server/versions/<version>/<platform>-<arch>/codex-app-server[.exe]
//! ~/.cowork/codex-app-server/current/<platform>-<arch>/codex-app-server[.exe]
//! <executable>.version
//! ```
//!
//! Companion binaries (`codex-code-mode-host` everywhere, plus the Windows
//! `codex-command-runner` / `codex-windows-sandbox-setup` helpers) are installed
//! next to the app-server because it resolves them from its own directory.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use cowork_config::{ConfigError, FileLockOptions, file_lock_root_for_cowork_home, with_file_lock};
use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::isolation::{CODEX_APP_SERVER_MANAGED_VERSION, CodexInstallStatus};

const DEFAULT_GITHUB_API_BASE_URL: &str = "https://api.github.com";
const CODEX_RELEASE_REPOSITORY: &str = "openai/codex";
const CODEX_USER_AGENT: &str = "agent-coworker-codex-app-server-runtime";
const GITHUB_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RELEASE_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const CODEX_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Production caps; [`CodexRuntimeInstallOptions`] may only lower them.
pub const CODEX_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const CODEX_MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MANAGED_VERSIONS_TO_KEEP: usize = 3;

const APP_SERVER_BASENAME: &str = "codex-app-server";
const CODE_MODE_HOST_BASENAME: &str = "codex-code-mode-host";
const CODEX_COMMAND_RUNNER_BASENAME: &str = "codex-command-runner";
const CODEX_WINDOWS_SANDBOX_SETUP_BASENAME: &str = "codex-windows-sandbox-setup";

/// Repo-pinned SHA-256 checksums for the managed Codex app-server release assets.
///
/// The repository is the trust anchor: downloaded release bytes are verified against these
/// before extraction, promotion, or execution, so a compromised, swapped, or corrupted upstream
/// asset fails closed. When bumping [`CODEX_APP_SERVER_MANAGED_VERSION`], add the new version's
/// app-server and companion digests, obtainable with:
/// `gh api repos/openai/codex/releases/tags/rust-v<version> --jq '.assets[] | "\(.name) \(.digest)"'`
const CODEX_APP_SERVER_MANAGED_CHECKSUMS: &[(&str, &[(&str, &str)])] = &[(
    "0.160.0",
    &[
        (
            "codex-app-server-aarch64-apple-darwin.tar.gz",
            "1e6e5bd7e248a366ef17475602d9fbc37b8ad38498f7cdc184023cd5c718e8c5",
        ),
        (
            "codex-app-server-x86_64-apple-darwin.tar.gz",
            "9c8b8f053b0aba693e566fbe42d60b4c0488efcb2f68863251b03e9b2729eeee",
        ),
        (
            "codex-app-server-aarch64-unknown-linux-musl.tar.gz",
            "782581656b7c27ad23d2e5cf268bac5ad8a4112b149a2ad77ce97644ad4cddda",
        ),
        (
            "codex-app-server-x86_64-unknown-linux-musl.tar.gz",
            "d0a05909836d4a73634641b89c7a62fd99c0978cdfe7ae9b8b631e9ee6d9da46",
        ),
        (
            "codex-app-server-aarch64-pc-windows-msvc.exe",
            "6d9d17d4b244c01e8118e1795a058e1781d05147b1d33e81db511012d0c6ba9d",
        ),
        (
            "codex-app-server-x86_64-pc-windows-msvc.exe",
            "5cbc46199b17ecb509b58400d65e0de3f9e4d7aa049423024a6da0c62b3fa526",
        ),
        (
            "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
            "dc70fbc76e9dcae5ae3d5424808c8e7c2df5e0db4ac827ddd4fbe339015aad75",
        ),
        (
            "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
            "b024eba366ec2e3b6734972a00df8ed9b7bf14e670579bc5ba18194612d9f441",
        ),
        (
            "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
            "94066fdf13ffecd2f58776ec5cb8fc3040283a642e3d6ff25c5d82048c41038e",
        ),
        (
            "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
            "ac6cd6288f0e39f46a33eba1cfd37711651f14f33dbc73d6a1b82eb45e038cac",
        ),
        (
            "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
            "86ac0f80fa35b7fff88730b735e517fa4e953e47bac8f38662e8e76d686b939a",
        ),
        (
            "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
            "1d448bfde19e7a280d600d8d0bcddf77afbe9feaec1e804905becc5f39bc9db6",
        ),
        (
            "codex-command-runner-aarch64-pc-windows-msvc.exe",
            "e46a43aa9ad1ecaca67b57f2dcbc016868e932ec1bed2c616d59646e5b26316c",
        ),
        (
            "codex-command-runner-x86_64-pc-windows-msvc.exe",
            "dd13f8e95faba5cf539d870dd3b64c226b00d062a5b523e7e08c44fdc8235224",
        ),
        (
            "codex-windows-sandbox-setup-aarch64-pc-windows-msvc.exe",
            "cf4d66e2e7a78843b9aff9680a3d52d54a56f6c2c3f889e78f4196d840e8d9e6",
        ),
        (
            "codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe",
            "8f91d62aca2aca87b0ebf446848b817720415dd3080905ffc3085c17b70bd57a",
        ),
    ],
)];

/// Artifact platform/arch, using Node-compatible identifiers (`darwin`/`linux`/`win32`,
/// `x64`/`arm64`) like the TS resolver so the on-disk layout is shared with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRuntimeTarget {
    pub platform: String,
    pub arch: String,
}

impl CodexRuntimeTarget {
    /// The target this process runs on; errors for architectures Codex does not publish.
    pub fn host() -> Result<Self, String> {
        Self::new(cowork_sandbox::host_platform(), cowork_sandbox::host_arch())
    }

    pub fn new(platform: &str, arch: &str) -> Result<Self, String> {
        if arch != "x64" && arch != "arm64" {
            return Err(format!("Unsupported Codex app-server architecture: {arch}"));
        }
        let target = Self {
            platform: platform.to_owned(),
            arch: arch.to_owned(),
        };
        target.triple()?;
        Ok(target)
    }

    fn is_windows(&self) -> bool {
        self.platform == "win32"
    }

    fn triple(&self) -> Result<&'static str, String> {
        match (self.platform.as_str(), self.arch.as_str()) {
            ("win32", "x64") => Ok("x86_64-pc-windows-msvc"),
            ("win32", "arm64") => Ok("aarch64-pc-windows-msvc"),
            ("darwin", "x64") => Ok("x86_64-apple-darwin"),
            ("darwin", "arm64") => Ok("aarch64-apple-darwin"),
            ("linux", "x64") => Ok("x86_64-unknown-linux-musl"),
            ("linux", "arm64") => Ok("aarch64-unknown-linux-musl"),
            (platform, arch) => Err(format!(
                "Unsupported Codex app-server target: {platform}/{arch}"
            )),
        }
    }

    fn exe_suffix(&self) -> &'static str {
        if self.is_windows() { ".exe" } else { "" }
    }

    fn dir_name(&self) -> String {
        format!("{}-{}", self.platform, self.arch)
    }

    /// Release asset name for `basename` (`codex-app-server`, companions) on this target.
    pub fn asset_name(&self, basename: &str) -> Result<String, String> {
        let triple = self.triple()?;
        Ok(if self.is_windows() {
            format!("{basename}-{triple}.exe")
        } else {
            format!("{basename}-{triple}.tar.gz")
        })
    }

    fn companion_basenames(&self) -> Vec<&'static str> {
        let mut out = vec![CODE_MODE_HOST_BASENAME];
        if self.is_windows() {
            out.push(CODEX_COMMAND_RUNNER_BASENAME);
            out.push(CODEX_WINDOWS_SANDBOX_SETUP_BASENAME);
        }
        out
    }
}

/// Network/test knobs for the managed installer. Production callers use [`Self::from_env`].
#[derive(Debug, Clone)]
pub struct CodexRuntimeInstallOptions {
    /// GitHub REST API base (`COWORK_GITHUB_API_BASE_URL`, default `https://api.github.com`).
    /// Redirecting it cannot bypass verification: assets must still match the pinned checksums.
    pub api_base_url: String,
    /// `GITHUB_TOKEN`/`GH_TOKEN`; only ever sent to `https://api.github.com`, with an anonymous
    /// retry when GitHub rejects it (TS `fetchWithGitHubAuth`).
    pub github_token: Option<String>,
    /// Artifact target; `None` means the host.
    pub target: Option<CodexRuntimeTarget>,
    /// Test-only replacement for the pinned per-asset checksums. Production
    /// ([`Self::from_env`]) always verifies against the repo-pinned table.
    pub expected_checksums: Option<HashMap<String, String>>,
    /// Optional lower download deadline (cannot exceed [`CODEX_DOWNLOAD_TIMEOUT`]).
    pub download_timeout: Option<Duration>,
    /// Optional lower per-asset byte cap (cannot exceed [`CODEX_MAX_DOWNLOAD_BYTES`]).
    pub max_download_bytes: Option<u64>,
}

impl CodexRuntimeInstallOptions {
    pub fn from_env(env: &HashMap<String, String>) -> Self {
        let non_empty = |key: &str| {
            env.get(key)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        Self {
            api_base_url: non_empty("COWORK_GITHUB_API_BASE_URL")
                .map(|v| v.trim_end_matches('/').to_owned())
                .unwrap_or_else(|| DEFAULT_GITHUB_API_BASE_URL.to_owned()),
            github_token: non_empty("GITHUB_TOKEN").or_else(|| non_empty("GH_TOKEN")),
            target: None,
            expected_checksums: None,
            download_timeout: None,
            max_download_bytes: None,
        }
    }

    fn resolved_target(&self) -> Result<CodexRuntimeTarget, String> {
        match &self.target {
            Some(target) => CodexRuntimeTarget::new(&target.platform, &target.arch),
            None => CodexRuntimeTarget::host(),
        }
    }

    fn expected_checksum(&self, version: &str, asset_name: &str) -> Option<String> {
        if let Some(overrides) = &self.expected_checksums {
            return overrides.get(asset_name).cloned();
        }
        pinned_checksum(version, asset_name).map(str::to_owned)
    }

    fn download_limits(&self) -> Result<(Duration, u64), String> {
        let timeout = self.download_timeout.unwrap_or(CODEX_DOWNLOAD_TIMEOUT);
        if timeout.is_zero() || timeout > CODEX_DOWNLOAD_TIMEOUT {
            return Err(format!(
                "Codex download timeout must be positive and no greater than {}ms.",
                CODEX_DOWNLOAD_TIMEOUT.as_millis()
            ));
        }
        let max_bytes = self.max_download_bytes.unwrap_or(CODEX_MAX_DOWNLOAD_BYTES);
        if max_bytes == 0 || max_bytes > CODEX_MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Codex download byte limit must be a positive integer no greater than {CODEX_MAX_DOWNLOAD_BYTES}."
            ));
        }
        Ok((timeout, max_bytes))
    }
}

fn pinned_checksum(version: &str, asset_name: &str) -> Option<&'static str> {
    CODEX_APP_SERVER_MANAGED_CHECKSUMS
        .iter()
        .find(|(v, _)| *v == version)
        .and_then(|(_, assets)| assets.iter().find(|(name, _)| *name == asset_name))
        .map(|(_, sum)| *sum)
}

/// `~/.cowork/codex-app-server` (`cowork_home` is the `.cowork` root).
pub fn managed_codex_root(cowork_home: &Path) -> PathBuf {
    cowork_home.join("codex-app-server")
}

/// Versioned install path for `version` on `target`.
pub fn managed_codex_executable_path(
    cowork_home: &Path,
    version: &str,
    target: &CodexRuntimeTarget,
) -> PathBuf {
    managed_codex_root(cowork_home)
        .join("versions")
        .join(version)
        .join(target.dir_name())
        .join(format!("{APP_SERVER_BASENAME}{}", target.exe_suffix()))
}

/// Promoted "current" path on `target`.
pub fn managed_codex_current_path(cowork_home: &Path, target: &CodexRuntimeTarget) -> PathBuf {
    managed_codex_root(cowork_home)
        .join("current")
        .join(target.dir_name())
        .join(format!("{APP_SERVER_BASENAME}{}", target.exe_suffix()))
}

fn version_file_path(executable: &Path) -> PathBuf {
    let mut os = executable.as_os_str().to_os_string();
    os.push(".version");
    PathBuf::from(os)
}

/// Reads the `<executable>.version` marker written at promotion time.
pub fn read_managed_version_file(executable: &Path) -> Option<String> {
    std::fs::read_to_string(version_file_path(executable))
        .ok()
        .map(|raw| raw.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn companion_sibling_path(
    app_server_executable: &Path,
    basename: &str,
    target: &CodexRuntimeTarget,
) -> PathBuf {
    app_server_executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{basename}{}", target.exe_suffix()))
}

/// The managed command a verified install should spawn: the versioned executable on Windows
/// (a running `current` copy cannot be replaced there), the promoted `current` path elsewhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedCodexCommand {
    pub command: PathBuf,
    pub version: String,
}

#[derive(Debug)]
struct InstallError(String);

impl From<ConfigError> for InstallError {
    fn from(err: ConfigError) -> Self {
        Self(err.to_string())
    }
}

impl From<String> for InstallError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

fn in_flight_installs() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// TS `updateManagedCodexAppServer`: installs (or with `force`, reinstalls) the app-pinned managed
/// runtime and returns its install status.
pub async fn update_managed_codex_app_server(
    cowork_home: &Path,
    force: bool,
    opts: &CodexRuntimeInstallOptions,
) -> Result<CodexInstallStatus, String> {
    let installed =
        install_codex_app_server(cowork_home, CODEX_APP_SERVER_MANAGED_VERSION, force, opts)
            .await?;
    let command = installed.command.to_string_lossy().into_owned();
    Ok(CodexInstallStatus {
        available: true,
        source: "managed".to_owned(),
        command: Some(command.clone()),
        args: Some(Vec::new()),
        version: Some(installed.version.clone()),
        pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_owned()),
        pin_matches_current: Some(installed.version == CODEX_APP_SERVER_MANAGED_VERSION),
        managed_path: Some(command),
        message: format!(
            "Installed Cowork-managed Codex runtime {}.",
            installed.version
        ),
    })
}

/// TS `installCodexAppServer` for an explicit release `version`.
///
/// Without `force`, an existing verified version is kept: missing companions are repaired
/// best-effort and the version is re-promoted. Otherwise the full asset set is downloaded,
/// verified, staged, and only then promoted, so a failed or mismatched download never replaces
/// installed bytes.
pub async fn install_codex_app_server(
    cowork_home: &Path,
    version: &str,
    force: bool,
    opts: &CodexRuntimeInstallOptions,
) -> Result<ManagedCodexCommand, String> {
    let version = normalize_codex_version(version)?;
    let target = opts.resolved_target()?;
    let (download_timeout, max_download_bytes) = opts.download_limits()?;
    let key = format!(
        "{}-{}-{}-{version}",
        cowork_home.display(),
        target.platform,
        target.arch
    );
    let gate = {
        let mut map = in_flight_installs().lock();
        Arc::clone(map.entry(key).or_default())
    };
    let _in_flight = gate.lock().await;

    let client = build_install_http_client()?;
    let release = fetch_codex_release(&client, opts, &version).await?;
    let ctx = InstallContext {
        client,
        opts,
        release,
        target,
        download_timeout,
        max_download_bytes,
    };

    let executable_path =
        managed_codex_executable_path(cowork_home, &ctx.release.version, &ctx.target);
    let current_path = managed_codex_current_path(cowork_home, &ctx.target);
    let lock_root = file_lock_root_for_cowork_home(cowork_home);
    let staging_root = managed_codex_root(cowork_home).join(".staging");
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("Failed to create {}: {e}", staging_root.display()))?;
    let temp_root = staging_root.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&temp_root)
        .map_err(|e| format!("Failed to create {}: {e}", temp_root.display()))?;

    let result = async {
        if executable_path.is_file() && !force {
            repair_companions_best_effort(&ctx, &executable_path, &temp_root, &lock_root).await;
            with_lock(&executable_path, &lock_root, || {
                promote_current_best_effort(&ctx, &executable_path, &current_path, &lock_root)
            })
            .await?;
        } else {
            // Stage and verify the entire set before replacing any installed bytes. Forced repairs
            // must not skip existing (possibly corrupt) companions.
            let staged = temp_root
                .join("install")
                .join(executable_path.file_name().unwrap_or_default());
            std::fs::create_dir_all(staged.parent().unwrap_or(&temp_root))
                .map_err(|e| format!("Failed to create Codex staging directory: {e}"))?;
            install_companion_binaries(&ctx, &staged, None, &temp_root).await?;
            let asset_name = ctx.target.asset_name(APP_SERVER_BASENAME)?;
            install_release_executable(&ctx, &asset_name, APP_SERVER_BASENAME, &staged, &temp_root)
                .await?;
            with_lock(&executable_path, &lock_root, || async {
                promote_managed_install(
                    &staged,
                    &executable_path,
                    &ctx.release.version,
                    &ctx.target,
                    false,
                )
                .await?;
                promote_current_best_effort(&ctx, &executable_path, &current_path, &lock_root).await
            })
            .await?;
        }
        Ok::<(), String>(())
    }
    .await;
    let _ = std::fs::remove_dir_all(&temp_root);
    result?;

    prune_managed_versions(cowork_home);
    Ok(ManagedCodexCommand {
        command: if ctx.target.is_windows() {
            executable_path
        } else {
            current_path
        },
        version: ctx.release.version,
    })
}

/// Resolves the installed managed runtime for status/spawn: the pinned version when present,
/// else whatever was last promoted to `current`.
pub fn resolve_installed_managed_command(
    cowork_home: &Path,
    target: &CodexRuntimeTarget,
) -> Option<(PathBuf, Option<String>)> {
    let pinned =
        managed_codex_executable_path(cowork_home, CODEX_APP_SERVER_MANAGED_VERSION, target);
    let current = managed_codex_current_path(cowork_home, target);
    let current_version = read_managed_version_file(&current);
    if pinned.is_file() {
        let pinned_version = read_managed_version_file(&pinned)
            .unwrap_or_else(|| CODEX_APP_SERVER_MANAGED_VERSION.to_owned());
        if !target.is_windows()
            && current.is_file()
            && current_version.as_deref() == Some(pinned_version.as_str())
        {
            return Some((current, Some(pinned_version)));
        }
        return Some((pinned, Some(pinned_version)));
    }
    if current.is_file() {
        return Some((current, current_version));
    }
    None
}

struct InstallContext<'a> {
    client: reqwest::Client,
    opts: &'a CodexRuntimeInstallOptions,
    release: CodexRelease,
    target: CodexRuntimeTarget,
    download_timeout: Duration,
    max_download_bytes: u64,
}

async fn with_lock<F, Fut>(target: &Path, lock_root: &Path, work: F) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    with_file_lock(
        target,
        move || async move { work().await.map_err(InstallError) },
        FileLockOptions {
            lock_root: Some(lock_root.to_path_buf()),
            ..FileLockOptions::default()
        },
    )
    .await
    .map_err(|InstallError(message)| message)
}

fn normalize_codex_version(version: &str) -> Result<String, String> {
    let trimmed = version.trim();
    let normalized = trimmed.strip_prefix("rust-v").unwrap_or(trimmed);
    let valid = regex::Regex::new(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
        .map(|re| re.is_match(normalized))
        .unwrap_or(false);
    if !valid {
        return Err("Codex app-server version must look like 0.144.0.".to_owned());
    }
    Ok(normalized.to_owned())
}

fn build_install_http_client() -> Result<reqwest::Client, String> {
    // Release assets redirect cross-origin (github.com -> objects.githubusercontent.com); reqwest
    // strips Authorization on cross-origin redirects. Proxy env vars are honored as usual.
    reqwest::Client::builder()
        .connect_timeout(CODEX_CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for Codex app-server install: {e}"))
}

#[derive(Debug, Clone)]
struct CodexRelease {
    version: String,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseAsset {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    browser_download_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReleaseResponse {
    #[serde(default)]
    tag_name: Option<String>,
    #[serde(default)]
    assets: Option<Vec<serde_json::Value>>,
}

fn is_github_token_host(url: &str) -> bool {
    url::Url::parse(url)
        .map(|u| u.scheme() == "https" && u.host_str() == Some("api.github.com"))
        .unwrap_or(false)
}

async fn fetch_codex_release(
    client: &reqwest::Client,
    opts: &CodexRuntimeInstallOptions,
    version: &str,
) -> Result<CodexRelease, String> {
    let url = format!(
        "{}/repos/{CODEX_RELEASE_REPOSITORY}/releases/tags/rust-v{version}",
        opts.api_base_url.trim_end_matches('/')
    );
    let token = opts
        .github_token
        .as_deref()
        .filter(|_| is_github_token_host(&url));
    let body = tokio::time::timeout(GITHUB_REQUEST_TIMEOUT, async {
        let request = |auth: Option<&str>| {
            let mut req = client
                .get(&url)
                .header(reqwest::header::ACCEPT, "application/vnd.github+json")
                .header(reqwest::header::USER_AGENT, CODEX_USER_AGENT);
            if let Some(token) = auth {
                req = req.bearer_auth(token);
            }
            req.send()
        };
        let mut response = request(token)
            .await
            .map_err(|e| format!("Failed to read Codex app-server release metadata: {e}"))?;
        if token.is_some() && matches!(response.status().as_u16(), 401 | 403) {
            // A stale or under-scoped token must not block a public release read.
            response = request(None)
                .await
                .map_err(|e| format!("Failed to read Codex app-server release metadata: {e}"))?;
        }
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Failed to read Codex app-server release metadata: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            )
            .trim_end()
            .to_owned());
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_RELEASE_METADATA_BYTES)
        {
            return Err(format!(
                "GitHub response exceeded its {MAX_RELEASE_METADATA_BYTES}-byte limit"
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to read Codex app-server release metadata: {e}"))?
        {
            if (body.len() + chunk.len()) as u64 > MAX_RELEASE_METADATA_BYTES {
                return Err(format!(
                    "GitHub response exceeded its {MAX_RELEASE_METADATA_BYTES}-byte limit"
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
    .await
    .map_err(|_| {
        format!(
            "GitHub request timed out after {}ms",
            GITHUB_REQUEST_TIMEOUT.as_millis()
        )
    })??;

    let release: ReleaseResponse = serde_json::from_slice(&body)
        .map_err(|e| format!("Failed to parse Codex app-server release metadata: {e}"))?;
    let tag_name = release.tag_name.unwrap_or_default();
    if tag_name.is_empty() {
        return Err("Codex app-server release metadata did not include tag_name.".to_owned());
    }
    let release_version = normalize_codex_version(&tag_name)?;
    if release_version != version {
        return Err(format!(
            "Codex app-server release metadata did not match requested version {version}."
        ));
    }
    let assets = release
        .assets
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| serde_json::from_value::<ReleaseAsset>(value).ok())
        .collect();
    Ok(CodexRelease {
        version: release_version,
        assets,
    })
}

fn find_release_asset_url(assets: &[ReleaseAsset], asset_name: &str) -> Result<String, String> {
    assets
        .iter()
        .find(|asset| asset.name.as_deref() == Some(asset_name))
        .and_then(|asset| asset.browser_download_url.clone())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            format!("Codex app-server release did not include required asset {asset_name}.")
        })
}

/// Streams `url` into a new file at `dest` under the deadline and byte cap, returning the SHA-256
/// of the bytes written. A partial file is removed on any failure.
async fn download_file(ctx: &InstallContext<'_>, url: &str, dest: &Path) -> Result<String, String> {
    let max_bytes = ctx.max_download_bytes;
    let download = async {
        let mut response = ctx
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/octet-stream")
            .header(reqwest::header::USER_AGENT, CODEX_USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("Failed to download Codex app-server: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Failed to download Codex app-server: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            )
            .trim_end()
            .to_owned());
        }
        if response.content_length().is_some_and(|len| len > max_bytes) {
            return Err(format!(
                "Codex app-server download exceeded its {max_bytes}-byte limit."
            ));
        }
        let mut file = create_new_private_file(dest)?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to download Codex app-server: {e}"))?
        {
            written = written.saturating_add(chunk.len() as u64);
            if written > max_bytes {
                return Err(format!(
                    "Codex app-server download exceeded its {max_bytes}-byte limit."
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
        }
        file.flush()
            .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
        Ok(hex::encode(hasher.finalize()))
    };
    let result = match tokio::time::timeout(ctx.download_timeout, download).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Codex app-server download timed out after {}ms.",
            ctx.download_timeout.as_millis()
        )),
    };
    if result.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    result
}

fn create_new_private_file(path: &Path) -> Result<std::fs::File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .map_err(|e| format!("Failed to create {}: {e}", path.display()))
}

/// Downloads one release asset, verifies it against the pinned checksum BEFORE it is extracted,
/// copied, made executable, or promoted, and installs the contained executable at `dest_path` via
/// an atomic rename.
async fn install_release_executable(
    ctx: &InstallContext<'_>,
    asset_name: &str,
    wanted_basename: &str,
    dest_path: &Path,
    temp_root: &Path,
) -> Result<(), String> {
    let download_url = find_release_asset_url(&ctx.release.assets, asset_name)?;
    let asset_path = temp_root.join(asset_name);
    let actual = download_file(ctx, &download_url, &asset_path).await?;
    let Some(expected) = ctx.opts.expected_checksum(&ctx.release.version, asset_name) else {
        return Err(format!(
            "Refusing to install Codex app-server {}: no pinned SHA-256 checksum for asset {asset_name}.",
            ctx.release.version
        ));
    };
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(format!(
            "Codex app-server asset {asset_name} failed checksum verification (expected {expected}, got {actual})."
        ));
    }

    let mut source_path = asset_path.clone();
    if let Some(stem) = asset_name.strip_suffix(".tar.gz") {
        let extracted = temp_root.join(format!("extract-{wanted_basename}"));
        let archive = asset_path.clone();
        let wanted = wanted_basename.to_owned();
        let fallback = stem.to_owned();
        let out = extracted.clone();
        let max_bytes = ctx.max_download_bytes;
        let found = tokio::task::spawn_blocking(move || {
            extract_executable_from_tar_gz(&archive, &wanted, &fallback, &out, max_bytes)
        })
        .await
        .map_err(|e| format!("Failed to extract Codex app-server archive: {e}"))??;
        if !found {
            return Err(format!("Unable to find {wanted_basename} in {asset_name}."));
        }
        source_path = extracted;
    }
    copy_executable_atomically(&source_path, dest_path, &ctx.target).await
}

/// Extracts the first regular file named `wanted` (else `fallback`) from a verified `.tar.gz`
/// into `out` without unpacking anything else. Returns `false` when neither entry exists.
fn extract_executable_from_tar_gz(
    archive: &Path,
    wanted: &str,
    fallback: &str,
    out: &Path,
    max_bytes: u64,
) -> Result<bool, String> {
    let err = |e: std::io::Error| format!("Failed to extract Codex app-server archive: {e}");
    for name in [wanted, fallback] {
        let file = std::fs::File::open(archive).map_err(err)?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in tar.entries().map_err(err)? {
            let mut entry = entry.map_err(err)?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path().map_err(err)?;
            if path.file_name().and_then(|n| n.to_str()) != Some(name) {
                continue;
            }
            let mut dest = create_new_private_file(out)?;
            let copied =
                std::io::copy(&mut (&mut entry).take(max_bytes + 1), &mut dest).map_err(err)?;
            if copied > max_bytes {
                drop(dest);
                let _ = std::fs::remove_file(out);
                return Err(format!(
                    "Codex app-server archive entry exceeded its {max_bytes}-byte limit."
                ));
            }
            dest.flush().map_err(err)?;
            return Ok(true);
        }
    }
    Ok(false)
}

async fn copy_executable_atomically(
    source: &Path,
    dest: &Path,
    target: &CodexRuntimeTarget,
) -> Result<(), String> {
    let source = source.to_path_buf();
    let dest = dest.to_path_buf();
    let make_executable = !target.is_windows();
    tokio::task::spawn_blocking(move || {
        copy_executable_atomically_sync(&source, &dest, make_executable)
    })
    .await
    .map_err(|e| format!("Failed to install Codex app-server: {e}"))?
}

fn copy_executable_atomically_sync(
    source: &Path,
    dest: &Path,
    make_executable: bool,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let mut tmp = dest.as_os_str().to_os_string();
    tmp.push(format!(".tmp-{}", Uuid::new_v4()));
    let tmp = PathBuf::from(tmp);
    let result = (|| {
        std::fs::copy(source, &tmp)
            .map_err(|e| format!("Failed to copy {}: {e}", source.display()))?;
        #[cfg(unix)]
        if make_executable {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to mark {} executable: {e}", tmp.display()))?;
        }
        #[cfg(not(unix))]
        let _ = make_executable;
        std::fs::rename(&tmp, dest)
            .map_err(|e| format!("Failed to install {}: {e}", dest.display()))
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Installs every companion with a pinned checksum next to `app_server_executable` (skipping
/// siblings already present there or, during repair, next to `existing_app_server`).
async fn install_companion_binaries(
    ctx: &InstallContext<'_>,
    app_server_executable: &Path,
    existing_app_server: Option<&Path>,
    temp_root: &Path,
) -> Result<(), String> {
    for basename in ctx.target.companion_basenames() {
        let asset_name = ctx.target.asset_name(basename)?;
        if ctx
            .opts
            .expected_checksum(&ctx.release.version, &asset_name)
            .is_none()
        {
            continue;
        }
        let dest = companion_sibling_path(app_server_executable, basename, &ctx.target);
        if dest.exists() {
            continue;
        }
        if existing_app_server.is_some_and(|existing| {
            companion_sibling_path(existing, basename, &ctx.target).exists()
        }) {
            continue;
        }
        install_release_executable(ctx, &asset_name, basename, &dest, temp_root).await?;
    }
    Ok(())
}

/// Repairs an installed version that predates a companion requirement. Best-effort: the
/// app-server was already verified and works without companions, so a failed repair download
/// (or checksum mismatch) leaves them uninstalled without failing the update.
async fn repair_companions_best_effort(
    ctx: &InstallContext<'_>,
    app_server_executable: &Path,
    temp_root: &Path,
    lock_root: &Path,
) {
    let staged = temp_root
        .join("repair")
        .join(app_server_executable.file_name().unwrap_or_default());
    if std::fs::create_dir_all(staged.parent().unwrap_or(temp_root)).is_err() {
        return;
    }
    if install_companion_binaries(ctx, &staged, Some(app_server_executable), temp_root)
        .await
        .is_err()
    {
        return;
    }
    let _ = with_lock(app_server_executable, lock_root, || {
        promote_companion_binaries(&staged, app_server_executable, &ctx.target, true)
    })
    .await;
}

async fn promote_companion_binaries(
    executable: &Path,
    dest_executable: &Path,
    target: &CodexRuntimeTarget,
    only_missing: bool,
) -> Result<(), String> {
    for basename in target.companion_basenames() {
        let source = companion_sibling_path(executable, basename, target);
        if !source.exists() {
            continue;
        }
        let dest = companion_sibling_path(dest_executable, basename, target);
        if only_missing && dest.exists() {
            continue;
        }
        copy_executable_atomically(&source, &dest, target).await?;
    }
    Ok(())
}

/// Copies companions, then the app-server (the activation marker), then the version marker.
async fn promote_managed_install(
    executable: &Path,
    dest_executable: &Path,
    version: &str,
    target: &CodexRuntimeTarget,
    only_missing_companions: bool,
) -> Result<(), String> {
    if let Some(parent) = dest_executable.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    promote_companion_binaries(executable, dest_executable, target, only_missing_companions)
        .await?;
    copy_executable_atomically(executable, dest_executable, target).await?;
    cowork_config::write_text_file_atomic(
        &version_file_path(dest_executable),
        &format!("{version}\n"),
        None,
    )
    .map_err(|e| format!("Failed to write Codex app-server version marker: {e}"))
}

/// Promotes a verified versioned install to `current`. On Windows a running `current` copy cannot
/// be replaced; that is tolerated because Windows spawns the versioned executable.
async fn promote_current_best_effort(
    ctx: &InstallContext<'_>,
    executable: &Path,
    current: &Path,
    lock_root: &Path,
) -> Result<(), String> {
    let is_windows = ctx.target.is_windows();
    let version = ctx.release.version.clone();
    with_lock(current, lock_root, || async {
        match promote_managed_install(executable, current, &version, &ctx.target, false).await {
            Ok(()) => Ok(()),
            Err(_) if is_windows => Ok(()),
            Err(err) => Err(err),
        }
    })
    .await
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let left: Vec<&str> = a.split(['.', '-']).collect();
    let right: Vec<&str> = b.split(['.', '-']).collect();
    for index in 0..left.len().max(right.len()) {
        match (left.get(index), right.get(index)) {
            (None, Some(_)) => return Ordering::Greater,
            (Some(_), None) => return Ordering::Less,
            (Some(l), Some(r)) => match (l.parse::<u64>(), r.parse::<u64>()) {
                (Ok(ln), Ok(rn)) if ln != rn => return ln.cmp(&rn),
                (Ok(_), Ok(_)) => {}
                (Err(_), Err(_)) if l != r => return l.cmp(r),
                (Err(_), Err(_)) => {}
                (Ok(_), Err(_)) => return Ordering::Greater,
                (Err(_), Ok(_)) => return Ordering::Less,
            },
            (None, None) => {}
        }
    }
    Ordering::Equal
}

fn prune_managed_versions(cowork_home: &Path) {
    let versions_dir = managed_codex_root(cowork_home).join("versions");
    let Ok(entries) = std::fs::read_dir(&versions_dir) else {
        return;
    };
    let mut versions: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    if versions.len() <= MANAGED_VERSIONS_TO_KEEP {
        return;
    }
    versions.sort_by(|a, b| compare_versions(a, b));
    let prune_count = versions.len() - MANAGED_VERSIONS_TO_KEEP;
    for version in versions.into_iter().take(prune_count) {
        let _ = std::fs::remove_dir_all(versions_dir.join(version));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_codex_release_layout() {
        let linux = CodexRuntimeTarget::new("linux", "x64").unwrap();
        assert_eq!(
            linux.asset_name(APP_SERVER_BASENAME).unwrap(),
            "codex-app-server-x86_64-unknown-linux-musl.tar.gz"
        );
        let win = CodexRuntimeTarget::new("win32", "arm64").unwrap();
        assert_eq!(
            win.asset_name(CODEX_COMMAND_RUNNER_BASENAME).unwrap(),
            "codex-command-runner-aarch64-pc-windows-msvc.exe"
        );
        assert_eq!(win.companion_basenames().len(), 3);
        assert!(CodexRuntimeTarget::new("linux", "ia32").is_err());
        assert!(CodexRuntimeTarget::new("freebsd", "x64").is_err());
    }

    #[test]
    fn every_pinned_target_has_app_server_and_code_mode_host_checksums() {
        for (platform, arch) in [
            ("darwin", "x64"),
            ("darwin", "arm64"),
            ("linux", "x64"),
            ("linux", "arm64"),
            ("win32", "x64"),
            ("win32", "arm64"),
        ] {
            let target = CodexRuntimeTarget::new(platform, arch).unwrap();
            for basename in std::iter::once(APP_SERVER_BASENAME).chain(target.companion_basenames())
            {
                let asset = target.asset_name(basename).unwrap();
                assert!(
                    pinned_checksum(CODEX_APP_SERVER_MANAGED_VERSION, &asset).is_some(),
                    "missing pinned checksum for {asset}"
                );
            }
        }
    }

    #[test]
    fn versions_normalize_and_compare_like_ts() {
        assert_eq!(normalize_codex_version("rust-v0.160.0").unwrap(), "0.160.0");
        assert!(normalize_codex_version("latest").is_err());
        assert_eq!(
            compare_versions("0.160.0", "0.154.0"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            compare_versions("0.160.0", "0.160.0-alpha"),
            std::cmp::Ordering::Greater
        );
    }
}
