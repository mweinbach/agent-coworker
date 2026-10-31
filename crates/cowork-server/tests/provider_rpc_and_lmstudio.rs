use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use cowork_server::{ServerOptions, start_server};
use data_encoding::BASE64URL_NOPAD;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use uuid::Uuid;

struct IsolatedEnv {
    base_dir: PathBuf,
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedEnv {
    fn new() -> Self {
        let id = Uuid::new_v4();
        let base_dir = PathBuf::from(format!("/private/tmp/cowork-prov-rpc-{id}"));
        let home_dir = base_dir.join("home");
        let userdata_dir = base_dir.join("userdata");
        let workspace_dir = base_dir.join("workspace");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::create_dir_all(&userdata_dir).unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();

        let home_dir = std::fs::canonicalize(&home_dir).unwrap();
        let userdata_dir = std::fs::canonicalize(&userdata_dir).unwrap();
        let workspace_dir = std::fs::canonicalize(&workspace_dir).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".into(), home_dir.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            userdata_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            userdata_dir.to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
        env.insert(
            "OPENCODE_GO_BASE_URL".into(),
            "http://127.0.0.1:9/v1".into(),
        );
        env.insert(
            "OPENCODE_ZEN_BASE_URL".into(),
            "http://127.0.0.1:9/v1".into(),
        );

        Self {
            base_dir,
            home_dir,
            workspace_dir,
            env,
        }
    }

    fn server_options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace_dir.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home_dir.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

impl Drop for IsolatedEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base_dir);
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_initialized_ws(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("cowork.jsonrpc.v1"),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

    ws.send(WsMessage::Text(
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "provider-rpc-test", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let init_raw = match ws.next().await.unwrap().unwrap() {
        WsMessage::Text(t) => t.to_string(),
        other => panic!("unexpected ws message: {other:?}"),
    };
    let init_val: Value = serde_json::from_str(&init_raw).unwrap();
    assert!(init_val.get("jsonrpc").is_none(), "must omit jsonrpc: 2.0");
    assert_eq!(init_val["id"], "init-1");

    ws.send(WsMessage::Text(
        json!({ "method": "initialized", "params": {} })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();

    ws
}

async fn ws_rpc(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    loop {
        let msg = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("ws response timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = msg {
            let val: Value = serde_json::from_str(&txt).unwrap();
            assert!(
                val.get("jsonrpc").is_none(),
                "outbound frame must omit jsonrpc"
            );
            if val.get("id").and_then(Value::as_str) == Some(id) {
                return val;
            }
        }
    }
}

fn install_mock_codex_app_server(iso: &mut IsolatedEnv, initial_authenticated: bool) -> PathBuf {
    let log_file = iso.base_dir.join("codex-rpc-log.jsonl");
    let state_file = iso.base_dir.join("codex-mock-state.json");
    std::fs::write(
        &state_file,
        json!({
            "authenticated": initial_authenticated,
            "apps": { "github": false, "slack": true },
            "spawns": 0,
            "modelListBatches": 0
        })
        .to_string(),
    )
    .unwrap();

    if initial_authenticated {
        let codex_auth = iso.home_dir.join(".cowork/auth/codex-cli");
        std::fs::create_dir_all(&codex_auth).unwrap();
        std::fs::write(
            codex_auth.join("auth.json"),
            r#"{"access_token":"seed-codex-tok","email":"seed@example.com"}"#,
        )
        .unwrap();
    }

    let script_path = iso.base_dir.join("mock_codex_server.mjs");
    std::fs::write(
        &script_path,
        format!(
            r#"import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const logFile = {log_file:?};
const stateFile = {state_file:?};

function readState() {{
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}}
function writeState(st) {{
  fs.writeFileSync(stateFile, JSON.stringify(st), "utf8");
}}
function appendLog(entry) {{
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
}}

const st0 = readState();
st0.spawns = (st0.spawns || 0) + 1;
writeState(st0);
appendLog({{
  event: "spawn",
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME || null,
  customEnvMarker: process.env.COWORK_TEST_MARKER || null,
}});

const rl = readline.createInterface({{ input: process.stdin, crlfDelay: Infinity }});
function send(obj) {{
  process.stdout.write(JSON.stringify(obj) + "\n");
}}

rl.on("line", (line) => {{
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  appendLog({{ event: "rpc", id: msg.id ?? null, method: msg.method ?? null, params: msg.params ?? null }});

  if (msg.method === "initialize") {{
    send({{ id: msg.id, result: {{ serverInfo: {{ name: "mock-codex", version: "0.160.0" }} }} }});
  }} else if (msg.method === "account/read") {{
    const st = readState();
    if (st.authenticated) {{
      send({{
        id: msg.id,
        result: {{
          account: {{ email: "chatgpt-user@example.com", planType: "pro" }},
          requiresOpenaiAuth: false,
        }},
      }});
    }} else {{
      send({{
        id: msg.id,
        result: {{
          account: null,
          requiresOpenaiAuth: true,
        }},
      }});
    }}
  }} else if (msg.method === "account/login/start") {{
    const loginId = "codex-login-42";
    send({{
      id: msg.id,
      result: {{
        type: "chatgpt",
        loginId,
        authUrl: "http://127.0.0.1:9/codex-chatgpt-login?state=42",
      }},
    }});
    setTimeout(() => {{
      const st = readState();
      st.authenticated = true;
      writeState(st);
      if (process.env.CODEX_HOME) {{
        fs.mkdirSync(process.env.CODEX_HOME, {{ recursive: true }});
        fs.writeFileSync(
          path.join(process.env.CODEX_HOME, "auth.json"),
          JSON.stringify({{ access_token: "live-chatgpt-oauth-tok", email: "chatgpt-user@example.com", plan_type: "pro" }}),
          {{ mode: 0o600 }},
        );
      }}
      send({{
        method: "account/login/completed",
        params: {{ loginId, success: true, error: null }},
      }});
    }}, 30);
  }} else if (msg.method === "account/logout") {{
    const st = readState();
    st.authenticated = false;
    writeState(st);
    if (process.env.CODEX_HOME) {{
      const af = path.join(process.env.CODEX_HOME, "auth.json");
      if (fs.existsSync(af)) fs.unlinkSync(af);
    }}
    send({{ id: msg.id, result: {{ ok: true }} }});
  }} else if (msg.method === "config/read") {{
    const st = readState();
    const apps = {{}};
    for (const [k, v] of Object.entries(st.apps || {{}})) {{
      apps[k] = {{ enabled: Boolean(v) }};
    }}
    send({{ id: msg.id, result: {{ config: {{ apps }} }} }});
  }} else if (msg.method === "config/value/write") {{
    const st = readState();
    const kp = String(msg.params?.keyPath || "");
    const m = /^apps\.([^.]+)\.enabled$/.exec(kp);
    if (m) {{
      st.apps[m[1]] = Boolean(msg.params?.value);
      writeState(st);
    }}
    send({{ id: msg.id, result: {{ ok: true }} }});
  }} else if (msg.method === "mcpServerStatus/list") {{
    // Return empty MCP tools so `app/list` (including `forceRefetch`) is also exercised
    send({{ id: msg.id, result: {{ data: [], nextCursor: null }} }});
  }} else if (msg.method === "app/list") {{
    const st = readState();
    send({{
      id: msg.id,
      result: {{
        data: [
          {{
            id: "github",
            name: "GitHub",
            description: "GitHub repositories",
            isAccessible: true,
            isEnabled: Boolean(st.apps.github),
          }},
          {{
            id: "slack",
            name: "Slack",
            description: "Slack workspace",
            isAccessible: true,
            isEnabled: Boolean(st.apps.slack),
          }},
        ],
        nextCursor: null,
      }},
    }});
  }} else if (msg.method === "model/list") {{
    const st = readState();
    st.modelListBatches = (st.modelListBatches || 0) + 1;
    writeState(st);
    const batch = st.modelListBatches;
    send({{
      id: msg.id,
      result: {{
        data: [
          {{
            id: `gpt-5.4-codex-b${{batch}}`,
            displayName: `GPT-5.4 Codex B${{batch}}`,
            isDefault: true,
            supportsImageInput: true,
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          }},
        ],
        nextCursor: null,
      }},
    }});
  }}
}});
"#,
            log_file = log_file.to_string_lossy(),
            state_file = state_file.to_string_lossy(),
        ),
    )
    .unwrap();

    let node_bin = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join("node"))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/usr/local/bin/node"));
    let wrapper_path = iso.base_dir.join("mock-codex");
    std::fs::write(
        &wrapper_path,
        format!(
            "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
            node_bin.display(),
            script_path.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    iso.env.insert(
        "COWORK_CODEX_APP_SERVER_BIN".into(),
        wrapper_path.to_string_lossy().into_owned(),
    );
    iso.env
        .insert("COWORK_TEST_MARKER".into(), "isolated-runtime-env".into());
    log_file
}

#[tokio::test]
async fn serves_all_17_provider_rpc_routes_and_3_openai_native_connector_routes() {
    let mut iso = IsolatedEnv::new();
    // Point LM Studio and test API providers to an unused loopback port so unit assertions never make external network calls
    iso.env
        .insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
    iso.env
        .insert("OPENAI_BASE_URL".into(), "http://127.0.0.1:9/v1".into());
    iso.env.insert(
        "OPENCODE_GO_BASE_URL".into(),
        "http://127.0.0.1:9/v1".into(),
    );
    iso.env.insert(
        "OPENCODE_ZEN_BASE_URL".into(),
        "http://127.0.0.1:9/v1".into(),
    );
    iso.env.insert(
        "COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS".into(),
        "1".into(),
    );
    let codex_log = install_mock_codex_app_server(&mut iso, true);

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // 1. catalog/read -> all 14 providers
    let cat_res = ws_rpc(
        &mut ws,
        "r1",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd }),
    )
    .await;
    let all = cat_res["result"]["event"]["all"].as_array().unwrap();
    assert_eq!(all.len(), 14);

    // Unknown param key -> -32602
    let unknown_param = ws_rpc(
        &mut ws,
        "r1-bad",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd, "bogusKey": true }),
    )
    .await;
    assert_eq!(unknown_param["error"]["code"], -32602);

    // 2. authMethods/read
    let methods_res = ws_rpc(
        &mut ws,
        "r2",
        "cowork/provider/authMethods/read",
        json!({ "cwd": cwd }),
    )
    .await;
    let methods = methods_res["result"]["event"]["methods"]
        .as_object()
        .unwrap();
    assert_eq!(methods.len(), 14);
    assert_eq!(methods["google"].as_array().unwrap().len(), 3);
    assert_eq!(methods["bedrock"].as_array().unwrap().len(), 4);
    assert_eq!(methods["codex-cli"][0]["id"], "oauth_cli");

    // 3. auth/setApiKey (default methodId omitted for CLI compatibility + explicit exa_api_key + validation)
    let set_openai = ws_rpc(
        &mut ws,
        "r3",
        "cowork/provider/auth/setApiKey",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "apiKey": "sk-proj-supersecret9876"
        }),
    )
    .await;
    assert_eq!(set_openai["result"]["event"]["ok"], true);
    assert_eq!(set_openai["result"]["event"]["mode"], "api_key");

