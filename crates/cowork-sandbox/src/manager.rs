use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::bwrap::{BwrapBuildOptions, build_bwrap_command};
use crate::detect::{
    WindowsProbeOptions, find_bwrap, find_windows_helper, has_seatbelt, is_bwrap_usable,
    probe_windows_sandbox_bundle,
};
use crate::env_utils::{host_platform, sanitized_process_env};
use crate::policy::{SandboxPolicy, policy_allows_network, requires_hard_floor_enforcement};
use crate::protected_paths::{WorkspaceProtectedPathsCache, global_protected_paths_cache};
use crate::seatbelt::build_seatbelt_command_with_cache;
use crate::windows::build_windows_sandbox_command;
use crate::{SandboxCommand, SandboxErrorCode, SandboxType, TransformedCommand};

/// Per-dimension kernel enforcement capabilities of an OS sandbox backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxEnforcement {
    pub filesystem: bool,
    pub network: bool,
    pub process: bool,
    pub integrity: bool,
}

impl SandboxEnforcement {
    pub const NONE: Self = Self {
        filesystem: false,
        network: false,
        process: false,
        integrity: false,
    };

    pub const FULL: Self = Self {
        filesystem: true,
        network: true,
        process: true,
        integrity: true,
    };
}

/// Detected OS sandbox backend and enforcement dimensions for the current host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxCapabilities {
    pub backend: SandboxType,
    pub bwrap_path: Option<PathBuf>,
    pub windows_helper_path: Option<PathBuf>,
    pub enforcement: SandboxEnforcement,
    pub warning: Option<String>,
    pub setup_required: bool,
}

impl SandboxCapabilities {
    pub fn none(warning: impl Into<String>) -> Self {
        Self {
            backend: SandboxType::None,
            bwrap_path: None,
            windows_helper_path: None,
            enforcement: SandboxEnforcement::NONE,
            warning: Some(warning.into()),
            setup_required: false,
        }
    }
}

/// Optional overrides for `SandboxManager::transform_with_options`.
#[derive(Default)]
pub struct TransformOptions<'a> {
    pub platform: Option<&'a str>,
    pub capabilities: Option<&'a SandboxCapabilities>,
    pub sandbox_exec_path: Option<&'a Path>,
    pub env_source: Option<&'a HashMap<String, String>>,
}

/// Outcome of evaluating `SANDBOX_REQUIRED` and approval gates before command execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxGateDecision {
    /// Execute the wrapped OS-sandboxed command.
    RunSandboxed(TransformedCommand),
    /// Execute the raw inner command unsandboxed (e.g. `--yolo` with no hard floor).
    RunUnsandboxed { warning: Option<String> },
    /// Backend cannot enforce a non-hard-floor policy; caller must obtain explicit user approval
    /// (`reason: "sandbox_denied"`) before running unsandboxed, or fail closed with `SANDBOX_REQUIRED`.
    RequireUnsandboxedApproval {
        reason: &'static str,
        warning: Option<String>,
        fallback_command: TransformedCommand,
    },
    /// Fail closed immediately with `SANDBOX_REQUIRED` (hard floors or `sandbox.requireBackend = true`).
    Deny {
        error_code: SandboxErrorCode,
        stderr: String,
        warning: Option<String>,
    },
}

/// Coordinates OS backend capability detection, cached `.git`/`.cowork` subpath exclusions,
/// command wrapping, and `SANDBOX_REQUIRED` fail-closed gate evaluation.
#[derive(Clone)]
pub struct SandboxManager {
    cache: Arc<WorkspaceProtectedPathsCache>,
}

impl Default for SandboxManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxManager {
    /// Creates a `SandboxManager` sharing the process-wide `WorkspaceProtectedPathsCache`.
    pub fn new() -> Self {
        Self {
            cache: Arc::clone(global_protected_paths_cache()),
        }
    }

    /// Creates a `SandboxManager` backed by a caller-supplied `WorkspaceProtectedPathsCache`.
    pub fn with_cache(cache: Arc<WorkspaceProtectedPathsCache>) -> Self {
        Self { cache }
    }

    /// Returns a reference to the underlying `WorkspaceProtectedPathsCache`.
    pub fn protected_paths_cache(&self) -> &Arc<WorkspaceProtectedPathsCache> {
        &self.cache
    }

