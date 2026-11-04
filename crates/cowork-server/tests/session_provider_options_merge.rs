//! `cowork/session/config/set` (and `cowork/session/defaults/apply` with a `threadId`) merge a
//! partial `providerOptions` patch into the thread's stored override, as the TypeScript
//! `SessionMetadataManager` did through `mergeEditableOpenAiCompatibleProviderOptions`.
//!
//! `/reasoning high` followed by `/verbosity low` sends two partial `providerOptions.openai`
//! patches; the second must not discard the first. TS merge semantics:
//! - each provider section is merged key by key over the stored section;
//! - Google `thinkingConfig` merges into the stored `thinkingConfig`, and an explicit
//!   `thinkingConfig: {}` clears only `thinkingLevel`;
//! - Codex `webSearch` merges into the stored `webSearch`, its `location` merges field by
//!   field, and an explicit `location: {}` clears the stored location;
//! - `null`, invalid enum values and non-editable keys are ignored (the stored value is kept),
//!   and a `providerOptions: null` patch leaves the override untouched.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const THREAD_MODEL: &str = "gpt-5.4";

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new(prefix: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(std::env::temp_dir())
            .unwrap();
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
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        Self {
            _root: root,
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
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

/// Every Responses request body a mock OpenAI listener receives.
#[derive(Clone, Default)]
struct Recorder {
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Recorder {
    fn thread_turns(&self) -> Vec<Value> {
        self.bodies
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b["model"] == THREAD_MODEL)
            .cloned()
            .collect()
    }
}

fn sse_event(event_type: &str, data: Value) -> String {
    format!("event: {event_type}\ndata: {data}\n\n")
}

fn text_sse(resp_id: &str, text: &str) -> String {
    [
        sse_event(
            "response.created",
            json!({ "type": "response.created", "response": { "id": resp_id } }),
        ),
        sse_event(
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "id": "msg_0", "type": "message", "role": "assistant", "status": "in_progress", "content": [] }
            }),
        ),
        sse_event(
            "response.output_text.delta",
            json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_0", "delta": text }),
        ),
        sse_event(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "msg_0", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{ "type": "output_text", "text": text, "annotations": [] }]
                }
            }),
        ),
        sse_event(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "id": resp_id,
                    "status": "completed",
                    "output": [],
                    "usage": { "input_tokens": 18, "output_tokens": 9 }
                }
            }),
        ),
    ]
    .concat()
}

async fn responses_handler(
    State(rec): State<Recorder>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    rec.bodies.lock().unwrap().push(parsed);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(text_sse("resp_1", "Answer.")))
        .unwrap()
        .into_response()
}

/// Starts a mock OpenAI Responses listener and points the environment-tier OpenAI endpoint at it.
async fn start_mock(iso: &mut Iso) -> Recorder {
    let rec = Recorder::default();
    let app = Router::new()
        .route("/v1/responses", post(responses_handler))
        .with_state(rec.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    iso.env.insert("OPENAI_API_KEY".into(), "test-key".into());
    iso.env.insert(
        "OPENAI_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    rec
}

async fn connect(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "provider-options-merge-tests", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
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

async fn next_json(ws: &mut WsStream) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).unwrap();
        }
    }
}

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let val = next_json(ws).await;
        if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
            return val;
        }
    }
}

async fn start_thread(ws: &mut WsStream, iso: &Iso) -> String {
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let started = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "openai", "model": THREAD_MODEL }),
    )
    .await;
    started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned()
}

/// Sends `cowork/session/config/set { providerOptions }` and returns the event's options.
async fn set_provider_options(
    ws: &mut WsStream,
    thread_id: &str,
    provider_options: Value,
) -> Value {
    let res = call(
        ws,
        "cfg",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "providerOptions": provider_options } }),
    )
    .await;
    assert!(res.get("error").is_none(), "config/set failed: {res}");
    res["result"]["event"]["config"]["providerOptions"].clone()
}

async fn run_turn(ws: &mut WsStream, thread_id: &str, id: &str) -> String {
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "hello" }] }),
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    loop {
        let val = next_json(ws).await;
        if val["method"] == "turn/completed" {
            return val["params"]["turn"]["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
    }
}

fn stored_provider_options(server: &ServerHandle, thread_id: &str) -> Option<Value> {
    let live = server.runtime().load_thread(thread_id).unwrap();
    let live = live.lock();
    live.config_overrides.get("providerOptions").cloned()
}

fn seed_provider_options(server: &ServerHandle, thread_id: &str, value: Value) {
    let live = server.runtime().load_thread(thread_id).unwrap();
    live.lock()
        .config_overrides
        .insert("providerOptions".to_owned(), value);
}

#[tokio::test]
async fn sequential_openai_patches_merge_and_reach_the_next_turn() {
    let mut iso = Iso::new("cowork-provider-options-merge-openai-");
    let rec = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    // `/reasoning high`, then `/verbosity low`.
    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "openai": { "reasoningEffort": "high" } }),
    )
    .await;
    let event_po = set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "openai": { "textVerbosity": "low" } }),
    )
    .await;
    let expected = json!({ "openai": { "reasoningEffort": "high", "textVerbosity": "low" } });
    assert_eq!(event_po, expected);
    assert_eq!(stored_provider_options(&server, &thread_id), Some(expected));

    assert_eq!(run_turn(&mut ws, &thread_id, "turn-1").await, "completed");
    let turns = rec.thread_turns();
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0]["reasoning"]["effort"], "high", "{}", turns[0]);
    assert_eq!(turns[0]["text"]["verbosity"], "low", "{}", turns[0]);
}

