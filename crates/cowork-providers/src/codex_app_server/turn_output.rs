//! Per-turn usage and assistant-text bookkeeping for Codex app-server turns
//! (`codexAppServer/config.ts` `parseUsage` and `notifications.ts` `assistantText()` /
//! `assistantTextFromTurn` parity).

use std::collections::HashMap;

use cowork_inference::{TextPhase, TurnUsage};
use serde_json::Value;

/// Accumulation key for `item/agentMessage/delta` notifications without an `itemId`. The pinned
/// app-server always sends one; the legacy router dropped such deltas from the final text, which
/// would silently lose the only text of a turn, so they share one synthetic item instead.
const ANONYMOUS_ITEM_ID: &str = "\u{0}codex-anonymous-agent-message";

fn finite_number(record: Option<&Value>, key: &str) -> Option<u64> {
    let n = record?.get(key)?.as_f64()?;
    n.is_finite().then(|| n.max(0.0) as u64)
}

fn first_number(record: Option<&Value>, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| finite_number(record, key))
}

fn object_field<'a>(record: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| record?.get(*key).filter(|v| v.is_object()))
}

/// Normalizes one Codex `TokenUsageBreakdown` record (camelCase or OpenAI snake_case, with nested
/// `*_details`), exactly as `parseUsage` does for the record it selects.
fn usage_from_breakdown(usage: &Value) -> TurnUsage {
    let usage = Some(usage);
    let input_details = object_field(
        usage,
        &[
            "inputTokensDetails",
            "input_tokens_details",
            "inputDetails",
            "input_details",
        ],
    );
    let output_details = object_field(
        usage,
        &[
            "outputTokensDetails",
            "output_tokens_details",
            "outputDetails",
            "output_details",
        ],
    );
    let prompt_tokens = first_number(usage, &["inputTokens", "input_tokens"]).unwrap_or(0);
    let cached_prompt_tokens = first_number(
        usage,
        &[
            "cachedInputTokens",
            "cached_input_tokens",
            "cacheReadInputTokens",
            "cache_read_input_tokens",
            "inputCachedTokens",
            "input_cached_tokens",
        ],
    )
    .or_else(|| {
        first_number(
            input_details,
            &[
                "cachedTokens",
                "cached_tokens",
                "cacheReadTokens",
                "cache_read_tokens",
            ],
        )
    });
    let cache_write_prompt_tokens = first_number(
        usage,
        &[
            "cacheWriteInputTokens",
            "cache_write_input_tokens",
            "cacheCreationInputTokens",
            "cache_creation_input_tokens",
            "inputCacheWriteTokens",
            "input_cache_write_tokens",
        ],
    )
    .or_else(|| {
        first_number(
            input_details,
            &[
                "cacheWriteTokens",
                "cache_write_tokens",
                "cacheCreationTokens",
                "cache_creation_tokens",
            ],
        )
    });
    let explicit_completion_tokens = first_number(usage, &["outputTokens", "output_tokens"]);
    let reasoning_output_tokens =
        first_number(usage, &["reasoningOutputTokens", "reasoning_output_tokens"])
            .or_else(|| first_number(output_details, &["reasoningTokens", "reasoning_tokens"]));
    let total_tokens = first_number(usage, &["totalTokens", "total_tokens"]).unwrap_or_else(|| {
        prompt_tokens
            + explicit_completion_tokens
                .or(reasoning_output_tokens)
                .unwrap_or(0)
    });
    let completion_tokens = explicit_completion_tokens.unwrap_or_else(|| {
        if total_tokens >= prompt_tokens {
            total_tokens - prompt_tokens
        } else {
            reasoning_output_tokens.unwrap_or(0)
        }
    });
    TurnUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cached_prompt_tokens,
        cache_write_prompt_tokens,
        reasoning_output_tokens,
        estimated_cost_usd: None,
    }
}

fn is_empty_usage(usage: &TurnUsage) -> bool {
    usage.prompt_tokens == 0 && usage.completion_tokens == 0 && usage.total_tokens == 0
}

/// Exact port of `parseUsage`: normalizes a `thread/tokenUsage/updated` `tokenUsage` payload,
/// preferring the `total` breakdown over `last`. Returns `None` when every count is zero.
pub fn parse_codex_usage(token_usage: &Value) -> Option<TurnUsage> {
    let record = token_usage.is_object().then_some(token_usage);
    let usage = object_field(record, &["total"]).or_else(|| object_field(record, &["last"]))?;
    let parsed = usage_from_breakdown(usage);
    (!is_empty_usage(&parsed)).then_some(parsed)
}

fn sub_option(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a.map(|a| a.saturating_sub(b.unwrap_or(0)))
}

fn add_option(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    }
}

fn usage_minus(a: &TurnUsage, b: &TurnUsage) -> TurnUsage {
    TurnUsage {
        prompt_tokens: a.prompt_tokens.saturating_sub(b.prompt_tokens),
        completion_tokens: a.completion_tokens.saturating_sub(b.completion_tokens),
        total_tokens: a.total_tokens.saturating_sub(b.total_tokens),
        cached_prompt_tokens: sub_option(a.cached_prompt_tokens, b.cached_prompt_tokens),
        cache_write_prompt_tokens: sub_option(
            a.cache_write_prompt_tokens,
            b.cache_write_prompt_tokens,
        ),
        reasoning_output_tokens: sub_option(a.reasoning_output_tokens, b.reasoning_output_tokens),
        estimated_cost_usd: None,
    }
}

