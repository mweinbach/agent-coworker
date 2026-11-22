//! Usage settings page (`apps/desktop/src/ui/settings/pages/UsagePage.tsx`).

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};

use rune::{El, col, memo, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Kit, SegmentedControl};

use crate::state::{AppState, ThreadRecord, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    EmptyState, EntityIconSize, Section, SettingsRow, StatusTone, callout_banner, entity_icon,
    settings_page, stat_tile, status_pill, theme_memo_sig,
};
use crate::views::settings::shell::PageContent;
use crate::views::settings::state::UsageViewTab;

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

struct ProviderUsageAcc {
    provider: String,
    sessions: usize,
    models: BTreeSet<String>,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    estimated_cost_usd: f64,
}

impl ProviderUsageAcc {
    fn new(provider: String, sessions: usize) -> Self {
        Self {
            provider,
            sessions,
            models: BTreeSet::new(),
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            estimated_cost_usd: 0.0,
        }
    }

    fn into_bucket(self) -> ProviderUsageBucket {
        ProviderUsageBucket {
            provider: self.provider,
            sessions: self.sessions,
            models: self.models.into_iter().collect(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cached_tokens: self.cached_tokens,
            estimated_cost_usd: self.estimated_cost_usd,
        }
    }
}

/// Aggregates token counts and estimated costs across loaded thread runtimes, falling
/// back to `s.usage_summary` when per-thread usage records have not been hydrated yet.
pub fn aggregate_usage(s: &AppState) -> AggregateUsage {
    let threads_by_id: HashMap<&str, &ThreadRecord> =
        s.threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut by_provider: BTreeMap<String, ProviderUsageAcc> = BTreeMap::new();
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
        let thread = threads_by_id.get(thread_id.as_str()).copied();
        let fallback_provider = thread
            .and_then(|t| t.provider.as_deref())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("Unknown");
        let fallback_model = thread
            .and_then(|t| t.model.as_deref())
            .map(str::trim)
            .filter(|m| !m.is_empty());

        any_thread_usage = true;
        total_sessions += 1;
        total_input = total_input.saturating_add(usage.input_tokens);
        total_output = total_output.saturating_add(usage.output_tokens);
        total_cached = total_cached.saturating_add(usage.cached_tokens);
        if usage.estimated_cost_usd.is_finite() {
            total_cost += usage.estimated_cost_usd;
        }

        if !usage.by_model.is_empty() {
            let mut seen_providers_in_thread: BTreeSet<&str> = BTreeSet::new();
            for entry in usage.by_model.values() {
                let provider_ref = {
                    let trimmed = entry.provider.trim();
                    if trimmed.is_empty() {
                        fallback_provider
                    } else {
                        trimmed
                    }
                };
                let bucket = if let Some(existing) = by_provider.get_mut(provider_ref) {
                    existing
                } else {
                    by_provider
                        .entry(provider_ref.to_string())
                        .or_insert_with(|| ProviderUsageAcc::new(provider_ref.to_string(), 0))
                };
                if seen_providers_in_thread.insert(provider_ref) {
                    bucket.sessions += 1;
                }
                let model_trimmed = entry.model.trim();
                if !model_trimmed.is_empty() && !bucket.models.contains(model_trimmed) {
                    bucket.models.insert(model_trimmed.to_string());
                }
                bucket.input_tokens = bucket.input_tokens.saturating_add(entry.input_tokens);
                bucket.output_tokens = bucket.output_tokens.saturating_add(entry.output_tokens);
                bucket.cached_tokens = bucket.cached_tokens.saturating_add(entry.cached_tokens);
                if entry.estimated_cost_usd.is_finite() {
                    bucket.estimated_cost_usd += entry.estimated_cost_usd;
                }
            }
        } else {
            let bucket = if let Some(existing) = by_provider.get_mut(fallback_provider) {
                existing
            } else {
                by_provider
                    .entry(fallback_provider.to_string())
                    .or_insert_with(|| ProviderUsageAcc::new(fallback_provider.to_string(), 0))
            };
            bucket.sessions += 1;
            if let Some(model) = fallback_model
                && !bucket.models.contains(model)
            {
                bucket.models.insert(model.to_string());
            }
            bucket.input_tokens = bucket.input_tokens.saturating_add(usage.input_tokens);
            bucket.output_tokens = bucket.output_tokens.saturating_add(usage.output_tokens);
            bucket.cached_tokens = bucket.cached_tokens.saturating_add(usage.cached_tokens);
            if usage.estimated_cost_usd.is_finite() {
                bucket.estimated_cost_usd += usage.estimated_cost_usd;
            }
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
        let mut summary_by_provider: BTreeMap<String, ProviderUsageAcc> = BTreeMap::new();
        for entry in summary.by_model.values() {
            let provider_ref = {
                let trimmed = entry.provider.trim();
                if trimmed.is_empty() {
                    "Unknown"
                } else {
                    trimmed
                }
            };
            let bucket = if let Some(existing) = summary_by_provider.get_mut(provider_ref) {
                existing
            } else {
                summary_by_provider
                    .entry(provider_ref.to_string())
                    .or_insert_with(|| ProviderUsageAcc::new(provider_ref.to_string(), 1))
            };
            let model_trimmed = entry.model.trim();
            if !model_trimmed.is_empty() && !bucket.models.contains(model_trimmed) {
                bucket.models.insert(model_trimmed.to_string());
            }
            bucket.input_tokens = bucket.input_tokens.saturating_add(entry.input_tokens);
            bucket.output_tokens = bucket.output_tokens.saturating_add(entry.output_tokens);
            bucket.cached_tokens = bucket.cached_tokens.saturating_add(entry.cached_tokens);
            if entry.estimated_cost_usd.is_finite() {
                bucket.estimated_cost_usd += entry.estimated_cost_usd;
            }
        }
        let mut summary_providers: Vec<ProviderUsageBucket> = summary_by_provider
            .into_values()
            .map(ProviderUsageAcc::into_bucket)
            .collect();
        summary_providers.sort_by(|a, b| {
            b.estimated_cost_usd
                .total_cmp(&a.estimated_cost_usd)
                .then_with(|| a.provider.cmp(&b.provider))
        });
        return AggregateUsage {
            has_usage: has_summary_data,
            total_cost_usd: has_summary_data.then_some(total_cost),
            total_input_tokens: total_input,
            total_output_tokens: total_output,
            total_cached_tokens: total_cached,
            total_sessions: if has_summary_data { 1 } else { 0 },
            providers: summary_providers,
        };
    }

    let mut providers: Vec<ProviderUsageBucket> = by_provider
        .into_values()
        .map(ProviderUsageAcc::into_bucket)
        .collect();
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

fn usage_page_memo_version(s: &AppState, t: &ThemeTokens) -> u64 {
    let mut h = DefaultHasher::new();
    let tab_idx: u8 = match s.settings_ui.usage_tab {
        UsageViewTab::Overview => 0,
        UsageViewTab::Sessions => 1,
        UsageViewTab::Models => 2,
        UsageViewTab::Workspaces => 3,
    };
    (
        theme_memo_sig(s, t),
        tab_idx,
        s.workspaces_rev,
        s.workspaces.len(),
        s.threads_rev,
        s.threads.len(),
    )
        .hash(&mut h);
    if s.workspaces_rev == 0 {
        for ws in &s.workspaces {
            (
                ws.id.as_str(),
                ws.name.as_str(),
                ws.path.as_str(),
                ws.archived,
                ws.one_off_chat,
            )
                .hash(&mut h);
        }
    }
    if s.threads_rev == 0 {
        for th in &s.threads {
            (
                th.id.as_str(),
                th.workspace_id.as_str(),
                th.title.as_str(),
                th.provider.as_deref(),
                th.model.as_deref(),
                th.updated_at,
            )
                .hash(&mut h);
        }
    }
    // Order-independent hash across `thread_runtime_by_id` HashMap entries.
    let mut rt_acc = 0u64;
    let mut rt_count = 0usize;
    for (tid, rt) in &s.thread_runtime_by_id {
        if rt.usage.is_none() && rt.last_turn_usage.is_none() {
            continue;
        }
        rt_count += 1;
        let mut eh = DefaultHasher::new();
        tid.hash(&mut eh);
        if let Some(u) = &rt.usage {
            (
                u.input_tokens,
                u.output_tokens,
                u.cached_tokens,
                u.estimated_cost_usd.to_bits(),
                u.by_model.len(),
            )
                .hash(&mut eh);
            let mut bm_acc = 0u64;
            for (mk, mv) in &u.by_model {
                let mut mh = DefaultHasher::new();
                (
                    mk.as_str(),
                    mv.provider.as_str(),
                    mv.model.as_str(),
                    mv.turns,
                    mv.input_tokens,
                    mv.output_tokens,
                    mv.cached_tokens,
                    mv.estimated_cost_usd.to_bits(),
                )
                    .hash(&mut mh);
                bm_acc = bm_acc.wrapping_add(mh.finish());
            }
            bm_acc.hash(&mut eh);
        }
        if let Some(last) = &rt.last_turn_usage {
            (
                last.input_tokens,
                last.output_tokens,
                last.estimated_cost_usd.to_bits(),
            )
                .hash(&mut eh);
        }
        rt_acc = rt_acc.wrapping_add(eh.finish());
    }
    (rt_count, rt_acc).hash(&mut h);
    if let Some(summary) = &s.usage_summary {
        (
            summary.input_tokens,
            summary.output_tokens,
            summary.cached_tokens,
            summary.estimated_cost_usd.to_bits(),
            summary.by_model.len(),
        )
            .hash(&mut h);
        let mut sm_acc = 0u64;
        for (mk, mv) in &summary.by_model {
            let mut mh = DefaultHasher::new();
            (
                mk.as_str(),
                mv.provider.as_str(),
                mv.model.as_str(),
                mv.turns,
                mv.input_tokens,
                mv.output_tokens,
                mv.cached_tokens,
                mv.estimated_cost_usd.to_bits(),
            )
                .hash(&mut mh);
            sm_acc = sm_acc.wrapping_add(mh.finish());
        }
        sm_acc.hash(&mut h);
    }
    h.finish()
}

/// Renders the Usage settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let info_btn = Button::new("How estimates work")
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Regular)
        .on_press(|s: &mut AppState| {
            s.settings_ui.usage_estimates_dialog_open = true;
        })
        .build(k);

