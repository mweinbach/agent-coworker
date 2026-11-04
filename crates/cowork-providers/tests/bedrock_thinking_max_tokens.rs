//! Regression: budgeted Claude thinking on Bedrock must keep `budget_tokens < maxTokens`.
//! Ports TS `streamSimpleBedrock` + pi-ai `adjustMaxTokensForThinking`: the caller's output limit
//! (or the model cap when none was given) grows by the thinking budget, capped at the model max;
//! adaptive-thinking models pass `maxTokens` through untouched.

use cowork_providers::bedrock::build_converse_request_body;
use serde_json::{Map, Value, json};

const SONNET_45: &str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

fn body_for(model_id: &str, opts: Value) -> Value {
    let opts: Map<String, Value> = opts.as_object().unwrap().clone();
    build_converse_request_body(model_id, "System", &[], &[], &opts)
}

fn budget_and_max(body: &Value) -> (u64, u64) {
    let budget = body["additionalModelRequestFields"]["thinking"]["budget_tokens"]
        .as_u64()
        .expect("budget_tokens");
    let max = body["inferenceConfig"]["maxTokens"]
        .as_u64()
        .expect("inferenceConfig.maxTokens");
    (budget, max)
}

#[test]
fn sonnet_45_high_reasoning_with_small_max_tokens_raises_output_limit() {
    let body = body_for(
        SONNET_45,
        json!({ "bedrock": { "reasoning": "high", "maxTokens": 4096 } }),
    );
    // min(4096 + 16384, 64000) = 20480; budget 16384 stays below it.
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"],
        json!({ "type": "enabled", "budget_tokens": 16384 })
    );
    assert_eq!(body["inferenceConfig"]["maxTokens"], json!(20480));
    let (budget, max) = budget_and_max(&body);
    assert!(budget < max, "budget {budget} must be < maxTokens {max}");
}

#[test]
fn sonnet_45_high_reasoning_without_max_tokens_uses_model_cap() {
    let body = body_for(SONNET_45, json!({ "bedrock": { "reasoning": "high" } }));
    // No caller cap: TS uses `model.maxTokens` (64000), so min(64000 + 16384, 64000) = 64000.
    assert_eq!(body["inferenceConfig"]["maxTokens"], json!(64000));
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"]["budget_tokens"],
        json!(16384)
    );
}

#[test]
fn model_cap_clamps_budget_to_leave_answer_room() {
    // Claude 3.7 Sonnet is not in the pi-ai Bedrock catalog: TS falls back to maxTokens 8192.
    // min(8000 + 16384, 8192) = 8192 <= 16384, so the budget becomes 8192 - 1024 = 7168.
    let body = body_for(
        "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        json!({ "bedrock": { "reasoning": "xhigh", "maxTokens": 8000 } }),
    );
    assert_eq!(budget_and_max(&body), (7168, 8192));

    // Opus 4.1 caps at 32000.
    let body = body_for(
        "us.anthropic.claude-opus-4-1-20250805-v1:0",
        json!({ "bedrock": { "reasoning": "high", "maxTokens": 30000 } }),
    );
    assert_eq!(budget_and_max(&body), (16384, 32000));
}

#[test]
fn minimal_and_custom_thinking_budgets_follow_pi_defaults() {
    let body = body_for(
        SONNET_45,
        json!({ "bedrock": { "reasoning": "minimal", "maxTokens": 2000 } }),
    );
    assert_eq!(budget_and_max(&body), (1024, 3024));

    let body = body_for(
        SONNET_45,
        json!({
            "bedrock": {
                "reasoning": "medium",
                "maxTokens": 1000,
                "thinkingBudgets": { "medium": 4000 }
            }
        }),
    );
    assert_eq!(budget_and_max(&body), (4000, 5000));
}

#[test]
fn adaptive_model_leaves_max_tokens_untouched() {
    let body = body_for(
        "us.anthropic.claude-sonnet-4-6",
        json!({ "bedrock": { "reasoning": "high", "maxTokens": 4096 } }),
    );
    assert_eq!(body["inferenceConfig"]["maxTokens"], json!(4096));
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"],
        json!({ "type": "adaptive" })
    );
    assert!(
        body["additionalModelRequestFields"]["thinking"]
            .get("budget_tokens")
            .is_none()
    );

    let body = body_for(
        "us.anthropic.claude-sonnet-4-6",
        json!({ "bedrock": { "reasoning": "high" } }),
    );
    assert!(body.get("inferenceConfig").is_none());
}

#[test]
fn no_reasoning_leaves_max_tokens_untouched() {
    let body = body_for(SONNET_45, json!({ "bedrock": { "maxTokens": 4096 } }));
    assert_eq!(body["inferenceConfig"]["maxTokens"], json!(4096));
    assert!(body.get("additionalModelRequestFields").is_none());

    let body = body_for(SONNET_45, json!({ "bedrock": { "reasoning": "off" } }));
    assert!(body.get("inferenceConfig").is_none());
}
