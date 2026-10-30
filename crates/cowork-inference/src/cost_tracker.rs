use chrono::Utc;
use cowork_config::ProviderName;
use serde::{Deserialize, Serialize};

use crate::error::InferenceError;
use crate::pricing::{
    ModelPricing, PricingEngine, TokenCostBreakdown, calculate_token_cost_breakdown, format_cost,
};

const MAX_TURNS: usize = 512;
pub const COMPACT_SNAPSHOT_TURNS_LIMIT: usize = 8;

/// Per-step or per-turn token usage totals (`src/session/costTracker.ts` parity).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,
}

/// Session/turn USD cost breakdown including unattributed (`otherCostUsd`) costs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCostBreakdown {
    pub input_cost_usd: f64,
    pub cached_input_cost_usd: f64,
    pub cache_write_input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub other_cost_usd: f64,
}

impl UsageCostBreakdown {
    fn from_token_breakdown(b: TokenCostBreakdown) -> Self {
        Self {
            input_cost_usd: b.input_cost_usd,
            cached_input_cost_usd: b.cached_input_cost_usd,
            cache_write_input_cost_usd: b.cache_write_input_cost_usd,
            output_cost_usd: b.output_cost_usd,
            other_cost_usd: 0.0,
        }
    }

    fn from_unattributed(cost_usd: f64) -> Self {
        Self {
            other_cost_usd: cost_usd,
            ..Self::default()
        }
    }

    fn add(self, rhs: Self) -> Self {
        Self {
            input_cost_usd: self.input_cost_usd + rhs.input_cost_usd,
            cached_input_cost_usd: self.cached_input_cost_usd + rhs.cached_input_cost_usd,
            cache_write_input_cost_usd: self.cache_write_input_cost_usd
                + rhs.cache_write_input_cost_usd,
            output_cost_usd: self.output_cost_usd + rhs.output_cost_usd,
            other_cost_usd: self.other_cost_usd + rhs.other_cost_usd,
        }
    }

    fn sum(self) -> f64 {
        self.input_cost_usd
            + self.cached_input_cost_usd
            + self.cache_write_input_cost_usd
            + self.output_cost_usd
            + self.other_cost_usd
    }
}

/// Recorded per-turn cost entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCostEntry {
    pub turn_id: String,
    pub turn_index: usize,
    pub timestamp: String,
    pub provider: ProviderName,
    pub model: String,
    pub usage: TurnUsage,
    pub estimated_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_breakdown: Option<UsageCostBreakdown>,
    pub pricing: Option<ModelPricing>,
}

/// Cumulative usage summary for a single `(provider, model)` pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageSummary {
    pub provider: ProviderName,
    pub model: String,
    pub turns: usize,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cached_prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cache_write_prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_reasoning_output_tokens: Option<u64>,
    pub estimated_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_breakdown: Option<UsageCostBreakdown>,
}

/// Soft (`warnAtUsd`) and hard (`stopAtUsd`) session USD budget thresholds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetThresholds {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warn_at_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_at_usd: Option<f64>,
}

/// Partial update to budget thresholds (`None` = unchanged, `Some(None)` = clear, `Some(Some(x))` = set).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BudgetThresholdUpdate {
    pub warn_at_usd: Option<Option<f64>>,
    pub stop_at_usd: Option<Option<f64>>,
}

/// Exported budget evaluation status.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub configured: bool,
    pub warn_at_usd: Option<f64>,
    pub stop_at_usd: Option<f64>,
    pub warning_triggered: bool,
    pub stop_triggered: bool,
    pub current_cost_usd: Option<f64>,
}

/// Full or compact session usage snapshot persisted in SQLite and projected over JSON-RPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageSnapshot {
    pub session_id: String,
    pub total_turns: usize,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cached_prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cache_write_prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_reasoning_output_tokens: Option<u64>,
    pub estimated_total_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_breakdown: Option<UsageCostBreakdown>,
    pub cost_tracking_available: bool,
    pub by_model: Vec<ModelUsageSummary>,
    pub turns: Vec<TurnCostEntry>,
    pub budget_status: BudgetStatus,
    pub created_at: String,
    pub updated_at: String,
}

