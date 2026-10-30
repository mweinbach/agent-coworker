use std::collections::HashMap;

use cowork_config::ProviderName;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Per-model USD pricing rates per 1,000,000 tokens (`src/session/pricing.ts` parity).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context_threshold_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context_input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context_output_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context_cached_input_per_million: Option<f64>,
}

impl ModelPricing {
    pub fn standard(input: f64, output: f64) -> Self {
        Self {
            input_per_million: input,
            output_per_million: output,
            cached_input_per_million: None,
            cache_write_input_per_million: None,
            long_context_threshold_tokens: None,
            long_context_input_per_million: None,
            long_context_output_per_million: None,
            long_context_cached_input_per_million: None,
        }
    }

    pub fn with_cache(
        input: f64,
        output: f64,
        cache_read: Option<f64>,
        cache_write: Option<f64>,
    ) -> Self {
        Self {
            input_per_million: input,
            output_per_million: output,
            cached_input_per_million: cache_read,
            cache_write_input_per_million: cache_write,
            long_context_threshold_tokens: None,
            long_context_input_per_million: None,
            long_context_output_per_million: None,
            long_context_cached_input_per_million: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_long_context(
        input: f64,
        output: f64,
        cache_read: Option<f64>,
        cache_write: Option<f64>,
        threshold_tokens: u64,
        long_input: Option<f64>,
        long_output: Option<f64>,
        long_cached: Option<f64>,
    ) -> Self {
        Self {
            input_per_million: input,
            output_per_million: output,
            cached_input_per_million: cache_read,
            cache_write_input_per_million: cache_write,
            long_context_threshold_tokens: Some(threshold_tokens),
            long_context_input_per_million: long_input,
            long_context_output_per_million: long_output,
            long_context_cached_input_per_million: long_cached,
        }
    }
}

/// Catalog entry associating `(provider, model)` with its `ModelPricing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingCatalogEntry {
    pub provider: ProviderName,
    pub model: String,
    pub pricing: ModelPricing,
}

/// Split USD cost breakdown across billable token buckets.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCostBreakdown {
    pub input_cost_usd: f64,
    pub cached_input_cost_usd: f64,
    pub cache_write_input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub total_cost_usd: f64,
}

/// Tiered model pricing resolver supporting built-in tables, longest-prefix matching, and
/// `COWORK_MODEL_PRICING_OVERRIDES` environment JSON overrides.
#[derive(Debug, Clone)]
pub struct PricingEngine {
    table: HashMap<String, ModelPricing>,
}

impl Default for PricingEngine {
    fn default() -> Self {
        Self {
            table: build_base_pricing_table(),
        }
    }
}

impl PricingEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_env(env: &HashMap<String, String>) -> Self {
        let mut table = build_base_pricing_table();
        for (k, v) in parse_pricing_overrides_from_env(env) {
            table.insert(k, v);
        }
        Self { table }
    }

    pub fn from_process_env() -> Self {
        let mut env = HashMap::new();
        if let Ok(val) = std::env::var("COWORK_MODEL_PRICING_OVERRIDES") {
            env.insert("COWORK_MODEL_PRICING_OVERRIDES".to_string(), val);
        }
        Self::from_env(&env)
    }

    /// Resolves pricing for `(provider, model)` via exact lookup followed by longest-prefix match.
    pub fn resolve(&self, provider: ProviderName, model: &str) -> Option<ModelPricing> {
        // `opencode-go` is intentionally excluded from local pricing estimation.
        if provider == ProviderName::OpencodeGo {
            return None;
        }
        let exact_key = format!("{}:{model}", provider.as_str());
        if let Some(exact) = self.table.get(&exact_key) {
            return Some(exact.clone());
        }

        let prefix = format!("{}:", provider.as_str());
        let mut best_match: Option<&ModelPricing> = None;
        let mut best_len = 0usize;
        for (key, pricing) in &self.table {
            let Some(model_part) = key.strip_prefix(&prefix) else {
                continue;
            };
            if model.starts_with(model_part) && model_part.len() > best_len {
                best_match = Some(pricing);
                best_len = model_part.len();
            }
        }
        best_match.cloned()
    }

    pub fn calculate_cost(
        &self,
        prompt_tokens: u64,
        completion_tokens: u64,
        pricing: &ModelPricing,
        cached_prompt_tokens: u64,
        cache_write_prompt_tokens: u64,
    ) -> f64 {
        self.calculate_breakdown(
            prompt_tokens,
            completion_tokens,
            pricing,
            cached_prompt_tokens,
            cache_write_prompt_tokens,
        )
        .total_cost_usd
    }

    pub fn calculate_breakdown(
        &self,
        prompt_tokens: u64,
        completion_tokens: u64,
        pricing: &ModelPricing,
        cached_prompt_tokens: u64,
        cache_write_prompt_tokens: u64,
    ) -> TokenCostBreakdown {
        calculate_token_cost_breakdown(
            prompt_tokens,
            completion_tokens,
            pricing,
            cached_prompt_tokens,
            cache_write_prompt_tokens,
        )
    }

    pub fn list_catalog(&self) -> Vec<PricingCatalogEntry> {
        let mut entries: Vec<PricingCatalogEntry> = self
            .table
            .iter()
            .filter_map(|(key, pricing)| {
                let (prov_raw, model) = key.split_once(':')?;
                let provider = ProviderName::parse(prov_raw)?;
                Some(PricingCatalogEntry {
                    provider,
                    model: model.to_string(),
                    pricing: pricing.clone(),
                })
            })
            .collect();
        entries.sort_by(|a, b| {
            a.provider
                .as_str()
                .cmp(b.provider.as_str())
                .then_with(|| a.model.cmp(&b.model))
        });
        entries
    }
}

