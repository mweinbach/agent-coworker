use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use chrono::Utc;
use cowork_inference::{
    CanonicalMessage, Citation, ContentBlock, MediaKind, MediaSource, MessageRole,
    ProviderNativeToolRole, ProviderOpaqueMeta, ProviderTransportError, ReasoningStreamMode,
    StepBudget, StopReason, StreamEvent, ToolResultPart, TurnUsage, execute_step_with_sink,
    extract_nested_citations, filter_persisted_assistant_history, parse_partial_json_object,
};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::endpoint_capabilities::{
    EndpointToolCapabilities, NativeProgrammaticToolCallingKind, NativeToolCallingPlan,
    NativeToolSearchKind, is_programmatic_eligible_tool, read_native_tool_calling_plan,
    record_rejected_native_capability, resolve_endpoint_tool_capabilities,
    write_native_tool_calling_plan,
};
use crate::sse::{build_http_client, post_json_sse};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    ToolDefinition, request_disables_all_tools,
};

const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

const CLAUDE_CODE_CANONICAL_TOOLS: &[&str] = &[
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];

/// Native Rust SSE wire transport for the Anthropic Messages API (`POST /v1/messages`).
#[derive(Debug, Clone)]
pub struct AnthropicMessagesTransport {
    client: reqwest::Client,
}

impl Default for AnthropicMessagesTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicMessagesTransport {
    pub fn new() -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
        }
    }
}

/// Loose SSE payload for Anthropic Messages events.
/// Intentionally omits `#[serde(deny_unknown_fields)]` so additive vendor fields never break streaming.
#[derive(Debug, Clone, Deserialize)]
struct AnthropicSseEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    message: Option<Value>,
    #[serde(default)]
    content_block: Option<Value>,
    #[serde(default)]
    delta: Option<Value>,
    #[serde(default)]
    usage: Option<Value>,
    #[serde(default)]
    container: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

#[async_trait]
impl ProviderTransport for AnthropicMessagesTransport {
    fn native_tool_capabilities(
        &self,
        base_url: Option<&str>,
        model_id: &str,
        strategy: cowork_config::ToolCallingStrategy,
    ) -> EndpointToolCapabilities {
        resolve_endpoint_tool_capabilities(
            cowork_config::ProviderName::Anthropic,
            base_url,
            model_id,
            strategy,
        )
    }

    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let allow_ambient_env = !request.provider_options.contains_key("coworkHome");
        let api_key = resolve_anthropic_api_key(request.api_key.as_deref(), allow_ambient_env)?;
        let is_oauth = api_key.contains("sk-ant-oat");

        let raw_base = request
            .base_url
            .as_deref()
            .unwrap_or_else(|| {
                crate::default_inference_base_url(cowork_config::ProviderName::Anthropic)
            })
            .trim_end_matches('/');
        let endpoint = if raw_base.ends_with("/v1") {
            format!("{raw_base}/messages")
        } else {
            format!("{raw_base}/v1/messages")
        };

        let mut effective_provider_options = request.provider_options.clone();
        let (wire_body, beta_features, effort_meta) = build_anthropic_messages_payload(
            &request.model_id,
            &request.system_prompt,
            &request.messages,
            &request.tools,
            &effective_provider_options,
            is_oauth,
        );
        let headers =
            build_anthropic_headers(&api_key, is_oauth, &beta_features, &request.extra_headers)?;

        let emitted_visible = AtomicBool::new(false);
        let first_result = self
            .run_attempts(
                &request,
                budget,
                on_event,
                &emitted_visible,
                &endpoint,
                &headers,
                wire_body,
                effort_meta,
                is_oauth,
            )
            .await;

        match first_result {
            Ok(res) => Ok(res),
            Err(err) => {
                if !emitted_visible.load(Ordering::SeqCst)
                    && !budget.cancellation_token().is_cancelled()
                    && let Some(active_plan) =
                        read_native_tool_calling_plan(&effective_provider_options)
                {
                    let (rej_ts, rej_ptc) =
                        classify_rejected_anthropic_native_tool_error(&err, &active_plan);
                    if rej_ts || rej_ptc {
                        record_rejected_native_capability(
                            cowork_config::ProviderName::Anthropic,
                            request.base_url.as_deref(),
                            &request.model_id,
                            rej_ts,
                            rej_ptc,
                            &err.message,
                        );
                        let mut downgraded_plan = active_plan;
                        if rej_ts {
                            downgraded_plan.tool_search = None;
                            downgraded_plan.deferred_tool_names.clear();
                        }
                        if rej_ptc {
                            downgraded_plan.programmatic_tool_calling = None;
                            downgraded_plan.programmatic_tool_names.clear();
                        }
                        write_native_tool_calling_plan(
                            &mut effective_provider_options,
                            &downgraded_plan,
                        );
                        tracing::warn!(
                            rejected_tool_search = rej_ts,
                            rejected_ptc = rej_ptc,
                            error = %err.message,
                            "anthropic endpoint rejected native tool feature; retrying with plain tools"
                        );
                        let (fallback_body, fallback_betas, fallback_effort) =
                            build_anthropic_messages_payload(
                                &request.model_id,
                                &request.system_prompt,
                                &request.messages,
                                &request.tools,
                                &effective_provider_options,
                                is_oauth,
                            );
                        let fallback_headers = build_anthropic_headers(
                            &api_key,
                            is_oauth,
                            &fallback_betas,
                            &request.extra_headers,
                        )?;
                        return self
                            .run_attempts(
                                &request,
                                budget,
                                on_event,
                                &emitted_visible,
                                &endpoint,
                                &fallback_headers,
                                fallback_body,
                                fallback_effort,
                                is_oauth,
                            )
                            .await;
                    }
                }
                Err(err)
            }
        }
    }
}

impl AnthropicMessagesTransport {
    #[allow(clippy::too_many_arguments)]
    async fn run_attempts(
        &self,
        request: &ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
        emitted_visible: &AtomicBool,
        endpoint: &str,
        headers: &HeaderMap,
        wire_body: Value,
        effort_meta: Option<String>,
        is_oauth: bool,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let mut sink = |ev: StreamEvent| {
            if ev.is_visible_output() {
                emitted_visible.store(true, Ordering::SeqCst);
            }
            on_event(ev);
        };
        let client = self.client.clone();
        let turn_id = request.turn_id.clone();
        let model_id = request.model_id.clone();
        let declared_tools = request.tools.clone();
        let attempt_timeout_ms = request.policy.timeout_ms;

        execute_step_with_sink(
            &request.policy,
            budget,
            &mut sink,
            &mut |_attempt_no, mut emit| {
                let client = client.clone();
                let endpoint = endpoint.to_owned();
                let headers = headers.clone();
                let wire_body = wire_body.clone();
                let turn_id = turn_id.clone();
                let model_id = model_id.clone();
                let effort_meta = effort_meta.clone();
                let declared_tools = declared_tools.clone();

                async move {
                    let timeout_dur = budget.attempt_timeout(attempt_timeout_ms)?;
                    let mut sse =
                        post_json_sse(&client, &endpoint, headers, &wire_body, timeout_dur).await?;

                    let mut decoder =
                        AnthropicStreamState::new(turn_id, model_id, is_oauth, declared_tools);
                    while let Some(frame_res) = sse.next().await {
                        let frame = frame_res?;
                        let trimmed = frame.data.trim();
                        if trimmed.is_empty() || trimmed == "[DONE]" || frame.event == "ping" {
                            continue;
                        }
                        let raw_json: Value = serde_json::from_str(trimmed).map_err(|err| {
                            ProviderTransportError::protocol(format!(
                                "Invalid JSON in Anthropic SSE frame: {err}"
                            ))
                        })?;
                        decoder.raw_events.push(raw_json.clone());
                        let ev: AnthropicSseEvent =
                            serde_json::from_value(raw_json).map_err(|err| {
                                ProviderTransportError::protocol(format!(
                                    "Malformed Anthropic SSE event: {err}"
                                ))
                            })?;
                        decoder.handle_event(ev, &mut *emit)?;
                    }

                    decoder.finish(effort_meta)
                }
            },
        )
        .await
    }
}

