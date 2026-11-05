use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use chrono::Utc;
use cowork_inference::{
    CanonicalMessage, Citation, ContentBlock, ContinuationFingerprintInput, MediaKind, MediaSource,
    MessageRole, ProviderContinuationState, ProviderNativeToolRole, ProviderOpaqueMeta,
    ProviderTransportError, ReasoningStreamMode, StepBudget, StopReason, StreamEvent, TextPhase,
    ToolResultPart, TurnUsage, compose_openai_tool_call_id, compute_continuation_fingerprint,
    execute_step_with_sink, extract_nested_citations, filter_persisted_assistant_history,
    sanitize_openai_composite_tool_id, split_openai_tool_call_id, validate_continuation_state,
};
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::endpoint_capabilities::{
    EndpointToolCapabilities, NativeProgrammaticToolCallingKind, NativeToolCallingPlan,
    NativeToolSearchKind, read_native_tool_calling_plan, record_rejected_native_capability,
    resolve_endpoint_tool_capabilities, write_native_tool_calling_plan,
};
use crate::sse::{build_http_client, post_json_sse};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    ToolDefinition, candidate_continuation_splits, request_disables_all_tools,
};

const OPENAI_PROVIDER: &str = "openai";
const OPENAI_RESPONSES_API: &str = "openai-responses";

/// Native Rust SSE wire transport for the OpenAI Responses API (`POST /v1/responses`).
#[derive(Debug, Clone)]
pub struct OpenAiResponsesTransport {
    client: reqwest::Client,
    /// `previous_response_id` handles OpenAI rejected through this transport. The harness
    /// retries a failed step with the same request (and the server builds one transport per
    /// turn), so a handle rejected once is never sent again from this instance.
    rejected_response_ids: Arc<parking_lot::Mutex<HashSet<String>>>,
}

impl Default for OpenAiResponsesTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiResponsesTransport {
    pub fn new() -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
            rejected_response_ids: Arc::default(),
        }
    }
}

/// Loose SSE envelope for OpenAI Responses events.
/// Intentionally omits `#[serde(deny_unknown_fields)]` so additive vendor fields never break streaming.
#[derive(Debug, Clone, Deserialize)]
struct OpenAiResponsesSseEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    output_index: Option<usize>,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    response: Option<Value>,
    #[serde(default)]
    item: Option<Value>,
    #[serde(default)]
    part: Option<Value>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

#[async_trait]
impl ProviderTransport for OpenAiResponsesTransport {
    fn native_tool_capabilities(
        &self,
        base_url: Option<&str>,
        model_id: &str,
        strategy: cowork_config::ToolCallingStrategy,
    ) -> EndpointToolCapabilities {
        resolve_endpoint_tool_capabilities(
            cowork_config::ProviderName::Openai,
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
        let api_key = resolve_openai_api_key(request.api_key.as_deref(), allow_ambient_env)?;
        let base_url = request
            .base_url
            .as_deref()
            .unwrap_or_else(|| {
                crate::default_inference_base_url(cowork_config::ProviderName::Openai)
            })
            .trim_end_matches('/');
        let endpoint = format!("{base_url}/responses");

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let auth_val = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| {
            ProviderTransportError::protocol(format!("Invalid API key header: {e}"))
        })?;
        headers.insert(AUTHORIZATION, auth_val);
        for (k, v) in &request.extra_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }

        let tool_values: Vec<Value> = request
            .tools
            .iter()
            .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
            .collect();

        let mut effective_provider_options = request.provider_options.clone();

        // Check SHA-256 continuation fingerprint against candidate prefixes.
        let mut active_previous_response_id: Option<String> = None;
        let mut input_messages_slice: &[CanonicalMessage] = &request.messages;

        if let Some(stored) = &request.continuation {
            for (prefix, delta) in candidate_continuation_splits(&request.messages) {
                let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: "openai",
                    model_id: &request.model_id,
                    system_prompt: &request.system_prompt,
                    tools: &tool_values,
                    authorized_tool_names: request.authorized_tool_names.as_deref(),
                    canonical_prefix: prefix,
                    stream_options: &effective_provider_options,
                });
                if let Some(ProviderContinuationState::OpenAi { response_id, .. }) =
                    validate_continuation_state(Some(stored), "openai", &request.model_id, &fp)
                {
                    if !self.rejected_response_ids.lock().contains(response_id) {
                        active_previous_response_id = Some(response_id.clone());
                        input_messages_slice = delta;
                    }
                    break;
                }
            }
        }

        let wire_body = build_openai_responses_payload(
            &request.model_id,
            &request.system_prompt,
            input_messages_slice,
            &request.messages,
            &request.tools,
            &effective_provider_options,
            active_previous_response_id.as_deref(),
        );

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
            )
            .await;
        let mut step_result = match (first_result, active_previous_response_id.as_deref()) {
            (Ok(result), _) => result,
            // `runUserMessageTurn.ts` parity: a stored continuation handle OpenAI rejects is
            // dropped and the step is retried once from the full local transcript, but only
            // while nothing visible has streamed and the turn is still live.
            (Err(err), Some(rejected_id))
                if !emitted_visible.load(Ordering::SeqCst)
                    && !budget.cancellation_token().is_cancelled()
                    && is_invalid_openai_continuation_error(&err) =>
            {
                self.rejected_response_ids
                    .lock()
                    .insert(rejected_id.to_owned());
                tracing::warn!(
                    previous_response_id = rejected_id,
                    error = %err.message,
                    "stored openai continuation handle was rejected; retrying from local transcript"
                );
                let full_body = build_openai_responses_payload(
                    &request.model_id,
                    &request.system_prompt,
                    &request.messages,
                    &request.messages,
                    &request.tools,
                    &effective_provider_options,
                    None,
                );
                self.run_attempts(
                    &request,
                    budget,
                    on_event,
                    &emitted_visible,
                    &endpoint,
                    &headers,
                    full_body,
                )
                .await?
            }
            (Err(err), _) => {
                if !emitted_visible.load(Ordering::SeqCst)
                    && !budget.cancellation_token().is_cancelled()
                    && let Some(active_plan) =
                        read_native_tool_calling_plan(&effective_provider_options)
                {
                    let (rej_ts, rej_ptc) =
                        classify_rejected_openai_native_tool_error(&err, &active_plan);
                    if rej_ts || rej_ptc {
                        record_rejected_native_capability(
                            cowork_config::ProviderName::Openai,
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
                            "openai endpoint rejected native tool feature; retrying with plain tools"
                        );
                        let fallback_body = build_openai_responses_payload(
                            &request.model_id,
                            &request.system_prompt,
                            &request.messages,
                            &request.messages,
                            &request.tools,
                            &effective_provider_options,
                            None,
                        );
                        self.run_attempts(
                            &request,
                            budget,
                            on_event,
                            &emitted_visible,
                            &endpoint,
                            &headers,
                            fallback_body,
                        )
                        .await?
                    } else {
                        return Err(err);
                    }
                } else {
                    return Err(err);
                }
            }
        };

        if let Some(ProviderContinuationState::OpenAi {
            request_fingerprint,
            ..
        }) = &mut step_result.continuation
        {
            let mut next_prefix = request.messages.clone();
            if let Some(persisted) = &step_result.persisted_assistant {
                next_prefix.push(persisted.clone());
            }
            *request_fingerprint =
                compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: "openai",
                    model_id: &request.model_id,
                    system_prompt: &request.system_prompt,
                    tools: &tool_values,
                    authorized_tool_names: request.authorized_tool_names.as_deref(),
                    canonical_prefix: &next_prefix,
                    stream_options: &effective_provider_options,
                });
        }

        Ok(step_result)
    }
}

