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
//!   model preferences, and the 24-hour provider model discovery cache, coordinated with
//!   cross-process SQLite `with_file_lock` (`locks/files/<sha256>.sqlite`).

pub mod error;
pub mod feature_flags;
pub mod file_lock;
pub mod merge;
pub mod migration;
pub mod models;
pub mod patch_store;
pub mod paths;
pub mod providers;
pub mod stores;

use serde::{Deserialize, Serialize};

pub use error::{ConfigError, Result};
pub use feature_flags::{
    ALL_FEATURE_FLAG_IDS, FeatureFlagDefinition, FeatureFlagId, FeatureFlagOverrides, FeatureFlags,
    PackagedAvailability, ResolveFeatureFlagsOptions, feature_flag_definition,
    is_openai_native_connectors_experiment_enabled, parse_env_flag_boolean, resolve_feature_flags,
};
pub use file_lock::{
    FILE_LOCK_ACQUIRE_TIMEOUT_MS, FileLockOptions, file_lock_root_for_cowork_home,
    lock_database_path_for, with_file_lock, with_file_lock_sync,
};
pub use merge::{
    AgentConfig, CommandTemplateConfig, DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS,
    DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS, ExperimentalFeatures, HarnessConfig, LoadConfigOptions,
    ModelSettings, ObservabilityConfig, ProjectConfigOverrides, ToolCallingConfig, UserProfile,
    is_network_telemetry_globally_disabled, load_config,
};
pub use migration::{
    AgentConfigMigrationResult, AgentConfigMigrationScopeResult, MigrateAgentConfigOptions,
    format_agent_config_migration_report, migrate_agent_config,
};
pub use models::{
    ModelRegistry, NormalizedChildRouting, SupportedModel, fallback_default_model_id,
    legacy_model_alias, normalize_child_routing_config, parse_child_model_ref,
    reconcile_reasoning_provider_options,
};
pub use patch_store::{
    ProjectConfigPatch, UserProfilePatch, merge_config_patch, persist_project_config_patch,
};
pub use paths::{
    AiCoworkerPaths, CaseSensitivity, PROTECTED_METADATA_DIR_NAMES, assert_within_roots,
    canonical_key, canonicalize_sync, cowork_home, crosses_protected_metadata,
    ensure_ai_coworker_home, ensure_private_dir_sync, env_map_from_process, fs_case_sensitivity,
    get_ai_coworker_paths, get_one_off_chats_root, harden_private_file_sync, host_platform,
    is_inside, is_inside_with_options, is_path_inside_one_off_chats_root, normalize_lexical_path,
    resolve_home_dir, same_path, same_workspace_path, write_text_file_atomic,
};
pub use providers::{
    ChildModelRoutingMode, ProviderName, RuntimeName, SandboxConfig, SandboxMode,
    SkillImprovementScope, default_runtime_name_for_provider, normalize_runtime_name_for_provider,
    resolve_provider_name,
};
pub use stores::{
    CachedModelDiscoveryModel, CachedModelReasoning, ConnectionMode, ConnectionStore,
    CustomModelEntry, CustomModelStore, DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS,
    ModelDiscoveryCacheFile, ModelDiscoveryResult, ModelDiscoverySource, ModelPreferenceEntry,
    ModelPreferenceUpdate, ModelPreferencesStore, StoredConnection, TOOL_API_KEY_NAMES,
    ToolApiKeyName, ToolApiKeys, delete_custom_model, get_saved_provider_api_key,
    is_model_discovery_cache_fresh, model_discovery_cache_path, normalize_custom_model_id,
    parse_connection_store_json, read_connection_store, read_connection_store_sync,
    read_custom_model_store, read_custom_model_store_sync, read_model_discovery_cache,
    read_model_discovery_cache_sync, read_model_preferences_store,
    read_model_preferences_store_sync, remove_provider_connection, reset_model_preferences,
    save_provider_connection, set_model_preferences, upsert_custom_model, write_connection_store,
    write_model_discovery_cache, write_model_preferences_store,
};

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
