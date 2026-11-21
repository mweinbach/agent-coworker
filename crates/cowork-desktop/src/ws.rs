//! Reconnecting JSON-RPC 2.0-lite WebSocket client manager per workspace.
//!
//! Ported from `src/client/jsonRpcSocket.ts` and
//! `apps/desktop/src/app/store.helpers/jsonRpcSocket.ts`, reusing `cowork-protocol`.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use cowork_protocol::{
    ClientCapabilities, ClientInfo, InitializeParams, InitializeResult, JsonRpcLiteClientResponse,
    JsonRpcLiteId, JsonRpcLiteNotification, JsonRpcLiteOutbound, JsonRpcLiteRequest,
    JsonRpcLiteResponse, WEBSOCKET_SUBPROTOCOL, error_codes,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep, sleep_until, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::actions::StoreEvent;

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_RECONNECT_ATTEMPTS: u32 = 10;
pub const BASE_RECONNECT_DELAY_MS: u64 = 500;
pub const MAX_RECONNECT_DELAY_MS: u64 = 30_000;
pub const MAX_QUEUED_REQUESTS: usize = 128;

/// Required WebSocket subprotocol string for `cowork-server`.
pub const SUBPROTOCOL: &str = WEBSOCKET_SUBPROTOCOL;

/// Connection lifecycle state for a workspace's JSON-RPC WebSocket.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum WsConnectionState {
    #[default]
    Disconnected,
    Connecting,
    Handshaking,
    Connected,
    Reconnecting {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        reason: String,
    },
    Exhausted {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

impl WsConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, WsConnectionState::Connected)
    }

    pub fn is_connecting_or_reconnecting(&self) -> bool {
        matches!(
            self,
            WsConnectionState::Connecting
                | WsConnectionState::Handshaking
                | WsConnectionState::Reconnecting { .. }
        )
    }
}

/// JSON-RPC error returned by a workspace server or transport failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WsRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for WsRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON-RPC error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for WsRpcError {}

/// Commands sent from the store/UI thread to the background WebSocket manager.
#[derive(Clone, Debug, PartialEq)]
pub enum WsCommand {
    ConnectWorkspace {
        workspace_id: String,
        ws_url: String,
        browser_access_token: Option<String>,
    },
    DisconnectWorkspace {
        workspace_id: String,
    },
    SendRequest {
        workspace_id: String,
        request_id: u64,
        method: String,
        params: Value,
        timeout_ms: Option<u64>,
        retry_on_disconnect: bool,
    },
    SendNotification {
        workspace_id: String,
        method: String,
        params: Value,
    },
    SendServerResponse {
        workspace_id: String,
        id: JsonRpcLiteId,
        result: Value,
    },
    Shutdown,
}

/// Metadata kept by `AppState` for correlating in-flight JSON-RPC responses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRpcMeta {
    pub workspace_id: String,
    pub method: String,
}

/// Builds the standard `initialize` payload for a Cowork desktop client.
pub fn desktop_initialize_params(opt_out_notification_methods: Vec<String>) -> InitializeParams {
    build_initialize_params(opt_out_notification_methods, true)
}

fn build_initialize_params(
    opt_out_notification_methods: Vec<String>,
    include_tool_retry_lineage: bool,
) -> InitializeParams {
    InitializeParams {
        client_info: ClientInfo {
            name: "cowork-desktop".to_string(),
            title: Some("Cowork Desktop".to_string()),
            version: Some(crate::native::resolve_desktop_app_version().to_string()),
        },
        capabilities: Some(ClientCapabilities {
            experimental_api: Some(true),
            tool_retry_lineage: include_tool_retry_lineage.then_some(true),
            opt_out_notification_methods: Some(opt_out_notification_methods),
        }),
    }
}

/// Computes bounded exponential backoff with deterministic per-attempt jitter.
pub fn reconnect_delay_ms(attempt: u32) -> u64 {
    let shift = attempt.saturating_sub(1).min(16);
    let base = BASE_RECONNECT_DELAY_MS
        .saturating_mul(1u64 << shift)
        .min(MAX_RECONNECT_DELAY_MS);
    let jitter = u64::from((attempt.saturating_mul(73)) % 150);
    base.saturating_add(jitter).min(MAX_RECONNECT_DELAY_MS)
}

/// Spawns the background Tokio WebSocket manager thread and returns its command sender.
pub fn spawn_ws_manager(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> mpsc::UnboundedSender<WsCommand> {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    std::thread::Builder::new()
        .name("cowork-ws-manager".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            rt.block_on(ws_manager_loop(cmd_rx, event_tx, waker));
        })
        .ok();
    cmd_tx
}

#[derive(Clone, Debug)]
struct QueuedRequest {
    request_id: u64,
    method: String,
    params: Value,
    timeout_ms: Option<u64>,
    retry_on_disconnect: bool,
}

