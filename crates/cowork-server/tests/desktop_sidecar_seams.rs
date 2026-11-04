use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedSidecarEnv {
    _root: TempDir,
    base: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedSidecarEnv {
    fn new(prefix: &str, tasks_enabled: bool) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("temporary sidecar directory");
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

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
        if tasks_enabled {
            env.insert("COWORK_ENABLE_TASKS".into(), "1".into());
        }
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        Self {
            _root: root,
            base,
            home,
            workspace,
            env,
        }
    }

    fn server_options(&self, yolo: bool) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

async fn connect_ready_ws(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

    ws.send(WsMessage::Text(
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "desktop-sidecar-seams-test", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();

    ws.send(WsMessage::Text(
        json!({
            "method": "initialized",
            "params": {}
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    ws
}

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": method,
            "params": params
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws stream open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = msg {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) {
                return val;
            }
        }
    }
}

fn chat_sse_tool_call(call_id: &str, tool_name: &str, args: &Value) -> String {
    let args_str = serde_json::to_string(args).unwrap();
    format!(
        concat!(
            "data: {{\"id\":\"cmpl-tc\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"tool_calls\":[{{\"index\":0,\"id\":{call_id:?},\"type\":\"function\",\"function\":{{\"name\":{tool_name:?},\"arguments\":{args_str:?}}}}}]}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-tc\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        call_id = call_id,
        tool_name = tool_name,
        args_str = args_str,
    )
}

fn chat_sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":25,\"completion_tokens\":8,\"total_tokens\":33}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

#[tokio::test]
async fn locate_builtin_dir_honors_cowork_builtin_dir_in_packaged_sidecar_mode() {
    let mut iso = IsolatedSidecarEnv::new("cowork-builtin-dir-", false);
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let staged_dist = iso.base.join("Resources/dist");
    fs::create_dir_all(staged_dist.join("config")).unwrap();
    fs::create_dir_all(staged_dist.join("prompts")).unwrap();
    fs::create_dir_all(staged_dist.join("skills")).unwrap();
    fs::copy(
        repo_root.join("config/defaults.json"),
        staged_dist.join("config/defaults.json"),
    )
    .unwrap();
    let model_dir = staged_dist.join("config/models/openai");
    fs::create_dir_all(&model_dir).unwrap();
    let model = json!({
        "id": "staged-model", "provider": "openai", "displayName": "Staged model",
        "knowledgeCutoff": "unknown", "supportsImageInput": false,
        "promptTemplate": "default", "isDefault": true
    });
    fs::write(model_dir.join("staged-model.json"), model.to_string()).unwrap();
    iso.env
        .insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
    let canonical_staged = fs::canonicalize(&staged_dist).unwrap();

    iso.env.insert(
        "COWORK_BUILTIN_DIR".into(),
        canonical_staged.to_string_lossy().into_owned(),
    );
    iso.env.insert("COWORK_DESKTOP_BUNDLE".into(), "1".into());

    let mut opts = iso.server_options(false);
    opts.built_in_dir = None;

    let server = start_server(opts).await.unwrap();
    assert_eq!(
        fs::canonicalize(&server.runtime().built_in_dir).unwrap(),
        canonical_staged,
        "packaged sidecar must resolve built_in_dir from COWORK_BUILTIN_DIR"
    );
    let catalog = server
        .runtime()
        .read_provider_catalog(&iso.workspace, false)
        .await;
    assert_eq!(catalog["default"]["openai"], "staged-model");
    server.shutdown().await;
}

#[tokio::test]
async fn codex_cli_oauth_callback_opens_browser_url_and_evicts_pooled_client() {
    let mut iso = IsolatedSidecarEnv::new("cowork-codex-seam-", false);
    let bin_dir = iso.base.join("mock-bin");
    fs::create_dir_all(&bin_dir).unwrap();

    let state_file = iso.base.join("codex_state.json");
    let opened_file = iso.base.join("opened_urls.txt");
    let fail_opener_flag = iso.base.join("fail_opener");
    fs::write(
        &state_file,
        json!({ "spawns": 0, "authenticated": false }).to_string(),
    )
    .unwrap();

    let opener_script = bin_dir.join("mock-browser-opener");
    fs::write(
        &opener_script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$1\" >> {opened:?}\nif [ -f {fail:?} ]; then\n  exit 1\nfi\nexit 0\n",
            opened = opened_file,
            fail = fail_opener_flag,
        ),
    )
    .unwrap();
    fs::set_permissions(&opener_script, fs::Permissions::from_mode(0o755)).unwrap();

    let node_bin = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).exists())
    .expect("node executable required for mock codex-app-server");

    let codex_script = iso.base.join("mock_codex.mjs");
    fs::write(
        &codex_script,
        format!(
            r#"import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const stateFile = {state_file:?};
const failFlag = {fail_opener_flag:?};
function readState() {{ return JSON.parse(fs.readFileSync(stateFile, "utf8")); }}
function writeState(st) {{ fs.writeFileSync(stateFile, JSON.stringify(st), "utf8"); }}

const st0 = readState();
st0.spawns = (st0.spawns || 0) + 1;
writeState(st0);

const rl = readline.createInterface({{ input: process.stdin, crlfDelay: Infinity }});
function send(obj) {{ process.stdout.write(JSON.stringify(obj) + "\n"); }}

rl.on("line", (line) => {{
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {{
    send({{ id: msg.id, result: {{ serverInfo: {{ name: "mock-codex", version: "0.160.0" }} }} }});
  }} else if (msg.method === "account/read") {{
    const st = readState();
    send({{
      id: msg.id,
      result: st.authenticated
        ? {{ account: {{ email: "seam@example.com", planType: "pro" }}, requiresOpenaiAuth: false }}
        : {{ account: null, requiresOpenaiAuth: true }},
    }});
  }} else if (msg.method === "account/login/start") {{
    const loginId = "codex-login-seam";
    send({{
      id: msg.id,
      result: {{
        type: "chatgpt",
        loginId,
        authUrl: "http://127.0.0.1:9/codex-chatgpt-login?state=seam",
      }},
    }});
    if (!fs.existsSync(failFlag)) {{
      setTimeout(() => {{
        const st = readState();
        st.authenticated = true;
        writeState(st);
        if (process.env.CODEX_HOME) {{
          fs.mkdirSync(process.env.CODEX_HOME, {{ recursive: true }});
          fs.writeFileSync(
            path.join(process.env.CODEX_HOME, "auth.json"),
            JSON.stringify({{ access_token: "seam-tok", email: "seam@example.com", plan_type: "pro" }}),
            {{ mode: 0o600 }},
          );
        }}
        send({{ method: "account/login/completed", params: {{ loginId, success: true, error: null }} }});
      }}, 80);
    }}
  }} else if (msg.method === "config/read") {{
    send({{ id: msg.id, result: {{ config: {{ apps: {{}} }} }} }});
  }} else if (msg.id !== undefined && msg.id !== null) {{
    send({{ id: msg.id, result: {{ data: [], nextCursor: null }} }});
  }}
}});
"#
        ),
    )
    .unwrap();

    let codex_wrapper = bin_dir.join("codex");
    fs::write(
        &codex_wrapper,
        format!("#!/bin/sh\nexec {node_bin:?} {codex_script:?} \"$@\"\n"),
    )
    .unwrap();
    fs::set_permissions(&codex_wrapper, fs::Permissions::from_mode(0o755)).unwrap();

    iso.env.insert(
        "COWORK_CODEX_APP_SERVER_BIN".into(),
        codex_wrapper.to_string_lossy().into_owned(),
    );
    iso.env.insert(
        "COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS".into(),
        "1".into(),
    );
    iso.env.insert(
        "COWORK_BROWSER_OPENER_COMMAND".into(),
        opener_script.to_string_lossy().into_owned(),
    );

    let cwd = iso.workspace.to_string_lossy().into_owned();
    let server = start_server(iso.server_options(false)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    // 1. Opener failure case: fail_opener flag set -> callback fails fast with opener error.
    fs::write(&fail_opener_flag, "1").unwrap();
    let auth_fail = ws_call(
        &mut ws,
        "cx-auth-fail",
        "cowork/provider/auth/authorize",
        json!({ "cwd": cwd, "provider": "codex-cli", "methodId": "oauth_cli" }),
    )
    .await;
    assert_eq!(
        auth_fail["result"]["event"]["type"], "provider_auth_challenge",
        "auth_fail: {auth_fail}"
    );
    let cb_fail = ws_call(
        &mut ws,
        "cx-cb-fail",
        "cowork/provider/auth/callback",
        json!({
            "cwd": cwd,
            "provider": "codex-cli",
            "methodId": "oauth_cli"
        }),
    )
    .await;
    assert_eq!(cb_fail["result"]["event"]["ok"], false);
    assert!(
        cb_fail["result"]["event"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("Unable to open the Codex app-server ChatGPT login URL"),
        "expected opener failure message, got: {cb_fail}"
    );
    fs::remove_file(&fail_opener_flag).unwrap();
    let _ = fs::remove_file(&opened_file);

    // 2. Success case: authorize reuses pooled client, callback opens authUrl via opener, completes login, AND evicts pooled client!
    let auth_ok = ws_call(
        &mut ws,
        "cx-auth-ok",
        "cowork/provider/auth/authorize",
        json!({ "cwd": cwd, "provider": "codex-cli", "methodId": "oauth_cli" }),
    )
    .await;
    assert_eq!(
        auth_ok["result"]["event"]["type"], "provider_auth_challenge",
        "auth_ok: {auth_ok}"
    );
    let spawns_before_cb: Value =
        serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
    let spawns_pre = spawns_before_cb["spawns"].as_i64().unwrap();
    assert!(spawns_pre >= 1);

    let cb_ok = ws_call(
        &mut ws,
        "cx-cb-ok",
        "cowork/provider/auth/callback",
        json!({
            "cwd": cwd,
            "provider": "codex-cli",
            "methodId": "oauth_cli"
        }),
    )
    .await;
    assert_eq!(
        cb_ok["result"]["event"]["ok"], true,
        "cb_ok failed: {cb_ok}"
    );

    let opened_urls = fs::read_to_string(&opened_file).unwrap_or_default();
    assert_eq!(
        opened_urls.trim(),
        "http://127.0.0.1:9/codex-chatgpt-login?state=seam",
        "callback must launch the ChatGPT login URL via browser opener"
    );

    // Subsequent connector list MUST spawn a fresh client (proving post-login codex_pool eviction)!
    let spawns_after_login: Value =
        serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
    let spawns_post_cb = spawns_after_login["spawns"].as_i64().unwrap();
    let post_list = ws_call(
        &mut ws,
        "cx-post-list",
        "cowork/connectors/openai-native/list",
        json!({ "cwd": cwd }),
    )
    .await;
    assert!(
        post_list.get("error").is_none(),
        "post_list failed: {post_list}"
    );
    assert_eq!(post_list["result"]["event"]["authenticated"], true);
    let spawns_after_post_list: Value =
        serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
    assert!(
        spawns_after_post_list["spawns"].as_i64().unwrap() > spawns_post_cb,
        "expected codex_pool eviction after login to spawn a fresh client on next request (post_cb={spawns_post_cb}, after_list={})",
        spawns_after_post_list["spawns"]
    );

    server.shutdown().await;
}

#[tokio::test]
async fn session_config_yolo_override_applies_per_thread_without_global_server_yolo() {
    let mut iso = IsolatedSidecarEnv::new("cowork-session-yolo-", false);
    let marker_yolo = iso.workspace.join("per-session-yolo.txt");
    let marker_normal = iso.workspace.join("normal-session.txt");
    fs::write(&marker_yolo, "before").unwrap();
    fs::write(&marker_normal, "before").unwrap();

    let marker_yolo_str = marker_yolo.to_string_lossy().into_owned();
    let marker_normal_str = marker_normal.to_string_lossy().into_owned();

    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: axum::body::Bytes| {
            let my = marker_yolo_str.clone();
            let mn = marker_normal_str.clone();
            async move {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let msgs = parsed["messages"].as_array().cloned().unwrap_or_default();
                let has_tool_result = msgs.iter().any(|m| m["role"] == "tool");
                let body_str = parsed.to_string();
                let sse = if !has_tool_result
                    && body_str.contains("Run destructive bash with session yolo.")
                {
                    chat_sse_tool_call(
                        "call_yolo_rm",
                        "bash",
                        &json!({
                            "command": format!("rm -f '{my}' && printf 'session-yolo-ok' > '{my}'")
                        }),
                    )
                } else if !has_tool_result
                    && body_str.contains("Run destructive bash without yolo.")
                {
                    chat_sse_tool_call(
                        "call_norm_rm",
                        "bash",
                        &json!({
                            "command": format!("rm -f '{mn}' && printf 'normal-ok' > '{mn}'")
                        }),
                    )
                } else {
                    chat_sse_text("Turn complete.")
                };
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from(sse))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    iso.env
        .insert("TOGETHER_API_KEY".into(), "tgp-session-yolo".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );

    // Server starts with global yolo = FALSE!
    let server = start_server(iso.server_options(false)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    // Thread 1: enable per-session `yolo: true` via `cowork/session/config/set`
    let th1 = ws_call(
        &mut ws,
        "th-s-yolo",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "together",
            "model": "deepseek-ai/DeepSeek-V3"
        }),
    )
    .await;
    let tid1 = th1["result"]["thread"]["id"].as_str().unwrap().to_owned();

    let cfg_res = ws_call(
        &mut ws,
        "cfg-s-yolo",
        "cowork/session/config/set",
        json!({
            "threadId": tid1,
            "config": { "yolo": true }
        }),
    )
    .await;
    assert!(
        cfg_res.get("error").is_none(),
        "config/set failed: {cfg_res}"
    );

    let _ = ws_call(
        &mut ws,
        "turn-s-yolo",
        "turn/start",
        json!({ "threadId": tid1, "input": "Run destructive bash with session yolo." }),
    )
    .await;

    let mut saw_yolo_approval = false;
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("turn 1 frame timeout")
            .unwrap()
            .unwrap();
        let WsMessage::Text(txt) = msg else { continue };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("item/commandExecution/requestApproval")) {
            saw_yolo_approval = true;
            let req_id = val["id"].as_str().unwrap().to_owned();
            ws.send(WsMessage::Text(
                json!({ "id": req_id, "result": { "decision": "decline" } })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        }
        if val.get("method") == Some(&json!("turn/completed"))
            && val["params"]["threadId"] == json!(tid1)
        {
            assert_eq!(val["params"]["turn"]["status"], json!("completed"));
            break;
        }
    }
    assert!(
        !saw_yolo_approval,
        "per-session config.yolo=true must auto-approve bash without requestApproval even when server yolo=false"
    );
    assert_eq!(fs::read_to_string(&marker_yolo).unwrap(), "session-yolo-ok");

    // Thread 2 on the SAME server (without yolo override) MUST still prompt for approval!
    let th2 = ws_call(
        &mut ws,
        "th-norm",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "together",
            "model": "deepseek-ai/DeepSeek-V3"
        }),
    )
    .await;
    let tid2 = th2["result"]["thread"]["id"].as_str().unwrap().to_owned();
    let _ = ws_call(
        &mut ws,
        "turn-norm",
        "turn/start",
        json!({ "threadId": tid2, "input": "Run destructive bash without yolo." }),
    )
    .await;

    let mut saw_normal_approval = false;
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("turn 2 frame timeout")
            .unwrap()
            .unwrap();
        let WsMessage::Text(txt) = msg else { continue };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("item/commandExecution/requestApproval")) {
            saw_normal_approval = true;
            let req_id = val["id"].as_str().unwrap().to_owned();
            ws.send(WsMessage::Text(
                json!({ "id": req_id, "result": { "decision": "accept" } })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        }
        if val.get("method") == Some(&json!("turn/completed"))
            && val["params"]["threadId"] == json!(tid2)
        {
            break;
        }
    }
    assert!(
        saw_normal_approval,
        "sibling thread without yolo override must still emit item/commandExecution/requestApproval"
    );

    server.shutdown().await;
    llm_task.abort();
}

#[tokio::test]
async fn startup_reconciles_pending_task_artifact_revision_settlements() {
    let mut iso = IsolatedSidecarEnv::new("cowork-pending-settle-", true);

    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async move {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(chat_sse_text("Kickoff complete.")))
                .unwrap()
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    iso.env
        .insert("TOGETHER_API_KEY".into(), "tgp-settle-test".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );

    let server1 = start_server(iso.server_options(false)).await.unwrap();
    let mut ws1 = connect_ready_ws(server1.ws_url()).await;

    struct SeededTaskInfo {
        task_id: String,
        artifact_id: String,
        work_item_id: String,
        task_thread_id: String,
        session_id: String,
        version_id: String,
        suffix: String,
    }

    async fn create_task_for_seed(
        ws: &mut WsStream,
        iso: &IsolatedSidecarEnv,
        suffix: &str,
        review_required: bool,
    ) -> SeededTaskInfo {
        let file_name = format!("deliverable-{suffix}.md");
        fs::write(
            iso.workspace.join(&file_name),
            format!("# Deliverable {suffix} v2\n"),
        )
        .unwrap();

        let create_res = ws_call(
            ws,
            &format!("create-{suffix}"),
            "task/create",
            json!({
                "provider": "together",
                "model": "deepseek-ai/DeepSeek-V3",
                "idempotencyKey": format!("idem-settle-{suffix}"),
                "title": format!("Settlement Task {suffix}"),
                "objective": "Verify pending artifact revision settlement on startup.",
                "context": "Settlement reconciliation test.",
                "reviewRequired": review_required,
                "reviewRounds": 0,
                "requirements": [
                    { "kind": "acceptance_criterion", "text": "Write deliverable", "permanence": "fixed" }
                ],
                "workItems": [
                    { "key": "draft", "title": "Draft deliverable", "expectedOutputs": [&file_name] }
                ]
            }),
        )
        .await;
        assert!(
            create_res.get("error").is_none(),
            "task/create failed: {create_res}"
        );
        let task_id = create_res["result"]["task"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        tokio::time::sleep(Duration::from_millis(200)).await;

        let read_res = ws_call(
            ws,
            &format!("read-{suffix}"),
            "task/read",
            json!({ "taskId": task_id }),
        )
        .await;
        let mut rev = read_res["result"]["task"]["revision"].as_i64().unwrap();
        let work_item_id = read_res["result"]["task"]["workItems"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let task_thread_id = read_res["result"]["task"]["threads"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let session_id = read_res["result"]["task"]["threads"][0]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();

        let status = read_res["result"]["task"]["status"].as_str().unwrap_or("");
        if status != "working" {
            let start_res = ws_call(
                ws,
                &format!("claim-{suffix}"),
                "task/workItem/claim",
                json!({
                    "taskId": task_id,
                    "expectedRevision": rev,
                    "workItemId": work_item_id,
                    "taskThreadId": task_thread_id
                }),
            )
            .await;
            rev = start_res["result"]["task"]["revision"].as_i64().unwrap();
        }

        let reg_res = ws_call(
            ws,
            &format!("reg-{suffix}"),
            "task/artifact/register",
            json!({
                "taskId": task_id,
                "expectedRevision": rev,
                "path": file_name,
                "title": format!("Deliverable {suffix}"),
                "kind": "document",
                "changeSummary": "Revised deliverable",
                "workItemId": work_item_id
            }),
        )
        .await;
        assert!(reg_res.get("error").is_none(), "reg failed: {reg_res}");
        rev = reg_res["result"]["task"]["revision"].as_i64().unwrap();
        let artifact_id = reg_res["result"]["task"]["artifacts"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let mark_res = ws_call(
            ws,
            &format!("mark-{suffix}"),
            "task/workItem/mark",
            json!({
                "taskId": task_id,
                "expectedRevision": rev,
                "workItemId": work_item_id,
                "status": "done",
                "completionEvidence": format!("Wrote {file_name}")
            }),
        )
        .await;
        assert!(mark_res.get("error").is_none(), "mark failed: {mark_res}");

        let art_read = ws_call(
            ws,
            &format!("art-read-{suffix}"),
            "task/artifact/read",
            json!({ "taskId": task_id, "artifactId": artifact_id }),
        )
        .await;
        let version_id = art_read["result"]["detail"]["versions"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        SeededTaskInfo {
            task_id,
            artifact_id,
            work_item_id,
            task_thread_id,
            session_id,
            version_id,
            suffix: suffix.to_owned(),
        }
    }

    let review_seed = create_task_for_seed(&mut ws1, &iso, "review", true).await;
    let auto_seed = create_task_for_seed(&mut ws1, &iso, "auto", false).await;
    let review_task_id = review_seed.task_id.clone();
    let auto_accept_task_id = auto_seed.task_id.clone();

    drop(ws1);
    server1.shutdown().await;

    // Seed pre-crash `pending` settlement state in `sessions.db` after server1 has stopped.
    {
        let db_path = iso.home.join(".cowork/sessions.db");
        let conn = Connection::open(&db_path).unwrap();
        let now = "2026-10-31T12:00:00.000Z";
        for seed in [&review_seed, &auto_seed] {
            conn.execute(
                "UPDATE sessions SET execution_state = 'completed' WHERE session_id = ?1",
                rusqlite::params![&seed.session_id],
            )
            .unwrap();
            conn.execute(
                "UPDATE tasks SET status = 'working' WHERE task_id = ?1",
                rusqlite::params![&seed.task_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_artifact_revisions (
                    revision_id, task_id, artifact_id, work_item_id, task_thread_id, session_id,
                    base_version_id, prior_version_id, result_version_id,
                    prior_task_status, settlement_status, status, instruction,
                    created_at, updated_at, completed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7, 'awaiting_review', 'pending', 'completed', 'Add executive summary', ?8, ?8, ?8)",
                rusqlite::params![
                    format!("rev-pending-{}", seed.suffix),
                    &seed.task_id,
                    &seed.artifact_id,
                    &seed.work_item_id,
                    &seed.task_thread_id,
                    &seed.session_id,
                    &seed.version_id,
                    now
                ],
            )
            .unwrap();
        }
    }

    // Boot a fresh server on the same workspace -> `init_task_coordinator` must reconcile both pending settlements!
    let server2 = start_server(iso.server_options(false)).await.unwrap();
    let mut ws2 = connect_ready_ws(server2.ws_url()).await;

    let r_review = ws_call(
        &mut ws2,
        "post-restart-review",
        "task/read",
        json!({ "taskId": review_task_id }),
    )
    .await;
    assert_eq!(
        r_review["result"]["task"]["status"], "awaiting_review",
        "reviewRequired=true task with pending_settlement revision must reconcile to awaiting_review on startup: {r_review}"
    );

    let r_auto = ws_call(
        &mut ws2,
        "post-restart-auto",
        "task/read",
        json!({ "taskId": auto_accept_task_id }),
    )
    .await;
    assert_eq!(
        r_auto["result"]["task"]["status"], "completed",
        "reviewRequired=false task with pending_settlement revision must reconcile to completed on startup: {r_auto}"
    );

    let conn = Connection::open(iso.home.join(".cowork/sessions.db")).unwrap();
    let remaining_pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task_artifact_revisions WHERE settlement_status = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        remaining_pending, 0,
        "all pending settlement rows must be cleared after startup reconciliation"
    );

    drop(ws2);
    server2.shutdown().await;
    llm_task.abort();
}

#[tokio::test]
async fn desktop_jsonrpc_socket_handshake_succeeds_with_default_capabilities() {
    let iso = IsolatedSidecarEnv::new("cowork-desktop-handshake-", false);
    let server = start_server(iso.server_options(false)).await.unwrap();

    let mut req = server.ws_url().into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

    // Exact frame emitted by `src/client/jsonRpcSocket.ts` when `experimentalApi` is unset (Desktop & Mobile default)
    ws.send(WsMessage::Text(
        json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "cowork-desktop",
                    "title": "Cowork Desktop",
                    "version": "0.1.0"
                },
                "capabilities": {
                    "experimentalApi": false,
                    "toolRetryLineage": true
                }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let init_frame = ws.next().await.unwrap().unwrap();
    let WsMessage::Text(init_txt) = init_frame else {
        panic!("expected text frame, got {init_frame:?}");
    };
    let init_val: Value = serde_json::from_str(&init_txt).unwrap();
    assert_eq!(init_val["id"], json!(1), "init response: {init_val}");
    assert!(
        init_val.get("error").is_none(),
        "Desktop default initialize must not return error: {init_val}"
    );
    assert_eq!(
        init_val["result"]["capabilities"],
        json!({
            "experimentalApi": true,
            "toolRetryLineage": true
        })
    );

    // Exact `initialized` frame emitted by `src/client/jsonRpcSocket.ts` (`params` omitted)
    ws.send(WsMessage::Text(
        json!({
            "method": "initialized"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let threads_res = ws_call(
        &mut ws,
        "threads-1",
        "thread/list",
        json!({ "cwd": iso.workspace.to_string_lossy() }),
    )
    .await;
    assert!(
        threads_res.get("error").is_none(),
        "thread/list after Desktop handshake must succeed: {threads_res}"
    );
    assert_eq!(threads_res["result"]["threads"], json!([]));

    drop(ws);
    server.shutdown().await;
}

#[tokio::test]
async fn thread_read_and_hydrate_match_strict_typescript_session_snapshot_schema() {
    use std::sync::{Arc, Mutex};

    let mut iso = IsolatedSidecarEnv::new("cowork-thread-read-snap-", false);
    fs::write(iso.workspace.join("note.txt"), "hello-snapshot\n").unwrap();

    let step_idx = Arc::new(Mutex::new(0usize));
    let step_idx_srv = Arc::clone(&step_idx);
    let mock_router = Router::new()
        .route(
            "/v1/models",
            axum::routing::get(|| async {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "object": "list",
                            "data": [{ "id": "mock-local-model", "object": "model" }]
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }),
        )
        // Native model list for the pre-inference model preparation (already loaded).
        .route(
            "/api/v1/models",
            axum::routing::get(|| async {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "models": [{
                            "key": "mock-local-model",
                            "type": "llm",
                            "loaded_instances": [{ "id": "mock-local-model:1", "config": {} }]
                        }] })
                        .to_string(),
                    ))
                    .unwrap()
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move || {
                let step_idx_srv = Arc::clone(&step_idx_srv);
                async move {
                    let cur = {
                        let mut g = step_idx_srv.lock().unwrap();
                        let v = *g;
                        *g += 1;
                        v
                    };
                    let body = if cur == 0 {
                        chat_sse_tool_call(
                            "call_read_1",
                            "read",
                            &json!({ "filePath": "note.txt" }),
                        )
                    } else {
                        chat_sse_text("Snapshot verified: hello-snapshot")
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );

    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_addr = mock_listener.local_addr().unwrap();
    let mock_srv = tokio::spawn(async move {
        let _ = axum::serve(mock_listener, mock_router).await;
    });

    iso.env
        .insert("LM_STUDIO_BASE_URL".into(), format!("http://{mock_addr}"));

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();

    let start_res = ws_call(
        &mut ws,
        "th-start",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "lmstudio",
            "model": "mock-local-model"
        }),
    )
    .await;
    let thread_id = start_res["result"]["thread"]["id"]
        .as_str()
        .expect("thread.id")
        .to_owned();

    // 1. Empty thread immediately after `thread/start`
    let read_empty = ws_call(
        &mut ws,
        "th-read-empty",
        "thread/read",
        json!({ "threadId": thread_id }),
    )
    .await;
    let hydrate_empty = ws_call(
        &mut ws,
        "th-hydrate-empty",
        "thread/hydrate",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await;

    // 2. Budget configured before any turn runs
    let budget_res = ws_call(
        &mut ws,
        "th-budget",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "warnAtUsd": 1.25, "stopAtUsd": 5.0 }),
    )
    .await;
    assert!(
        budget_res.get("error").is_none(),
        "budget error: {budget_res}"
    );
    let read_budget = ws_call(
        &mut ws,
        "th-read-budget",
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": false }),
    )
    .await;

    // 3. Full streaming turn with tool call + assistant response
    ws.send(WsMessage::Text(
        json!({
            "id": "turn-1",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "clientMessageId": "cmsg-snap-1",
                "input": "Read note.txt and summarize it."
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let mut got_turn_resp = false;
    let mut got_turn_completed = false;
    while !got_turn_resp || !got_turn_completed {
        let msg = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("turn timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = msg {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!("turn-1")) {
                assert!(val.get("error").is_none(), "turn/start error: {val}");
                got_turn_resp = true;
            } else if val.get("method") == Some(&json!("turn/completed")) {
                assert_eq!(val["params"]["turn"]["status"], json!("completed"));
                got_turn_completed = true;
            }
        }
    }

    let read_after_turn = ws_call(
        &mut ws,
        "th-read-turn",
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await;
    let hydrate_after_turn = ws_call(
        &mut ws,
        "th-hydrate-turn",
        "thread/hydrate",
        json!({ "threadId": thread_id, "includeTurns": false }),
    )
    .await;

    // 4. Restart server and verify cold-persisted `session_snapshots` row also passes strict schema!
    drop(ws);
    server.shutdown().await;
    let server2 = start_server(iso.server_options(true)).await.unwrap();
    let mut ws2 = connect_ready_ws(server2.ws_url()).await;
    let read_after_restart = ws_call(
        &mut ws2,
        "th-read-restart",
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await;

    // Validate all 6 payloads against untouched TypeScript strict Zod schemas!
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let samples_path = iso.base.join("thread_read_samples.json");
    fs::write(
        &samples_path,
        serde_json::to_vec_pretty(&json!({
            "threadId": thread_id,
            "readEmpty": read_empty["result"],
            "hydrateEmpty": hydrate_empty["result"],
            "readBudget": read_budget["result"],
            "readAfterTurn": read_after_turn["result"],
            "hydrateAfterTurn": hydrate_after_turn["result"],
            "readAfterRestart": read_after_restart["result"],
        }))
        .unwrap(),
    )
    .unwrap();

    let bun_check = std::process::Command::new("bun")
        .current_dir(&repo_root)
        .env("SAMPLES_PATH", &samples_path)
        .args([
            "-e",
            r#"
import { readFileSync } from "node:fs";
import { z } from "zod";
import { projectedItemSchema } from "./src/shared/projectedItems";
import { sessionSnapshotSchema } from "./src/shared/sessionSnapshot";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const jsonRpcThreadSchema = z
  .object({
    id: nonEmptyTrimmedStringSchema,
    title: z.string(),
    preview: z.string(),
    modelProvider: z.string(),
    model: z.string(),
    cwd: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    lastEventSeq: z.number().int().nonnegative(),
    hasPendingAsk: z.boolean().optional(),
    hasPendingApproval: z.boolean().optional(),
    status: z.object({ type: z.string() }).strict(),
    pinned: z.boolean().optional(),
    pinnedAt: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    archivedAt: z.string().nullable().optional(),
  })
  .strict();
const replayHealthSchema = z
  .object({
    trusted: z.boolean(),
    snapshotRequired: z.boolean(),
    reason: z.enum(["ok", "journal_write_failed", "after_seq_beyond_tail"]),
    tailSeq: z.number().int().nonnegative(),
    failedWriteCount: z.number().int().nonnegative(),
    droppedEventCount: z.number().int().nonnegative(),
  })
  .strict();
const threadSnapshotResponseSchema = z
  .object({
    thread: jsonRpcThreadSchema.extend({
      turns: z
        .array(
          z
            .object({
              id: nonEmptyTrimmedStringSchema,
              status: z.string(),
              items: z.array(projectedItemSchema),
            })
            .strict(),
        )
        .optional(),
    }),
    coworkSnapshot: sessionSnapshotSchema.nullable(),
    journalTailSeq: z.number().int().nonnegative().optional(),
    replayHealth: replayHealthSchema.optional(),
  })
  .strict();

const samples = JSON.parse(readFileSync(process.env.SAMPLES_PATH!, "utf8"));
const readSchema = threadSnapshotResponseSchema;
const hydrateSchema = threadSnapshotResponseSchema;

const rEmpty = readSchema.parse(samples.readEmpty);
const hEmpty = hydrateSchema.parse(samples.hydrateEmpty);
const rBudget = readSchema.parse(samples.readBudget);
const rTurn = readSchema.parse(samples.readAfterTurn);
const hTurn = hydrateSchema.parse(samples.hydrateAfterTurn);
const rRestart = readSchema.parse(samples.readAfterRestart);

if (!rEmpty.coworkSnapshot || rEmpty.coworkSnapshot.sessionId !== samples.threadId) {
  throw new Error("readEmpty missing coworkSnapshot.sessionId");
}
if (rEmpty.coworkSnapshot.sessionUsage !== null) {
  throw new Error("readEmpty sessionUsage should be null before budget/turns");
}
if (!hEmpty.coworkSnapshot || hEmpty.coworkSnapshot.feed.length !== 0) {
  throw new Error("hydrateEmpty feed should be empty");
}
if (!rBudget.coworkSnapshot?.sessionUsage || rBudget.coworkSnapshot.sessionUsage.budgetStatus.stopAtUsd !== 5) {
  throw new Error("readBudget missing budgetStatus.stopAtUsd === 5");
}
if (!rTurn.coworkSnapshot || !hTurn.coworkSnapshot || !rRestart.coworkSnapshot) {
  throw new Error("afterTurn/afterRestart missing coworkSnapshot");
}
const kinds = rTurn.coworkSnapshot.feed.map((f) => f.kind === "message" ? `${f.kind}:${f.role}` : f.kind);
if (!kinds.includes("message:user") || !kinds.includes("tool") || !kinds.includes("message:assistant")) {
  throw new Error(`expected user, tool, assistant in feed, got: ${JSON.stringify(kinds)}`);
}
if (rRestart.coworkSnapshot.feed.length !== rTurn.coworkSnapshot.feed.length) {
  throw new Error(`expected cold restart feed length ${rTurn.coworkSnapshot.feed.length}, got ${rRestart.coworkSnapshot.feed.length}`);
}
const userItem = rTurn.coworkSnapshot.feed.find((f) => f.kind === "message" && f.role === "user");
if (!userItem || !userItem.id.endsWith(":cmsg-snap-1")) {
  throw new Error(`expected user feed item id ending with :cmsg-snap-1, got: ${JSON.stringify(userItem)}`);
}
if (rTurn.coworkSnapshot.lastEventSeq < (rTurn.journalTailSeq ?? 0)) {
  throw new Error(`expected lastEventSeq (${rTurn.coworkSnapshot.lastEventSeq}) >= journalTailSeq (${rTurn.journalTailSeq})`);
}
if (!rTurn.coworkSnapshot.sessionUsage || rTurn.coworkSnapshot.sessionUsage.totalTurns < 1) {
  throw new Error(`expected sessionUsage.totalTurns >= 1, got: ${JSON.stringify(rTurn.coworkSnapshot.sessionUsage)}`);
}
if (!rTurn.coworkSnapshot.lastTurnUsage) {
  throw new Error("expected non-null lastTurnUsage after completed turn");
}
"#,
        ])
        .output()
        .expect("run bun schema check");

    assert!(
        bun_check.status.success(),
        "TypeScript strict sessionSnapshotSchema rejected Rust thread/read response:\nstdout: {}\nstderr: {}\nsamples: {}",
        String::from_utf8_lossy(&bun_check.stdout),
        String::from_utf8_lossy(&bun_check.stderr),
        fs::read_to_string(&samples_path).unwrap_or_default()
    );

    drop(ws2);
    mock_srv.abort();
    server2.shutdown().await;
}
