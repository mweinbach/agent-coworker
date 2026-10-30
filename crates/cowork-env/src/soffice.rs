use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    SandboxCommand, SandboxErrorCode, SandboxExecutionRequest, SandboxManager, SandboxPolicy,
    SandboxRunner, SandboxType, get_env, host_platform, minimal_sandbox_env, scratch_roots,
    set_env,
};
use dashmap::DashMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, watch};
use url::Url;
use uuid::Uuid;

use crate::error::{EnvError, Result};
use crate::shell::redact_secrets;

/// Availability state returned by `cowork/runtime/libreoffice/check`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibreOfficeCheckStatus {
    Available,
    Unavailable,
}

/// Optional conversion smoke-check metrics inside `LibreOfficeCapabilityDiagnostic`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibreOfficeSmokeResult {
    pub ok: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Wire-compatible payload returned under `result.status` by `cowork/runtime/libreoffice/check`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibreOfficeCapabilityDiagnostic {
    pub status: LibreOfficeCheckStatus,
    pub checked_at: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke: Option<LibreOfficeSmokeResult>,
}

/// Configuration for the bounded, sandboxed `SofficeRunner` pool.
#[derive(Clone)]
pub struct SofficeRunnerConfig {
    pub max_concurrent: usize,
    pub default_timeout: Duration,
    pub sandbox_manager: SandboxManager,
    pub homedir: PathBuf,
}

/// Request parameters for a sandboxed headless LibreOffice conversion.
#[derive(Debug, Clone)]
pub struct SofficeConvertRequest {
    pub input_path: PathBuf,
    pub output_dir: PathBuf,
    pub convert_to: String,
    pub extra_args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub timeout: Option<Duration>,
}

/// Result of a sandboxed headless LibreOffice conversion.
#[derive(Debug, Clone)]
pub struct SofficeConvertResult {
    pub output_path: PathBuf,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub sandbox: SandboxType,
    pub observed_pool_in_flight: usize,
}

/// Request parameters for rendering PDF pages to PNG via managed `pdftoppm`.
#[derive(Debug, Clone)]
pub struct PdftoppmJobRequest {
    pub pdf_path: PathBuf,
    pub output_dir: PathBuf,
    pub dpi: u32,
    pub first_page: Option<u32>,
    pub last_page: Option<u32>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub timeout: Option<Duration>,
}

struct JobScratchGuard {
    dir: PathBuf,
}