fn build_anthropic_headers(
    api_key: &str,
    is_oauth: bool,
    beta_features: &[String],
    extra_headers: &HashMap<String, String>,
) -> Result<HeaderMap, ProviderTransportError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static(ANTHROPIC_API_VERSION),
    );

    if is_oauth {
        let bearer = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| {
            ProviderTransportError::protocol(format!("Invalid Anthropic OAuth token: {e}"))
        })?;
        headers.insert(AUTHORIZATION, bearer);
    } else {
        let key_val = HeaderValue::from_str(api_key).map_err(|e| {
            ProviderTransportError::protocol(format!("Invalid Anthropic API key: {e}"))
        })?;
        headers.insert(HeaderName::from_static("x-api-key"), key_val);
    }

    let mut merged_betas: Vec<String> = Vec::new();
    let push_beta = |list: &mut Vec<String>, token: &str| {
        let trimmed = token.trim();
        if !trimmed.is_empty() && !list.iter().any(|b| b.eq_ignore_ascii_case(trimmed)) {
            list.push(trimmed.to_string());
        }
    };
    for beta in beta_features {
        push_beta(&mut merged_betas, beta);
    }

    for (k, v) in extra_headers {
        if k.eq_ignore_ascii_case("anthropic-beta") {
            for part in v.split(',') {
                push_beta(&mut merged_betas, part);
            }
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }

    if !merged_betas.is_empty()
        && let Ok(beta_val) = HeaderValue::from_str(&merged_betas.join(","))
    {
        headers.insert(HeaderName::from_static("anthropic-beta"), beta_val);
    }

    Ok(headers)
}

fn classify_rejected_anthropic_native_tool_error(
    err: &ProviderTransportError,
    plan: &NativeToolCallingPlan,
) -> (bool, bool) {
    if err.is_abort {
        return (false, false);
    }
    let is_client_err = matches!(err.status, Some(400 | 404 | 422))
        || (err.status.is_none() && !err.is_network_transient && !err.is_timeout);
    if !is_client_err {
        return (false, false);
    }
    let lower = err.message.to_ascii_lowercase();
    let mentions_ts = lower.contains("tool_search_tool") || lower.contains("defer_loading");
    let mentions_ptc = lower.contains("code_execution")
        || lower.contains("allowed_callers")
        || lower.contains("container");
    if mentions_ts || mentions_ptc {
        return (
            mentions_ts && plan.tool_search.is_some(),
            mentions_ptc && plan.programmatic_tool_calling.is_some(),
        );
    }
    let generic_tools_err = (lower.contains("tools.") || lower.contains("tools["))
        && (lower.contains("invalid")
            || lower.contains("unknown")
            || lower.contains("unsupported")
            || lower.contains("not supported")
            || lower.contains("extra inputs are not permitted"));
    if generic_tools_err {
        return (
            plan.tool_search.is_some(),
            plan.programmatic_tool_calling.is_some(),
        );
    }
    (false, false)
}

fn resolve_anthropic_api_key(
    explicit: Option<&str>,
    allow_ambient_env: bool,
) -> Result<String, ProviderTransportError> {
    if let Some(key) = explicit.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(key.to_string());
    }
    if allow_ambient_env {
        for var in ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] {
            if let Ok(val) = std::env::var(var)
                && !val.trim().is_empty()
            {
                return Ok(val.trim().to_string());
            }
        }
    }
    Err(ProviderTransportError::protocol(
        "No API key for provider: anthropic",
    ))
}

fn to_claude_code_name(name: &str) -> String {
    for &canonical in CLAUDE_CODE_CANONICAL_TOOLS {
        if canonical.eq_ignore_ascii_case(name) {
            return canonical.to_string();
        }
    }
    name.to_string()
}

fn from_claude_code_name(name: &str, declared_tools: &[ToolDefinition]) -> String {
    for t in declared_tools {
        if t.name.eq_ignore_ascii_case(name) {
            return t.name.clone();
        }
    }
    name.to_string()
}

fn read_anthropic_opt<'a>(opts: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    opts.get("anthropic")
        .and_then(Value::as_object)
        .and_then(|sub| sub.get(key))
        .or_else(|| opts.get(key))
}

/// Request-shaping limits for one Anthropic model, as the TS runtime resolved them from the
/// pi-ai 1.0.1 model table (`providers/anthropic.models.js`) before calling pi's `stream()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AnthropicModelSpec {
    /// pi `model.maxTokens`, sent as `max_tokens` when the caller sets no explicit cap.
    max_tokens: u64,
    /// pi `model.reasoning`: whether thinking options are honoured at all.
    reasoning: bool,
    /// pi `model.compat.forceAdaptiveThinking`: enabled thinking is sent as `{type: adaptive}`
    /// (budget ignored) and the interleaved-thinking beta is never added.
    force_adaptive_thinking: bool,
}

/// `claude-haiku-4-5`, `claude-opus-4-5` and `claude-sonnet-4-5` (incl. dated snapshots).
const BUDGET_THINKING_64K: AnthropicModelSpec = AnthropicModelSpec {
    max_tokens: 64_000,
    reasoning: true,
    force_adaptive_thinking: false,
};
/// Claude 4.6+ models: adaptive thinking with a 128k output cap.
const ADAPTIVE_THINKING_128K: AnthropicModelSpec = AnthropicModelSpec {
    max_tokens: 128_000,
    reasoning: true,
    force_adaptive_thinking: true,
};

/// Exact-id lookup mirroring TS `getAnthropicPiModel` (pi exact match, plus the
/// `claude-opus-4-8` override built from the 4.7 entry with `maxTokens: 128_000`). Unknown ids use
/// TS `buildAnthropicCustomPiModel`: 8192 output tokens, reasoning only for `claude` ids.
fn anthropic_model_spec(model_id: &str) -> AnthropicModelSpec {
    match model_id.trim() {
        "claude-haiku-4-5"
        | "claude-haiku-4-5-20251001"
        | "claude-opus-4-5"
        | "claude-opus-4-5-20251101"
        | "claude-sonnet-4-5"
        | "claude-sonnet-4-5-20250929" => BUDGET_THINKING_64K,
        "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-opus-4-7" | "claude-opus-4-8"
        | "claude-sonnet-5" | "claude-fable-5" | "claude-fable-5-1" | "claude-opus-5"
        | "claude-opus-5-5" | "claude-sonnet-5-5" => ADAPTIVE_THINKING_128K,
        other => AnthropicModelSpec {
            max_tokens: 8_192,
            reasoning: other.to_ascii_lowercase().contains("claude"),
            force_adaptive_thinking: false,
        },
    }
}

/// Anthropic requires `budget_tokens >= 1024`.
const MIN_THINKING_BUDGET_TOKENS: u64 = 1_024;
/// Output tokens kept for the answer when a budget would otherwise consume all of `max_tokens`
/// (pi `MIN_ANSWER_TOKENS`).
const MIN_ANSWER_TOKENS: u64 = 1_024;

