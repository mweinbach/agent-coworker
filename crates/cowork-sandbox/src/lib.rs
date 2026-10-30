//! `cowork-sandbox` — Persistence & Execution Primitives Layer.
//!
//! Module boundaries owned by this crate:
//! - **Policy resolver & hard floors**: Evaluates `ReadOnly`, `NoProjectWrite`, `WorkspaceWrite`,
//!   and `DangerFullAccess` policies while preserving hard floors (`read-only`, read-only roles,
//!   child `targetPaths`, and `network: false`) even when `--yolo` is active.
//! - **Cached protected-subpath discovery**: Uses `ignore` + `notify` to maintain `.git` and
//!   `.cowork` write-carveout sets without per-command workspace walks.
//! - **Self-exec `__sandbox-exec` backends**: macOS Apple-signed Seatbelt (`sandbox-exec`), Linux
//!   `bwrap` + native Rust `pre_exec` seccomp-BPF filter, and Windows restricted-token integration
//!   with `WinVerifyTrust`.
//! - **Denial classification**: Categorizes filesystem, protected-metadata, network, and backend
//!   availability denials for interactive escalation.

use serde::{Deserialize, Serialize};

/// Protected workspace metadata directory/file names carved out from `WorkspaceWrite` roots.
pub const PROTECTED_METADATA_NAMES: [&str; 2] = [".git", ".cowork"];

/// Canonical sandbox policy modes matching `src/platform/sandbox/policy.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    NoProjectWrite,
    WorkspaceWrite,
    DangerFullAccess,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_modes_serialize_as_kebab_case_and_protect_metadata() {
        assert_eq!(PROTECTED_METADATA_NAMES, [".git", ".cowork"]);
        assert_eq!(
            serde_json::to_string(&SandboxMode::NoProjectWrite).unwrap(),
            "\"no-project-write\""
        );
        assert_eq!(
            serde_json::to_string(&SandboxMode::WorkspaceWrite).unwrap(),
            "\"workspace-write\""
        );
    }
}
