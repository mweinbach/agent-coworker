//! Regression: a multi-step turn records usage once per provider step under the same turn id.
//! The steps must fold into one logical turn (`turnUsageAggregator.ts` parity) so
//! `totalTurns`, per-model `turns`, and the turn history are not inflated, while the budget
//! is still charged after every step.

use std::collections::HashMap;

use cowork_config::ProviderName;
use cowork_inference::{BudgetThresholds, PricingEngine, SessionCostTracker, TurnUsage};
use serde_json::json;

fn engine() -> PricingEngine {
    let mut env = HashMap::new();
    env.insert(
        "COWORK_MODEL_PRICING_OVERRIDES".to_owned(),
        json!({ "openai:gpt-multi-step": {"inputPerMillion": 1.0, "outputPerMillion": 2.0} })
            .to_string(),
    );
    PricingEngine::from_env(&env)
}

fn step_usage(prompt: u64, completion: u64) -> TurnUsage {
    TurnUsage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        reasoning_output_tokens: Some(10),
        ..TurnUsage::default()
    }
}

#[test]
fn three_step_turn_records_one_aggregated_turn() {
    let engine = engine();
    let mut tracker = SessionCostTracker::new(
        "sess",
        Some(BudgetThresholds {
            warn_at_usd: None,
            stop_at_usd: Some(0.004),
        }),
    );
    let record = |tracker: &mut SessionCostTracker, turn: &str, usage: TurnUsage| {
        tracker.record_turn_with_engine(
            turn,
            ProviderName::Openai,
            "gpt-multi-step",
            usage,
            None,
            &engine,
        )
    };

    record(&mut tracker, "turn_0", step_usage(500, 0));
    // $0.001 + $0.002 + $0.003 across three steps of one turn.
    record(&mut tracker, "turn_1", step_usage(1_000, 0));
    assert!(!tracker.is_budget_exceeded());
    record(&mut tracker, "turn_1", step_usage(0, 1_000));
    assert!(!tracker.is_budget_exceeded());
    let last = record(&mut tracker, "turn_1", step_usage(1_000, 1_000));
    // Budget is still enforced per step: the third step crosses stopAtUsd mid-turn.
    assert!(tracker.is_budget_exceeded());

    let snap = tracker.get_snapshot();
    assert_eq!(snap.total_turns, 2);
    assert_eq!(snap.turns.len(), 2);
    let turn = &snap.turns[1];
    assert_eq!(turn, &last);
    assert_eq!(turn.turn_id, "turn_1");
    assert_eq!(turn.turn_index, 1);
    assert_eq!(turn.usage.prompt_tokens, 2_000);
    assert_eq!(turn.usage.completion_tokens, 2_000);
    assert_eq!(turn.usage.total_tokens, 4_000);
    assert_eq!(turn.usage.reasoning_output_tokens, Some(30));
    assert!((turn.estimated_cost_usd.unwrap() - 0.006).abs() < 1e-12);

    assert_eq!(snap.total_prompt_tokens, 2_500);
    assert_eq!(snap.total_tokens, 4_500);
    assert!((snap.estimated_total_cost_usd.unwrap() - 0.0065).abs() < 1e-12);
    assert_eq!(snap.by_model.len(), 1);
    assert_eq!(snap.by_model[0].turns, 2);
    assert_eq!(snap.by_model[0].total_tokens, 4_500);

    // A new turn id still starts a new entry.
    record(&mut tracker, "turn_2", step_usage(1, 1));
    let snap = tracker.get_snapshot();
    assert_eq!(snap.total_turns, 3);
    assert_eq!(snap.turns.len(), 3);
    assert_eq!(snap.by_model[0].turns, 3);
}
