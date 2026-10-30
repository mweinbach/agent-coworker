use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::{
    ProviderName, assert_within_roots, canonicalize_sync, get_ai_coworker_paths,
    read_connection_store,
};
use cowork_inference::{
    CanonicalMessage, ClientCapabilities as InferenceClientCapabilities, ContentBlock, MessageRole,
    ProviderOpaqueMeta, RequestPolicy, StepBudget, StreamEvent, StreamEventProjector,
    ToolResultPart, TurnUsage,
};
use cowork_protocol::{
    JsonRpcLiteError, JsonRpcLiteNotification, JsonRpcLiteOutbound, TurnInterruptParams,
    TurnStartParams, TurnSteerParams, error_codes,
};
use cowork_providers::chat_completions::lmstudio::{
    LmStudioLocalService, resolve_lmstudio_options,
};
use cowork_providers::{
    AnthropicMessagesTransport, BedrockConverseTransport, ChatCompletionsTransport,
    CodexAppServerTransport, GoogleInteractionsTransport, OpenAiResponsesTransport,
    ProviderStepRequest, ProviderTransport, ToolDefinition, resolve_provider_api_key,
};
use cowork_storage::ThreadJournalEventInput;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::registry::ServerRuntimeState;

const MAX_TURN_TOOL_STEPS: usize = 8;
const MAX_READ_FILE_BYTES: usize = 64 * 1024;
const STEP_TIMEOUT_MS: u64 = 300_000;

pub(crate) struct ActiveTurnControl {
    pub turn_id: String,
    pub cancel_tx: watch::Sender<bool>,
    pub steer_tx: mpsc::UnboundedSender<(String, Option<String>)>,
}

fn new_canonical_message(role: MessageRole, content: Vec<ContentBlock>) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role,
        content,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

fn new_text_block(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.to_owned(),
        phase: None,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn add_opt_u64(dst: &mut Option<u64>, rhs: Option<u64>) {
    if let Some(v) = rhs {
        *dst = Some(dst.unwrap_or(0) + v);
    }
}

fn builtin_workspace_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "read_file".to_owned(),
            description: "Read the UTF-8 contents of a file inside the current workspace."
                .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative or absolute path within the workspace directory."
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "list_dir".to_owned(),
            description: "List files and directories inside a workspace directory.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Optional directory path within the workspace (defaults to '.')."
                    }
                },
                "additionalProperties": false
            }),
        },
    ]
}

fn execute_confined_workspace_tool(
    workspace_cwd: &Path,
    tool_name: &str,
    args: &serde_json::Map<String, Value>,
) -> (Value, String, bool) {
    let canonical_root = canonicalize_sync(workspace_cwd);
    let roots = [canonical_root.clone()];

    match tool_name {
        "read_file" | "read" => {
            let Some(raw_path) = args.get("path").and_then(Value::as_str).map(str::trim) else {
                let err = "Missing required string parameter `path`.".to_owned();
                return (json!({ "error": err }), err, true);
            };
            let candidate = if Path::new(raw_path).is_absolute() {
                PathBuf::from(raw_path)
            } else {
                canonical_root.join(raw_path)
            };
            if let Err(e) = assert_within_roots(&roots, &candidate) {
                let err = format!("Path escapes workspace confinement: {e}");
                return (json!({ "error": err }), err, true);
            }
            match std::fs::read(&candidate) {
                Ok(bytes) => {
                    let truncated = bytes.len() > MAX_READ_FILE_BYTES;
                    let slice = if truncated {
                        &bytes[..MAX_READ_FILE_BYTES]
                    } else {
                        &bytes[..]
                    };
                    let content = String::from_utf8_lossy(slice).into_owned();
                    (
                        json!({
                            "path": raw_path,
                            "content": content,
                            "truncated": truncated,
                        }),
                        content,
                        false,
                    )
                }
                Err(e) => {
                    let err = format!("Failed to read {raw_path}: {e}");
                    (json!({ "error": err }), err, true)
                }
            }
        }
        "list_dir" | "ls" => {
            let raw_path = args
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(".");
            let candidate = if Path::new(raw_path).is_absolute() {
                PathBuf::from(raw_path)
            } else {
                canonical_root.join(raw_path)
            };
            if let Err(e) = assert_within_roots(&roots, &candidate) {
                let err = format!("Path escapes workspace confinement: {e}");
                return (json!({ "error": err }), err, true);
            }
            match std::fs::read_dir(&candidate) {
                Ok(rd) => {
                    let mut entries = Vec::new();
                    for entry in rd.flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                        entries.push(if is_dir { format!("{name}/") } else { name });
                    }
                    entries.sort();
                    let text = entries.join("\n");
                    (
                        json!({
                            "path": raw_path,
                            "entries": entries,
                        }),
                        text,
                        false,
                    )
                }
                Err(e) => {
                    let err = format!("Failed to list {raw_path}: {e}");
                    (json!({ "error": err }), err, true)
                }
            }
        }
        other => {
            let err = format!("Unknown tool: {other}");
            (json!({ "error": err }), err, true)
        }
    }
}

