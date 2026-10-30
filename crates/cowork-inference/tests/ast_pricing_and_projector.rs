use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cowork_config::ProviderName;
use cowork_inference::{
    BudgetThresholdUpdate, BudgetThresholds, CanonicalMessage, Citation, ClientCapabilities,
    ContentBlock, CostTrackerEvent, InferenceModelRegistry, MediaKind, MediaSource, MessageRole,
    PricingEngine, ProviderNativeToolRole, ProviderOpaqueMeta, ReasoningStreamMode,
    SessionCostTracker, StopReason, StreamEvent, StreamEventProjector, StreamingToolDeltaParser,
    TextPhase, ToolResultPart, TurnUsage, compose_openai_tool_call_id,
    filter_persisted_assistant_history, split_openai_tool_call_id,
};
use serde_json::{Map, json};
use tempfile::Builder;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root")
        .to_path_buf()
}

fn isolated_private_tmp_dir(prefix: &str) -> tempfile::TempDir {
    Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("isolated /private/tmp tempdir")
}

#[test]
fn canonical_ast_roundtrips_all_provider_opaque_metadata_and_exec_citations_losslessly() {
    let composite_id = compose_openai_tool_call_id("call_abc123", "fc_item_999");
    assert_eq!(composite_id, "call_abc123|fc_item_999");
    assert_eq!(
        split_openai_tool_call_id(&composite_id),
        ("call_abc123", Some("fc_item_999"))
    );

    let mut tool_args = Map::new();
    tool_args.insert("cmd".to_string(), json!("rg Cargo.toml"));

    let openai_reasoning_meta = ProviderOpaqueMeta {
        openai_response_id: Some("resp_01".to_string()),
        openai_item_id: Some("rs_01".to_string()),
        openai_encrypted_reasoning: Some(json!("gAAAAABn_encrypted_blob")),
        openai_reasoning_item: Some(json!({
            "id": "rs_01",
            "type": "reasoning",
            "encrypted_content": "gAAAAABn_encrypted_blob",
            "summary": [{"type": "summary_text", "text": "Checking files"}]
        })),
        ..Default::default()
    };

    let anthropic_redacted_meta = ProviderOpaqueMeta {
        anthropic_redacted_thinking: Some("redacted_opaque_payload_xyz".to_string()),
        ..Default::default()
    };

    let gemini_tool_meta = ProviderOpaqueMeta {
        google_interaction_id: Some("inter_77".to_string()),
        google_thought_signature: Some("sig_gemini_thought_42".to_string()),
        ..Default::default()
    };

    let msg = CanonicalMessage {
        id: "msg_turn_1".to_string(),
        role: MessageRole::Assistant,
        phase: Some(TextPhase::FinalAnswer),
        provider: Some("openai".to_string()),
        api: Some("openai-responses".to_string()),
        model: Some("gpt-5.4".to_string()),
        stop_reason: Some(StopReason::ToolUse),
        created_at: "2026-10-30T00:00:00Z".to_string(),
        provider_meta: ProviderOpaqueMeta {
            openai_response_id: Some("resp_01".to_string()),
            anthropic_effort: Some("high".to_string()),
            google_interaction_id: Some("inter_77".to_string()),
            ..Default::default()
        },
        content: vec![
            ContentBlock::Thinking {
                text: "Checking files".to_string(),
                summary: Some("Checking files".to_string()),
                redacted: false,
                signature: Some("sig_anthropic_123".to_string()),
                provider_meta: openai_reasoning_meta,
            },
            ContentBlock::Thinking {
                text: String::new(),
                summary: None,
                redacted: true,
                signature: None,
                provider_meta: anthropic_redacted_meta,
            },
            ContentBlock::Text {
                text: "Let me inspect the workspace first.".to_string(),
                phase: Some(TextPhase::Commentary),
                citations: vec![],
                provider_meta: ProviderOpaqueMeta::default(),
            },
            ContentBlock::Text {
                text: "Found authoritative docs.".to_string(),
                phase: Some(TextPhase::FinalAnswer),
                citations: vec![Citation {
                    url: "https://developers.openai.com/api/docs".to_string(),
                    title: Some("OpenAI Docs".to_string()),
                    cited_text: Some("Responses API".to_string()),
                    start_index: Some(0),
                    end_index: Some(25),
                    source_type: Some("url_citation".to_string()),
                    provider_meta: Map::new(),
                }],
                provider_meta: ProviderOpaqueMeta::default(),
            },
            ContentBlock::ProviderNativeTool {
                id: "srvtool_1".to_string(),
                name: "exec".to_string(),
                role: ProviderNativeToolRole::Result,
                arguments: Map::new(),
                result: Some(json!({
                    "nested": {
                        "type": "web_search_result",
                        "citations": [{"url": "https://rust-lang.org", "title": "Rust"}]
                    }
                })),
                is_error: false,
                citations: vec![Citation {
                    url: "https://rust-lang.org".to_string(),
                    title: Some("Rust".to_string()),
                    cited_text: None,
                    start_index: None,
                    end_index: None,
                    source_type: Some("exec_nested_citation".to_string()),
                    provider_meta: Map::new(),
                }],
                provider_meta: ProviderOpaqueMeta::default(),
            },
            ContentBlock::ToolCall {
                id: composite_id.clone(),
                name: "bash".to_string(),
                arguments: tool_args,
                partial_json: None,
                provider_meta: gemini_tool_meta,
            },
            ContentBlock::Media {
                kind: MediaKind::Image,
                source: MediaSource::Base64 {
                    mime_type: "image/png".to_string(),
                    data: "iVBORw0KGgoAAAANSUhEUg==".to_string(),
                },
                provider_meta: ProviderOpaqueMeta::default(),
            },
        ],
    };

    let serialized = serde_json::to_string(&msg).expect("serialize CanonicalMessage");
    let roundtripped: CanonicalMessage =
        serde_json::from_str(&serialized).expect("deserialize CanonicalMessage");
    assert_eq!(roundtripped, msg);

    // Persisted assistant history omits OpenAI commentary text blocks while preserving final_answer,
    // encrypted thinking blocks, native tool blocks, and tool calls.
    let persisted = filter_persisted_assistant_history(&roundtripped)
        .expect("persisted message remains non-empty");
    assert_eq!(persisted.content.len(), 6);
    assert!(!persisted.content.iter().any(|block| matches!(
        block,
        ContentBlock::Text {
            phase: Some(TextPhase::Commentary),
            ..
        }
    )));

    // Verify ToolResult with multimodal parts and structured metadata round-trips cleanly.
    let tool_msg = CanonicalMessage {
        id: "msg_tool_1".to_string(),
        role: MessageRole::Tool,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        created_at: "2026-10-30T00:00:01Z".to_string(),
        provider_meta: ProviderOpaqueMeta::default(),
        content: vec![ContentBlock::ToolResult {
            tool_call_id: composite_id,
            tool_name: Some("bash".to_string()),
            content: vec![
                ToolResultPart::Text {
                    text: "Cargo.toml".to_string(),
                },
                ToolResultPart::Media {
                    kind: MediaKind::Document,
                    source: MediaSource::FileRef {
                        path: "/private/tmp/spec.pdf".to_string(),
                        mime_type: Some("application/pdf".to_string()),
                    },
                },
            ],
            structured_meta: Some(json!({"exitCode": 0})),
            is_error: false,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };
    let tool_json = serde_json::to_value(&tool_msg).expect("serialize tool message");
    let decoded_tool: CanonicalMessage =
        serde_json::from_value(tool_json).expect("deserialize tool message");
    assert_eq!(decoded_tool, tool_msg);
}

#[test]
fn model_registry_loads_all_builtin_provider_manifests_and_resolves_aliases() {
    let tmp = isolated_private_tmp_dir("cowork-inf-reg-");
    let registry = InferenceModelRegistry::load_from_repo_root(&repo_root())
        .expect("load config/models/<provider>/*.json");

    // There are 106 static JSON manifests across 13 provider folders under config/models/.
    assert!(
        registry.all_models().len() >= 100,
        "expected >=100 static models, got {}",
        registry.all_models().len()
    );

    // Check OpenAI, Anthropic, and Google models + defaults + legacy aliases.
    let gpt55 = registry
        .get(ProviderName::Openai, "gpt-5.5")
        .expect("openai:gpt-5.5");
    assert!(gpt55.supports_image_input);
    assert_eq!(
        gpt55
            .provider_options_defaults
            .get("reasoningEffort")
            .and_then(|v| v.as_str()),
        Some("high")
    );

    let legacy_gpt = registry
        .get(ProviderName::Openai, "gpt-5.1")
        .expect("legacy alias gpt-5.1 -> gpt-5.4");
    assert_eq!(legacy_gpt.id, "gpt-5.4");

    let opus47 = registry
        .get(ProviderName::Anthropic, "claude-opus-4-7")
        .expect("anthropic:claude-opus-4-7");
    assert_eq!(
        opus47
            .provider_options_defaults
            .get("effort")
            .and_then(|v| v.as_str()),
        Some("high")
    );

    let gemini_alias = registry
        .get(ProviderName::Google, "gemini-3-pro-preview")
        .expect("gemini-3-pro-preview alias");
    assert_eq!(gemini_alias.id, "gemini-3.1-pro-preview-customtools");

    let env = HashMap::new();
    let lmstudio_custom = registry.resolve_for_session(
        ProviderName::Lmstudio,
        Some("ornith-1.5-122b-uncensored@q4_k_m"),
        tmp.path(),
        &env,
    );
    assert_eq!(lmstudio_custom.id, "ornith-1.5-122b-uncensored@q4_k_m");
}

#[test]
fn pricing_engine_and_session_cost_tracker_enforce_long_context_tiers_and_budgets() {
    let mut env = HashMap::new();
    let engine = PricingEngine::from_env(&env);

    // 1. Standard vs Long-Context Tiering on openai:gpt-5.4 (threshold = 272_000)
    // Standard: input=$2.50/M, cached=$0.25/M, output=$15/M
    let gpt54 = engine
        .resolve(ProviderName::Openai, "gpt-5.4")
        .expect("openai:gpt-5.4 pricing");
    assert_eq!(gpt54.long_context_threshold_tokens, Some(272_000));

    // Exactly AT threshold (272_000) -> still standard tier!
    let at_threshold = engine.calculate_breakdown(272_000, 10_000, &gpt54, 72_000, 0);
    // uncached = 200_000 * $2.50/M = $0.50; cached = 72_000 * $0.25/M = $0.018; output = 10_000 * $15/M = $0.15
    assert!((at_threshold.input_cost_usd - 0.50).abs() < 1e-9);
    assert!((at_threshold.cached_input_cost_usd - 0.018).abs() < 1e-9);
    assert!((at_threshold.output_cost_usd - 0.15).abs() < 1e-9);
    assert!((at_threshold.total_cost_usd - 0.668).abs() < 1e-9);

    // ABOVE threshold (300_000 > 272_000) -> long-context tier!
    // Long-context: input=$5.00/M, cached=$0.50/M, output=$22.50/M
    let above_threshold = engine.calculate_breakdown(300_000, 10_000, &gpt54, 100_000, 0);
    // uncached = 200_000 * $5.00/M = $1.00; cached = 100_000 * $0.50/M = $0.05; output = 10_000 * $22.50/M = $0.225
    assert!((above_threshold.input_cost_usd - 1.00).abs() < 1e-9);
    assert!((above_threshold.cached_input_cost_usd - 0.05).abs() < 1e-9);
    assert!((above_threshold.output_cost_usd - 0.225).abs() < 1e-9);
    assert!((above_threshold.total_cost_usd - 1.275).abs() < 1e-9);

    // 2. Anthropic cache read + cache write pricing (claude-opus-4-7: in=$5, out=$25, read=$0.5, write=$6.25)
    let opus = engine
        .resolve(ProviderName::Anthropic, "claude-opus-4-7-20260601")
        .expect("prefix match anthropic:claude-opus-4-7");
    let opus_cost = engine.calculate_breakdown(100_000, 4_000, &opus, 60_000, 20_000);
    // uncached = 20_000 * 5 / 1M = 0.10; cached = 60_000 * 0.5 / 1M = 0.03; write = 20_000 * 6.25 / 1M = 0.125; out = 4_000 * 25 / 1M = 0.10
    assert!((opus_cost.total_cost_usd - 0.355).abs() < 1e-9);

    // 3. opencode-go is intentionally excluded even if overridden via COWORK_MODEL_PRICING_OVERRIDES!
    env.insert(
        "COWORK_MODEL_PRICING_OVERRIDES".to_string(),
        json!({
            "opencode-go:glm-5": {"inputPerMillion": 1.0, "outputPerMillion": 2.0},
            "openai:gpt-6-astra": {"inputPerMillion": 6.0, "outputPerMillion": 36.0, "cachedInputPerMillion": 0.6}
        })
        .to_string(),
    );
    let overridden_engine = PricingEngine::from_env(&env);
    assert!(
        overridden_engine
            .resolve(ProviderName::OpencodeGo, "glm-5")
            .is_none()
    );
    let astra_pricing = overridden_engine
        .resolve(ProviderName::Openai, "gpt-6-astra")
        .expect("custom override for openai:gpt-6-astra");
    assert!((astra_pricing.input_per_million - 6.0).abs() < 1e-9);

    // 4. SessionCostTracker warnAtUsd & stopAtUsd + validation + snapshot round-trip
    let mut tracker = SessionCostTracker::new(
        "sess_budget_1",
        Some(BudgetThresholds {
            warn_at_usd: Some(0.50),
            stop_at_usd: Some(1.00),
        }),
    );

    // Invalid budget (warn >= stop) must fail closed
    assert!(
        tracker
            .set_budget(BudgetThresholds {
                warn_at_usd: Some(1.00),
                stop_at_usd: Some(1.00),
            })
            .is_err()
    );

    let recorded_events: Arc<Mutex<Vec<CostTrackerEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&recorded_events);
    tracker.add_listener(move |evt| {
        events_clone.lock().unwrap().push(evt.clone());
    });

    // Turn 1: $0.668 -> crosses warnAtUsd ($0.50), does NOT cross stopAtUsd ($1.00)
    let entry1 = tracker.record_turn_with_engine(
        "turn_1",
        ProviderName::Openai,
        "gpt-5.4",
        TurnUsage {
            prompt_tokens: 272_000,
            completion_tokens: 10_000,
            total_tokens: 282_000,
            cached_prompt_tokens: Some(72_000),
            cache_write_prompt_tokens: None,
            reasoning_output_tokens: Some(4_000),
            estimated_cost_usd: None,
        },
        None,
        &engine,
    );
    assert!((entry1.estimated_cost_usd.unwrap() - 0.668).abs() < 1e-9);
    assert!(tracker.get_budget_status().warning_triggered);
    assert!(!tracker.is_budget_exceeded());

    // Turn 2: $0.668 -> cumulative $1.336 -> crosses stopAtUsd ($1.00)
    tracker.record_turn_with_engine(
        "turn_2",
        ProviderName::Openai,
        "gpt-5.4",
        TurnUsage {
            prompt_tokens: 272_000,
            completion_tokens: 10_000,
            total_tokens: 282_000,
            cached_prompt_tokens: Some(72_000),
            cache_write_prompt_tokens: None,
            reasoning_output_tokens: Some(2_000),
            estimated_cost_usd: None,
        },
        None,
        &engine,
    );
    assert!(tracker.is_budget_exceeded());
    assert!(tracker.get_budget_status().stop_triggered);

    let events = recorded_events.lock().unwrap();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CostTrackerEvent::BudgetWarning { .. }))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CostTrackerEvent::BudgetExceeded { .. }))
    );

    // Snapshot roundtrip preserves totals, reasoningOutputTokens, and budget status.
    let snap = tracker.get_snapshot();
    assert_eq!(snap.total_turns, 2);
    assert_eq!(snap.total_reasoning_output_tokens, Some(6_000));
    let restored = SessionCostTracker::from_snapshot(snap.clone());
    assert_eq!(restored.get_snapshot().total_tokens, snap.total_tokens);
    assert!(restored.is_budget_exceeded());

    // Updating stopAtUsd higher clears stop_triggered cleanly.
    let mut restored = restored;
    restored
        .update_budget(BudgetThresholdUpdate {
            warn_at_usd: None,
            stop_at_usd: Some(Some(5.00)),
        })
        .expect("raise stopAtUsd");
    assert!(!restored.is_budget_exceeded());
}

