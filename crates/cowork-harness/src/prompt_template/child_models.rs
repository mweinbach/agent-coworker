//! Child-agent model data for the spawnAgent prompt: legacy `src/models/childAgentModelInfo.ts`
//! (`bestFor` table) and the static model registry listing (`listSupportedModels`).

use std::path::Path;

use cowork_config::models::find_discovered_model_sync;
use cowork_config::{AiCoworkerPaths, ProviderName, SupportedModel};

const FRONTIER_CODING: &str =
    "frontier coding, agentic workflows, and the hardest reasoning-heavy tasks";
const BALANCED_GENERAL: &str =
    "strong general-purpose coding and reasoning with a balanced quality-latency tradeoff";
const FAST_GENERAL: &str =
    "fast lower-cost general work, smaller coding tasks, and lightweight verification passes";
const DEEP_REASONING: &str =
    "highest-accuracy deep analysis and difficult tasks where latency matters less";
const CLAUDE_FRONTIER: &str =
    "top-tier long-running coding, deep analysis, and high-stakes agent work";
const CLAUDE_BALANCED: &str =
    "everyday coding and analysis when you want strong quality without Opus-level latency or cost";
const CLAUDE_FAST: &str =
    "fast lightweight summarization, extraction, and smaller read-only or routing tasks";
const GEMINI_PRO: &str =
    "complex multimodal reasoning, long-context research, and harder coding tasks";
const GEMINI_FLASH: &str =
    "lower-latency multimodal tasks, quick synthesis, and lighter coding or retrieval work";
const OPEN_REASONER: &str =
    "strong open-model reasoning and coding tasks when you want a capable non-closed model option";
const GLM5: &str =
    "agentic coding, tool use, and Chinese-English general work with strong reasoning support";
const KIMI25: &str =
    "coding, math, and general reasoning when you want a strong all-around open model";
const QWEN_ADVANCED: &str =
    "advanced reasoning, coding, and agentic tasks that benefit from a larger Qwen model";
const MINIMAX25: &str =
    "general reasoning, coding, and multimodal tasks with a balanced high-capability profile";
const MIMO: &str = "open-source multimodal reasoning and coding with the MiMo model family";
const FREE_EXPERIMENTAL: &str =
    "free-tier experimentation, rough first passes, and non-critical exploratory work";
const KIMI26_TURBO: &str =
    "fast agentic coding and multimodal tasks with Kimi K2.6 Turbo via Fire Pass subscription";

