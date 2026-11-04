//! Regression: the legacy `providerOptions.bedrock.reasoning` key must still enable Claude
//! thinking on Bedrock (adaptive for Claude 4.6+, budgeted for older Claude models).

use cowork_providers::bedrock::build_converse_request_body;
use serde_json::{Map, Value, json};

fn body_for(model_id: &str, opts: Value) -> Value {
    let opts: Map<String, Value> = opts.as_object().unwrap().clone();
    build_converse_request_body(model_id, "System", &[], &[], &opts)
}

#[test]
fn legacy_bedrock_reasoning_key_enables_adaptive_thinking() {
    let body = body_for(
        "us.anthropic.claude-sonnet-4-6",
        json!({ "bedrock": { "reasoning": "high" } }),
    );
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"],
        json!({ "type": "adaptive" })
    );
    assert_eq!(
        body["additionalModelRequestFields"]["output_config"]["effort"],
        json!("high")
    );
}

#[test]
fn legacy_bedrock_reasoning_key_enables_budgeted_thinking() {
    let body = body_for(
        "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        json!({ "bedrock": { "reasoning": "medium" } }),
    );
    // TS `adjustMaxTokensForThinking` with the 8192 fallback model cap (3.7 Sonnet is not in the
    // pi-ai Bedrock catalog): maxTokens 8192, budget clamped to 8192 - 1024 for answer room.
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"],
        json!({ "type": "enabled", "budget_tokens": 7168 })
    );
    assert_eq!(body["inferenceConfig"]["maxTokens"], json!(8192));
}

#[test]
fn nested_bedrock_reasoning_wins_over_top_level_alias_and_off_disables() {
    let body = body_for(
        "us.anthropic.claude-sonnet-4-6",
        json!({ "reasoningEffort": "low", "bedrock": { "reasoning": "high" } }),
    );
    assert_eq!(
        body["additionalModelRequestFields"]["output_config"]["effort"],
        json!("high")
    );

    let body = body_for(
        "us.anthropic.claude-sonnet-4-6",
        json!({ "bedrock": { "reasoning": "off" } }),
    );
    assert!(body.get("additionalModelRequestFields").is_none());
}