    let mut overlays = Vec::new();
    if s.settings_ui.usage_estimates_dialog_open {
        Dialog::new("usage-estimates-dialog", "How usage estimates work")
            .open(true)
            .width(460.0)
            .fit()
            .on_close(|s: &mut AppState| {
                s.settings_ui.usage_estimates_dialog_open = false;
            })
            .child(
                col()
                    .w_full()
                    .min_w(0.0)
                    .px(16.0)
                    .pb(16.0)
                    .gap(12.0)
                    .child(
                        text("Estimated cost is computed locally from provider-reported input, output, and cached prompt tokens multiplied by Cowork's model pricing catalog.")
                            .font(k.ty.ui)
                            .color(t.text_muted)
                            .wrap(),
                    )
                    .child(
                        text("Actual invoices may differ based on provider discounts, subscription tiers, cached-read pricing, or custom endpoints.")
                            .font(k.ty.ui)
                            .color(t.text_muted)
                            .wrap(),
                    )
                    .child(
                        row().w_full().justify_end().child(
                            Button::new("Close")
                                .variant(ButtonVariant::Contrast)
                                .control_size(ControlSize::Regular)
                                .on_press(|s: &mut AppState| {
                                    s.settings_ui.usage_estimates_dialog_open = false;
                                })
                                .build(k),
                        ),
                    ),
            )
            .build(k, &mut overlays);
    }