/// Legacy `CHILD_AGENT_MODEL_INFO_BY_KEY`: `(provider, modelId, bestFor)`.
const CHILD_AGENT_MODEL_BEST_FOR: &[(&str, &str, &str)] = &[
    ("openai", "gpt-5.5", FRONTIER_CODING),
    ("openai", "gpt-5.4-pro", DEEP_REASONING),
    ("openai", "gpt-5.4", FRONTIER_CODING),
    ("openai", "gpt-5.4-mini", FRONTIER_CODING),
    ("openai", "gpt-5.4-nano", FAST_GENERAL),
    ("openai", "gpt-5.2", BALANCED_GENERAL),
    ("openai", "gpt-5.2-pro", DEEP_REASONING),
    ("openai", "gpt-5-mini", FAST_GENERAL),
    ("codex-cli", "gpt-5.5", FRONTIER_CODING),
    ("codex-cli", "gpt-5.6-sol", FRONTIER_CODING),
    ("codex-cli", "gpt-5.6-terra", BALANCED_GENERAL),
    ("codex-cli", "gpt-5.6-luna", FAST_GENERAL),
    ("codex-cli", "gpt-5.4", FRONTIER_CODING),
    ("codex-cli", "gpt-5.4-mini", FRONTIER_CODING),
    ("codex-cli", "gpt-5.3-codex-spark", FAST_GENERAL),
    ("anthropic", "claude-opus-4-6", CLAUDE_FRONTIER),
    ("anthropic", "claude-opus-4-7", CLAUDE_FRONTIER),
    ("anthropic", "claude-opus-4-8", CLAUDE_FRONTIER),
    ("anthropic", "claude-sonnet-4-6", CLAUDE_BALANCED),
    ("anthropic", "claude-sonnet-4-5", CLAUDE_BALANCED),
    ("anthropic", "claude-haiku-4-5", CLAUDE_FAST),
    ("bedrock", "amazon.nova-lite-v1:0", FAST_GENERAL),
    ("bedrock", "amazon.nova-micro-v1:0", FAST_GENERAL),
    (
        "bedrock",
        "anthropic.claude-3-5-haiku-20241022-v1:0",
        CLAUDE_FAST,
    ),
    ("google", "gemini-3.1-pro-preview", GEMINI_PRO),
    ("google", "gemini-3.1-pro-preview-customtools", GEMINI_PRO),
    ("google", "gemini-3-flash-preview", GEMINI_FLASH),
    ("google", "gemini-3.1-flash-lite", GEMINI_FLASH),
    ("google", "gemini-3.5-flash", GEMINI_FLASH),
    ("nvidia", "nvidia/nemotron-3-super-120b-a12b", OPEN_REASONER),
    ("together", "zai-org/GLM-5", GLM5),
    (
        "fireworks",
        "accounts/fireworks/models/deepseek-v4-pro",
        DEEP_REASONING,
    ),
    ("fireworks", "accounts/fireworks/models/glm-5p1", GLM5),
    ("together", "moonshotai/Kimi-K2.5", KIMI25),
    ("fireworks", "accounts/fireworks/models/kimi-k2p6", KIMI25),
    (
        "firepass",
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        KIMI26_TURBO,
    ),
    ("together", "Qwen/Qwen3.5-397B-A17B", QWEN_ADVANCED),
    (
        "fireworks",
        "accounts/fireworks/models/minimax-m2p7",
        MINIMAX25,
    ),
    ("minimax", "MiniMax-M3", FRONTIER_CODING),
    (
        "fireworks",
        "accounts/fireworks/models/qwen3p6-plus",
        QWEN_ADVANCED,
    ),
    ("opencode-go", "deepseek-v4-flash", OPEN_REASONER),
    ("opencode-go", "deepseek-v4-pro", DEEP_REASONING),
    ("opencode-go", "glm-5", GLM5),
    ("opencode-go", "glm-5.1", GLM5),
    ("opencode-go", "hy3-preview", FREE_EXPERIMENTAL),
    ("opencode-go", "kimi-k2.5", KIMI25),
    ("opencode-go", "kimi-k2.6", KIMI25),
    ("opencode-go", "mimo-v2-omni", MIMO),
    ("opencode-go", "mimo-v2-pro", MIMO),
    ("opencode-go", "mimo-v2.5", MIMO),
    ("opencode-go", "mimo-v2.5-pro", MIMO),
    ("opencode-go", "minimax-m2.5", MINIMAX25),
    ("opencode-go", "minimax-m2.7", MINIMAX25),
    ("opencode-go", "minimax-m3", MINIMAX25),
    ("opencode-go", "qwen3.5-plus", QWEN_ADVANCED),
    ("opencode-go", "qwen3.6-plus", QWEN_ADVANCED),
    ("opencode-go", "qwen3.7-max", QWEN_ADVANCED),
    ("opencode-go", "qwen3.7-plus", QWEN_ADVANCED),
    ("opencode-zen", "big-pickle", FREE_EXPERIMENTAL),
    ("opencode-zen", "claude-haiku-4-5", CLAUDE_FAST),
    ("opencode-zen", "claude-opus-4-1", CLAUDE_FRONTIER),
    ("opencode-zen", "claude-opus-4-5", CLAUDE_FRONTIER),
    ("opencode-zen", "claude-opus-4-6", CLAUDE_FRONTIER),
    ("opencode-zen", "claude-opus-4-7", CLAUDE_FRONTIER),
    ("opencode-zen", "claude-opus-4-8", CLAUDE_FRONTIER),
    ("opencode-zen", "claude-sonnet-4", CLAUDE_BALANCED),
    ("opencode-zen", "claude-sonnet-4-5", CLAUDE_BALANCED),
    ("opencode-zen", "claude-sonnet-4-6", CLAUDE_BALANCED),
    ("opencode-zen", "deepseek-v4-flash", OPEN_REASONER),
    ("opencode-zen", "deepseek-v4-flash-free", FREE_EXPERIMENTAL),
    ("opencode-zen", "gemini-3-flash", GEMINI_FLASH),
    ("opencode-zen", "gemini-3.1-pro", GEMINI_PRO),
    ("opencode-zen", "gemini-3.5-flash", GEMINI_FLASH),
    ("opencode-zen", "glm-5", GLM5),
    ("opencode-zen", "glm-5.1", GLM5),
    ("opencode-zen", "gpt-5", FRONTIER_CODING),
    ("opencode-zen", "gpt-5-codex", FRONTIER_CODING),
    ("opencode-zen", "gpt-5-nano", FAST_GENERAL),
    ("opencode-zen", "gpt-5.1", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.1-codex", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.1-codex-max", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.1-codex-mini", FAST_GENERAL),
    ("opencode-zen", "gpt-5.2", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.2-codex", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.3-codex", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.3-codex-spark", FAST_GENERAL),
    ("opencode-zen", "gpt-5.4", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.4-mini", FAST_GENERAL),
    ("opencode-zen", "gpt-5.4-nano", FAST_GENERAL),
    ("opencode-zen", "gpt-5.4-pro", DEEP_REASONING),
    ("opencode-zen", "gpt-5.5", FRONTIER_CODING),
    ("opencode-zen", "gpt-5.5-pro", DEEP_REASONING),
    ("opencode-zen", "grok-build-0.1", FRONTIER_CODING),
    ("opencode-zen", "kimi-k2.5", KIMI25),
    ("opencode-zen", "kimi-k2.6", KIMI25),
    ("opencode-zen", "mimo-v2.5-free", FREE_EXPERIMENTAL),
    ("opencode-zen", "minimax-m2.5", MINIMAX25),
    ("opencode-zen", "minimax-m2.7", MINIMAX25),
    ("opencode-zen", "minimax-m3-free", FREE_EXPERIMENTAL),
    ("opencode-zen", "nemotron-3-ultra-free", FREE_EXPERIMENTAL),
    ("opencode-zen", "north-mini-code-free", FREE_EXPERIMENTAL),
    ("opencode-zen", "qwen3.5-plus", QWEN_ADVANCED),
    ("opencode-zen", "qwen3.6-plus", QWEN_ADVANCED),
    ("opencode-zen", "qwen3.6-plus-free", QWEN_ADVANCED),
];

/// Legacy fallback when a model has no `bestFor` entry.
pub(super) const DEFAULT_BEST_FOR: &str = "general-purpose work on this provider";

/// Legacy `getChildAgentModelInfo(provider, modelId)?.bestFor`.
pub(super) fn child_agent_model_best_for(
    provider: ProviderName,
    model_id: &str,
) -> Option<&'static str> {
    CHILD_AGENT_MODEL_BEST_FOR
        .iter()
        .find(|(p, id, _)| *p == provider.as_str() && *id == model_id)
        .map(|(_, _, best_for)| *best_for)
}

/// A static registry model as legacy `listChildAgentModelsWithInfo` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RegistryChildModel {
    pub id: String,
    pub display_name: String,
    pub best_for: Option<&'static str>,
}

/// Approximates JS `String.prototype.localeCompare` for registry ids: case-insensitive first,
/// then byte order as a tiebreak.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// Legacy `listChildAgentModelsWithInfo(provider)`: the bundled registry models of `provider`
/// (`<builtInDir>/config/models/<provider>/*.json`), sorted by id, with their `bestFor`.
/// LM Studio has no static registry, so it lists nothing.
pub(super) fn list_child_agent_models_with_info(
    built_in_dir: Option<&Path>,
    provider: ProviderName,
) -> Vec<RegistryChildModel> {
    if provider.is_runtime_discovery_provider() {
        return Vec::new();
    }
    let Some(dir) = built_in_dir.map(|d| d.join("config").join("models").join(provider.as_str()))
    else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut models: Vec<RegistryChildModel> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|raw| serde_json::from_str::<SupportedModel>(&raw).ok())
        .filter(|model| model.provider == provider)
        .map(|model| RegistryChildModel {
            best_for: child_agent_model_best_for(provider, &model.id),
            id: model.id,
            display_name: model.display_name,
        })
        .collect();
    models.sort_by(|a, b| locale_compare(&a.id, &b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// Registry `supportsImageInput` of a bundled model, if it is in the static registry.
pub(super) fn registry_supports_image_input(
    built_in_dir: Option<&Path>,
    provider: ProviderName,
    model_id: &str,
) -> Option<bool> {
    let dir = built_in_dir?
        .join("config")
        .join("models")
        .join(provider.as_str());
    let trimmed = model_id.trim();
    let effective = cowork_config::legacy_model_alias(provider, trimmed).unwrap_or(trimmed);
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|raw| serde_json::from_str::<SupportedModel>(&raw).ok())
        .find(|model| model.provider == provider && model.id == effective)
        .map(|model| model.supports_image_input)
}

/// Legacy `inferLikelyProviderForModelId` + `providerMatchesLikelyModelProvider`.
fn likely_provider_matches(provider: ProviderName, model_id: &str) -> Option<bool> {
    static OPENAI_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let normalized = model_id.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized.starts_with("claude-") {
        return Some(provider == ProviderName::Anthropic);
    }
    if normalized.starts_with("gemini-") {
        return Some(provider == ProviderName::Google);
    }
    let openai_re = OPENAI_RE.get_or_init(|| {
        regex::Regex::new(r"^o(?:1|3|4)(?:$|[-.])|(?:^|[-.])codex(?:$|[-.])").expect("valid regex")
    });
    if normalized.starts_with("gpt-5")
        || normalized.starts_with("gpt-4o")
        || openai_re.is_match(&normalized)
    {
        return Some(matches!(
            provider,
            ProviderName::Openai | ProviderName::CodexCli
        ));
    }
    None
}

/// Legacy `isModelIdForeignToProvider` for an id absent from `provider`'s registry: it is not
/// the provider's likely family and another static registry lists it.
fn is_model_id_foreign_to_provider(
    built_in_dir: Option<&Path>,
    provider: ProviderName,
    model_id: &str,
) -> bool {
    if likely_provider_matches(provider, model_id) == Some(true) {
        return false;
    }
    ProviderName::ALL
        .into_iter()
        .filter(|candidate| *candidate != provider && !candidate.is_runtime_discovery_provider())
        .any(|candidate| {
            list_child_agent_models_with_info(built_in_dir, candidate)
                .iter()
                .any(|model| model.id == model_id)
        })
}

/// Legacy `isConfiguredCustomModelIdSync`: `providers[provider][].id` of
/// `<config>/custom-models.json`, read without creating anything.
fn is_configured_custom_model_id(
    paths: Option<&AiCoworkerPaths>,
    provider: ProviderName,
    model_id: &str,
) -> bool {
    if !provider.supports_custom_model_ids() {
        return false;
    }
    let Some(raw) = paths.and_then(|paths| {
        std::fs::read_to_string(paths.config_dir.join("custom-models.json")).ok()
    }) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| value.get("providers")?.get(provider.as_str()).cloned())
        .and_then(|entries| entries.as_array().cloned())
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| id.trim() == model_id.trim())
            })
        })
}

