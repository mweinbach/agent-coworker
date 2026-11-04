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
    BoundedLine, RpcTransport, SseTransport, StdioTransport, StreamableHttpTransport,
    TransportTimeouts, dispatch_jsonrpc_response, extract_matching_rpc_result, read_bounded_line,
};

#[path = "../tests/support/node_bin.rs"]
mod node_bin;

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
        &node_bin::node_bin(),
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
        &node_bin::node_bin(),
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

// ----------------------------------------------------------------------------
// Drop cleanup and dead-connection detection
// ----------------------------------------------------------------------------

/// Whether `pid` is gone (or only a zombie awaiting its reaper).
#[cfg(unix)]
fn process_gone(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .is_some_and(|state| state == "Z" || state == "X"),
        Err(_) => {
            // No procfs (macOS): fall back to `kill(pid, 0)`.
            // SAFETY: signal 0 only checks for existence.
            unsafe { libc::kill(pid, 0) != 0 }
        }
    }
}

#[cfg(unix)]
async fn wait_for_pid_file(path: &std::path::Path) -> i32 {
    tokio::time::timeout(SAFETY_BOUND, async {
        loop {
            if let Ok(raw) = std::fs::read_to_string(path)
                && let Ok(pid) = raw.trim().parse::<i32>()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("stdio child never wrote its grandchild pid")
}

#[cfg(unix)]
async fn assert_process_exits(pid: i32, what: &str) {
    let gone = tokio::time::timeout(SAFETY_BOUND, async {
        while !process_gone(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    if gone.is_err() {
        // SAFETY: cleanup of the leaked test process.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        panic!("{what}: grandchild {pid} in the MCP server's process group was leaked");
    }
}

/// A shell "server" that starts a long-lived grandchild in its process group (like `npx`
/// spawning `node`), records its pid, and never answers.
#[cfg(unix)]
fn grandchild_script(pid_file: &std::path::Path) -> Vec<String> {
    vec![
        "-c".to_owned(),
        format!("sleep 300 & echo $! > '{}'; wait", pid_file.display()),
    ]
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_stdio_transport_kills_its_process_group() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("grandchild.pid");
    let env = std::env::vars().collect();
    let transport = StdioTransport::connect(
        "sh",
        &grandchild_script(&pid_file),
        None,
        &env,
        None,
        SHORT_TIMEOUTS,
    )
    .await
    .unwrap();
    let grandchild = wait_for_pid_file(&pid_file).await;
    assert!(!process_gone(grandchild));

    drop(transport);
    assert_process_exits(grandchild, "dropped stdio transport").await;
}

#[cfg(unix)]
#[tokio::test]
async fn cancelled_handshake_kills_stdio_process_group() {
    use crate::types::{HydratedMcpServer, McpAuthScope, McpConfigSource, McpServerConfig};

    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("grandchild.pid");
    let server = HydratedMcpServer {
        config: McpServerConfig {
            name: "never-initializes".to_owned(),
            transport: crate::types::McpServerTransport::Stdio {
                command: "sh".to_owned(),
                args: Some(grandchild_script(&pid_file)),
                env: None,
                cwd: None,
            },
            enabled: None,
            required: None,
            retries: Some(0),
            auth: None,
            icon: None,
        },
        source: McpConfigSource::User,
        auth_scope: McpAuthScope::User,
        oauth_context: None,
    };
    let env = std::env::vars().collect();
    // `initialize` would wait for the 60s request timeout; the caller gives up first (as
    // `validate_mcp_server_with_env` does after 10s) and drops the connect future.
    let mut connect = Box::pin(super::connect_and_list_once(&server, &env));
    let grandchild = tokio::select! {
        _ = &mut connect => panic!("handshake must not complete"),
        pid = wait_for_pid_file(&pid_file) => pid,
    };
    drop(connect);
    assert_process_exits(grandchild, "cancelled handshake").await;
}

#[cfg(unix)]
#[tokio::test]
async fn stdio_transport_with_closed_stdout_is_unhealthy_and_fails_fast() {
    let env = std::env::vars().collect();
    // Closes stdout but keeps running (and keeps stdin open), so writes still succeed.
    let transport = StdioTransport::connect(
        "sh",
        &["-c".to_owned(), "exec 1>&-; sleep 300".to_owned()],
        None,
        &env,
        None,
        TransportTimeouts::default(),
    )
    .await
    .unwrap();
    tokio::time::timeout(SAFETY_BOUND, async {
        while transport.is_healthy() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("transport must report itself unhealthy once its reader exits");

    let started = Instant::now();
    let err = tokio::time::timeout(SAFETY_BOUND, transport.request("tools/list", None))
        .await
        .expect("request on a dead connection must not wait for the 60s request timeout")
        .unwrap_err();
    assert_eq!(err, "MCP stdio server closed stdout");
    assert!(started.elapsed() < Duration::from_secs(5));
    transport.close().await;
}

/// Legacy SSE server whose `/sse` stream announces `/messages` and then either ends (`/sse-end`)
/// or stays open while recording when the client goes away (`/sse-open`).
fn sse_lifecycle_app(stream_dropped: Arc<std::sync::atomic::AtomicBool>) -> Router {
    struct DropFlag(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let endpoint = || {
        Ok::<_, std::convert::Infallible>(Bytes::from_static(
            b"event: endpoint\ndata: /messages\n\n",
        ))
    };
    Router::new()
        .route(
            "/sse-end",
            get(move || async move {
                let body =
                    futures::stream::iter([endpoint()]).chain(futures::stream::once(async {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        Ok(Bytes::new())
                    }));
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(axum::body::Body::from_stream(body))
                    .unwrap()
            }),
        )
        .route(
            "/sse-open",
            get(move || {
                let flag = DropFlag(Arc::clone(&stream_dropped));
                async move {
                    let body = futures::stream::iter([endpoint()]).chain(futures::stream::unfold(
                        flag,
                        |flag| async move {
                            std::future::pending::<()>().await;
                            Some((Ok(Bytes::new()), flag))
                        },
                    ));
                    Response::builder()
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(axum::body::Body::from_stream(body))
                        .unwrap()
                }
            }),
        )
        .route(
            "/messages",
            post(|| async { StatusCode::ACCEPTED.into_response() }),
        )
}

#[tokio::test]
async fn sse_transport_with_ended_stream_is_unhealthy_and_fails_fast() {
    let (addr, server) = serve(sse_lifecycle_app(Arc::default())).await;
    let transport = SseTransport::connect(
        &format!("http://{addr}/sse-end"),
        None,
        None,
        TransportTimeouts::default(),
    )
    .await
    .unwrap();
    tokio::time::timeout(SAFETY_BOUND, async {
        while transport.is_healthy() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("transport must report itself unhealthy once its event stream ends");
    let err = tokio::time::timeout(
        Duration::from_secs(5),
        transport.request("tools/list", None),
    )
    .await
    .expect("request on a closed stream must not wait for the 60s request timeout")
    .unwrap_err();
    assert_eq!(err, "MCP SSE stream closed");
    server.abort();
}

#[tokio::test]
async fn dropping_sse_transport_closes_its_event_stream() {
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (addr, server) = serve(sse_lifecycle_app(Arc::clone(&dropped))).await;
    let transport = SseTransport::connect(
        &format!("http://{addr}/sse-open"),
        None,
        None,
        TransportTimeouts::default(),
    )
    .await
    .unwrap();
    assert!(transport.is_healthy());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!dropped.load(std::sync::atomic::Ordering::SeqCst));

    drop(transport);
    tokio::time::timeout(SAFETY_BOUND, async {
        while !dropped.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dropping the transport must close the SSE event stream");
    server.abort();
}

// ----------------------------------------------------------------------------
// Bounded stdio frames
// ----------------------------------------------------------------------------

#[tokio::test]
async fn bounded_line_reader_splits_lines_across_chunks_and_keeps_eof_tail() {
    // A 4-byte buffer forces every line to span several `fill_buf` chunks.
    let data: &[u8] = b"alpha\nbe\n\ntail";
    let mut reader = tokio::io::BufReader::with_capacity(4, data);
    let mut buf = Vec::new();
    let mut lines = Vec::new();
    loop {
        buf.clear();
        match read_bounded_line(&mut reader, &mut buf, 5).await.unwrap() {
            BoundedLine::Line => lines.push(String::from_utf8(buf.clone()).unwrap()),
            BoundedLine::Eof => break,
            BoundedLine::Overflow => panic!("no line exceeds the cap: {lines:?}"),
        }
    }
    assert_eq!(lines, ["alpha\n", "be\n", "\n", "tail"]);
}

#[tokio::test]
async fn bounded_line_reader_stops_an_endless_line_at_the_cap() {
    // `read_until` would never return on this stream; the bounded reader must stop at the cap
    // without buffering more than the cap.
    const CAP: usize = 1024 * 1024;
    let mut reader = tokio::io::BufReader::new(tokio::io::repeat(b'x'));
    let mut buf = Vec::new();
    let outcome = tokio::time::timeout(SAFETY_BOUND, read_bounded_line(&mut reader, &mut buf, CAP))
        .await
        .expect("an unterminated stream must hit the cap, not read forever")
        .unwrap();
    assert_eq!(outcome, BoundedLine::Overflow);
    assert!(
        buf.len() <= CAP,
        "buffered {} bytes past the cap",
        buf.len()
    );
}

#[tokio::test]
async fn bounded_line_reader_accepts_a_line_exactly_at_the_cap() {
    let mut reader = tokio::io::BufReader::with_capacity(3, &b"abcd\nabcde\n"[..]);
    let mut buf = Vec::new();
    assert_eq!(
        read_bounded_line(&mut reader, &mut buf, 4).await.unwrap(),
        BoundedLine::Line
    );
    assert_eq!(buf, b"abcd\n");
    buf.clear();
    assert_eq!(
        read_bounded_line(&mut reader, &mut buf, 4).await.unwrap(),
        BoundedLine::Overflow
    );
}

/// A server that answers the first request with an unterminated frame larger than the cap: the
/// pending request fails fast with the overflow error, the connection turns unhealthy, and later
/// requests fail fast too.
#[cfg(unix)]
#[tokio::test]
async fn stdio_oversized_unterminated_frame_fails_pending_requests_and_marks_unhealthy() {
    const CAP: usize = 64 * 1024;
    let env = std::env::vars().collect();
    // Wait for the request line, then stream 4 MiB with no newline and keep running.
    let transport = StdioTransport::connect_with_line_limit(
        "sh",
        &[
            "-c".to_owned(),
            "read _req; head -c 4194304 /dev/zero | tr '\\0' x; sleep 300".to_owned(),
        ],
        None,
        &env,
        None,
        TransportTimeouts::default(),
        CAP,
    )
    .await
    .unwrap();

    let started = Instant::now();
    let err = tokio::time::timeout(SAFETY_BOUND, transport.request("tools/list", None))
        .await
        .expect("oversized frame must fail the request before the 60s request timeout")
        .unwrap_err();
    assert_eq!(
        err,
        "MCP stdio message exceeded 65536 byte limit; connection closed"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!transport.is_healthy());
    assert!(transport.pending.is_empty());

    let err = tokio::time::timeout(SAFETY_BOUND, transport.request("tools/list", None))
        .await
        .expect("requests after the overflow must fail fast")
        .unwrap_err();
    assert_eq!(err, "MCP stdio server closed stdout");
    tokio::time::timeout(SAFETY_BOUND, transport.close())
        .await
        .expect("close completes");
}

#[test]
fn stdio_overflow_error_names_the_default_cap_in_mib() {
    assert_eq!(
        super::describe_byte_limit(super::MAX_STDIO_LINE_BYTES),
        "10 MiB"
    );
}