    let version = usage_page_memo_version(s, t);
    let body = memo("settings-usage-body", version, || {
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
            let active_ws_count = s.workspaces.iter().filter(|w| !w.archived).count();
            format!(
                "Across {active_ws_count} workspace{}",
                if active_ws_count == 1 { "" } else { "s" }
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

        let active_tab_idx = match s.settings_ui.usage_tab {
            UsageViewTab::Overview => 0,
            UsageViewTab::Sessions => 1,
            UsageViewTab::Models => 2,
            UsageViewTab::Workspaces => 3,
        };
        let tabs_control = SegmentedControl::new(
            &["Overview", "Sessions", "Models", "Workspaces"],
            Some(active_tab_idx),
        )
        .label("Usage breakdown view")
        .fit()
        .on_pick(|s: &mut AppState, idx, _tx| {
            s.settings_ui.usage_tab = match idx {
                1 => UsageViewTab::Sessions,
                2 => UsageViewTab::Models,
                3 => UsageViewTab::Workspaces,
                _ => UsageViewTab::Overview,
            };
        })
        .build(k);

        let breakdown_el: El = match s.settings_ui.usage_tab {
            UsageViewTab::Models => build_models_section(s, &agg, k, t),
            UsageViewTab::Sessions => build_sessions_section(s, k, t),
            UsageViewTab::Workspaces => build_workspaces_section(s, k, t),
            UsageViewTab::Overview => build_overview_section(s, &agg, k, t),
        };

        settings_page(vec![
            overview_grid,
            estimate_notice,
            row().w_full().child(tabs_control),
            breakdown_el,
        ])
    });

    PageContent::simple(body)
        .with_header_actions(vec![info_btn])
        .with_overlays(overlays)
}

fn build_overview_section(s: &AppState, agg: &AggregateUsage, k: &Kit, t: &ThemeTokens) -> El {
    if !agg.has_usage {
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
                                    .font(k.ty.ui_medium)
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
    }
}

/// Aggregated usage row for a single `(provider, model)` pair across tracked sessions.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelUsageRow {
    pub model: String,
    pub provider: String,
    pub turns: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub estimated_cost_usd: f64,
}

