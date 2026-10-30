use serde::{Deserialize, Serialize};

use crate::SandboxType;
use crate::env_utils::host_platform;
use crate::policy::{SandboxPolicy, policy_allows_network};

/// Wire-compatible OS sandbox denial category (`"filesystem"` | `"network"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxDenialCategory {
    Filesystem,
    Network,
}

impl SandboxDenialCategory {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Filesystem => "filesystem",
            Self::Network => "network",
        }
    }
}

/// Fine-grained structured denial classification for diagnostics and telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxDenialDetailKind {
    FilesystemWrite,
    ProtectedMetadata,
    Network,
    BackendUnavailable,
}

/// Complete structured classification of an OS sandbox denial.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDenialClassification {
    pub category: SandboxDenialCategory,
    pub detail_kind: SandboxDenialDetailKind,
    pub description: String,
}

/// Options for `classify_sandbox_denial`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClassifyDenialOptions<'a> {
    /// True when the active sandbox policy restricts network access (`!policy_allows_network`).
    pub network_restricted: bool,
    /// Optional platform override (`"darwin"`, `"linux"`, `"win32"`).
    pub platform: Option<&'a str>,
}

const NON_SANDBOX_EXIT_CODES: [i32; 5] = [
    0,   // success
    124, // step timeout (`TIMEOUT`)
    126, // target not executable
    127, // command not found
    130, // SIGINT / user abort (`ABORT_ERR`)
];

const FILESYSTEM_DENIAL_MARKERS_BASE: [&str; 6] = [
    "operation not permitted",
    "permission denied",
    "access is denied",
    "read-only file system",
    "seccomp",
    "landlock",
];

/// Explicit socket/connect EPERM markers emitted by macOS Seatbelt when `network: false` blocks
/// `system-socket` / `network-outbound` on direct IP connections without touching DNS.
const EXPLICIT_SOCKET_EPERM_MARKERS: [&str; 4] = [
    "socket: operation not permitted",
    "connect: operation not permitted",
    "sendto: operation not permitted",
    "network-outbound",
];

const NETWORK_DENIAL_MARKERS_BASE: [&str; 9] = [
    "network is unreachable",
    "network is down",
    "could not resolve host",
    "temporary failure in name resolution",
    "name or service not known",
    "nodename nor servname provided, or not known",
    "no address associated with hostname",
    "couldn't connect to server",
    "failed to connect to ",
];

const NETWORK_DENIAL_MARKERS_WIN32_ONLY: [&str; 5] = [
    "no such host is known",
    "the remote name could not be resolved",
    "wsahost_not_found",
    "wsaeconnrefused",
    "no connection could be made because the target machine actively refused",
];

const NON_SANDBOX_FAILURE_MARKERS: [&str; 9] = [
    "permission denied (publickey)",
    "permission denied, please try again",
    "authentication failed",
    "fatal: could not read from remote repository",
    "publickey,password",
    "403 forbidden",
    "permission denied while trying to connect to the docker daemon",
    "sudo: a terminal is required",
    "sudo: a password is required",
];

/// Classifies a non-zero sandboxed command result into `Filesystem` or `Network`, or `None`
/// when the failure does not match an OS sandbox denial.
///
/// Never matches bare `"sandbox"` substrings and ignores SSH/Git/HTTP/Docker/sudo auth failures.
pub fn classify_sandbox_denial(
    output: &str,
    exit_code: i32,
    opts: ClassifyDenialOptions<'_>,
) -> Option<SandboxDenialCategory> {
    classify_sandbox_denial_detailed(output, exit_code, opts).map(|c| c.category)
}

