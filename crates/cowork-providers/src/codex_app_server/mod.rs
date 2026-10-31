pub mod client;
pub mod connectors;
pub mod isolation;
pub mod policy;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::{
    SandboxMode, cowork_home, env_map_from_process, host_platform, resolve_home_dir,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, ContinuationFingerprintInput, MessageRole,
    ProviderContinuationState, ProviderOpaqueMeta, ProviderTransportError, ReasoningStreamMode,
    StepBudget, StopReason, StreamEvent, TurnUsage, compute_continuation_fingerprint,
    filter_persisted_assistant_history, validate_continuation_state,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};

pub use client::{
    CodexAppServerClient, CodexAppServerPool, CodexNotification, CodexTurnSteerParams,
    DynamicToolCallOutput, DynamicToolHandler,
};
pub use connectors::{
    CodexAccountInfo, CodexChatGptLoginChallenge, CodexRateLimits, OpenAiNativeConnectorInfo,
    OpenAiNativeConnectorsEvent, await_codex_chatgpt_login_completion, list_codex_models,
    logout_codex_account, parse_codex_chatgpt_login_challenge, read_codex_account,
    read_openai_native_connectors, set_openai_native_connector_enabled, start_codex_chatgpt_login,
};
pub use isolation::{
    CODEX_APP_SERVER_MANAGED_VERSION, CodexInstallStatus, build_codex_spawn_env,
    resolve_codex_app_server_status, resolve_codex_home, sync_codex_windows_sandbox_setup_state,
};
pub use policy::{
    CodexSandboxNarrowingInput, CodexSandboxNarrowingOutput, filter_codex_dynamic_tools,
    from_codex_mcp_tool_name, resolve_codex_sandbox_and_approval_policy, to_codex_mcp_tool_name,
};

pub trait CodexTurnObserver: Send + Sync {
    fn on_turn_started(
        &self,
        client: Arc<CodexAppServerClient>,
        codex_thread_id: &str,
        codex_turn_id: Option<&str>,
    );
}

#[derive(Clone, Default)]
pub struct CodexAppServerTransport {
    pub command_override: Option<(String, Vec<String>)>,
    pub tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    pub env_override: Option<HashMap<String, String>>,
    pub turn_observer: Option<Arc<dyn CodexTurnObserver>>,
}

impl std::fmt::Debug for CodexAppServerTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexAppServerTransport")
            .field("command_override", &self.command_override)
            .field("has_tool_handler", &self.tool_handler.is_some())
            .field("has_env_override", &self.env_override.is_some())
            .field("has_turn_observer", &self.turn_observer.is_some())
            .finish()
    }
}

impl CodexAppServerTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_env(env: HashMap<String, String>) -> Self {
        Self {
            env_override: Some(env),
            ..Self::default()
        }
    }

    pub fn with_env_and_bridges(
        env: HashMap<String, String>,
        tool_handler: Option<Arc<dyn DynamicToolHandler>>,
        turn_observer: Option<Arc<dyn CodexTurnObserver>>,
    ) -> Self {
        Self {
            command_override: None,
            tool_handler,
            env_override: Some(env),
            turn_observer,
        }
    }

    pub fn with_command_override(command: String, args: Vec<String>) -> Self {
        Self {
            command_override: Some((command, args)),
            ..Self::default()
        }
    }

    pub fn with_command_and_handler(
        command: String,
        args: Vec<String>,
        tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    ) -> Self {
        Self {
            command_override: Some((command, args)),
            tool_handler,
            ..Self::default()
        }
    }
}