/// Computes USD token cost split across uncached input, cached read, cache write, and output
/// buckets, switching to `long_context_*` rates strictly when `prompt_tokens > threshold`.
pub fn calculate_token_cost_breakdown(
    prompt_tokens: u64,
    completion_tokens: u64,
    pricing: &ModelPricing,
    cached_prompt_tokens: u64,
    cache_write_prompt_tokens: u64,
) -> TokenCostBreakdown {
    let use_long_context = pricing
        .long_context_threshold_tokens
        .is_some_and(|threshold| prompt_tokens > threshold);

    let input_per_million = if use_long_context {
        pricing
            .long_context_input_per_million
            .unwrap_or(pricing.input_per_million)
    } else {
        pricing.input_per_million
    };

    let output_per_million = if use_long_context {
        pricing
            .long_context_output_per_million
            .unwrap_or(pricing.output_per_million)
    } else {
        pricing.output_per_million
    };

    let cached_input_per_million = if use_long_context {
        pricing
            .long_context_cached_input_per_million
            .or(pricing.cached_input_per_million)
            .unwrap_or(input_per_million)
    } else {
        pricing
            .cached_input_per_million
            .unwrap_or(input_per_million)
    };

    let cache_write_per_million = pricing
        .cache_write_input_per_million
        .unwrap_or(input_per_million);

    let norm_cached = cached_prompt_tokens.min(prompt_tokens);
    let norm_cache_write = cache_write_prompt_tokens.min(prompt_tokens.saturating_sub(norm_cached));
    let uncached_prompt = prompt_tokens
        .saturating_sub(norm_cached)
        .saturating_sub(norm_cache_write);

    let input_cost = (uncached_prompt as f64 / 1_000_000.0) * input_per_million;
    let cached_cost = (norm_cached as f64 / 1_000_000.0) * cached_input_per_million;
    let cache_write_cost = (norm_cache_write as f64 / 1_000_000.0) * cache_write_per_million;
    let output_cost = (completion_tokens as f64 / 1_000_000.0) * output_per_million;

    TokenCostBreakdown {
        input_cost_usd: input_cost,
        cached_input_cost_usd: cached_cost,
        cache_write_input_cost_usd: cache_write_cost,
        output_cost_usd: output_cost,
        total_cost_usd: input_cost + cached_cost + cache_write_cost + output_cost,
    }
}

/// Formats USD cost for display (`"$0.00"`, 4 decimals under `$0.01`, 2 decimals otherwise).
pub fn format_cost(usd: f64) -> String {
    if usd == 0.0 {
        "$0.00".to_string()
    } else if usd < 0.01 {
        format!("${usd:.4}")
    } else {
        format!("${usd:.2}")
    }
}

/// Formats token counts (`"950"`, `"1.2k"`, `"1.23M"`).
pub fn format_token_count(count: u64) -> String {
    if count < 1_000 {
        count.to_string()
    } else if count < 1_000_000 {
        format!("{:.1}k", count as f64 / 1_000.0)
    } else {
        format!("{:.2}M", count as f64 / 1_000_000.0)
    }
}

fn is_pricing_override_key(key: &str) -> bool {
    let Some((provider, model)) = key.split_once(':') else {
        return false;
    };
    if provider.is_empty() || model.is_empty() {
        return false;
    }
    matches!(
        provider,
        "google"
            | "openai"
            | "anthropic"
            | "baseten"
            | "together"
            | "fireworks"
            | "firepass"
            | "minimax"
            | "opencode-zen"
            | "codex-cli"
    )
}

