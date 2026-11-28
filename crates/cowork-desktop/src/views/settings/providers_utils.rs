//! Sorting, status, and formatting helpers for Providers (`providersPageUtils.ts`).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

use crate::state::{ProviderModelSummary, ProviderStatusSummary, ProviderSummary};
use crate::views::settings::primitives::{StatusTone, contains_ascii_ci};

fn provider_priority_map() -> &'static HashMap<&'static str, usize> {
    static MAP: OnceLock<HashMap<&'static str, usize>> = OnceLock::new();
    MAP.get_or_init(|| {
        cowork_config::provider_specs()
            .iter()
            .enumerate()
            .map(|(idx, spec)| (spec.id.as_str(), idx))
            .collect()
    })
}

/// Returns the sort rank for a provider id from canonical `config/providers.json` order
/// (lower appears first when connection status ties).
pub fn provider_priority_rank(id: &str) -> usize {
    let trimmed = id.trim();
    let map = provider_priority_map();
    if trimmed.bytes().all(|b| !b.is_ascii_uppercase()) {
        map.get(trimmed).copied().unwrap_or(map.len())
    } else {
        let lower = trimmed.to_ascii_lowercase();
        map.get(lower.as_str()).copied().unwrap_or(map.len())
    }
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
        "exa_api_key" => "Exa API key".to_string(),
        "parallel_api_key" => "Parallel API key".to_string(),
        "oauth" | "oauth_cli" => "OAuth sign-in".to_string(),
        "oauth_callback" | "oauth-callback" => "OAuth callback".to_string(),
        "device_code" | "device-code" => "Device code".to_string(),
        "cli" | "codex_cli" => "CLI session".to_string(),
        "aws_default" => "AWS default credentials".to_string(),
        "aws_profile" | "iam" => "AWS profile".to_string(),
        "aws_keys" => "AWS access keys".to_string(),
        "credentials" => "Credentials".to_string(),
        "local" | "none" => "Local server".to_string(),
        "" => "Default".to_string(),
        other => other.replace(['_', '-'], " "),
    }
}

/// Filters and sorts borrowed provider references with connected/configured providers first,
/// then built-in order, avoiding linear status lookups inside the comparator.
pub(crate) fn sort_and_filter_provider_refs<'a>(
    providers: impl IntoIterator<Item = &'a ProviderSummary>,
    status_map: &HashMap<&str, &ProviderStatusSummary>,
    query: &str,
) -> Vec<&'a ProviderSummary> {
    let needle = query.trim().to_ascii_lowercase();
    let mut keyed: Vec<(&'a ProviderSummary, bool, usize)> = providers
        .into_iter()
        .filter(|p| {
            if needle.is_empty() {
                return true;
            }
            contains_ascii_ci(&p.id, &needle)
                || contains_ascii_ci(&p.name, &needle)
                || p.models.iter().any(|m| {
                    contains_ascii_ci(&m.id, &needle) || contains_ascii_ci(&m.name, &needle)
                })
        })
        .map(|p| {
            let conn = status_map
                .get(p.id.as_str())
                .is_some_and(|s| s.healthy || s.connected);
            let rank = provider_priority_rank(&p.id);
            (p, conn, rank)
        })
        .collect();

    keyed.sort_by(|(a, a_conn, a_rank), (b, b_conn, b_rank)| {
        b_conn
            .cmp(a_conn)
            .then_with(|| b.configured.cmp(&a.configured))
            .then_with(|| a_rank.cmp(b_rank))
            .then_with(|| a.name.cmp(&b.name))
    });
    keyed.into_iter().map(|(p, _, _)| p).collect()
}

/// Filters and sorts providers with connected/configured providers first, then built-in order.
pub fn sort_and_filter_providers<'a>(
    providers: &'a [ProviderSummary],
    statuses: &[ProviderStatusSummary],
    query: &str,
) -> Vec<&'a ProviderSummary> {
    let status_map: HashMap<&str, &ProviderStatusSummary> = statuses
        .iter()
        .map(|st| (st.provider.as_str(), st))
        .collect();
    sort_and_filter_provider_refs(providers.iter(), &status_map, query)
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