fn parse_stored_canonical_messages(stored: &[Value]) -> Vec<CanonicalMessage> {
    let mut out = Vec::new();
    for val in stored {
        if let Ok(cm) = serde_json::from_value::<CanonicalMessage>(val.clone()) {
            out.push(cm);
            continue;
        }
        let role = match val.get("role").and_then(Value::as_str) {
            Some("assistant") => MessageRole::Assistant,
            Some("system") => MessageRole::System,
            Some("tool") => MessageRole::Tool,
            _ => MessageRole::User,
        };
        if let Some(txt) = val.get("content").and_then(Value::as_str) {
            out.push(new_canonical_message(role, vec![new_text_block(txt)]));
        }
    }
    out
}

fn select_provider_transport(provider: ProviderName) -> Result<Box<dyn ProviderTransport>, String> {
    match provider {
        ProviderName::Openai => Ok(Box::new(OpenAiResponsesTransport::new())),
        ProviderName::Anthropic => Ok(Box::new(AnthropicMessagesTransport::new())),
        ProviderName::Google => Ok(Box::new(GoogleInteractionsTransport::new())),
        ProviderName::Bedrock => Ok(Box::new(BedrockConverseTransport::new())),
        ProviderName::CodexCli => Ok(Box::new(CodexAppServerTransport::new())),
        other => ChatCompletionsTransport::new(other)
            .map(|t| Box::new(t) as Box<dyn ProviderTransport>)
            .ok_or_else(|| format!("Unsupported provider transport: {}", other.as_str())),
    }
}

