//! A `codex-cli` session runs Cowork tools through the Codex dynamic-tool bridge, which clones
//! the tool context before the turn installs its live cost-tracker bridge. A `workflow` started
//! that way must still see the session's cost bridge, so its child-agent admission obeys the
//! session's `stopAtUsd` and its spend is charged to the parent session. Driven end to end over
//! the WebSocket server against a mocked stdio Codex app-server.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const STOP_AT_USD: f64 = 5.0;

/// Mock app-server; logs every client message to `logPath`. On `turn/start` it issues the
/// dynamic tool calls from `callsJson` one at a time (each after the previous reply), then
/// completes the turn with a plain text answer.
const CODEX_MOCK: &str = r#"
import readline from "node:readline";
import fs from "node:fs";

const [, , logPath, callsJson] = process.argv;
const calls = JSON.parse(callsJson);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const threadId = "thr-1";
const turnId = "turn-1";
let next = 0;

const callNext = () => {
  if (next < calls.length) {
    const call = calls[next];
    send({ id: `srv-${next}`, method: "item/tool/call", params: { threadId, turnId, callId: `call-${next}`, ...call } });
    next += 1;
    return;
  }
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "f1", delta: "Done." } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(msg) + "\n");
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: turnId } } });
    callNext();
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, result: {} });
  } else if (msg.id !== undefined) {
    // The client's reply to one of our dynamic tool calls.
    callNext();
  }
});
"#;

/// Reports the budget the workflow runtime derived from the session's cost bridge.
const BUDGET_PROBE_WORKFLOW: &str = r#"
export const meta = { name: "budget-probe", description: "Reports the workflow budget", phases: ["probe"] };
export default async function ({ budget, phase }) {
  phase("probe");
  return { total: budget.total, remaining: budget.remaining };
}
"#;

struct Iso {
    _root: TempDir,
    base: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new(calls: &Value) -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-codex-wf-cost-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(base.join("mock_codex.mjs"), CODEX_MOCK).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            base.join("electron").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            base.join("desktop").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("COWORK_ENABLE_WORKFLOWS".into(), "1".into());
        env.insert(
            "PATH".into(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into()),
        );
        env.insert("COWORK_CODEX_APP_SERVER_BIN".into(), "node".into());
        env.insert(
            "COWORK_CODEX_APP_SERVER_ARGS".into(),
            json!([
                base.join("mock_codex.mjs").to_string_lossy(),
                base.join("codex.log").to_string_lossy(),
                calls.to_string(),
            ])
            .to_string(),
        );
        Self {
            _root: root,
            base,
            home,
            workspace,
            env,
        }
    }

    fn options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: true,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }

    fn logged(&self) -> Vec<Value> {
        fs::read_to_string(self.base.join("codex.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect()
    }
}

async fn connect(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    send(
        &mut ws,
        json!({
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "codex-workflow-cost-bridge-tests", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )
    .await;
    let _ = ws.next().await.unwrap().unwrap();
    send(&mut ws, json!({ "method": "initialized", "params": {} })).await;
    ws
}

async fn send(ws: &mut WsStream, msg: Value) {
    ws.send(WsMessage::Text(msg.to_string().into()))
        .await
        .unwrap();
}

/// Sends a request and reads frames until its response; notifications seen on the way are
/// appended to `notifs`.
async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = tokio::time::timeout(rem, ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {method} response"));
        if let WsMessage::Text(txt) = frame.expect("ws open").expect("ws frame") {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            } else if val.get("id") == Some(&json!(id)) {
                return val;
            }
        }
    }
}

async fn wait_for_method(ws: &mut WsStream, notifs: &mut Vec<Value>, method: &str) -> Value {
    if let Some(found) = notifs.iter().find(|n| n["method"] == method) {
        return found.clone();
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        if let Ok(Some(Ok(WsMessage::Text(txt)))) = tokio::time::timeout(rem, ws.next()).await
            && let Ok(val) = serde_json::from_str::<Value>(&txt)
            && val.get("method").is_some()
        {
            notifs.push(val.clone());
            if val["method"] == method {
                return val;
            }
        }
    }
    panic!("timed out waiting for {method}; got {notifs:?}");
}

#[tokio::test]
async fn codex_dynamic_workflow_call_sees_the_session_cost_bridge() {
    let calls = json!([{
        "tool": "workflow",
        "arguments": { "action": "run", "script": BUDGET_PROBE_WORKFLOW }
    }]);
    let iso = Iso::new(&calls);
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let mut notifs = Vec::new();

    let started = call(
        &mut ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "codex-cli", "model": "gpt-5.4" }),
        &mut notifs,
    )
    .await;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned();

    let cap = call(
        &mut ws,
        "cap",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "stopAtUsd": STOP_AT_USD }),
        &mut notifs,
    )
    .await;
    assert!(cap.get("error").is_none(), "{cap}");

    let turn = call(
        &mut ws,
        "turn",
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "run the probe" }] }),
        &mut notifs,
    )
    .await;
    assert!(turn.get("error").is_none(), "turn/start failed: {turn}");
    let completed = wait_for_method(&mut ws, &mut notifs, "turn/completed").await;
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );

    let log = iso.logged();
    let reply = log
        .iter()
        .find(|m| m["id"] == "srv-0" && m.get("method").is_none())
        .unwrap_or_else(|| panic!("no reply to the workflow dynamic tool call: {log:?}"));
    assert_eq!(reply["result"]["success"], true, "{reply}");
    let text = reply["result"]["contentItems"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("workflow reply without text: {reply}"));
    let out: Value = serde_json::from_str(text)
        .unwrap_or_else(|e| panic!("workflow reply is not JSON ({e}): {text}"));
    assert_eq!(out["ok"], true, "{out}");
    // Without the session's cost bridge the workflow runs unbudgeted (`total: null`).
    let total = out["result"]["total"]
        .as_f64()
        .unwrap_or_else(|| panic!("workflow ran without the session budget: {out}"));
    assert!((total - STOP_AT_USD).abs() < 1e-9, "{out}");

    server.shutdown().await;
}
