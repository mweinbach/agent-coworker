use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::{HeaderValue, Method, Request, Response, StatusCode, header};
use axum::routing::any;
use cowork_config::get_one_off_chats_root;
use cowork_protocol::{
    JsonRpcLiteClientMessage, JsonRpcLiteOutbound, WEBSOCKET_SUBPROTOCOL,
    decode_client_message_bytes, parse_client_message,
};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::http_desktop::{
    handle_desktop_route, handle_http_workspaces, handle_mobile_h3_admin_route,
};
use crate::http_fs::{
    handle_fs_create_directory, handle_fs_list, handle_fs_open, handle_fs_preview, handle_fs_read,
    handle_fs_rename, handle_fs_trash,
};
use crate::jsonrpc::{ConnectionRpcState, dispatch_client_message};
use crate::registry::ServerRuntimeState;
use crate::security::{
    ALLOWED_CORS_HEADERS, ALLOWED_CORS_METHODS, SecurityGateDecision, apply_cors_headers,
    evaluate_security_gate, is_loopback_host,
};

const MAX_HTTP_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_WS_FRAME_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub runtime: Arc<ServerRuntimeState>,
    pub http_clients: Arc<DashMap<String, Arc<ConnectionRpcState>>>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/{*path}", any(handle_any_request))
        .route("/", any(handle_any_request))
        .with_state(state)
}

fn plain_text(status: StatusCode, body: impl Into<String>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body.into()))
        .unwrap()
}

fn json_resp(status: StatusCode, payload: &Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(payload).unwrap_or_default()))
        .unwrap()
}

async fn handle_any_request(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response<Body> {
    let req_headers = req.headers().clone();
    let method = req.method().clone();
    let pathname = req.uri().path().to_owned();
    let query = req.uri().query().map(str::to_owned);

    let gate = evaluate_security_gate(
        &method,
        &pathname,
        query.as_deref(),
        &req_headers,
        state.runtime.network_exposed_listener,
        state.runtime.browser_access_token.as_deref(),
    );

    let mut resp = match gate {
        SecurityGateDecision::Reject { status, body } => plain_text(status, body),
        SecurityGateDecision::OptionsPreflight => Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static(ALLOWED_CORS_METHODS),
            )
            .header(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static(ALLOWED_CORS_HEADERS),
            )
            .header(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static("86400"),
            )
            .body(Body::empty())
            .unwrap(),
        SecurityGateDecision::Allow => {
            dispatch_http_or_ws(
                &state,
                remote_addr,
                &method,
                &pathname,
                query.as_deref(),
                req,
            )
            .await
        }
    };

    apply_cors_headers(resp.headers_mut(), &req_headers);
    resp
}