/// Display name from legacy `getResolvedModelMetadataSync(provider, modelId, "child target")`:
/// the static registry, then (except Codex) the provider's discovery cache, then the id as
/// placeholder metadata. `None` where legacy threw: an id that provably belongs to another
/// provider and is not configured as a custom model here (LM Studio and Bedrock pass through).
pub(super) fn resolve_child_target_display_name(
    built_in_dir: Option<&Path>,
    paths: Option<&AiCoworkerPaths>,
    provider: ProviderName,
    model_id: &str,
) -> Option<String> {
    if let Some(model) = list_child_agent_models_with_info(built_in_dir, provider)
        .into_iter()
        .find(|model| model.id == model_id)
    {
        return Some(model.display_name);
    }
    if provider != ProviderName::CodexCli
        && let Some(cached) =
            paths.and_then(|paths| find_discovered_model_sync(paths, provider, model_id))
    {
        return Some(if cached.display_name.is_empty() {
            cached.id
        } else {
            cached.display_name
        });
    }
    if matches!(provider, ProviderName::Lmstudio | ProviderName::Bedrock) {
        return Some(model_id.to_owned());
    }
    if is_model_id_foreign_to_provider(built_in_dir, provider, model_id)
        && !is_configured_custom_model_id(paths, provider, model_id)
    {
        return None;
    }
    Some(model_id.to_owned())
}