impl OpenAiResponsesTransport {
    /// Runs one Responses request (with the policy's pre-output retries), recording in
    /// `emitted_visible` whether any visible output reached `on_event`.
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
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let mut sink = |ev: StreamEvent| {
            if ev.is_visible_output() {
                emitted_visible.store(true, Ordering::SeqCst);
            }
            on_event(ev);
        };
        let attempt_timeout_ms = request.policy.timeout_ms;
        execute_step_with_sink(
            &request.policy,
            budget,
            &mut sink,
            &mut |_attempt_no, mut emit| {
                let client = self.client.clone();
                let endpoint = endpoint.to_owned();
                let headers = headers.clone();
                let wire_body = wire_body.clone();
                let turn_id = request.turn_id.clone();
                let model_id = request.model_id.clone();

                async move {
                    let timeout_dur = budget.attempt_timeout(attempt_timeout_ms)?;
                    let mut sse =
                        post_json_sse(&client, &endpoint, headers, &wire_body, timeout_dur).await?;

                    let mut decoder = OpenAiStreamState::new(turn_id, model_id);
                    while let Some(frame_res) = sse.next().await {
                        let frame = frame_res?;
                        let trimmed = frame.data.trim();
                        if trimmed.is_empty() || trimmed == "[DONE]" {
                            continue;
                        }
                        let raw_json: Value = serde_json::from_str(trimmed).map_err(|err| {
                            ProviderTransportError::protocol(format!(
                                "Invalid JSON in OpenAI Responses SSE frame: {err}"
                            ))
                        })?;
                        decoder.raw_events.push(raw_json.clone());
                        let env: OpenAiResponsesSseEnvelope = serde_json::from_value(raw_json)
                            .map_err(|err| {
                                ProviderTransportError::protocol(format!(
                                    "Malformed OpenAI Responses event: {err}"
                                ))
                            })?;
                        decoder.handle_event(env, &mut *emit)?;
                    }

                    decoder.finish(String::new())
                }
            },
        )
        .await
    }
}

/// `isInvalidOpenAiContinuationError` parity (`continuationPolicy.ts`): the error mentions the
/// previous response handle and says it is not found / invalid / expired / unknown / missing.
/// OpenAI's `previous_response_not_found` error code is matched directly as well.
fn is_invalid_openai_continuation_error(err: &ProviderTransportError) -> bool {
    if err.is_abort {
        return false;
    }
    if err.code.as_deref().is_some_and(|code| {
        code.trim()
            .eq_ignore_ascii_case("previous_response_not_found")
    }) {
        return true;
    }
    let normalized = err.message.to_lowercase();
    if normalized.contains("previous_response_not_found") {
        return true;
    }
    let mentions_previous_response = normalized.contains("previous_response_id")
        || normalized.contains("previous response")
        || normalized.contains("response_id");
    mentions_previous_response
        && [
            "not found",
            "invalid",
            "expired",
            "unknown",
            "does not exist",
        ]
        .iter()
        .any(|needle| normalized.contains(needle))
}

fn resolve_openai_api_key(
    explicit: Option<&str>,
    allow_ambient_env: bool,
) -> Result<String, ProviderTransportError> {
    if let Some(key) = explicit.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(key.to_string());
    }
    if allow_ambient_env
        && let Ok(env_key) = std::env::var("OPENAI_API_KEY")
        && !env_key.trim().is_empty()
    {
        return Ok(env_key.trim().to_string());
    }
    Err(ProviderTransportError::protocol(
        "No API key for provider: openai",
    ))
}

fn is_astra_model(model_id: &str) -> bool {
    let lower = model_id.trim().to_ascii_lowercase();
    lower == "gpt-6-astra" || lower.starts_with("gpt-6-astra-")
}

fn supports_xhigh_reasoning(model_id: &str) -> bool {
    let lower = model_id.trim().to_ascii_lowercase();
    lower == "gpt-5.5"
        || lower.starts_with("gpt-5.5-")
        || lower == "gpt-5.4"
        || lower.starts_with("gpt-5.4-")
        || lower == "gpt-5.2"
        || lower.starts_with("gpt-5.2-")
        || lower.starts_with("gpt-6")
}

fn normalize_openai_reasoning_effort(raw: Option<&str>, model_id: &str) -> Option<String> {
    let is_astra = is_astra_model(model_id);
    let normalized = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_ascii_lowercase();

    // GPT-6 Astra (`agent_docs/astra.md`): `none` is unsupported; migrate `none` or `minimal` -> `low`.
    if is_astra && (normalized == "none" || normalized == "minimal") {
        return Some("low".to_string());
    }
    if normalized == "none" {
        return None;
    }
    if normalized == "xhigh" || normalized == "max" {
        return Some(if supports_xhigh_reasoning(model_id) {
            "xhigh".to_string()
        } else {
            "high".to_string()
        });
    }
    if normalized == "light" {
        return Some("low".to_string());
    }
    if matches!(normalized.as_str(), "minimal" | "low" | "medium" | "high") {
        return Some(normalized);
    }
    None
}

fn classify_rejected_openai_native_tool_error(
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
    let mentions_ts = lower.contains("tool_search")
        || lower.contains("openrouter:tool_search")
        || lower.contains("defer_loading");
    let mentions_ptc =
        lower.contains("programmatic_tool_calling") || lower.contains("allowed_callers");
    if mentions_ts || mentions_ptc {
        return (
            mentions_ts && plan.tool_search.is_some(),
            mentions_ptc && plan.programmatic_tool_calling.is_some(),
        );
    }
    let generic_tool_schema_rejection = (lower.contains("tools[")
        || lower.contains("param: tools"))
        && (lower.contains("invalid")
            || lower.contains("unknown")
            || lower.contains("unsupported")
            || lower.contains("not supported")
            || lower.contains("unrecognized"));
    if generic_tool_schema_rejection {
        return (
            plan.tool_search.is_some(),
            plan.programmatic_tool_calling.is_some(),
        );
    }
    (false, false)
}

fn read_provider_opt<'a>(opts: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    opts.get("openai")
        .and_then(Value::as_object)
        .and_then(|sub| sub.get(key))
        .or_else(|| opts.get(key))
}

