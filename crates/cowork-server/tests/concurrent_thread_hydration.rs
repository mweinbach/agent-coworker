//! Regression tests for concurrent hydration of persisted / evicted threads: every caller that
//! races to load the same thread must share one `LiveSession`, so subscriber registrations
//! survive and `turn/start` admission (`busy`) is reserved on a single instance.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::{get, post};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const MODEL: &str = "moonshotai/kimi-k2-instruct";

struct Env {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    turn_requests: Arc<Mutex<usize>>,
}

impl Env {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-hydrate-race-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let turn_requests = Arc::new(Mutex::new(0usize));
        let counter = Arc::clone(&turn_requests);
        let app = Router::new()
            .route(
                "/v1/chat/completions",
                post(move |body: axum::body::Bytes| {
                    let counter = Arc::clone(&counter);
                    async move {
                        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let is_turn_step =
                            parsed["tools"].as_array().is_some_and(|t| !t.is_empty());
                        if is_turn_step {
                            *counter.lock().unwrap() += 1;
                            // Keep the admitted turn running while the rivals are rejected.
                            tokio::time::sleep(Duration::from_millis(800)).await;
                        }
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "text/event-stream")
                            .body(Body::from(chat_sse_text("done")))
                            .unwrap()
                    }
                }),
            )
            .route(
                "/v1/models",
                get(|| async {
                    axum::Json(json!({ "object": "list", "data": [{ "id": "local-model", "object": "model" }] }))
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        env.insert(
            "NVIDIA_BASE_URL".into(),
            format!("http://127.0.0.1:{port}/v1"),
        );
        env.insert("NVIDIA_API_KEY".into(), "nvapi-mock-test".into());
        Self {
            _root: root,
            home,
            workspace,
            env,
            turn_requests,
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
}

fn chat_sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
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
                "clientInfo": { "name": "hydrate-race", "version": "1.0.0" },
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

async fn await_response(ws: &mut WsStream, id: &str) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("response timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_none() && val["id"].as_str() == Some(id) {
                return val;
            }
        }
    }
}

/// Creates a persisted thread, then evicts it so the next access must rehydrate from SQLite.
async fn persisted_evicted_thread(server: &cowork_server::ServerHandle, env: &Env) -> String {
    let rt = server.runtime();
    let (thread, created) = rt
        .start_or_get_thread(&env.workspace, None, Some("nvidia"), Some(MODEL), "creator")
        .await
        .unwrap();
    assert!(created);
    let id = thread.id.clone();
    rt.unsubscribe("creator", &id);
    assert_eq!(rt.evict_idle_sessions(Duration::ZERO), 1);
    assert!(rt.get_live_thread(&id).is_none());
    id
}

