//! `cowork-env` — Persistence & Execution Primitives Layer.
//!
//! Module boundaries owned by this crate:
//! - **Clean non-login shell environment**: Spawns `bash -c` / `pwsh -NoProfile` with an explicit
//!   redacted environment map (`COWORK_DESKTOP_PARENT_MANAGED` stripped from child processes) and
//!   zero `export PATH=... &&` command string mutation.
//! - **Dual-format runtime pack manager**: Verifies signed v1 `.zip` archives and v2 modular
//!   `.tar.zst` packs (`core`, `python-wheels`, `libreoffice`) via `ed25519-dalek` + `rayon`,
//!   seals installed directories read-only, and coordinates bootstrap via `fs4`.
//! - **`uv` ephemeral Python environments**: Provisions copy-on-write `.venv` environments backed
//!   by `~/.cowork/cache/uv` without mutating sealed runtime files.
//! - **Isolated `SofficeRunner` pool**: Bounded-concurrency headless LibreOffice + `pdftoppm`
//!   conversions wrapped in `cowork-sandbox` with disposable temporary user profiles.

/// Parent-managed sidecar lifecycle variable that MUST be stripped from child tool processes.
pub const PARENT_MANAGED_ENV_VAR: &str = "COWORK_DESKTOP_PARENT_MANAGED";

/// Modular v2 `.tar.zst` runtime pack identifiers.
pub const RUNTIME_V2_PACK_IDS: [&str; 3] = ["core", "python-wheels", "libreoffice"];

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