fn resolve_cache_control(opts: &Map<String, Value>) -> Option<Value> {
    let retention = read_anthropic_opt(opts, "cacheRetention")
        .or_else(|| read_anthropic_opt(opts, "cache_retention"))
        .and_then(Value::as_str)
        .unwrap_or("short");

    match retention {
        "none" => None,
        "long" => Some(json!({ "type": "ephemeral", "ttl": "1h" })),
        _ => Some(json!({ "type": "ephemeral" })),
    }
}

/// Whether a history thinking block was produced by the Anthropic Messages API, so its
/// signature / redacted payload can be replayed as Anthropic signed thinking. Messages tagged with
/// another provider are foreign; untagged (legacy) messages count only when the block carries
/// Anthropic-specific thinking metadata.
fn is_anthropic_origin_thinking(
    msg: &CanonicalMessage,
    provider_meta: &ProviderOpaqueMeta,
) -> bool {
    match msg.provider.as_deref() {
        Some(provider) => provider == "anthropic",
        None => {
            provider_meta.anthropic_thinking_signature.is_some()
                || provider_meta.anthropic_redacted_thinking.is_some()
        }
    }
}

fn build_anthropic_messages_payload(
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
    is_oauth: bool,
) -> (Value, Vec<String>, Option<String>) {
    let tools_disabled = request_disables_all_tools(provider_options);
    let effective_tools: &[ToolDefinition] = if tools_disabled { &[] } else { tools };
    let native_plan = if tools_disabled || effective_tools.is_empty() {
        None
    } else {
        read_native_tool_calling_plan(provider_options)
    };
    let native_ts_kind = native_plan.as_ref().and_then(|p| p.tool_search);
    let native_ptc_active = native_plan
        .as_ref()
        .and_then(|p| p.programmatic_tool_calling)
        == Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120);

    let cache_control = resolve_cache_control(provider_options);
    let mut betas: Vec<String> = Vec::new();
    if is_oauth {
        betas.push("claude-code-20250219".to_string());
        betas.push("oauth-2025-04-20".to_string());
    }
    if !effective_tools.is_empty() {
        betas.push("fine-grained-tool-streaming-2025-05-14".to_string());
    }

    // TS `buildPiStreamOptions` + pi-ai 1.0.1 `stream()`/`buildParams`: thinking is only on when
    // `thinking.type` is `adaptive` or `enabled`; `effort` alone (or `disabled`) sends no
    // `thinking` field. Force-adaptive models (Claude 4.6+) turn an `enabled` budget config into
    // `{type: adaptive}` without the interleaved beta; older models send the budget as-is.
    let spec = anthropic_model_spec(model_id);
    let thinking_cfg = read_anthropic_opt(provider_options, "thinking").and_then(Value::as_object);
    let thinking_type = thinking_cfg
        .and_then(|t| t.get("type"))
        .and_then(Value::as_str);
    let thinking_enabled = matches!(thinking_type, Some("adaptive" | "enabled"));
    let explicit_effort = read_anthropic_opt(provider_options, "effort")
        .or_else(|| read_anthropic_opt(provider_options, "reasoningEffort"))
        .or_else(|| read_anthropic_opt(provider_options, "reasoning_effort"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "none" && *s != "off")
        .map(ToOwned::to_owned);
    let interleaved_thinking = read_anthropic_opt(provider_options, "interleavedThinking")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    // pi `buildParams`: `max_tokens: options.maxTokens ?? model.maxTokens`. TS never combined the
    // thinking budget into `max_tokens` (that is only pi's `streamSimple` path).
    let mut max_tokens = read_anthropic_opt(provider_options, "maxTokens")
        .or_else(|| read_anthropic_opt(provider_options, "max_tokens"))
        .or_else(|| read_anthropic_opt(provider_options, "maxOutputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(spec.max_tokens);

    let mut thinking_payload: Option<Value> = None;
    let mut active_effort: Option<String> = None;

    if spec.reasoning && thinking_enabled {
        if spec.force_adaptive_thinking {
            thinking_payload = Some(json!({
                "type": "adaptive",
                "display": "summarized",
            }));
            active_effort = explicit_effort;
        } else {
            // pi: `budget_tokens: options.thinkingBudgetTokens || 1024`, where TS only forwards
            // `budgetTokens` for `type: enabled`.
            let configured_budget = (thinking_type == Some("enabled"))
                .then(|| {
                    thinking_cfg
                        .and_then(|t| t.get("budgetTokens").or_else(|| t.get("budget_tokens")))
                        .and_then(Value::as_u64)
                })
                .flatten()
                .filter(|b| *b > 0)
                .unwrap_or(MIN_THINKING_BUDGET_TOKENS);
            let mut budget_tokens = configured_budget.max(MIN_THINKING_BUDGET_TOKENS);
            // Anthropic rejects `budget_tokens >= max_tokens`. pi would send that request as-is
            // and fail with a 400; instead shrink the budget to leave room for the answer, and
            // only raise `max_tokens` when even the minimum budget does not fit.
            if budget_tokens >= max_tokens {
                budget_tokens = max_tokens
                    .saturating_sub(MIN_ANSWER_TOKENS)
                    .max(MIN_THINKING_BUDGET_TOKENS);
                if budget_tokens >= max_tokens {
                    max_tokens = budget_tokens + MIN_ANSWER_TOKENS;
                }
            }
            thinking_payload = Some(json!({
                "type": "enabled",
                "budget_tokens": budget_tokens,
                "display": "summarized",
            }));
            if interleaved_thinking {
                betas.push("interleaved-thinking-2025-05-14".to_string());
            }
        }
    }

    let converted_messages =
        convert_messages_to_anthropic(messages, is_oauth, cache_control.as_ref());

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model_id.to_string()));
    body.insert("max_tokens".to_string(), json!(max_tokens));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("messages".to_string(), Value::Array(converted_messages));

    if native_ptc_active {
        if let Some(explicit_container) = read_anthropic_opt(provider_options, "container")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            body.insert(
                "container".to_string(),
                Value::String(explicit_container.to_string()),
            );
        } else if let Some(reused_container) = find_reusable_anthropic_container(messages) {
            body.insert("container".to_string(), Value::String(reused_container));
        }
    }

    // System prompt blocks + trailing cache_control breakpoint.
    let mut system_blocks: Vec<Value> = Vec::new();
    if is_oauth {
        system_blocks.push(json!({
            "type": "text",
            "text": CLAUDE_CODE_IDENTITY,
        }));
    }
    if !system_prompt.trim().is_empty() {
        system_blocks.push(json!({
            "type": "text",
            "text": system_prompt,
        }));
    }
    if let (Some(cc), Some(last_sys)) = (&cache_control, system_blocks.last_mut())
        && let Some(obj) = last_sys.as_object_mut()
    {
        obj.insert("cache_control".to_string(), cc.clone());
    }
    if !system_blocks.is_empty() {
        body.insert("system".to_string(), Value::Array(system_blocks));
    }

    // Temperature is incompatible with Anthropic thinking modes (`anthropic-messages.js`).
    if thinking_payload.is_none()
        && let Some(temp) =
            read_anthropic_opt(provider_options, "temperature").and_then(Value::as_f64)
    {
        body.insert("temperature".to_string(), json!(temp));
    }

    if let Some(thinking) = thinking_payload {
        body.insert("thinking".to_string(), thinking);
    }
    if let Some(effort) = &active_effort {
        body.insert("output_config".to_string(), json!({ "effort": effort }));
    }

    if !effective_tools.is_empty() {
        let deferred_set: HashSet<&str> = if native_ts_kind.is_some() {
            native_plan
                .as_ref()
                .map(|p| p.deferred_tool_names.iter().map(String::as_str).collect())
                .unwrap_or_default()
        } else {
            HashSet::new()
        };
        let programmatic_set: HashSet<&str> = if native_ptc_active {
            native_plan
                .as_ref()
                .map(|p| {
                    p.programmatic_tool_names
                        .iter()
                        .map(String::as_str)
                        .collect()
                })
                .unwrap_or_default()
        } else {
            HashSet::new()
        };

        // Anthropic rejects `cache_control` on any tool marked `defer_loading: true`, so place
        // the tool-list cache breakpoint on the last non-deferred custom tool (or fall back to
        // the server tool below when every custom tool is deferred).
        let last_non_deferred_idx = effective_tools
            .iter()
            .rposition(|t| !deferred_set.contains(t.name.as_str()));

        let mut wire_tools: Vec<Value> = effective_tools
            .iter()
            .enumerate()
            .map(|(idx, t)| {
                let mut tool_obj = Map::new();
                tool_obj.insert(
                    "name".to_string(),
                    Value::String(if is_oauth {
                        to_claude_code_name(&t.name)
                    } else {
                        t.name.clone()
                    }),
                );
                tool_obj.insert(
                    "description".to_string(),
                    Value::String(t.description.clone()),
                );
                tool_obj.insert(
                    "input_schema".to_string(),
                    anthropic_tool_input_schema(&t.parameters),
                );
                if deferred_set.contains(t.name.as_str()) {
                    tool_obj.insert("defer_loading".to_string(), Value::Bool(true));
                }
                if native_ptc_active
                    && programmatic_set.contains(t.name.as_str())
                    && is_programmatic_eligible_tool(
                        t,
                        NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120,
                    )
                {
                    tool_obj.insert(
                        "allowed_callers".to_string(),
                        json!(["direct", "code_execution_20260120"]),
                    );
                }
                if last_non_deferred_idx == Some(idx)
                    && let Some(cc) = &cache_control
                {
                    tool_obj.insert("cache_control".to_string(), cc.clone());
                }
                Value::Object(tool_obj)
            })
            .collect();

        if let Some(ts_kind) = native_ts_kind {
            let prefer_regex = matches!(ts_kind, NativeToolSearchKind::AnthropicRegex)
                || read_anthropic_opt(provider_options, "toolSearchVariant")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v.eq_ignore_ascii_case("regex"));
            let mut server_ts = if prefer_regex {
                json!({
                    "type": "tool_search_tool_regex_20251119",
                    "name": "tool_search_tool_regex",
                })
            } else {
                json!({
                    "type": "tool_search_tool_bm25_20251119",
                    "name": "tool_search_tool_bm25",
                })
            };
            if last_non_deferred_idx.is_none()
                && !native_ptc_active
                && let (Some(cc), Some(obj)) = (&cache_control, server_ts.as_object_mut())
            {
                obj.insert("cache_control".to_string(), cc.clone());
            }
            wire_tools.push(server_ts);
        }

        if native_ptc_active {
            let mut server_ce = json!({
                "type": "code_execution_20260120",
                "name": "code_execution",
            });
            if last_non_deferred_idx.is_none()
                && let (Some(cc), Some(obj)) = (&cache_control, server_ce.as_object_mut())
            {
                obj.insert("cache_control".to_string(), cc.clone());
            }
            wire_tools.push(server_ce);
        }

        body.insert("tools".to_string(), Value::Array(wire_tools));

        // Anthropic rejects `disable_parallel_tool_use: true` when programmatic tool calling is active.
        if !native_ptc_active
            && read_anthropic_opt(provider_options, "disableParallelToolUse")
                .and_then(Value::as_bool)
                == Some(true)
        {
            body.insert(
                "tool_choice".to_string(),
                json!({
                    "type": "auto",
                    "disable_parallel_tool_use": true,
                }),
            );
        }
    }

    (Value::Object(body), betas, active_effort)
}

