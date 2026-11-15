//! Usage settings page (`apps/desktop/src/ui/settings/pages/UsagePage.tsx`).

use std::collections::BTreeMap;

use rune::{El, row, text};
use rune_kit::Kit;

use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    EmptyState, EntityIconSize, Section, SettingsRow, StatusTone, callout_banner, entity_icon,
    settings_page, stat_tile, status_pill,
};
use crate::views::settings::shell::PageContent;

/// Formats large token counts compactly (`842`, `12.4K`, `3.2M`, `1.1B`).
pub fn format_token_count(tokens: u64) -> String {
    if tokens >= 1_000_000_000 {
        format!("{:.1}B", tokens as f64 / 1_000_000_000.0)
    } else if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 10_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else if tokens >= 1_000 {
        format!("{:.2}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

/// Formats estimated USD cost (`$0.0042` below `$0.01`, `$1.23` otherwise, `"—"` if absent).
pub fn format_estimated_cost(cost: Option<f64>) -> String {
    match cost {
        Some(v) if v.is_finite() && v > 0.0 => {
            if v < 0.01 {
                format!("${v:.4}")
            } else {
                format!("${v:.2}")
            }
        }
        Some(0.0) => "$0.00".to_string(),
        _ => "—".to_string(),
    }
}

/// Aggregated usage bucket for a single provider across active threads.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderUsageBucket {
    pub provider: String,
    pub sessions: usize,
    pub models: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub estimated_cost_usd: f64,
}

impl ProviderUsageBucket {
    /// Combined input + output tokens for this provider.
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }
}

/// Full usage aggregation computed across `AppState.thread_runtime_by_id` and `AppState.usage_summary`.
#[derive(Clone, Debug, PartialEq)]
pub struct AggregateUsage {
    pub has_usage: bool,
    pub total_cost_usd: Option<f64>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cached_tokens: u64,
    pub total_sessions: usize,
    pub providers: Vec<ProviderUsageBucket>,
}

impl AggregateUsage {
    /// Combined total prompt + completion tokens.
    pub fn total_tokens(&self) -> u64 {
        self.total_input_tokens
            .saturating_add(self.total_output_tokens)
    }

    /// Count of distinct model IDs observed across all providers.
    pub fn total_models(&self) -> usize {
        self.providers.iter().map(|p| p.models.len()).sum()
    }
}

/// Aggregates token counts and estimated costs across loaded thread runtimes, falling
/// back to `s.usage_summary` when per-thread usage records have not been hydrated yet.
pub fn aggregate_usage(s: &AppState) -> AggregateUsage {
    let mut by_provider: BTreeMap<String, ProviderUsageBucket> = BTreeMap::new();
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cached: u64 = 0;
    let mut total_cost: f64 = 0.0;
    let mut any_thread_usage = false;
    let mut total_sessions: usize = 0;

    for (thread_id, runtime) in &s.thread_runtime_by_id {
        let Some(usage) = &runtime.usage else {
            continue;
        };
        let thread = s.threads.iter().find(|t| t.id == *thread_id);
        let provider_name = thread
            .and_then(|t| t.provider.as_deref())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("Unknown")
            .to_string();
        let model_name = thread
            .and_then(|t| t.model.as_deref())
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string);

        any_thread_usage = true;
        total_sessions += 1;
        total_input = total_input.saturating_add(usage.input_tokens);
        total_output = total_output.saturating_add(usage.output_tokens);
        total_cached = total_cached.saturating_add(usage.cached_tokens);
        if usage.estimated_cost_usd.is_finite() {
            total_cost += usage.estimated_cost_usd;
        }

        let bucket =
            by_provider
                .entry(provider_name.clone())
                .or_insert_with(|| ProviderUsageBucket {
                    provider: provider_name,
                    sessions: 0,
                    models: Vec::new(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cached_tokens: 0,
                    estimated_cost_usd: 0.0,
                });
        bucket.sessions += 1;
        if let Some(model) = model_name
            && !bucket.models.contains(&model)
        {
            bucket.models.push(model);
        }
        bucket.input_tokens = bucket.input_tokens.saturating_add(usage.input_tokens);
        bucket.output_tokens = bucket.output_tokens.saturating_add(usage.output_tokens);
        bucket.cached_tokens = bucket.cached_tokens.saturating_add(usage.cached_tokens);
        if usage.estimated_cost_usd.is_finite() {
            bucket.estimated_cost_usd += usage.estimated_cost_usd;
        }
    }

    if !any_thread_usage && let Some(summary) = &s.usage_summary {
        total_input = summary.input_tokens;
        total_output = summary.output_tokens;
        total_cached = summary.cached_tokens;
        total_cost = summary.estimated_cost_usd;
        let has_summary_data = total_input > 0
            || total_output > 0
            || total_cached > 0
            || summary.estimated_cost_usd > 0.0;
        return AggregateUsage {
            has_usage: has_summary_data,
            total_cost_usd: has_summary_data.then_some(total_cost),
            total_input_tokens: total_input,
            total_output_tokens: total_output,
            total_cached_tokens: total_cached,
            total_sessions: if has_summary_data { 1 } else { 0 },
            providers: Vec::new(),
        };
    }

    let mut providers: Vec<ProviderUsageBucket> = by_provider.into_values().collect();
    providers.sort_by(|a, b| {
        b.estimated_cost_usd
            .total_cmp(&a.estimated_cost_usd)
            .then_with(|| a.provider.cmp(&b.provider))
    });

    AggregateUsage {
        has_usage: any_thread_usage,
        total_cost_usd: any_thread_usage.then_some(total_cost),
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cached_tokens: total_cached,
        total_sessions,
        providers,
    }
}

/// Renders the Usage settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let agg = aggregate_usage(s);
    let total_tokens = agg.total_tokens();

    let cost_tile = stat_tile(
        "Estimated total cost",
        if agg.has_usage {
            format_estimated_cost(agg.total_cost_usd)
        } else {
            "—".to_string()
        },
        Some(if agg.has_usage {
            "Based on local pricing data"
        } else {
            "No usage recorded yet"
        }),
        k,
        t,
    );

    let token_hint = if agg.has_usage {
        if agg.total_cached_tokens > 0 {
            format!(
                "{} in · {} out · {} cached",
                format_token_count(agg.total_input_tokens),
                format_token_count(agg.total_output_tokens),
                format_token_count(agg.total_cached_tokens),
            )
        } else {
            format!(
                "{} in · {} out",
                format_token_count(agg.total_input_tokens),
                format_token_count(agg.total_output_tokens),
            )
        }
    } else {
        "No usage recorded yet".to_string()
    };
    let tokens_tile = stat_tile(
        "Total tokens",
        if agg.has_usage {
            format_token_count(total_tokens)
        } else {
            "0".to_string()
        },
        Some(token_hint.as_str()),
        k,
        t,
    );

    let session_hint = if agg.has_usage {
        format!(
            "Across {} workspace{}",
            s.workspaces.iter().filter(|w| !w.archived).count(),
            if s.workspaces.iter().filter(|w| !w.archived).count() == 1 {
                ""
            } else {
                "s"
            }
        )
    } else {
        "No sessions yet".to_string()
    };
    let sessions_tile = stat_tile(
        "Tracked sessions",
        agg.total_sessions.to_string(),
        Some(session_hint.as_str()),
        k,
        t,
    );

    let model_count = agg.total_models();
    let provider_hint = if agg.providers.is_empty() {
        "No models used yet".to_string()
    } else {
        format!(
            "{model_count} model{} observed",
            if model_count == 1 { "" } else { "s" }
        )
    };
    let providers_tile = stat_tile(
        "Providers",
        agg.providers.len().to_string(),
        Some(provider_hint.as_str()),
        k,
        t,
    );

    let overview_grid = row()
        .w_full()
        .gap(12.0)
        .child(cost_tile)
        .child(tokens_tile)
        .child(sessions_tile)
        .child(providers_tile);

    let estimate_notice = callout_banner(
        StatusTone::Neutral,
        "Numbers are estimates based on provider-reported token usage and Cowork's local pricing catalog. Billing and cached-token discounts vary by provider.",
        k,
        t,
    );

    let breakdown_el: El = if !agg.has_usage {
        Section::new()
            .title("By provider")
            .description("Aggregated token and cost totals per provider.")
            .child(
                EmptyState::new("No usage data recorded yet")
                    .icon(&icons::BAR_CHART_3)
                    .description("Usage will appear here as you use models across sessions.")
                    .build(k, t),
            )
            .build(k, t)
    } else if agg.providers.is_empty() {
        Section::new()
            .title("Session totals")
            .description("Aggregate counts reported across active server state.")
            .child(
                SettingsRow::new("Total tokens")
                    .description(format!(
                        "{} input · {} output · {} cached",
                        format_token_count(agg.total_input_tokens),
                        format_token_count(agg.total_output_tokens),
                        format_token_count(agg.total_cached_tokens),
                    ))
                    .control(status_pill(
                        format_estimated_cost(agg.total_cost_usd),
                        StatusTone::Neutral,
                        k,
                        t,
                    ))
                    .build(k, t),
            )
            .build(k, t)
    } else {
        let mut section = Section::new()
            .title("By provider")
            .description("Aggregated token and cost totals per provider and model.");
        for group in &agg.providers {
            let icon_el = entity_icon(s, None, &group.provider, EntityIconSize::Sm, k, t);
            let models_summary = if group.models.is_empty() {
                "No model breakdown reported".to_string()
            } else {
                group.models.join(", ")
            };
            let detail = format!(
                "{} tokens ({} in · {} out · {} cached) · {} session{}",
                format_token_count(group.total_tokens()),
                format_token_count(group.input_tokens),
                format_token_count(group.output_tokens),
                format_token_count(group.cached_tokens),
                group.sessions,
                if group.sessions == 1 { "" } else { "s" }
            );
            section = section.child(
                SettingsRow::new(group.provider.clone())
                    .leading(icon_el)
                    .description(detail)
                    .meta(models_summary)
                    .control(
                        row()
                            .gap(8.0)
                            .child(
                                text(format_estimated_cost(Some(group.estimated_cost_usd)))
                                    .font(k.ty.body_medium)
                                    .color(t.text_base),
                            )
                            .child(status_pill(
                                format!(
                                    "{} model{}",
                                    group.models.len(),
                                    if group.models.len() == 1 { "" } else { "s" }
                                ),
                                StatusTone::Neutral,
                                k,
                                t,
                            )),
                    )
                    .build(k, t),
            );
        }
        section.build(k, t)
    };

    PageContent::simple(settings_page(vec![
        overview_grid,
        estimate_notice,
        breakdown_el,
    ]))
}
