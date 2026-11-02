//! Regression: server-to-client JSON-RPC requests (e.g. `ping`) may reuse the id of a
//! pending client request. They must be answered, never treated as that request's response.
//!
//! Regression: request deadlines bound the whole exchange (write/POST, response headers and
//! body, and the matching response), so a stalled server cannot hang a transport forever.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

use super::{
    RpcTransport, SseTransport, StdioTransport, StreamableHttpTransport, TransportTimeouts,
    dispatch_jsonrpc_response, extract_matching_rpc_result,
};

#[test]
fn server_request_with_pending_id_is_answered_not_dispatched() {
    let pending: DashMap<u64, oneshot::Sender<Result<Value, String>>> = DashMap::new();
    let (tx, mut rx) = oneshot::channel();
    pending.insert(3, tx);

    let replies = dispatch_jsonrpc_response(
        &pending,
        json!([
            { "jsonrpc": "2.0", "id": 3, "method": "ping" },
            { "jsonrpc": "2.0", "id": 3, "method": "sampling/createMessage", "params": {} },
            { "jsonrpc": "2.0", "method": "notifications/progress", "params": {} },
        ]),
    );
    assert_eq!(
        replies,
        vec![
            json!({ "jsonrpc": "2.0", "id": 3, "result": {} }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "error": { "code": -32601, "message": "Method not found: sampling/createMessage" },
            }),
        ]
    );
    assert!(
        pending.contains_key(&3),
        "client request 3 must stay pending"
    );
    assert!(rx.try_recv().is_err());

    let replies = dispatch_jsonrpc_response(
        &pending,
        json!({ "jsonrpc": "2.0", "id": 3, "result": { "ok": true } }),
    );
    assert!(replies.is_empty());
    assert_eq!(rx.try_recv().unwrap().unwrap(), json!({ "ok": true }));
}

#[test]
fn streamable_http_result_extraction_skips_server_requests() {
    let ping = json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" });
    assert!(extract_matching_rpc_result(&ping, 7).is_none());
    let batch = json!([ping, { "jsonrpc": "2.0", "id": 7, "result": { "v": 1 } }]);
    assert_eq!(
        extract_matching_rpc_result(&batch, 7).unwrap().unwrap(),
        json!({ "v": 1 })
    );
}

#[tokio::test]
async fn stdio_answers_ping_that_reuses_pending_id() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("ping_reuse_server.js");
    // On `tools/call` id N: send `ping` and `roots/list` with id N, wait for both replies,
    // then return them inside the real result.
    std::fs::write(
        &script,
        r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let call = null;
const replies = [];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "tools/call") {
    call = msg;
    send({ jsonrpc: "2.0", id: msg.id, method: "ping" });
    send({ jsonrpc: "2.0", id: msg.id, method: "roots/list" });
  } else if (!msg.method && call) {
    replies.push(msg);
    if (replies.length === 2) {
      send({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "real" }], replies } });
    }
  }
});
"#,
    )
    .unwrap();

    let env = std::env::vars().collect();
    let transport = StdioTransport::connect(
        "node",
        &[script.to_string_lossy().into_owned()],
        None,
        &env,
        None,
        TransportTimeouts::default(),
    )
    .await
    .unwrap();
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        transport.request("tools/call", Some(json!({ "name": "x", "arguments": {} }))),
    )
    .await
    .expect("request completes")
    .expect("request succeeds");
    transport.close().await;

    assert_eq!(res["content"][0]["text"], "real", "{res}");
    let replies = res["replies"].as_array().unwrap();
    assert!(
        replies.contains(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} })),
        "{res}"
    );
    assert!(
        replies
            .iter()
            .any(|r| r["id"] == 1 && r["error"]["code"] == -32601),
        "{res}"
    );
}