#[tokio::test]
async fn null_invalid_and_non_editable_patch_values_keep_the_stored_override() {
    let iso = Iso::new("cowork-provider-options-merge-null-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    set_provider_options(
        &mut ws,
        &thread_id,
        json!({
            "openai": { "reasoningEffort": "high", "textVerbosity": "low" },
            "codeMode": true
        }),
    )
    .await;
    let expected = json!({
        "openai": { "reasoningEffort": "high", "textVerbosity": "low" },
        "codeMode": true
    });

    // TS ignores `null`, unknown enum values, non-editable keys and a null patch.
    for patch in [
        json!({ "openai": { "reasoningEffort": null } }),
        json!({ "openai": { "textVerbosity": "loud", "baseUrl": "http://127.0.0.1:9/v1" } }),
        json!({ "openai": null }),
        Value::Null,
    ] {
        set_provider_options(&mut ws, &thread_id, patch.clone()).await;
        assert_eq!(
            stored_provider_options(&server, &thread_id),
            Some(expected.clone()),
            "patch {patch} must not change the stored override"
        );
    }

    // A valid value replaces only its own key; siblings and tool toggles survive.
    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "openai": { "reasoningEffort": "low" }, "lmstudio": { "autoLoad": true } }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "openai": { "reasoningEffort": "low", "textVerbosity": "low" },
            "lmstudio": { "autoLoad": true },
            "codeMode": true
        }))
    );
}

#[tokio::test]
async fn google_thinking_config_merges_nested_and_empty_object_clears_level() {
    let iso = Iso::new("cowork-provider-options-merge-google-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    // A stored nested sibling (e.g. persisted from an earlier session) must survive.
    seed_provider_options(
        &server,
        &thread_id,
        json!({
            "google": {
                "nativeWebSearch": false,
                "thinkingConfig": { "includeThoughts": true, "thinkingLevel": "low" }
            }
        }),
    );

    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "google": { "thinkingConfig": { "thinkingLevel": "high" } } }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "google": {
                "nativeWebSearch": false,
                "thinkingConfig": { "includeThoughts": true, "thinkingLevel": "high" }
            }
        }))
    );

    // A sibling key leaves the nested config untouched.
    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "google": { "responseMimeType": " application/json " } }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "google": {
                "nativeWebSearch": false,
                "responseMimeType": "application/json",
                "thinkingConfig": { "includeThoughts": true, "thinkingLevel": "high" }
            }
        }))
    );

    // An invalid level alone is not editable: ignored.
    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "google": { "thinkingConfig": { "thinkingLevel": "extreme" } } }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id).unwrap()["google"]["thinkingConfig"],
        json!({ "includeThoughts": true, "thinkingLevel": "high" })
    );

    // An explicit empty `thinkingConfig` clears only `thinkingLevel`.
    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "google": { "thinkingConfig": {} } }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "google": {
                "nativeWebSearch": false,
                "responseMimeType": "application/json",
                "thinkingConfig": { "includeThoughts": true }
            }
        }))
    );
}

#[tokio::test]
async fn codex_web_search_location_merges_and_empty_location_clears() {
    let iso = Iso::new("cowork-provider-options-merge-codex-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    set_provider_options(
        &mut ws,
        &thread_id,
        json!({
            "codex-cli": {
                "webSearchMode": "live",
                "webSearch": {
                    "contextSize": "high",
                    "allowedDomains": [" example.com ", ""],
                    "location": { "country": "US", "city": "SF" }
                }
            }
        }),
    )
    .await;
    set_provider_options(
        &mut ws,
        &thread_id,
        json!({
            "codex-cli": {
                "reasoningEffort": "low",
                "webSearch": { "location": { "city": "NYC" } }
            }
        }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "codex-cli": {
                "webSearchMode": "live",
                "reasoningEffort": "low",
                "webSearch": {
                    "contextSize": "high",
                    "allowedDomains": ["example.com"],
                    "location": { "country": "US", "city": "NYC" }
                }
            }
        }))
    );

    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "codex-cli": { "webSearch": { "location": {} } } }),
    )
    .await;
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "codex-cli": {
                "webSearchMode": "live",
                "reasoningEffort": "low",
                "webSearch": { "contextSize": "high", "allowedDomains": ["example.com"] }
            }
        }))
    );
}

#[tokio::test]
async fn session_defaults_apply_merges_into_the_thread_override() {
    let iso = Iso::new("cowork-provider-options-merge-defaults-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();

    set_provider_options(
        &mut ws,
        &thread_id,
        json!({ "openai": { "reasoningEffort": "high" } }),
    )
    .await;
    let res = call(
        &mut ws,
        "defaults",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "config": { "providerOptions": { "openai": { "textVerbosity": "low" } } }
        }),
    )
    .await;
    assert!(res.get("error").is_none(), "defaults/apply failed: {res}");
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({ "openai": { "reasoningEffort": "high", "textVerbosity": "low" } }))
    );
}