    /// Detects OS sandbox capabilities on `platform_override` (defaulting to `host_platform()`).
    pub fn detect_capabilities(
        &self,
        platform_override: Option<&str>,
        env_override: Option<&HashMap<String, String>>,
    ) -> SandboxCapabilities {
        let platform = platform_override.unwrap_or(host_platform());
        let owned_env;
        let env = match env_override {
            Some(e) => e,
            None => {
                owned_env = sanitized_process_env();
                &owned_env
            }
        };

        match platform {
            "darwin" => {
                if has_seatbelt() {
                    SandboxCapabilities {
                        backend: SandboxType::Seatbelt,
                        bwrap_path: None,
                        windows_helper_path: None,
                        enforcement: SandboxEnforcement::FULL,
                        warning: None,
                        setup_required: false,
                    }
                } else {
                    SandboxCapabilities::none(
                        "macOS sandbox-exec not found at /usr/bin/sandbox-exec — commands run unsandboxed.",
                    )
                }
            }
            "linux" => {
                let Some(bwrap_path) = find_bwrap(env) else {
                    return SandboxCapabilities::none(
                        "bubblewrap (bwrap) not installed — commands run unsandboxed. Install bubblewrap (e.g. apt install bubblewrap) to enable sandboxing.",
                    );
                };
                if !is_bwrap_usable(&bwrap_path) {
                    return SandboxCapabilities::none(
                        "bubblewrap (bwrap) is installed but unusable here (unprivileged user namespaces are likely disabled by kernel.apparmor_restrict_unprivileged_userns or similar) — commands run unsandboxed.",
                    );
                }
                SandboxCapabilities {
                    backend: SandboxType::Bwrap,
                    bwrap_path: Some(bwrap_path),
                    windows_helper_path: None,
                    enforcement: SandboxEnforcement::FULL,
                    warning: None,
                    setup_required: false,
                }
            }
            "win32" => {
                let Some(helper_path) = find_windows_helper(env, &[]) else {
                    return SandboxCapabilities::none(
                        "Windows sandbox helper bundle not found — commands run unsandboxed.",
                    );
                };
                let probe =
                    probe_windows_sandbox_bundle(&helper_path, env, WindowsProbeOptions::default());
                if !probe.integrity {
                    return SandboxCapabilities {
                        backend: SandboxType::None,
                        bwrap_path: None,
                        windows_helper_path: None,
                        enforcement: SandboxEnforcement::NONE,
                        warning: probe.warning.or_else(|| {
                            Some(
                                "Windows sandbox helper integrity verification failed — commands require unsandboxed approval."
                                    .to_owned(),
                            )
                        }),
                        setup_required: false,
                    };
                }
                SandboxCapabilities {
                    backend: SandboxType::Windows,
                    bwrap_path: None,
                    windows_helper_path: Some(helper_path),
                    enforcement: SandboxEnforcement {
                        filesystem: probe.filesystem,
                        network: probe.network,
                        process: probe.process,
                        integrity: probe.integrity,
                    },
                    warning: probe.warning,
                    setup_required: probe.setup_required,
                }
            }
            other => SandboxCapabilities::none(format!(
                "No OS sandbox backend for platform \"{other}\" — commands run unsandboxed."
            )),
        }
    }

    /// Wraps `inner` with the active OS sandbox backend for `policy`.
    ///
    /// Never invokes an unverified or missing helper binary; when `capabilities.backend == None`
    /// or `!capabilities.enforcement.integrity`, returns `sandbox: SandboxType::None` (`unsandboxed: true`).
    pub fn transform(
        &self,
        inner: &SandboxCommand,
        policy: &SandboxPolicy,
        cwd: &Path,
    ) -> (TransformedCommand, SandboxEnforcement, Option<String>) {
        self.transform_with_options(inner, policy, cwd, TransformOptions::default())
    }

