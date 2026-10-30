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

    let conn_set = ws_rpc(
        &mut ws,
        "c2",
        "cowork/connectors/openai-native/setEnabled",
        json!({ "cwd": cwd, "connectorId": "github", "enabled": true }),
    )
    .await;
    assert_eq!(
        conn_set["result"]["event"]["enabledConnectorIds"],
        json!(["github"])
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
        json!(["github"])
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
                            "data: {\"id\":\"chatcmpl-mock-1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_mock_read_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"\"}}]}}]}\n\n",
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
    assert_eq!(final_agent_text, expected_token);

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
                "input": "Call the `read_file` tool with `{\"path\": \"token.txt\"}` and reply with ONLY the exact 16-character hexadecimal string inside that file."
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