/// Events emitted by `SessionCostTracker` on turn recording and threshold crossings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CostTrackerEvent {
    TurnRecorded {
        entry: Box<TurnCostEntry>,
        cumulative: Box<SessionUsageSnapshot>,
    },
    UsageChanged {
        cumulative: Box<SessionUsageSnapshot>,
    },
    BudgetWarning {
        #[serde(rename = "currentCostUsd")]
        current_cost_usd: f64,
        #[serde(rename = "thresholdUsd")]
        threshold_usd: f64,
        message: String,
    },
    BudgetExceeded {
        #[serde(rename = "currentCostUsd")]
        current_cost_usd: f64,
        #[serde(rename = "thresholdUsd")]
        threshold_usd: f64,
        message: String,
    },
}

type ListenerFn = Box<dyn Fn(&CostTrackerEvent) + Send + Sync>;

/// Session-level token & USD cost accumulator enforcing `warnAtUsd` and `stopAtUsd`.
pub struct SessionCostTracker {
    session_id: String,
    turns: Vec<TurnCostEntry>,
    model_order: Vec<String>,
    model_summaries: std::collections::HashMap<String, ModelUsageSummary>,
    listeners: Vec<ListenerFn>,
    lifetime_turn_count: usize,
    total_prompt_tokens: u64,
    total_completion_tokens: u64,
    total_tokens: u64,
    total_cached_prompt_tokens: u64,
    total_cache_write_prompt_tokens: u64,
    total_reasoning_output_tokens: u64,
    estimated_total_cost_usd: Option<f64>,
    cost_breakdown: Option<UsageCostBreakdown>,
    cost_tracking_available: bool,
    has_unknown_cost_turns: bool,
    budget_thresholds: BudgetThresholds,
    warning_triggered: bool,
    stop_triggered: bool,
    created_at: String,
    updated_at: String,
}