#[tokio::test]
async fn unreadable_history_survives_rename_and_retried_thread_creation() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let rt = server.runtime();
    let start = || rt.start_or_get_thread(&env.workspace, Some("stable-key"), None, None, "client");
    let (thread, _) = start().await.unwrap();
    rt.unsubscribe("client", &thread.id);
    assert_eq!(rt.evict_idle_sessions(Duration::ZERO), 1);

    let conn = rusqlite::Connection::open(rt.session_db.db_path()).unwrap();
    let set_history = |history: &str| {
        conn.execute(
            "UPDATE session_state SET messages_json = ? WHERE session_id = ?",
            [history, thread.id.as_str()],
        )
        .unwrap();
    };
    let nested_history = |depth| {
        format!(
            r#"[{{"role":"tool","content":[{{"type":"tool-result","toolCallId":"id","toolName":"lookup","output":{}1{}}}]}}]"#,
            "[".repeat(depth),
            "]".repeat(depth)
        )
    };

    // A valid legacy tool result beyond serde_json's default depth is still usable.
    set_history(&nested_history(140));
    let (before, count) = rt.session_db.get_messages(&thread.id, 0, 1).unwrap();
    assert_eq!(count, 1);
    rt.set_session_title(&thread.id, "Renamed").await.unwrap();
    assert_eq!(
        rt.session_db.get_messages(&thread.id, 0, 1).unwrap().0,
        before
    );
    assert_eq!(rt.evict_idle_sessions(Duration::ZERO), 1);

    for history in [
        r#"[{"role":"user","content":"truncated"#.to_owned(),
        nested_history(512),
    ] {
        set_history(&history);
        assert!(rt.session_db.get_messages(&thread.id, 0, 1).is_err());
        assert!(rt.set_session_title(&thread.id, "Rename").await.is_err());
        assert!(
            rt.read_or_hydrate_thread(&thread.id, 0, false)
                .await
                .unwrap_err()
                .contains("Failed to load thread")
        );
        assert!(start().await.is_err());
        assert!(rt.delete_session(&env.home, &thread.id).await.is_err());
        let stored: String = conn
            .query_row(
                "SELECT messages_json FROM session_state WHERE session_id = ?",
                [&thread.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, history);
    }
    // Deletion from the owning workspace needs only intact session metadata.
    rt.delete_session(&env.workspace, &thread.id).await.unwrap();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_hydration_of_an_evicted_thread_shares_one_live_session() {
    const CALLERS: usize = 8;
    const ROUNDS: usize = 60;
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let rt = Arc::clone(server.runtime());
    let thread_id = persisted_evicted_thread(&server, &env).await;

    for round in 0..ROUNDS {
        assert!(rt.get_live_thread(&thread_id).is_none());
        let barrier = Arc::new(Barrier::new(CALLERS));
        let arcs: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..CALLERS)
                .map(|i| {
                    let barrier = Arc::clone(&barrier);
                    let rt = &rt;
                    let thread_id = &thread_id;
                    scope.spawn(move || {
                        barrier.wait();
                        rt.subscribe(&format!("conn-{round}-{i}"), thread_id)
                            .expect("thread must hydrate")
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let installed = rt.get_live_thread(&thread_id).expect("thread is live");
        for (i, arc) in arcs.iter().enumerate() {
            assert!(
                Arc::ptr_eq(arc, &installed),
                "round {round}: caller {i} received a live session that is not the installed one"
            );
        }
        let subscribers: HashSet<String> = installed.lock().subscribers.iter().cloned().collect();
        let expected: HashSet<String> = (0..CALLERS).map(|i| format!("conn-{round}-{i}")).collect();
        assert_eq!(
            subscribers, expected,
            "round {round}: every concurrent subscriber registration must survive"
        );

        for i in 0..CALLERS {
            assert_eq!(
                rt.unsubscribe(&format!("conn-{round}-{i}"), &thread_id),
                "unsubscribed"
            );
        }
        assert_eq!(rt.evict_idle_sessions(Duration::ZERO), 1);
    }
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_thread_start_with_one_client_thread_id_creates_once() {
    const CALLERS: usize = 8;
    const ROUNDS: usize = 20;
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let rt = Arc::clone(server.runtime());

    for round in 0..ROUNDS {
        let client_thread_id = format!("client-thread-{round}");
        let barrier = Arc::new(tokio::sync::Barrier::new(CALLERS));
        let tasks: Vec<_> = (0..CALLERS)
            .map(|i| {
                let rt = Arc::clone(&rt);
                let barrier = Arc::clone(&barrier);
                let workspace = env.workspace.clone();
                let client_thread_id = client_thread_id.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    rt.start_or_get_thread(
                        &workspace,
                        Some(&client_thread_id),
                        Some("nvidia"),
                        Some(MODEL),
                        &format!("conn-{round}-{i}"),
                    )
                    .await
                    .unwrap()
                })
            })
            .collect();
        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap());
        }
        let ids: HashSet<String> = results.iter().map(|(t, _)| t.id.clone()).collect();
        assert_eq!(ids.len(), 1, "round {round}: one thread per clientThreadId");
        let created = results.iter().filter(|(_, c)| *c).count();
        assert_eq!(created, 1, "round {round}: exactly one caller creates");

        let id = ids.into_iter().next().unwrap();
        let live = rt.get_live_thread(&id).expect("thread is live");
        let subscribers: HashSet<String> = live.lock().subscribers.iter().cloned().collect();
        let expected: HashSet<String> = (0..CALLERS).map(|i| format!("conn-{round}-{i}")).collect();
        assert_eq!(
            subscribers, expected,
            "round {round}: every caller must be subscribed to the one live session"
        );
    }
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_turn_start_on_a_rehydrated_thread_admits_exactly_one() {
    const CALLERS: usize = 6;
    const THREADS: usize = 12;
    let env = Env::new().await;
    let thread_ids: Vec<String> = {
        let server = start_server(env.options()).await.unwrap();
        let mut ids = Vec::new();
        for _ in 0..THREADS {
            ids.push(persisted_evicted_thread(&server, &env).await);
        }
        server.shutdown().await;
        ids
    };

    // Fresh server: the threads exist only in sessions.db.
    let server = start_server(env.options()).await.unwrap();
    let mut sockets = Vec::new();
    for _ in 0..CALLERS {
        sockets.push(connect(server.ws_url()).await);
    }
    for (round, thread_id) in thread_ids.iter().enumerate() {
        assert!(server.runtime().get_live_thread(thread_id).is_none());
        let barrier = Arc::new(tokio::sync::Barrier::new(CALLERS));
        let tasks: Vec<_> = sockets
            .drain(..)
            .enumerate()
            .map(|(i, mut ws)| {
                let barrier = Arc::clone(&barrier);
                let thread_id = thread_id.clone();
                tokio::spawn(async move {
                    let id = format!("race-{round}-{i}");
                    let msg = json!({
                        "id": id,
                        "method": "turn/start",
                        "params": { "threadId": thread_id, "input": format!("hello {i}") }
                    });
                    barrier.wait().await;
                    send(&mut ws, msg).await;
                    (await_response(&mut ws, &id).await, ws)
                })
            })
            .collect();
        let mut responses = Vec::new();
        for task in tasks {
            let (resp, ws) = task.await.unwrap();
            responses.push(resp);
            sockets.push(ws);
        }
        let accepted = responses
            .iter()
            .filter(|r| r.get("result").is_some())
            .count();
        assert_eq!(
            accepted, 1,
            "round {round}: exactly one concurrent turn/start may be admitted: {responses:#?}"
        );
        for r in responses.iter().filter(|r| r.get("error").is_some()) {
            assert!(
                r["error"]["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("already in progress")),
                "round {round}: rivals must be rejected as busy: {r}"
            );
        }
        let live = server
            .runtime()
            .get_live_thread(thread_id)
            .expect("thread is live");
        assert_eq!(
            live.lock().subscribers.len(),
            CALLERS,
            "round {round}: every connection's subscription must land on the one live session"
        );
    }
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
        *env.turn_requests.lock().unwrap(),
        THREADS,
        "only one admitted turn per thread may reach the provider"
    );
    drop(sockets);
    server.shutdown().await;
}