#[derive(Clone, Debug)]
struct InFlightRequest {
    request_id: u64,
    method: String,
    params: Value,
    timeout_ms: Option<u64>,
    retry_on_disconnect: bool,
    deadline: Instant,
}

enum WorkspaceActorMsg {
    SendRequest(QueuedRequest),
    SendNotification { method: String, params: Value },
    SendServerResponse { id: JsonRpcLiteId, result: Value },
    Disconnect,
}

fn emit_event(
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    event: StoreEvent,
) {
    let _ = event_tx.send(event);
    if let Some(w) = waker {
        w();
    }
}

async fn ws_manager_loop(
    mut cmd_rx: mpsc::UnboundedReceiver<WsCommand>,
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) {
    let mut actors: HashMap<String, mpsc::UnboundedSender<WorkspaceActorMsg>> = HashMap::new();

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            WsCommand::ConnectWorkspace {
                workspace_id,
                ws_url,
                browser_access_token,
            } => {
                if let Some(prev) = actors.remove(&workspace_id) {
                    let _ = prev.send(WorkspaceActorMsg::Disconnect);
                }
                let (actor_tx, actor_rx) = mpsc::unbounded_channel();
                actors.insert(workspace_id.clone(), actor_tx);
                let tx = event_tx.clone();
                let wk = waker.clone();
                tokio::spawn(workspace_connection_actor(
                    workspace_id,
                    ws_url,
                    browser_access_token,
                    actor_rx,
                    tx,
                    wk,
                ));
            }
            WsCommand::DisconnectWorkspace { workspace_id } => {
                if let Some(prev) = actors.remove(&workspace_id) {
                    let _ = prev.send(WorkspaceActorMsg::Disconnect);
                } else {
                    emit_event(
                        &event_tx,
                        &waker,
                        StoreEvent::WsStateChanged {
                            workspace_id,
                            state: WsConnectionState::Disconnected,
                        },
                    );
                }
            }
            WsCommand::SendRequest {
                workspace_id,
                request_id,
                method,
                params,
                timeout_ms,
                retry_on_disconnect,
            } => {
                let req = QueuedRequest {
                    request_id,
                    method: method.clone(),
                    params,
                    timeout_ms,
                    retry_on_disconnect,
                };
                if let Some(tx) = actors.get(&workspace_id) {
                    if tx.send(WorkspaceActorMsg::SendRequest(req)).is_err() {
                        fail_disconnected_request(
                            &event_tx,
                            &waker,
                            &workspace_id,
                            request_id,
                            method,
                        );
                    }
                } else {
                    fail_disconnected_request(&event_tx, &waker, &workspace_id, request_id, method);
                }
            }
            WsCommand::SendNotification {
                workspace_id,
                method,
                params,
            } => {
                if let Some(tx) = actors.get(&workspace_id) {
                    let _ = tx.send(WorkspaceActorMsg::SendNotification { method, params });
                }
            }
            WsCommand::SendServerResponse {
                workspace_id,
                id,
                result,
            } => {
                let send_err = match actors.get(&workspace_id) {
                    Some(tx) => tx
                        .send(WorkspaceActorMsg::SendServerResponse {
                            id: id.clone(),
                            result,
                        })
                        .is_err(),
                    None => true,
                };
                if send_err {
                    emit_event(
                        &event_tx,
                        &waker,
                        StoreEvent::WsServerResponseResult {
                            workspace_id,
                            request_id: id,
                            ok: false,
                            error: Some(
                                "The response could not be sent. Reconnect and retry.".to_string(),
                            ),
                        },
                    );
                }
            }
            WsCommand::Shutdown => {
                for (_, tx) in actors.drain() {
                    let _ = tx.send(WorkspaceActorMsg::Disconnect);
                }
                break;
            }
        }
    }
}

fn fail_disconnected_request(
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
    request_id: u64,
    method: String,
) {
    emit_event(
        event_tx,
        waker,
        StoreEvent::WsResponse {
            workspace_id: workspace_id.to_string(),
            request_id,
            method,
            result: Err(WsRpcError {
                code: -32001,
                message: "WebSocket not connected".to_string(),
                data: None,
            }),
        },
    );
}

fn build_ws_request(
    ws_url: &str,
    browser_access_token: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let trimmed = ws_url.trim();
    let mut req = trimmed
        .into_client_request()
        .map_err(|err| format!("Invalid WebSocket URL: {err}"))?;
    let proto_hdr = HeaderValue::from_static(SUBPROTOCOL);
    req.headers_mut()
        .insert("Sec-WebSocket-Protocol", proto_hdr);
    if let Some(token) = browser_access_token
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        if let Ok(hdr) = HeaderValue::from_str(token) {
            req.headers_mut().insert("X-Cowork-Browser-Token", hdr);
        }
        if let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {token}")) {
            req.headers_mut().insert("Authorization", bearer);
        }
    }
    Ok(req)
}