    let conn_file = iso.home_dir.join(".cowork/auth/connections.json");
    assert!(conn_file.is_file());
    assert_eq!(
        std::fs::metadata(&conn_file).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let set_exa = ws_rpc(
        &mut ws,
        "r3-exa",
        "cowork/provider/auth/setApiKey",
        json!({
            "cwd": cwd,
            "provider": "google",
            "methodId": "exa_api_key",
            "apiKey": "exa-secret-key-1234"
        }),
    )
    .await;
    assert_eq!(set_exa["result"]["event"]["ok"], true);

    let empty_key = ws_rpc(
        &mut ws,
        "r3-empty",
        "cowork/provider/auth/setApiKey",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "methodId": "api_key",
            "apiKey": ""
        }),
    )
    .await;
    assert_eq!(empty_key["error"]["code"], -32602);

    let ws_only_key = ws_rpc(
        &mut ws,
        "r3-ws",
        "cowork/provider/auth/setApiKey",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "methodId": "api_key",
            "apiKey": "   "
        }),
    )
    .await;
    assert_eq!(ws_only_key["result"]["event"]["ok"], false);

    // 4. auth/setConfig (Bedrock structured credentials)
    let set_bedrock_missing = ws_rpc(
        &mut ws,
        "r4-bad",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "methodId": "aws_keys",
            "values": { "accessKeyId": "AKIA1234567890" }
        }),
    )
    .await;
    assert_eq!(set_bedrock_missing["result"]["event"]["ok"], false);

    let set_bedrock_ok = ws_rpc(
        &mut ws,
        "r4-ok",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "methodId": "aws_keys",
            "values": {
                "accessKeyId": "AKIA1234567890ABCD",
                "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                "region": "us-west-2"
            }
        }),
    )
    .await;
    assert_eq!(set_bedrock_ok["result"]["event"]["ok"], true);
    assert_eq!(set_bedrock_ok["result"]["event"]["mode"], "credentials");

    // 5. auth/copyApiKey (OpenCode sibling pair only)
    let _ = ws_rpc(
        &mut ws,
        "r5-seed",
        "cowork/provider/auth/setApiKey",
        json!({
            "cwd": cwd,
            "provider": "opencode-go",
            "methodId": "api_key",
            "apiKey": "oc-shared-secret-key"
        }),
    )
    .await;
    let copy_ok = ws_rpc(
        &mut ws,
        "r5-ok",
        "cowork/provider/auth/copyApiKey",
        json!({
            "cwd": cwd,
            "provider": "opencode-zen",
            "sourceProvider": "opencode-go"
        }),
    )
    .await;
    assert_eq!(copy_ok["result"]["event"]["ok"], true);

    let copy_bad = ws_rpc(
        &mut ws,
        "r5-bad",
        "cowork/provider/auth/copyApiKey",
        json!({
            "cwd": cwd,
            "provider": "anthropic",
            "sourceProvider": "openai"
        }),
    )
    .await;
    assert_eq!(copy_bad["error"]["code"], -32600);

    // 6. status/refresh
    let status_res = ws_rpc(
        &mut ws,
        "r6",
        "cowork/provider/status/refresh",
        json!({ "cwd": cwd }),
    )
    .await;
    let statuses = status_res["result"]["event"]["providers"]
        .as_array()
        .unwrap();
    assert_eq!(statuses.len(), 14);
    let openai_st = statuses.iter().find(|s| s["provider"] == "openai").unwrap();
    assert_eq!(openai_st["authorized"], true);
    assert_eq!(openai_st["savedApiKeyMasks"]["api_key"], "sk-p...9876");
    let google_st = statuses.iter().find(|s| s["provider"] == "google").unwrap();
    assert_eq!(google_st["savedApiKeyMasks"]["exa_api_key"], "exa-...1234");

    // 7. auth/logout
    let logout_res = ws_rpc(
        &mut ws,
        "r7",
        "cowork/provider/auth/logout",
        json!({ "cwd": cwd, "provider": "openai" }),
    )
    .await;
    assert_eq!(
        logout_res["result"]["event"]["type"],
        "provider_auth_result"
    );
    assert_eq!(logout_res["result"]["event"]["methodId"], "logout");
    assert_eq!(logout_res["result"]["event"]["ok"], true);

    // 8 & 9. customModel/add & customModel/delete
    let add_cm = ws_rpc(
        &mut ws,
        "r8",
        "cowork/provider/customModel/add",
        json!({ "cwd": cwd, "provider": "openai", "modelId": "gpt-5.4-enterprise" }),
    )
    .await;
    let openai_models = add_cm["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap();
    assert!(
        openai_models
            .iter()
            .any(|m| m["id"] == "gpt-5.4-enterprise")
    );

    let add_cm_lms = ws_rpc(
        &mut ws,
        "r8-lms",
        "cowork/provider/customModel/add",
        json!({ "cwd": cwd, "provider": "lmstudio", "modelId": "foo" }),
    )
    .await;
    assert_eq!(add_cm_lms["error"]["code"], -32600);

    let del_cm = ws_rpc(
        &mut ws,
        "r9",
        "cowork/provider/customModel/delete",
        json!({ "cwd": cwd, "provider": "openai", "modelId": "gpt-5.4-enterprise" }),
    )
    .await;
    let openai_models_after = del_cm["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap();
    assert!(
        !openai_models_after
            .iter()
            .any(|m| m["id"] == "gpt-5.4-enterprise")
    );

    // 10 & 11. model/setEnabled & model/resetEnabled
    let default_openai = del_cm["result"]["event"]["default"]["openai"]
        .as_str()
        .unwrap()
        .to_string();
    let set_en = ws_rpc(
        &mut ws,
        "r10",
        "cowork/provider/model/setEnabled",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "models": [{ "id": default_openai, "enabled": false }]
        }),
    )
    .await;
    let new_default = set_en["result"]["event"]["default"]["openai"]
        .as_str()
        .unwrap();
    assert_ne!(new_default, default_openai);

    let set_en_empty = ws_rpc(
        &mut ws,
        "r10-empty",
        "cowork/provider/model/setEnabled",
        json!({ "cwd": cwd, "provider": "openai", "models": [] }),
    )
    .await;
    assert_eq!(set_en_empty["error"]["code"], -32602);

    let reset_en = ws_rpc(
        &mut ws,
        "r11",
        "cowork/provider/model/resetEnabled",
        json!({ "cwd": cwd, "provider": "openai" }),
    )
    .await;
    assert_eq!(
        reset_en["result"]["event"]["default"]["openai"].as_str(),
        Some(default_openai.as_str())
    );

    // 12 & 13. codexAppServer/status & codexAppServer/update
    let codex_st = ws_rpc(
        &mut ws,
        "r12",
        "cowork/provider/codexAppServer/status",
        json!({ "cwd": cwd }),
    )
    .await;
    assert!(codex_st["result"]["status"]["source"].is_string());

    let codex_up = ws_rpc(
        &mut ws,
        "r13",
        "cowork/provider/codexAppServer/update",
        json!({ "cwd": cwd, "force": false }),
    )
    .await;
    assert!(codex_up["result"]["status"]["message"].is_string());

    // 14 & 15. lmstudio/local/status & lmstudio/local/start
    let lms_st = ws_rpc(
        &mut ws,
        "r14",
        "cowork/provider/lmstudio/local/status",
        json!({ "cwd": cwd, "baseUrl": "http://127.0.0.1:9" }),
    )
    .await;
    assert_eq!(lms_st["result"]["status"]["running"], false);

    let lms_start_remote = ws_rpc(
        &mut ws,
        "r15-bad",
        "cowork/provider/lmstudio/local/start",
        json!({ "cwd": cwd, "baseUrl": "https://example.com:1234" }),
    )
    .await;
    assert_eq!(lms_start_remote["error"]["code"], -32602);

    let lms_start_missing = ws_rpc(
        &mut ws,
        "r15-ok",
        "cowork/provider/lmstudio/local/start",
        json!({ "cwd": cwd, "baseUrl": "http://127.0.0.1:9", "timeoutMs": 600 }),
    )
    .await;
    assert_eq!(lms_start_missing["result"]["status"]["ok"], false);
    assert_eq!(lms_start_missing["result"]["status"]["installed"], false);

    // 16..18. connectors/openai-native/{list,refresh,setEnabled} (passthrough allowed)
    let conn_list = ws_rpc(
        &mut ws,
        "c1",
        "cowork/connectors/openai-native/list",
        json!({ "cwd": cwd, "extraClientHint": 1 }),
    )
    .await;
    assert_eq!(
        conn_list["result"]["event"]["type"],
        "openai_native_connectors"
    );
    assert_eq!(conn_list["result"]["event"]["authenticated"], true);
    assert_eq!(
        conn_list["result"]["event"]["enabledConnectorIds"],
        json!(["slack"])
    );

    let conn_set = ws_rpc(
        &mut ws,
        "c2",
        "cowork/connectors/openai-native/setEnabled",
        json!({ "cwd": cwd, "connectorId": "github", "enabled": true }),
    )
    .await;
    assert_eq!(
        conn_set["result"]["event"]["enabledConnectorIds"],
        json!(["github", "slack"])
    );
    assert!(
        !iso.home_dir
            .join(".cowork/auth/codex-cli/connectors-preferences.json")
            .exists(),
        "setEnabled must write to codex app-server via config/value/write, not local connectors-preferences.json"
    );

    let conn_ref = ws_rpc(
        &mut ws,
        "c3",
        "cowork/connectors/openai-native/refresh",
        json!({ "cwd": cwd }),
    )
    .await;
    assert_eq!(
        conn_ref["result"]["event"]["enabledConnectorIds"],
        json!(["github", "slack"])
    );

    let rpc_log = std::fs::read_to_string(&codex_log).unwrap();
    assert!(
        rpc_log.contains("\"method\":\"config/value/write\"")
            && rpc_log.contains("\"keyPath\":\"apps.github.enabled\""),
        "expected config/value/write apps.github.enabled in codex app-server log: {rpc_log}"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn completes_dual_stack_ipv4_and_ipv6_oauth_pkce_flow_over_jsonrpc() {
    let mut iso = IsolatedEnv::new();
    iso.env
        .insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());

    // Mock OAuth 2.1 token endpoint validating S256 PKCE verifier
    let captured_challenge: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let ch_state = captured_challenge.clone();

    let oauth_app = Router::new()
        .route(
            "/oauth/token",
            post(
                move |State(exp): State<Arc<Mutex<Option<String>>>>, body: String| async move {
                    let params: Vec<(String, String)> =
                        url::form_urlencoded::parse(body.as_bytes())
                            .into_owned()
                            .collect();
                    let get_p = |k: &str| {
                        params
                            .iter()
                            .find(|(key, _)| key == k)
                            .map(|(_, v)| v.as_str())
                    };
                    let verifier = get_p("code_verifier").unwrap_or_default();
                    let computed = BASE64URL_NOPAD.encode(&Sha256::digest(verifier.as_bytes()));
                    let expected = exp.lock().unwrap().clone().unwrap_or_default();
                    if get_p("code") != Some("rpc-oauth-code-777") || computed != expected {
                        return Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Body::from("invalid_grant"))
                            .unwrap();
                    }
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({
                                "access_token": "oa-rpc-access-tok",
                                "refresh_token": "oa-rpc-refresh-tok",
                                "expires_in": 3600,
                                "token_type": "Bearer"
                            })
                            .to_string(),
                        ))
                        .unwrap()
                },
            ),
        )
        .with_state(ch_state);

    let oauth_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let oauth_port = oauth_listener.local_addr().unwrap().port();
    let oauth_srv = tokio::spawn(async move {
        let _ = axum::serve(oauth_listener, oauth_app).await;
    });

    iso.env
        .insert("COWORK_OAUTH_CLIENT_ID".into(), "cowork-rpc-client".into());
    iso.env.insert(
        "COWORK_OAUTH_AUTHORIZE_URL".into(),
        format!("http://127.0.0.1:{oauth_port}/oauth/authorize"),
    );
    iso.env.insert(
        "COWORK_OAUTH_TOKEN_URL".into(),
        format!("http://127.0.0.1:{oauth_port}/oauth/token"),
    );

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // Start OAuth 2.1 PKCE challenge over JSON-RPC
    let auth_res = ws_rpc(
        &mut ws,
        "oa-1",
        "cowork/provider/auth/authorize",
        json!({
            "cwd": cwd,
            "provider": "codex-cli",
            "methodId": "oauth_cli"
        }),
    )
    .await;
    assert_eq!(
        auth_res["result"]["event"]["type"],
        "provider_auth_challenge"
    );
    let auth_url_str = auth_res["result"]["event"]["challenge"]["url"]
        .as_str()
        .expect("authorize URL with PKCE challenge");
    let parsed_url = url::Url::parse(auth_url_str).unwrap();
    let query: HashMap<String, String> = parsed_url.query_pairs().into_owned().collect();
    let state_param = query.get("state").unwrap().clone();
    let challenge_param = query.get("code_challenge").unwrap().clone();
    let redirect_uri = query.get("redirect_uri").unwrap().clone();
    let cb_port = url::Url::parse(&redirect_uri).unwrap().port().unwrap();
    *captured_challenge.lock().unwrap() = Some(challenge_param);

    // Pasting manual `code` to auto `oauth_cli` method returns ok: false
    let pasted = ws_rpc(
        &mut ws,
        "oa-paste",
        "cowork/provider/auth/callback",
        json!({
            "cwd": cwd,
            "provider": "codex-cli",
            "methodId": "oauth_cli",
            "code": "manual-pasted-code"
        }),
    )
    .await;
    assert_eq!(pasted["result"]["event"]["ok"], false);

    // Deliver CSRF mismatch on IPv4 127.0.0.1 -> HTTP 400, then valid callback on IPv6 [::1]!
    let http = reqwest::Client::new();
    let bad_csrf = http
        .get(format!(
            "http://127.0.0.1:{cb_port}/oauth/callback?code=rpc-oauth-code-777&state=bad-csrf"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_csrf.status(), StatusCode::BAD_REQUEST);

    let deliver_ipv6 = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let ok_resp = http
            .get(format!(
                "http://[::1]:{cb_port}/oauth/callback?code=rpc-oauth-code-777&state={state_param}"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(ok_resp.status(), StatusCode::OK);
    });

    let cb_res = ws_rpc(
        &mut ws,
        "oa-cb",
        "cowork/provider/auth/callback",
        json!({
            "cwd": cwd,
            "provider": "codex-cli",
            "methodId": "oauth_cli"
        }),
    )
    .await;
    deliver_ipv6.await.unwrap();
    assert_eq!(cb_res["result"]["event"]["ok"], true);
    assert_eq!(cb_res["result"]["event"]["mode"], "oauth");

    oauth_srv.abort();
    server.shutdown().await;
}