fn parse_non_neg_f64(val: Option<&Value>) -> Result<Option<f64>, ()> {
    let Some(val) = val else {
        return Ok(None);
    };
    let Some(num) = val.as_f64() else {
        return Err(());
    };
    if !num.is_finite() || num < 0.0 {
        return Err(());
    }
    Ok(Some(num))
}

fn parse_pricing_overrides_from_env(
    env: &HashMap<String, String>,
) -> HashMap<String, ModelPricing> {
    let mut out = HashMap::new();
    let Some(raw) = env
        .get("COWORK_MODEL_PRICING_OVERRIDES")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return out;
    };

    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return out;
    };

    for (key, value) in map {
        if !is_pricing_override_key(&key) {
            continue;
        }
        let Some(obj) = value.as_object() else {
            continue;
        };
        let Ok(Some(input_per_million)) = parse_non_neg_f64(obj.get("inputPerMillion")) else {
            continue;
        };
        let Ok(Some(output_per_million)) = parse_non_neg_f64(obj.get("outputPerMillion")) else {
            continue;
        };
        let Ok(cached_input_per_million) = parse_non_neg_f64(obj.get("cachedInputPerMillion"))
        else {
            continue;
        };
        let Ok(cache_write_input_per_million) =
            parse_non_neg_f64(obj.get("cacheWriteInputPerMillion"))
        else {
            continue;
        };
        let long_context_threshold_tokens = match obj.get("longContextThresholdTokens") {
            None => None,
            Some(v) => match v.as_u64() {
                Some(n) => Some(n),
                None => continue,
            },
        };
        let Ok(long_context_input_per_million) =
            parse_non_neg_f64(obj.get("longContextInputPerMillion"))
        else {
            continue;
        };
        let Ok(long_context_output_per_million) =
            parse_non_neg_f64(obj.get("longContextOutputPerMillion"))
        else {
            continue;
        };
        let Ok(long_context_cached_input_per_million) =
            parse_non_neg_f64(obj.get("longContextCachedInputPerMillion"))
        else {
            continue;
        };

        out.insert(
            key,
            ModelPricing {
                input_per_million,
                output_per_million,
                cached_input_per_million,
                cache_write_input_per_million,
                long_context_threshold_tokens,
                long_context_input_per_million,
                long_context_output_per_million,
                long_context_cached_input_per_million,
            },
        );
    }

    out
}