fn id_key(id: &JsonRpcLiteId) -> String {
    match id {
        JsonRpcLiteId::Number(n) => format!("n:{n}"),
        JsonRpcLiteId::String(s) => format!("s:{s}"),
    }
}

async fn workspace_connection_actor(
    workspace_id: String,
    ws_url: String,
    browser_access_token: Option<String>,
    mut msg_rx: mpsc::UnboundedReceiver<WorkspaceActorMsg>,
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) {
    let mut reconnect_attempt: u32 = 0;
    let mut queued: VecDeque<QueuedRequest> = VecDeque::new();
    let mut stopped_intentionally = false;

    loop {
        if stopped_intentionally {
            break;
        }

        let request = match build_ws_request(&ws_url, browser_access_token.as_deref()) {
            Ok(req) => req,
            Err(reason) => {
                emit_event(
                    &event_tx,
                    &waker,
                    StoreEvent::WsStateChanged {
                        workspace_id: workspace_id.clone(),
                        state: WsConnectionState::Failed { reason },
                    },
                );
                drain_queued_errors(&mut queued, &event_tx, &waker, &workspace_id, "Invalid URL");
                break;
            }
        };

        emit_event(
            &event_tx,
            &waker,
            StoreEvent::WsStateChanged {
                workspace_id: workspace_id.clone(),
                state: WsConnectionState::Connecting,
            },
        );

        let connect_res = tokio::select! {
            biased;
            msg = msg_rx.recv() => {
                match msg {
                    Some(WorkspaceActorMsg::Disconnect) | None => {
                        stopped_intentionally = true;
                        break;
                    }
                    Some(other) => {
                        handle_offline_msg(other, &mut queued, &event_tx, &waker, &workspace_id);
                        continue;
                    }
                }
            }
            res = timeout(OPEN_TIMEOUT, connect_async(request)) => res,
        };

        let mut ws_stream = match connect_res {
            Ok(Ok((stream, _resp))) => stream,
            Ok(Err(err)) => {
                let reason = format!("WebSocket connection failed: {err}");
                if should_stop_on_reconnect(
                    &mut reconnect_attempt,
                    reason,
                    &mut queued,
                    &mut msg_rx,
                    &event_tx,
                    &waker,
                    &workspace_id,
                )
                .await
                {
                    break;
                }
                continue;
            }
            Err(_) => {
                let reason = "WebSocket open timed out".to_string();
                if should_stop_on_reconnect(
                    &mut reconnect_attempt,
                    reason,
                    &mut queued,
                    &mut msg_rx,
                    &event_tx,
                    &waker,
                    &workspace_id,
                )
                .await
                {
                    break;
                }
                continue;
            }
        };

        emit_event(
            &event_tx,
            &waker,
            StoreEvent::WsStateChanged {
                workspace_id: workspace_id.clone(),
                state: WsConnectionState::Handshaking,
            },
        );

        let init_outcome = perform_handshake(
            &mut ws_stream,
            &mut msg_rx,
            &mut queued,
            &event_tx,
            &waker,
            &workspace_id,
        )
        .await;

        let init_result = match init_outcome {
            HandshakeOutcome::Ready(res) => res,
            HandshakeOutcome::DisconnectedByClient => {
                let _ = ws_stream.close(None).await;
                stopped_intentionally = true;
                break;
            }
            HandshakeOutcome::Failed(reason) => {
                let _ = ws_stream.close(None).await;
                if should_stop_on_reconnect(
                    &mut reconnect_attempt,
                    reason,
                    &mut queued,
                    &mut msg_rx,
                    &event_tx,
                    &waker,
                    &workspace_id,
                )
                .await
                {
                    break;
                }
                continue;
            }
        };

        reconnect_attempt = 0;
        emit_event(
            &event_tx,
            &waker,
            StoreEvent::WsStateChanged {
                workspace_id: workspace_id.clone(),
                state: WsConnectionState::Connected,
            },
        );
        emit_event(
            &event_tx,
            &waker,
            StoreEvent::WsInitialized {
                workspace_id: workspace_id.clone(),
                result: Box::new(init_result),
            },
        );

        let disconnect_reason = run_connected_session(
            ws_stream,
            &mut msg_rx,
            &mut queued,
            &event_tx,
            &waker,
            &workspace_id,
        )
        .await;

        match disconnect_reason {
            SessionEnd::DisconnectedByClient => {
                stopped_intentionally = true;
                break;
            }
            SessionEnd::TransportLost(reason) => {
                if should_stop_on_reconnect(
                    &mut reconnect_attempt,
                    reason,
                    &mut queued,
                    &mut msg_rx,
                    &event_tx,
                    &waker,
                    &workspace_id,
                )
                .await
                {
                    break;
                }
            }
        }
    }

    drain_queued_errors(
        &mut queued,
        &event_tx,
        &waker,
        &workspace_id,
        "WebSocket disconnected",
    );
    if stopped_intentionally {
        emit_event(
            &event_tx,
            &waker,
            StoreEvent::WsStateChanged {
                workspace_id,
                state: WsConnectionState::Disconnected,
            },
        );
    }
}