impl SessionCostTracker {
    pub fn new(session_id: impl Into<String>, budget: Option<BudgetThresholds>) -> Self {
        let now = Utc::now().to_rfc3339();
        let thresholds = budget.unwrap_or_default();
        Self {
            session_id: session_id.into(),
            turns: Vec::new(),
            model_order: Vec::new(),
            model_summaries: std::collections::HashMap::new(),
            listeners: Vec::new(),
            lifetime_turn_count: 0,
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_tokens: 0,
            total_cached_prompt_tokens: 0,
            total_cache_write_prompt_tokens: 0,
            total_reasoning_output_tokens: 0,
            estimated_total_cost_usd: None,
            cost_breakdown: Some(UsageCostBreakdown::default()),
            cost_tracking_available: false,
            has_unknown_cost_turns: false,
            budget_thresholds: thresholds,
            warning_triggered: false,
            stop_triggered: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn from_snapshot(snapshot: SessionUsageSnapshot) -> Self {
        let mut tracker = Self::new(
            snapshot.session_id.clone(),
            Some(BudgetThresholds {
                warn_at_usd: snapshot.budget_status.warn_at_usd,
                stop_at_usd: snapshot.budget_status.stop_at_usd,
            }),
        );
        tracker.turns = snapshot.turns.clone();
        for summary in &snapshot.by_model {
            let key = format!("{}:{}", summary.provider.as_str(), summary.model);
            tracker.model_order.push(key.clone());
            tracker.model_summaries.insert(key, summary.clone());
        }
        tracker.lifetime_turn_count = snapshot.total_turns.max(snapshot.turns.len());
        tracker.total_prompt_tokens = snapshot.total_prompt_tokens;
        tracker.total_completion_tokens = snapshot.total_completion_tokens;
        tracker.total_tokens = snapshot.total_tokens;
        tracker.total_cached_prompt_tokens =
            snapshot.total_cached_prompt_tokens.unwrap_or_else(|| {
                snapshot
                    .turns
                    .iter()
                    .map(|t| t.usage.cached_prompt_tokens.unwrap_or(0))
                    .sum()
            });
        tracker.total_cache_write_prompt_tokens =
            snapshot.total_cache_write_prompt_tokens.unwrap_or_else(|| {
                snapshot
                    .turns
                    .iter()
                    .map(|t| t.usage.cache_write_prompt_tokens.unwrap_or(0))
                    .sum()
            });
        tracker.total_reasoning_output_tokens =
            snapshot.total_reasoning_output_tokens.unwrap_or_else(|| {
                snapshot
                    .turns
                    .iter()
                    .map(|t| t.usage.reasoning_output_tokens.unwrap_or(0))
                    .sum()
            });

        tracker.has_unknown_cost_turns = (tracker.lifetime_turn_count > 0
            && snapshot.estimated_total_cost_usd.is_none())
            || snapshot
                .by_model
                .iter()
                .any(|s| s.estimated_cost_usd.is_none())
            || snapshot
                .turns
                .iter()
                .any(|t| t.estimated_cost_usd.is_none());

        tracker.estimated_total_cost_usd = if tracker.has_unknown_cost_turns {
            None
        } else {
            snapshot.estimated_total_cost_usd
        };
        tracker.cost_breakdown = if tracker.has_unknown_cost_turns {
            None
        } else {
            snapshot.cost_breakdown.or_else(|| {
                snapshot
                    .estimated_total_cost_usd
                    .map(UsageCostBreakdown::from_unattributed)
            })
        };
        tracker.cost_tracking_available = !tracker.has_unknown_cost_turns
            && snapshot.cost_tracking_available
            && snapshot.estimated_total_cost_usd.is_some();
        tracker.warning_triggered = snapshot.budget_status.warning_triggered;
        tracker.stop_triggered = snapshot.budget_status.stop_triggered;
        tracker.created_at = snapshot.created_at;
        tracker.updated_at = snapshot.updated_at;
        tracker
    }

    pub fn add_listener<F>(&mut self, listener: F)
    where
        F: Fn(&CostTrackerEvent) + Send + Sync + 'static,
    {
        self.listeners.push(Box::new(listener));
    }

    /// Records a turn using the process environment's `PricingEngine`.
    pub fn record_turn(
        &mut self,
        turn_id: impl Into<String>,
        provider: ProviderName,
        model: impl Into<String>,
        usage: TurnUsage,
        request_usages: Option<Option<&[TurnUsage]>>,
    ) -> TurnCostEntry {
        let engine = PricingEngine::from_process_env();
        self.record_turn_with_engine(turn_id, provider, model, usage, request_usages, &engine)
    }

    /// Records a turn using an injected `PricingEngine` (deterministic for tests and isolated envs).
    pub fn record_turn_with_engine(
        &mut self,
        turn_id: impl Into<String>,
        provider: ProviderName,
        model: impl Into<String>,
        usage: TurnUsage,
        request_usages: Option<Option<&[TurnUsage]>>,
        engine: &PricingEngine,
    ) -> TurnCostEntry {
        let turn_id = turn_id.into();
        let model = model.into();
        let pricing = engine.resolve(provider, &model);
        let (cost_usd, cost_breakdown) =
            calculate_turn_usage_cost(&usage, pricing.as_ref(), request_usages);

        let now = Utc::now().to_rfc3339();
        let entry = TurnCostEntry {
            turn_id,
            turn_index: self.lifetime_turn_count,
            timestamp: now.clone(),
            provider,
            model: model.clone(),
            usage: usage.clone(),
            estimated_cost_usd: cost_usd,
            cost_breakdown,
            pricing,
        };

        self.turns.push(entry.clone());
        self.lifetime_turn_count += 1;

        self.total_prompt_tokens += usage.prompt_tokens;
        self.total_completion_tokens += usage.completion_tokens;
        self.total_tokens += usage.total_tokens;
        self.total_cached_prompt_tokens += usage.cached_prompt_tokens.unwrap_or(0);
        self.total_cache_write_prompt_tokens += usage.cache_write_prompt_tokens.unwrap_or(0);
        self.total_reasoning_output_tokens += usage.reasoning_output_tokens.unwrap_or(0);

        self.record_session_cost(cost_usd, cost_breakdown);
        self.update_model_summary(provider, &model, &usage, cost_usd, cost_breakdown);

        if self.turns.len() > MAX_TURNS {
            let drain_count = self.turns.len() - MAX_TURNS;
            self.turns.drain(0..drain_count);
        }

        self.updated_at = now;
        let cumulative = self.get_snapshot();
        self.emit(&CostTrackerEvent::TurnRecorded {
            entry: Box::new(entry.clone()),
            cumulative: Box::new(cumulative),
        });
        self.check_budget();

        entry
    }

    pub fn record_unattributed_cost(&mut self, usd_cost: f64) -> Result<(), InferenceError> {
        if !usd_cost.is_finite() || usd_cost < 0.0 {
            return Err(InferenceError::InvalidBudget(
                "Unattributed cost must be a finite non-negative number.".to_string(),
            ));
        }
        if usd_cost == 0.0 {
            return Ok(());
        }
        self.record_session_cost(
            Some(usd_cost),
            Some(UsageCostBreakdown::from_unattributed(usd_cost)),
        );
        self.updated_at = Utc::now().to_rfc3339();
        self.check_budget();
        let cumulative = self.get_snapshot();
        self.emit(&CostTrackerEvent::UsageChanged {
            cumulative: Box::new(cumulative),
        });
        Ok(())
    }

    pub fn set_budget(&mut self, thresholds: BudgetThresholds) -> Result<(), InferenceError> {
        validate_budget_thresholds(thresholds)?;
        self.budget_thresholds = thresholds;
        self.warning_triggered = match (thresholds.warn_at_usd, self.estimated_total_cost_usd) {
            (Some(warn), Some(cost)) => cost >= warn,
            _ => false,
        };
        self.stop_triggered = match (thresholds.stop_at_usd, self.estimated_total_cost_usd) {
            (Some(stop), Some(cost)) => cost >= stop,
            _ => false,
        };
        self.updated_at = Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn update_budget(&mut self, update: BudgetThresholdUpdate) -> Result<(), InferenceError> {
        let next_warn = match update.warn_at_usd {
            None => self.budget_thresholds.warn_at_usd,
            Some(val) => val,
        };
        let next_stop = match update.stop_at_usd {
            None => self.budget_thresholds.stop_at_usd,
            Some(val) => val,
        };
        self.set_budget(BudgetThresholds {
            warn_at_usd: next_warn,
            stop_at_usd: next_stop,
        })
    }

    pub fn get_budget_status(&self) -> BudgetStatus {
        BudgetStatus {
            configured: self.budget_thresholds.warn_at_usd.is_some()
                || self.budget_thresholds.stop_at_usd.is_some(),
            warn_at_usd: self.budget_thresholds.warn_at_usd,
            stop_at_usd: self.budget_thresholds.stop_at_usd,
            warning_triggered: self.warning_triggered,
            stop_triggered: self.stop_triggered,
            current_cost_usd: self.estimated_total_cost_usd,
        }
    }

    pub fn is_budget_exceeded(&self) -> bool {
        self.stop_triggered
    }

    pub fn get_snapshot(&self) -> SessionUsageSnapshot {
        self.build_snapshot(None)
    }

    pub fn get_compact_snapshot(&self, turns_limit: Option<usize>) -> SessionUsageSnapshot {
        self.build_snapshot(Some(turns_limit.unwrap_or(COMPACT_SNAPSHOT_TURNS_LIMIT)))
    }

    fn build_snapshot(&self, turns_limit: Option<usize>) -> SessionUsageSnapshot {
        let turns = match turns_limit {
            None => self.turns.clone(),
            Some(0) => Vec::new(),
            Some(limit) => {
                let start = self.turns.len().saturating_sub(limit);
                self.turns[start..].to_vec()
            }
        };

        let by_model: Vec<ModelUsageSummary> = self
            .model_order
            .iter()
            .filter_map(|k| self.model_summaries.get(k).cloned())
            .collect();

        SessionUsageSnapshot {
            session_id: self.session_id.clone(),
            total_turns: self.lifetime_turn_count,
            total_prompt_tokens: self.total_prompt_tokens,
            total_completion_tokens: self.total_completion_tokens,
            total_tokens: self.total_tokens,
            total_cached_prompt_tokens: (self.total_cached_prompt_tokens > 0)
                .then_some(self.total_cached_prompt_tokens),
            total_cache_write_prompt_tokens: (self.total_cache_write_prompt_tokens > 0)
                .then_some(self.total_cache_write_prompt_tokens),
            total_reasoning_output_tokens: (self.total_reasoning_output_tokens > 0)
                .then_some(self.total_reasoning_output_tokens),
            estimated_total_cost_usd: self.estimated_total_cost_usd,
            cost_breakdown: self.cost_breakdown,
            cost_tracking_available: self.cost_tracking_available,
            by_model,
            turns,
            budget_status: self.get_budget_status(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn record_session_cost(
        &mut self,
        cost_usd: Option<f64>,
        cost_breakdown: Option<UsageCostBreakdown>,
    ) {
        let Some(cost_usd) = cost_usd else {
            self.has_unknown_cost_turns = true;
            self.cost_tracking_available = false;
            self.estimated_total_cost_usd = None;
            self.cost_breakdown = None;
            return;
        };

        if self.has_unknown_cost_turns {
            self.cost_tracking_available = false;
            self.estimated_total_cost_usd = None;
            self.cost_breakdown = None;
            return;
        }

        self.cost_tracking_available = true;
        self.estimated_total_cost_usd =
            Some(self.estimated_total_cost_usd.unwrap_or(0.0) + cost_usd);
        self.cost_breakdown = match (self.cost_breakdown, cost_breakdown) {
            (Some(cur), Some(next)) => Some(cur.add(next)),
            _ => None,
        };
    }

    fn update_model_summary(
        &mut self,
        provider: ProviderName,
        model: &str,
        usage: &TurnUsage,
        cost_usd: Option<f64>,
        cost_breakdown: Option<UsageCostBreakdown>,
    ) {
        let key = format!("{}:{model}", provider.as_str());
        if let Some(existing) = self.model_summaries.get_mut(&key) {
            existing.turns += 1;
            existing.total_prompt_tokens += usage.prompt_tokens;
            existing.total_completion_tokens += usage.completion_tokens;
            existing.total_tokens += usage.total_tokens;
            let cached = usage.cached_prompt_tokens.unwrap_or(0);
            if existing.total_cached_prompt_tokens.is_some() || cached > 0 {
                existing.total_cached_prompt_tokens =
                    Some(existing.total_cached_prompt_tokens.unwrap_or(0) + cached);
            }
            let cwrite = usage.cache_write_prompt_tokens.unwrap_or(0);
            if existing.total_cache_write_prompt_tokens.is_some() || cwrite > 0 {
                existing.total_cache_write_prompt_tokens =
                    Some(existing.total_cache_write_prompt_tokens.unwrap_or(0) + cwrite);
            }
            let reasoning = usage.reasoning_output_tokens.unwrap_or(0);
            if existing.total_reasoning_output_tokens.is_some() || reasoning > 0 {
                existing.total_reasoning_output_tokens =
                    Some(existing.total_reasoning_output_tokens.unwrap_or(0) + reasoning);
            }
            match (existing.estimated_cost_usd, cost_usd) {
                (Some(prev), Some(cur)) => {
                    existing.estimated_cost_usd = Some(prev + cur);
                    existing.cost_breakdown = match (existing.cost_breakdown, cost_breakdown) {
                        (Some(b1), Some(b2)) => Some(b1.add(b2)),
                        _ => None,
                    };
                }
                _ => {
                    existing.estimated_cost_usd = None;
                    existing.cost_breakdown = None;
                }
            }
        } else {
            self.model_order.push(key.clone());
            self.model_summaries.insert(
                key,
                ModelUsageSummary {
                    provider,
                    model: model.to_string(),
                    turns: 1,
                    total_prompt_tokens: usage.prompt_tokens,
                    total_completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                    total_cached_prompt_tokens: usage.cached_prompt_tokens.filter(|&v| v > 0),
                    total_cache_write_prompt_tokens: usage
                        .cache_write_prompt_tokens
                        .filter(|&v| v > 0),
                    total_reasoning_output_tokens: usage.reasoning_output_tokens.filter(|&v| v > 0),
                    estimated_cost_usd: cost_usd,
                    cost_breakdown,
                },
            );
        }
    }

    fn check_budget(&mut self) {
        let Some(current_cost) = self.estimated_total_cost_usd else {
            return;
        };

        if let Some(warn_at) = self.budget_thresholds.warn_at_usd
            && !self.warning_triggered
            && current_cost >= warn_at
        {
            self.warning_triggered = true;
            let message = format!(
                "⚠️  Budget warning: session cost {} has reached the warning threshold of {}.",
                format_cost(current_cost),
                format_cost(warn_at)
            );
            self.emit(&CostTrackerEvent::BudgetWarning {
                current_cost_usd: current_cost,
                threshold_usd: warn_at,
                message,
            });
        }

        if let Some(stop_at) = self.budget_thresholds.stop_at_usd
            && !self.stop_triggered
            && current_cost >= stop_at
        {
            self.stop_triggered = true;
            let message = format!(
                "🛑 Budget exceeded: session cost {} has exceeded the hard cap of {}. No further turns will be processed.",
                format_cost(current_cost),
                format_cost(stop_at)
            );
            self.emit(&CostTrackerEvent::BudgetExceeded {
                current_cost_usd: current_cost,
                threshold_usd: stop_at,
                message,
            });
        }
    }

    fn emit(&self, event: &CostTrackerEvent) {
        for listener in &self.listeners {
            listener(event);
        }
    }
}

fn validate_budget_thresholds(thresholds: BudgetThresholds) -> Result<(), InferenceError> {
    if let Some(w) = thresholds.warn_at_usd
        && (!w.is_finite() || w < 0.0)
    {
        return Err(InferenceError::InvalidBudget(
            "Warning threshold must be a finite non-negative number.".to_string(),
        ));
    }
    if let Some(s) = thresholds.stop_at_usd
        && (!s.is_finite() || s < 0.0)
    {
        return Err(InferenceError::InvalidBudget(
            "Hard-stop threshold must be a finite non-negative number.".to_string(),
        ));
    }
    if let (Some(warn), Some(stop)) = (thresholds.warn_at_usd, thresholds.stop_at_usd)
        && warn >= stop
    {
        return Err(InferenceError::InvalidBudget(
            "Warning threshold must be less than the hard-stop threshold.".to_string(),
        ));
    }
    Ok(())
}

fn has_matching_token_usage(usage: &TurnUsage, requests: &[TurnUsage]) -> bool {
    let sum_prompt: u64 = requests.iter().map(|r| r.prompt_tokens).sum();
    let sum_comp: u64 = requests.iter().map(|r| r.completion_tokens).sum();
    let sum_tot: u64 = requests.iter().map(|r| r.total_tokens).sum();
    let sum_cached: u64 = requests
        .iter()
        .map(|r| r.cached_prompt_tokens.unwrap_or(0))
        .sum();
    let sum_cwrite: u64 = requests
        .iter()
        .map(|r| r.cache_write_prompt_tokens.unwrap_or(0))
        .sum();
    let sum_reason: u64 = requests
        .iter()
        .map(|r| r.reasoning_output_tokens.unwrap_or(0))
        .sum();

    sum_prompt == usage.prompt_tokens
        && sum_comp == usage.completion_tokens
        && sum_tot == usage.total_tokens
        && sum_cached == usage.cached_prompt_tokens.unwrap_or(0)
        && sum_cwrite == usage.cache_write_prompt_tokens.unwrap_or(0)
        && sum_reason == usage.reasoning_output_tokens.unwrap_or(0)
}

fn calculate_turn_usage_cost(
    usage: &TurnUsage,
    pricing: Option<&ModelPricing>,
    request_usages: Option<Option<&[TurnUsage]>>,
) -> (Option<f64>, Option<UsageCostBreakdown>) {
    let single_slice = std::slice::from_ref(usage);
    let resolved_requests: Option<&[TurnUsage]> = match request_usages {
        None => Some(single_slice),
        Some(Some(reqs)) if !reqs.is_empty() && has_matching_token_usage(usage, reqs) => Some(reqs),
        Some(_) => None,
    };

    if resolved_requests.is_none()
        && let Some(p) = pricing
        && let Some(threshold) = p.long_context_threshold_tokens
        && usage.prompt_tokens > threshold
    {
        return (None, None);
    }

    let mut cost_usd = 0.0;
    let mut breakdown = UsageCostBreakdown::default();
    for req in resolved_requests.unwrap_or(single_slice) {
        if let Some(p) = pricing {
            let b = calculate_token_cost_breakdown(
                req.prompt_tokens,
                req.completion_tokens,
                p,
                req.cached_prompt_tokens.unwrap_or(0),
                req.cache_write_prompt_tokens.unwrap_or(0),
            );
            cost_usd += b.total_cost_usd;
            breakdown = breakdown.add(UsageCostBreakdown::from_token_breakdown(b));
        } else if let Some(est) = req.estimated_cost_usd.filter(|v| v.is_finite()) {
            cost_usd += est;
            breakdown = breakdown.add(UsageCostBreakdown::from_unattributed(est));
        } else {
            return (None, None);
        }
    }

    let delta = cost_usd - breakdown.sum();
    if delta.abs() >= 1e-6 {
        if delta < 0.0 {
            breakdown = UsageCostBreakdown::from_unattributed(cost_usd);
        } else {
            breakdown.other_cost_usd += delta;
        }
    }

    (Some(cost_usd), Some(breakdown))
}