fn build_base_pricing_table() -> HashMap<String, ModelPricing> {
    let mut t = HashMap::new();
    let mut put = |k: &str, p: ModelPricing| {
        t.insert(k.to_string(), p);
    };

    // Fireworks & Firepass (`src/providers/fireworksShared.ts`)
    put(
        "fireworks:accounts/fireworks/models/deepseek-v4-pro",
        ModelPricing::with_cache(1.74, 3.48, Some(0.15), None),
    );
    put(
        "fireworks:accounts/fireworks/models/kimi-k2p6",
        ModelPricing::with_cache(0.95, 4.0, Some(0.16), None),
    );
    put(
        "fireworks:accounts/fireworks/models/glm-5p1",
        ModelPricing::with_cache(1.4, 4.4, Some(0.26), None),
    );
    put(
        "fireworks:accounts/fireworks/models/qwen3p6-plus",
        ModelPricing::with_cache(0.5, 3.0, Some(0.1), None),
    );
    put(
        "fireworks:accounts/fireworks/models/minimax-m2p7",
        ModelPricing::with_cache(0.3, 1.2, Some(0.06), None),
    );
    put(
        "firepass:accounts/fireworks/routers/kimi-k2p6-turbo",
        ModelPricing::with_cache(0.95, 4.0, Some(0.16), None),
    );

    // OpenCode Zen (`src/providers/opencodeShared.ts`; opencode-go intentionally excluded)
    for (model_id, inp, outp, cread, cwrite) in [
        ("claude-opus-4-8", 5.0, 25.0, 0.5, 6.25),
        ("claude-opus-4-7", 5.0, 25.0, 0.5, 6.25),
        ("claude-opus-4-6", 5.0, 25.0, 0.5, 6.25),
        ("claude-opus-4-5", 5.0, 25.0, 0.5, 6.25),
        ("claude-opus-4-1", 15.0, 75.0, 1.5, 18.75),
        ("claude-sonnet-4-6", 3.0, 15.0, 0.3, 3.75),
        ("claude-sonnet-4-5", 3.0, 15.0, 0.3, 3.75),
        ("claude-sonnet-4", 3.0, 15.0, 0.3, 3.75),
        ("claude-haiku-4-5", 1.0, 5.0, 0.1, 1.25),
        ("gemini-3.5-flash", 1.5, 9.0, 0.15, 0.0),
        ("gemini-3.1-pro", 2.0, 12.0, 0.2, 0.0),
        ("gemini-3-flash", 0.5, 3.0, 0.05, 0.0),
        ("gpt-5.5", 5.0, 30.0, 0.5, 0.0),
        ("gpt-5.5-pro", 30.0, 180.0, 30.0, 0.0),
        ("gpt-5.4", 2.5, 15.0, 0.25, 0.0),
        ("gpt-5.4-pro", 30.0, 180.0, 30.0, 0.0),
        ("gpt-5.4-mini", 0.75, 4.5, 0.075, 0.0),
        ("gpt-5.4-nano", 0.2, 1.25, 0.02, 0.0),
        ("gpt-5.3-codex-spark", 1.75, 14.0, 0.175, 0.0),
        ("gpt-5.3-codex", 1.75, 14.0, 0.175, 0.0),
        ("gpt-5.2", 1.75, 14.0, 0.175, 0.0),
        ("gpt-5.2-codex", 1.75, 14.0, 0.175, 0.0),
        ("gpt-5.1", 1.07, 8.5, 0.107, 0.0),
        ("gpt-5.1-codex-max", 1.25, 10.0, 0.125, 0.0),
        ("gpt-5.1-codex", 1.07, 8.5, 0.107, 0.0),
        ("gpt-5.1-codex-mini", 0.25, 2.0, 0.025, 0.0),
        ("gpt-5", 1.07, 8.5, 0.107, 0.0),
        ("gpt-5-codex", 1.07, 8.5, 0.107, 0.0),
        ("gpt-5-nano", 0.05, 0.4, 0.005, 0.0),
        ("grok-build-0.1", 1.0, 2.0, 0.2, 0.0),
        ("deepseek-v4-flash", 0.14, 0.28, 0.03, 0.0),
        ("glm-5.1", 1.4, 4.4, 0.26, 0.0),
        ("glm-5", 1.0, 3.2, 0.2, 0.0),
        ("minimax-m2.7", 0.3, 1.2, 0.06, 0.0),
        ("minimax-m2.5", 0.3, 1.2, 0.06, 0.0),
        ("kimi-k2.6", 0.95, 4.0, 0.16, 0.0),
        ("kimi-k2.5", 0.6, 3.0, 0.08, 0.0),
        ("qwen3.6-plus", 0.5, 3.0, 0.05, 0.625),
        ("qwen3.5-plus", 0.2, 1.2, 0.02, 0.25),
        ("big-pickle", 0.0, 0.0, 0.0, 0.0),
        ("deepseek-v4-flash-free", 0.0, 0.0, 0.0, 0.0),
        ("mimo-v2.5-free", 0.0, 0.0, 0.0, 0.0),
        ("qwen3.6-plus-free", 0.0, 0.0, 0.0, 0.0),
        ("minimax-m3-free", 0.0, 0.0, 0.0, 0.0),
        ("nemotron-3-ultra-free", 0.0, 0.0, 0.0, 0.0),
        ("north-mini-code-free", 0.0, 0.0, 0.0, 0.0),
    ] {
        put(
            &format!("opencode-zen:{model_id}"),
            ModelPricing::with_cache(inp, outp, Some(cread), Some(cwrite)),
        );
    }

    // Anthropic
    for opus in ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"] {
        put(
            &format!("anthropic:{opus}"),
            ModelPricing::with_cache(5.0, 25.0, Some(0.5), Some(6.25)),
        );
    }
    for sonnet in ["claude-sonnet-4-6", "claude-sonnet-4-5"] {
        put(
            &format!("anthropic:{sonnet}"),
            ModelPricing::with_cache(3.0, 15.0, Some(0.3), Some(3.75)),
        );
    }
    put(
        "anthropic:claude-haiku-4-5",
        ModelPricing::with_cache(1.0, 5.0, Some(0.1), Some(1.25)),
    );

    // Baseten
    put(
        "baseten:moonshotai/Kimi-K2.5",
        ModelPricing::with_cache(0.6, 3.0, Some(0.12), None),
    );
    put(
        "baseten:zai-org/GLM-5",
        ModelPricing::with_cache(0.95, 3.15, Some(0.2), None),
    );
    put(
        "baseten:nvidia/Nemotron-120B-A12B",
        ModelPricing::with_cache(0.3, 0.75, Some(0.06), None),
    );

    // Together AI
    put(
        "together:moonshotai/Kimi-K2.5",
        ModelPricing::standard(0.5, 2.8),
    );
    put(
        "together:Qwen/Qwen3.5-397B-A17B",
        ModelPricing::standard(0.6, 3.6),
    );
    put("together:zai-org/GLM-5", ModelPricing::standard(1.0, 3.2));

    // MiniMax
    put(
        "minimax:MiniMax-M3",
        ModelPricing::with_long_context(
            0.6,
            2.4,
            Some(0.12),
            None,
            512_000,
            Some(1.2),
            Some(4.8),
            Some(0.24),
        ),
    );

    // OpenAI
    put(
        "openai:gpt-5.5",
        ModelPricing::with_long_context(
            5.0,
            30.0,
            Some(0.5),
            None,
            272_000,
            Some(10.0),
            Some(45.0),
            Some(1.0),
        ),
    );
    put(
        "openai:gpt-5.4",
        ModelPricing::with_long_context(
            2.5,
            15.0,
            Some(0.25),
            None,
            272_000,
            Some(5.0),
            Some(22.5),
            Some(0.5),
        ),
    );
    put(
        "openai:gpt-5.4-mini",
        ModelPricing::with_cache(0.75, 4.5, Some(0.075), None),
    );
    put(
        "openai:gpt-5.4-nano",
        ModelPricing::with_cache(0.2, 1.25, Some(0.02), None),
    );
    put(
        "openai:gpt-5.4-pro",
        ModelPricing::with_long_context(
            30.0,
            180.0,
            None,
            None,
            272_000,
            Some(60.0),
            Some(270.0),
            None,
        ),
    );
    put(
        "openai:gpt-5.2",
        ModelPricing::with_cache(1.75, 14.0, Some(0.175), None),
    );
    put("openai:gpt-5.2-pro", ModelPricing::standard(21.0, 168.0));
    put(
        "openai:gpt-5-mini",
        ModelPricing::with_cache(0.25, 2.0, Some(0.025), None),
    );

    // Codex CLI
    put(
        "codex-cli:gpt-5.6-sol",
        ModelPricing::with_cache(5.0, 30.0, Some(0.5), Some(6.25)),
    );
    put(
        "codex-cli:gpt-5.6-terra",
        ModelPricing::with_cache(2.5, 15.0, Some(0.25), Some(3.125)),
    );
    put(
        "codex-cli:gpt-5.6-luna",
        ModelPricing::with_cache(1.0, 6.0, Some(0.1), Some(1.25)),
    );
    put(
        "codex-cli:gpt-5.5",
        ModelPricing::with_long_context(
            5.0,
            30.0,
            Some(0.5),
            None,
            272_000,
            Some(10.0),
            Some(45.0),
            Some(1.0),
        ),
    );
    put(
        "codex-cli:gpt-5.4",
        ModelPricing::with_long_context(
            2.5,
            15.0,
            Some(0.25),
            None,
            272_000,
            Some(5.0),
            Some(22.5),
            Some(0.5),
        ),
    );
    put(
        "codex-cli:gpt-5.4-mini",
        ModelPricing::with_cache(0.75, 4.5, Some(0.075), None),
    );
    put(
        "codex-cli:gpt-5.3-codex",
        ModelPricing::with_cache(1.75, 14.0, Some(0.175), None),
    );
    put(
        "codex-cli:gpt-5.3-codex-spark",
        ModelPricing::with_cache(1.75, 14.0, Some(0.175), None),
    );

    // Google
    for pro in [
        "gemini-3.1-pro-preview-customtools",
        "gemini-3.1-pro-preview",
    ] {
        put(
            &format!("google:{pro}"),
            ModelPricing::with_long_context(
                2.0,
                12.0,
                Some(0.2),
                None,
                200_000,
                Some(4.0),
                Some(18.0),
                Some(0.4),
            ),
        );
    }
    put(
        "google:gemini-3-flash-preview",
        ModelPricing::with_cache(0.5, 3.0, Some(0.05), None),
    );
    put(
        "google:gemini-3.1-flash-lite-preview",
        ModelPricing::with_cache(0.25, 1.5, Some(0.025), None),
    );
    put(
        "google:gemini-3.1-flash-lite",
        ModelPricing::with_cache(0.25, 1.5, Some(0.025), None),
    );
    put(
        "google:gemini-3.5-flash",
        ModelPricing::with_cache(1.5, 9.0, Some(0.15), None),
    );

    t
}