/// Aggregates per-model usage across all tracked thread runtimes, falling back to
/// `s.usage_summary.by_model` only when no thread runtime has recorded usage yet.
pub fn aggregate_model_usage(s: &AppState, agg: &AggregateUsage) -> Vec<ModelUsageRow> {
    let threads_by_id: HashMap<&str, &ThreadRecord> =
        s.threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut rows: Vec<ModelUsageRow> = Vec::new();
    let mut row_index: HashMap<(&str, &str), usize> = HashMap::new();

    #[allow(clippy::too_many_arguments)]
    fn upsert_row<'a>(
        rows: &mut Vec<ModelUsageRow>,
        row_index: &mut HashMap<(&'a str, &'a str), usize>,
        model: &'a str,
        provider: &'a str,
        turns: usize,
        input: u64,
        output: u64,
        cached: u64,
        cost: f64,
    ) {
        if let Some(&idx) = row_index.get(&(model, provider)) {
            let existing = &mut rows[idx];
            existing.turns += turns;
            existing.input_tokens = existing.input_tokens.saturating_add(input);
            existing.output_tokens = existing.output_tokens.saturating_add(output);
            existing.cached_tokens = existing.cached_tokens.saturating_add(cached);
            if cost.is_finite() {
                existing.estimated_cost_usd += cost;
            }
        } else {
            let idx = rows.len();
            row_index.insert((model, provider), idx);
            rows.push(ModelUsageRow {
                model: model.to_string(),
                provider: provider.to_string(),
                turns,
                input_tokens: input,
                output_tokens: output,
                cached_tokens: cached,
                estimated_cost_usd: if cost.is_finite() { cost } else { 0.0 },
            });
        }
    }

    let mut any_thread_models = false;
    for (thread_id, runtime) in &s.thread_runtime_by_id {
        let Some(usage) = &runtime.usage else {
            continue;
        };
        any_thread_models = true;
        let thread = threads_by_id.get(thread_id.as_str()).copied();
        let fallback_provider = thread
            .and_then(|t| t.provider.as_deref())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("unknown");
        let fallback_model = thread
            .and_then(|t| t.model.as_deref())
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or("default");
        if !usage.by_model.is_empty() {
            for entry in usage.by_model.values() {
                let provider = {
                    let p = entry.provider.trim();
                    if p.is_empty() { fallback_provider } else { p }
                };
                let model = {
                    let m = entry.model.trim();
                    if m.is_empty() { fallback_model } else { m }
                };
                upsert_row(
                    &mut rows,
                    &mut row_index,
                    model,
                    provider,
                    entry.turns.max(1),
                    entry.input_tokens,
                    entry.output_tokens,
                    entry.cached_tokens,
                    entry.estimated_cost_usd,
                );
            }
        } else {
            upsert_row(
                &mut rows,
                &mut row_index,
                fallback_model,
                fallback_provider,
                1,
                usage.input_tokens,
                usage.output_tokens,
                usage.cached_tokens,
                usage.estimated_cost_usd,
            );
        }
    }

    if !any_thread_models
        && agg.has_usage
        && let Some(summary) = &s.usage_summary
        && !summary.by_model.is_empty()
    {
        for entry in summary.by_model.values() {
            upsert_row(
                &mut rows,
                &mut row_index,
                entry.model.as_str(),
                entry.provider.as_str(),
                entry.turns,
                entry.input_tokens,
                entry.output_tokens,
                entry.cached_tokens,
                entry.estimated_cost_usd,
            );
        }
    }

    rows.sort_by(|a, b| {
        b.estimated_cost_usd
            .total_cmp(&a.estimated_cost_usd)
            .then_with(|| a.model.cmp(&b.model))
            .then_with(|| a.provider.cmp(&b.provider))
    });
    rows
}