enum HandshakeOutcome {
    Ready(InitializeResult),
    DisconnectedByClient,
    Failed(String),
}

async fn perform_handshake<S>(
    ws_stream: &mut S,
    msg_rx: &mut mpsc::UnboundedReceiver<WorkspaceActorMsg>,
    queued: &mut VecDeque<QueuedRequest>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
) -> HandshakeOutcome
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    for (attempt_idx, include_lineage) in [true, false].into_iter().enumerate() {
        let init_id = JsonRpcLiteId::String(format!("__init_{}", attempt_idx + 1));
        let params = build_initialize_params(Vec::new(), include_lineage);
        let req = JsonRpcLiteRequest {
            id: init_id.clone(),
            method: "initialize".to_string(),
            params: serde_json::to_value(params).ok(),
        };
        let payload = match serde_json::to_string(&req) {
            Ok(s) => s,
            Err(err) => {
                return HandshakeOutcome::Failed(format!("Serialize initialize error: {err}"));
            }
        };
        if let Err(err) = ws_stream.send(Message::text(payload)).await {
            return HandshakeOutcome::Failed(format!("Send initialize failed: {err}"));
        }

        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        let retry_without_lineage = loop {
            tokio::select! {
                biased;
                msg = msg_rx.recv() => {
                    match msg {
                        Some(WorkspaceActorMsg::Disconnect) | None => {
                            return HandshakeOutcome::DisconnectedByClient;
                        }
                        Some(other) => {
                            handle_offline_msg(other, queued, event_tx, waker, workspace_id);
                        }
                    }
                }
                _ = sleep_until(deadline) => {
                    return HandshakeOutcome::Failed("WebSocket handshake timed out".to_string());
                }
                frame = ws_stream.next() => {
                    match frame {
                        Some(Ok(Message::Text(text))) => {
                            match serde_json::from_str::<JsonRpcLiteOutbound>(&text) {
                                Ok(JsonRpcLiteOutbound::Response(JsonRpcLiteResponse::Success { id, result }))
                                    if id == init_id =>
                                {
                                    let parsed: InitializeResult = match serde_json::from_value(result) {
                                        Ok(v) => v,
                                        Err(err) => {
                                            return HandshakeOutcome::Failed(format!(
                                                "Invalid initialize result: {err}"
                                            ));
                                        }
                                    };
                                    let initialized = JsonRpcLiteNotification {
                                        method: "initialized".to_string(),
                                        params: Some(json!({})),
                                    };
                                    if let Ok(txt) = serde_json::to_string(&initialized) {
                                        let _ = ws_stream.send(Message::text(txt)).await;
                                    }
                                    return HandshakeOutcome::Ready(parsed);
                                }
                                Ok(JsonRpcLiteOutbound::Response(JsonRpcLiteResponse::Error { id, error }))
                                    if id.as_ref() == Some(&init_id) =>
                                {
                                    if include_lineage && error.code == error_codes::INVALID_PARAMS {
                                        break true;
                                    }
                                    return HandshakeOutcome::Failed(format!(
                                        "Handshake rejected ({}): {}",
                                        error.code, error.message
                                    ));
                                }
                                Ok(JsonRpcLiteOutbound::Notification(notif)) => {
                                    emit_event(
                                        event_tx,
                                        waker,
                                        StoreEvent::WsNotification {
                                            workspace_id: workspace_id.to_string(),
                                            method: notif.method,
                                            params: notif.params.unwrap_or(Value::Null),
                                        },
                                    );
                                }
                                Ok(JsonRpcLiteOutbound::ServerRequest(srv_req)) => {
                                    emit_event(
                                        event_tx,
                                        waker,
                                        StoreEvent::WsServerRequest {
                                            workspace_id: workspace_id.to_string(),
                                            id: srv_req.id,
                                            method: srv_req.method,
                                            params: srv_req.params.unwrap_or(Value::Null),
                                        },
                                    );
                                }
                                Ok(JsonRpcLiteOutbound::Response(_)) => {}
                                Err(err) => {
                                    emit_event(
                                        event_tx,
                                        waker,
                                        StoreEvent::WsInvalidMessage {
                                            workspace_id: workspace_id.to_string(),
                                            message: format!("Invalid handshake JSON-RPC frame: {err}"),
                                        },
                                    );
                                }
                            }
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                        Some(Ok(Message::Close(_))) | None => {
                            return HandshakeOutcome::Failed("WebSocket closed during handshake".to_string());
                        }
                        Some(Err(err)) => {
                            return HandshakeOutcome::Failed(format!("WebSocket error during handshake: {err}"));
                        }
                        Some(Ok(_)) => {}
                    }
                }
            }
        };

        if !retry_without_lineage {
            break;
        }
    }

    HandshakeOutcome::Failed("WebSocket handshake failed".to_string())
}

