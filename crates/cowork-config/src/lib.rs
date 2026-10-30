//! `cowork-config` — Foundation Layer.
//!
//! Module boundaries owned by this crate:
//! - **Canonical home & workspace roots**: Resolves `~/.cowork` (honoring `COWORK_HOME_OVERRIDE`)
//!   and `<workspace>/.cowork/`, plus idempotent legacy `<workspace>/.agent` migration.
//! - **3-tier configuration merge**: Merges built-in `config/defaults.json` < user
//!   `~/.cowork/config/config.json` < workspace `<workspace>/.cowork/config.json` < environment
//!   overrides with explicit clear/inherit sentinel semantics.
//! - **Workspace security trust clamps**: Prevents untrusted workspace configs from injecting
//!   telemetry credentials or widening sandbox floors (`--yolo`, `danger-full-access`).
//! - **Feature flags**: Evaluates all 8 flags (`menuBar`, `remoteAccess`, `workspacePicker`,
//!   `workspaceLifecycle`, `openAiNativeConnectors`, `canvas`, `tasks`, `workflows`), enforcing
//!   packaged `forced-off` availability clamps.
//! - **Auth & model stores**: Atomic `0600` persistence for `connections.json`, custom models,
//!   model preferences, and the 24-hour provider model discovery cache.

use serde::{Deserialize, Serialize};

/// Environment variable overriding the canonical `~/.cowork` home directory.
pub const COWORK_HOME_OVERRIDE_ENV: &str = "COWORK_HOME_OVERRIDE";

/// Configuration precedence tiers from lowest to highest priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigTier {
    Defaults,
    User,
    Workspace,
    Environment,
}

/// Canonical feature flag identifiers matching `src/shared/featureFlags.ts`.
pub const FEATURE_FLAG_NAMES: [&str; 8] = [
    "menuBar",
    "remoteAccess",
    "workspacePicker",
    "workspaceLifecycle",
    "openAiNativeConnectors",
    "canvas",
    "tasks",
    "workflows",
];

/// Re-exported protocol version verified across foundation crates.
pub fn supported_protocol_version() -> &'static str {
    cowork_protocol::WEBSOCKET_PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_tier_precedence_and_feature_flags_are_ordered() {
        assert!(ConfigTier::Defaults < ConfigTier::User);
        assert!(ConfigTier::User < ConfigTier::Workspace);
        assert!(ConfigTier::Workspace < ConfigTier::Environment);
        assert_eq!(FEATURE_FLAG_NAMES.len(), 8);
        assert!(FEATURE_FLAG_NAMES.contains(&"remoteAccess"));
        assert_eq!(supported_protocol_version(), "7.48");
    }
}