fn build_models_section(s: &AppState, agg: &AggregateUsage, k: &Kit, t: &ThemeTokens) -> El {
    let rows = aggregate_model_usage(s, agg);

    let mut section = Section::new()
        .title("By model")
        .description("Token consumption and estimated cost across individual models.");
    if rows.is_empty() {
        section = section.child(
            EmptyState::new("No per-model usage recorded")
                .icon(&icons::BAR_CHART_3)
                .description("Run a turn with a model to populate model-level usage totals.")
                .build(k, t),
        );
    } else {
        for ModelUsageRow {
            model,
            provider,
            turns,
            input_tokens: input,
            output_tokens: output,
            cached_tokens: cached,
            estimated_cost_usd: cost,
        } in rows
        {
            let icon_el = entity_icon(s, None, &provider, EntityIconSize::Sm, k, t);
            section = section.child(
                SettingsRow::new(model)
                    .leading(icon_el)
                    .description(format!(
                        "{provider} · {} tokens ({} in · {} out · {} cached) · {turns} turn/session{}",
                        format_token_count(input.saturating_add(output)),
                        format_token_count(input),
                        format_token_count(output),
                        format_token_count(cached),
                        if turns == 1 { "" } else { "s" },
                    ))
                    .control(status_pill(
                        format_estimated_cost(Some(cost)),
                        StatusTone::Neutral,
                        k,
                        t,
                    ))
                    .build(k, t),
            );
        }
    }
    section.build(k, t)
}