enum SessionEnd {
    DisconnectedByClient,
    TransportLost(String),
}

async fn run_connected_session<S>(
    mut ws_stream: S,
    msg_rx: &mut mpsc::UnboundedReceiver<WorkspaceActorMsg>,
    queued: &mut VecDeque<QueuedRequest>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
) -> SessionEnd
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let mut pending: HashMap<String, InFlightRequest> = HashMap::new();

    while let Some(req) = queued.pop_front() {
        if let Err(err) = send_request_wire(&mut ws_stream, &mut pending, req.clone()).await {
            if req.retry_on_disconnect && queued.len() < MAX_QUEUED_REQUESTS {
                queued.push_front(req);
            } else {
                fail_disconnected_request(
                    event_tx,
                    waker,
                    workspace_id,
                    req.request_id,
                    req.method,
                );
            }
            requeue_or_fail_pending(
                &mut pending,
                queued,
                event_tx,
                waker,
                workspace_id,
                "WebSocket write failed",
            );
            return SessionEnd::TransportLost(err);
        }
    }

    let reason = loop {
        let next_deadline = pending.values().map(|r| r.deadline).min();

        tokio::select! {
            biased;
            msg = msg_rx.recv() => {
                match msg {
                    Some(WorkspaceActorMsg::Disconnect) | None => {
                        let _ = ws_stream.close().await;
                        requeue_or_fail_pending(
                            &mut pending,
                            queued,
                            event_tx,
                            waker,
                            workspace_id,
                            "WebSocket disconnected",
                        );
                        return SessionEnd::DisconnectedByClient;
                    }
                    Some(WorkspaceActorMsg::SendRequest(req)) => {
                        if let Err(err) = send_request_wire(&mut ws_stream, &mut pending, req.clone()).await {
                            if req.retry_on_disconnect && queued.len() < MAX_QUEUED_REQUESTS {
                                queued.push_back(req);
                            } else {
                                fail_disconnected_request(event_tx, waker, workspace_id, req.request_id, req.method);
                            }
                            break err;
                        }
                    }
                    Some(WorkspaceActorMsg::SendNotification { method, params }) => {
                        let notif = JsonRpcLiteNotification {
                            method,
                            params: Some(params),
                        };
                        if let Ok(txt) = serde_json::to_string(&notif)
                            && let Err(err) = ws_stream.send(Message::text(txt)).await
                        {
                            break format!("WebSocket write failed: {err}");
                        }
                    }
                    Some(WorkspaceActorMsg::SendServerResponse { id, result }) => {
                        let resp = JsonRpcLiteClientResponse {
                            id: id.clone(),
                            result: Some(result),
                            error: None,
                        };
                        match serde_json::to_string(&resp) {
                            Ok(txt) => {
                                if let Err(err) = ws_stream.send(Message::text(txt)).await {
                                    emit_event(
                                        event_tx,
                                        waker,
                                        StoreEvent::WsServerResponseResult {
                                            workspace_id: workspace_id.to_string(),
                                            request_id: id,
                                            ok: false,
                                            error: Some(format!(
                                                "The response could not be sent: {err}"
                                            )),
                                        },
                                    );
                                    break format!("WebSocket write failed: {err}");
                                }
                                emit_event(
                                    event_tx,
                                    waker,
                                    StoreEvent::WsServerResponseResult {
                                        workspace_id: workspace_id.to_string(),
                                        request_id: id,
                                        ok: true,
                                        error: None,
                                    },
                                );
                            }
                            Err(err) => {
                                emit_event(
                                    event_tx,
                                    waker,
                                    StoreEvent::WsServerResponseResult {
                                        workspace_id: workspace_id.to_string(),
                                        request_id: id,
                                        ok: false,
                                        error: Some(format!(
                                            "Failed to serialize response: {err}"
                                        )),
                                    },
                                );
                            }
                        }
                    }
                }
            }
            _ = async {
                match next_deadline {
                    Some(d) => sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                let now = Instant::now();
                let expired: Vec<String> = pending
                    .iter()
                    .filter(|(_, req)| req.deadline <= now)
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in expired {
                    if let Some(req) = pending.remove(&k) {
                        emit_event(
                            event_tx,
                            waker,
                            StoreEvent::WsResponse {
                                workspace_id: workspace_id.to_string(),
                                request_id: req.request_id,
                                method: req.method,
                                result: Err(WsRpcError {
                                    code: -32000,
                                    message: "Request timed out".to_string(),
                                    data: None,
                                }),
                            },
                        );
                    }
                }
            }
            frame = ws_stream.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        dispatch_inbound_frame(&text, &mut pending, event_tx, waker, workspace_id);
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => {
                        break "WebSocket connection closed".to_string();
                    }
                    Some(Err(err)) => {
                        break format!("WebSocket read error: {err}");
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    };

    requeue_or_fail_pending(&mut pending, queued, event_tx, waker, workspace_id, &reason);
    SessionEnd::TransportLost(reason)
}

async fn send_request_wire<S>(
    ws_stream: &mut S,
    pending: &mut HashMap<String, InFlightRequest>,
    req: QueuedRequest,
) -> Result<(), String>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let rpc_id = JsonRpcLiteId::Number(req.request_id as i64);
    let key = id_key(&rpc_id);
    let wire = JsonRpcLiteRequest {
        id: rpc_id,
        method: req.method.clone(),
        params: Some(req.params.clone()),
    };
    let txt = serde_json::to_string(&wire).map_err(|e| format!("Serialize error: {e}"))?;
    let timeout_dur = req
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_REQUEST_TIMEOUT);
    pending.insert(
        key.clone(),
        InFlightRequest {
            request_id: req.request_id,
            method: req.method,
            params: req.params,
            timeout_ms: req.timeout_ms,
            retry_on_disconnect: req.retry_on_disconnect,
            deadline: Instant::now() + timeout_dur,
        },
    );
    if let Err(err) = ws_stream.send(Message::text(txt)).await {
        pending.remove(&key);
        return Err(format!("WebSocket send error: {err}"));
    }
    Ok(())
}