fn find_reusable_anthropic_container(messages: &[CanonicalMessage]) -> Option<String> {
    let now = Utc::now();
    for msg in messages.iter().rev() {
        if msg.role != MessageRole::Assistant {
            continue;
        }
        let Some(container_val) = msg.provider_meta.extra.get("anthropicContainer") else {
            continue;
        };
        if let Some(id) = container_val
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(id.to_string());
        }
        let Some(obj) = container_val.as_object() else {
            continue;
        };
        let Some(id) = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if let Some(expires_at) = obj.get("expires_at").and_then(Value::as_str)
            && let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(expires_at)
            && parsed.with_timezone(&Utc) <= now
        {
            return None;
        }
        return Some(id.to_string());
    }
    None
}

/// Builds a tool's Anthropic `input_schema` from its (already normalized) parameter schema.
///
/// The complete schema is forwarded so root-level `$defs` / `definitions` referenced by nested
/// `$ref`s, `additionalProperties`, and every nested combinator reach the API intact; rebuilding
/// it from only `properties` / `required` leaves dangling references that make Anthropic reject
/// the whole request. Anthropic requires `type: "object"` at the root and rejects `oneOf` /
/// `allOf` / `anyOf` at the top level, so the root type is forced and root-level combinators are
/// dropped (nested ones are untouched). A non-object schema becomes an empty object schema.
fn anthropic_tool_input_schema(parameters: &Value) -> Value {
    let mut schema = parameters.as_object().cloned().unwrap_or_default();
    for combinator in ["oneOf", "allOf", "anyOf"] {
        schema.remove(combinator);
    }
    schema.insert("type".to_string(), Value::String("object".to_string()));
    if !schema.get("properties").is_some_and(Value::is_object) {
        schema.insert("properties".to_string(), json!({}));
    }
    Value::Object(schema)
}