impl ServerRuntimeState {
    pub async fn handle_turn_start(
        self: &Arc<Self>,
        connection_id: &str,
        tool_retry_lineage: bool,
        params: &TurnStartParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let user_text = params
            .input
            .extract_text()
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        let Some(live_arc) = self.subscribe(connection_id, &params.thread_id) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Unknown thread: {}", params.thread_id),
            ));
        };

        let (provider, model_id, cwd_path, session_provider_opts) = {
            let live = live_arc.lock();
            if live.busy || self.active_turns.contains_key(&params.thread_id) {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_REQUEST,
                    "A turn is already in progress on this thread.",
                ));
            }
            (
                live.provider,
                live.model.clone(),
                PathBuf::from(&live.cwd),
                live.config_overrides
                    .get("providerOptions")
                    .and_then(Value::as_object)
                    .cloned(),
            )
        };

        let mut merged_provider_opts = self
            .load_workspace_config(&cwd_path)
            .ok()
            .and_then(|cfg| cfg.provider_options)
            .unwrap_or_default();
        if let Some(over) = session_provider_opts {
            for (k, v) in over {
                merged_provider_opts.insert(k, v);
            }
        }

        // Pre-turn LM Studio reachability gate (`routes/turn.ts` parity).
        let mut lmstudio_inference_url: Option<String> = None;
        if provider == ProviderName::Lmstudio {
            let svc = LmStudioLocalService::new();
            let status = svc
                .get_status(&self.homedir, &self.env, Some(&merged_provider_opts), None)
                .await;
            if !status.running {
                return Err(JsonRpcLiteError::with_data(
                    error_codes::INVALID_REQUEST,
                    format!(
                        "LM Studio isn't running at {}. Start LM Studio's local server and try again.",
                        status.base_url
                    ),
                    json!({
                        "reason": "lmstudio_unreachable",
                        "provider": "lmstudio",
                        "baseUrl": status.base_url,
                        "installed": status.installed,
                        "canAutoStart": status.can_auto_start,
                    }),
                ));
            }
            let lms_opts = resolve_lmstudio_options(&self.env, Some(&merged_provider_opts), None);
            lmstudio_inference_url = Some(lms_opts.inference_base_url);
            let lms_obj = merged_provider_opts
                .entry("lmstudio".to_owned())
                .or_insert_with(|| json!({}));
            if let Some(map) = lms_obj.as_object_mut() {
                map.entry("autoLoad".to_owned())
                    .or_insert(Value::Bool(false));
            }
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let conn_store = read_connection_store(&paths).await.ok();
        let api_key = resolve_provider_api_key(provider, conn_store.as_ref(), &self.env);

        let base_url = match provider {
            ProviderName::Lmstudio => lmstudio_inference_url,
            _ => merged_provider_opts
                .get(provider.as_str())
                .and_then(Value::as_object)
                .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
                .and_then(Value::as_str)
                .map(str::to_owned),
        };

        merged_provider_opts.insert(
            "coworkHome".to_owned(),
            Value::String(paths.root_dir.to_string_lossy().into_owned()),
        );
        merged_provider_opts.insert(
            "cwd".to_owned(),
            Value::String(cwd_path.to_string_lossy().into_owned()),
        );

        let turn_id = Uuid::new_v4().to_string();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let (steer_tx, mut steer_rx) = mpsc::unbounded_channel::<(String, Option<String>)>();

        {
            let mut live = live_arc.lock();
            live.busy = true;
            live.idle_since = None;
        }
        self.active_turns.insert(
            params.thread_id.clone(),
            ActiveTurnControl {
                turn_id: turn_id.clone(),
                cancel_tx,
                steer_tx,
            },
        );

        let runtime = Arc::clone(self);
        let thread_id = params.thread_id.clone();
        let conn_id = connection_id.to_owned();
        let client_message_id = params.client_message_id.clone();
        let live_for_task = Arc::clone(&live_arc);
        let return_turn_id = turn_id.clone();

        tokio::spawn(async move {
            let mut projector = StreamEventProjector::new(
                &thread_id,
                InferenceClientCapabilities { tool_retry_lineage },
            );

            let mut history = {
                let live = live_for_task.lock();
                parse_stored_canonical_messages(&live.messages)
            };

            let (journal_tx, mut journal_rx) = mpsc::unbounded_channel::<ThreadJournalEventInput>();
            let journal_for_writer = Arc::clone(&runtime.journal);
            let journal_writer = tokio::spawn(async move {
                while let Some(entry) = journal_rx.recv().await {
                    let _ = journal_for_writer.enqueue(entry).await;
                }
            });

            let emit_event = |proj: &mut StreamEventProjector, ev: &StreamEvent| {
                let notifications = proj.project(ev);
                let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

                for notif in &notifications {
                    let item_id = notif
                        .params
                        .get("itemId")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            notif
                                .params
                                .get("item")
                                .and_then(|i| i.get("id"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_owned);
                    let _ = journal_tx.send(ThreadJournalEventInput {
                        thread_id: thread_id.clone(),
                        ts: ts.clone(),
                        event_type: notif.method.clone(),
                        turn_id: Some(turn_id.clone()),
                        item_id,
                        request_id: None,
                        payload: notif.params.clone(),
                    });

                    let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                        method: notif.method.clone(),
                        params: Some(notif.params.clone()),
                    });
                    runtime.broadcast_to_thread(&thread_id, Some(&conn_id), &outbound);
                }
            };

            emit_event(
                &mut projector,
                &StreamEvent::TurnStarted {
                    turn_id: turn_id.clone(),
                },
            );
            emit_event(
                &mut projector,
                &StreamEvent::UserMessage {
                    turn_id: turn_id.clone(),
                    text: user_text.clone(),
                    client_message_id: client_message_id.clone(),
                    steer_request_id: None,
                    annotations: Vec::new(),
                },
            );

            history.push(new_canonical_message(
                MessageRole::User,
                vec![new_text_block(&user_text)],
            ));

            let tools = builtin_workspace_tools();
            let system_prompt = format!(
                "You are Cowork, a helpful coding and workspace assistant operating in `{}`. Use the provided workspace tools (`read_file`, `list_dir`) whenever inspecting files is needed, and answer concisely and accurately.",
                cwd_path.display()
            );

            let mut final_status = "completed".to_owned();
            let mut total_usage = TurnUsage::default();
            let mut last_assistant_preview = user_text.clone();

            match select_provider_transport(provider) {
                Ok(transport) => {
                    for _step in 0..MAX_TURN_TOOL_STEPS {
                        if *cancel_rx.borrow() {
                            final_status = "interrupted".to_owned();
                            break;
                        }

                        while let Ok((steer_text, steer_cid)) = steer_rx.try_recv() {
                            emit_event(
                                &mut projector,
                                &StreamEvent::UserMessage {
                                    turn_id: turn_id.clone(),
                                    text: steer_text.clone(),
                                    client_message_id: steer_cid,
                                    steer_request_id: Some(Uuid::new_v4().to_string()),
                                    annotations: Vec::new(),
                                },
                            );
                            history.push(new_canonical_message(
                                MessageRole::User,
                                vec![new_text_block(&steer_text)],
                            ));
                        }

                        let req = ProviderStepRequest {
                            model_id: model_id.clone(),
                            base_url: base_url.clone(),
                            api_key: api_key.clone(),
                            extra_headers: HashMap::new(),
                            system_prompt: system_prompt.clone(),
                            messages: history.clone(),
                            tools: tools.clone(),
                            authorized_tool_names: None,
                            provider_options: merged_provider_opts.clone(),
                            continuation: None,
                            policy: RequestPolicy::default(),
                            turn_id: turn_id.clone(),
                        };
                        let budget = StepBudget::new(STEP_TIMEOUT_MS, None);

                        let step_outcome = {
                            let mut cb = |ev: StreamEvent| {
                                emit_event(&mut projector, &ev);
                            };
                            tokio::select! {
                                res = transport.stream_step(req, &budget, &mut cb) => Some(res),
                                _ = cancel_rx.changed() => None,
                            }
                        };

                        let Some(step_res) = step_outcome else {
                            final_status = "interrupted".to_owned();
                            break;
                        };

                        match step_res {
                            Ok(res) => {
                                total_usage.prompt_tokens += res.usage.prompt_tokens;
                                total_usage.completion_tokens += res.usage.completion_tokens;
                                total_usage.total_tokens += res.usage.total_tokens;
                                add_opt_u64(
                                    &mut total_usage.cached_prompt_tokens,
                                    res.usage.cached_prompt_tokens,
                                );
                                add_opt_u64(
                                    &mut total_usage.cache_write_prompt_tokens,
                                    res.usage.cache_write_prompt_tokens,
                                );
                                add_opt_u64(
                                    &mut total_usage.reasoning_output_tokens,
                                    res.usage.reasoning_output_tokens,
                                );

                                let mut tool_calls = Vec::new();
                                for block in &res.assistant.content {
                                    match block {
                                        ContentBlock::Text { text, .. }
                                            if !text.trim().is_empty() =>
                                        {
                                            last_assistant_preview = text.clone();
                                        }
                                        ContentBlock::ToolCall {
                                            id,
                                            name,
                                            arguments,
                                            ..
                                        } => {
                                            tool_calls.push((
                                                id.clone(),
                                                name.clone(),
                                                arguments.clone(),
                                            ));
                                        }
                                        _ => {}
                                    }
                                }

                                let persisted_msg = res
                                    .persisted_assistant
                                    .unwrap_or_else(|| res.assistant.clone());
                                history.push(persisted_msg);

                                if tool_calls.is_empty() {
                                    break;
                                }

                                let mut tool_result_blocks = Vec::with_capacity(tool_calls.len());
                                for (tc_id, tc_name, tc_args) in tool_calls {
                                    let (json_res, text_res, is_error) =
                                        execute_confined_workspace_tool(
                                            &cwd_path, &tc_name, &tc_args,
                                        );
                                    emit_event(
                                        &mut projector,
                                        &StreamEvent::ToolResult {
                                            turn_id: turn_id.clone(),
                                            key: tc_id.clone(),
                                            name: tc_name.clone(),
                                            result: json_res.clone(),
                                            is_error,
                                            denied: false,
                                        },
                                    );
                                    tool_result_blocks.push(ContentBlock::ToolResult {
                                        tool_call_id: tc_id,
                                        tool_name: Some(tc_name),
                                        content: vec![ToolResultPart::Text { text: text_res }],
                                        structured_meta: Some(json_res),
                                        is_error,
                                        provider_meta: ProviderOpaqueMeta::default(),
                                    });
                                }

                                history.push(new_canonical_message(
                                    MessageRole::Tool,
                                    tool_result_blocks,
                                ));
                            }
                            Err(err) => {
                                final_status = "failed".to_owned();
                                emit_event(
                                    &mut projector,
                                    &StreamEvent::Error {
                                        turn_id: turn_id.clone(),
                                        message: err.message,
                                        code: None,
                                    },
                                );
                                break;
                            }
                        }
                    }
                }
                Err(msg) => {
                    final_status = "failed".to_owned();
                    emit_event(
                        &mut projector,
                        &StreamEvent::Error {
                            turn_id: turn_id.clone(),
                            message: msg,
                            code: None,
                        },
                    );
                }
            }

            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            {
                let mut live = live_for_task.lock();
                live.busy = false;
                live.updated_at = now;
                live.messages = history
                    .iter()
                    .filter_map(|m| serde_json::to_value(m).ok())
                    .collect();
                live.message_count = live.messages.len();
                live.last_message_preview =
                    Some(last_assistant_preview.chars().take(180).collect::<String>());
            }
            runtime.active_turns.remove(&thread_id);
            let _ = runtime
                .persist_live_session(&live_for_task, "turn/completed")
                .await;

            emit_event(
                &mut projector,
                &StreamEvent::TurnCompleted {
                    turn_id: turn_id.clone(),
                    status: final_status,
                    usage: Some(total_usage),
                },
            );
            drop(journal_tx);
            let _ = journal_writer.await;
        });

        Ok(json!({
            "turn": {
                "id": return_turn_id,
                "threadId": params.thread_id,
                "status": "inProgress",
                "items": [],
            }
        }))
    }

    pub fn handle_turn_steer(&self, params: &TurnSteerParams) -> Result<Value, JsonRpcLiteError> {
        let steer_text = params
            .input
            .extract_text()
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        let Some(ctrl) = self.active_turns.get(&params.thread_id) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!("No active turn to steer on thread {}", params.thread_id),
            ));
        };
        if let Some(expected_turn) = params.turn_id.as_deref().filter(|s| !s.trim().is_empty())
            && ctrl.turn_id != expected_turn
        {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "Active turn {} does not match requested turnId {}",
                    ctrl.turn_id, expected_turn
                ),
            ));
        }

        let active_turn_id = ctrl.turn_id.clone();
        ctrl.steer_tx
            .send((steer_text, params.client_message_id.clone()))
            .map_err(|_| {
                JsonRpcLiteError::new(
                    error_codes::INVALID_REQUEST,
                    "Turn completed before steer message could be delivered.",
                )
            })?;

        Ok(json!({
            "accepted": true,
            "turnId": active_turn_id,
        }))
    }

    pub fn handle_turn_interrupt(
        &self,
        params: &TurnInterruptParams,
    ) -> Result<Value, JsonRpcLiteError> {
        if let Some(ctrl) = self.active_turns.get(&params.thread_id) {
            let _ = ctrl.cancel_tx.send(true);
            return Ok(json!({
                "interrupted": true,
                "turnId": ctrl.turn_id,
            }));
        }
        Ok(json!({ "interrupted": false }))
    }
}