#[tokio::test]
async fn streamable_http_answers_ping_that_reuses_pending_id() {
    let replies: Arc<parking_lot::Mutex<Vec<Value>>> = Arc::default();
    let recorded = Arc::clone(&replies);
    let app = Router::new().route(
        "/mcp",
        post(move |_headers: HeaderMap, body: String| {
            let recorded = Arc::clone(&recorded);
            async move {
                let msg: Value = serde_json::from_str(&body).unwrap();
                if msg.get("method").is_none() {
                    recorded.lock().push(msg);
                    return StatusCode::ACCEPTED.into_response();
                }
                let id = msg["id"].clone();
                let ping = json!({ "jsonrpc": "2.0", "id": id, "method": "ping" });
                let result = json!({ "jsonrpc": "2.0", "id": id, "result": { "real": true } });
                let sse = format!("data: {ping}\n\ndata: {result}\n\n");
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(axum::body::Body::from(sse))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let transport = StreamableHttpTransport::new(
        &format!("http://{addr}/mcp"),
        None,
        None,
        TransportTimeouts::default(),
    )
    .unwrap();
    let res = transport
        .request("tools/call", Some(json!({})))
        .await
        .unwrap();
    server.abort();

    assert_eq!(res, json!({ "real": true }));
    assert_eq!(
        *replies.lock(),
        vec![json!({ "jsonrpc": "2.0", "id": 1, "result": {} })]
    );
}

// ----------------------------------------------------------------------------
// Request deadlines: a server that accepts a message but never answers it must fail the
// request within the deadline without wedging the transport for later requests.
// ----------------------------------------------------------------------------

const SHORT_TIMEOUTS: TransportTimeouts = TransportTimeouts {
    connect: Duration::from_secs(5),
    request: Duration::from_millis(300),
};

/// Upper bound for an operation that should end at `SHORT_TIMEOUTS.request`; generous for
/// loaded CI hosts while far below the 60s production default.
const SAFETY_BOUND: Duration = Duration::from_secs(10);

/// Response behavior keyed on the JSON-RPC `method`: `hang` never sends response headers,
/// `hang_body` sends headers and a partial JSON body but never finishes it.
enum Stall {
    Headers,
    Body,
}

fn stall_for(msg: &Value) -> Option<Stall> {
    match msg.get("method").and_then(Value::as_str) {
        Some("hang") => Some(Stall::Headers),
        Some("hang_body") => Some(Stall::Body),
        _ => None,
    }
}

async fn stalled_response(stall: Stall) -> Response {
    match stall {
        Stall::Headers => std::future::pending().await,
        Stall::Body => {
            let body = futures::stream::once(async {
                Ok::<_, std::convert::Infallible>(Bytes::from_static(b"{\"jsonrpc\":\"2.0\","))
            })
            .chain(futures::stream::pending());
            Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from_stream(body))
                .unwrap()
        }
    }
}

async fn serve(app: Router) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, server)
}

async fn assert_times_out<T: std::fmt::Debug>(
    fut: impl std::future::Future<Output = Result<T, String>>,
    expected: &str,
) {
    let started = Instant::now();
    let err = tokio::time::timeout(SAFETY_BOUND, fut)
        .await
        .expect("operation must end at the request deadline, not hang")
        .expect_err("stalled operation must fail");
    assert_eq!(err, expected);
    assert!(
        started.elapsed() >= SHORT_TIMEOUTS.request,
        "failed before the deadline: {err}"
    );
}

/// Legacy SSE server: GET `/sse` announces `/messages` and then delivers responses for
/// POSTs on the long-lived event stream; GET `/sse-hang` never sends response headers.
fn legacy_sse_app() -> Router {
    type EventTx = Arc<parking_lot::Mutex<Option<mpsc::UnboundedSender<String>>>>;
    let events: EventTx = Arc::default();
    let get_events = Arc::clone(&events);
    Router::new()
        .route(
            "/sse",
            get(move || {
                let events = Arc::clone(&get_events);
                async move {
                    let (tx, rx) = mpsc::unbounded_channel::<String>();
                    tx.send("event: endpoint\ndata: /messages\n\n".to_owned())
                        .unwrap();
                    *events.lock() = Some(tx);
                    let body = futures::stream::unfold(rx, |mut rx| async move {
                        let chunk = rx.recv().await?;
                        Some((Ok::<_, std::convert::Infallible>(Bytes::from(chunk)), rx))
                    });
                    Response::builder()
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(axum::body::Body::from_stream(body))
                        .unwrap()
                }
            }),
        )
        .route("/sse-hang", get(std::future::pending::<Response>))
        .route(
            "/messages",
            post(move |body: String| {
                let events = Arc::clone(&events);
                async move {
                    let msg: Value = serde_json::from_str(&body).unwrap();
                    if let Some(stall) = stall_for(&msg) {
                        return stalled_response(stall).await;
                    }
                    if let Some(id) = msg.get("id") {
                        let result =
                            json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } });
                        let tx = events.lock().clone().expect("event stream is open");
                        tx.send(format!("event: message\ndata: {result}\n\n"))
                            .unwrap();
                    }
                    StatusCode::ACCEPTED.into_response()
                }
            }),
        )
}