fn build_sessions_section(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let mut entries: Vec<_> = s
        .threads
        .iter()
        .filter_map(|thread| {
            let rt = s.thread_runtime_by_id.get(&thread.id)?;
            let usage = rt.usage.as_ref()?;
            let has_data = usage.input_tokens > 0
                || usage.output_tokens > 0
                || usage.cached_tokens > 0
                || usage.estimated_cost_usd > 0.0;
            has_data.then_some((thread, usage, rt.last_turn_usage.as_ref()))
        })
        .collect();
    entries.sort_by(|a, b| {
        b.1.estimated_cost_usd
            .total_cmp(&a.1.estimated_cost_usd)
            .then_with(|| b.0.updated_at.cmp(&a.0.updated_at))
    });

    let mut section = Section::new()
        .title("By session")
        .description("Top active sessions ordered by estimated spend.");
    if entries.is_empty() {
        section = section.child(
            EmptyState::new("No session usage yet")
                .icon(&icons::BAR_CHART_3)
                .description("Session token and cost breakdowns appear as chats run.")
                .build(k, t),
        );
    } else {
        for (thread, usage, last_turn) in entries.into_iter().take(25) {
            let title = if thread.title.trim().is_empty() {
                "Untitled session"
            } else {
                thread.title.trim()
            };
            let model_label = thread
                .model
                .as_deref()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("Default model");
            let mut row_builder = SettingsRow::new(title).description(format!(
                "{model_label} · {} tokens ({} in · {} out · {} cached)",
                format_token_count(usage.input_tokens.saturating_add(usage.output_tokens)),
                format_token_count(usage.input_tokens),
                format_token_count(usage.output_tokens),
                format_token_count(usage.cached_tokens),
            ));
            if let Some(last) = last_turn {
                row_builder = row_builder.meta(format!(
                    "Last turn: {} tokens ({})",
                    format_token_count(last.input_tokens.saturating_add(last.output_tokens)),
                    format_estimated_cost(Some(last.estimated_cost_usd))
                ));
            }
            section = section.child(
                row_builder
                    .control(status_pill(
                        format_estimated_cost(Some(usage.estimated_cost_usd)),
                        StatusTone::Neutral,
                        k,
                        t,
                    ))
                    .build(k, t),
            );
        }
    }
    section.build(k, t)
}

fn build_workspaces_section(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let ws_by_id: HashMap<&str, &WorkspaceRecord> =
        s.workspaces.iter().map(|w| (w.id.as_str(), w)).collect();
    let mut by_ws: BTreeMap<String, (String, usize, u64, u64, f64)> = BTreeMap::new();
    for thread in &s.threads {
        let Some(usage) = s
            .thread_runtime_by_id
            .get(&thread.id)
            .and_then(|rt| rt.usage.as_ref())
        else {
            continue;
        };
        let ws = ws_by_id.get(thread.workspace_id.as_str()).copied();
        let key = if ws.is_some_and(|w| w.one_off_chat) {
            "__chats__"
        } else {
            thread.workspace_id.as_str()
        };
        let entry = if let Some(existing) = by_ws.get_mut(key) {
            existing
        } else {
            let label = match ws {
                Some(w) if w.one_off_chat => "Chats".to_string(),
                Some(w) if !w.name.trim().is_empty() => w.name.clone(),
                Some(w) => w.path.clone(),
                None => thread.workspace_id.clone(),
            };
            by_ws
                .entry(key.to_string())
                .or_insert((label, 0, 0, 0, 0.0))
        };
        entry.1 += 1;
        entry.2 = entry.2.saturating_add(usage.input_tokens);
        entry.3 = entry.3.saturating_add(usage.output_tokens);
        if usage.estimated_cost_usd.is_finite() {
            entry.4 += usage.estimated_cost_usd;
        }
    }
    let mut rows: Vec<_> = by_ws.into_values().collect();
    rows.sort_by(|a, b| b.4.total_cmp(&a.4).then_with(|| a.0.cmp(&b.0)));

    let mut section = Section::new()
        .title("By workspace")
        .description("Aggregated spend and tokens grouped by workspace.");
    if rows.is_empty() {
        section = section.child(
            EmptyState::new("No workspace usage yet")
                .icon(&icons::BAR_CHART_3)
                .description("Workspace totals will appear after sessions record usage.")
                .build(k, t),
        );
    } else {
        for (label, sessions, input, output, cost) in rows {
            section = section.child(
                SettingsRow::new(label)
                    .description(format!(
                        "{sessions} session{} · {} tokens ({} in · {} out)",
                        if sessions == 1 { "" } else { "s" },
                        format_token_count(input.saturating_add(output)),
                        format_token_count(input),
                        format_token_count(output),
                    ))
                    .control(status_pill(
                        format_estimated_cost(Some(cost)),
                        StatusTone::Neutral,
                        k,
                        t,
                    ))
                    .build(k, t),
            );
        }
    }
    section.build(k, t)
}
