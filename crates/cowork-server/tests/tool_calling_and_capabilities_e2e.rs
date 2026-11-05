use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

struct IsolatedEnv {
    base_dir: PathBuf,
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedEnv {
    fn new(openai_base_url: &str, openai_api_key: &str) -> Self {
        let id = Uuid::new_v4();
        let base_dir = test_temp_base().join(format!("cowork-tc-e2e-{id}"));
        let home_dir = base_dir.join("home");
        let userdata_dir = base_dir.join("userdata");
        let workspace_dir = base_dir.join("workspace");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::create_dir_all(&userdata_dir).unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::write(workspace_dir.join("hello.txt"), "hello world\n").unwrap();

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
        env.insert("COWORK_DISABLE_BROWSER_OPEN".into(), "1".into());
        env.insert("OPENAI_BASE_URL".into(), openai_base_url.into());
        env.insert("OPENAI_API_KEY".into(), openai_api_key.into());

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
            yolo: true,
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

type ProbeAuthLog = Arc<Mutex<Vec<(String, Option<String>)>>>;

#[derive(Clone, Default)]
struct MockOpenAiEndpointState {
    probe_auth_headers: ProbeAuthLog,
    response_payloads: Arc<Mutex<Vec<Value>>>,
    sse_replies: Arc<Mutex<Vec<String>>>,
}

async fn handle_model_probe(
    State(state): State<MockOpenAiEndpointState>,
    AxumPath(model_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    state
        .probe_auth_headers
        .lock()
        .unwrap()
        .push((model_id.clone(), auth));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header("openai-processing-ms", "5")
        .body(Body::from(
            json!({
                "id": model_id,
                "object": "model",
                "owned_by": "openai",
                "capabilities": {
                    "tool_search": true,
                    "programmatic_tool_calling": true
                }
            })
            .to_string(),
        ))
        .unwrap()
}

async fn handle_responses(
    State(state): State<MockOpenAiEndpointState>,
    Json(payload): Json<Value>,
) -> Response {
    if payload.get("model") != Some(&json!("gpt-5.4")) {
        let aux_sse = [
            sse_frame(json!({
                "type": "response.created",
                "response": { "id": "resp_aux", "status": "in_progress" }
            })),
            sse_frame(json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "id": "msg_aux", "type": "message", "content": [] }
            })),
            sse_frame(json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "msg_aux",
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "[]" }]
                }
            })),
            sse_frame(json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_aux",
                    "status": "completed",
                    "usage": { "input_tokens": 10, "output_tokens": 2, "total_tokens": 12 }
                }
            })),
        ]
        .concat();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(aux_sse))
            .unwrap()
            .into_response();
    }

    state.response_payloads.lock().unwrap().push(payload);
    let sse = state.sse_replies.lock().unwrap().remove(0);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(sse))
        .unwrap()
        .into_response()
}

async fn spawn_mock_endpoint(sse_replies: Vec<String>) -> (String, MockOpenAiEndpointState) {
    let state = MockOpenAiEndpointState {
        probe_auth_headers: Arc::new(Mutex::new(Vec::new())),
        response_payloads: Arc::new(Mutex::new(Vec::new())),
        sse_replies: Arc::new(Mutex::new(sse_replies)),
    };
    let app = Router::new()
        .route("/v1/models/{model_id}", get(handle_model_probe))
        .route("/v1/responses", post(handle_responses))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/v1"), state)
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
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "tc-e2e", "version": "1.0.0" },
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
        json!({ "method": "initialized", "params": {} })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    ws
}

async fn send_rpc(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();

    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = ws.next().await {
            let WsMessage::Text(raw) = msg.unwrap() else {
                continue;
            };
            let val: Value = serde_json::from_str(&raw).unwrap();
            if val.get("id") == Some(&json!(id)) {
                return val;
            }
        }
        panic!("ws closed waiting for {id}");
    })
    .await
    .expect("rpc timeout")
}

async fn wait_for_turn_completed(ws: &mut WsStream, turn_id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(msg) = ws.next().await {
            let WsMessage::Text(raw) = msg.unwrap() else {
                continue;
            };
            let val: Value = serde_json::from_str(&raw).unwrap();
            if val.get("method") == Some(&json!("turn/completed"))
                && val["params"]["turn"]["id"] == json!(turn_id)
            {
                return val;
            }
        }
        panic!("ws closed waiting for turn/completed {turn_id}");
    })
    .await
    .expect("turn/completed timeout")
}

fn sse_frame(data: Value) -> String {
    format!("data: {data}\n\n")
}