fn dispatch_inbound_frame(
    text: &str,
    pending: &mut HashMap<String, InFlightRequest>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
) {
    match serde_json::from_str::<JsonRpcLiteOutbound>(text) {
        Ok(JsonRpcLiteOutbound::Response(JsonRpcLiteResponse::Success { id, result })) => {
            if let Some(in_flight) = pending.remove(&id_key(&id)) {
                emit_event(
                    event_tx,
                    waker,
                    StoreEvent::WsResponse {
                        workspace_id: workspace_id.to_string(),
                        request_id: in_flight.request_id,
                        method: in_flight.method,
                        result: Ok(result),
                    },
                );
            }
        }
        Ok(JsonRpcLiteOutbound::Response(JsonRpcLiteResponse::Error { id, error })) => {
            if let Some(rpc_id) = id
                && let Some(in_flight) = pending.remove(&id_key(&rpc_id))
            {
                emit_event(
                    event_tx,
                    waker,
                    StoreEvent::WsResponse {
                        workspace_id: workspace_id.to_string(),
                        request_id: in_flight.request_id,
                        method: in_flight.method,
                        result: Err(WsRpcError {
                            code: i64::from(error.code),
                            message: error.message,
                            data: error.data,
                        }),
                    },
                );
            }
        }
        Ok(JsonRpcLiteOutbound::Notification(notif)) => {
            emit_event(
                event_tx,
                waker,
                StoreEvent::WsNotification {
                    workspace_id: workspace_id.to_string(),
                    method: notif.method,
                    params: notif.params.unwrap_or(Value::Null),
                },
            );
        }
        Ok(JsonRpcLiteOutbound::ServerRequest(srv_req)) => {
            emit_event(
                event_tx,
                waker,
                StoreEvent::WsServerRequest {
                    workspace_id: workspace_id.to_string(),
                    id: srv_req.id,
                    method: srv_req.method,
                    params: srv_req.params.unwrap_or(Value::Null),
                },
            );
        }
        Err(err) => {
            emit_event(
                event_tx,
                waker,
                StoreEvent::WsInvalidMessage {
                    workspace_id: workspace_id.to_string(),
                    message: format!("Invalid JSON-RPC frame: {err}"),
                },
            );
        }
    }
}

fn requeue_or_fail_pending(
    pending: &mut HashMap<String, InFlightRequest>,
    queued: &mut VecDeque<QueuedRequest>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
    reason: &str,
) {
    let mut items: Vec<InFlightRequest> = pending.drain().map(|(_, v)| v).collect();
    items.sort_by_key(|r| r.request_id);
    for item in items {
        if item.retry_on_disconnect && queued.len() < MAX_QUEUED_REQUESTS {
            queued.push_back(QueuedRequest {
                request_id: item.request_id,
                method: item.method,
                params: item.params,
                timeout_ms: item.timeout_ms,
                retry_on_disconnect: true,
            });
        } else {
            emit_event(
                event_tx,
                waker,
                StoreEvent::WsResponse {
                    workspace_id: workspace_id.to_string(),
                    request_id: item.request_id,
                    method: item.method,
                    result: Err(WsRpcError {
                        code: -32001,
                        message: reason.to_string(),
                        data: None,
                    }),
                },
            );
        }
    }
}