#[tokio::test]
async fn sse_request_times_out_when_post_never_responds() {
    let (addr, server) = serve(legacy_sse_app()).await;
    let transport =
        SseTransport::connect(&format!("http://{addr}/sse"), None, None, SHORT_TIMEOUTS)
            .await
            .unwrap();

    assert_times_out(
        transport.request("hang", None),
        "MCP SSE request \"hang\" timed out",
    )
    .await;
    assert_times_out(
        transport.request("hang_body", None),
        "MCP SSE request \"hang_body\" timed out",
    )
    .await;
    assert_times_out(
        transport.notify("hang", None),
        "MCP SSE notification \"hang\" timed out",
    )
    .await;
    assert!(
        transport.pending.is_empty(),
        "timed-out requests must not leak pending entries"
    );

    // The event stream and transport stay usable after the stalled exchanges.
    let res = tokio::time::timeout(SAFETY_BOUND, transport.request("tools/list", None))
        .await
        .expect("follow-up request is not blocked")
        .expect("follow-up request succeeds");
    assert_eq!(res, json!({ "ok": true }));

    transport.close().await;
    server.abort();
}

#[tokio::test]
async fn sse_connect_times_out_when_get_never_responds() {
    let (addr, server) = serve(legacy_sse_app()).await;
    let started = Instant::now();
    let err = tokio::time::timeout(
        SAFETY_BOUND,
        SseTransport::connect(
            &format!("http://{addr}/sse-hang"),
            None,
            None,
            TransportTimeouts {
                connect: Duration::from_millis(300),
                ..SHORT_TIMEOUTS
            },
        ),
    )
    .await
    .expect("connect must end at the connect deadline, not hang")
    .err()
    .expect("connect to a stalled SSE GET must fail");
    assert_eq!(err, "Timed out waiting for MCP SSE stream response");
    assert!(started.elapsed() >= Duration::from_millis(300));
    server.abort();
}

#[tokio::test]
async fn streamable_http_request_times_out_when_post_never_responds() {
    let app = Router::new().route(
        "/mcp",
        post(|body: String| async move {
            let msg: Value = serde_json::from_str(&body).unwrap();
            if let Some(stall) = stall_for(&msg) {
                return stalled_response(stall).await;
            }
            match msg.get("id") {
                Some(id) => {
                    axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }))
                        .into_response()
                }
                None => StatusCode::ACCEPTED.into_response(),
            }
        }),
    );
    let (addr, server) = serve(app).await;
    let transport =
        StreamableHttpTransport::new(&format!("http://{addr}/mcp"), None, None, SHORT_TIMEOUTS)
            .unwrap();

    assert_times_out(
        transport.request("hang", None),
        "MCP HTTP request \"hang\" timed out",
    )
    .await;
    assert_times_out(
        transport.request("hang_body", None),
        "MCP HTTP request \"hang_body\" timed out",
    )
    .await;
    assert_times_out(
        transport.notify("hang", None),
        "MCP HTTP notification \"hang\" timed out",
    )
    .await;

    let res = tokio::time::timeout(SAFETY_BOUND, transport.request("tools/list", None))
        .await
        .expect("follow-up request is not blocked")
        .expect("follow-up request succeeds");
    assert_eq!(res, json!({ "ok": true }));
    server.abort();
}

#[tokio::test]
async fn stdio_request_times_out_when_server_stops_reading_stdin() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("never_reads_stdin.js");
    // Never reads stdin, so a frame larger than the pipe buffer blocks the write.
    std::fs::write(&script, "setInterval(() => {}, 1000);\n").unwrap();

    let env = std::env::vars().collect();
    let transport = StdioTransport::connect(
        "node",
        &[script.to_string_lossy().into_owned()],
        None,
        &env,
        None,
        SHORT_TIMEOUTS,
    )
    .await
    .unwrap();

    let big = "x".repeat(4 * 1024 * 1024);
    assert_times_out(
        transport.request("tools/call", Some(json!({ "blob": big }))),
        "MCP stdio request \"tools/call\" timed out",
    )
    .await;
    // The first frame's write is still parked on the full pipe; later writes queue behind it
    // and must also respect their own deadline.
    assert_times_out(
        transport.notify("notifications/initialized", None),
        "MCP stdio notification \"notifications/initialized\" timed out",
    )
    .await;
    assert!(transport.pending.is_empty());

    // Closing must not wait on the stdin lock held by the stalled write.
    tokio::time::timeout(SAFETY_BOUND, transport.close())
        .await
        .expect("close is not blocked by a stalled stdin write");
}