impl JobScratchGuard {
    fn create(prefix: &str) -> Result<(Self, PathBuf, PathBuf)> {
        let scratch_base = scratch_roots(None)
            .into_iter()
            .next()
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&scratch_base)?;
        let canonical_base = canonicalize_sync(&scratch_base);
        let dir = canonical_base.join(format!("{prefix}{}", Uuid::new_v4().simple()));
        let profile_dir = dir.join("profile");
        let tmp_dir = dir.join("tmp");
        std::fs::create_dir_all(&profile_dir)?;
        std::fs::create_dir_all(&tmp_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for p in [&dir, &profile_dir, &tmp_dir] {
                if let Ok(m) = std::fs::metadata(p) {
                    let mut perms = m.permissions();
                    perms.set_mode(0o700);
                    let _ = std::fs::set_permissions(p, perms);
                }
            }
        }
        Ok((Self { dir }, profile_dir, tmp_dir))
    }

    fn path(&self) -> &Path {
        &self.dir
    }

    fn cleanup_now(&self) {
        if self.dir.exists() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

impl Drop for JobScratchGuard {
    fn drop(&mut self) {
        self.cleanup_now();
    }
}

struct InFlightCounterGuard {
    counter: Arc<AtomicUsize>,
}

impl Drop for InFlightCounterGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Strictly validates caller-supplied `soffice` arguments before spawn, rejecting interactive UI,
/// macro/script execution, printing, remote URLs, and `-env:UserInstallation` overrides.
pub fn validate_soffice_args(args: &[String]) -> Result<()> {
    let mut idx = 0usize;
    while idx < args.len() {
        let arg = args[idx].trim();
        if arg.is_empty() || arg.contains('\0') {
            return Err(EnvError::SofficeForbiddenFlag(format!(
                "Empty or NUL argument at index {idx}"
            )));
        }

        let lower = arg.to_ascii_lowercase();

        // Reject macro / script / UNO / remote URL schemes anywhere in positional or flag args.
        for scheme in [
            "macro:",
            "vnd.sun.star.script:",
            ".uno:",
            "slot:",
            "service:",
            "http://",
            "https://",
            "ftp://",
            "smb://",
            "dav://",
            "davs://",
            "file://",
        ] {
            if lower.starts_with(scheme) || lower.contains(&format!("={scheme}")) {
                return Err(EnvError::SofficeForbiddenFlag(format!(
                    "Forbidden URI/macro scheme in argument {arg:?}"
                )));
            }
        }

        // Reject caller attempts to override isolated `-env:UserInstallation`.
        if lower.starts_with("-env:") || lower.starts_with("--env:") {
            return Err(EnvError::SofficeForbiddenFlag(format!(
                "Caller -env: overrides are forbidden ({arg:?})"
            )));
        }

        if arg.starts_with('-') {
            match lower.as_str() {
                "--version"
                | "-h"
                | "--help"
                | "--headless"
                | "--invisible"
                | "--nocrashreport"
                | "--nodefault"
                | "--nofirststartwizard"
                | "--nologo"
                | "--norestore"
                | "--nolockcheck"
                | "--cat" => {
                    idx += 1;
                }
                "--convert-to" | "--outdir" => {
                    let Some(val) = args.get(idx + 1) else {
                        return Err(EnvError::SofficeForbiddenFlag(format!(
                            "Flag {arg} requires a value"
                        )));
                    };
                    if val.trim().is_empty() || val.starts_with('-') {
                        return Err(EnvError::SofficeForbiddenFlag(format!(
                            "Invalid value {val:?} for {arg}"
                        )));
                    }
                    idx += 2;
                }
                _ if lower.starts_with("--infilter=") || lower.starts_with("--convert-to=") => {
                    idx += 1;
                }
                _ => {
                    return Err(EnvError::SofficeForbiddenFlag(format!(
                        "Disallowed LibreOffice flag {arg:?} (UI, macro, print, and socket modes are blocked)"
                    )));
                }
            }
        } else {
            idx += 1;
        }
    }
    Ok(())
}

/// Validates `pdftoppm` arguments before spawn.
pub fn validate_pdftoppm_args(args: &[String]) -> Result<()> {
    for arg in args {
        if arg.is_empty() || arg.contains('\0') {
            return Err(EnvError::SofficeForbiddenFlag(
                "Invalid empty/NUL pdftoppm argument".to_owned(),
            ));
        }
    }
    Ok(())
}

fn resolve_managed_soffice(env: &HashMap<String, String>) -> Result<PathBuf> {
    let platform = host_platform();
    let Some(raw) = get_env(env, "COWORK_RUNTIME_SOFFICE", platform)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Err(EnvError::SofficeUnavailable(
            "COWORK_RUNTIME_SOFFICE is not configured in the active Cowork runtime.".to_owned(),
        ));
    };
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err(EnvError::SofficeUnavailable(format!(
            "Managed LibreOffice launcher in active Cowork runtime does not exist: {}",
            path.display()
        )));
    }
    Ok(canonicalize_sync(&path))
}

fn resolve_managed_pdftoppm(env: &HashMap<String, String>) -> Result<PathBuf> {
    let platform = host_platform();
    if let Some(raw) = get_env(env, "COWORK_RUNTIME_PDFTOPPM", platform)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(raw);
        if p.is_file() {
            return Ok(canonicalize_sync(&p));
        }
    }
    if let Some(poppler_bin) = get_env(env, "COWORK_RUNTIME_POPPLER_BIN", platform)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let exe_name = if platform == "win32" {
            "pdftoppm.exe"
        } else {
            "pdftoppm"
        };
        let p = PathBuf::from(poppler_bin).join(exe_name);
        if p.is_file() {
            return Ok(canonicalize_sync(&p));
        }
    }
    Err(EnvError::SofficeUnavailable(
        "Managed pdftoppm binary is not configured in the active Cowork runtime.".to_owned(),
    ))
}