fn usage_plus(a: &TurnUsage, b: &TurnUsage) -> TurnUsage {
    TurnUsage {
        prompt_tokens: a.prompt_tokens + b.prompt_tokens,
        completion_tokens: a.completion_tokens + b.completion_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
        cached_prompt_tokens: add_option(a.cached_prompt_tokens, b.cached_prompt_tokens),
        cache_write_prompt_tokens: add_option(
            a.cache_write_prompt_tokens,
            b.cache_write_prompt_tokens,
        ),
        reasoning_output_tokens: add_option(a.reasoning_output_tokens, b.reasoning_output_tokens),
        estimated_cost_usd: None,
    }
}

/// Scopes Codex `thread/tokenUsage/updated` reports to the current turn.
///
/// `tokenUsage.total` is the thread's running total (Codex accumulates it across every turn of
/// the thread and re-seeds it from the rollout on `thread/resume`), while `tokenUsage.last` is the
/// single most recent model request. Using `last` undercounts a turn that made several model
/// requests; using `total` (as the legacy runtime did) charges a resumed thread's previous turns
/// again. The turn's usage is therefore `latest.total - (first.total - first.last)`: the running
/// total minus the thread total from before this turn's first request. For a fresh thread that
/// baseline is zero and the result equals `parseUsage`. Repeated reports of an unchanged total
/// cannot double count. Payloads without `total` fall back to summing each report's `last`.
#[derive(Debug, Clone, Default)]
pub struct CodexTurnUsageTracker {
    baseline: Option<TurnUsage>,
    latest_total: Option<TurnUsage>,
    summed_last: Option<TurnUsage>,
}

impl CodexTurnUsageTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one `tokenUsage` payload that belongs to this turn.
    pub fn record(&mut self, token_usage: &Value) {
        let record = token_usage.is_object().then_some(token_usage);
        let last = object_field(record, &["last"]).map(usage_from_breakdown);
        if let Some(total) = object_field(record, &["total"]).map(usage_from_breakdown) {
            if self.baseline.is_none() {
                self.baseline = Some(match &last {
                    Some(last) => usage_minus(&total, last),
                    None => TurnUsage::default(),
                });
            }
            self.latest_total = Some(total);
        } else if let Some(last) = last {
            self.summed_last = Some(match &self.summed_last {
                Some(sum) => usage_plus(sum, &last),
                None => last,
            });
        }
    }

    /// The turn's usage so far, or `None` when nothing non-zero was reported.
    pub fn usage(&self) -> Option<TurnUsage> {
        let usage = match (&self.latest_total, &self.summed_last) {
            (Some(total), _) => usage_minus(total, self.baseline.as_ref().unwrap_or(total)),
            (None, Some(sum)) => sum.clone(),
            (None, None) => return None,
        };
        (!is_empty_usage(&usage)).then_some(usage)
    }
}

/// Assistant `agentMessage` items of one Codex turn, keyed by item id in first-seen order, with
/// the `phase` each item reported (`notifications.ts` `textByItemId` / `phaseByItemId`).
#[derive(Debug, Clone, Default)]
pub struct CodexAssistantItems {
    order: Vec<String>,
    text_by_id: HashMap<String, String>,
    phase_by_id: HashMap<String, String>,
}

impl CodexAssistantItems {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers an item (no-op when known) and returns its stable stream block index.
    pub fn ensure(&mut self, id: Option<&str>, initial_text: &str) -> usize {
        let id = id.filter(|id| !id.is_empty()).unwrap_or(ANONYMOUS_ITEM_ID);
        if let Some(index) = self.order.iter().position(|known| known == id) {
            return index;
        }
        self.order.push(id.to_owned());
        self.text_by_id
            .insert(id.to_owned(), initial_text.to_owned());
        self.order.len() - 1
    }

    fn id_at(&self, index: usize) -> &str {
        &self.order[index]
    }

    /// Records the item's phase when `phase` is non-empty and returns the effective (reported or
    /// previously remembered) phase.
    pub fn remember_phase(&mut self, index: usize, phase: Option<&str>) -> Option<String> {
        let id = self.id_at(index).to_owned();
        if let Some(phase) = phase.filter(|p| !p.trim().is_empty()) {
            self.phase_by_id.insert(id.clone(), phase.to_owned());
        }
        self.phase_by_id.get(&id).cloned()
    }

    pub fn append(&mut self, index: usize, delta: &str) {
        let id = self.id_at(index).to_owned();
        self.text_by_id.entry(id).or_default().push_str(delta);
    }

    /// Replaces the accumulated text with the item's completed text (ignored when empty).
    pub fn set_text(&mut self, index: usize, text: &str) {
        if text.is_empty() {
            return;
        }
        let id = self.id_at(index).to_owned();
        self.text_by_id.insert(id, text.to_owned());
    }

    pub fn text(&self, index: usize) -> &str {
        self.text_by_id
            .get(self.id_at(index))
            .map(String::as_str)
            .unwrap_or("")
    }

    pub fn phase(&self, index: usize) -> Option<&str> {
        self.phase_by_id.get(self.id_at(index)).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// `assistantText()`: non-commentary items, each trimmed, empty ones dropped, joined by `\n`.
    pub fn assistant_text(&self) -> String {
        self.order
            .iter()
            .filter(|id| self.phase_by_id.get(*id).map(String::as_str) != Some("commentary"))
            .filter_map(|id| self.text_by_id.get(id))
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// `assistantTextFromTurn`: the non-commentary `agentMessage` items of a completed turn payload,
/// empty ones dropped, joined by `\n`.
pub fn assistant_text_from_codex_turn(turn: &Value) -> String {
    turn.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                .filter(|item| {
                    item.get("phase")
                        .and_then(Value::as_str)
                        .filter(|p| !p.is_empty())
                        != Some("commentary")
                })
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The stream/persistence phase for a Codex `agentMessage` phase string.
pub fn codex_text_phase(phase: Option<&str>) -> Option<TextPhase> {
    phase.and_then(TextPhase::from_wire)
}
