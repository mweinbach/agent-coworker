use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{ConfigError, Result};
use crate::feature_flags::{
    FeatureFlags, ResolveFeatureFlagsOptions, is_openai_native_connectors_experiment_enabled,
    resolve_feature_flags,
};
use crate::models::{
    ModelRegistry, normalize_child_routing_config, reconcile_reasoning_provider_options,
};
use crate::paths::{
    canonicalize_sync, env_map_from_process, get_ai_coworker_paths, get_one_off_chats_root,
    host_platform, is_inside, is_path_inside_one_off_chats_root, resolve_home_dir,
};
use crate::providers::{
    ChildModelRoutingMode, ProviderName, RuntimeName, SandboxConfig, SandboxMode,
    SkillImprovementScope, normalize_runtime_name_for_provider, resolve_provider_name,
};

pub const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS: u64 = 25_000;
pub const DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS: usize = 4;
const BUILTIN_DEFAULTS_JSON: &str = include_str!("../../../config/defaults.json");

#[derive(Debug, Clone, Default)]
pub struct LoadConfigOptions {
    pub cwd: Option<PathBuf>,
    pub homedir: Option<PathBuf>,
    pub built_in_dir: Option<PathBuf>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallingConfig {
    pub code_mode: bool,
    pub deferred_tool_search: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub instructions: String,
    pub work: String,
    pub details: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityConfig {
    pub provider: String,
    pub base_url: String,
    pub otel_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracing_environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    pub record_inputs: bool,
    pub record_outputs: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfig {
    pub report_only: bool,
    pub strict_mode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTemplateConfig {
    pub template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalFeatures {
    pub open_ai_native_connectors: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigOverrides {
    pub tool_output_overflow_chars: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub provider: ProviderName,
    pub runtime: RuntimeName,
    pub sandbox: SandboxConfig,
    pub tool_calling: ToolCallingConfig,
    pub model: String,
    pub preferred_child_model: String,
    pub child_model_routing_mode: ChildModelRoutingMode,
    pub preferred_child_model_ref: String,
    pub allowed_child_model_refs: Vec<String>,
    pub tool_output_overflow_chars: Option<u64>,
    pub workflow_max_concurrent_agents: usize,
    pub inherited_tool_output_overflow_chars: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_config_overrides: Option<ProjectConfigOverrides>,
    pub working_directory: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_directory: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploads_directory: Option<PathBuf>,
    pub user_name: String,
    pub user_profile: UserProfile,
    pub knowledge_cutoff: String,
    pub project_cowork_dir: PathBuf,
    pub project_memory_dir: PathBuf,
    pub project_memory_db_path: PathBuf,
    pub memories_dir: PathBuf,
    pub user_cowork_dir: PathBuf,
    pub workspace_agents_dir: PathBuf,
    pub user_agents_dir: PathBuf,
    pub workspace_plugins_dir: PathBuf,
    pub user_plugins_dir: PathBuf,
    pub built_in_dir: PathBuf,
    pub built_in_config_dir: PathBuf,
    pub skills_dirs: Vec<PathBuf>,
    pub memory_dirs: Vec<PathBuf>,
    pub config_dirs: Vec<PathBuf>,
    pub enable_mcp: bool,
    pub trust_workspace_mcp: bool,
    pub enable_memory: bool,
    pub memory_require_approval: bool,
    pub advanced_memory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_generation_model: Option<String>,
    pub skill_improvement_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_improvement_model: Option<String>,
    pub skill_improvement_scope: SkillImprovementScope,
    pub skill_improvement_excluded_skills: Vec<String>,
    pub include_raw_chunks: bool,
    pub tasks_enabled: bool,
    pub workflows_enabled: bool,
    pub feature_flags: FeatureFlags,
    pub experimental_features: ExperimentalFeatures,
    pub backups_enabled: bool,
    pub observability_enabled: bool,
    pub observability: ObservabilityConfig,
    pub harness: HarnessConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<HashMap<String, CommandTemplateConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_settings: Option<ModelSettings>,
}

pub(crate) fn deep_merge_objects(
    base: &Map<String, Value>,
    over: &Map<String, Value>,
) -> Map<String, Value> {
    let mut out = base.clone();
    for (k, v) in over {
        if let (Some(Value::Object(existing)), Value::Object(incoming)) = (out.get(k), v) {
            out.insert(
                k.clone(),
                Value::Object(deep_merge_objects(existing, incoming)),
            );
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

pub(crate) fn load_json_object_safe(file_path: &Path) -> Result<Map<String, Value>> {
    let raw = match fs::read_to_string(file_path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(source) => {
            return Err(ConfigError::Io {
                path: file_path.to_path_buf(),
                source,
            });
        }
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| ConfigError::InvalidJson {
        path: file_path.to_path_buf(),
        message: e.to_string(),
    })?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err(ConfigError::NotJsonObject(file_path.to_path_buf())),
    }
}

fn as_bool_like_value(val: Option<&Value>) -> Option<bool> {
    match val? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => as_bool_like_str(Some(s.as_str())),
        _ => None,
    }
}

pub fn as_bool_like_str(raw: Option<&str>) -> Option<bool> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

fn as_non_empty_str_val(val: Option<&Value>) -> Option<String> {
    val?.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn as_non_empty_env(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn as_non_negative_u64_val(val: Option<&Value>) -> Option<u64> {
    match val? {
        Value::Number(n) => n
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f.floor() as u64),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f.floor() as u64),
        _ => None,
    }
}

/// Returns:
/// - `None` if `key` is absent or invalid (inherit parent tier / default),
/// - `Some(None)` if explicitly `null` (disable truncation),
/// - `Some(Some(n))` if a valid non-negative integer.
fn parse_nullable_overflow_field(map: &Map<String, Value>, key: &str) -> Option<Option<u64>> {
    let raw = map.get(key)?;
    if raw.is_null() {
        return Some(None);
    }
    as_non_negative_u64_val(Some(raw)).map(Some)
}

fn as_string_array_val(val: Option<&Value>) -> Option<Vec<String>> {
    match val? {
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(|v| as_non_empty_str_val(Some(v)))
                .collect(),
        ),
        Value::String(s) => Some(
            s.split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
        ),
        _ => None,
    }
}

fn resolve_sandbox_config(env_mode: Option<&str>, inherited_raw: Option<&Value>) -> SandboxConfig {
    let obj = inherited_raw.and_then(Value::as_object);
    let mode = env_mode
        .and_then(SandboxMode::parse)
        .or_else(|| {
            obj.and_then(|o| o.get("mode"))
                .and_then(Value::as_str)
                .and_then(SandboxMode::parse)
        })
        .unwrap_or(SandboxMode::WorkspaceWrite);
    let defaults = SandboxConfig::default();
    let network = obj
        .and_then(|o| o.get("network"))
        .and_then(Value::as_bool)
        .unwrap_or(defaults.network);
    let require_backend = obj
        .and_then(|o| o.get("requireBackend"))
        .and_then(Value::as_bool)
        .unwrap_or(defaults.require_backend);
    SandboxConfig {
        mode,
        network,
        require_backend,
    }
}

fn resolve_dir_inside_workspace(maybe_rel: &str, base_cwd: &Path) -> PathBuf {
    let candidate = Path::new(maybe_rel);
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_cwd.join(candidate)
    };
    if !is_inside(base_cwd, &resolved) {
        return base_cwd.to_path_buf();
    }
    resolved
}

pub fn is_network_telemetry_globally_disabled(env: &HashMap<String, String>) -> bool {
    as_bool_like_str(
        env.get("COWORK_DISABLE_NETWORK_TELEMETRY")
            .map(String::as_str),
    ) == Some(true)
}

fn resolve_builtin_dir(env: &HashMap<String, String>) -> PathBuf {
    if let Some(dir) = as_non_empty_env(env, "COWORK_BUILTIN_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(cwd) = std::env::current_dir()
        && cwd.join("config").join("defaults.json").exists()
    {
        return cwd;
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn parse_commands_config(
    raw: Option<&Value>,
) -> Result<Option<HashMap<String, CommandTemplateConfig>>> {
    let Some(val) = raw else {
        return Ok(None);
    };
    let Some(obj) = val.as_object() else {
        return Err(ConfigError::Validation(
            "Invalid command config: expected object".to_string(),
        ));
    };
    let mut commands = HashMap::new();
    for (name, entry) in obj {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(ConfigError::Validation(
                "Invalid command config: empty command name".to_string(),
            ));
        }
        let parsed: CommandTemplateConfig = serde_json::from_value(entry.clone())
            .map_err(|e| ConfigError::Validation(format!("Invalid command config: {e}")))?;
        if parsed.template.trim().is_empty()
            || !matches!(parsed.source.as_str(), "command" | "mcp" | "skill")
        {
            return Err(ConfigError::Validation(
                "Invalid command config: invalid template or source".to_string(),
            ));
        }
        commands.insert(trimmed_name.to_string(), parsed);
    }
    if commands.is_empty() {
        Ok(None)
    } else {
        Ok(Some(commands))
    }
}

/// Loads and merges configuration across all 4 tiers (`defaults < user < workspace < env`)
/// while enforcing workspace security trust boundaries (`src/config.ts` parity).
pub fn load_config(options: LoadConfigOptions) -> Result<AgentConfig> {
    let env = options.env.unwrap_or_else(env_map_from_process);
    let cwd = options
        .cwd
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let homedir = options
        .homedir
        .unwrap_or_else(|| resolve_home_dir(&env, host_platform()));
    let built_in_dir = options
        .built_in_dir
        .unwrap_or_else(|| resolve_builtin_dir(&env));

    let project_cowork_dir = cwd.join(".cowork");
    let workspace_agents_dir = cwd.join(".agents");
    let user_agents_dir = homedir.join(".agents");
    let built_in_config_dir = built_in_dir.join("config");
    let cowork_paths = get_ai_coworker_paths(Some(&homedir), &env);
    let user_cowork_dir = cowork_paths.root_dir.clone();
    let one_off_chats_root = get_one_off_chats_root(&homedir);
    let project_memory_cowork_dir = if is_path_inside_one_off_chats_root(&cwd, &homedir) {
        one_off_chats_root.join(".cowork")
    } else {
        project_cowork_dir.clone()
    };
    let project_memory_dir = project_memory_cowork_dir.join("memory");
    let project_memory_db_path = project_memory_cowork_dir.join("memory.sqlite");
    let workspace_plugins_dir = project_cowork_dir.join("plugins");
    let user_plugins_dir = user_cowork_dir.join("plugins");
    let user_config_dir = cowork_paths.config_dir.clone();

    let defaults_path = built_in_config_dir.join("defaults.json");
    let built_in_defaults: Map<String, Value> = if defaults_path.exists() {
        load_json_object_safe(&defaults_path)?
    } else {
        serde_json::from_str(BUILTIN_DEFAULTS_JSON)
            .expect("embedded config/defaults.json must be valid JSON object")
    };
    let user_config = load_json_object_safe(&user_config_dir.join("config.json"))?;
    let project_config = load_json_object_safe(&project_cowork_dir.join("config.json"))?;

    let inherited_merged = deep_merge_objects(&built_in_defaults, &user_config);
    let merged = deep_merge_objects(&inherited_merged, &project_config);

    let provider = env
        .get("AGENT_PROVIDER")
        .and_then(|s| ProviderName::parse(s))
        .or_else(|| resolve_provider_name(project_config.get("provider")))
        .or_else(|| resolve_provider_name(user_config.get("provider")))
        .or_else(|| resolve_provider_name(built_in_defaults.get("provider")))
        .unwrap_or(ProviderName::Google);

    let raw_runtime = env
        .get("AGENT_RUNTIME")
        .and_then(|s| RuntimeName::parse(s))
        .or_else(|| {
            project_config
                .get("runtime")
                .and_then(Value::as_str)
                .and_then(RuntimeName::parse)
        })
        .or_else(|| {
            user_config
                .get("runtime")
                .and_then(Value::as_str)
                .and_then(RuntimeName::parse)
        })
        .or_else(|| {
            built_in_defaults
                .get("runtime")
                .and_then(Value::as_str)
                .and_then(RuntimeName::parse)
        });
    let runtime = normalize_runtime_name_for_provider(provider, raw_runtime);

    let working_directory = as_non_empty_env(&env, "AGENT_WORKING_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.clone());

    // SECURITY BOUNDARY: sandbox resolves ONLY from env.AGENT_SANDBOX + inheritedMerged.sandbox (never projectConfig!).
    let sandbox = resolve_sandbox_config(
        env.get("AGENT_SANDBOX").map(String::as_str),
        inherited_merged.get("sandbox"),
    );

    let tool_calling_obj = merged.get("toolCalling").and_then(Value::as_object);
    let tool_calling = ToolCallingConfig {
        code_mode: tool_calling_obj
            .and_then(|o| o.get("codeMode"))
            .and_then(Value::as_bool)
            == Some(true),
        deferred_tool_search: tool_calling_obj
            .and_then(|o| o.get("deferredToolSearch"))
            .and_then(Value::as_bool)
            == Some(true),
    };

    let configured_model = as_non_empty_env(&env, "AGENT_MODEL")
        .or_else(|| as_non_empty_str_val(project_config.get("model")))
        .or_else(|| as_non_empty_str_val(user_config.get("model")))
        .or_else(|| {
            if resolve_provider_name(built_in_defaults.get("provider")) == Some(provider) {
                as_non_empty_str_val(built_in_defaults.get("model"))
            } else {
                None
            }
        });

    let registry = ModelRegistry::load_from_builtin_dir(&built_in_dir);
    let supported_model =
        registry.resolve_model_for_config(provider, configured_model.as_deref(), &homedir, &env);

    // Merge providerOptions defaults with configured providerOptions and reconcile gated reasoning keys.
    let merged_provider_opts_raw = merged.get("providerOptions").and_then(Value::as_object);
    let mut combined_provider_opts = merged_provider_opts_raw.cloned().unwrap_or_default();
    let current_section = combined_provider_opts
        .get(provider.as_str())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let merged_section =
        deep_merge_objects(&supported_model.provider_options_defaults, &current_section);
    if merged_section.is_empty() {
        combined_provider_opts.remove(provider.as_str());
    } else {
        combined_provider_opts.insert(provider.as_str().to_string(), Value::Object(merged_section));
    }
    let provider_options = reconcile_reasoning_provider_options(
        &combined_provider_opts,
        provider,
        &supported_model.provider_options_defaults,
    );

    let child_routing_mode = project_config
        .get("childModelRoutingMode")
        .and_then(Value::as_str)
        .and_then(ChildModelRoutingMode::parse)
        .or_else(|| {
            user_config
                .get("childModelRoutingMode")
                .and_then(Value::as_str)
                .and_then(ChildModelRoutingMode::parse)
        })
        .or_else(|| {
            built_in_defaults
                .get("childModelRoutingMode")
                .and_then(Value::as_str)
                .and_then(ChildModelRoutingMode::parse)
        })
        .unwrap_or(ChildModelRoutingMode::SameProvider);

    let raw_allowed_refs = as_string_array_val(project_config.get("allowedChildModelRefs"))
        .or_else(|| as_string_array_val(user_config.get("allowedChildModelRefs")))
        .or_else(|| as_string_array_val(built_in_defaults.get("allowedChildModelRefs")));

    let preferred_child_ref_raw =
        as_non_empty_str_val(project_config.get("preferredChildModelRef"))
            .or_else(|| as_non_empty_str_val(user_config.get("preferredChildModelRef")))
            .or_else(|| as_non_empty_str_val(built_in_defaults.get("preferredChildModelRef")))
            .or_else(|| as_non_empty_str_val(project_config.get("preferredChildModel")))
            .or_else(|| as_non_empty_str_val(user_config.get("preferredChildModel")))
            .or_else(|| as_non_empty_str_val(built_in_defaults.get("preferredChildModel")))
            .or_else(|| as_non_empty_str_val(project_config.get("subAgentModel")))
            .or_else(|| as_non_empty_str_val(user_config.get("subAgentModel")))
            .or_else(|| as_non_empty_str_val(built_in_defaults.get("subAgentModel")));

    let child_routing = normalize_child_routing_config(
        provider,
        &supported_model.id,
        child_routing_mode,
        preferred_child_ref_raw.as_deref(),
        raw_allowed_refs.as_deref(),
    );

    let inherited_overflow =
        parse_nullable_overflow_field(&inherited_merged, "toolOutputOverflowChars")
            .unwrap_or(Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));
    let project_overflow =
        parse_nullable_overflow_field(&project_config, "toolOutputOverflowChars");
    let merged_overflow = parse_nullable_overflow_field(&merged, "toolOutputOverflowChars")
        .unwrap_or(Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));

    let workflow_max_concurrent_agents =
        as_non_negative_u64_val(merged.get("workflowMaxConcurrentAgents"))
            .map(|n| (n as usize).clamp(1, 16))
            .unwrap_or(DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS);

    let canonical_cwd = canonicalize_sync(&cwd);
    let output_dir_raw = as_non_empty_env(&env, "AGENT_OUTPUT_DIR")
        .or_else(|| as_non_empty_str_val(project_config.get("outputDirectory")))
        .or_else(|| as_non_empty_str_val(user_config.get("outputDirectory")))
        .or_else(|| as_non_empty_str_val(built_in_defaults.get("outputDirectory")));
    let output_directory = output_dir_raw.map(|d| resolve_dir_inside_workspace(&d, &canonical_cwd));

    let uploads_dir_raw = as_non_empty_env(&env, "AGENT_UPLOADS_DIR")
        .or_else(|| as_non_empty_str_val(project_config.get("uploadsDirectory")))
        .or_else(|| as_non_empty_str_val(user_config.get("uploadsDirectory")))
        .or_else(|| as_non_empty_str_val(built_in_defaults.get("uploadsDirectory")));
    let uploads_directory =
        uploads_dir_raw.map(|d| resolve_dir_inside_workspace(&d, &canonical_cwd));

    let user_name = env
        .get("AGENT_USER_NAME")
        .map(|s| s.trim().to_string())
        .or_else(|| {
            merged
                .get("userName")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();

    let profile_obj = merged.get("userProfile").and_then(Value::as_object);
    let user_profile = UserProfile {
        instructions: profile_obj
            .and_then(|o| o.get("instructions"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        work: profile_obj
            .and_then(|o| o.get("work"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        details: profile_obj
            .and_then(|o| o.get("details"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    };

    let enable_mcp = as_bool_like_str(env.get("AGENT_ENABLE_MCP").map(String::as_str))
        .or_else(|| as_bool_like_value(project_config.get("enableMcp")))
        .or_else(|| as_bool_like_value(user_config.get("enableMcp")))
        .or_else(|| as_bool_like_value(built_in_defaults.get("enableMcp")))
        .unwrap_or(true);

    // SECURITY BOUNDARY: trustWorkspaceMcp omits untrusted projectConfig!
    let trust_workspace_mcp =
        as_bool_like_str(env.get("AGENT_TRUST_WORKSPACE_MCP").map(String::as_str))
            .or_else(|| as_bool_like_value(user_config.get("trustWorkspaceMcp")))
            .or_else(|| as_bool_like_value(built_in_defaults.get("trustWorkspaceMcp")))
            .unwrap_or(false);

    let enable_memory = as_bool_like_str(env.get("AGENT_ENABLE_MEMORY").map(String::as_str))
        .or_else(|| as_bool_like_value(project_config.get("enableMemory")))
        .or_else(|| as_bool_like_value(user_config.get("enableMemory")))
        .or_else(|| as_bool_like_value(built_in_defaults.get("enableMemory")))
        .unwrap_or(true);

    let memory_require_approval =
        as_bool_like_str(env.get("AGENT_MEMORY_REQUIRE_APPROVAL").map(String::as_str))
            .or_else(|| as_bool_like_value(project_config.get("memoryRequireApproval")))
            .or_else(|| as_bool_like_value(user_config.get("memoryRequireApproval")))
            .or_else(|| as_bool_like_value(built_in_defaults.get("memoryRequireApproval")))
            .unwrap_or(false);

    // Global-only memory & skill improvement settings (omit projectConfig).
    let advanced_memory = as_bool_like_str(env.get("AGENT_ADVANCED_MEMORY").map(String::as_str))
        .or_else(|| as_bool_like_value(user_config.get("advancedMemory")))
        .or_else(|| as_bool_like_value(built_in_defaults.get("advancedMemory")))
        .unwrap_or(false);

    let memory_generation_model = as_non_empty_env(&env, "AGENT_MEMORY_MODEL")
        .or_else(|| as_non_empty_str_val(user_config.get("memoryGenerationModel")))
        .or_else(|| as_non_empty_str_val(built_in_defaults.get("memoryGenerationModel")));

    let skill_improvement_enabled =
        as_bool_like_str(env.get("AGENT_SKILL_IMPROVEMENT").map(String::as_str))
            .or_else(|| as_bool_like_value(user_config.get("skillImprovementEnabled")))
            .or_else(|| as_bool_like_value(built_in_defaults.get("skillImprovementEnabled")))
            .unwrap_or(false);

    let skill_improvement_model = as_non_empty_env(&env, "AGENT_SKILL_IMPROVEMENT_MODEL")
        .or_else(|| as_non_empty_str_val(user_config.get("skillImprovementModel")))
        .or_else(|| as_non_empty_str_val(built_in_defaults.get("skillImprovementModel")));

    let skill_improvement_scope = env
        .get("AGENT_SKILL_IMPROVEMENT_SCOPE")
        .and_then(|s| SkillImprovementScope::parse(s))
        .or_else(|| {
            user_config
                .get("skillImprovementScope")
                .and_then(Value::as_str)
                .and_then(SkillImprovementScope::parse)
        })
        .or_else(|| {
            built_in_defaults
                .get("skillImprovementScope")
                .and_then(Value::as_str)
                .and_then(SkillImprovementScope::parse)
        })
        .unwrap_or(SkillImprovementScope::User);

    let skill_improvement_excluded_skills = env
        .get("AGENT_SKILL_IMPROVEMENT_EXCLUDED_SKILLS")
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .or_else(|| as_string_array_val(user_config.get("skillImprovementExcludedSkills")))
        .or_else(|| as_string_array_val(built_in_defaults.get("skillImprovementExcludedSkills")))
        .unwrap_or_default();

    let include_raw_chunks =
        as_bool_like_str(env.get("AGENT_INCLUDE_RAW_CHUNKS").map(String::as_str))
            .or_else(|| as_bool_like_value(project_config.get("includeRawChunks")))
            .or_else(|| as_bool_like_value(user_config.get("includeRawChunks")))
            .or_else(|| as_bool_like_value(built_in_defaults.get("includeRawChunks")))
            .unwrap_or(true);

    let is_packaged = env.get("COWORK_IS_PACKAGED").map(String::as_str) == Some("true");
    let feature_flags = resolve_feature_flags(ResolveFeatureFlagsOptions {
        is_packaged,
        env: Some(&env),
        overrides: None,
    });

    let backups_enabled = as_bool_like_str(env.get("AGENT_BACKUPS_ENABLED").map(String::as_str))
        .or_else(|| as_bool_like_value(project_config.get("backupsEnabled")))
        .or_else(|| as_bool_like_value(user_config.get("backupsEnabled")))
        .or_else(|| as_bool_like_value(built_in_defaults.get("backupsEnabled")))
        .unwrap_or(false);

    // SECURITY BOUNDARY: Workspace observability cannot inject endpoints/keys or enable telemetry;
    // it may ONLY clamp observabilityEnabled/recordInputs/recordOutputs to false and add non-secret labels.
    let inherited_obs = inherited_merged
        .get("observability")
        .and_then(Value::as_object);
    let project_obs = project_config
        .get("observability")
        .and_then(Value::as_object);
    let network_telemetry_disabled = is_network_telemetry_globally_disabled(&env);

    let requested_obs_enabled =
        as_bool_like_str(env.get("AGENT_OBSERVABILITY_ENABLED").map(String::as_str))
            .unwrap_or_else(|| {
                if as_bool_like_value(project_config.get("observabilityEnabled")) == Some(false) {
                    false
                } else {
                    as_bool_like_value(user_config.get("observabilityEnabled"))
                        .or_else(|| {
                            as_bool_like_value(built_in_defaults.get("observabilityEnabled"))
                        })
                        .unwrap_or(false)
                }
            });
    let observability_enabled = if network_telemetry_disabled {
        false
    } else {
        requested_obs_enabled
    };

    let obs_record_payloads = as_bool_like_str(
        env.get("AGENT_OBSERVABILITY_RECORD_PAYLOADS")
            .map(String::as_str),
    );
    let record_inputs = if network_telemetry_disabled {
        false
    } else {
        as_bool_like_str(
            env.get("AGENT_OBSERVABILITY_RECORD_INPUTS")
                .map(String::as_str),
        )
        .or(obs_record_payloads)
        .unwrap_or_else(|| {
            if project_obs.and_then(|o| as_bool_like_value(o.get("recordInputs"))) == Some(false) {
                false
            } else {
                inherited_obs
                    .and_then(|o| as_bool_like_value(o.get("recordInputs")))
                    .unwrap_or(false)
            }
        })
    };
    let record_outputs = if network_telemetry_disabled {
        false
    } else {
        as_bool_like_str(
            env.get("AGENT_OBSERVABILITY_RECORD_OUTPUTS")
                .map(String::as_str),
        )
        .or(obs_record_payloads)
        .unwrap_or_else(|| {
            if project_obs.and_then(|o| as_bool_like_value(o.get("recordOutputs"))) == Some(false) {
                false
            } else {
                inherited_obs
                    .and_then(|o| as_bool_like_value(o.get("recordOutputs")))
                    .unwrap_or(false)
            }
        })
    };

    let langfuse_base_url = as_non_empty_env(&env, "LANGFUSE_BASE_URL")
        .or_else(|| inherited_obs.and_then(|o| as_non_empty_str_val(o.get("baseUrl"))))
        .unwrap_or_else(|| "https://cloud.langfuse.com".to_string())
        .trim_end_matches('/')
        .to_string();

    let public_key = if network_telemetry_disabled {
        None
    } else {
        as_non_empty_env(&env, "LANGFUSE_PUBLIC_KEY")
            .or_else(|| inherited_obs.and_then(|o| as_non_empty_str_val(o.get("publicKey"))))
    };
    let secret_key = if network_telemetry_disabled {
        None
    } else {
        as_non_empty_env(&env, "LANGFUSE_SECRET_KEY")
            .or_else(|| inherited_obs.and_then(|o| as_non_empty_str_val(o.get("secretKey"))))
    };
    let tracing_environment = if network_telemetry_disabled {
        None
    } else {
        as_non_empty_env(&env, "LANGFUSE_TRACING_ENVIRONMENT")
            .or_else(|| project_obs.and_then(|o| as_non_empty_str_val(o.get("tracingEnvironment"))))
            .or_else(|| {
                inherited_obs.and_then(|o| as_non_empty_str_val(o.get("tracingEnvironment")))
            })
    };
    let release = if network_telemetry_disabled {
        None
    } else {
        as_non_empty_env(&env, "LANGFUSE_RELEASE")
            .or_else(|| project_obs.and_then(|o| as_non_empty_str_val(o.get("release"))))
            .or_else(|| inherited_obs.and_then(|o| as_non_empty_str_val(o.get("release"))))
    };

    let observability = ObservabilityConfig {
        provider: "langfuse".to_string(),
        otel_endpoint: format!("{langfuse_base_url}/api/public/otel/v1/traces"),
        base_url: langfuse_base_url,
        public_key,
        secret_key,
        tracing_environment,
        release,
        record_inputs,
        record_outputs,
    };

    let harness_obj = merged.get("harness").and_then(Value::as_object);
    let harness = HarnessConfig {
        report_only: as_bool_like_str(env.get("AGENT_HARNESS_REPORT_ONLY").map(String::as_str))
            .or_else(|| harness_obj.and_then(|o| as_bool_like_value(o.get("reportOnly"))))
            .unwrap_or(true),
        strict_mode: as_bool_like_str(env.get("AGENT_HARNESS_STRICT_MODE").map(String::as_str))
            .or_else(|| harness_obj.and_then(|o| as_bool_like_value(o.get("strictMode"))))
            .unwrap_or(false),
    };

    let command = parse_commands_config(merged.get("command"))?;
    let disable_builtin_skills =
        as_bool_like_str(env.get("COWORK_DISABLE_BUILTIN_SKILLS").map(String::as_str))
            .unwrap_or(false);

    let mut skills_dirs = vec![
        project_cowork_dir.join("skills"),
        cowork_paths.skills_dir.clone(),
    ];
    if !disable_builtin_skills {
        skills_dirs.push(built_in_dir.join("skills"));
    }

    let max_retries = env
        .get("AGENT_MODEL_MAX_RETRIES")
        .and_then(|s| s.trim().parse::<u32>().ok())
        .or_else(|| {
            merged
                .get("modelSettings")
                .and_then(Value::as_object)
                .and_then(|o| as_non_negative_u64_val(o.get("maxRetries")))
                .map(|n| n as u32)
        });
    let model_settings = max_retries.map(|m| ModelSettings {
        max_retries: Some(m),
    });

    Ok(AgentConfig {
        provider,
        runtime,
        sandbox,
        tool_calling,
        model: supported_model.id,
        preferred_child_model: child_routing.preferred_child_model,
        child_model_routing_mode: child_routing.child_model_routing_mode,
        preferred_child_model_ref: child_routing.preferred_child_model_ref,
        allowed_child_model_refs: child_routing.allowed_child_model_refs,
        tool_output_overflow_chars: merged_overflow,
        workflow_max_concurrent_agents,
        inherited_tool_output_overflow_chars: inherited_overflow,
        project_config_overrides: project_overflow.map(|ov| ProjectConfigOverrides {
            tool_output_overflow_chars: ov,
        }),
        working_directory,
        output_directory,
        uploads_directory,
        user_name,
        user_profile,
        knowledge_cutoff: supported_model.knowledge_cutoff,
        project_cowork_dir: project_cowork_dir.clone(),
        project_memory_dir: project_memory_dir.clone(),
        project_memory_db_path,
        memories_dir: cowork_paths.memories_dir,
        user_cowork_dir: user_cowork_dir.clone(),
        workspace_agents_dir,
        user_agents_dir,
        workspace_plugins_dir,
        user_plugins_dir,
        built_in_dir,
        built_in_config_dir: built_in_config_dir.clone(),
        skills_dirs,
        memory_dirs: vec![project_memory_dir, user_cowork_dir.join("memory")],
        config_dirs: vec![project_cowork_dir, user_config_dir, built_in_config_dir],
        enable_mcp,
        trust_workspace_mcp,
        enable_memory,
        memory_require_approval,
        advanced_memory,
        memory_generation_model,
        skill_improvement_enabled,
        skill_improvement_model,
        skill_improvement_scope,
        skill_improvement_excluded_skills,
        include_raw_chunks,
        tasks_enabled: feature_flags.tasks,
        workflows_enabled: feature_flags.workflows,
        feature_flags,
        experimental_features: ExperimentalFeatures {
            open_ai_native_connectors: is_openai_native_connectors_experiment_enabled(&env),
        },
        backups_enabled,
        observability_enabled,
        observability,
        harness,
        command,
        provider_options,
        model_settings,
    })
}
