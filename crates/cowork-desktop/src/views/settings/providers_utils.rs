//! Sorting, status, and formatting helpers for Providers (`providersPageUtils.ts`).

use serde_json::Value;

use crate::state::{ProviderModelSummary, ProviderStatusSummary, ProviderSummary};
use crate::views::settings::primitives::StatusTone;

const BUILT_IN_PROVIDER_PRIORITY: &[&str] = &[
    "anthropic",
    "claude-cli",
    "openai",
    "codex-cli",
    "openai-codex",
    "google",
    "openrouter",
    "bedrock",
    "azure",
    "ollama",
    "lmstudio",
];

/// Returns the sort rank for a provider id (lower appears first when connection status ties).
pub fn provider_priority_rank(id: &str) -> usize {
    let lower = id.trim().to_ascii_lowercase();
    BUILT_IN_PROVIDER_PRIORITY
        .iter()
        .position(|candidate| *candidate == lower)
        .unwrap_or(BUILT_IN_PROVIDER_PRIORITY.len())
}

/// Computes badge label and tone for a provider summary + runtime status snapshot.
pub fn provider_status_badge(
    summary: &ProviderSummary,
    status: Option<&ProviderStatusSummary>,
) -> (&'static str, StatusTone) {
    if let Some(st) = status {
        if st.healthy || st.connected {
            return ("Connected", StatusTone::Success);
        }
        if st.detail.as_deref().is_some_and(|d| !d.trim().is_empty()) && summary.configured {
            return ("Needs attention", StatusTone::Warning);
        }
    }
    if summary.configured {
        ("Configured", StatusTone::Neutral)
    } else {
        ("Not configured", StatusTone::Neutral)
    }
}

/// Human-friendly label for a provider auth method identifier.
pub fn format_auth_method_label(method: &str) -> String {
    match method.trim().to_ascii_lowercase().as_str() {
        "api_key" | "apikey" => "API key".to_string(),
        "oauth" => "OAuth sign-in".to_string(),
        "oauth_callback" | "oauth-callback" => "OAuth callback".to_string(),
        "device_code" | "device-code" => "Device code".to_string(),
        "cli" | "codex_cli" => "CLI session".to_string(),
        "aws_profile" | "iam" => "AWS credentials".to_string(),
        "local" | "none" => "Local server".to_string(),
        "" => "Default".to_string(),
        other => other.replace(['_', '-'], " "),
    }
}

/// Filters and sorts providers with connected/configured providers first, then built-in order.
pub fn sort_and_filter_providers<'a>(
    providers: &'a [ProviderSummary],
    statuses: &[ProviderStatusSummary],
    query: &str,
) -> Vec<&'a ProviderSummary> {
    let needle = query.trim().to_ascii_lowercase();
    let mut matches: Vec<&ProviderSummary> = providers
        .iter()
        .filter(|p| {
            if needle.is_empty() {
                return true;
            }
            p.id.to_ascii_lowercase().contains(&needle)
                || p.name.to_ascii_lowercase().contains(&needle)
                || p.models.iter().any(|m| {
                    m.id.to_ascii_lowercase().contains(&needle)
                        || m.name.to_ascii_lowercase().contains(&needle)
                })
        })
        .collect();

    matches.sort_by(|a, b| {
        let a_conn = statuses
            .iter()
            .find(|s| s.provider == a.id)
            .is_some_and(|s| s.healthy || s.connected);
        let b_conn = statuses
            .iter()
            .find(|s| s.provider == b.id)
            .is_some_and(|s| s.healthy || s.connected);

        b_conn
            .cmp(&a_conn)
            .then_with(|| b.configured.cmp(&a.configured))
            .then_with(|| provider_priority_rank(&a.id).cmp(&provider_priority_rank(&b.id)))
            .then_with(|| a.name.cmp(&b.name))
    });
    matches
}

/// Extracts a concise single-line summary from optional rate-limit JSON metadata.
pub fn extract_rate_limit_hint(rate_limits: Option<&Value>) -> Option<String> {
    let val = rate_limits?;
    if let Some(msg) = val.get("summary").and_then(Value::as_str)
        && !msg.trim().is_empty()
    {
        return Some(msg.trim().to_string());
    }
    let remaining = val
        .get("remainingRequests")
        .or_else(|| val.get("remaining"))
        .and_then(Value::as_u64);
    let limit = val
        .get("limitRequests")
        .or_else(|| val.get("limit"))
        .and_then(Value::as_u64);
    match (remaining, limit) {
        (Some(rem), Some(lim)) => Some(format!("{rem} / {lim} requests remaining")),
        (Some(rem), None) => Some(format!("{rem} requests remaining")),
        _ => None,
    }
}

/// Formats a display label for a provider model, falling back cleanly to `id`.
pub fn model_display_name(model: &ProviderModelSummary) -> &str {
    if model.name.trim().is_empty() {
        model.id.as_str()
    } else {
        model.name.as_str()
    }
}