/// Detailed variant of `classify_sandbox_denial` returning `SandboxDenialClassification`.
pub fn classify_sandbox_denial_detailed(
    output: &str,
    exit_code: i32,
    opts: ClassifyDenialOptions<'_>,
) -> Option<SandboxDenialClassification> {
    if NON_SANDBOX_EXIT_CODES.contains(&exit_code) {
        return None;
    }
    let platform = opts.platform.unwrap_or(host_platform());
    let lower = output.to_ascii_lowercase();
    if NON_SANDBOX_FAILURE_MARKERS
        .iter()
        .any(|m| lower.contains(m))
    {
        return None;
    }

    // Check whether non-socket filesystem markers are present, stripping explicit socket-only
    // EPERM phrases when `network_restricted == true` so mixed outputs (`touch: ... Operation not
    // permitted\ncurl: Could not resolve host`) still prioritize `Filesystem`, while pure socket
    // EPERM (`socket: Operation not permitted`) under `network: false` classifies as `Network`.
    let fs_probe_text = if opts.network_restricted {
        let mut scrubbed = lower
            .lines()
            .filter(|line| {
                !((line.contains("connectx to ") || line.contains("connect to "))
                    && line.contains("operation not permitted"))
            })
            .collect::<Vec<_>>()
            .join("\n");
        for marker in EXPLICIT_SOCKET_EPERM_MARKERS {
            scrubbed = scrubbed.replace(marker, "");
        }
        scrubbed
    } else {
        lower.clone()
    };

    let has_fs_marker = FILESYSTEM_DENIAL_MARKERS_BASE
        .iter()
        .any(|m| fs_probe_text.contains(m))
        || (platform == "win32"
            && fs_probe_text.contains("access to the path")
            && fs_probe_text.contains("is denied"));

    if has_fs_marker {
        let detail_kind = if lower.contains("/.git")
            || lower.contains("\\.git")
            || lower.contains(".git/")
            || lower.contains(".git\\")
            || lower.contains("/.cowork")
            || lower.contains("\\.cowork")
            || lower.contains(".cowork/")
            || lower.contains(".cowork\\")
        {
            SandboxDenialDetailKind::ProtectedMetadata
        } else {
            SandboxDenialDetailKind::FilesystemWrite
        };
        let category = SandboxDenialCategory::Filesystem;
        return Some(SandboxDenialClassification {
            category,
            detail_kind,
            description: describe_sandbox_denial(category).to_owned(),
        });
    }

    if opts.network_restricted {
        let has_connect_eperm_line = lower.lines().any(|line| {
            (line.contains("connectx to ") || line.contains("connect to "))
                && line.contains("operation not permitted")
        });
        let has_net_marker = has_connect_eperm_line
            || EXPLICIT_SOCKET_EPERM_MARKERS
                .iter()
                .any(|m| lower.contains(m))
            || NETWORK_DENIAL_MARKERS_BASE
                .iter()
                .any(|m| lower.contains(m))
            || (platform == "win32"
                && NETWORK_DENIAL_MARKERS_WIN32_ONLY
                    .iter()
                    .any(|m| lower.contains(m)));
        if has_net_marker {
            let category = SandboxDenialCategory::Network;
            return Some(SandboxDenialClassification {
                category,
                detail_kind: SandboxDenialDetailKind::Network,
                description: describe_sandbox_denial(category).to_owned(),
            });
        }
    }

    None
}

/// Boolean helper returning whether `output` + `exit_code` indicates a likely OS sandbox denial.
pub fn is_likely_sandbox_denied(
    output: &str,
    exit_code: i32,
    opts: ClassifyDenialOptions<'_>,
) -> bool {
    classify_sandbox_denial(output, exit_code, opts).is_some()
}

/// Safe user-facing summary of a classified sandbox denial (never echoing untrusted stderr).
pub const fn describe_sandbox_denial(category: SandboxDenialCategory) -> &'static str {
    match category {
        SandboxDenialCategory::Network => "The OS sandbox blocked network access for this command.",
        SandboxDenialCategory::Filesystem => {
            "The OS sandbox blocked a write outside the workspace for this command."
        }
    }
}

/// Structured user-approval escalation plan produced after a sandboxed `workspace-write` failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxEscalationPlan {
    pub reason: String,
    pub reason_code: String,
    pub category: SandboxDenialCategory,
    pub detail_kind: SandboxDenialDetailKind,
    pub detail: String,
    pub retry_policy: SandboxPolicy,
}

/// Determines whether a command failure qualifies for interactive sandbox approval escalation and
/// computes the minimum widened `retry_policy`.
///
/// Escalation is NEVER offered when:
/// - The command ran unsandboxed (`sandbox == SandboxType::None` or `unsandboxed == true`)
/// - The active policy is `ReadOnly`, `NoProjectWrite`, or `DangerFullAccess`
/// - The session is a scoped child (`has_scoped_target_paths == true`)
#[allow(clippy::too_many_arguments)]
pub fn plan_sandbox_escalation(
    policy: &SandboxPolicy,
    sandbox_used: SandboxType,
    unsandboxed: bool,
    has_scoped_target_paths: bool,
    stdout: &str,
    stderr: &str,
    exit_code: i32,
    platform_override: Option<&str>,
) -> Option<SandboxEscalationPlan> {
    if unsandboxed || sandbox_used == SandboxType::None || has_scoped_target_paths {
        return None;
    }

    let SandboxPolicy::WorkspaceWrite { network, .. } = policy else {
        return None;
    };

    let combined = if stdout.is_empty() {
        stderr.to_owned()
    } else if stderr.is_empty() {
        stdout.to_owned()
    } else {
        format!("{stderr}\n{stdout}")
    };

    let classification = classify_sandbox_denial_detailed(
        &combined,
        exit_code,
        ClassifyDenialOptions {
            network_restricted: !policy_allows_network(policy),
            platform: platform_override,
        },
    )?;

    let retry_policy = match classification.category {
        SandboxDenialCategory::Network => {
            let mut widened = policy.clone();
            if let SandboxPolicy::WorkspaceWrite { network: net, .. } = &mut widened {
                *net = true;
            }
            widened
        }
        SandboxDenialCategory::Filesystem => SandboxPolicy::DangerFullAccess {
            network: Some(*network),
        },
    };

    Some(SandboxEscalationPlan {
        reason: "sandbox_denied".to_owned(),
        reason_code: "sandbox_denied_escalation".to_owned(),
        category: classification.category,
        detail_kind: classification.detail_kind,
        detail: classification.description,
        retry_policy,
    })
}