fn handle_offline_msg(
    msg: WorkspaceActorMsg,
    queued: &mut VecDeque<QueuedRequest>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
) {
    match msg {
        WorkspaceActorMsg::SendRequest(req) => {
            if req.retry_on_disconnect && queued.len() < MAX_QUEUED_REQUESTS {
                queued.push_back(req);
            } else {
                fail_disconnected_request(
                    event_tx,
                    waker,
                    workspace_id,
                    req.request_id,
                    req.method,
                );
            }
        }
        WorkspaceActorMsg::SendServerResponse { id, .. } => {
            emit_event(
                event_tx,
                waker,
                StoreEvent::WsServerResponseResult {
                    workspace_id: workspace_id.to_string(),
                    request_id: id,
                    ok: false,
                    error: Some("The response could not be sent. Reconnect and retry.".to_string()),
                },
            );
        }
        WorkspaceActorMsg::SendNotification { .. } | WorkspaceActorMsg::Disconnect => {}
    }
}

fn drain_queued_errors(
    queued: &mut VecDeque<QueuedRequest>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
    reason: &str,
) {
    while let Some(req) = queued.pop_front() {
        emit_event(
            event_tx,
            waker,
            StoreEvent::WsResponse {
                workspace_id: workspace_id.to_string(),
                request_id: req.request_id,
                method: req.method,
                result: Err(WsRpcError {
                    code: -32001,
                    message: reason.to_string(),
                    data: None,
                }),
            },
        );
    }
}

