//! `cowork-sandbox` — OS Sandboxing & Self-Exec Enforcement Layer.
//!
//! Module boundaries owned by this crate:
//! - **Policy resolver & hard floors** (`policy`): Computes `SandboxPolicy` (`read-only`,
//!   `no-project-write`, `workspace-write`, `danger-full-access`), enforces child `targetPaths`
//!   and `SANDBOX_REQUIRED` fail-closed rules, preserves hard security floors even under `--yolo`,
//!   and excludes both lexical and canonicalized blocked roots in `tmp_scratch_roots`.
//! - **Cached `.git` / `.cowork` exclusions** (`protected_paths`): `WorkspaceProtectedPathsCache`
//!   combines `ignore::WalkBuilder` with `notify::RecommendedWatcher` to maintain protected subpath
//!   exclusions without running a synchronous full-workspace walk before every command.
//! - **Cross-platform OS backends** (`seatbelt`, `bwrap`, `linux_seccomp`, `windows`, `detect`,
//!   `manager`, `runner`, `cli`):
//!   - **macOS**: Verified `/usr/bin/sandbox-exec` Seatbelt profiles with canonical `/private/tmp`
//!     realpaths and `anchor apple` code-signature validation.
//!   - **Linux**: `bwrap` namespaces + `<self_exe> __sandbox-exec --linux-seccomp` native Rust
//!     `pre_exec` classic-BPF syscall filter (zero `/usr/bin/python3` dependency).
//!   - **Windows**: `cowork-win-sandbox.exe` restricted-token + Job Object integration, offline-safe
//!     native `WinVerifyTrust` Authenticode verification, unified `~/.cowork` sandbox home, and
//!     newest-wins v5 setup state synchronization.
//! - **Denial classification & approval escalation** (`denial`, `approval`): Distinguishes genuine
//!   OS network and filesystem sandbox denials from ordinary tool errors without substring false
//!   positives and computes minimum widened retry policies.

pub mod approval;
pub mod bwrap;
pub mod cli;
pub mod denial;
pub mod detect;
pub mod env_utils;
pub mod linux_seccomp;
pub mod manager;
pub mod policy;
pub mod protected_paths;
pub mod runner;
pub mod seatbelt;
pub mod windows;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use approval::{
    CommandApprovalClassification, CommandApprovalReasonCode, CommandRiskLevel,
    classify_command_detailed,
};
pub use bwrap::{BwrapBuildOptions, build_bwrap_command, resolve_sandbox_exec_binary};
pub use cli::{
    ParsedSandboxExecArgs, RunSandboxExecOptions, parse_sandbox_exec_args, resolve_cli_run_policy,
    run_sandbox_exec_cli,
};
pub use cowork_config::{SandboxConfig, SandboxMode as SandboxConfigMode};
pub use denial::{
    ClassifyDenialOptions, SandboxDenialCategory, SandboxDenialClassification,
    SandboxDenialDetailKind, SandboxEscalationPlan, classify_sandbox_denial,
    classify_sandbox_denial_detailed, describe_sandbox_denial, is_likely_sandbox_denied,
    plan_sandbox_escalation,
};
pub use detect::{
    BWRAP_RETRY_COOLDOWN_MS, BwrapProbeOptions, ProbeCommandOutput, SEATBELT_RETRY_COOLDOWN_MS,
    SeatbeltCheckOptions, WINDOWS_SANDBOX_PROBE_TIMEOUT_MS, WINDOWS_SANDBOX_PROBE_TTL_MS,
    WindowsProbeOptions, WindowsSandboxProbeResult, find_bwrap, find_windows_helper, has_seatbelt,
    has_seatbelt_with_options, is_bwrap_usable, is_bwrap_usable_with_options,
    probe_windows_sandbox_bundle, reset_bwrap_cache_for_tests, reset_seatbelt_cache_for_tests,
    reset_windows_probe_cache_for_tests,
};
pub use env_utils::{
    PARENT_MANAGED_ENV_VAR, find_env_key, get_env, host_arch, host_platform, minimal_sandbox_env,
    remove_env, sandbox_env_allowlist, sanitized_process_env, set_env,
};
pub use linux_seccomp::{
    LinuxSeccompInstruction, build_linux_socket_filter, build_linux_socket_filter_fixed,
    evaluate_seccomp_bpf,
};
#[cfg(target_os = "linux")]
pub use linux_seccomp::{apply_linux_seccomp_filter, install_linux_seccomp_pre_exec};
pub use manager::{
    SandboxCapabilities, SandboxEnforcement, SandboxGateDecision, SandboxManager, TransformOptions,
};
pub use policy::{
    FilteredTargetPaths, ResolveSandboxPolicyInput, SandboxPolicy, WritableRootKind,
    canonical_tmp_alias, filter_target_paths_to_workspace, infer_missing_target_root_kind,
    is_usable_target_path, normalize_sandbox_child_env, policy_allows_network,
    requires_hard_floor_enforcement, resolve_sandbox_policy, scratch_roots, tmp_scratch_roots,
    with_tmp_scratch,
};
pub use protected_paths::{
    PROTECTED_SUBDIRS, ProtectedMetadataOptions, ProtectedPathsCacheStats,
    WorkspaceProtectedPathsCache, global_protected_paths_cache, is_protected_metadata_name,
    platform_is_case_insensitive, protected_metadata_paths,
};
pub use runner::{
    DEFAULT_MAX_BUFFER_BYTES, SandboxExecutionRequest, SandboxExecutionResult, SandboxRunner,
};
pub use seatbelt::{
    MACOS_SEATBELT_EXECUTABLE, build_seatbelt_command, build_seatbelt_command_with_cache,
};
pub use windows::{
    CODEX_WINDOWS_SANDBOX_SETUP_VERSION, WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
    WINDOWS_SANDBOX_HASH_MANIFEST_NAME, WINDOWS_SANDBOX_HELPER_NAME, WINDOWS_SANDBOX_SETUP_NAME,
    WindowsSandboxHashManifest, build_windows_sandbox_command, is_native_windows_binary,
    load_windows_sandbox_hash_manifest, read_windows_pe_machine,
    sync_codex_windows_sandbox_setup_state, sync_codex_windows_sandbox_setup_state_between,
    verify_windows_authenticode, windows_sandbox_home, windows_sandbox_home_for_platform,
};