async fn dispatch_http_or_ws(
    state: &AppState,
    remote_addr: SocketAddr,
    method: &Method,
    pathname: &str,
    query: Option<&str>,
    req: Request<Body>,
) -> Response<Body> {
    if method == Method::GET && pathname == "/cowork/health" {
        return handle_health(state);
    }

    if pathname == "/ws" {
        return handle_ws_upgrade(state.clone(), query, req).await;
    }

    if pathname == "/rpc" {
        return handle_loopback_rpc(state, remote_addr, method, req).await;
    }

    if method == Method::GET && pathname == "/cowork/workspaces" {
        return handle_http_workspaces(
            &state.runtime.working_directory,
            &state.runtime.homedir,
            state.runtime.desktop_service.as_deref(),
        );
    }

    if pathname.starts_with("/mobile-h3/trusted") {
        let headers = req.headers().clone();
        let Ok(body) = to_bytes(req.into_body(), MAX_HTTP_BODY_BYTES).await else {
            return plain_text(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
        };
        return handle_mobile_h3_admin_route(
            method,
            pathname,
            &headers,
            &body,
            state.runtime.mobile_h3(),
        )
        .await;
    }

    if pathname.starts_with("/cowork/desktop/") {
        let headers = req.headers().clone();
        let Ok(body) = to_bytes(req.into_body(), MAX_HTTP_BODY_BYTES).await else {
            return plain_text(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
        };
        return handle_desktop_route(
            method,
            pathname,
            query,
            &headers,
            &body,
            &state.runtime.working_directory,
            state.runtime.desktop_service.as_deref(),
        );
    }

    if pathname.starts_with("/cowork/fs/") {
        let allowed_roots = match &state.runtime.desktop_service {
            Some(svc) => svc.allowed_fs_roots(&state.runtime.working_directory),
            None => vec![
                state.runtime.working_directory.clone(),
                get_one_off_chats_root(&state.runtime.homedir),
            ],
        };
        let cwd = &state.runtime.working_directory;
        let res = match (method.as_str(), pathname) {
            ("GET", "/cowork/fs/list") => handle_fs_list(&allowed_roots, cwd, query),
            ("GET", "/cowork/fs/read") => handle_fs_read(&allowed_roots, cwd, query),
            ("GET", "/cowork/fs/preview") => handle_fs_preview(&allowed_roots, cwd, query),
            ("GET", "/cowork/fs/open") => handle_fs_open(&allowed_roots, cwd, query, false),
            ("GET", "/cowork/fs/reveal") => handle_fs_open(&allowed_roots, cwd, query, true),
            ("POST", "/cowork/fs/create-directory") => {
                let Ok(body) = to_bytes(req.into_body(), MAX_HTTP_BODY_BYTES).await else {
                    return plain_text(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
                };
                handle_fs_create_directory(&allowed_roots, cwd, &body)
            }
            ("POST", "/cowork/fs/rename") => {
                let Ok(body) = to_bytes(req.into_body(), MAX_HTTP_BODY_BYTES).await else {
                    return plain_text(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
                };
                handle_fs_rename(&allowed_roots, cwd, &body)
            }
            ("POST", "/cowork/fs/trash") => {
                let Ok(body) = to_bytes(req.into_body(), MAX_HTTP_BODY_BYTES).await else {
                    return plain_text(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
                };
                handle_fs_trash(&allowed_roots, cwd, &body)
            }
            _ => return plain_text(StatusCode::NOT_FOUND, "Not found"),
        };
        return match res {
            Ok(resp) => resp,
            Err(err) => err.into_response(),
        };
    }

    if pathname.starts_with("/cowork") {
        return plain_text(StatusCode::NOT_FOUND, "Not found");
    }

    plain_text(StatusCode::OK, "OK")
}

fn handle_health(state: &AppState) -> Response<Body> {
    let runtime = &state.runtime;
    let lock_diag = runtime.session_db.write_lock_diagnostics();
    let journal_health = runtime.journal.get_aggregate_health();
    let q_stats = runtime.send_queue.stats();
    let version = runtime
        .env
        .get("COWORK_VERSION")
        .cloned()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());

    let mut db_obj = json!({
        "ok": runtime.session_db.journal_mode().is_ok(),
    });
    if lock_diag.max_wait_ms > 0 {
        db_obj["lockWaitMs"] = json!(lock_diag.max_wait_ms);
    }

    let body = json!({
        "ok": true,
        "version": version,
        "uptimeMs": runtime.started_at.elapsed().as_millis() as u64,
        "cwd": runtime.working_directory.to_string_lossy(),
        "activeSessions": runtime.active_session_count(),
        "db": db_obj,
        "journal": {
            "healthy": journal_health.healthy,
            "backlog": journal_health.backlog,
        },
        "sendQueue": {
            "dropped": q_stats.dropped_deltas + q_stats.dropped_important,
            "queued": q_stats.queued_sends,
        },
        "startup": runtime.startup_snapshot(),
    });
    json_resp(StatusCode::OK, &body)
}

async fn handle_ws_upgrade(
    state: AppState,
    query: Option<&str>,
    req: Request<Body>,
) -> Response<Body> {
    if let Some(q) = query {
        for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
            if k == "protocol" && !v.trim().is_empty() {
                return plain_text(
                    StatusCode::BAD_REQUEST,
                    "The ?protocol= WebSocket query parameter is no longer supported. Use the cowork.jsonrpc.v1 subprotocol or omit protocol negotiation.",
                );
            }
        }
    }

    let offered: Vec<String> = req
        .headers()
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|hv| hv.to_str().ok())
        .flat_map(|s| s.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();

    let selected_subprotocol = if offered.iter().any(|p| p == WEBSOCKET_SUBPROTOCOL) {
        Some(WEBSOCKET_SUBPROTOCOL.to_owned())
    } else if let Some(first_unknown) = offered.first() {
        return plain_text(
            StatusCode::BAD_REQUEST,
            format!(
                "Unsupported WebSocket subprotocol: {first_unknown}. Only {WEBSOCKET_SUBPROTOCOL} is supported."
            ),
        );
    } else {
        None
    };

    let (mut parts, _body) = req.into_parts();
    let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &state).await else {
        return plain_text(StatusCode::BAD_REQUEST, "WebSocket upgrade failed");
    };

    let ws = ws
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .max_message_size(MAX_WS_FRAME_BYTES);
    let ws = if selected_subprotocol.is_some() {
        ws.protocols([WEBSOCKET_SUBPROTOCOL])
    } else {
        ws
    };

    let runtime = state.runtime.clone();
    ws.on_upgrade(move |socket| run_websocket_session(runtime, socket, selected_subprotocol))
}

async fn run_websocket_session(
    runtime: Arc<ServerRuntimeState>,
    socket: WebSocket,
    selected_subprotocol: Option<String>,
) {
    let connection_id = Uuid::new_v4().to_string();
    let conn_state = Arc::new(ConnectionRpcState::new(
        connection_id.clone(),
        "websocket",
        selected_subprotocol,
    ));

    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(64);
    runtime.register_ws_sink(&connection_id, tx);

    let writer_runtime = runtime.clone();
    let writer_conn_id = connection_id.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if ws_sink
                .send(AxumWsMessage::Text(frame.into()))
                .await
                .is_err()
            {
                break;
            }
            writer_runtime.flush_connection_queue(&writer_conn_id);
        }
    });

    while let Some(Ok(msg)) = ws_stream.next().await {
        let decoded = match msg {
            AxumWsMessage::Text(txt) => parse_client_message(txt.as_str()),
            AxumWsMessage::Binary(bin) => decode_client_message_bytes(&bin),
            AxumWsMessage::Ping(_) | AxumWsMessage::Pong(_) => continue,
            AxumWsMessage::Close(_) => break,
        };

        let client_msg = match decoded {
            Ok(m) => m,
            Err(err) => {
                runtime.send_to_connection(
                    &connection_id,
                    &JsonRpcLiteOutbound::Response(err.into_response()),
                );
                continue;
            }
        };

        // Run handshake & notifications inline so `initialize` -> `initialized` is strictly ordered;
        // spawn post-handshake requests so concurrent in-flight requests & overload (-32001) work accurately.
        let is_handshake_or_non_req = match &client_msg {
            JsonRpcLiteClientMessage::Request(r) => {
                r.method == "initialize" || r.method == "initialized" || !conn_state.is_ready()
            }
            _ => true,
        };

        if is_handshake_or_non_req {
            if let Some(resp) = dispatch_client_message(&runtime, &conn_state, client_msg).await {
                runtime.send_to_connection(&connection_id, &JsonRpcLiteOutbound::Response(resp));
            }
            for notif in conn_state.drain_deferred_broadcasts() {
                runtime.broadcast_to_all(&JsonRpcLiteOutbound::Notification(notif));
            }
        } else {
            let rt = runtime.clone();
            let cs = conn_state.clone();
            let cid = connection_id.clone();
            tokio::spawn(async move {
                if let Some(resp) = dispatch_client_message(&rt, &cs, client_msg).await {
                    rt.send_to_connection(&cid, &JsonRpcLiteOutbound::Response(resp));
                }
                for notif in cs.drain_deferred_broadcasts() {
                    rt.broadcast_to_all(&JsonRpcLiteOutbound::Notification(notif));
                }
            });
        }
    }

    runtime.remove_connection(&connection_id);
    writer_task.abort();
}