#[tokio::test]
async fn server_e2e_capabilities_check_security_config_persistence_native_ptc_turn_and_tools_none()
{
    let turn1_step1_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": { "id": "resp_e2e_1", "status": "in_progress" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "prog_e2e_1", "type": "program", "code": "await glob({ pattern: '*.txt' });" }
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": { "id": "prog_e2e_1", "type": "program", "code": "await glob({ pattern: '*.txt' });" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {
                "id": "fc_e2e_1",
                "call_id": "call_glob_e2e_1",
                "type": "function_call",
                "name": "glob",
                "caller": { "type": "programmatic", "program_id": "prog_e2e_1" },
                "arguments": ""
            }
        })),
        sse_frame(json!({
            "type": "response.function_call_arguments.done",
            "output_index": 1,
            "item_id": "fc_e2e_1",
            "arguments": "{\"pattern\":\"*.txt\"}"
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": {
                "id": "fc_e2e_1",
                "call_id": "call_glob_e2e_1",
                "type": "function_call",
                "name": "glob",
                "caller": { "type": "programmatic", "program_id": "prog_e2e_1" },
                "arguments": "{\"pattern\":\"*.txt\"}"
            }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_e2e_1",
                "status": "completed",
                "usage": { "input_tokens": 50, "output_tokens": 20, "total_tokens": 70 }
            }
        })),
    ]
    .concat();

    let turn1_step2_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": { "id": "resp_e2e_2", "status": "in_progress" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "msg_e2e_2", "type": "message", "content": [] }
        })),
        sse_frame(json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "item_id": "msg_e2e_2",
            "delta": "Found hello.txt via native PTC."
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_e2e_2",
                "type": "message",
                "content": [{ "type": "output_text", "text": "Found hello.txt via native PTC." }]
            }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_e2e_2",
                "status": "completed",
                "usage": { "input_tokens": 60, "output_tokens": 10, "total_tokens": 70 }
            }
        })),
    ]
    .concat();

    let turn2_repair_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": { "id": "resp_e2e_3", "status": "in_progress" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "msg_e2e_3", "type": "message", "content": [] }
        })),
        sse_frame(json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "item_id": "msg_e2e_3",
            "delta": "Repair complete with zero tools."
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_e2e_3",
                "type": "message",
                "content": [{ "type": "output_text", "text": "Repair complete with zero tools." }]
            }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_e2e_3",
                "status": "completed",
                "usage": { "input_tokens": 40, "output_tokens": 8, "total_tokens": 48 }
            }
        })),
    ]
    .concat();

    let (configured_base_url, configured_state) =
        spawn_mock_endpoint(vec![turn1_step1_sse, turn1_step2_sse, turn2_repair_sse]).await;
    let (untrusted_override_url, untrusted_state) = spawn_mock_endpoint(Vec::new()).await;

    let iso = IsolatedEnv::new(&configured_base_url, "sk-secret-configured-key");
    let server = start_server(iso.server_options()).await.unwrap();
    let ws_url = format!("ws://127.0.0.1:{}/ws", server.port());
    let mut ws = connect_initialized_ws(&ws_url).await;
    let cwd = iso.workspace_dir.to_string_lossy().into_owned();

    // 1. Apply provider/model + toolCalling via `cowork/session/defaults/apply` and verify readback.
    let apply_resp = send_rpc(
        &mut ws,
        "apply-1",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "model": "gpt-5.4",
            "config": {
                "toolCalling": {
                    "codeMode": true,
                    "deferredToolSearch": true,
                    "strategy": "auto"
                }
            }
        }),
    )
    .await;
    assert!(
        apply_resp.get("error").is_none(),
        "apply-1 failed: {apply_resp}"
    );
    assert_eq!(
        apply_resp["result"]["event"]["config"]["toolCalling"],
        json!({
            "codeMode": true,
            "deferredToolSearch": true,
            "strategy": "auto"
        })
    );

    // 2. Check configured endpoint capabilities -> sends configured API key and discovers native OpenAI capabilities!
    let cap_resp = send_rpc(
        &mut ws,
        "cap-configured",
        "cowork/provider/capabilities/check",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "model": "gpt-5.4",
            "refresh": true
        }),
    )
    .await;
    assert!(
        cap_resp.get("error").is_none(),
        "cap-configured failed: {cap_resp}"
    );
    assert_eq!(
        cap_resp["result"]["capabilities"]["source"],
        json!("endpointCheck")
    );
    assert_eq!(
        cap_resp["result"]["capabilities"]["nativeToolSearch"],
        json!("openAiResponses")
    );
    assert_eq!(
        cap_resp["result"]["capabilities"]["nativeProgrammaticToolCalling"],
        json!("openAiResponses")
    );
    {
        let probes = configured_state.probe_auth_headers.lock().unwrap();
        assert_eq!(probes.len(), 1);
        assert_eq!(
            probes[0].1.as_deref(),
            Some("Bearer sk-secret-configured-key"),
            "configured baseUrl probe should authenticate with configured API key"
        );
    }

    // 3. SECURITY BOUNDARY: Client-supplied `baseUrl` override MUST NOT receive saved API keys!
    let untrusted_resp = send_rpc(
        &mut ws,
        "cap-untrusted",
        "cowork/provider/capabilities/check",
        json!({
            "cwd": cwd,
            "provider": "openai",
            "model": "gpt-5.4",
            "baseUrl": untrusted_override_url,
            "refresh": true
        }),
    )
    .await;
    assert!(
        untrusted_resp.get("error").is_none(),
        "cap-untrusted failed: {untrusted_resp}"
    );
    {
        let untrusted_probes = untrusted_state.probe_auth_headers.lock().unwrap();
        assert!(
            untrusted_probes.is_empty(),
            "unconfigured baseUrl override must never receive saved API keys or make authenticated probe"
        );
    }

    // 4. Start a thread and run a live native PTC + tool-search turn end-to-end!
    let thread_resp = send_rpc(&mut ws, "thr-start", "thread/start", json!({ "cwd": cwd })).await;
    let thread_id = thread_resp["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_string();

    let turn1_resp = send_rpc(
        &mut ws,
        "turn-1",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": "List txt files" }]
        }),
    )
    .await;
    let turn1_id = turn1_resp["result"]["turn"]["id"]
        .as_str()
        .expect("turn 1 id")
        .to_string();
    let turn1_done = wait_for_turn_completed(&mut ws, &turn1_id).await;
    assert_eq!(turn1_done["params"]["turn"]["status"], json!("completed"));

    {
        let payloads = configured_state.response_payloads.lock().unwrap();
        assert_eq!(payloads.len(), 2, "expected 2 model steps in turn 1");
        let step1_tools = payloads[0]["tools"].as_array().expect("step 1 tools");
        // Native server tools emitted, and harness `codeMode` / `toolSearch` omitted!
        assert!(
            step1_tools
                .iter()
                .any(|t| t == &json!({ "type": "tool_search" }))
        );
        assert!(
            step1_tools
                .iter()
                .any(|t| t == &json!({ "type": "programmatic_tool_calling" }))
        );
        assert!(
            !step1_tools
                .iter()
                .any(|t| t.get("name") == Some(&json!("codeMode")))
        );
        assert!(
            !step1_tools
                .iter()
                .any(|t| t.get("name") == Some(&json!("toolSearch")))
        );

        // Step 2 echoed `caller` on `function_call_output`!
        let step2_input = payloads[1]["input"].as_array().expect("step 2 input");
        let fco = step2_input
            .iter()
            .find(|i| i.get("type") == Some(&json!("function_call_output")))
            .expect("step 2 function_call_output");
        assert_eq!(
            fco.get("caller"),
            Some(&json!({ "type": "programmatic", "program_id": "prog_e2e_1" }))
        );
    }

    // 5. Run a repair turn with `tools: "none"` on the SAME thread -> zero tools sent on the wire!
    let turn2_resp = send_rpc(
        &mut ws,
        "turn-2",
        "turn/start",
        json!({
            "threadId": thread_id,
            "tools": "none",
            "input": [{ "type": "text", "text": "Repair output JSON without tools" }]
        }),
    )
    .await;
    let turn2_id = turn2_resp["result"]["turn"]["id"]
        .as_str()
        .expect("turn 2 id")
        .to_string();
    let turn2_done = wait_for_turn_completed(&mut ws, &turn2_id).await;
    assert_eq!(turn2_done["params"]["turn"]["status"], json!("completed"));
    {
        let payloads = configured_state.response_payloads.lock().unwrap();
        assert_eq!(payloads.len(), 3);
        assert!(
            payloads[2].get("tools").is_none(),
            "turn/start tools:'none' must omit all native and custom tools"
        );
    }

    // 6. Test `clearToolCalling: true` resets `toolCalling` back to defaults.
    let clear_resp = send_rpc(
        &mut ws,
        "apply-clear",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "config": {
                "clearToolCalling": true
            }
        }),
    )
    .await;
    assert!(
        clear_resp.get("error").is_none(),
        "apply-clear failed: {clear_resp}"
    );
    assert_eq!(
        clear_resp["result"]["event"]["config"]["toolCalling"],
        json!({
            "codeMode": false,
            "deferredToolSearch": false,
            "strategy": "auto"
        })
    );

    server.shutdown().await;
}