/// Resolved sandbox execution modes enforced by `cowork-sandbox` (`read-only`, `no-project-write`,
/// `workspace-write`, `danger-full-access`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    NoProjectWrite,
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    /// Returns whether this mode represents a hard floor that `--yolo` MUST NOT lift.
    pub const fn is_hard_floor(self) -> bool {
        matches!(self, Self::ReadOnly | Self::NoProjectWrite)
    }
}

/// Active OS sandbox backend identifier matching wire `"seatbelt" | "bwrap" | "windows" | "none"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxType {
    Seatbelt,
    Bwrap,
    Windows,
    None,
}

impl SandboxType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Seatbelt => "seatbelt",
            Self::Bwrap => "bwrap",
            Self::Windows => "windows",
            Self::None => "none",
        }
    }
}

/// Machine-readable error codes returned by `SandboxManager` and `SandboxRunner`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SandboxErrorCode {
    #[serde(rename = "SANDBOX_REQUIRED")]
    SandboxRequired,
    #[serde(rename = "TIMEOUT")]
    Timeout,
    #[serde(rename = "ABORT_ERR")]
    AbortErr,
    #[serde(rename = "SANDBOX_BACKEND_FAILED")]
    BackendFailed,
}

/// Inner command (`file` + `args`) before OS sandbox wrapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCommand {
    pub file: String,
    pub args: Vec<String>,
}

impl SandboxCommand {
    pub fn new(file: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            file: file.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }
}

/// Wrapped command ready to spawn under the selected OS sandbox backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransformedCommand {
    pub file: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub sandbox: SandboxType,
    pub unsandboxed: bool,
}

/// Typed errors surfaced by `cowork-sandbox`.
#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("SANDBOX_REQUIRED: {0}")]
    SandboxRequired(String),
    #[error("sandbox execution timed out")]
    Timeout,
    #[error("sandbox execution cancelled")]
    Cancelled,
    #[error("sandbox I/O error: {0}")]
    Io(#[from] std::io::Error),
}