fn build_openai_responses_payload(
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    full_messages: &[CanonicalMessage],
    tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
    previous_response_id: Option<&str>,
) -> Value {
    let is_astra = is_astra_model(model_id);
    let mut input_items = convert_messages_to_responses_input(model_id, messages, full_messages);

    let effort_raw = read_provider_opt(provider_options, "reasoningEffort")
        .or_else(|| read_provider_opt(provider_options, "reasoning_effort"))
        .or_else(|| read_provider_opt(provider_options, "effort"))
        .and_then(Value::as_str);
    let summary_raw =
        read_provider_opt(provider_options, "reasoningSummary").and_then(Value::as_str);

    let effort = normalize_openai_reasoning_effort(effort_raw, model_id)
        .or_else(|| is_astra.then(|| "low".to_string()));

    let reasoning_obj = if effort.is_some() || summary_raw.is_some() {
        Some(json!({
            "effort": effort.unwrap_or_else(|| "medium".to_string()),
            "summary": summary_raw.unwrap_or("auto"),
        }))
    } else {
        None
    };

    // Non-reasoning GPT-5 calls append `# Juice: 0 !important` developer instruction (`openaiNativeResponses.ts`),
    // except on an empty `previous_response_id` continuation step (`program_output` -> final answer).
    if reasoning_obj.is_none()
        && model_id.trim().to_ascii_lowercase().starts_with("gpt-5")
        && !(previous_response_id.is_some() && messages.is_empty())
    {
        input_items.push(json!({
            "role": "developer",
            "content": [{"type": "input_text", "text": "# Juice: 0 !important"}]
        }));
    }

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model_id.to_string()));
    body.insert(
        "instructions".to_string(),
        Value::String(system_prompt.to_string()),
    );
    body.insert("input".to_string(), Value::Array(input_items));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("store".to_string(), Value::Bool(true));

    // `truncation: "auto"` is sent on every request, with or without a continuation
    // (`buildOpenAiContinuationRequestOptions` parity).
    body.insert("truncation".to_string(), Value::String("auto".to_string()));
    if let Some(prev_id) = previous_response_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        body.insert(
            "previous_response_id".to_string(),
            Value::String(prev_id.to_string()),
        );
    }

    if let Some(max_toks) = read_provider_opt(provider_options, "maxTokens")
        .or_else(|| read_provider_opt(provider_options, "maxOutputTokens"))
        .or_else(|| read_provider_opt(provider_options, "max_tokens"))
        .or_else(|| read_provider_opt(provider_options, "max_output_tokens"))
        .and_then(Value::as_u64)
    {
        body.insert("max_output_tokens".to_string(), json!(max_toks));
    }

    // Sampling / logprobs rules: Astra forbids `temperature`, `top_p`, `top_logprobs`, and `message.output_text.logprobs`.
    if !is_astra {
        if let Some(temp) =
            read_provider_opt(provider_options, "temperature").and_then(Value::as_f64)
        {
            body.insert("temperature".to_string(), json!(temp));
        }
        if let Some(top_p) = read_provider_opt(provider_options, "topP")
            .or_else(|| read_provider_opt(provider_options, "top_p"))
            .and_then(Value::as_f64)
        {
            body.insert("top_p".to_string(), json!(top_p));
        }
        if let Some(top_lp) = read_provider_opt(provider_options, "topLogprobs")
            .or_else(|| read_provider_opt(provider_options, "top_logprobs"))
            .and_then(Value::as_u64)
        {
            body.insert("top_logprobs".to_string(), json!(top_lp));
        }
    }

    let mut include_list: Vec<String> = read_provider_opt(provider_options, "include")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter(|item| !(is_astra && *item == "message.output_text.logprobs"))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    if let Some(reasoning) = reasoning_obj {
        body.insert("reasoning".to_string(), reasoning);
        if !include_list
            .iter()
            .any(|s| s == "reasoning.encrypted_content")
        {
            include_list.push("reasoning.encrypted_content".to_string());
        }
    }
    if !include_list.is_empty() {
        body.insert("include".to_string(), json!(include_list));
    }

    if let Some(verbosity) =
        read_provider_opt(provider_options, "textVerbosity").and_then(Value::as_str)
    {
        body.insert("text".to_string(), json!({ "verbosity": verbosity }));
    }

    // Prompt cache migration: Astra replaces `prompt_cache_retention` with `prompt_cache_options.ttl: "30m"`.
    if let Some(retention) = read_provider_opt(provider_options, "promptCacheRetention")
        .or_else(|| read_provider_opt(provider_options, "prompt_cache_retention"))
        .and_then(Value::as_str)
    {
        if is_astra {
            if retention != "none" {
                body.insert("prompt_cache_options".to_string(), json!({ "ttl": "30m" }));
            }
        } else {
            body.insert(
                "prompt_cache_retention".to_string(),
                Value::String(retention.to_string()),
            );
        }
    } else if is_astra
        && let Some(cache_opts) = read_provider_opt(provider_options, "prompt_cache_options")
    {
        body.insert("prompt_cache_options".to_string(), cache_opts.clone());
    }

    // Service tier: Astra with EU data residency does not support `fast` or `priority`.
    let is_eu_residency = read_provider_opt(provider_options, "dataResidency")
        .or_else(|| read_provider_opt(provider_options, "data_residency"))
        .and_then(Value::as_str)
        .is_some_and(|r| r.eq_ignore_ascii_case("eu"));

    if let Some(tier) = read_provider_opt(provider_options, "serviceTier")
        .or_else(|| read_provider_opt(provider_options, "service_tier"))
        .and_then(Value::as_str)
    {
        let blocked_astra_eu = is_astra
            && is_eu_residency
            && (tier.eq_ignore_ascii_case("fast") || tier.eq_ignore_ascii_case("priority"));
        if !blocked_astra_eu {
            body.insert("service_tier".to_string(), Value::String(tier.to_string()));
        }
    }

    let tools_disabled = request_disables_all_tools(provider_options);
    if !tools_disabled && !tools.is_empty() {
        let native_plan = read_native_tool_calling_plan(provider_options);
        let deferred_set: HashSet<&str> = native_plan
            .as_ref()
            .filter(|p| {
                matches!(
                    p.tool_search,
                    Some(
                        NativeToolSearchKind::OpenAiResponses
                            | NativeToolSearchKind::OpenRouterResponses
                    )
                )
            })
            .map(|p| p.deferred_tool_names.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let programmatic_set: HashSet<&str> = native_plan
            .as_ref()
            .filter(|p| {
                p.programmatic_tool_calling
                    == Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
            })
            .map(|p| {
                p.programmatic_tool_names
                    .iter()
                    .map(String::as_str)
                    .collect()
            })
            .unwrap_or_default();

        let mut converted_tools: Vec<Value> = tools
            .iter()
            .map(|t| {
                let mut fn_tool = Map::new();
                fn_tool.insert("type".to_string(), Value::String("function".to_string()));
                fn_tool.insert("name".to_string(), Value::String(t.name.clone()));
                fn_tool.insert(
                    "description".to_string(),
                    Value::String(t.description.clone()),
                );
                fn_tool.insert("parameters".to_string(), t.parameters.clone());
                fn_tool.insert("strict".to_string(), Value::Bool(false));
                if deferred_set.contains(t.name.as_str()) {
                    fn_tool.insert("defer_loading".to_string(), Value::Bool(true));
                }
                if programmatic_set.contains(t.name.as_str()) {
                    fn_tool.insert(
                        "allowed_callers".to_string(),
                        json!(["direct", "programmatic"]),
                    );
                }
                Value::Object(fn_tool)
            })
            .collect();

        if let Some(plan) = &native_plan {
            match plan.tool_search {
                Some(NativeToolSearchKind::OpenAiResponses) => {
                    converted_tools.push(json!({ "type": "tool_search" }));
                }
                Some(NativeToolSearchKind::OpenRouterResponses) => {
                    converted_tools.push(json!({ "type": "openrouter:tool_search" }));
                }
                _ => {}
            }
            if plan.programmatic_tool_calling
                == Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
            {
                converted_tools.push(json!({ "type": "programmatic_tool_calling" }));
            }
        }

        body.insert("tools".to_string(), Value::Array(converted_tools));
    }

    Value::Object(body)
}