async fn handle_loopback_rpc(
    state: &AppState,
    remote_addr: SocketAddr,
    method: &Method,
    req: Request<Body>,
) -> Response<Body> {
    if !is_loopback_host(&remote_addr.ip().to_string()) {
        return json_resp(
            StatusCode::FORBIDDEN,
            &json!({ "error": "Loopback HTTP RPC is restricted to local clients." }),
        );
    }

    if method != Method::POST {
        return json_resp(
            StatusCode::METHOD_NOT_ALLOWED,
            &json!({ "error": "Method not allowed." }),
        );
    }

    let Some(client_id) = req
        .headers()
        .get("x-cowork-client-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        return json_resp(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "Missing x-cowork-client-id header." }),
        );
    };

    let Ok(body_bytes) = to_bytes(req.into_body(), MAX_HTTP_BODY_BYTES).await else {
        return json_resp(
            StatusCode::PAYLOAD_TOO_LARGE,
            &json!({ "error": "Payload too large." }),
        );
    };

    let Ok(raw_json) = serde_json::from_slice::<Value>(&body_bytes) else {
        return json_resp(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "Invalid JSON body." }),
        );
    };

    if !raw_json.is_object() {
        return json_resp(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "JSON-RPC payload must be an object." }),
        );
    }

    let client_msg = match decode_client_message_bytes(&body_bytes) {
        Ok(m) => m,
        Err(err) => {
            let val = serde_json::to_value(err.into_response()).unwrap_or_else(|_| json!({}));
            return json_resp(StatusCode::OK, &val);
        }
    };

    let conn_state = state
        .http_clients
        .entry(client_id.clone())
        .or_insert_with(|| {
            Arc::new(ConnectionRpcState::new(
                format!("http:{client_id}"),
                "http",
                Some(WEBSOCKET_SUBPROTOCOL.to_owned()),
            ))
        })
        .value()
        .clone();

    let is_request = matches!(client_msg, JsonRpcLiteClientMessage::Request(_));
    let maybe_resp = dispatch_client_message(&state.runtime, &conn_state, client_msg).await;
    for notif in conn_state.drain_deferred_broadcasts() {
        state
            .runtime
            .broadcast_to_all(&JsonRpcLiteOutbound::Notification(notif));
    }

    match (is_request, maybe_resp) {
        (_, Some(resp)) => {
            let val = serde_json::to_value(resp).unwrap_or_else(|_| json!({}));
            json_resp(StatusCode::OK, &val)
        }
        (false, None) => Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Body::empty())
            .unwrap(),
        (true, None) => json_resp(StatusCode::OK, &json!({})),
    }
}
