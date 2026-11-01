//! Regression: server-to-client JSON-RPC requests (e.g. `ping`) may reuse the id of a
//! pending client request. They must be answered, never treated as that request's response.

use std::sync::Arc;

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use dashmap::DashMap;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::{
    RpcTransport, StdioTransport, StreamableHttpTransport, dispatch_jsonrpc_response,
    extract_matching_rpc_result,
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

    let transport =
        StreamableHttpTransport::new(&format!("http://{addr}/mcp"), None, None).unwrap();
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