fn convert_messages_to_responses_input(
    target_model_id: &str,
    messages: &[CanonicalMessage],
    full_messages: &[CanonicalMessage],
) -> Vec<Value> {
    let mut items = Vec::new();
    let mut pending_calls: Vec<(String, String)> = Vec::new(); // (call_id, tool_name)
    let mut satisfied_call_ids = std::collections::HashSet::new();
    // `transformMessages` parity: original -> normalized composite tool-call ids for assistant
    // calls rewritten on cross-model replay, so matching tool results reference the same id.
    let mut tool_call_id_map: HashMap<String, String> = HashMap::new();

    // Index `openaiCaller` across the full transcript so delta `previous_response_id` slices
    // (`[MessageRole::Tool]`) can still echo `caller` on `function_call_output`.
    let mut caller_by_call_id: HashMap<String, Value> = HashMap::new();
    for msg in full_messages {
        if msg.role != MessageRole::Assistant {
            continue;
        }
        for block in &msg.content {
            if let ContentBlock::ToolCall {
                id, provider_meta, ..
            } = block
                && let Some(caller) = provider_meta.extra.get("openaiCaller")
            {
                caller_by_call_id.insert(id.clone(), caller.clone());
                let (raw_call_id, _) = split_openai_tool_call_id(id);
                caller_by_call_id.insert(raw_call_id.to_string(), caller.clone());
            }
        }
    }

    let flush_orphaned_calls =
        |items: &mut Vec<Value>,
         pending: &mut Vec<(String, String)>,
         satisfied: &mut std::collections::HashSet<String>| {
            for (call_id, _name) in pending.drain(..) {
                if !satisfied.contains(&call_id) {
                    items.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": "No result provided",
                    }));
                }
            }
            satisfied.clear();
        };

    for (msg_idx, msg) in messages.iter().enumerate() {
        match msg.role {
            MessageRole::System | MessageRole::Developer => {
                flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
                let text = collect_plain_text(&msg.content);
                if !text.is_empty() {
                    let role = if msg.role == MessageRole::Developer {
                        "developer"
                    } else {
                        "system"
                    };
                    items.push(json!({
                        "role": role,
                        "content": [{"type": "input_text", "text": text}],
                    }));
                }
            }
            MessageRole::User => {
                flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
                let mut parts = Vec::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text, .. } if !text.is_empty() => {
                            parts.push(json!({"type": "input_text", "text": text}));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Image,
                            source,
                            ..
                        } => {
                            if let Some(image_url) = media_source_to_openai_image_url(source) {
                                parts.push(json!({
                                    "type": "input_image",
                                    "detail": "auto",
                                    "image_url": image_url,
                                }));
                            }
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Document,
                            source: MediaSource::Base64 { mime_type, data },
                            ..
                        } => {
                            parts.push(json!({
                                "type": "input_file",
                                "filename": "attachment.pdf",
                                "file_data": format!("data:{mime_type};base64,{data}"),
                            }));
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    items.push(json!({
                        "role": "user",
                        "content": parts,
                    }));
                }
            }
            MessageRole::Assistant => {
                flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
                if matches!(
                    msg.stop_reason,
                    Some(StopReason::Error | StopReason::Aborted)
                ) {
                    continue;
                }
                // `transformMessages` parity (`openaiResponsesShared.ts`): encrypted reasoning
                // items, text item ids and annotations are only replayed when provider, api AND
                // model all match the target; anything else is converted to plain text.
                let is_same_provider_api = msg.provider.as_deref() == Some(OPENAI_PROVIDER)
                    && msg.api.as_deref() == Some(OPENAI_RESPONSES_API);
                let is_same_model =
                    is_same_provider_api && msg.model.as_deref() == Some(target_model_id);
                let is_different_model =
                    is_same_provider_api && msg.model.as_deref() != Some(target_model_id);

                for (b_idx, block) in msg.content.iter().enumerate() {
                    match block {
                        ContentBlock::Thinking {
                            text,
                            signature,
                            provider_meta,
                            ..
                        } => {
                            if is_same_model {
                                if let Some(item_val) = &provider_meta.openai_reasoning_item {
                                    items.push(item_val.clone());
                                    continue;
                                }
                                if let Some(sig) = signature
                                    && let Ok(parsed_item) = serde_json::from_str::<Value>(sig)
                                    && parsed_item.get("type").and_then(Value::as_str)
                                        == Some("reasoning")
                                {
                                    items.push(parsed_item);
                                    continue;
                                }
                            } else if !text.trim().is_empty() {
                                items.push(json!({
                                    "type": "message",
                                    "role": "assistant",
                                    "status": "completed",
                                    "id": format!("msg_{msg_idx}_{b_idx}"),
                                    "content": [{
                                        "type": "output_text",
                                        "text": text,
                                        "annotations": [],
                                    }],
                                }));
                            }
                        }
                        ContentBlock::Text {
                            text,
                            phase,
                            provider_meta,
                            ..
                        } => {
                            if *phase == Some(TextPhase::Commentary) {
                                continue;
                            }
                            // Cross-model text loses its stored item id and annotations
                            // (`transformMessages` rewrites it to a bare `{type:"text"}` block).
                            let msg_id = provider_meta
                                .openai_item_id
                                .clone()
                                .filter(|id| is_same_model && id.len() <= 64)
                                .unwrap_or_else(|| format!("msg_{msg_idx}_{b_idx}"));
                            let annotations = provider_meta
                                .extra
                                .get("annotations")
                                .and_then(Value::as_array)
                                .filter(|_| is_same_model)
                                .cloned()
                                .unwrap_or_default();
                            items.push(json!({
                                "type": "message",
                                "role": "assistant",
                                "status": "completed",
                                "id": msg_id,
                                "content": [{
                                    "type": "output_text",
                                    "text": text,
                                    "annotations": annotations,
                                }],
                            }));
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                            provider_meta,
                            ..
                        } => {
                            let normalized = if is_same_model {
                                id.clone()
                            } else {
                                sanitize_openai_composite_tool_id(id)
                            };
                            if normalized != *id {
                                tool_call_id_map.insert(id.clone(), normalized.clone());
                            }
                            let (call_id, item_id_opt) = split_openai_tool_call_id(&normalized);
                            let item_id = match item_id_opt {
                                Some(it) if is_different_model && it.starts_with("fc_") => None,
                                other => other,
                            };
                            let mut fc_obj = Map::new();
                            fc_obj.insert(
                                "type".to_string(),
                                Value::String("function_call".to_string()),
                            );
                            if let Some(it) = item_id {
                                fc_obj.insert("id".to_string(), Value::String(it.to_string()));
                            }
                            fc_obj
                                .insert("call_id".to_string(), Value::String(call_id.to_string()));
                            fc_obj.insert("name".to_string(), Value::String(name.clone()));
                            fc_obj.insert(
                                "arguments".to_string(),
                                Value::String(
                                    serde_json::to_string(arguments)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                ),
                            );
                            if is_same_model
                                && let Some(caller) = provider_meta.extra.get("openaiCaller")
                            {
                                fc_obj.insert("caller".to_string(), caller.clone());
                            }
                            pending_calls.push((call_id.to_string(), name.clone()));
                            items.push(Value::Object(fc_obj));
                        }
                        ContentBlock::ProviderNativeTool { provider_meta, .. } => {
                            if is_same_model
                                && let Some(raw_item) = provider_meta.extra.get("openaiRawItem")
                            {
                                items.push(raw_item.clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
            MessageRole::Tool => {
                for block in &msg.content {
                    if let ContentBlock::ToolResult {
                        tool_call_id,
                        content,
                        provider_meta,
                        ..
                    } = block
                    {
                        let resolved_id = tool_call_id_map
                            .get(tool_call_id)
                            .map_or(tool_call_id.as_str(), String::as_str);
                        let (call_id, _) = split_openai_tool_call_id(resolved_id);
                        satisfied_call_ids.insert(call_id.to_string());

                        let mut texts = Vec::new();
                        let mut images = Vec::new();
                        for part in content {
                            match part {
                                ToolResultPart::Text { text } => texts.push(text.as_str()),
                                ToolResultPart::Media {
                                    kind: MediaKind::Image,
                                    source,
                                } => {
                                    if let Some(url) = media_source_to_openai_image_url(source) {
                                        images.push(url);
                                    }
                                }
                                _ => {}
                            }
                        }
                        let output_str = if !texts.is_empty() {
                            texts.join("\n")
                        } else if !images.is_empty() {
                            "(see attached image)".to_string()
                        } else {
                            String::new()
                        };

                        let caller = provider_meta
                            .extra
                            .get("openaiCaller")
                            .or_else(|| caller_by_call_id.get(tool_call_id.as_str()))
                            .or_else(|| caller_by_call_id.get(call_id));

                        let mut fco_obj = Map::new();
                        fco_obj.insert(
                            "type".to_string(),
                            Value::String("function_call_output".to_string()),
                        );
                        fco_obj.insert("call_id".to_string(), Value::String(call_id.to_string()));
                        fco_obj.insert("output".to_string(), Value::String(output_str));
                        if let Some(caller_val) = caller {
                            fco_obj.insert("caller".to_string(), caller_val.clone());
                        }
                        items.push(Value::Object(fco_obj));

                        if !images.is_empty() && caller.is_none() {
                            let mut user_parts = vec![json!({
                                "type": "input_text",
                                "text": "Attached image(s) from tool result:",
                            })];
                            for url in images {
                                user_parts.push(json!({
                                    "type": "input_image",
                                    "detail": "auto",
                                    "image_url": url,
                                }));
                            }
                            items.push(json!({
                                "role": "user",
                                "content": user_parts,
                            }));
                        }
                    }
                }
            }
        }
    }

    flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
    items
}

/// Builds the stream error for `response.incomplete` / `response.failed`
/// (`buildOpenAiResponseFailedError` parity in `openaiResponsesProjector.ts`): the message is
/// suffixed with `(code: …, status: …, type: …, param: …)`, where `code` falls back to
/// `incomplete_details.reason` (e.g. `max_output_tokens`).
fn openai_response_failed_error(env: &OpenAiResponsesSseEnvelope) -> ProviderTransportError {
    fn first_str<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a str> {
        candidates
            .iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .find(|s| !s.trim().is_empty())
    }
    let response = env.response.as_ref().filter(|r| r.is_object());
    let response_error = response
        .and_then(|r| r.get("error"))
        .filter(|e| e.is_object());
    let event_error = env.error.as_ref().filter(|e| e.is_object());
    let error = response_error.or(event_error);
    let event_message = env.message.as_ref().map(|m| Value::String(m.clone()));
    let event_code = env.code.as_ref().map(|c| Value::String(c.clone()));
    let incomplete_reason = response
        .and_then(|r| r.get("incomplete_details"))
        .and_then(|d| d.get("reason"));

    let message = first_str(&[
        error.and_then(|e| e.get("message")),
        event_message.as_ref(),
        response.and_then(|r| r.get("error")),
    ])
    .unwrap_or(if env.event_type == "response.incomplete" {
        "OpenAI response incomplete."
    } else {
        "OpenAI response failed."
    });
    let code = first_str(&[
        error.and_then(|e| e.get("code")),
        event_code.as_ref(),
        incomplete_reason,
    ]);
    let status = first_str(&[response.and_then(|r| r.get("status"))]);
    let failure_type = first_str(&[error.and_then(|e| e.get("type"))]);
    let param = first_str(&[error.and_then(|e| e.get("param"))]);

    let detail_suffix = [
        code.map(|c| format!("code: {c}")),
        status.map(|s| format!("status: {s}")),
        failure_type.map(|t| format!("type: {t}")),
        param.map(|p| format!("param: {p}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    let full_message = if detail_suffix.is_empty() {
        message.to_string()
    } else {
        format!("{message} ({detail_suffix})")
    };
    let mut err = ProviderTransportError::protocol(full_message);
    err.code = code.map(ToOwned::to_owned);
    err
}

fn collect_plain_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn media_source_to_openai_image_url(source: &MediaSource) -> Option<String> {
    match source {
        MediaSource::Base64 { mime_type, data } => Some(format!("data:{mime_type};base64,{data}")),
        MediaSource::Url { url, .. } => Some(url.clone()),
        MediaSource::FileRef { .. } => None,
    }
}

fn parse_item_object_args(raw: Option<&Value>) -> Map<String, Value> {
    match raw {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(s)) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

struct OpenAiStreamState {
    turn_id: String,
    model_id: String,
    response_id: Option<String>,
    open_items: BTreeMap<usize, OpenAiActiveItem>,
    finished_blocks: BTreeMap<usize, ContentBlock>,
    pending_server_tool_search_keys: VecDeque<String>,
    pending_program_keys: VecDeque<String>,
    next_auto_slot: usize,
    last_slot: Option<usize>,
    usage: TurnUsage,
    stop_reason: StopReason,
    completed: bool,
    raw_events: Vec<Value>,
}

enum OpenAiActiveItem {
    Reasoning {
        item_id: String,
        summary_parts: Vec<String>,
    },
    Message {
        block_index: usize,
        item_id: String,
        phase: Option<TextPhase>,
        text_buf: String,
    },
    FunctionCall {
        item_id: String,
        key: String,
        name: String,
        partial_json: String,
    },
    ServerItem {
        item_id: String,
        code_buf: String,
    },
}

impl OpenAiActiveItem {
    fn item_id(&self) -> &str {
        match self {
            Self::Reasoning { item_id, .. }
            | Self::Message { item_id, .. }
            | Self::FunctionCall { item_id, .. }
            | Self::ServerItem { item_id, .. } => item_id,
        }
    }
}

impl OpenAiStreamState {
    fn new(turn_id: String, model_id: String) -> Self {
        Self {
            turn_id,
            model_id,
            response_id: None,
            open_items: BTreeMap::new(),
            finished_blocks: BTreeMap::new(),
            pending_server_tool_search_keys: VecDeque::new(),
            pending_program_keys: VecDeque::new(),
            next_auto_slot: 0,
            last_slot: None,
            usage: TurnUsage::default(),
            stop_reason: StopReason::Stop,
            completed: false,
            raw_events: Vec::new(),
        }
    }

    fn resolve_open_slot(
        &self,
        output_index: Option<usize>,
        item_id: Option<&str>,
    ) -> Option<usize> {
        if let Some(idx) = output_index
            && self.open_items.contains_key(&idx)
        {
            return Some(idx);
        }
        if let Some(target_id) = item_id
            && let Some((&slot, _)) = self
                .open_items
                .iter()
                .find(|(_, active)| active.item_id() == target_id)
        {
            return Some(slot);
        }
        self.last_slot
            .filter(|slot| self.open_items.contains_key(slot))
            .or_else(|| self.open_items.keys().next_back().copied())
    }

    fn handle_event(
        &mut self,
        env: OpenAiResponsesSseEnvelope,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<(), ProviderTransportError> {
        if let Some(resp) = &env.response
            && let Some(id) = resp
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        {
            self.response_id = Some(id.to_string());
        }

        match env.event_type.as_str() {
            "response.output_item.added" => {
                let Some(item) = env.item.as_ref().and_then(Value::as_object) else {
                    return Ok(());
                };
                let slot = env.output_index.unwrap_or(self.next_auto_slot);
                self.next_auto_slot = self.next_auto_slot.max(slot + 1);
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let item_id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("item_{slot}"));

                match item_type {
                    "reasoning" => {
                        emit(StreamEvent::ThinkingStart {
                            turn_id: self.turn_id.clone(),
                            stream_id: item_id.clone(),
                            mode: ReasoningStreamMode::Summary,
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::Reasoning {
                                item_id,
                                summary_parts: Vec::new(),
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "message" => {
                        let phase = item
                            .get("phase")
                            .and_then(Value::as_str)
                            .and_then(TextPhase::from_wire);
                        emit(StreamEvent::TextStart {
                            turn_id: self.turn_id.clone(),
                            block_index: slot,
                            phase,
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::Message {
                                block_index: slot,
                                item_id,
                                phase,
                                text_buf: String::new(),
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "function_call" => {
                        let call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or(&item_id);
                        let composite = compose_openai_tool_call_id(call_id, &item_id);
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let initial_partial = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key: composite.clone(),
                            name: name.clone(),
                            initial_args: None,
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::FunctionCall {
                                item_id,
                                key: composite,
                                name,
                                partial_json: initial_partial,
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "tool_search_call" => {
                        let key = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .unwrap_or(&item_id)
                            .to_string();
                        let initial_args = parse_item_object_args(item.get("arguments"));
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key: key.clone(),
                            name: "tool_search".to_string(),
                            initial_args: (!initial_args.is_empty()).then_some(initial_args),
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::ServerItem {
                                item_id,
                                code_buf: String::new(),
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "program" => {
                        let key = item_id.clone();
                        let initial_code = item
                            .get("code")
                            .or_else(|| item.get("program"))
                            .or_else(|| item.get("source"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let mut initial_args = Map::new();
                        if !initial_code.is_empty() {
                            initial_args
                                .insert("code".to_string(), Value::String(initial_code.clone()));
                        }
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key,
                            name: "programmatic_tool_calling".to_string(),
                            initial_args: (!initial_args.is_empty()).then_some(initial_args),
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::ServerItem {
                                item_id,
                                code_buf: initial_code,
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "tool_search_output" | "program_output" => {
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::ServerItem {
                                item_id,
                                code_buf: String::new(),
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    _ => {}
                }
            }
            "response.program.delta" | "response.program_code.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::ServerItem { code_buf, .. }) =
                        self.open_items.get_mut(&slot)
                {
                    code_buf.push_str(delta);
                }
            }
            "response.reasoning_summary_part.added" => {
                if let Some(slot) = self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Reasoning { summary_parts, .. }) =
                        self.open_items.get_mut(&slot)
                {
                    let init_text = env
                        .part
                        .as_ref()
                        .and_then(|p| p.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    summary_parts.push(init_text);
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Reasoning {
                        item_id,
                        summary_parts,
                    }) = self.open_items.get_mut(&slot)
                {
                    if summary_parts.is_empty() {
                        summary_parts.push(String::new());
                    }
                    if let Some(last) = summary_parts.last_mut() {
                        last.push_str(delta);
                    }
                    emit(StreamEvent::ThinkingDelta {
                        turn_id: self.turn_id.clone(),
                        stream_id: item_id.clone(),
                        mode: ReasoningStreamMode::Summary,
                        delta: delta.to_string(),
                    });
                }
            }
            "response.reasoning_summary_part.done" => {
                if let Some(slot) = self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Reasoning { item_id, .. }) =
                        self.open_items.get(&slot)
                {
                    emit(StreamEvent::ThinkingDelta {
                        turn_id: self.turn_id.clone(),
                        stream_id: item_id.clone(),
                        mode: ReasoningStreamMode::Summary,
                        delta: "\n\n".to_string(),
                    });
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Message {
                        block_index,
                        phase,
                        text_buf,
                        ..
                    }) = self.open_items.get_mut(&slot)
                {
                    text_buf.push_str(delta);
                    emit(StreamEvent::TextDelta {
                        turn_id: self.turn_id.clone(),
                        block_index: *block_index,
                        delta: delta.to_string(),
                        phase: *phase,
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::FunctionCall {
                        key,
                        name,
                        partial_json,
                        ..
                    }) = self.open_items.get_mut(&slot)
                {
                    partial_json.push_str(delta);
                    emit(StreamEvent::ToolCallDelta {
                        turn_id: self.turn_id.clone(),
                        key: key.clone(),
                        name: name.clone(),
                        delta: delta.to_string(),
                    });
                }
            }
            "response.function_call_arguments.done" => {
                if let Some(args) = env.arguments
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::FunctionCall { partial_json, .. }) =
                        self.open_items.get_mut(&slot)
                {
                    *partial_json = args;
                }
            }
            "response.output_item.done" => {
                let Some(item_val) = env.item else {
                    return Ok(());
                };
                let Some(item) = item_val.as_object() else {
                    return Ok(());
                };
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let done_item_id = item.get("id").and_then(Value::as_str);
                let resolved_slot = self.resolve_open_slot(env.output_index, done_item_id);
                let removed_active = resolved_slot.and_then(|s| self.open_items.remove(&s));
                let slot = resolved_slot.unwrap_or_else(|| {
                    let s = env.output_index.unwrap_or(self.next_auto_slot);
                    self.next_auto_slot = self.next_auto_slot.max(s + 1);
                    s
                });

                match item_type {
                    "reasoning" => {
                        let fallback_rs_id = match &removed_active {
                            Some(OpenAiActiveItem::Reasoning { item_id, .. }) => item_id.as_str(),
                            _ => "rs_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_rs_id).to_string();
                        let summary_text = item
                            .get("summary")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join("\n\n")
                            })
                            .unwrap_or_default();
                        let serialized_item = serde_json::to_string(&item_val).ok();
                        let encrypted_content = item.get("encrypted_content").cloned();

                        emit(StreamEvent::ThinkingEnd {
                            turn_id: self.turn_id.clone(),
                            stream_id: item_id.clone(),
                            mode: ReasoningStreamMode::Summary,
                            text: summary_text.clone(),
                            signature: serialized_item.clone(),
                            redacted: false,
                        });

                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::Thinking {
                                text: summary_text.clone(),
                                summary: (!summary_text.is_empty()).then_some(summary_text),
                                redacted: false,
                                signature: serialized_item,
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    openai_encrypted_reasoning: encrypted_content,
                                    openai_reasoning_item: Some(item_val),
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "message" => {
                        let fallback_item_id = match &removed_active {
                            Some(OpenAiActiveItem::Message { item_id, .. }) => item_id.as_str(),
                            _ => "msg_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_item_id).to_string();
                        let phase = item
                            .get("phase")
                            .and_then(Value::as_str)
                            .and_then(TextPhase::from_wire);
                        let mut full_text = String::new();
                        let mut raw_annotations = Vec::new();
                        if let Some(parts) = item.get("content").and_then(Value::as_array) {
                            for p in parts {
                                let p_type =
                                    p.get("type").and_then(Value::as_str).unwrap_or_default();
                                if p_type == "output_text" {
                                    if let Some(t) = p.get("text").and_then(Value::as_str) {
                                        full_text.push_str(t);
                                    }
                                    if let Some(anns) =
                                        p.get("annotations").and_then(Value::as_array)
                                    {
                                        raw_annotations.extend(anns.iter().cloned());
                                    }
                                } else if let Some(r) = p.get("refusal").and_then(Value::as_str) {
                                    full_text.push_str(r);
                                }
                            }
                        }
                        if full_text.is_empty()
                            && let Some(OpenAiActiveItem::Message { text_buf, .. }) =
                                &removed_active
                        {
                            full_text = text_buf.clone();
                        }

                        let citations: Vec<Citation> =
                            extract_nested_citations(&Value::Array(raw_annotations.clone()));
                        let block_index = match &removed_active {
                            Some(OpenAiActiveItem::Message { block_index, .. }) => *block_index,
                            _ => slot,
                        };

                        emit(StreamEvent::TextEnd {
                            turn_id: self.turn_id.clone(),
                            block_index,
                            text: full_text.clone(),
                            phase,
                            citations: citations.clone(),
                            annotations: raw_annotations.clone(),
                        });

                        let mut extra = Map::new();
                        if !raw_annotations.is_empty() {
                            extra.insert("annotations".to_string(), Value::Array(raw_annotations));
                        }
                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::Text {
                                text: full_text,
                                phase,
                                citations,
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "function_call" => {
                        let fallback_fc_id = match &removed_active {
                            Some(OpenAiActiveItem::FunctionCall { item_id, .. }) => {
                                item_id.as_str()
                            }
                            _ => "fc_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_fc_id).to_string();
                        let call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or(&item_id)
                            .to_string();
                        let composite = compose_openai_tool_call_id(&call_id, &item_id);
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let raw_args = match &removed_active {
                            Some(OpenAiActiveItem::FunctionCall { partial_json, .. })
                                if !partial_json.is_empty() =>
                            {
                                partial_json.as_str()
                            }
                            _ => item
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or("{}"),
                        };
                        // A completed call's arguments must be one whole JSON object: never
                        // repair truncated/malformed arguments into an executable call.
                        let parsed_args = if raw_args.trim().is_empty() {
                            Map::new()
                        } else {
                            match serde_json::from_str::<Value>(raw_args) {
                                Ok(Value::Object(obj)) => obj,
                                _ => {
                                    return Err(ProviderTransportError::protocol(format!(
                                        "Invalid JSON arguments for OpenAI tool call \"{name}\"."
                                    )));
                                }
                            }
                        };

                        emit(StreamEvent::ToolCallEnd {
                            turn_id: self.turn_id.clone(),
                            key: composite.clone(),
                            name: name.clone(),
                            arguments: Some(parsed_args.clone()),
                            retry_of: None,
                            input_digest: None,
                        });

                        let mut extra = Map::new();
                        if let Some(caller) = item.get("caller")
                            && caller.is_object()
                        {
                            extra.insert("openaiCaller".to_string(), caller.clone());
                        }

                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::ToolCall {
                                id: composite,
                                name,
                                arguments: parsed_args,
                                partial_json: None,
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    openai_call_id: Some(call_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "tool_search_call" => {
                        let fallback_id = match &removed_active {
                            Some(OpenAiActiveItem::ServerItem { item_id, .. }) => item_id.as_str(),
                            _ => "tsc_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_id).to_string();
                        let explicit_call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty());
                        let key = explicit_call_id.unwrap_or(&item_id).to_string();
                        if explicit_call_id.is_none() {
                            self.pending_server_tool_search_keys.push_back(key.clone());
                        }
                        let args_map = parse_item_object_args(item.get("arguments"));
                        emit(StreamEvent::ToolCallEnd {
                            turn_id: self.turn_id.clone(),
                            key,
                            name: "tool_search".to_string(),
                            arguments: Some(args_map.clone()),
                            retry_of: None,
                            input_digest: None,
                        });
                        let mut extra = Map::new();
                        extra.insert("openaiRawItem".to_string(), item_val);
                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::ProviderNativeTool {
                                id: item_id.clone(),
                                name: "tool_search".to_string(),
                                role: ProviderNativeToolRole::Call,
                                arguments: args_map,
                                result: None,
                                is_error: false,
                                citations: Vec::new(),
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "tool_search_output" => {
                        let fallback_id = match &removed_active {
                            Some(OpenAiActiveItem::ServerItem { item_id, .. }) => item_id.as_str(),
                            _ => "tso_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_id).to_string();
                        let key = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(ToOwned::to_owned)
                            .or_else(|| self.pending_server_tool_search_keys.pop_front())
                            .unwrap_or_else(|| item_id.clone());
                        let status = item
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("completed");
                        let is_error = status == "failed" || status == "error";
                        let matched_tools: Vec<String> = item
                            .get("tools")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|entry| {
                                        entry.as_str().map(ToOwned::to_owned).or_else(|| {
                                            entry
                                                .get("name")
                                                .and_then(Value::as_str)
                                                .map(ToOwned::to_owned)
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let summary_result = json!({
                            "status": status,
                            "tools": matched_tools,
                        });
                        emit(StreamEvent::ToolResult {
                            turn_id: self.turn_id.clone(),
                            key,
                            name: "tool_search".to_string(),
                            result: summary_result.clone(),
                            is_error,
                            denied: false,
                        });
                        let mut extra = Map::new();
                        extra.insert("openaiRawItem".to_string(), item_val);
                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::ProviderNativeTool {
                                id: item_id.clone(),
                                name: "tool_search".to_string(),
                                role: ProviderNativeToolRole::Result,
                                arguments: Map::new(),
                                result: Some(summary_result),
                                is_error,
                                citations: Vec::new(),
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "program" => {
                        let fallback_id = match &removed_active {
                            Some(OpenAiActiveItem::ServerItem { item_id, .. }) => item_id.as_str(),
                            _ => "prg_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_id).to_string();
                        let code = item
                            .get("code")
                            .or_else(|| item.get("program"))
                            .or_else(|| item.get("source"))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                            .or_else(|| match &removed_active {
                                Some(OpenAiActiveItem::ServerItem { code_buf, .. })
                                    if !code_buf.is_empty() =>
                                {
                                    Some(code_buf.clone())
                                }
                                _ => None,
                            })
                            .unwrap_or_default();
                        let mut args_map = Map::new();
                        if !code.is_empty() {
                            args_map.insert("code".to_string(), Value::String(code));
                        }
                        self.pending_program_keys.push_back(item_id.clone());
                        emit(StreamEvent::ToolCallEnd {
                            turn_id: self.turn_id.clone(),
                            key: item_id.clone(),
                            name: "programmatic_tool_calling".to_string(),
                            arguments: Some(args_map.clone()),
                            retry_of: None,
                            input_digest: None,
                        });
                        let mut extra = Map::new();
                        extra.insert("openaiRawItem".to_string(), item_val);
                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::ProviderNativeTool {
                                id: item_id.clone(),
                                name: "programmatic_tool_calling".to_string(),
                                role: ProviderNativeToolRole::Call,
                                arguments: args_map,
                                result: None,
                                is_error: false,
                                citations: Vec::new(),
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "program_output" => {
                        let fallback_id = match &removed_active {
                            Some(OpenAiActiveItem::ServerItem { item_id, .. }) => item_id.as_str(),
                            _ => "prgo_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_id).to_string();
                        let key = item
                            .get("program_id")
                            .or_else(|| item.get("caller_id"))
                            .or_else(|| item.get("call_id"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(ToOwned::to_owned)
                            .or_else(|| self.pending_program_keys.pop_front())
                            .unwrap_or_else(|| item_id.clone());
                        let status = item
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("completed");
                        let is_error = status == "failed"
                            || status == "error"
                            || item.get("error").is_some_and(|e| !e.is_null());
                        let output_payload = item
                            .get("output")
                            .cloned()
                            .unwrap_or_else(|| json!({ "status": status }));
                        emit(StreamEvent::ToolResult {
                            turn_id: self.turn_id.clone(),
                            key,
                            name: "programmatic_tool_calling".to_string(),
                            result: output_payload.clone(),
                            is_error,
                            denied: false,
                        });
                        let mut extra = Map::new();
                        extra.insert("openaiRawItem".to_string(), item_val);
                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::ProviderNativeTool {
                                id: item_id.clone(),
                                name: "programmatic_tool_calling".to_string(),
                                role: ProviderNativeToolRole::Result,
                                arguments: Map::new(),
                                result: Some(output_payload),
                                is_error,
                                citations: Vec::new(),
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    _ => {}
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                if env.event_type != "response.completed"
                    && env.response.as_ref().and_then(Value::as_object).is_none()
                {
                    return Err(openai_response_failed_error(&env));
                }
                if let Some(resp) = env.response.as_ref().and_then(Value::as_object) {
                    if let Some(usage) = resp.get("usage").and_then(Value::as_object) {
                        let input_tokens = usage
                            .get("input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let cached_tokens = usage
                            .get("input_tokens_details")
                            .and_then(|d| d.get("cached_tokens"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let output_tokens = usage
                            .get("output_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let reasoning_tokens = usage
                            .get("output_tokens_details")
                            .and_then(|d| d.get("reasoning_tokens"))
                            .and_then(Value::as_u64);
                        let total_tokens = usage
                            .get("total_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(input_tokens + output_tokens);

                        self.usage = TurnUsage {
                            prompt_tokens: input_tokens,
                            completion_tokens: output_tokens,
                            total_tokens,
                            cached_prompt_tokens: (cached_tokens > 0).then_some(cached_tokens),
                            cache_write_prompt_tokens: None,
                            reasoning_output_tokens: reasoning_tokens,
                            estimated_cost_usd: None,
                        };
                    }
                    if env.event_type != "response.completed" {
                        return Err(openai_response_failed_error(&env));
                    }
                    // `mapStopReason(response.status)`: a `failed` / `cancelled` / `incomplete`
                    // (or unknown) status on the terminal event is never a normal completion.
                    if let Some(status) = resp
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        && !matches!(status, "completed" | "in_progress" | "queued")
                    {
                        return Err(openai_response_failed_error(&env));
                    }
                    self.stop_reason = if self
                        .finished_blocks
                        .values()
                        .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
                    {
                        StopReason::ToolUse
                    } else {
                        StopReason::Stop
                    };
                }
                self.completed = true;
            }
            "error" => {
                // `buildOpenAiResponseFailedError(event)`: nested `error.code` (for example
                // `previous_response_not_found` or `rate_limit_exceeded`) wins over `event.code`.
                return Err(openai_response_failed_error(&env));
            }
            _ => {}
        }

        Ok(())
    }

    fn finish(
        self,
        next_fingerprint: String,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        if !self.completed {
            return Err(ProviderTransportError::network(
                "OpenAI response stream ended before completion.",
            ));
        }
        // An output item that was added but never finished was truncated: never surface its
        // partial text or execute a partially streamed tool call (Anthropic/Google parity).
        if !self.open_items.is_empty() {
            return Err(ProviderTransportError::network(
                "OpenAI response stream ended with unfinished content.",
            ));
        }

        let content: Vec<ContentBlock> = self.finished_blocks.into_values().collect();
        let phase = content.iter().rev().find_map(|b| match b {
            ContentBlock::Text { phase: Some(p), .. } => Some(*p),
            _ => None,
        });

        let has_tool_call = content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolCall { .. }));
        let has_visible_final_text = content.iter().any(|b| {
            matches!(
                b,
                ContentBlock::Text { text, phase, .. }
                    if *phase != Some(TextPhase::Commentary) && !text.trim().is_empty()
            )
        });
        let has_program_output = content.iter().any(|b| {
            matches!(
                b,
                ContentBlock::ProviderNativeTool {
                    name,
                    role: ProviderNativeToolRole::Result,
                    ..
                } if name == "programmatic_tool_calling"
            )
        });
        let mut assistant_extra = Map::new();
        if has_program_output && !has_tool_call && !has_visible_final_text {
            assistant_extra.insert("requiresContinuationStep".to_string(), Value::Bool(true));
        }

        let assistant = CanonicalMessage {
            id: self
                .response_id
                .clone()
                .unwrap_or_else(|| format!("resp_{}", Uuid::new_v4())),
            role: MessageRole::Assistant,
            content,
            phase,
            provider: Some(OPENAI_PROVIDER.to_string()),
            api: Some(OPENAI_RESPONSES_API.to_string()),
            model: Some(self.model_id.clone()),
            stop_reason: Some(self.stop_reason),
            provider_meta: ProviderOpaqueMeta {
                openai_response_id: self.response_id.clone(),
                extra: assistant_extra,
                ..Default::default()
            },
            created_at: Utc::now().to_rfc3339(),
        };

        let persisted_assistant = filter_persisted_assistant_history(&assistant);
        let continuation = self
            .response_id
            .map(|resp_id| ProviderContinuationState::OpenAi {
                model: self.model_id,
                response_id: resp_id,
                updated_at: Utc::now().to_rfc3339(),
                request_fingerprint: next_fingerprint,
            });

        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage: self.usage,
            continuation,
            raw_events: self.raw_events,
        })
    }
}