    pub fn transform_with_options(
        &self,
        inner: &SandboxCommand,
        policy: &SandboxPolicy,
        cwd: &Path,
        opts: TransformOptions<'_>,
    ) -> (TransformedCommand, SandboxEnforcement, Option<String>) {
        if matches!(policy, SandboxPolicy::DangerFullAccess { .. }) && policy_allows_network(policy)
        {
            return (
                TransformedCommand {
                    file: inner.file.clone(),
                    args: inner.args.clone(),
                    env: HashMap::new(),
                    sandbox: SandboxType::None,
                    unsandboxed: true,
                },
                SandboxEnforcement::NONE,
                None,
            );
        }

        let owned_caps;
        let caps = match opts.capabilities {
            Some(c) => c,
            None => {
                owned_caps = self.detect_capabilities(opts.platform, opts.env_source);
                &owned_caps
            }
        };

        if caps.backend == SandboxType::None || !caps.enforcement.integrity || caps.setup_required {
            return (
                TransformedCommand {
                    file: inner.file.clone(),
                    args: inner.args.clone(),
                    env: HashMap::new(),
                    sandbox: SandboxType::None,
                    unsandboxed: true,
                },
                SandboxEnforcement::NONE,
                caps.warning.clone(),
            );
        }

        match caps.backend {
            SandboxType::Seatbelt => {
                let cmd = build_seatbelt_command_with_cache(inner, policy, Some(&self.cache));
                (cmd, caps.enforcement, caps.warning.clone())
            }
            SandboxType::Bwrap => {
                let bwrap_path = caps
                    .bwrap_path
                    .as_deref()
                    .unwrap_or_else(|| Path::new("/usr/bin/bwrap"));
                let cmd = build_bwrap_command(
                    bwrap_path,
                    inner,
                    policy,
                    cwd,
                    BwrapBuildOptions {
                        sandbox_exec_path: opts.sandbox_exec_path,
                        exists: None,
                        is_directory: None,
                        cache: Some(&self.cache),
                    },
                );
                (cmd, caps.enforcement, caps.warning.clone())
            }
            SandboxType::Windows => {
                let owned_env;
                let env_src = match opts.env_source {
                    Some(e) => e,
                    None => {
                        owned_env = sanitized_process_env();
                        &owned_env
                    }
                };
                let helper_path = caps
                    .windows_helper_path
                    .as_deref()
                    .unwrap_or_else(|| Path::new("cowork-win-sandbox.exe"));
                let cmd = build_windows_sandbox_command(helper_path, inner, policy, cwd, env_src);
                (cmd, caps.enforcement, caps.warning.clone())
            }
            SandboxType::None => unreachable!(),
        }
    }

    /// Evaluates hard-floor, `sandbox.requireBackend`, `--yolo`, and unsandboxed-approval gates.
    #[allow(clippy::too_many_arguments)]
    pub fn evaluate_gate(
        &self,
        inner: &SandboxCommand,
        policy: &SandboxPolicy,
        cwd: &Path,
        yolo: bool,
        require_backend: bool,
        has_scoped_target_paths: bool,
        opts: TransformOptions<'_>,
    ) -> SandboxGateDecision {
        let hard_floor = requires_hard_floor_enforcement(policy, yolo, has_scoped_target_paths);

        // `--yolo` lifts sandboxing ONLY when no hard floor (`read-only`, `no-project-write`,
        // `targetPaths`, or `network: false`) applies.
        if yolo && !hard_floor {
            return SandboxGateDecision::RunUnsandboxed { warning: None };
        }

        let (transformed, enforcement, warning) =
            self.transform_with_options(inner, policy, cwd, opts);

        let requires_sandbox_enforcement =
            !matches!(policy, SandboxPolicy::DangerFullAccess { .. })
                || !policy_allows_network(policy);
        let backend_does_not_enforce_policy = transformed.sandbox == SandboxType::None
            || !enforcement.integrity
            || !enforcement.process
            || (!matches!(policy, SandboxPolicy::DangerFullAccess { .. })
                && !enforcement.filesystem)
            || (!policy_allows_network(policy) && !enforcement.network);

        if requires_sandbox_enforcement && hard_floor && backend_does_not_enforce_policy {
            let reason = warning.as_deref().unwrap_or("no backend");
            return SandboxGateDecision::Deny {
                error_code: SandboxErrorCode::SandboxRequired,
                stderr: format!(
                    "Refusing to run: this context requires an enforcing OS sandbox, which is unavailable ({reason})."
                ),
                warning,
            };
        }

        if requires_sandbox_enforcement && require_backend && backend_does_not_enforce_policy {
            let reason = warning
                .as_deref()
                .unwrap_or("OS sandbox backend unavailable");
            let stderr = if transformed.sandbox != SandboxType::None {
                format!(
                    "Refusing to run: {reason} (sandbox.requireBackend is enabled and requires filesystem/network enforcement)."
                )
            } else {
                format!(
                    "Refusing to run unsandboxed: {reason} (sandbox.requireBackend is enabled)."
                )
            };
            return SandboxGateDecision::Deny {
                error_code: SandboxErrorCode::SandboxRequired,
                stderr,
                warning,
            };
        }

        if requires_sandbox_enforcement && backend_does_not_enforce_policy {
            return SandboxGateDecision::RequireUnsandboxedApproval {
                reason: "sandbox_denied",
                warning,
                fallback_command: transformed,
            };
        }

        if transformed.sandbox == SandboxType::None {
            SandboxGateDecision::RunUnsandboxed { warning }
        } else {
            SandboxGateDecision::RunSandboxed(transformed)
        }
    }
}