async fn should_stop_on_reconnect(
    reconnect_attempt: &mut u32,
    reason: String,
    queued: &mut VecDeque<QueuedRequest>,
    msg_rx: &mut mpsc::UnboundedReceiver<WorkspaceActorMsg>,
    event_tx: &mpsc::UnboundedSender<StoreEvent>,
    waker: &Option<rune::Waker>,
    workspace_id: &str,
) -> bool {
    *reconnect_attempt = reconnect_attempt.saturating_add(1);
    if *reconnect_attempt > MAX_RECONNECT_ATTEMPTS {
        emit_event(
            event_tx,
            waker,
            StoreEvent::WsStateChanged {
                workspace_id: workspace_id.to_string(),
                state: WsConnectionState::Exhausted { reason },
            },
        );
        drain_queued_errors(
            queued,
            event_tx,
            waker,
            workspace_id,
            "WebSocket reconnect limit reached",
        );
        return true;
    }

    let delay_ms = reconnect_delay_ms(*reconnect_attempt);
    emit_event(
        event_tx,
        waker,
        StoreEvent::WsStateChanged {
            workspace_id: workspace_id.to_string(),
            state: WsConnectionState::Reconnecting {
                attempt: *reconnect_attempt,
                max_attempts: MAX_RECONNECT_ATTEMPTS,
                delay_ms,
                reason,
            },
        },
    );

    let sleep_fut = sleep(Duration::from_millis(delay_ms));
    tokio::pin!(sleep_fut);
    loop {
        tokio::select! {
            biased;
            msg = msg_rx.recv() => {
                match msg {
                    Some(WorkspaceActorMsg::Disconnect) | None => return true,
                    Some(other) => handle_offline_msg(other, queued, event_tx, waker, workspace_id),
                }
            }
            _ = &mut sleep_fut => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cowork_protocol::{NegotiatedServerCapabilities, ServerInfo, TransportDescriptor};
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    #[allow(clippy::result_large_err)]
    async fn spawn_mock_ws_server(
        require_lineage_fallback: bool,
    ) -> (
        String,
        tokio::task::JoinHandle<(Option<String>, Vec<String>)>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ws_url = format!("ws://{addr}/ws");

        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut captured_token: Option<String> = None;
            let mut seen_methods: Vec<String> = Vec::new();
            let ws = accept_hdr_async(stream, |req: &Request, mut resp: Response| {
                if let Some(proto) = req.headers().get("sec-websocket-protocol")
                    && proto == SUBPROTOCOL
                {
                    resp.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        HeaderValue::from_static(SUBPROTOCOL),
                    );
                }
                captured_token = req
                    .headers()
                    .get("x-cowork-browser-token")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                Ok(resp)
            })
            .await
            .unwrap();

            let (mut sink, mut stream) = ws.split();
            while let Some(Ok(Message::Text(txt))) = stream.next().await {
                let Ok(val) = serde_json::from_str::<Value>(&txt) else {
                    continue;
                };
                let method = val
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let id = val.get("id").cloned();
                seen_methods.push(method.clone());

                match method.as_str() {
                    "initialize" => {
                        let has_lineage = val
                            .get("params")
                            .and_then(|p| p.get("capabilities"))
                            .and_then(|c| c.get("toolRetryLineage"))
                            .is_some();
                        if require_lineage_fallback && has_lineage {
                            let err = serde_json::json!({
                                "id": id,
                                "error": {
                                    "code": error_codes::INVALID_PARAMS,
                                    "message": "toolRetryLineage unsupported"
                                }
                            });
                            sink.send(Message::text(err.to_string())).await.unwrap();
                        } else {
                            let res = InitializeResult {
                                server_info: ServerInfo {
                                    name: "cowork-server-mock".to_string(),
                                    subprotocol: Some(SUBPROTOCOL.to_string()),
                                },
                                protocol_version: "1.0".to_string(),
                                transport: TransportDescriptor {
                                    transport_type: "websocket".to_string(),
                                    protocol_mode: "jsonrpc".to_string(),
                                },
                                capabilities: NegotiatedServerCapabilities {
                                    experimental_api: true,
                                    tool_retry_lineage: Some(!require_lineage_fallback),
                                },
                            };
                            let ok = serde_json::json!({
                                "id": id,
                                "result": res,
                            });
                            sink.send(Message::text(ok.to_string())).await.unwrap();
                        }
                    }
                    "initialized" => {
                        let notif = serde_json::json!({
                            "method": "turn/started",
                            "params": { "threadId": "th-1", "turnId": "turn-1" }
                        });
                        sink.send(Message::text(notif.to_string())).await.unwrap();
                    }
                    "thread/list" => {
                        let ok = serde_json::json!({
                            "id": id,
                            "result": { "threads": [] }
                        });
                        sink.send(Message::text(ok.to_string())).await.unwrap();
                    }
                    _ => {}
                }
            }
            (captured_token, seen_methods)
        });

        (ws_url, handle)
    }

    #[test]
    fn handshake_with_lineage_fallback_token_and_request_roundtrip() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .unwrap();
        rt.block_on(async {
            let (ws_url, server_handle) = spawn_mock_ws_server(true).await;
            let (event_tx, mut event_rx) = mpsc::unbounded_channel();
            let cmd_tx = spawn_ws_manager(event_tx, None);

            cmd_tx
                .send(WsCommand::ConnectWorkspace {
                    workspace_id: "ws-1".to_string(),
                    ws_url,
                    browser_access_token: Some("secret-browser-token".to_string()),
                })
                .unwrap();

            // Queue a retryable request immediately while Connecting; it must flush post-handshake.
            cmd_tx
                .send(WsCommand::SendRequest {
                    workspace_id: "ws-1".to_string(),
                    request_id: 42,
                    method: "thread/list".to_string(),
                    params: json!({}),
                    timeout_ms: Some(5000),
                    retry_on_disconnect: true,
                })
                .unwrap();

            let mut saw_connected = false;
            let mut saw_notif = false;
            let mut saw_response = false;
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && !(saw_connected && saw_notif && saw_response) {
                if let Ok(Some(ev)) = timeout(Duration::from_secs(2), event_rx.recv()).await {
                    match ev {
                        StoreEvent::WsInitialized { result, .. } => {
                            assert_ne!(result.capabilities.tool_retry_lineage, Some(true));
                            saw_connected = true;
                        }
                        StoreEvent::WsNotification { method, .. } if method == "turn/started" => {
                            saw_notif = true;
                        }
                        StoreEvent::WsResponse {
                            request_id: 42,
                            method,
                            result: Ok(_),
                            ..
                        } if method == "thread/list" => {
                            saw_response = true;
                        }
                        _ => {}
                    }
                }
            }
            assert!(saw_connected && saw_notif && saw_response);

            cmd_tx.send(WsCommand::Shutdown).unwrap();
            let (captured_token, seen_methods) = server_handle.await.unwrap();
            assert_eq!(captured_token.as_deref(), Some("secret-browser-token"));
            assert!(
                seen_methods
                    .iter()
                    .filter(|m| m.as_str() == "initialize")
                    .count()
                    == 2
            );
            assert!(seen_methods.contains(&"initialized".to_string()));
            assert!(seen_methods.contains(&"thread/list".to_string()));
        });
    }

    #[test]
    fn backoff_is_bounded_at_30s() {
        assert!(reconnect_delay_ms(1) >= 500 && reconnect_delay_ms(1) < 700);
        assert!(reconnect_delay_ms(20) <= MAX_RECONNECT_DELAY_MS);
    }
}
