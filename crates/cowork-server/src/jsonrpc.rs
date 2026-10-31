use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use cowork_protocol::{
    ClientInfo, CommandExecuteParams, CommandListParams, ConnectorsOpenAiNativeListParams,
    ConnectorsOpenAiNativeRefreshParams, ConnectorsOpenAiNativeSetEnabledParams,
    CreationPreflightParams, InitializeResult, JSONRPC_PROTOCOL_VERSION, JsonRpcLiteClientMessage,
    JsonRpcLiteError, JsonRpcLiteId, JsonRpcLiteNotification, JsonRpcLiteOutbound,
    JsonRpcLiteRequest, JsonRpcLiteResponse, MemoryAdvancedDeleteParams,
    MemoryAdvancedFolderDeleteParams, MemoryAdvancedFolderGenerateParams,
    MemoryAdvancedFolderListParams, MemoryAdvancedFolderUpsertParams, MemoryAdvancedGenerateParams,
    MemoryAdvancedListParams, MemoryAdvancedUpsertParams, MemoryDeleteParams, MemoryListParams,
    MemoryUpsertParams, NegotiatedServerCapabilities, ProviderAuthAuthorizeParams,
    ProviderAuthCallbackParams, ProviderAuthCopyApiKeyParams, ProviderAuthLogoutParams,
    ProviderAuthMethodsReadParams, ProviderAuthSetApiKeyParams, ProviderAuthSetConfigParams,
    ProviderCatalogReadParams, ProviderCodexAppServerStatusParams,
    ProviderCodexAppServerUpdateParams, ProviderCustomModelAddParams,
    ProviderCustomModelDeleteParams, ProviderLmStudioLocalStartParams,
    ProviderLmStudioLocalStatusParams, ProviderModelResetEnabledParams,
    ProviderModelSetEnabledParams, ProviderStatusRefreshParams, RuntimeDiagnosticsReadParams,
    RuntimeLibreOfficeCheckParams, ServerInfo, SessionConfigSetParams, SessionDefaultsApplyParams,
    SessionDeleteParams, SessionFileUploadParams, SessionHarnessContextGetParams,
    SessionHarnessContextSetParams, SessionModelSetParams, SessionStateReadParams,
    SessionTitleSetParams, SessionUsageBudgetSetParams, ThreadArchivedSetParams, ThreadForkParams,
    ThreadHydrateParams, ThreadListParams, ThreadPinnedSetParams, ThreadReadParams,
    ThreadResumeParams, ThreadStartParams, ThreadUnsubscribeParams, TransportDescriptor,
    TurnInterruptParams, TurnStartParams, TurnSteerParams, WorkspaceBootstrapParams,
    WorkspaceListParams, WorkspaceSwitchParams, error_codes, parse_initialize_params,
    parse_initialized_params,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::http_desktop::build_workspace_summaries;
use crate::registry::ServerRuntimeState;

#[derive(Debug)]
struct HandshakeFlags {
    initialize_received: bool,
    initialized_received: bool,
    client_info: Option<ClientInfo>,
    tool_retry_lineage: bool,
    opt_out_methods: HashSet<String>,
}

/// Per-connection JSON-RPC-lite state (`initialize` -> `initialized` guard + overload counter).
#[derive(Debug)]
pub struct ConnectionRpcState {
    pub connection_id: String,
    pub transport_type: String,
    pub selected_subprotocol: Option<String>,
    flags: Mutex<HandshakeFlags>,
    pending_requests: Arc<AtomicUsize>,
}

impl ConnectionRpcState {
    pub fn new(
        connection_id: impl Into<String>,
        transport_type: impl Into<String>,
        selected_subprotocol: Option<String>,
    ) -> Self {
        Self {
            connection_id: connection_id.into(),
            transport_type: transport_type.into(),
            selected_subprotocol,
            flags: Mutex::new(HandshakeFlags {
                initialize_received: false,
                initialized_received: false,
                client_info: None,
                tool_retry_lineage: false,
                opt_out_methods: HashSet::new(),
            }),
            pending_requests: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn is_ready(&self) -> bool {
        let g = self.flags.lock();
        g.initialize_received && g.initialized_received
    }

    pub fn client_info(&self) -> Option<ClientInfo> {
        self.flags.lock().client_info.clone()
    }

    pub fn tool_retry_lineage(&self) -> bool {
        self.flags.lock().tool_retry_lineage
    }
}

struct PendingRequestGuard {
    counter: Arc<AtomicUsize>,
}

impl PendingRequestGuard {
    fn try_acquire(counter: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        loop {
            let current = counter.load(Ordering::Acquire);
            if current >= max {
                return None;
            }
            if counter
                .compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(Self {
                    counter: counter.clone(),
                });
            }
        }
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

fn parse_params_required<T: DeserializeOwned>(
    method: &str,
    raw: Option<&Value>,
) -> Result<T, JsonRpcLiteError> {
    let Some(val) = raw else {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid params"),
        ));
    };
    serde_json::from_value::<T>(val.clone()).map_err(|err| {
        JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {err}"))
    })
}

fn parse_params_optional<T: DeserializeOwned + Default>(
    method: &str,
    raw: Option<&Value>,
) -> Result<T, JsonRpcLiteError> {
    match raw {
        None | Some(Value::Null) => Ok(T::default()),
        Some(val) => serde_json::from_value::<T>(val.clone()).map_err(|err| {
            JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {err}"))
        }),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionalCwdParams {
    cwd: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsListParams {
    cwd: Option<String>,
}

/// Dispatches a validated JSON-RPC-lite client message against `ConnectionRpcState` and `ServerRuntimeState`.
/// Returns `Some(response)` when an outbound JSON-RPC response frame must be returned.
pub async fn dispatch_client_message(
    runtime: &Arc<ServerRuntimeState>,
    conn: &ConnectionRpcState,
    message: JsonRpcLiteClientMessage,
) -> Option<JsonRpcLiteResponse> {
    match message {
        JsonRpcLiteClientMessage::ClientResponse(client_resp) => {
            // Client replies to server-initiated requests bypass pre-init guards.
            runtime.resolve_client_interaction_response(&conn.connection_id, &client_resp)
        }
        JsonRpcLiteClientMessage::Notification(notif) => {
            dispatch_notification(runtime, conn, notif)
        }
        JsonRpcLiteClientMessage::Request(req) => Some(dispatch_request(runtime, conn, req).await),
    }
}

fn dispatch_notification(
    _runtime: &Arc<ServerRuntimeState>,
    conn: &ConnectionRpcState,
    notif: JsonRpcLiteNotification,
) -> Option<JsonRpcLiteResponse> {
    if notif.method == "initialize" {
        return Some(JsonRpcLiteResponse::error(
            None,
            JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "initialize must be sent as a request",
            ),
        ));
    }

    if notif.method == "initialized" {
        if let Err(err) = parse_initialized_params(notif.params.as_ref()) {
            return Some(JsonRpcLiteResponse::error(None, err));
        }
        let mut flags = conn.flags.lock();
        if !flags.initialize_received {
            return Some(JsonRpcLiteResponse::error(
                None,
                JsonRpcLiteError::new(error_codes::NOT_INITIALIZED, "Not initialized"),
            ));
        }
        flags.initialized_received = true;
        return None;
    }

    if !conn.is_ready() {
        return Some(JsonRpcLiteResponse::error(
            None,
            JsonRpcLiteError::new(error_codes::NOT_INITIALIZED, "Not initialized"),
        ));
    }

    // Known or unknown post-handshake notifications are benignly ignored.
    None
}

async fn dispatch_request(
    runtime: &Arc<ServerRuntimeState>,
    conn: &ConnectionRpcState,
    req: JsonRpcLiteRequest,
) -> JsonRpcLiteResponse {
    if req.method == "initialize" {
        {
            let flags = conn.flags.lock();
            if flags.initialize_received {
                return JsonRpcLiteResponse::error(
                    Some(req.id),
                    JsonRpcLiteError::new(error_codes::ALREADY_INITIALIZED, "Already initialized"),
                );
            }
        }
        let parsed = match parse_initialize_params(req.params.as_ref()) {
            Ok(p) => p,
            Err(err) => return JsonRpcLiteResponse::error(Some(req.id), err),
        };
        let tool_retry_lineage = parsed
            .capabilities
            .as_ref()
            .and_then(|c| c.tool_retry_lineage)
            == Some(true);
        let opt_out: HashSet<String> = parsed
            .capabilities
            .as_ref()
            .and_then(|c| c.opt_out_notification_methods.clone())
            .unwrap_or_default()
            .into_iter()
            .collect();

        {
            let mut flags = conn.flags.lock();
            if flags.initialize_received {
                return JsonRpcLiteResponse::error(
                    Some(req.id),
                    JsonRpcLiteError::new(error_codes::ALREADY_INITIALIZED, "Already initialized"),
                );
            }
            flags.initialize_received = true;
            flags.client_info = Some(parsed.client_info);
            flags.tool_retry_lineage = tool_retry_lineage;
            flags.opt_out_methods = opt_out.clone();
        }
        runtime.send_queue.set_connection_capabilities(
            &conn.connection_id,
            opt_out,
            tool_retry_lineage,
        );

        let result = InitializeResult {
            protocol_version: JSONRPC_PROTOCOL_VERSION.to_owned(),
            server_info: ServerInfo {
                name: "cowork".to_owned(),
                subprotocol: conn.selected_subprotocol.clone(),
            },
            capabilities: NegotiatedServerCapabilities {
                experimental_api: true,
                tool_retry_lineage: tool_retry_lineage.then_some(true),
            },
            transport: TransportDescriptor {
                transport_type: conn.transport_type.clone(),
                protocol_mode: "jsonrpc".to_owned(),
            },
        };
        return JsonRpcLiteResponse::success(req.id, serde_json::to_value(result).unwrap());
    }

    if req.method == "initialized" {
        if let Err(err) = parse_initialized_params(req.params.as_ref()) {
            return JsonRpcLiteResponse::error(Some(req.id), err);
        }
        let mut flags = conn.flags.lock();
        if !flags.initialize_received {
            return JsonRpcLiteResponse::error(
                Some(req.id),
                JsonRpcLiteError::new(error_codes::NOT_INITIALIZED, "Not initialized"),
            );
        }
        flags.initialized_received = true;
        return JsonRpcLiteResponse::success(req.id, json!({}));
    }

    if !conn.is_ready() {
        return JsonRpcLiteResponse::error(
            Some(req.id),
            JsonRpcLiteError::new(error_codes::NOT_INITIALIZED, "Not initialized"),
        );
    }

    let Some(_guard) =
        PendingRequestGuard::try_acquire(&conn.pending_requests, runtime.max_pending_requests)
    else {
        return JsonRpcLiteResponse::error(
            Some(req.id),
            JsonRpcLiteError::new(
                error_codes::SERVER_OVERLOADED,
                "Too many in-flight JSON-RPC requests",
            ),
        );
    };

    let req_id: JsonRpcLiteId = req.id.clone();
    match route_ready_request(runtime, conn, &req).await {
        Ok(result) => JsonRpcLiteResponse::success(req_id, result),
        Err(err) => JsonRpcLiteResponse::error(Some(req_id), err),
    }
}

async fn route_ready_request(
    runtime: &Arc<ServerRuntimeState>,
    conn: &ConnectionRpcState,
    req: &JsonRpcLiteRequest,
) -> Result<Value, JsonRpcLiteError> {
    let method = req.method.as_str();
    match method {
        "ping" => {
            if let Some(val) = &req.params
                && !val.is_object()
                && !val.is_null()
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    "ping: invalid params",
                ));
            }
            Ok(json!({}))
        }

        "thread/start" => {
            let p: ThreadStartParams = parse_params_optional(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let (thread, _) = runtime
                .start_or_get_thread(
                    &cwd,
                    p.client_thread_id.as_deref(),
                    p.provider.as_deref(),
                    p.model.as_deref(),
                    &conn.connection_id,
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let out = json!({ "thread": thread });
            runtime.send_to_connection(
                &conn.connection_id,
                &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: "thread/started".to_owned(),
                    params: Some(out.clone()),
                }),
            );
            Ok(out)
        }

        "thread/resume" => {
            let p: ThreadResumeParams = parse_params_required(method, req.params.as_ref())?;
            let (thread, replay_health) = runtime
                .resume_thread(&conn.connection_id, &p.thread_id, p.after_seq.unwrap_or(0))
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let mut out = Map::new();
            out.insert(
                "thread".to_owned(),
                serde_json::to_value(&thread).unwrap_or(Value::Null),
            );
            if let Some(rh) = replay_health {
                out.insert(
                    "replayHealth".to_owned(),
                    serde_json::to_value(rh).unwrap_or(Value::Null),
                );
            }
            runtime.send_to_connection(
                &conn.connection_id,
                &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: "thread/started".to_owned(),
                    params: Some(json!({ "thread": thread })),
                }),
            );
            Ok(Value::Object(out))
        }

        "thread/list" => {
            let p: ThreadListParams = parse_params_optional(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let (threads, total) = runtime.list_workspace_threads(&cwd, p.offset, p.limit);
            Ok(json!({
                "threads": threads,
                "total": total,
            }))
        }

        "thread/read" => {
            let p: ThreadReadParams = parse_params_required(method, req.params.as_ref())?;
            runtime
                .read_or_hydrate_thread(&p.thread_id, 0, p.include_turns.unwrap_or(false))
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))
        }

        "thread/hydrate" => {
            let p: ThreadHydrateParams = parse_params_required(method, req.params.as_ref())?;
            runtime
                .read_or_hydrate_thread(
                    &p.thread_id,
                    p.after_seq.unwrap_or(0),
                    p.include_turns.unwrap_or(false),
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))
        }

        "thread/unsubscribe" => {
            let p: ThreadUnsubscribeParams = parse_params_required(method, req.params.as_ref())?;
            let status = runtime.unsubscribe(&conn.connection_id, &p.thread_id);
            if status == "unsubscribed" {
                runtime.send_to_connection(
                    &conn.connection_id,
                    &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                        method: "thread/closed".to_owned(),
                        params: Some(json!({ "threadId": p.thread_id })),
                    }),
                );
            }
            Ok(json!({ "status": status }))
        }

        "thread/fork" => {
            let p: ThreadForkParams = parse_params_required(method, req.params.as_ref())?;
            runtime
                .handle_thread_fork(Some(&conn.connection_id), &p)
                .await
        }

        "thread/pinned/set" => {
            let p: ThreadPinnedSetParams = parse_params_required(method, req.params.as_ref())?;
            let thread = runtime
                .set_thread_pinned(&p.thread_id, p.pinned)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "thread": thread }))
        }

        "thread/archived/set" => {
            let p: ThreadArchivedSetParams = parse_params_required(method, req.params.as_ref())?;
            let thread = runtime
                .set_thread_archived(&p.thread_id, p.archived)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "thread": thread }))
        }

        "cowork/session/title/set" => {
            let p: SessionTitleSetParams = parse_params_required(method, req.params.as_ref())?;
            let event = runtime
                .set_session_title(&p.thread_id, &p.title)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/state/read" => {
            let p: SessionStateReadParams = parse_params_optional(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let events = runtime
                .read_workspace_state(&conn.connection_id, &cwd)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "events": events }))
        }

        "cowork/session/model/set" => {
            let p: SessionModelSetParams = parse_params_required(method, req.params.as_ref())?;
            let event = runtime
                .set_session_model(&p.thread_id, p.provider.as_deref(), &p.model)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/usageBudget/set" => {
            let p: SessionUsageBudgetSetParams =
                parse_params_required(method, req.params.as_ref())?;
            let event = runtime
                .set_session_usage_budget(&p.thread_id, p.warn_at_usd, p.stop_at_usd)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/config/set" => {
            let p: SessionConfigSetParams = parse_params_required(method, req.params.as_ref())?;
            let event = runtime
                .set_session_config(&p.thread_id, p.config)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/harnessContext/get" => {
            let p: SessionHarnessContextGetParams =
                parse_params_required(method, req.params.as_ref())?;
            let event = runtime
                .get_harness_context(&p.thread_id)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/harnessContext/set" => {
            let p: SessionHarnessContextSetParams =
                parse_params_required(method, req.params.as_ref())?;
            let event = runtime
                .set_harness_context(&p.thread_id, p.context)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/defaults/apply" => {
            let p: SessionDefaultsApplyParams = parse_params_optional(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let event = runtime
                .apply_session_defaults(
                    &cwd,
                    p.thread_id.as_deref(),
                    p.provider.as_deref(),
                    p.model.as_deref(),
                    p.enable_mcp,
                    p.config,
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/file/upload" => {
            let p: SessionFileUploadParams = parse_params_required(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let event = runtime
                .upload_workspace_file(&cwd, &p.filename, &p.content_base64)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "cowork/session/delete" => {
            let p: SessionDeleteParams = parse_params_required(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let event = runtime
                .delete_session(&cwd, &p.target_session_id)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "event": event }))
        }

        "workspace/list" => {
            let _: WorkspaceListParams = parse_params_optional(method, req.params.as_ref())?;
            let (workspaces, active_id) = build_workspace_summaries(
                &runtime.working_directory,
                &runtime.homedir,
                runtime.desktop_service.as_deref(),
            );
            Ok(json!({
                "workspaces": workspaces,
                "activeWorkspaceId": active_id,
            }))
        }

        "workspace/switch" => {
            let p: WorkspaceSwitchParams = parse_params_required(method, req.params.as_ref())?;
            let (workspaces, _) = build_workspace_summaries(
                &runtime.working_directory,
                &runtime.homedir,
                runtime.desktop_service.as_deref(),
            );
            let Some(found) = workspaces.into_iter().find(|w| w.id == p.workspace_id) else {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("Unknown workspace: {}", p.workspace_id),
                ));
            };
            Ok(json!({
                "workspaceId": found.id,
                "name": found.name,
                "path": found.path,
            }))
        }

        "cowork/workspace/bootstrap" => {
            let p: WorkspaceBootstrapParams = parse_params_optional(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let (threads, _) = runtime.list_workspace_threads(&cwd, None, None);
            let state = runtime
                .read_workspace_state(&conn.connection_id, &cwd)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({
                "threads": threads,
                "state": state,
            }))
        }

        "command/list" => {
            let p: CommandListParams = parse_params_required(method, req.params.as_ref())?;
            let Some(live_arc) = runtime.load_thread(&p.thread_id) else {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("Unknown thread: {}", p.thread_id),
                ));
            };
            let cwd = std::path::PathBuf::from(live_arc.lock().cwd.clone());
            let commands = runtime.list_commands(&cwd);
            Ok(json!({ "commands": commands }))
        }

        "command/execute" => {
            let p: CommandExecuteParams = parse_params_required(method, req.params.as_ref())?;
            runtime
                .execute_command_turn(
                    &conn.connection_id,
                    &p.thread_id,
                    &p.name,
                    p.arguments.as_deref(),
                    p.client_message_id.as_deref(),
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))
        }

        "cowork/creation/preflight" => {
            let p: CreationPreflightParams = parse_params_required(method, req.params.as_ref())?;
            let res = runtime
                .run_creation_preflight(&p)
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            serde_json::to_value(res).map_err(|e| {
                JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("Serialize error: {e}"))
            })
        }

        "turn/start" => {
            let p: TurnStartParams = parse_params_required(method, req.params.as_ref())?;
            runtime
                .handle_turn_start(&conn.connection_id, conn.tool_retry_lineage(), &p)
                .await
        }

        "turn/steer" => {
            let p: TurnSteerParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_turn_steer(&p)
        }

        "turn/interrupt" => {
            let p: TurnInterruptParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_turn_interrupt(&p)
        }

        "cowork/provider/catalog/read" => {
            let p: ProviderCatalogReadParams = parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_provider_catalog_read(&p).await
        }

        "cowork/provider/authMethods/read" => {
            let p: ProviderAuthMethodsReadParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_provider_auth_methods_read(p.cwd.as_deref())
        }

        "cowork/provider/status/refresh" => {
            let p: ProviderStatusRefreshParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_provider_status_refresh(&p).await
        }

        "cowork/provider/codexAppServer/status" => {
            let p: ProviderCodexAppServerStatusParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_codex_app_server_status(&p)
        }

        "cowork/provider/codexAppServer/update" => {
            let p: ProviderCodexAppServerUpdateParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_codex_app_server_update(&p).await
        }

        "cowork/provider/lmstudio/local/status" => {
            let p: ProviderLmStudioLocalStatusParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_lmstudio_local_status(&p).await
        }

        "cowork/provider/lmstudio/local/start" => {
            let p: ProviderLmStudioLocalStartParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_lmstudio_local_start(&p).await
        }

        "cowork/provider/auth/authorize" => {
            let p: ProviderAuthAuthorizeParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_auth_authorize(&p).await
        }

        "cowork/provider/auth/callback" => {
            let p: ProviderAuthCallbackParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_auth_callback(&p).await
        }

        "cowork/provider/auth/logout" => {
            let p: ProviderAuthLogoutParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_auth_logout(&p).await
        }

        "cowork/provider/auth/setApiKey" => {
            let p: ProviderAuthSetApiKeyParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_auth_set_api_key(&p).await
        }

        "cowork/provider/auth/setConfig" => {
            let p: ProviderAuthSetConfigParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_auth_set_config(&p).await
        }

        "cowork/provider/auth/copyApiKey" => {
            let p: ProviderAuthCopyApiKeyParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_auth_copy_api_key(&p).await
        }

        "cowork/provider/customModel/add" => {
            let p: ProviderCustomModelAddParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_custom_model_add(&p).await
        }

        "cowork/provider/customModel/delete" => {
            let p: ProviderCustomModelDeleteParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_custom_model_delete(&p).await
        }

        "cowork/provider/model/setEnabled" => {
            let p: ProviderModelSetEnabledParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_model_set_enabled(&p).await
        }

        "cowork/provider/model/resetEnabled" => {
            let p: ProviderModelResetEnabledParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_provider_model_reset_enabled(&p).await
        }

        "cowork/connectors/openai-native/list" => {
            let p: ConnectorsOpenAiNativeListParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime
                .handle_connectors_openai_native_list(p.cwd.as_deref(), false)
                .await
        }

        "cowork/connectors/openai-native/refresh" => {
            let p: ConnectorsOpenAiNativeRefreshParams =
                parse_params_optional(method, req.params.as_ref())?;
            runtime
                .handle_connectors_openai_native_list(p.cwd.as_deref(), true)
                .await
        }

        "cowork/connectors/openai-native/setEnabled" => {
            let p: ConnectorsOpenAiNativeSetEnabledParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime
                .handle_connectors_openai_native_set_enabled(&p)
                .await
        }

        "cowork/skills/list" => {
            let p: SkillsListParams = parse_params_optional(method, req.params.as_ref())?;
            let cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            let skills: Vec<Value> = runtime
                .list_commands(&cwd)
                .into_iter()
                .filter(|c| c.source == "skill")
                .map(|c| {
                    json!({
                        "name": c.name,
                        "description": c.description.unwrap_or_default(),
                        "enabled": true,
                    })
                })
                .collect();
            Ok(json!({ "skills": skills }))
        }

        "cowork/mcp/list" => {
            let p: OptionalCwdParams = parse_params_optional(method, req.params.as_ref())?;
            let _cwd = runtime
                .resolve_workspace_path(p.cwd.as_deref(), method)
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
            Ok(json!({ "servers": [] }))
        }

        "cowork/runtime/libreoffice/check" => {
            let p: RuntimeLibreOfficeCheckParams =
                parse_params_optional(method, req.params.as_ref())?;
            if let Some(cwd) = &p.cwd
                && cwd.trim().is_empty()
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("{method}: cwd must be non-empty when provided"),
                ));
            }
            let res = runtime
                .handle_runtime_libreoffice_check(p.smoke.unwrap_or(false))
                .await;
            serde_json::to_value(res).map_err(|e| {
                JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
            })
        }

        "cowork/memory/list" => {
            let p: MemoryListParams = parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_memory_list(&p)
        }

        "cowork/memory/upsert" => {
            let p: MemoryUpsertParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_upsert(&p)
        }

        "cowork/memory/delete" => {
            let p: MemoryDeleteParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_delete(&p)
        }

        "cowork/memory/advanced/list" => {
            if req
                .params
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|m| m.contains_key("folder"))
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!(
                        "{method}: folder is not accepted; use cowork/memory/advanced/folder/* for explicit folder access"
                    ),
                ));
            }
            let p: MemoryAdvancedListParams = parse_params_optional(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_list(&p)
        }

        "cowork/memory/advanced/upsert" => {
            if req
                .params
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|m| m.contains_key("folder"))
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!(
                        "{method}: folder is not accepted; use cowork/memory/advanced/folder/* for explicit folder access"
                    ),
                ));
            }
            let p: MemoryAdvancedUpsertParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_upsert(&p)
        }

        "cowork/memory/advanced/delete" => {
            if req
                .params
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|m| m.contains_key("folder"))
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!(
                        "{method}: folder is not accepted; use cowork/memory/advanced/folder/* for explicit folder access"
                    ),
                ));
            }
            let p: MemoryAdvancedDeleteParams = parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_delete(&p)
        }

        "cowork/memory/advanced/generate" => {
            if req
                .params
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|m| m.contains_key("folder"))
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!(
                        "{method}: folder is not accepted; use cowork/memory/advanced/folder/* for explicit folder access"
                    ),
                ));
            }
            let p: MemoryAdvancedGenerateParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_generate(&p).await
        }

        "cowork/memory/advanced/folder/list" => {
            let p: MemoryAdvancedFolderListParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_folder_list(&p)
        }

        "cowork/memory/advanced/folder/upsert" => {
            let p: MemoryAdvancedFolderUpsertParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_folder_upsert(&p)
        }

        "cowork/memory/advanced/folder/delete" => {
            let p: MemoryAdvancedFolderDeleteParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_folder_delete(&p)
        }

        "cowork/memory/advanced/folder/generate" => {
            let p: MemoryAdvancedFolderGenerateParams =
                parse_params_required(method, req.params.as_ref())?;
            runtime.handle_memory_advanced_folder_generate(&p).await
        }

        "cowork/runtime/diagnostics/read" => {
            let _p: RuntimeDiagnosticsReadParams =
                parse_params_optional(method, req.params.as_ref())?;
            let res = runtime.handle_runtime_diagnostics_read();
            serde_json::to_value(res).map_err(|e| {
                JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
            })
        }

        _ => Err(JsonRpcLiteError::new(
            error_codes::METHOD_NOT_FOUND,
            format!("Unknown method: {method}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_request_guard_enforces_max_in_flight_and_releases_on_drop() {
        let counter = Arc::new(AtomicUsize::new(0));
        let g1 = PendingRequestGuard::try_acquire(&counter, 2).expect("slot 1");
        let g2 = PendingRequestGuard::try_acquire(&counter, 2).expect("slot 2");
        assert!(PendingRequestGuard::try_acquire(&counter, 2).is_none());
        drop(g1);
        let g3 = PendingRequestGuard::try_acquire(&counter, 2).expect("slot after release");
        drop(g2);
        drop(g3);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }
}
