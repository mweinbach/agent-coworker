use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use cowork_inference::{
    CanonicalMessage, ContentBlock, ContinuationFingerprintInput,
    DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS, DEFAULT_MODEL_STEP_BUDGET_SECS, MessageRole,
    ProviderContinuationState, ProviderOpaqueMeta, ProviderTransportError, RequestPolicy,
    StepBudget, StreamEvent, TextPhase, compute_backoff_delay_ms, compute_continuation_fingerprint,
    execute_step_with_pre_output_retry, parse_retry_after_ms, validate_continuation_state,
};
use serde_json::{Map, json};
use tokio_util::sync::CancellationToken;

#[test]
fn request_policy_defaults_and_clamps_120s_http_and_300s_step_budgets() {
    let default_policy = RequestPolicy::default();
    assert_eq!(
        default_policy.timeout_ms,
        DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS * 1_000
    );
    assert_eq!(
        default_policy.step_timeout_ms,
        DEFAULT_MODEL_STEP_BUDGET_SECS * 1_000
    );

    // timeoutMs is clamped to stepTimeoutMs when stepTimeoutMs is smaller.
    let opts = json!({
        "timeoutMs": 120_000,
        "stepTimeoutMs": 45_000,
        "maxRetryDelayMs": 15_000
    });
    let resolved = RequestPolicy::from_options(opts.as_object().unwrap()).expect("valid policy");
    assert_eq!(resolved.timeout_ms, 45_000);
    assert_eq!(resolved.step_timeout_ms, 45_000);
    assert_eq!(resolved.max_retry_delay_ms, 15_000);

    // Out-of-bounds values fail closed.
    assert!(RequestPolicy::from_options(json!({"timeoutMs": 0}).as_object().unwrap()).is_err());
    assert!(
        RequestPolicy::from_options(json!({"stepTimeoutMs": 2_000_000}).as_object().unwrap())
            .is_err()
    );
}

#[test]
fn retry_after_parsing_and_equal_jitter_backoff_match_spec() {
    let mut headers = HashMap::new();
    headers.insert("retry-after-ms".to_string(), "350".to_string());
    let parsed_ms = parse_retry_after_ms(&headers, 60_000).expect("valid retry-after-ms");
    assert_eq!(parsed_ms, Some(350));

    let mut sec_headers = HashMap::new();
    sec_headers.insert("retry-after".to_string(), "2".to_string());
    let parsed_secs = parse_retry_after_ms(&sec_headers, 60_000).expect("valid retry-after secs");
    assert_eq!(parsed_secs, Some(2_000));

    // Exceeding maxRetryDelayMs fails immediately instead of stalling the step.
    let mut huge_headers = HashMap::new();
    huge_headers.insert("retry-after".to_string(), "120".to_string());
    assert!(parse_retry_after_ms(&huge_headers, 60_000).is_err());

    // Equal jitter [delay/2, delay) when no Retry-After header is present:
    // retry 1 -> base 2000ms -> [1000, 2000)
    assert_eq!(compute_backoff_delay_ms(1, None, 2_000, 60_000, 0.0), 1_000);
    assert_eq!(compute_backoff_delay_ms(1, None, 2_000, 60_000, 0.5), 1_500);
    // retry 2 -> 4000ms -> [2000, 4000)
    assert_eq!(compute_backoff_delay_ms(2, None, 2_000, 60_000, 0.0), 2_000);
    // Explicit Retry-After overrides exponential backoff.
    assert_eq!(
        compute_backoff_delay_ms(1, Some(125), 2_000, 60_000, 0.0),
        125
    );
}

#[tokio::test]
async fn pre_first_token_retries_429_and_5xx_with_retry_after_but_never_retries_after_visible_output()
 {
    let policy = RequestPolicy {
        timeout_ms: 5_000,
        step_timeout_ms: 10_000,
        max_attempts: 4,
        base_delay_ms: 20,
        max_retry_delay_ms: 5_000,
    };

    // Case A: 429 (with retry-after-ms: 15) -> 503 -> 200 OK (all before visible tokens!)
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_clone = Arc::clone(&attempts);
    let budget = StepBudget::new(policy.step_timeout_ms, None);

    let result =
        execute_step_with_pre_output_retry(&policy, &budget, move |_attempt_no, mut emit| {
            let attempts_inner = Arc::clone(&attempts_clone);
            async move {
                let current = attempts_inner.fetch_add(1, Ordering::SeqCst) + 1;
                if current == 1 {
                    let mut headers = HashMap::new();
                    headers.insert("retry-after-ms".to_string(), "15".to_string());
                    return Err(ProviderTransportError::http(
                        429,
                        "Too Many Requests",
                        headers,
                    ));
                }
                if current == 2 {
                    return Err(ProviderTransportError::http(
                        503,
                        "Service Unavailable",
                        HashMap::new(),
                    ));
                }
                emit(StreamEvent::TextDelta {
                    turn_id: "turn_ok".to_string(),
                    block_index: 0,
                    delta: "Hello world".to_string(),
                    phase: Some(TextPhase::FinalAnswer),
                });
                Ok("completed_after_retries")
            }
        })
        .await
        .expect("pre-first-token retries succeed");

    assert_eq!(result, "completed_after_retries");
    assert_eq!(attempts.load(Ordering::SeqCst), 3);

    // Case B: Once a visible token (or tool delta) has been emitted, a mid-stream 500/network drop
    // MUST NOT retry — it must surface truthfully on attempt 1!
    let post_token_attempts = Arc::new(AtomicUsize::new(0));
    let post_token_clone = Arc::clone(&post_token_attempts);
    let emitted_chunks = Arc::new(AtomicUsize::new(0));
    let emitted_clone = Arc::clone(&emitted_chunks);
    let budget2 = StepBudget::new(policy.step_timeout_ms, None);

    let err =
        execute_step_with_pre_output_retry(&policy, &budget2, move |_attempt_no, mut emit| {
            let attempts_inner = Arc::clone(&post_token_clone);
            let emitted_inner = Arc::clone(&emitted_clone);
            async move {
                attempts_inner.fetch_add(1, Ordering::SeqCst);
                emit(StreamEvent::TextDelta {
                    turn_id: "turn_midstream_err".to_string(),
                    block_index: 0,
                    delta: "Partial visible text".to_string(),
                    phase: None,
                });
                emitted_inner.fetch_add(1, Ordering::SeqCst);
                Err::<(), ProviderTransportError>(ProviderTransportError::network(
                    "ECONNRESET mid-stream",
                ))
            }
        })
        .await
        .expect_err("mid-stream failure after visible output must not retry");

    assert!(err.message.contains("ECONNRESET"));
    assert_eq!(post_token_attempts.load(Ordering::SeqCst), 1);
    assert_eq!(emitted_chunks.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn step_budget_enforces_deadline_and_propagates_caller_cancellation() {
    let policy = RequestPolicy {
        timeout_ms: 500,
        step_timeout_ms: 80,
        max_attempts: 4,
        base_delay_ms: 200,
        max_retry_delay_ms: 1_000,
    };
    let budget = StepBudget::new(policy.step_timeout_ms, None);

    let err = execute_step_with_pre_output_retry(&policy, &budget, |_attempt, _emit| async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        Ok::<_, ProviderTransportError>("never")
    })
    .await
    .expect_err("step budget timeout must cancel hanging attempt");
    assert!(err.is_timeout || err.is_abort);

    // Caller CancellationToken cancels in-flight backoff immediately.
    let cancel = CancellationToken::new();
    let budget_cancel = StepBudget::new(10_000, Some(cancel.clone()));
    let cancel_trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_trigger.cancel();
    });

    let err_cancel = budget_cancel
        .sleep(Duration::from_secs(5))
        .await
        .expect_err("cancelled sleep");
    assert!(err_cancel.is_abort);
}