fn parse_libreoffice_version(output: &str) -> Option<String> {
    let re = Regex::new(r"(?i)LibreOffice(?:\s+Community)?\s+([0-9]+(?:\.[0-9A-Za-z-]+)+)").ok()?;
    re.captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

fn build_isolated_child_env(
    base_env: &HashMap<String, String>,
    scratch_home: &Path,
    scratch_tmp: &Path,
) -> HashMap<String, String> {
    let platform = host_platform();
    let mut env = minimal_sandbox_env(base_env, platform);

    // Ensure LibreOffice's private `program` dir is never on PATH.
    if let Some(lo_bin) = get_env(&env, "COWORK_RUNTIME_LIBREOFFICE_BINARY", platform)
        .and_then(|s| Path::new(s).parent())
        .map(|p| p.to_string_lossy().into_owned())
        && let Some(cur_path) = get_env(&env, "PATH", platform).map(str::to_owned)
    {
        let delim = if platform == "win32" { ';' } else { ':' };
        let filtered: Vec<&str> = cur_path
            .split(delim)
            .filter(|seg| {
                if platform == "win32" {
                    !seg.trim().eq_ignore_ascii_case(&lo_bin)
                } else {
                    seg.trim() != lo_bin
                }
            })
            .collect();
        set_env(
            &mut env,
            "PATH",
            filtered.join(&delim.to_string()),
            platform,
        );
    }

    let tmp_str = scratch_tmp.to_string_lossy().into_owned();
    let home_str = scratch_home.to_string_lossy().into_owned();
    set_env(&mut env, "HOME", home_str.clone(), platform);
    set_env(&mut env, "TMPDIR", tmp_str.clone(), platform);
    set_env(&mut env, "TMP", tmp_str.clone(), platform);
    set_env(&mut env, "TEMP", tmp_str, platform);
    if platform == "win32" {
        set_env(&mut env, "USERPROFILE", home_str, platform);
    }
    set_env(
        &mut env,
        "SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION",
        "1".to_owned(),
        platform,
    );
    set_env(&mut env, "SAL_USE_VCLPLUGIN", "svp".to_owned(), platform);
    env
}

/// Non-blocking bounded-concurrency pool executing headless LibreOffice (`soffice`) and `pdftoppm`
/// inside OS sandboxes with disposable per-invocation `-env:UserInstallation` profiles.
pub struct SofficeRunner {
    semaphore: Arc<Semaphore>,
    default_timeout: Duration,
    sandbox_runner: SandboxRunner,
    in_flight: Arc<AtomicUsize>,
    next_job_id: AtomicU64,
    active_cancels: Arc<DashMap<u64, watch::Sender<bool>>>,
}

impl SofficeRunner {
    pub fn new(cfg: SofficeRunnerConfig) -> Self {
        let permits = cfg.max_concurrent.max(1);
        Self {
            semaphore: Arc::new(Semaphore::new(permits)),
            default_timeout: cfg.default_timeout,
            sandbox_runner: SandboxRunner::new(cfg.sandbox_manager),
            in_flight: Arc::new(AtomicUsize::new(0)),
            next_job_id: AtomicU64::new(1),
            active_cancels: Arc::new(DashMap::new()),
        }
    }

    /// Cancels all in-flight LibreOffice / `pdftoppm` child process groups immediately.
    pub async fn shutdown(&self) {
        for entry in self.active_cancels.iter() {
            let _ = entry.value().send(true);
        }
        self.active_cancels.clear();
    }

    fn verify_full_sandbox_enforcement(&self, env: &HashMap<String, String>) -> Result<()> {
        let caps = self
            .sandbox_runner
            .manager()
            .detect_capabilities(Some(host_platform()), Some(env));
        let enforcement = caps.enforcement;
        if caps.backend == SandboxType::None
            || !enforcement.filesystem
            || !enforcement.network
            || !enforcement.process
            || !enforcement.integrity
        {
            return Err(EnvError::SofficeSandboxUnenforced(
                caps.warning.unwrap_or_else(|| {
                    "Host sandbox lacks full filesystem/network/process/integrity enforcement"
                        .to_owned()
                }),
            ));
        }
        Ok(())
    }

    /// Runs a headless LibreOffice document conversion inside the bounded pool and OS sandbox.
    pub async fn convert_document(
        &self,
        req: SofficeConvertRequest,
    ) -> Result<SofficeConvertResult> {
        let soffice_bin = resolve_managed_soffice(&req.env)?;
        if req.convert_to.trim().is_empty() || req.convert_to.starts_with('-') {
            return Err(EnvError::SofficeForbiddenFlag(format!(
                "Invalid --convert-to format {:?}",
                req.convert_to
            )));
        }

        let canonical_input = canonicalize_sync(&req.input_path);
        if !canonical_input.is_file() {
            return Err(EnvError::SofficeFailed(format!(
                "Input file does not exist: {}",
                req.input_path.display()
            )));
        }
        std::fs::create_dir_all(&req.output_dir)?;
        let canonical_outdir = canonicalize_sync(&req.output_dir);

        let mut user_args = req.extra_args.clone();
        user_args.extend([
            "--convert-to".to_owned(),
            req.convert_to.clone(),
            "--outdir".to_owned(),
            canonical_outdir.to_string_lossy().into_owned(),
            canonical_input.to_string_lossy().into_owned(),
        ]);
        validate_soffice_args(&user_args)?;

        let _permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| EnvError::SofficeFailed("SofficeRunner pool closed".to_owned()))?;
        let active_now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        let _counter_guard = InFlightCounterGuard {
            counter: self.in_flight.clone(),
        };

        let (scratch_guard, profile_dir, tmp_dir) = JobScratchGuard::create("cowork-soffice-job-")?;
        let profile_url = Url::from_file_path(&profile_dir)
            .map(|u| u.to_string())
            .map_err(|_| {
                EnvError::SofficeFailed(format!(
                    "Failed building file:// URL for {}",
                    profile_dir.display()
                ))
            })?;

        let mut full_args = vec![
            "--headless".to_owned(),
            "--invisible".to_owned(),
            "--nocrashreport".to_owned(),
            "--nodefault".to_owned(),
            "--nofirststartwizard".to_owned(),
            "--nologo".to_owned(),
            "--norestore".to_owned(),
            format!("-env:UserInstallation={profile_url}"),
        ];
        full_args.extend(user_args);

        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![scratch_guard.path().to_path_buf(), canonical_outdir.clone()],
            writable_root_kinds: HashMap::new(),
            network: false,
        };
        let child_env = build_isolated_child_env(&req.env, scratch_guard.path(), &tmp_dir);
        self.verify_full_sandbox_enforcement(&child_env)?;

        let timeout = req.timeout.unwrap_or(self.default_timeout);
        let mut sreq = SandboxExecutionRequest::new(
            SandboxCommand::new(soffice_bin.to_string_lossy().into_owned(), full_args),
            policy,
            &req.cwd,
        );
        sreq.yolo = false;
        sreq.require_backend = true;
        sreq.timeout = Some(timeout);
        sreq.env_source = Some(child_env.clone());
        sreq.extra_env = child_env;

        let job_id = self.next_job_id.fetch_add(1, Ordering::Relaxed);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.active_cancels.insert(job_id, cancel_tx);

        let started = Instant::now();
        let exec_res = self
            .sandbox_runner
            .run_with_approval(
                sreq,
                Some(cancel_rx),
                None::<fn(Option<&str>) -> std::future::Ready<bool>>,
            )
            .await;
        self.active_cancels.remove(&job_id);
        let duration_ms = started.elapsed().as_millis() as u64;

        // Clean up the temporary profile & scratch dir immediately now that the child process group has exited.
        scratch_guard.cleanup_now();

        if exec_res.error_code == Some(SandboxErrorCode::Timeout) {
            return Err(EnvError::SofficeTimeout {
                timeout_ms: timeout.as_millis() as u64,
            });
        }
        if exec_res.unsandboxed || exec_res.sandbox == SandboxType::None {
            return Err(EnvError::SofficeSandboxUnenforced(
                exec_res
                    .sandbox_warning
                    .unwrap_or_else(|| "LibreOffice conversion ran without OS sandbox".to_owned()),
            ));
        }
        if let Some(code) = exec_res.error_code {
            return Err(EnvError::SofficeFailed(format!(
                "Sandbox error ({code:?}): {}",
                redact_secrets(&exec_res.stderr)
            )));
        }
        if exec_res.exit_code != 0 {
            return Err(EnvError::SofficeFailed(format!(
                "soffice exited with code {}: {}",
                exec_res.exit_code,
                redact_secrets(exec_res.stderr.trim())
            )));
        }

        let target_ext = req
            .convert_to
            .split(':')
            .next()
            .unwrap_or(&req.convert_to)
            .trim();
        let stem = canonical_input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        let expected_out = canonical_outdir.join(format!("{stem}.{target_ext}"));
        if !expected_out.is_file() {
            return Err(EnvError::SofficeFailed(format!(
                "LibreOffice completed with exit 0 but did not produce {}",
                expected_out.display()
            )));
        }

        Ok(SofficeConvertResult {
            output_path: expected_out,
            stdout: exec_res.stdout,
            stderr: exec_res.stderr,
            duration_ms,
            sandbox: exec_res.sandbox,
            observed_pool_in_flight: active_now,
        })
    }

    /// Renders PDF pages to PNG images via managed `pdftoppm` inside the bounded pool and OS sandbox.
    pub async fn render_pdf_pages(&self, req: PdftoppmJobRequest) -> Result<Vec<PathBuf>> {
        let pdftoppm_bin = resolve_managed_pdftoppm(&req.env)?;
        let canonical_pdf = canonicalize_sync(&req.pdf_path);
        if !canonical_pdf.is_file() {
            return Err(EnvError::SofficeFailed(format!(
                "PDF file does not exist: {}",
                req.pdf_path.display()
            )));
        }
        std::fs::create_dir_all(&req.output_dir)?;
        let canonical_outdir = canonicalize_sync(&req.output_dir);

        let prefix = canonical_outdir.join("page");
        let mut args = vec![
            "-png".to_owned(),
            "-r".to_owned(),
            req.dpi.max(36).to_string(),
        ];
        if let Some(f) = req.first_page {
            args.push("-f".to_owned());
            args.push(f.to_string());
        }
        if let Some(l) = req.last_page {
            args.push("-l".to_owned());
            args.push(l.to_string());
        }
        args.push(canonical_pdf.to_string_lossy().into_owned());
        args.push(prefix.to_string_lossy().into_owned());
        validate_pdftoppm_args(&args)?;

        let _permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| EnvError::SofficeFailed("SofficeRunner pool closed".to_owned()))?;
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let _counter_guard = InFlightCounterGuard {
            counter: self.in_flight.clone(),
        };

        let (scratch_guard, _, tmp_dir) = JobScratchGuard::create("cowork-pdftoppm-job-")?;
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![scratch_guard.path().to_path_buf(), canonical_outdir.clone()],
            writable_root_kinds: HashMap::new(),
            network: false,
        };
        let child_env = build_isolated_child_env(&req.env, scratch_guard.path(), &tmp_dir);
        self.verify_full_sandbox_enforcement(&child_env)?;

        let timeout = req.timeout.unwrap_or(self.default_timeout);
        let mut sreq = SandboxExecutionRequest::new(
            SandboxCommand::new(pdftoppm_bin.to_string_lossy().into_owned(), args),
            policy,
            &req.cwd,
        );
        sreq.yolo = false;
        sreq.require_backend = true;
        sreq.timeout = Some(timeout);
        sreq.env_source = Some(child_env.clone());
        sreq.extra_env = child_env;

        let job_id = self.next_job_id.fetch_add(1, Ordering::Relaxed);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.active_cancels.insert(job_id, cancel_tx);
        let exec_res = self
            .sandbox_runner
            .run_with_approval(
                sreq,
                Some(cancel_rx),
                None::<fn(Option<&str>) -> std::future::Ready<bool>>,
            )
            .await;
        self.active_cancels.remove(&job_id);
        scratch_guard.cleanup_now();

        if exec_res.error_code == Some(SandboxErrorCode::Timeout) {
            return Err(EnvError::SofficeTimeout {
                timeout_ms: timeout.as_millis() as u64,
            });
        }
        if exec_res.unsandboxed || exec_res.sandbox == SandboxType::None {
            return Err(EnvError::SofficeSandboxUnenforced(
                "pdftoppm ran without OS sandbox".to_owned(),
            ));
        }
        if exec_res.exit_code != 0 {
            return Err(EnvError::SofficeFailed(format!(
                "pdftoppm exited with code {}: {}",
                exec_res.exit_code,
                redact_secrets(exec_res.stderr.trim())
            )));
        }

        let mut pages: Vec<PathBuf> = std::fs::read_dir(&canonical_outdir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("page-") && n.ends_with(".png"))
            })
            .collect();
        pages.sort();
        Ok(pages)
    }

    /// Executes the non-blocking `cowork/runtime/libreoffice/check` probe (`--version` and optional
    /// sandboxed HTML -> PDF smoke conversion).
    pub async fn check_capability(
        &self,
        cwd: &Path,
        env: &HashMap<String, String>,
        smoke: bool,
    ) -> LibreOfficeCapabilityDiagnostic {
        let checked_at = chrono::Utc::now().to_rfc3339();
        let soffice_bin = match resolve_managed_soffice(env) {
            Ok(p) => p,
            Err(err) => {
                return LibreOfficeCapabilityDiagnostic {
                    status: LibreOfficeCheckStatus::Unavailable,
                    checked_at,
                    message: redact_secrets(&err.to_string()),
                    version: None,
                    resolved_path: None,
                    smoke: None,
                };
            }
        };
        let resolved_str = soffice_bin.to_string_lossy().into_owned();

        // Run quick `--headless --version` probe inside isolated scratch profile.
        let version = match self.run_version_probe(&soffice_bin, cwd, env).await {
            Ok(ver) => ver,
            Err(err) => {
                let err_msg = redact_secrets(&err.to_string());
                return LibreOfficeCapabilityDiagnostic {
                    status: LibreOfficeCheckStatus::Unavailable,
                    checked_at,
                    message: format!("LibreOffice version probe failed: {err_msg}"),
                    version: None,
                    resolved_path: Some(resolved_str),
                    smoke: smoke.then_some(LibreOfficeSmokeResult {
                        ok: false,
                        duration_ms: 0,
                        size_bytes: None,
                        error: Some(err_msg),
                    }),
                };
            }
        };

        if !smoke {
            return LibreOfficeCapabilityDiagnostic {
                status: LibreOfficeCheckStatus::Available,
                checked_at,
                message: "Cowork's managed LibreOffice launcher responds to --version; UI and printing modes are blocked, but conversion readiness is unverified. Request a sandboxed conversion smoke check before relying on document rendering.".to_owned(),
                version,
                resolved_path: Some(resolved_str),
                smoke: None,
            };
        }

        let smoke_started = Instant::now();
        let Ok((smoke_scratch, _, _)) = JobScratchGuard::create("cowork-soffice-smoke-") else {
            return LibreOfficeCapabilityDiagnostic {
                status: LibreOfficeCheckStatus::Unavailable,
                checked_at,
                message:
                    "Failed allocating isolated scratch directory for LibreOffice smoke check."
                        .to_owned(),
                version,
                resolved_path: Some(resolved_str),
                smoke: Some(LibreOfficeSmokeResult {
                    ok: false,
                    duration_ms: smoke_started.elapsed().as_millis() as u64,
                    size_bytes: None,
                    error: Some("Failed creating smoke scratch directory".to_owned()),
                }),
            };
        };

        let smoke_in = smoke_scratch.path().join("cowork-soffice-smoke.html");
        let smoke_out_dir = smoke_scratch.path().join("out");
        let _ = std::fs::create_dir_all(&smoke_out_dir);
        let _ = std::fs::write(
            &smoke_in,
            "<!doctype html><html><body><p>Cowork LibreOffice smoke check</p></body></html>\n",
        );

        let conv_res = self
            .convert_document(SofficeConvertRequest {
                input_path: smoke_in,
                output_dir: smoke_out_dir,
                convert_to: "pdf".to_owned(),
                extra_args: Vec::new(),
                cwd: cwd.to_path_buf(),
                env: env.clone(),
                timeout: Some(Duration::from_secs(20)),
            })
            .await;

        match conv_res {
            Ok(done) => {
                let size_bytes = std::fs::metadata(&done.output_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                smoke_scratch.cleanup_now();
                if size_bytes == 0 {
                    LibreOfficeCapabilityDiagnostic {
                        status: LibreOfficeCheckStatus::Unavailable,
                        checked_at,
                        message: "LibreOffice smoke conversion produced an empty PDF.".to_owned(),
                        version,
                        resolved_path: Some(resolved_str),
                        smoke: Some(LibreOfficeSmokeResult {
                            ok: false,
                            duration_ms: done.duration_ms,
                            size_bytes: None,
                            error: Some("Produced 0-byte PDF".to_owned()),
                        }),
                    }
                } else {
                    LibreOfficeCapabilityDiagnostic {
                        status: LibreOfficeCheckStatus::Available,
                        checked_at,
                        message: "Cowork's managed LibreOffice launcher completed a sandboxed headless PDF conversion smoke check.".to_owned(),
                        version,
                        resolved_path: Some(resolved_str),
                        smoke: Some(LibreOfficeSmokeResult {
                            ok: true,
                            duration_ms: done.duration_ms,
                            size_bytes: Some(size_bytes),
                            error: None,
                        }),
                    }
                }
            }
            Err(err) => {
                let elapsed = smoke_started.elapsed().as_millis() as u64;
                smoke_scratch.cleanup_now();
                let err_str = redact_secrets(&err.to_string());
                LibreOfficeCapabilityDiagnostic {
                    status: LibreOfficeCheckStatus::Unavailable,
                    checked_at,
                    message: format!("LibreOffice conversion smoke check failed: {err_str}"),
                    version,
                    resolved_path: Some(resolved_str),
                    smoke: Some(LibreOfficeSmokeResult {
                        ok: false,
                        duration_ms: elapsed,
                        size_bytes: None,
                        error: Some(err_str),
                    }),
                }
            }
        }
    }

    async fn run_version_probe(
        &self,
        soffice_bin: &Path,
        cwd: &Path,
        env: &HashMap<String, String>,
    ) -> Result<Option<String>> {
        let _permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| EnvError::SofficeFailed("SofficeRunner pool closed".to_owned()))?;
        let (scratch_guard, profile_dir, tmp_dir) = JobScratchGuard::create("cowork-soffice-ver-")?;
        let profile_url = Url::from_file_path(&profile_dir)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| format!("file://{}", profile_dir.to_string_lossy()));

        let args = vec![
            "--headless".to_owned(),
            format!("-env:UserInstallation={profile_url}"),
            "--version".to_owned(),
        ];
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![scratch_guard.path().to_path_buf()],
            writable_root_kinds: HashMap::new(),
            network: false,
        };
        let child_env = build_isolated_child_env(env, scratch_guard.path(), &tmp_dir);

        let mut req = SandboxExecutionRequest::new(
            SandboxCommand::new(soffice_bin.to_string_lossy().into_owned(), args),
            policy,
            cwd,
        );
        req.yolo = false;
        req.require_backend = false;
        req.timeout = Some(Duration::from_secs(10));
        req.env_source = Some(child_env.clone());
        req.extra_env = child_env;

        let res = self
            .sandbox_runner
            .run_with_approval(
                req,
                None,
                None::<fn(Option<&str>) -> std::future::Ready<bool>>,
            )
            .await;
        scratch_guard.cleanup_now();

        if res.exit_code != 0 {
            return Err(EnvError::SofficeFailed(format!(
                "soffice --version exited with {}: {}",
                res.exit_code,
                res.stderr.trim()
            )));
        }
        let combined = format!("{}\n{}", res.stdout, res.stderr);
        Ok(parse_libreoffice_version(&combined))
    }
}