#[async_trait]
impl ProviderTransport for CodexAppServerTransport {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let env = self
            .env_override
            .clone()
            .unwrap_or_else(env_map_from_process);
        let homedir = resolve_home_dir(&env, host_platform());
        let resolved_cowork_home = request
            .provider_options
            .get("coworkHome")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| cowork_home(&env));
        let cwd = request
            .provider_options
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| homedir.clone());

        let (command, args) = match &self.command_override {
            Some((cmd, a)) => (cmd.clone(), a.clone()),
            None => {
                let status = resolve_codex_app_server_status(&resolved_cowork_home, &env);
                if !status.available {
                    return Err(ProviderTransportError::protocol(status.message));
                }
                (
                    status.command.unwrap_or_else(|| "codex".to_string()),
                    status.args.unwrap_or_default(),
                )
            }
        };

        let sandbox_mode = request
            .provider_options
            .get("sandboxMode")
            .and_then(|v| serde_json::from_value::<SandboxMode>(v.clone()).ok())
            .unwrap_or(SandboxMode::WorkspaceWrite);
        let network = request
            .provider_options
            .get("sandboxNetwork")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let yolo = request
            .provider_options
            .get("yolo")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let policy = resolve_codex_sandbox_and_approval_policy(&CodexSandboxNarrowingInput {
            mode: sandbox_mode,
            network,
            yolo,
            workspace_dir: cwd.clone(),
            agent_target_paths: Vec::new(),
            read_only_role: false,
            has_mutation_guard_with_dynamic_tools: false,
        });

        let dynamic_tools = filter_codex_dynamic_tools(&request.tools, false);
        let wire_dynamic_tools: Vec<Value> = dynamic_tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.parameters,
                })
            })
            .collect();

        let client = CodexAppServerClient::spawn_stdio(
            &command,
            &args,
            &cwd,
            &resolved_cowork_home,
            &env,
            self.tool_handler.clone(),
        )
        .await?;

        // Pre-arm notification subscription BEFORE `thread/start` and `turn/start` so fast turns never race!
        let mut notif_rx = client.subscribe_notifications();

        let mut config_overrides = serde_json::Map::new();
        if policy.force_disable_web_search {
            config_overrides.insert("web_search".into(), Value::String("disabled".into()));
        }

        let thread_res = client
            .request(
                "thread/start",
                Some(json!({
                    "model": request.model_id,
                    "cwd": cwd.to_string_lossy(),
                    "approvalPolicy": policy.approval_policy,
                    "sandbox": policy.thread_sandbox,
                    "developerInstructions": request.system_prompt,
                    "dynamicTools": wire_dynamic_tools,
                    "config": config_overrides,
                })),
            )
            .await?;

        let thread_id = thread_res
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderTransportError::protocol("Codex thread/start did not return thread.id")
            })?
            .to_string();

        let prompt_text: String = request
            .messages
            .iter()
            .rev()
            .find(|m| m.role == MessageRole::User)
            .map(|m| {
                m.content
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        let turn_res = client
            .request(
                "turn/start",
                Some(json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": prompt_text }],
                    "sandboxPolicy": policy.turn_sandbox_policy,
                    "approvalPolicy": policy.approval_policy,
                })),
            )
            .await?;

        let codex_turn_id = turn_res
            .get("turn")
            .and_then(|t| t.get("id"))
            .or_else(|| turn_res.get("turnId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if let Some(obs) = &self.turn_observer {
            obs.on_turn_started(Arc::clone(&client), &thread_id, codex_turn_id.as_deref());
        }

        let turn_id = request.turn_id.clone();
        let think_stream_id = format!("{turn_id}:codex-think");
        let mut thinking_started = false;
        let mut thinking_closed = false;
        let mut thinking_text = String::new();
        let mut text_started = false;
        let mut text_closed = false;
        let mut visible_text = String::new();
        let mut usage = TurnUsage::default();
        let mut raw_events = Vec::new();

        let wait_res = budget
            .run_attempt(request.policy.step_timeout_ms, async {
                while let Some(notif) = notif_rx.recv().await {
                    raw_events.push(json!({
                        "method": notif.method,
                        "params": notif.params,
                    }));
                    match notif.method.as_str() {
                        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                            if let Some(d) = notif.params.get("delta").and_then(Value::as_str)
                                && !d.is_empty()
                            {
                                if !thinking_started {
                                    thinking_started = true;
                                    on_event(StreamEvent::ThinkingStart {
                                        turn_id: turn_id.clone(),
                                        stream_id: think_stream_id.clone(),
                                        mode: ReasoningStreamMode::Summary,
                                    });
                                }
                                thinking_text.push_str(d);
                                on_event(StreamEvent::ThinkingDelta {
                                    turn_id: turn_id.clone(),
                                    stream_id: think_stream_id.clone(),
                                    mode: ReasoningStreamMode::Summary,
                                    delta: d.to_string(),
                                });
                            }
                        }
                        "item/agentMessage/delta" => {
                            if let Some(d) = notif.params.get("delta").and_then(Value::as_str)
                                && !d.is_empty()
                            {
                                if thinking_started && !thinking_closed {
                                    thinking_closed = true;
                                    on_event(StreamEvent::ThinkingEnd {
                                        turn_id: turn_id.clone(),
                                        stream_id: think_stream_id.clone(),
                                        mode: ReasoningStreamMode::Summary,
                                        text: thinking_text.clone(),
                                        signature: None,
                                        redacted: false,
                                    });
                                }
                                if !text_started {
                                    text_started = true;
                                    on_event(StreamEvent::TextStart {
                                        turn_id: turn_id.clone(),
                                        block_index: 0,
                                        phase: None,
                                    });
                                }
                                visible_text.push_str(d);
                                on_event(StreamEvent::TextDelta {
                                    turn_id: turn_id.clone(),
                                    block_index: 0,
                                    delta: d.to_string(),
                                    phase: None,
                                });
                            }
                        }
                        "thread/tokenUsage/updated" => {
                            if let Some(u) =
                                notif.params.get("tokenUsage").and_then(|tu| tu.get("last"))
                            {
                                let inp = u
                                    .get("inputTokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.prompt_tokens);
                                let out = u
                                    .get("outputTokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.completion_tokens);
                                usage.prompt_tokens = inp;
                                usage.completion_tokens = out;
                                usage.total_tokens = inp + out;
                            }
                        }
                        "turn/completed" => {
                            if let Some(u) = notif.params.get("usage") {
                                let inp = u
                                    .get("inputTokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.prompt_tokens);
                                let out = u
                                    .get("outputTokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.completion_tokens);
                                usage.prompt_tokens = inp;
                                usage.completion_tokens = out;
                                usage.total_tokens = inp + out;
                            }
                            break;
                        }
                        _ => {}
                    }
                }
                Ok(())
            })
            .await;

        client.close().await;
        wait_res?;

        if thinking_started && !thinking_closed {
            on_event(StreamEvent::ThinkingEnd {
                turn_id: turn_id.clone(),
                stream_id: think_stream_id,
                mode: ReasoningStreamMode::Summary,
                text: thinking_text.clone(),
                signature: None,
                redacted: false,
            });
        }
        if text_started && !text_closed {
            let _ = &mut text_closed;
            on_event(StreamEvent::TextEnd {
                turn_id: turn_id.clone(),
                block_index: 0,
                text: visible_text.clone(),
                phase: None,
                citations: Vec::new(),
                annotations: Vec::new(),
            });
        }

        let mut content = Vec::new();
        if !thinking_text.is_empty() {
            content.push(ContentBlock::Thinking {
                text: thinking_text,
                summary: None,
                redacted: false,
                signature: None,
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }
        if !visible_text.is_empty() {
            content.push(ContentBlock::Text {
                text: visible_text,
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }

        let assistant = CanonicalMessage {
            id: format!("msg-{}", Uuid::new_v4()),
            role: MessageRole::Assistant,
            content,
            phase: None,
            provider: Some("codex-cli".to_string()),
            api: Some("codex-app-server".to_string()),
            model: Some(request.model_id.clone()),
            stop_reason: Some(StopReason::Stop),
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: Utc::now().to_rfc3339(),
        };
        let persisted_assistant = filter_persisted_assistant_history(&assistant);
        let mut next_prefix = request.messages.clone();
        if let Some(ref p) = persisted_assistant {
            next_prefix.push(p.clone());
        } else {
            next_prefix.push(assistant.clone());
        }
        let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
            provider: "codex-cli",
            model_id: &request.model_id,
            system_prompt: &request.system_prompt,
            tools: &wire_dynamic_tools,
            authorized_tool_names: request.authorized_tool_names.as_deref(),
            canonical_prefix: &next_prefix,
            stream_options: &request.provider_options,
        });
        let _ = validate_continuation_state(
            request.continuation.as_ref(),
            "codex-cli",
            &request.model_id,
            &fp,
        );
        let continuation = Some(ProviderContinuationState::CodexCli {
            model: request.model_id,
            thread_id,
            updated_at: Utc::now().to_rfc3339(),
            request_fingerprint: Some(fp),
        });

        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage,
            continuation,
            raw_events,
        })
    }
}