fn convert_messages_to_anthropic(
    messages: &[CanonicalMessage],
    is_oauth: bool,
    cache_control: Option<&Value>,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut pending_tool_ids: Vec<String> = Vec::new();
    let mut satisfied_tool_ids = std::collections::HashSet::new();

    let flush_orphaned =
        |out: &mut Vec<Value>,
         pending: &mut Vec<String>,
         satisfied: &mut std::collections::HashSet<String>| {
            let missing: Vec<Value> = pending
                .drain(..)
                .filter(|id| !satisfied.contains(id))
                .map(|id| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": "No result provided",
                        "is_error": true,
                    })
                })
                .collect();
            satisfied.clear();
            push_anthropic_message(out, "user", missing);
        };

    let mut idx = 0;
    while idx < messages.len() {
        let msg = &messages[idx];
        match msg.role {
            MessageRole::System | MessageRole::Developer => {
                idx += 1;
            }
            MessageRole::User => {
                flush_orphaned(&mut out, &mut pending_tool_ids, &mut satisfied_tool_ids);
                let mut blocks = Vec::new();
                for b in &msg.content {
                    match b {
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Image,
                            source: MediaSource::Base64 { mime_type, data },
                            ..
                        } => {
                            blocks.push(json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime_type,
                                    "data": data,
                                }
                            }));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Document,
                            source: MediaSource::Base64 { mime_type, data },
                            ..
                        } => {
                            blocks.push(json!({
                                "type": "document",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime_type,
                                    "data": data,
                                }
                            }));
                        }
                        _ => {}
                    }
                }
                push_anthropic_message(&mut out, "user", blocks);
                idx += 1;
            }
            MessageRole::Assistant => {
                flush_orphaned(&mut out, &mut pending_tool_ids, &mut satisfied_tool_ids);
                let mut blocks = Vec::new();
                for b in &msg.content {
                    match b {
                        ContentBlock::Thinking {
                            text,
                            redacted,
                            provider_meta,
                            ..
                        } if !is_anthropic_origin_thinking(msg, provider_meta) => {
                            // Reasoning from another provider (e.g. an OpenAI Responses item whose
                            // serialized JSON lives in `signature`) can never verify as Anthropic
                            // signed thinking: replay its visible text only and drop opaque
                            // redacted payloads, matching the OpenAI transport's foreign handling.
                            if !*redacted && !text.trim().is_empty() {
                                blocks.push(json!({
                                    "type": "text",
                                    "text": text,
                                }));
                            }
                        }
                        ContentBlock::Thinking {
                            text,
                            redacted,
                            signature,
                            provider_meta,
                            ..
                        } => {
                            if *redacted || provider_meta.anthropic_redacted_thinking.is_some() {
                                let data = provider_meta
                                    .anthropic_redacted_thinking
                                    .as_deref()
                                    .or(signature.as_deref())
                                    .unwrap_or_default();
                                blocks.push(json!({
                                    "type": "redacted_thinking",
                                    "data": data,
                                }));
                                continue;
                            }
                            let sig = provider_meta
                                .anthropic_thinking_signature
                                .as_deref()
                                .or(signature.as_deref())
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            if let Some(sig) = sig {
                                blocks.push(json!({
                                    "type": "thinking",
                                    "thinking": text,
                                    "signature": sig,
                                }));
                            } else if !text.trim().is_empty() {
                                blocks.push(json!({
                                    "type": "text",
                                    "text": text,
                                }));
                            }
                        }
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                            blocks.push(json!({
                                "type": "text",
                                "text": text,
                            }));
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                            provider_meta,
                            ..
                        } => {
                            let clean_id = sanitize_anthropic_tool_id(id);
                            pending_tool_ids.push(clean_id.clone());
                            let mut block_obj = Map::new();
                            block_obj.insert("type".to_string(), Value::String("tool_use".into()));
                            block_obj.insert("id".to_string(), Value::String(clean_id));
                            block_obj.insert(
                                "name".to_string(),
                                Value::String(if is_oauth {
                                    to_claude_code_name(name)
                                } else {
                                    name.clone()
                                }),
                            );
                            block_obj.insert("input".to_string(), Value::Object(arguments.clone()));
                            if msg.provider.as_deref().is_none_or(|p| p == "anthropic")
                                && let Some(caller) = provider_meta
                                    .extra
                                    .get("anthropicCaller")
                                    .filter(|v| !v.is_null())
                            {
                                block_obj.insert("caller".to_string(), caller.clone());
                            }
                            blocks.push(Value::Object(block_obj));
                        }
                        ContentBlock::ProviderNativeTool { provider_meta, .. } => {
                            if msg.provider.as_deref().is_none_or(|p| p == "anthropic")
                                && let Some(raw_block) =
                                    provider_meta.extra.get("anthropicRawBlock")
                            {
                                blocks.push(raw_block.clone());
                            }
                        }
                        _ => {}
                    }
                }
                push_anthropic_message(&mut out, "assistant", blocks);
                idx += 1;
            }
            MessageRole::Tool => {
                // Collect consecutive tool-result messages into a single `user` turn (`anthropic-messages.js`).
                let mut tool_results = Vec::new();
                while idx < messages.len() && messages[idx].role == MessageRole::Tool {
                    for b in &messages[idx].content {
                        if let ContentBlock::ToolResult {
                            tool_call_id,
                            content,
                            is_error,
                            provider_meta,
                            ..
                        } = b
                        {
                            let clean_id = sanitize_anthropic_tool_id(tool_call_id);
                            satisfied_tool_ids.insert(clean_id.clone());
                            let is_programmatic_result = provider_meta
                                .extra
                                .get("anthropicCaller")
                                .and_then(|c| c.get("type"))
                                .and_then(Value::as_str)
                                .is_some_and(|t| t != "direct");
                            let mut inner_parts = Vec::new();
                            for part in content {
                                match part {
                                    ToolResultPart::Text { text } => {
                                        inner_parts.push(json!({ "type": "text", "text": text }));
                                    }
                                    ToolResultPart::Media {
                                        kind: MediaKind::Image,
                                        source: MediaSource::Base64 { mime_type, data },
                                    } => {
                                        if is_programmatic_result {
                                            inner_parts.push(json!({
                                                "type": "text",
                                                "text": format!("[image attachment ({mime_type}) omitted from programmatic tool result]"),
                                            }));
                                        } else {
                                            inner_parts.push(json!({
                                                "type": "image",
                                                "source": {
                                                    "type": "base64",
                                                    "media_type": mime_type,
                                                    "data": data,
                                                }
                                            }));
                                        }
                                    }
                                    ToolResultPart::Media {
                                        kind: MediaKind::Document,
                                        source: MediaSource::Base64 { mime_type, data },
                                    } => {
                                        if is_programmatic_result {
                                            inner_parts.push(json!({
                                                "type": "text",
                                                "text": format!("[document attachment ({mime_type}) omitted from programmatic tool result]"),
                                            }));
                                        } else {
                                            inner_parts.push(json!({
                                                "type": "document",
                                                "source": {
                                                    "type": "base64",
                                                    "media_type": mime_type,
                                                    "data": data,
                                                }
                                            }));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            tool_results.push(json!({
                                "type": "tool_result",
                                "tool_use_id": clean_id,
                                "content": inner_parts,
                                "is_error": is_error,
                            }));
                        }
                    }
                    idx += 1;
                }
                push_anthropic_message(&mut out, "user", tool_results);
            }
        }
    }

    flush_orphaned(&mut out, &mut pending_tool_ids, &mut satisfied_tool_ids);

    // Attach `cache_control` breakpoint to the last content block of the trailing `user` message.
    if let (Some(cc), Some(last_msg)) = (cache_control, out.last_mut())
        && last_msg.get("role").and_then(Value::as_str) == Some("user")
        && let Some(arr) = last_msg.get_mut("content").and_then(Value::as_array_mut)
        && let Some(last_block) = arr.last_mut().and_then(Value::as_object_mut)
    {
        last_block.insert("cache_control".to_string(), cc.clone());
    }

    out
}

/// Appends `blocks` as a `role` turn, merging into the previous entry when it has the same role.
///
/// Anthropic requires `user` / `assistant` turns to alternate, but several history shapes produce
/// adjacent same-role turns: synthesized orphan `tool_result`s followed by the next user message,
/// a `turn/steer` user message right after tool results, an earlier failed turn (`[User, User]`),
/// or a user message holding only unsupported media between two assistant turns. Merged `user`
/// turns keep every `tool_result` block ahead of the other blocks, as the API requires.
fn push_anthropic_message(out: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.get("role").and_then(Value::as_str) == Some(role)
        && let Some(existing) = last.get_mut("content").and_then(Value::as_array_mut)
    {
        existing.extend(blocks);
        if role == "user" {
            // Stable partition: tool_result blocks first, preserving relative order.
            let (mut results, rest): (Vec<Value>, Vec<Value>) = std::mem::take(existing)
                .into_iter()
                .partition(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"));
            results.extend(rest);
            *existing = results;
        }
        return;
    }
    out.push(json!({
        "role": role,
        "content": blocks,
    }));
}

fn sanitize_anthropic_tool_id(raw: &str) -> String {
    let base = raw.split('|').next().unwrap_or(raw);
    let mut cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }
    cleaned
}

enum AnthropicOpenBlock {
    Text {
        text: String,
        citations: Vec<Citation>,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        caller: Option<Value>,
        initial_input: Map<String, Value>,
        partial_json: String,
    },
    ServerToolUse {
        id: String,
        name: String,
        raw_block: Map<String, Value>,
        initial_input: Map<String, Value>,
        partial_json: String,
    },
    ServerToolResult {
        tool_use_id: String,
        block_type: String,
        raw_block: Value,
    },
}

struct AnthropicStreamState {
    turn_id: String,
    model_id: String,
    is_oauth: bool,
    declared_tools: Vec<ToolDefinition>,
    message_id: Option<String>,
    container: Option<Value>,
    pause_turn: bool,
    open_blocks: BTreeMap<usize, AnthropicOpenBlock>,
    finished_blocks: BTreeMap<usize, ContentBlock>,
    server_tool_names_by_id: HashMap<String, String>,
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
    stop_reason: StopReason,
    /// Set once `message_delta` carried a `stop_reason` (or `message_stop` arrived).
    stop_reason_seen: bool,
    /// Error message for a `refusal` / `sensitive` stop (pi-ai `mapStopReason`).
    stop_error: Option<String>,
    /// Finished tool_use blocks whose input was not strict JSON, awaiting the stop reason.
    deferred_tool_calls: BTreeMap<usize, DeferredToolCall>,
    completed: bool,
    raw_events: Vec<Value>,
}

struct DeferredToolCall {
    id: String,
    name: String,
    caller: Option<Value>,
    raw_json: String,
}

impl AnthropicStreamState {
    fn new(
        turn_id: String,
        model_id: String,
        is_oauth: bool,
        declared_tools: Vec<ToolDefinition>,
    ) -> Self {
        Self {
            turn_id,
            model_id,
            is_oauth,
            declared_tools,
            message_id: None,
            container: None,
            pause_turn: false,
            open_blocks: BTreeMap::new(),
            finished_blocks: BTreeMap::new(),
            server_tool_names_by_id: HashMap::new(),
            input_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 0,
            stop_reason: StopReason::Stop,
            stop_reason_seen: false,
            stop_error: None,
            deferred_tool_calls: BTreeMap::new(),
            completed: false,
            raw_events: Vec::new(),
        }
    }

    fn handle_event(
        &mut self,
        ev: AnthropicSseEvent,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<(), ProviderTransportError> {
        match ev.event_type.as_str() {
            "message_start" => {
                if let Some(msg) = ev.message.as_ref().and_then(Value::as_object) {
                    if let Some(id) = msg.get("id").and_then(Value::as_str) {
                        self.message_id = Some(id.to_string());
                    }
                    if let Some(c) = msg.get("container").filter(|v| !v.is_null()) {
                        self.container = Some(c.clone());
                    }
                    if let Some(u) = msg.get("usage").and_then(Value::as_object) {
                        self.update_usage_counters(u);
                    }
                }
            }
            "content_block_start" => {
                let idx = ev.index.unwrap_or(0);
                let Some(cb) = ev.content_block.as_ref().and_then(Value::as_object) else {
                    return Ok(());
                };
                let cb_type = cb.get("type").and_then(Value::as_str).unwrap_or_default();
                match cb_type {
                    "text" => {
                        let init = cb
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        emit(StreamEvent::TextStart {
                            turn_id: self.turn_id.clone(),
                            block_index: idx,
                            phase: None,
                        });
                        if !init.is_empty() {
                            emit(StreamEvent::TextDelta {
                                turn_id: self.turn_id.clone(),
                                block_index: idx,
                                delta: init.clone(),
                                phase: None,
                            });
                        }
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::Text {
                                text: init,
                                citations: Vec::new(),
                            },
                        );
                    }
                    "thinking" => {
                        let stream_id = format!("thinking_{idx}");
                        emit(StreamEvent::ThinkingStart {
                            turn_id: self.turn_id.clone(),
                            stream_id,
                            mode: ReasoningStreamMode::Reasoning,
                        });
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::Thinking {
                                thinking: cb
                                    .get("thinking")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                signature: cb
                                    .get("signature")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            },
                        );
                    }
                    "redacted_thinking" => {
                        let data = cb
                            .get("data")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let stream_id = format!("redacted_{idx}");
                        emit(StreamEvent::ThinkingStart {
                            turn_id: self.turn_id.clone(),
                            stream_id,
                            mode: ReasoningStreamMode::Summary,
                        });
                        self.open_blocks
                            .insert(idx, AnthropicOpenBlock::RedactedThinking { data });
                    }
                    "tool_use" => {
                        let id = cb
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("toolu_0")
                            .to_string();
                        let wire_name = cb.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let name = if self.is_oauth {
                            from_claude_code_name(wire_name, &self.declared_tools)
                        } else {
                            wire_name.to_string()
                        };
                        let caller = cb.get("caller").filter(|v| !v.is_null()).cloned();
                        let initial_input = cb
                            .get("input")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key: id.clone(),
                            name: name.clone(),
                            initial_args: (!initial_input.is_empty())
                                .then(|| initial_input.clone()),
                        });
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::ToolUse {
                                id,
                                name,
                                caller,
                                initial_input,
                                partial_json: String::new(),
                            },
                        );
                    }
                    "server_tool_use" => {
                        let id = cb
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("srvtoolu_0")
                            .to_string();
                        let name = cb
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("server_tool")
                            .to_string();
                        let initial_input = cb
                            .get("input")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        self.server_tool_names_by_id
                            .insert(id.clone(), name.clone());
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key: id.clone(),
                            name: name.clone(),
                            initial_args: (!initial_input.is_empty())
                                .then(|| initial_input.clone()),
                        });
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::ServerToolUse {
                                id,
                                name,
                                raw_block: cb.clone(),
                                initial_input,
                                partial_json: String::new(),
                            },
                        );
                    }
                    "tool_search_tool_result"
                    | "code_execution_tool_result"
                    | "bash_code_execution_tool_result"
                    | "text_editor_code_execution_tool_result"
                    | "web_search_tool_result"
                    | "web_fetch_tool_result" => {
                        let tool_use_id = cb
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("srvtoolu_0")
                            .to_string();
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::ServerToolResult {
                                tool_use_id,
                                block_type: cb_type.to_string(),
                                raw_block: Value::Object(cb.clone()),
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let idx = ev.index.unwrap_or(0);
                let Some(delta_obj) = ev.delta.as_ref().and_then(Value::as_object) else {
                    return Ok(());
                };
                let d_type = delta_obj
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                match (d_type, self.open_blocks.get_mut(&idx)) {
                    ("text_delta", Some(AnthropicOpenBlock::Text { text, .. })) => {
                        if let Some(chunk) = delta_obj.get("text").and_then(Value::as_str) {
                            text.push_str(chunk);
                            emit(StreamEvent::TextDelta {
                                turn_id: self.turn_id.clone(),
                                block_index: idx,
                                delta: chunk.to_string(),
                                phase: None,
                            });
                        }
                    }
                    ("citations_delta", Some(AnthropicOpenBlock::Text { citations, .. })) => {
                        if let Some(cit) = delta_obj.get("citation") {
                            citations.extend(extract_nested_citations(cit));
                        }
                    }
                    ("thinking_delta", Some(AnthropicOpenBlock::Thinking { thinking, .. })) => {
                        if let Some(chunk) = delta_obj.get("thinking").and_then(Value::as_str) {
                            thinking.push_str(chunk);
                            emit(StreamEvent::ThinkingDelta {
                                turn_id: self.turn_id.clone(),
                                stream_id: format!("thinking_{idx}"),
                                mode: ReasoningStreamMode::Reasoning,
                                delta: chunk.to_string(),
                            });
                        }
                    }
                    ("signature_delta", Some(AnthropicOpenBlock::Thinking { signature, .. })) => {
                        if let Some(sig) = delta_obj.get("signature").and_then(Value::as_str) {
                            signature.push_str(sig);
                        }
                    }
                    (
                        "input_json_delta",
                        Some(
                            AnthropicOpenBlock::ToolUse {
                                id,
                                name,
                                partial_json,
                                ..
                            }
                            | AnthropicOpenBlock::ServerToolUse {
                                id,
                                name,
                                partial_json,
                                ..
                            },
                        ),
                    ) => {
                        if let Some(chunk) = delta_obj.get("partial_json").and_then(Value::as_str) {
                            partial_json.push_str(chunk);
                            emit(StreamEvent::ToolCallDelta {
                                turn_id: self.turn_id.clone(),
                                key: id.clone(),
                                name: name.clone(),
                                delta: chunk.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let idx = ev.index.unwrap_or(0);
                if let Some(open) = self.open_blocks.remove(&idx) {
                    match open {
                        AnthropicOpenBlock::Text { text, citations } => {
                            emit(StreamEvent::TextEnd {
                                turn_id: self.turn_id.clone(),
                                block_index: idx,
                                text: text.clone(),
                                phase: None,
                                citations: citations.clone(),
                                annotations: Vec::new(),
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::Text {
                                    text,
                                    phase: None,
                                    citations,
                                    provider_meta: ProviderOpaqueMeta::default(),
                                },
                            );
                        }
                        AnthropicOpenBlock::Thinking {
                            thinking,
                            signature,
                        } => {
                            let sig_opt = (!signature.is_empty()).then_some(signature);
                            emit(StreamEvent::ThinkingEnd {
                                turn_id: self.turn_id.clone(),
                                stream_id: format!("thinking_{idx}"),
                                mode: ReasoningStreamMode::Reasoning,
                                text: thinking.clone(),
                                signature: sig_opt.clone(),
                                redacted: false,
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::Thinking {
                                    text: thinking,
                                    summary: None,
                                    redacted: false,
                                    signature: sig_opt.clone(),
                                    provider_meta: ProviderOpaqueMeta {
                                        anthropic_thinking_signature: sig_opt,
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                        AnthropicOpenBlock::RedactedThinking { data } => {
                            emit(StreamEvent::ThinkingEnd {
                                turn_id: self.turn_id.clone(),
                                stream_id: format!("redacted_{idx}"),
                                mode: ReasoningStreamMode::Summary,
                                text: String::new(),
                                signature: Some(data.clone()),
                                redacted: true,
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::Thinking {
                                    text: String::new(),
                                    summary: None,
                                    redacted: true,
                                    signature: Some(data.clone()),
                                    provider_meta: ProviderOpaqueMeta {
                                        anthropic_redacted_thinking: Some(data),
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                        AnthropicOpenBlock::ToolUse {
                            id,
                            name,
                            caller,
                            initial_input,
                            partial_json,
                        } => {
                            // Anthropic sends `content_block_stop` for a tool_use cut off by the
                            // token limit and only reports `stop_reason: max_tokens` afterwards in
                            // `message_delta`. Input that is complete JSON is final either way;
                            // anything else waits for the stop reason before it is repaired (or
                            // rejected as truncated) and surfaced as a tool call.
                            let strict_args = if partial_json.trim().is_empty() {
                                Some(initial_input)
                            } else {
                                serde_json::from_str::<Map<String, Value>>(&partial_json).ok()
                            };
                            match strict_args {
                                Some(args) => {
                                    self.finish_tool_call(idx, id, name, caller, args, emit)
                                }
                                None => {
                                    self.deferred_tool_calls.insert(
                                        idx,
                                        DeferredToolCall {
                                            id,
                                            name,
                                            caller,
                                            raw_json: partial_json,
                                        },
                                    );
                                    if self.stop_reason_seen {
                                        self.resolve_deferred_tool_calls(emit)?;
                                    }
                                }
                            }
                        }
                        AnthropicOpenBlock::ServerToolUse {
                            id,
                            name,
                            mut raw_block,
                            initial_input,
                            partial_json,
                        } => {
                            let args = if partial_json.trim().is_empty() {
                                initial_input
                            } else {
                                serde_json::from_str::<Map<String, Value>>(&partial_json)
                                    .unwrap_or_else(|_| parse_partial_json_object(&partial_json))
                            };
                            raw_block.insert("input".to_string(), Value::Object(args.clone()));
                            emit(StreamEvent::ToolCallEnd {
                                turn_id: self.turn_id.clone(),
                                key: id.clone(),
                                name: name.clone(),
                                arguments: Some(args.clone()),
                                retry_of: None,
                                input_digest: None,
                            });
                            let mut extra = Map::new();
                            extra.insert("anthropicRawBlock".to_string(), Value::Object(raw_block));
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::ProviderNativeTool {
                                    id,
                                    name,
                                    role: ProviderNativeToolRole::Call,
                                    arguments: args,
                                    result: None,
                                    is_error: false,
                                    citations: Vec::new(),
                                    provider_meta: ProviderOpaqueMeta {
                                        extra,
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                        AnthropicOpenBlock::ServerToolResult {
                            tool_use_id,
                            block_type,
                            raw_block,
                        } => {
                            let name = self
                                .server_tool_names_by_id
                                .get(&tool_use_id)
                                .cloned()
                                .unwrap_or_else(|| {
                                    default_server_tool_name_for_result_block(&block_type)
                                        .to_string()
                                });
                            let content_val =
                                raw_block.get("content").cloned().unwrap_or(Value::Null);
                            let (output, is_error) =
                                summarize_anthropic_server_tool_result(&block_type, &content_val);
                            emit(StreamEvent::ToolResult {
                                turn_id: self.turn_id.clone(),
                                key: tool_use_id.clone(),
                                name: name.clone(),
                                result: json!({
                                    "summary": output,
                                    "content": content_val,
                                }),
                                is_error,
                                denied: false,
                            });
                            let mut extra = Map::new();
                            extra.insert("anthropicRawBlock".to_string(), raw_block);
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::ProviderNativeTool {
                                    id: tool_use_id,
                                    name,
                                    role: ProviderNativeToolRole::Result,
                                    arguments: Map::new(),
                                    result: Some(content_val),
                                    is_error,
                                    citations: Vec::new(),
                                    provider_meta: ProviderOpaqueMeta {
                                        extra,
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(u) = ev.usage.as_ref().and_then(Value::as_object) {
                    self.update_usage_counters(u);
                }
                if let Some(c) = ev
                    .container
                    .as_ref()
                    .or_else(|| ev.delta.as_ref().and_then(|d| d.get("container")))
                    .filter(|v| !v.is_null())
                {
                    self.container = Some(c.clone());
                }
                if let Some(d) = ev.delta.as_ref().and_then(Value::as_object)
                    && let Some(sr) = d.get("stop_reason").and_then(Value::as_str)
                {
                    // pi-ai `mapStopReason`: `refusal` / `sensitive` are error stops whose message
                    // the TS runtime raised as the turn failure.
                    self.stop_reason = match sr {
                        "tool_use" => StopReason::ToolUse,
                        "max_tokens" => StopReason::Length,
                        "pause_turn" => {
                            self.pause_turn = true;
                            StopReason::Stop
                        }
                        "refusal" => {
                            self.stop_error = Some(
                                d.get("stop_details")
                                    .and_then(|details| details.get("explanation"))
                                    .and_then(Value::as_str)
                                    .filter(|text| !text.is_empty())
                                    .unwrap_or("The model refused to complete the request")
                                    .to_string(),
                            );
                            StopReason::Error
                        }
                        "sensitive" => {
                            self.stop_error = Some("Provider stopped with: sensitive".to_string());
                            StopReason::Error
                        }
                        _ => StopReason::Stop,
                    };
                    self.stop_reason_seen = true;
                    self.resolve_deferred_tool_calls(emit)?;
                }
            }
            "message_stop" => {
                self.stop_reason_seen = true;
                self.resolve_deferred_tool_calls(emit)?;
                self.completed = true;
            }
            "error" => {
                let msg = ev
                    .error
                    .as_ref()
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Anthropic stream error");
                return Err(ProviderTransportError::protocol(msg));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish_tool_call(
        &mut self,
        idx: usize,
        id: String,
        name: String,
        caller: Option<Value>,
        args: Map<String, Value>,
        emit: &mut dyn FnMut(StreamEvent),
    ) {
        emit(StreamEvent::ToolCallEnd {
            turn_id: self.turn_id.clone(),
            key: id.clone(),
            name: name.clone(),
            arguments: Some(args.clone()),
            retry_of: None,
            input_digest: None,
        });
        let mut extra = Map::new();
        if let Some(caller_val) = caller {
            extra.insert("anthropicCaller".to_string(), caller_val);
        }
        self.finished_blocks.insert(
            idx,
            ContentBlock::ToolCall {
                id,
                name,
                arguments: args,
                partial_json: None,
                provider_meta: ProviderOpaqueMeta {
                    extra,
                    ..Default::default()
                },
            },
        );
    }

    /// Settles tool calls whose input was not strict JSON once the stop reason is known. A
    /// `max_tokens` stop means that input was truncated: fail the step with the same retryable
    /// error kind as Chat Completions instead of repairing it into an executable call. Error stops
    /// (`refusal` / `sensitive`) fail in `finish`, so their calls are never surfaced. Any other stop
    /// keeps the lenient TS-parity repair.
    fn resolve_deferred_tool_calls(
        &mut self,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<(), ProviderTransportError> {
        if self.deferred_tool_calls.is_empty() || self.stop_error.is_some() {
            return Ok(());
        }
        if self.stop_reason == StopReason::Length {
            return Err(ProviderTransportError::network(
                "Anthropic stream ended with incomplete tool call arguments.",
            ));
        }
        for (idx, call) in std::mem::take(&mut self.deferred_tool_calls) {
            let args = parse_partial_json_object(&call.raw_json);
            self.finish_tool_call(idx, call.id, call.name, call.caller, args, emit);
        }
        Ok(())
    }

    fn update_usage_counters(&mut self, u: &Map<String, Value>) {
        if let Some(v) = u.get("input_tokens").and_then(Value::as_u64) {
            self.input_tokens = v;
        }
        if let Some(v) = u.get("cache_read_input_tokens").and_then(Value::as_u64) {
            self.cache_read_tokens = v;
        }
        if let Some(v) = u.get("cache_creation_input_tokens").and_then(Value::as_u64) {
            self.cache_write_tokens = v;
        }
        if let Some(v) = u.get("output_tokens").and_then(Value::as_u64) {
            self.output_tokens = v;
        }
    }

    fn finish(
        self,
        effort_meta: Option<String>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        // A stream that closes without `message_stop`, or with any content block still open, was
        // truncated: never surface partial text as a normal stop or return finished tool calls
        // from an incomplete message (same retryable error kind as Google Interactions).
        if !self.completed {
            return Err(ProviderTransportError::network(
                "Anthropic stream ended before message_stop.",
            ));
        }
        if !self.open_blocks.is_empty() {
            return Err(ProviderTransportError::network(
                "Anthropic stream ended with unfinished content.",
            ));
        }
        // TS threw `errorMessage` for a pi `error` stop reason; it is not a transient failure.
        if let Some(message) = self.stop_error {
            return Err(ProviderTransportError::protocol(message));
        }
        if !self.deferred_tool_calls.is_empty() {
            return Err(ProviderTransportError::network(
                "Anthropic stream ended with incomplete tool call arguments.",
            ));
        }

        let content: Vec<ContentBlock> = self.finished_blocks.into_values().collect();
        let prompt_tokens = self.input_tokens + self.cache_read_tokens + self.cache_write_tokens;
        let usage = TurnUsage {
            prompt_tokens,
            completion_tokens: self.output_tokens,
            total_tokens: prompt_tokens + self.output_tokens,
            cached_prompt_tokens: (self.cache_read_tokens > 0).then_some(self.cache_read_tokens),
            cache_write_prompt_tokens: (self.cache_write_tokens > 0)
                .then_some(self.cache_write_tokens),
            reasoning_output_tokens: None,
            estimated_cost_usd: None,
        };

        let mut extra = Map::new();
        if let Some(container) = self.container {
            extra.insert("anthropicContainer".to_string(), container);
        }
        if self.pause_turn {
            extra.insert("requiresContinuationStep".to_string(), Value::Bool(true));
        }

        let assistant = CanonicalMessage {
            id: self
                .message_id
                .unwrap_or_else(|| format!("msg_{}", Uuid::new_v4())),
            role: MessageRole::Assistant,
            content,
            phase: None,
            provider: Some("anthropic".to_string()),
            api: Some("anthropic-messages".to_string()),
            model: Some(self.model_id),
            stop_reason: Some(self.stop_reason),
            provider_meta: ProviderOpaqueMeta {
                anthropic_effort: effort_meta,
                extra,
                ..Default::default()
            },
            created_at: Utc::now().to_rfc3339(),
        };

        let persisted_assistant = filter_persisted_assistant_history(&assistant);
        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage,
            continuation: None,
            raw_events: self.raw_events,
        })
    }
}

fn default_server_tool_name_for_result_block(block_type: &str) -> &'static str {
    match block_type {
        "tool_search_tool_result" => "tool_search_tool_bm25",
        "code_execution_tool_result" => "code_execution",
        "bash_code_execution_tool_result" => "bash_code_execution",
        "text_editor_code_execution_tool_result" => "text_editor_code_execution",
        "web_search_tool_result" => "web_search",
        "web_fetch_tool_result" => "web_fetch",
        _ => "server_tool",
    }
}

fn summarize_anthropic_server_tool_result(block_type: &str, content: &Value) -> (String, bool) {
    if let Some(obj) = content.as_object() {
        let inner_type = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        if inner_type.ends_with("_error") {
            let err_code = obj
                .get("error_code")
                .and_then(Value::as_str)
                .unwrap_or("server_tool_error");
            return (format!("{block_type} error: {err_code}"), true);
        }
        if inner_type == "tool_search_tool_search_result"
            && let Some(refs) = obj.get("tool_references").and_then(Value::as_array)
        {
            let names: Vec<&str> = refs
                .iter()
                .filter_map(|r| r.get("tool_name").and_then(Value::as_str))
                .collect();
            if names.is_empty() {
                return ("No matching tools found.".to_string(), false);
            }
            return (format!("Matched tools: {}", names.join(", ")), false);
        }
        if matches!(
            inner_type,
            "code_execution_result"
                | "bash_code_execution_result"
                | "encrypted_code_execution_result"
        ) {
            let return_code = obj.get("return_code").and_then(Value::as_i64).unwrap_or(0);
            let stdout = obj
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let stderr = obj
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut parts = Vec::new();
            if !stdout.is_empty() {
                parts.push(stdout.to_string());
            }
            if !stderr.is_empty() {
                parts.push(stderr.to_string());
            }
            let summary = if parts.is_empty() {
                format!("exit code {return_code}")
            } else {
                parts.join("\n")
            };
            return (summary, return_code != 0);
        }
    }
    (content.to_string(), false)
}

#[cfg(test)]
#[path = "anthropic_native_rejection_tests.rs"]
mod anthropic_native_rejection_tests;
