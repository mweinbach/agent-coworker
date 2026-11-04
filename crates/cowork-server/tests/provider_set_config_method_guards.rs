//! Regression coverage for `cowork/provider/auth/setConfig` method guards (TS
//! `setProviderConfig` parity): OAuth methods and methods without structured fields must be
//! rejected before anything is written, so a rejected request can never replace a working
//! saved API-key connection with an empty `credentials` entry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
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
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let base_dir = base.join(format!("cowork-set-config-guards-{}", Uuid::new_v4()));
        let home_dir = base_dir.join("home");
        let userdata_dir = base_dir.join("userdata");
        let workspace_dir = base_dir.join("workspace");
        for dir in [&home_dir, &userdata_dir, &workspace_dir] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let home_dir = std::fs::canonicalize(&home_dir).unwrap();
        let userdata_dir = std::fs::canonicalize(&userdata_dir).unwrap();
        let workspace_dir = std::fs::canonicalize(&workspace_dir).unwrap();

        let home = home_dir.to_string_lossy().into_owned();
        let userdata = userdata_dir.to_string_lossy().into_owned();
        let mut env = HashMap::new();
        env.insert("HOME".into(), home.clone());
        env.insert("COWORK_HOME_OVERRIDE".into(), home);
        env.insert("COWORK_ELECTRON_USER_DATA_DIR".into(), userdata.clone());
        env.insert("COWORK_DESKTOP_USER_DATA_DIR".into(), userdata);
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("COWORK_DISABLE_BROWSER_OPEN".into(), "1".into());
        // Keep every discovery/status path on an unused loopback port.
        env.insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
        env.insert("OPENAI_BASE_URL".into(), "http://127.0.0.1:9/v1".into());
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

    fn read_connections(&self) -> Value {
        let raw = std::fs::read_to_string(self.home_dir.join(".cowork/auth/connections.json"))
            .expect("connections.json readable");
        serde_json::from_str(&raw).expect("connections.json is JSON")
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
    let init = ws_rpc(
        &mut ws,
        "init-1",
        "initialize",
        json!({
            "clientInfo": { "name": "set-config-guards-test", "version": "1.0.0" },
            "capabilities": { "experimentalApi": true }
        }),
    )
    .await;
    assert!(init.get("result").is_some(), "initialize failed: {init}");
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
        json!({ "id": id, "method": method, "params": params })
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
            if val.get("id").and_then(Value::as_str) == Some(id) {
                return val;
            }
        }
    }
}

fn assert_openai_api_key_intact(connections: &Value, expected_key: &str) {
    let openai = &connections["services"]["openai"];
    assert_eq!(openai["mode"], "api_key", "openai entry: {openai}");
    assert_eq!(openai["apiKey"], expected_key, "openai entry: {openai}");
    assert!(
        openai.get("values").is_none(),
        "openai entry must not gain structured values: {openai}"
    );
}

#[tokio::test]
async fn set_config_rejects_unstructured_and_oauth_methods_without_touching_saved_credentials() {
    let iso = IsolatedEnv::new();
    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_initialized_ws(server.ws_url()).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();
    let openai_key = "sk-proj-working-key-1234";

    // Seed a working saved API-key connection.
    let seeded = ws_rpc(
        &mut ws,
        "seed",
        "cowork/provider/auth/setApiKey",
        json!({ "cwd": cwd, "provider": "openai", "methodId": "api_key", "apiKey": openai_key }),
    )
    .await;
    assert_eq!(seeded["result"]["event"]["ok"], true, "{seeded}");
    let before = iso.read_connections();
    assert_openai_api_key_intact(&before, openai_key);

    // 1. Plain API-key method (no structured fields) must be rejected by setConfig.
    let unstructured = ws_rpc(
        &mut ws,
        "unstructured",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "methodId": "api_key",
            "values": { "apiKey": "sk-proj-replacement-5678" }
        }),
    )
    .await;
    let event = &unstructured["result"]["event"];
    assert_eq!(event["type"], "provider_auth_result", "{unstructured}");
    assert_eq!(event["ok"], false, "{unstructured}");
    assert_eq!(event["provider"], "openai");
    assert_eq!(event["methodId"], "api_key");
    assert_eq!(
        event["message"],
        "Method \"api_key\" does not define structured fields."
    );
    assert!(event.get("mode").is_none(), "{unstructured}");

    // 2. OAuth method must be rejected by setConfig.
    let oauth = ws_rpc(
        &mut ws,
        "oauth",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "codex-cli",
            "methodId": "oauth_cli",
            "values": { "token": "abc" }
        }),
    )
    .await;
    let event = &oauth["result"]["event"];
    assert_eq!(event["ok"], false, "{oauth}");
    assert_eq!(event["provider"], "codex-cli");
    assert_eq!(
        event["message"],
        "Method \"oauth_cli\" is not a credential method."
    );

    // 3. Unknown method keeps its existing rejection.
    let unknown = ws_rpc(
        &mut ws,
        "unknown",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "methodId": "bogus",
            "values": { "apiKey": "x" }
        }),
    )
    .await;
    assert_eq!(unknown["result"]["event"]["ok"], false, "{unknown}");
    assert_eq!(
        unknown["result"]["event"]["message"],
        "Unsupported auth method \"bogus\"."
    );

    // Nothing was written by any rejected request.
    let after_rejections = iso.read_connections();
    assert_eq!(
        after_rejections["services"], before["services"],
        "rejected setConfig calls must not modify saved connections"
    );
    assert!(after_rejections["services"].get("codex-cli").is_none());

    // 4. A genuinely structured method still saves.
    let bedrock = ws_rpc(
        &mut ws,
        "bedrock",
        "cowork/provider/auth/setConfig",
        json!({
            "cwd": cwd,
            "provider": "bedrock",
            "methodId": "aws_profile",
            "values": { "profile": "dev", "region": "us-west-2" }
        }),
    )
    .await;
    let event = &bedrock["result"]["event"];
    assert_eq!(event["ok"], true, "{bedrock}");
    assert_eq!(event["mode"], "credentials");
    let after_save = iso.read_connections();
    let bedrock_entry = &after_save["services"]["bedrock"];
    assert_eq!(bedrock_entry["mode"], "credentials");
    assert_eq!(bedrock_entry["methodId"], "aws_profile");
    assert_eq!(bedrock_entry["values"]["profile"], "dev");
    assert_eq!(bedrock_entry["values"]["region"], "us-west-2");
    assert_openai_api_key_intact(&after_save, openai_key);

    // The saved OpenAI key still authenticates from the provider's point of view.
    let status = ws_rpc(
        &mut ws,
        "status",
        "cowork/provider/status/refresh",
        json!({ "cwd": cwd }),
    )
    .await;
    let providers = status["result"]["event"]["providers"]
        .as_array()
        .unwrap_or_else(|| panic!("status providers missing: {status}"));
    let openai_status = providers
        .iter()
        .find(|p| p["provider"] == "openai")
        .expect("openai status entry");
    assert_eq!(openai_status["authorized"], true, "{openai_status}");
    assert_eq!(openai_status["mode"], "api_key", "{openai_status}");
}