#[test]
fn sha256_continuation_fingerprint_invalidates_on_system_tool_or_prefix_mutation() {
    let base_prefix = vec![CanonicalMessage {
        id: "m1".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Hello".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    }];

    let mut stream_opts_a = Map::new();
    stream_opts_a.insert("reasoningEffort".to_string(), json!("high"));
    stream_opts_a.insert("apiKey".to_string(), json!("sk-secret-1"));

    let mut stream_opts_b = Map::new();
    stream_opts_b.insert("apiKey".to_string(), json!("sk-rotated-2"));
    stream_opts_b.insert("reasoningEffort".to_string(), json!("high"));

    let base_input = ContinuationFingerprintInput {
        provider: "openai",
        model_id: "gpt-5.4",
        system_prompt: "You are Cowork.",
        tools: &[json!({"name": "bash", "parameters": {"type": "object"}})],
        authorized_tool_names: Some(&["bash".to_string(), "read".to_string()]),
        canonical_prefix: &base_prefix,
        stream_options: &stream_opts_a,
    };

    let fp1 = compute_continuation_fingerprint(&base_input);
    assert_eq!(fp1.len(), 64, "SHA-256 hex digest must be 64 hex chars");

    // Rotating API key or reordering authorizedToolNames must NOT invalidate continuation!
    let rotated_key_input = ContinuationFingerprintInput {
        authorized_tool_names: Some(&["read".to_string(), "bash".to_string()]),
        stream_options: &stream_opts_b,
        ..base_input.clone()
    };
    assert_eq!(compute_continuation_fingerprint(&rotated_key_input), fp1);

    let stored = ProviderContinuationState::OpenAi {
        model: "gpt-5.4".to_string(),
        response_id: "resp_prev_1".to_string(),
        updated_at: "2026-10-30T00:00:00Z".to_string(),
        request_fingerprint: fp1.clone(),
    };
    assert!(validate_continuation_state(Some(&stored), "openai", "gpt-5.4", &fp1).is_some());

    // Mutating system prompt invalidates continuation
    let mutated_sys = ContinuationFingerprintInput {
        system_prompt: "You are Cowork (updated instructions).",
        ..base_input.clone()
    };
    let fp_sys = compute_continuation_fingerprint(&mutated_sys);
    assert_ne!(fp_sys, fp1);
    assert!(validate_continuation_state(Some(&stored), "openai", "gpt-5.4", &fp_sys).is_none());

    // Mutating tool definitions invalidates continuation
    let mutated_tools = ContinuationFingerprintInput {
        tools: &[
            json!({"name": "bash", "parameters": {"type": "object"}}),
            json!({"name": "write", "parameters": {"type": "object"}}),
        ],
        ..base_input.clone()
    };
    let fp_tools = compute_continuation_fingerprint(&mutated_tools);
    assert_ne!(fp_tools, fp1);
    assert!(validate_continuation_state(Some(&stored), "openai", "gpt-5.4", &fp_tools).is_none());

    // Mutating canonical prefix invalidates continuation
    let mut edited_prefix = base_prefix.clone();
    edited_prefix[0].content = vec![ContentBlock::Text {
        text: "Edited user prompt".to_string(),
        phase: None,
        citations: vec![],
        provider_meta: ProviderOpaqueMeta::default(),
    }];
    let mutated_prefix = ContinuationFingerprintInput {
        canonical_prefix: &edited_prefix,
        ..base_input
    };
    let fp_prefix = compute_continuation_fingerprint(&mutated_prefix);
    assert_ne!(fp_prefix, fp1);
    assert!(validate_continuation_state(Some(&stored), "openai", "gpt-5.4", &fp_prefix).is_none());
}