#[tokio::test]
async fn rejects_unreachable_lmstudio_on_turn_start_and_streams_mock_tool_call_turn() {
    use axum::routing::get;

    // Part A: Unreachable LM Studio loopback port returns -32600 with data.reason == "lmstudio_unreachable"
    {
        let closed_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed_listener.local_addr().unwrap().port();
        drop(closed_listener);

        let mut iso = IsolatedEnv::new();
        let unreachable_url = format!("http://127.0.0.1:{closed_port}");
        iso.env
            .insert("LM_STUDIO_BASE_URL".into(), unreachable_url.clone());
        let server = start_server(iso.server_options()).await.unwrap();
        let mut ws = connect_initialized_ws(server.ws_url()).await;
        let cwd = iso.workspace_dir.to_string_lossy().into_owned();

        let th_res = ws_rpc(
            &mut ws,
            "t-dead-start",
            "thread/start",
            json!({
                "cwd": cwd,
                "provider": "lmstudio",
                "model": "ornith-1.5-122b-uncensored@q4_k_m"
            }),
        )
        .await;
        let thread_id = th_res["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let dead_turn = ws_rpc(
            &mut ws,
            "turn-dead",
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": "Hello"
            }),
        )
        .await;
        assert_eq!(dead_turn["error"]["code"], -32600);
        assert_eq!(dead_turn["error"]["data"]["reason"], "lmstudio_unreachable");
        assert_eq!(dead_turn["error"]["data"]["baseUrl"], unreachable_url);
        server.shutdown().await;
    }

    // Part B: Deterministic local mock OpenAI Chat Completions SSE server (`127.0.0.1:0`)
    // verifying `turn/start` -> `read_file` tool execution -> streaming `item/*` deltas -> `turn/completed`.
    let captured_requests: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured_for_post = Arc::clone(&captured_requests);

    let mock_lmstudio_app = Router::new()
        .route(
            "/v1/models",
            get(|| async {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "object": "list",
                            "data": [
                                {
                                    "id": "ornith-1.5-122b-uncensored@q4_k_m",
                                    "object": "model",
                                    "owned_by": "organization_owner"
                                }
                            ]
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |body: String| {
                let captured = Arc::clone(&captured_for_post);
                async move {
                    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    captured.lock().unwrap().push(parsed.clone());

                    let tool_output = parsed["messages"].as_array().and_then(|msgs| {
                        msgs.iter().rev().find_map(|m| {
                            if m["role"] == "tool" {
                                m["content"].as_str().map(str::trim).map(ToOwned::to_owned)
                            } else {
                                None
                            }
                        })
                    });

                    let sse = if let Some(read_token) = tool_output {
                        let split = read_token.len() / 2;
                        let (part_a, part_b) = read_token.split_at(split);
                        format!(
                            concat!(
                                "data: {{\"id\":\"chatcmpl-mock-2\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"reasoning_content\":\"Verified file token.\"}}}}],\"stats\":{{\"tokens_per_second\":88.4}}}}\n\n",
                                "data: {{\"id\":\"chatcmpl-mock-2\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{part_a:?}}}}}]}}\n\n",
                                "data: {{\"id\":\"chatcmpl-mock-2\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{part_b:?}}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":42,\"completion_tokens\":8,\"total_tokens\":50}},\"model_info\":{{\"arch\":\"qwen\"}}}}\n\n",
                                "data: [DONE]\n\n"
                            ),
                            part_a = part_a,
                            part_b = part_b,
                        )
                    } else {
                        concat!(
                            "data: {\"id\":\"chatcmpl-mock-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Reading workspace token file.\"}}],\"stats\":{\"tokens_per_second\":91.2}}\n\n",
                            "data: {\"id\":\"chatcmpl-mock-1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_mock_read_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"filePath\\\":\\\"\"}}]}}]}\n\n",
                            "data: {\"id\":\"chatcmpl-mock-1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"secret_token.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":12,\"total_tokens\":42},\"stats\":{\"stop_type\":\"eos\"}}\n\n",
                            "data: [DONE]\n\n"
                        )
                        .to_owned()
                    };

                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                }
            }),
        );

    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let mock_srv = tokio::spawn(async move {
        let _ = axum::serve(mock_listener, mock_lmstudio_app).await;
    });

    let mut iso = IsolatedEnv::new();
    iso.env.insert(
        "LM_STUDIO_BASE_URL".into(),
        format!("http://127.0.0.1:{mock_port}"),
    );
    let expected_token = "a1b2c3d4e5f60718";
    std::fs::write(
        iso.workspace_dir.join("secret_token.txt"),
        format!("{expected_token}\n"),
    )
    .unwrap();

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // Verify catalog discovers ornith-1.5-122b-uncensored@q4_k_m via mock GET /v1/models
    let cat_res = ws_rpc(
        &mut ws,
        "mock-cat",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd }),
    )
    .await;
    let lms_entry = cat_res["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "lmstudio")
        .unwrap();
    assert_eq!(lms_entry["state"], "ready");
    assert!(
        lms_entry["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "ornith-1.5-122b-uncensored@q4_k_m")
    );

    let th_res = ws_rpc(
        &mut ws,
        "mock-th",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "lmstudio",
            "model": "ornith-1.5-122b-uncensored@q4_k_m"
        }),
    )
    .await;
    let thread_id = th_res["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let cfg_res = ws_rpc(
        &mut ws,
        "mock-cfg",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "lmstudio": {
                        "temperature": 0.0
                    }
                }
            }
        }),
    )
    .await;
    assert!(
        cfg_res.get("error").is_none(),
        "config/set failed: {cfg_res}"
    );

    ws.send(WsMessage::Text(
        json!({
            "id": "mock-turn-1",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "clientMessageId": "cmsg-mock-1",
                "input": "Call `read_file` on `secret_token.txt` and reply with the exact hex token."
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let mut got_turn_resp = false;
    let mut saw_tool_output_available = false;
    let mut saw_agent_delta = false;
    let mut final_agent_text = String::new();
    let mut turn_completed_status = None;

    while turn_completed_status.is_none() || !got_turn_resp {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("mock LM Studio turn timed out")
            .expect("ws stream open")
            .expect("ws frame ok");
        let WsMessage::Text(txt) = frame else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        assert!(val.get("jsonrpc").is_none());

        if val.get("id").and_then(Value::as_str) == Some("mock-turn-1") {
            assert!(val.get("error").is_none(), "turn/start error: {val}");
            got_turn_resp = true;
            continue;
        }

        match val.get("method").and_then(Value::as_str) {
            Some("item/agentMessage/delta") => {
                if let Some(d) = val["params"]["delta"].as_str()
                    && !d.is_empty()
                {
                    saw_agent_delta = true;
                }
            }
            Some("item/started" | "item/updated" | "item/completed") => {
                let item = &val["params"]["item"];
                if item["type"] == "toolCall" && item["state"] == "output-available" {
                    saw_tool_output_available = true;
                }
                if val["method"] == "item/completed" && item["type"] == "agentMessage" {
                    if let Some(t) = item["text"].as_str() {
                        final_agent_text = t.to_string();
                    } else if let Some(arr) = item["content"].as_array() {
                        for part in arr {
                            if let Some(t) = part["text"].as_str() {
                                final_agent_text.push_str(t);
                            }
                        }
                    }
                }
            }
            Some("turn/completed") => {
                turn_completed_status = val["params"]["turn"]["status"]
                    .as_str()
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }

    assert_eq!(turn_completed_status.as_deref(), Some("completed"));
    assert!(
        saw_tool_output_available,
        "expected read_file toolCall item to reach output-available"
    );
    assert!(
        saw_agent_delta,
        "expected streaming item/agentMessage/delta notifications"
    );
    assert!(
        final_agent_text.contains(expected_token),
        "expected final_agent_text to contain {expected_token}, got {final_agent_text}"
    );

    {
        let reqs = captured_requests.lock().unwrap();
        assert_eq!(reqs.len(), 2, "expected 2 Chat Completions SSE steps");
        assert_eq!(reqs[0]["stream"], true);
        assert_eq!(reqs[0]["temperature"], json!(0.0));
        assert_eq!(reqs[1]["temperature"], json!(0.0));
    }

    mock_srv.abort();
    server.shutdown().await;
}

#[tokio::test]
#[ignore = "live local LM Studio e2e; run with --ignored"]
async fn streams_live_lmstudio_tool_call_turn_on_1234() {
    // Strictly read-only live e2e against http://127.0.0.1:1234 (ornith-1.5-122b-uncensored@q4_k_m).
    // NEVER call /api/v1/models/load or /api/v1/models/unload on port 1234.
    let mut iso = IsolatedEnv::new();
    iso.env
        .insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:1234".into());
    // Unambiguous unprefixed 16-char lowercase hex token so the model never strips synthetic prefixes.
    let hex_token = Uuid::new_v4().simple().to_string()[..16].to_string();
    std::fs::write(
        iso.workspace_dir.join("token.txt"),
        format!("{hex_token}\n"),
    )
    .unwrap();

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // Verify catalog discovers ornith-1.5-122b-uncensored@q4_k_m via read-only GET /v1/models
    let cat_res = ws_rpc(
        &mut ws,
        "live-cat",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd }),
    )
    .await;
    let lms_entry = cat_res["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "lmstudio")
        .unwrap();
    assert_eq!(lms_entry["state"], "ready");
    assert!(
        lms_entry["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "ornith-1.5-122b-uncensored@q4_k_m")
    );

    let th_res = ws_rpc(
        &mut ws,
        "live-th",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "lmstudio",
            "model": "ornith-1.5-122b-uncensored@q4_k_m"
        }),
    )
    .await;
    let thread_id = th_res["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let cfg_res = ws_rpc(
        &mut ws,
        "live-cfg",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "lmstudio": {
                        "temperature": 0.0,
                        "maxTokens": 512
                    }
                }
            }
        }),
    )
    .await;
    assert!(
        cfg_res.get("error").is_none(),
        "config/set failed: {cfg_res}"
    );

    ws.send(WsMessage::Text(
        json!({
            "id": "live-turn-1",
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "clientMessageId": "cmsg-live-1",
                "input": "Call the `read` tool with `{\"filePath\": \"token.txt\"}` and reply with ONLY the exact 16-character hexadecimal string inside that file."
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let mut got_turn_resp = false;
    let mut saw_tool_output_available = false;
    let mut saw_agent_delta = false;
    let mut final_agent_text = String::new();
    let mut turn_completed_status = None;

    while turn_completed_status.is_none() || !got_turn_resp {
        let frame = tokio::time::timeout(Duration::from_secs(90), ws.next())
            .await
            .expect("live LM Studio turn timed out")
            .expect("ws stream open")
            .expect("ws frame ok");
        let WsMessage::Text(txt) = frame else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        assert!(val.get("jsonrpc").is_none());

        if val.get("id").and_then(Value::as_str) == Some("live-turn-1") {
            assert!(val.get("error").is_none(), "turn/start error: {val}");
            got_turn_resp = true;
            continue;
        }

        match val.get("method").and_then(Value::as_str) {
            Some("item/agentMessage/delta") => {
                if let Some(d) = val["params"]["delta"].as_str()
                    && !d.is_empty()
                {
                    saw_agent_delta = true;
                }
            }
            Some("item/started" | "item/updated" | "item/completed") => {
                let item = &val["params"]["item"];
                if item["type"] == "toolCall" && item["state"] == "output-available" {
                    saw_tool_output_available = true;
                }
                if val["method"] == "item/completed" && item["type"] == "agentMessage" {
                    if let Some(t) = item["text"].as_str() {
                        final_agent_text = t.to_string();
                    } else if let Some(arr) = item["content"].as_array() {
                        for part in arr {
                            if let Some(t) = part["text"].as_str() {
                                final_agent_text.push_str(t);
                            }
                        }
                    }
                }
            }
            Some("turn/completed") => {
                turn_completed_status = val["params"]["turn"]["status"]
                    .as_str()
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }

    assert_eq!(turn_completed_status.as_deref(), Some("completed"));
    assert!(
        saw_tool_output_available,
        "expected read_file toolCall item to reach output-available"
    );
    assert!(
        saw_agent_delta,
        "expected streaming item/agentMessage/delta notifications"
    );
    assert!(
        final_agent_text.to_ascii_lowercase().contains(&hex_token),
        "expected final assistant message to include unprefixed hex token {hex_token}, got: {final_agent_text}"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn caches_live_provider_discovery_for_24h_and_honors_refresh_true_over_jsonrpc() {
    use axum::routing::get;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let hit_count = Arc::new(AtomicUsize::new(0));
    let hits_for_route = Arc::clone(&hit_count);
    let mock_models_app = Router::new().route(
        "/v1/models",
        get(move || {
            let hits = Arc::clone(&hits_for_route);
            async move {
                let n = hits.fetch_add(1, Ordering::SeqCst) + 1;
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "object": "list",
                            "data": [
                                { "id": format!("gpt-5.4-mock-v{n}"), "object": "model" }
                            ]
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    let mock_srv = tokio::spawn(async move {
        let _ = axum::serve(listener, mock_models_app).await;
    });

    let mut iso = IsolatedEnv::new();
    iso.env
        .insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
    iso.env
        .insert("OPENAI_API_KEY".into(), "sk-test-cache-12345678".into());
    iso.env.insert(
        "OPENAI_BASE_URL".into(),
        format!("http://127.0.0.1:{mock_port}/v1"),
    );

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // Initial `refresh: true` populates the 24h discovery cache (`~/.cowork/cache/models/openai.json`)
    let r1 = ws_rpc(
        &mut ws,
        "cache-1",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd, "refresh": true }),
    )
    .await;
    let openai_models_1 = r1["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap();
    assert!(openai_models_1.iter().any(|m| m["id"] == "gpt-5.4-mock-v1"));
    assert_eq!(hit_count.load(Ordering::SeqCst), 1);

    let cache_file = iso.home_dir.join(".cowork/cache/models/openai.json");
    assert!(cache_file.is_file());

    // Second read within 24h TTL serves from cache without hitting HTTP
    let r2 = ws_rpc(
        &mut ws,
        "cache-2",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd }),
    )
    .await;
    let openai_models_2 = r2["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap();
    assert!(openai_models_2.iter().any(|m| m["id"] == "gpt-5.4-mock-v1"));
    assert_eq!(hit_count.load(Ordering::SeqCst), 1);

    // Explicit `refresh: true` bypasses the 24h cache and fetches fresh models (`v2`)
    let r3 = ws_rpc(
        &mut ws,
        "cache-3",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd, "refresh": true }),
    )
    .await;
    let openai_models_3 = r3["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap();
    assert!(openai_models_3.iter().any(|m| m["id"] == "gpt-5.4-mock-v2"));
    assert_eq!(hit_count.load(Ordering::SeqCst), 2);

    mock_srv.abort();
    server.shutdown().await;
}

#[tokio::test]
async fn codex_cli_oauth_connectors_and_live_catalog_operate_end_to_end_via_app_server() {
    let mut iso = IsolatedEnv::new();
    iso.env.insert(
        "COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS".into(),
        "1".into(),
    );
    // Start unauthenticated with ZERO `COWORK_OAUTH_*` synthetic env vars
    let codex_log = install_mock_codex_app_server(&mut iso, false);

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();
    let expected_codex_home = iso
        .home_dir
        .join(".cowork/auth/codex-cli")
        .to_string_lossy()
        .into_owned();

    // 1. Before sign-in, `connectors/openai-native/list` spawns CodexAppServerClient with isolated
    //    `CODEX_HOME`, workspace `cwd`, and `ServerRuntimeState.env`, and returns `authenticated: false`
    let pre_list = ws_rpc(
        &mut ws,
        "cx-pre-list",
        "cowork/connectors/openai-native/list",
        json!({ "cwd": cwd }),
    )
    .await;
    assert_eq!(pre_list["result"]["event"]["authenticated"], false);
    assert_eq!(pre_list["result"]["event"]["connectors"], json!([]));

    // 2. `cowork/provider/auth/authorize` (`methodId: "oauth_cli"`) calls `start_codex_chatgpt_login`
    let authz = ws_rpc(
        &mut ws,
        "cx-authz",
        "cowork/provider/auth/authorize",
        json!({ "cwd": cwd, "provider": "codex-cli", "methodId": "oauth_cli" }),
    )
    .await;
    assert_eq!(authz["result"]["event"]["type"], "provider_auth_challenge");
    assert_eq!(authz["result"]["event"]["challenge"]["method"], "auto");
    assert_eq!(
        authz["result"]["event"]["challenge"]["url"],
        "http://127.0.0.1:9/codex-chatgpt-login?state=42"
    );

    // 3. `cowork/provider/auth/callback` awaits `account/login/completed` + verifies `account/read`
    let cb = ws_rpc(
        &mut ws,
        "cx-cb",
        "cowork/provider/auth/callback",
        json!({ "cwd": cwd, "provider": "codex-cli", "methodId": "oauth_cli" }),
    )
    .await;
    assert_eq!(cb["result"]["event"]["ok"], true);
    assert_eq!(cb["result"]["event"]["mode"], "oauth");
    assert!(
        cb["result"]["event"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("chatgpt-user@example.com")
    );
    assert!(
        iso.home_dir
            .join(".cowork/auth/codex-cli/auth.json")
            .is_file(),
        "codex auth must live at ~/.cowork/auth/codex-cli/auth.json"
    );
    assert!(
        !iso.home_dir.join(".cowork/auth/connections.json").is_file(),
        "codex-cli auth must not duplicate into connections.json"
    );

    // 4. `connectors/{list,setEnabled,refresh}` reuse the pooled CodexAppServerClient
    let list_after = ws_rpc(
        &mut ws,
        "cx-list",
        "cowork/connectors/openai-native/list",
        json!({ "cwd": cwd }),
    )
    .await;
    assert_eq!(list_after["result"]["event"]["authenticated"], true);
    assert_eq!(
        list_after["result"]["event"]["enabledConnectorIds"],
        json!(["slack"])
    );

    let spawns_before_toggle = std::fs::read_to_string(&codex_log)
        .unwrap()
        .lines()
        .filter(|l| l.contains("\"event\":\"spawn\""))
        .count();

    let set_gh = ws_rpc(
        &mut ws,
        "cx-set",
        "cowork/connectors/openai-native/setEnabled",
        json!({ "cwd": cwd, "connectorId": "github", "enabled": true }),
    )
    .await;
    assert_eq!(
        set_gh["result"]["event"]["enabledConnectorIds"],
        json!(["github", "slack"])
    );

    let ref_res = ws_rpc(
        &mut ws,
        "cx-ref",
        "cowork/connectors/openai-native/refresh",
        json!({ "cwd": cwd }),
    )
    .await;
    assert_eq!(
        ref_res["result"]["event"]["enabledConnectorIds"],
        json!(["github", "slack"])
    );

    let spawns_after_refresh = std::fs::read_to_string(&codex_log)
        .unwrap()
        .lines()
        .filter(|l| l.contains("\"event\":\"spawn\""))
        .count();
    assert_eq!(
        spawns_before_toggle, spawns_after_refresh,
        "connectors list/setEnabled/refresh must reuse pooled CodexAppServerClient"
    );

    // 5. `cowork/provider/catalog/read` with `refresh: true` queries `model/list` and updates 24h cache
    let cat_res = ws_rpc(
        &mut ws,
        "cx-cat",
        "cowork/provider/catalog/read",
        json!({ "cwd": cwd, "refresh": true }),
    )
    .await;
    let codex_entry = cat_res["result"]["event"]["all"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "codex-cli")
        .unwrap();
    assert!(
        codex_entry["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "gpt-5.4-codex-b1")
    );
    assert!(
        iso.home_dir
            .join(".cowork/cache/models/codex-cli.json")
            .is_file()
    );

    // 6. `cowork/provider/auth/logout` passes active client to `logout_codex_account` (`account/logout`)
    let logout_res = ws_rpc(
        &mut ws,
        "cx-logout",
        "cowork/provider/auth/logout",
        json!({ "cwd": cwd, "provider": "codex-cli" }),
    )
    .await;
    assert_eq!(logout_res["result"]["event"]["ok"], true);
    assert!(
        !iso.home_dir
            .join(".cowork/auth/codex-cli/auth.json")
            .exists(),
        "auth.json must be removed on logout"
    );

    let log_lines: Vec<Value> = std::fs::read_to_string(&codex_log)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect();

    assert!(log_lines.iter().any(|e| {
        e["event"] == "spawn"
            && e["cwd"] == cwd
            && e["codexHome"] == expected_codex_home
            && e["customEnvMarker"] == "isolated-runtime-env"
    }));
    assert!(
        log_lines
            .iter()
            .any(|e| e["event"] == "rpc" && e["method"] == "account/login/start")
    );
    assert!(log_lines.iter().any(|e| {
        e["event"] == "rpc"
            && e["method"] == "app/list"
            && e["params"]["forceRefetch"] == json!(false)
    }));
    assert!(log_lines.iter().any(|e| {
        e["event"] == "rpc"
            && e["method"] == "app/list"
            && e["params"]["forceRefetch"] == json!(true)
    }));
    assert!(log_lines.iter().any(|e| {
        e["event"] == "rpc"
            && e["method"] == "config/value/write"
            && e["params"]["keyPath"] == "apps.github.enabled"
            && e["params"]["value"] == json!(true)
    }));
    assert!(
        log_lines
            .iter()
            .any(|e| e["event"] == "rpc" && e["method"] == "account/logout"),
        "logout must invoke account/logout on active CodexAppServerClient"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn bedrock_server_turn_runner_honors_saved_region_isolated_env_and_nested_options() {
    use axum::extract::Path as AxumPath;
    use axum::http::HeaderMap;
    use cowork_providers::bedrock::encode_eventstream_json_frame;

    let captured_bdrk: Arc<Mutex<Vec<(String, String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let cap_clone = captured_bdrk.clone();

    let mut stream_bytes = Vec::new();
    stream_bytes.extend_from_slice(
        &encode_eventstream_json_frame("messageStart", &json!({ "role": "assistant" })).unwrap(),
    );
    stream_bytes.extend_from_slice(
        &encode_eventstream_json_frame(
            "contentBlockDelta",
            &json!({ "contentBlockIndex": 0, "delta": { "text": "Bedrock reply ok" } }),
        )
        .unwrap(),
    );
    stream_bytes.extend_from_slice(
        &encode_eventstream_json_frame("contentBlockStop", &json!({ "contentBlockIndex": 0 }))
            .unwrap(),
    );
    stream_bytes.extend_from_slice(
        &encode_eventstream_json_frame("messageStop", &json!({ "stopReason": "end_turn" }))
            .unwrap(),
    );
    stream_bytes.extend_from_slice(
        &encode_eventstream_json_frame(
            "metadata",
            &json!({ "usage": { "inputTokens": 12, "outputTokens": 4, "totalTokens": 16 } }),
        )
        .unwrap(),
    );

    let bdrk_app = Router::new().route(
        "/model/{model_id}/converse-stream",
        post(
            move |AxumPath(model_id): AxumPath<String>, headers: HeaderMap, body: String| {
                let cap = cap_clone.clone();
                let bytes = stream_bytes.clone();
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    cap.lock().unwrap().push((model_id, auth, parsed));
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/vnd.amazon.eventstream")
                        .body(Body::from(bytes))
                        .unwrap()
                }
            },
        ),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bdrk_port = listener.local_addr().unwrap().port();
    let bdrk_srv = tokio::spawn(async move {
        let _ = axum::serve(listener, bdrk_app).await;
    });

    let mut iso = IsolatedEnv::new();
    iso.env.insert(
        "AWS_BEDROCK_ENDPOINT_URL".into(),
        format!("http://127.0.0.1:{bdrk_port}"),
    );

    // Populate isolated `<homedir>/.aws/{credentials,config}` for `aws_profile` testing
    std::fs::create_dir_all(iso.home_dir.join(".aws")).unwrap();
    std::fs::write(
        iso.home_dir.join(".aws/credentials"),
        "[srv-prof]\naws_access_key_id = AKIAIOSFODNN7SRVPROF\naws_secret_access_key = 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\n",
    )
    .unwrap();
    std::fs::write(
        iso.home_dir.join(".aws/config"),
        "[profile srv-prof]\nregion = ap-northeast-1\n",
    )
    .unwrap();

    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // Helper closure to run a turn and collect terminal status
    async fn run_turn_and_wait(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        req_id: &str,
        thread_id: &str,
        prompt: &str,
    ) -> (String, String) {
        ws.send(WsMessage::Text(
            json!({
                "id": req_id,
                "method": "turn/start",
                "params": { "threadId": thread_id, "input": prompt }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let mut got_resp = false;
        let mut status = None;
        let mut text = String::new();
        while !got_resp || status.is_none() {
            let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("turn ws timeout")
                .expect("ws open")
                .expect("ws frame");
            let WsMessage::Text(raw) = msg else { continue };
            let val: Value = serde_json::from_str(&raw).unwrap();
            if val.get("id").and_then(Value::as_str) == Some(req_id) {
                got_resp = true;
                continue;
            }
            if val.get("method").and_then(Value::as_str) == Some("item/agentMessage/delta")
                && let Some(d) = val["params"]["delta"].as_str()
            {
                text.push_str(d);
            }
            if val.get("method").and_then(Value::as_str) == Some("turn/completed") {
                status = val["params"]["turn"]["status"]
                    .as_str()
                    .map(ToOwned::to_owned);
            }
        }
        (status.unwrap(), text)
    }

    // 1. Unconfigured Bedrock under isolated homedir/env fails cleanly (0 mock hits, no ambient OS leak)
    let thr_unauth = ws_rpc(
        &mut ws,
        "b-thr-0",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "model": "us.anthropic.claude-sonnet-4-6"
        }),
    )
    .await["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (st_unauth, _) = run_turn_and_wait(&mut ws, "b-turn-0", &thr_unauth, "Hello").await;
    assert_eq!(st_unauth, "failed");
    assert_eq!(captured_bdrk.lock().unwrap().len(), 0);

    // 2. Save Bedrock Bearer `api_key` (`methodId: "api_key"`, `region: "eu-west-1"`) via `setConfig`
    let set_bearer = ws_rpc(
        &mut ws,
        "b-cfg-bearer",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "methodId": "api_key",
            "values": {
                "apiKey": "ABSK-server-saved-bearer-token",
                "region": "eu-west-1"
            }
        }),
    )
    .await;
    assert_eq!(set_bearer["result"]["event"]["ok"], true);

    let thr_bearer = ws_rpc(
        &mut ws,
        "b-thr-1",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "model": "us.anthropic.claude-sonnet-4-6"
        }),
    )
    .await["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Configure nested `providerOptions.bedrock` (`maxTokens`, `reasoningEffort`) + top-level `temperature` fallback
    let cfg1 = ws_rpc(
        &mut ws,
        "b-sess-cfg-1",
        "cowork/session/config/set",
        json!({
            "threadId": thr_bearer,
            "config": {
                "providerOptions": {
                    "temperature": 0.4,
                    "maxTokens": 999,
                    "bedrock": {
                        "maxTokens": 4096,
                        "reasoningEffort": "high"
                    }
                }
            }
        }),
    )
    .await;
    assert!(
        cfg1.get("error").is_none(),
        "session/config/set failed: {cfg1}"
    );

    let (st_bearer, txt_bearer) =
        run_turn_and_wait(&mut ws, "b-turn-1", &thr_bearer, "Hi Bearer").await;
    assert_eq!(st_bearer, "completed");
    assert_eq!(txt_bearer, "Bedrock reply ok");

    // 3. Save Bedrock `aws_profile` (`srv-prof` in isolated `<homedir>/.aws`, `region = ap-northeast-1`),
    //    then verify both profile region and nested `providerOptions.bedrock.region` override
    let set_prof = ws_rpc(
        &mut ws,
        "b-cfg-prof",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "methodId": "aws_profile",
            "values": { "profile": "srv-prof" }
        }),
    )
    .await;
    assert_eq!(set_prof["result"]["event"]["ok"], true);

    let thr_prof = ws_rpc(
        &mut ws,
        "b-thr-2",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "model": "amazon.nova-lite-v1:0"
        }),
    )
    .await["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (st_prof_1, _) = run_turn_and_wait(&mut ws, "b-turn-2", &thr_prof, "Profile turn 1").await;
    assert_eq!(st_prof_1, "completed");

    // Override region via nested `providerOptions.bedrock.region`
    let cfg2 = ws_rpc(
        &mut ws,
        "b-sess-cfg-2",
        "cowork/session/config/set",
        json!({
            "threadId": thr_prof,
            "config": {
                "providerOptions": {
                    "bedrock": {
                        "region": "eu-central-1",
                        "maxTokens": 2222
                    }
                }
            }
        }),
    )
    .await;
    assert!(
        cfg2.get("error").is_none(),
        "session/config/set failed: {cfg2}"
    );

    let (st_prof_2, _) = run_turn_and_wait(&mut ws, "b-turn-3", &thr_prof, "Profile turn 2").await;
    assert_eq!(st_prof_2, "completed");

    // 4. Save Bedrock SigV4 `aws_keys` (`region: "sa-east-1"`) via `setConfig` and verify signing region
    let set_keys = ws_rpc(
        &mut ws,
        "b-cfg-keys",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "methodId": "aws_keys",
            "values": {
                "accessKeyId": "AKIAIOSFODNN7SIGV4KY",
                "secretAccessKey": "sigv4-synthetic-secret-key-0123456789abcd",
                "region": "sa-east-1"
            }
        }),
    )
    .await;
    assert_eq!(set_keys["result"]["event"]["ok"], true);

    let thr_keys = ws_rpc(
        &mut ws,
        "b-thr-3",
        "thread/start",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "model": "amazon.nova-lite-v1:0"
        }),
    )
    .await["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (st_keys, _) = run_turn_and_wait(&mut ws, "b-turn-4", &thr_keys, "Keys turn").await;
    assert_eq!(st_keys, "completed");

    bdrk_srv.abort();
    server.shutdown().await;

    let seen = captured_bdrk.lock().unwrap();
    assert_eq!(seen.len(), 4);

    // Request 0: Bearer token + nested `providerOptions.bedrock.{maxTokens, reasoningEffort}` + top-level `temperature`
    assert_eq!(seen[0].1, "Bearer ABSK-server-saved-bearer-token");
    assert_eq!(seen[0].2["inferenceConfig"]["maxTokens"], json!(4096));
    assert_eq!(seen[0].2["inferenceConfig"]["temperature"], json!(0.4));
    assert_eq!(
        seen[0].2["additionalModelRequestFields"]["output_config"]["effort"],
        json!("high")
    );

    // Request 1: Isolated `~/.aws` profile `srv-prof` SigV4 signed with `ap-northeast-1`
    assert!(
        seen[1].1.contains("/ap-northeast-1/bedrock/aws4_request"),
        "expected ap-northeast-1 SigV4 credential scope, got: {}",
        seen[1].1
    );

    // Request 2: Nested `providerOptions.bedrock.region = eu-central-1` overrides SigV4 signing region
    assert!(
        seen[2].1.contains("/eu-central-1/bedrock/aws4_request"),
        "expected eu-central-1 SigV4 credential scope, got: {}",
        seen[2].1
    );
    assert_eq!(seen[2].2["inferenceConfig"]["maxTokens"], json!(2222));

    // Request 3: Saved `connections.json` SigV4 `aws_keys` signed with `sa-east-1`
    assert!(
        seen[3].1.contains("/sa-east-1/bedrock/aws4_request"),
        "expected sa-east-1 SigV4 credential scope, got: {}",
        seen[3].1
    );
}