#[test]
fn partial_json_parser_and_stream_projector_maintain_occurrence_ids_phases_and_lineage_gates() {
    // 1. Incremental partial-JSON tool delta parser
    let mut parser = StreamingToolDeltaParser::new();
    assert_eq!(
        parser.push_delta("{\"command\": \"cargo "),
        json!({"command": "cargo "}).as_object().unwrap().clone()
    );
    assert_eq!(
        parser
            .push_delta("test --workspace\", \"nested\": {\"retries\": 3, \"flags\": [\"--offline"),
        json!({
            "command": "cargo test --workspace",
            "nested": {
                "retries": 3,
                "flags": ["--offline"]
            }
        })
        .as_object()
        .unwrap()
        .clone()
    );
    parser.push_delta("\"]}}");
    let finalized = parser.finalize().expect("valid complete JSON object");
    assert_eq!(
        finalized,
        json!({
            "command": "cargo test --workspace",
            "nested": {
                "retries": 3,
                "flags": ["--offline"]
            }
        })
        .as_object()
        .unwrap()
        .clone()
    );

    // 2. StreamEvent -> JSON-RPC item/* projector:
    //    - Preserves clientMessageId on userMessage
    //    - Closes open assistant text item BEFORE reasoning or toolCall phases begin
    //    - Uses occurrence-stable item IDs (agentMessage:turn-1, then agentMessage:turn-1:2)
    //    - Filters retryOf / inputDigest and hidden cowork.toolRetryTurn when toolRetryLineage=false
    let mut legacy_projector = StreamEventProjector::new(
        "thread_1",
        ClientCapabilities {
            tool_retry_lineage: false,
        },
    );
    let mut modern_projector = StreamEventProjector::new(
        "thread_1",
        ClientCapabilities {
            tool_retry_lineage: true,
        },
    );

    let events = vec![
        StreamEvent::TurnStarted {
            turn_id: "turn-1".to_string(),
        },
        StreamEvent::UserMessage {
            turn_id: "turn-1".to_string(),
            text: "Run diagnostics".to_string(),
            client_message_id: Some("cmsg-42".to_string()),
            steer_request_id: None,
            annotations: vec![json!({"type": "cowork.toolRetryMetadata", "attempt": 2})],
        },
        // Hidden retry-turn user message should be stripped for legacy clients, kept for modern clients
        StreamEvent::UserMessage {
            turn_id: "turn-1".to_string(),
            text: "Retry bash".to_string(),
            client_message_id: Some("cmsg-retry".to_string()),
            steer_request_id: None,
            annotations: vec![json!({"type": "cowork.toolRetryTurn", "toolCallId": "tc-0"})],
        },
        StreamEvent::TextDelta {
            turn_id: "turn-1".to_string(),
            block_index: 0,
            delta: "Inspecting repo...".to_string(),
            phase: Some(TextPhase::Commentary),
        },
        // Entering reasoning MUST deterministically close agentMessage:turn-1 first!
        StreamEvent::ThinkingDelta {
            turn_id: "turn-1".to_string(),
            stream_id: "rs_1".to_string(),
            mode: ReasoningStreamMode::Summary,
            delta: "Planning command".to_string(),
        },
        // Entering toolCall MUST close reasoning:turn-1:rs_1 first!
        StreamEvent::ToolCallStart {
            turn_id: "turn-1".to_string(),
            key: "call_1".to_string(),
            name: "bash".to_string(),
            initial_args: None,
        },
        StreamEvent::ToolCallDelta {
            turn_id: "turn-1".to_string(),
            key: "call_1".to_string(),
            name: "bash".to_string(),
            delta: "{\"cmd\":\"pwd".to_string(),
        },
        StreamEvent::ToolCallDelta {
            turn_id: "turn-1".to_string(),
            key: "call_1".to_string(),
            name: "bash".to_string(),
            delta: "\"}".to_string(),
        },
        StreamEvent::ToolCallEnd {
            turn_id: "turn-1".to_string(),
            key: "call_1".to_string(),
            name: "bash".to_string(),
            arguments: Some(json!({"cmd": "pwd"}).as_object().unwrap().clone()),
            retry_of: Some("toolCall:turn-0:call_0".to_string()),
            input_digest: Some(json!({"sha256": "abc123"})),
        },
        StreamEvent::ToolResult {
            turn_id: "turn-1".to_string(),
            key: "call_1".to_string(),
            name: "bash".to_string(),
            result: json!({"stdout": "/private/tmp"}),
            is_error: false,
            denied: false,
        },
        // Second assistant text block in same turn MUST get occurrence ID `agentMessage:turn-1:2`!
        StreamEvent::TextDelta {
            turn_id: "turn-1".to_string(),
            block_index: 1,
            delta: "All checks passed.".to_string(),
            phase: Some(TextPhase::FinalAnswer),
        },
        StreamEvent::TurnCompleted {
            turn_id: "turn-1".to_string(),
            status: "completed".to_string(),
            usage: None,
        },
    ];

    let mut legacy_out = Vec::new();
    let mut modern_out = Vec::new();
    for ev in &events {
        legacy_out.extend(legacy_projector.project(ev));
        modern_out.extend(modern_projector.project(ev));
    }

    // Verify userMessage preserves clientMessageId (`userMessage:turn-1:cmsg-42`)
    let user_started = legacy_out
        .iter()
        .find(|n| {
            n.method == "item/started" && n.params["item"]["id"] == "userMessage:turn-1:cmsg-42"
        })
        .expect("userMessage started");
    assert_eq!(user_started.params["item"]["clientMessageId"], "cmsg-42");
    // Legacy client must NOT see cowork.toolRetryMetadata or hidden cmsg-retry
    assert!(user_started.params["item"].get("annotations").is_none());
    assert!(
        !legacy_out
            .iter()
            .any(|n| { n.params["item"]["id"] == "userMessage:turn-1:cmsg-retry" })
    );
    // Modern client MUST see hidden retry userMessage and retryOf/inputDigest
    assert!(
        modern_out
            .iter()
            .any(|n| { n.params["item"]["id"] == "userMessage:turn-1:cmsg-retry" })
    );

    // Verify agentMessage:turn-1 was closed BEFORE reasoning item/started!
    let idx_agent1_completed = legacy_out
        .iter()
        .position(|n| {
            n.method == "item/completed" && n.params["item"]["id"] == "agentMessage:turn-1"
        })
        .expect("agentMessage:turn-1 completed");
    let idx_reasoning_started = legacy_out
        .iter()
        .position(|n| n.method == "item/started" && n.params["item"]["type"] == "reasoning")
        .expect("reasoning started");
    assert!(
        idx_agent1_completed < idx_reasoning_started,
        "open assistant text item must close before reasoning phase begins"
    );

    // Verify reasoning closed BEFORE toolCall started!
    let idx_reasoning_completed = legacy_out
        .iter()
        .position(|n| n.method == "item/completed" && n.params["item"]["type"] == "reasoning")
        .expect("reasoning completed");
    let idx_tool_started = legacy_out
        .iter()
        .position(|n| {
            n.method == "item/started" && n.params["item"]["id"] == "toolCall:turn-1:call_1"
        })
        .expect("toolCall started");
    assert!(
        idx_reasoning_completed < idx_tool_started,
        "open reasoning item must close before toolCall phase begins"
    );

    // Verify second assistant message gets occurrence-stable ID `agentMessage:turn-1:2` on both delta and completed!
    let second_delta = legacy_out
        .iter()
        .find(|n| {
            n.method == "item/agentMessage/delta" && n.params["delta"] == "All checks passed."
        })
        .expect("second agentMessage delta");
    assert_eq!(second_delta.params["itemId"], "agentMessage:turn-1:2");

    // Verify retryOf & inputDigest stripped on legacy client and preserved on modern client
    let legacy_tool_completed = legacy_out
        .iter()
        .rfind(|n| {
            n.method == "item/completed" && n.params["item"]["id"] == "toolCall:turn-1:call_1"
        })
        .expect("legacy tool completed");
    assert!(
        legacy_tool_completed.params["item"]
            .get("retryOf")
            .is_none()
    );
    assert!(
        legacy_tool_completed.params["item"]
            .get("inputDigest")
            .is_none()
    );

    let modern_tool_completed = modern_out
        .iter()
        .rfind(|n| {
            n.method == "item/completed" && n.params["item"]["id"] == "toolCall:turn-1:call_1"
        })
        .expect("modern tool completed");
    assert_eq!(
        modern_tool_completed.params["item"]["retryOf"],
        "toolCall:turn-0:call_0"
    );
    assert_eq!(
        modern_tool_completed.params["item"]["inputDigest"]["sha256"],
        "abc123"
    );

    // Every outbound JSON-RPC notification frame omits `"jsonrpc": "2.0"`.
    for n in &legacy_out {
        let wire = n.to_jsonrpc_value();
        assert!(wire.get("jsonrpc").is_none());
    }
}
