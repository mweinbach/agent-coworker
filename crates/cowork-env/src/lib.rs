//! `cowork-env` — Persistence & Execution Primitives Layer.
//!
//! Module boundaries owned by this crate:
//! - **Clean non-login shell environment** (`shell`): Spawns `bash -c` / `pwsh -NoProfile` with an
//!   explicit canonical environment map (`COWORK_DESKTOP_PARENT_MANAGED` and host credentials
//!   stripped from child processes) and zero `export PATH=... &&` command string mutation.
//! - **Dual-format runtime pack manager** (`manifest`, `archive`, `integrity`, `installer`):
//!   Verifies signed v1 `.zip` archives and v2 modular `.tar.zst` packs (`core`, `python-wheels`,
//!   `libreoffice`) via `ed25519-dalek` + parallel `rayon` (`blake3` + `sha256`), seals installed
//!   directories read-only, and coordinates cross-process bootstrap via `fs4`.
//! - **`uv` ephemeral Python environments** (`uv`): Configures `<cowork_home>/cache/uv` and
//!   provisions copy-on-write/ephemeral `.venv` environments without mutating sealed runtime files.
//! - **Isolated `SofficeRunner` pool** (`soffice`): Bounded-concurrency headless LibreOffice +
//!   `pdftoppm` conversions wrapped in `cowork-sandbox` with disposable temporary user profiles.

pub mod archive;
pub mod error;
pub mod installer;
pub mod integrity;
pub mod manifest;
pub mod shell;
pub mod soffice;
pub mod uv;

/// Parent-managed sidecar lifecycle variable that MUST be stripped from child tool processes.
pub const PARENT_MANAGED_ENV_VAR: &str = "COWORK_DESKTOP_PARENT_MANAGED";

/// Modular v2 `.tar.zst` runtime pack identifiers.
pub const RUNTIME_V2_PACK_IDS: [&str; 3] = ["core", "python-wheels", "libreoffice"];

pub use archive::{
    ArchiveFormat, MAX_ARCHIVE_ENTRY_COUNT, MAX_ARCHIVE_UNPACKED_BYTES,
    assert_safe_relative_runtime_path, assert_safe_symlink_target, detect_archive_format,
    extract_v1_zip_archive, extract_v2_tar_zst_archive, validate_symlink_graph,
};
pub use error::{EnvError, Result};
pub use installer::{
    DEFAULT_BOOTSTRAP_LOCK_TIMEOUT, EnsureRuntimeOptions, RuntimeConsumerLease,
    RuntimeInstallOptions, bootstrap_lock_path, build_signed_v1_zip_fixture,
    build_signed_v2_pack_tar_zst_fixture, consumer_lease_lock_path, ensure_cowork_runtime_ready,
    has_active_consumer_lease, install_v1_zip_runtime, install_v2_pack_set,
    prune_installed_runtimes, read_current_pointer, runtime_root_dir, with_runtime_bootstrap_lock,
    with_runtime_bootstrap_lock_sync,
};
pub use integrity::{
    attestation_sidecar_path, compute_tree_state_digest_parallel, hash_bytes_dual,
    hash_regular_file, remove_sealed_tree, seal_tree_readonly, unseal_tree_for_removal,
    verify_ed25519_envelope, verify_installed_runtime, verify_integrity_tree_parallel,
};
pub use manifest::{
    InstalledRuntimePointer, IntegrityEntryKind, IntegrityFileEntry, OFFICIAL_RUNTIME_KEY_ID,
    OFFICIAL_RUNTIME_PUBLIC_KEY_PEM, PreparedRuntime, RuntimeBootstrapPhase,
    RuntimeBootstrapProgress, RuntimeIntegrityManifest, RuntimeManifest, RuntimeManifestPaths,
    RuntimePackId, RuntimePackManifest, RuntimePaths, RuntimeProgressCallback,
    RuntimeSignatureEnvelope, SUPPORTED_RUNTIME_ASSETS, StartupProgressEvent, TrustedKeyRing,
    format_ndjson_progress_event, parse_ed25519_verifying_key, resolve_asset_for_platform,
    resolve_host_asset,
};
pub use shell::{
    ShellCandidate, ShellEnvOptions, ShellExecutionOptions, ShellExecutionOutput,
    ShellExecutionPlan, build_canonical_shell_env, build_non_login_shell_plan,
    execute_non_login_shell, redact_env_for_diagnostics, redact_secrets,
};
pub use soffice::{
    LibreOfficeCapabilityDiagnostic, LibreOfficeCheckStatus, LibreOfficeSmokeResult,
    PdftoppmJobRequest, SofficeConvertRequest, SofficeConvertResult, SofficeRunner,
    SofficeRunnerConfig, validate_pdftoppm_args, validate_soffice_args,
};
pub use uv::{EphemeralPythonEnv, UvEnvironmentPaths, UvManagerConfig, UvPythonManager};

/// Returns the default child sandbox mode used for isolated LibreOffice conversions.
pub const fn default_soffice_sandbox_mode() -> cowork_sandbox::SandboxMode {
    cowork_sandbox::SandboxMode::NoProjectWrite
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_env_invariants_are_defined() {
        assert_eq!(PARENT_MANAGED_ENV_VAR, "COWORK_DESKTOP_PARENT_MANAGED");
        assert_eq!(
            RUNTIME_V2_PACK_IDS,
            ["core", "python-wheels", "libreoffice"]
        );
        assert_eq!(
            default_soffice_sandbox_mode(),
            cowork_sandbox::SandboxMode::NoProjectWrite
        );
    }
}
