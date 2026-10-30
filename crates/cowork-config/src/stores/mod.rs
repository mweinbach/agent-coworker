pub mod connections;
pub mod custom_models;
pub mod discovery_cache;
pub mod model_preferences;

pub use connections::{
    ConnectionMode, ConnectionStore, StoredConnection, TOOL_API_KEY_NAMES, ToolApiKeyName,
    ToolApiKeys, get_saved_provider_api_key, parse_connection_store_json, read_connection_store,
    read_connection_store_sync, remove_provider_connection, save_provider_connection,
    write_connection_store,
};
pub use custom_models::{
    CustomModelEntry, CustomModelStore, delete_custom_model, normalize_custom_model_id,
    read_custom_model_store, read_custom_model_store_sync, upsert_custom_model,
};
pub use discovery_cache::{
    CachedModelDiscoveryModel, CachedModelReasoning, DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS,
    ModelDiscoveryCacheFile, ModelDiscoveryResult, ModelDiscoverySource,
    is_model_discovery_cache_fresh, model_discovery_cache_path, read_model_discovery_cache,
    read_model_discovery_cache_sync, write_model_discovery_cache,
};
pub use model_preferences::{
    ModelPreferenceEntry, ModelPreferenceUpdate, ModelPreferencesStore,
    read_model_preferences_store, read_model_preferences_store_sync, reset_model_preferences,
    set_model_preferences, write_model_preferences_store,
};
