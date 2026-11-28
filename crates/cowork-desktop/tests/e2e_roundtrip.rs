//! End-to-end integration test exercising the real `cowork-desktop` store,
//! `native/` sidecar manager, `ws/` WebSocket client, and `cowork-server`.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use cowork_desktop::actions::{Action, ChatAction, NativeAction, SettingsAction};
use cowork_desktop::native::{on_shutdown, spawn_native_worker};
use cowork_desktop::state::{
    AppState, FeedItem, FeedMessageRole, ServerLifecycleState, ThreadBusyPolicy, WorkspaceRuntime,
};
use cowork_desktop::ws::{WsConnectionState, spawn_ws_manager};
use serde_json::json;
use tempfile::TempDir;

struct MockOpenAiServer {
    base_url: String,
    hits: Arc<AtomicUsize>,
    shutdown: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl MockOpenAiServer {
    fn start(reply_text: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock OpenAI listener");
        let port = listener.local_addr().expect("listener local_addr").port();
        listener
            .set_nonblocking(true)
            .expect("set listener nonblocking");
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_bg = Arc::clone(&hits);
        let shutdown = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&shutdown);

        let handle = std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        hits_bg.fetch_add(1, Ordering::Relaxed);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let req_head = read_http_request(&mut stream);
                        if req_head.starts_with("GET ") {
                            let body =
                                r#"{"object":"list","data":[{"id":"gpt-5.4","object":"model"}]}"#;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(resp.as_bytes());
                        } else {
                            let sse = build_responses_sse(reply_text);
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                sse.len(),
                                sse
                            );
                            let _ = stream.write_all(resp.as_bytes());
                        }
                        let _ = stream.flush();
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(15));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            hits,
            shutdown,
            handle: Some(handle),
        }
    }
}

impl Drop for MockOpenAiServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn read_http_request(stream: &mut impl Read) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut header_end = None;
    let mut content_len = 0_usize;

    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none()
                    && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
                {
                    let end = pos + 4;
                    header_end = Some(end);
                    let headers = String::from_utf8_lossy(&buf[..end]);
                    for line in headers.lines() {
                        if let Some((name, val)) = line.split_once(':')
                            && name.trim().eq_ignore_ascii_case("content-length")
                        {
                            content_len = val.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }
                if let Some(end) = header_end
                    && buf.len() >= end + content_len
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    String::from_utf8_lossy(&buf).into_owned()
}

fn build_responses_sse(reply_text: &str) -> String {
    let midpoint = reply_text.len() / 2;
    let (first_half, second_half) = reply_text.split_at(midpoint);
    let events = [
        (
            "response.created",
            json!({
                "type": "response.created",
                "response": { "id": "resp_e2e_1", "status": "in_progress" }
            }),
        ),
        (
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "id": "msg_e2e_1",
                    "type": "message",
                    "role": "assistant",
                    "content": []
                }
            }),
        ),
        (
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": "msg_e2e_1",
                "output_index": 0,
                "content_index": 0,
                "delta": first_half
            }),
        ),
        (
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": "msg_e2e_1",
                "output_index": 0,
                "content_index": 0,
                "delta": second_half
            }),
        ),
        (
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "msg_e2e_1",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{ "type": "output_text", "text": reply_text }]
                }
            }),
        ),
        (
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_e2e_1",
                    "status": "completed",
                    "usage": {
                        "input_tokens": 12,
                        "output_tokens": 6,
                        "total_tokens": 18
                    }
                }
            }),
        ),
    ];

    let mut out = String::new();
    for (event_name, payload) in events {
        out.push_str(&format!("event: {event_name}\ndata: {payload}\n\n"));
    }
    out
}

fn pump_until(
    state: &mut AppState,
    timeout: Duration,
    mut pred: impl FnMut(&AppState) -> bool,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        state.now_secs = start.elapsed().as_secs_f64();
        let _ = state.drain_events();
        if pred(state) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn set_isolated_env(home_dir: &Path, user_data_dir: &Path, openai_base_url: &str) {
    // SAFETY: Single-test integration binary; called before spawning background worker threads.
    unsafe {
        std::env::set_var("HOME", home_dir);
        std::env::set_var("COWORK_DESKTOP_USER_DATA_DIR", user_data_dir);
        std::env::set_var("OPENAI_API_KEY", "sk-e2e-mock-openai-key");
        std::env::set_var("OPENAI_BASE_URL", openai_base_url);
        std::env::set_var("COWORK_TELEMETRY_DISABLED", "1");
        std::env::set_var("COWORK_DISABLE_RUNTIME", "1");
        std::env::set_var("COWORK_RUNTIME_ALLOW_NETWORK", "0");
    }
}

struct ShutdownGuard(Option<AppState>);

impl ShutdownGuard {
    fn new(state: AppState) -> Self {
        Self(Some(state))
    }
}

impl std::ops::Deref for ShutdownGuard {
    type Target = AppState;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("AppState present until drop")
    }
}

impl std::ops::DerefMut for ShutdownGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("AppState present until drop")
    }
}

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        if let Some(mut state) = self.0.take() {
            on_shutdown(&mut state);
        }
    }
}

#[test]
#[ignore = "requires built cowork-server binary; run `cargo build -p cowork-server --bin cowork-server && cargo test -p cowork-desktop --test e2e_roundtrip -- --ignored`"]
fn desktop_starts_workspace_server_lists_threads_and_streams_reply() {
    const MOCK_REPLY: &str = "Hello from mock OpenAI E2E!";

    let temp = TempDir::new().expect("create TempDir");
    let home_dir = temp.path().join("home");
    let user_data_dir = temp.path().join("user_data");
    let workspace_dir = temp.path().join("workspace");
    std::fs::create_dir_all(&home_dir).expect("create home dir");
    std::fs::create_dir_all(&user_data_dir).expect("create user data dir");
    std::fs::create_dir_all(&workspace_dir).expect("create workspace dir");

    let mock_openai = MockOpenAiServer::start(MOCK_REPLY);
    set_isolated_env(&home_dir, &user_data_dir, &mock_openai.base_url);

    let mut state = ShutdownGuard::new(AppState::default());
    let event_tx = state.services.event_tx.clone();
    state.services.ws_tx = Some(spawn_ws_manager(event_tx.clone(), None));
    state.services.native_tx = Some(spawn_native_worker(event_tx, None));

    assert!(
        pump_until(&mut state, Duration::from_secs(10), |s| s.native_ready),
        "timed out waiting for NativeReady"
    );

    state.dispatch(Action::Native(NativeAction::AddWorkspace {
        path: workspace_dir,
        name: Some("E2E Repo".to_string()),
    }));

    let ws_id = state
        .active_workspace_id
        .clone()
        .expect("active_workspace_id set after AddWorkspace");

    if !pump_until(&mut state, Duration::from_secs(30), |s| {
        let server_running =
            s.workspace_runtime_by_id
                .get(&ws_id)
                .is_some_and(|rt: &WorkspaceRuntime| {
                    matches!(rt.server_state, ServerLifecycleState::Running { .. })
                });
        let ws_connected = s
            .workspace_socket_by_id
            .get(&ws_id)
            .is_some_and(|st| matches!(st, WsConnectionState::Connected));
        let has_statuses = s
            .workspace_runtime_by_id
            .get(&ws_id)
            .is_some_and(|rt| !rt.provider_statuses.is_empty());
        server_running && ws_connected && !s.provider_catalog.is_empty() && has_statuses
    }) {
        let rt = state.workspace_runtime_by_id.get(&ws_id);
        let ws = state.workspace_socket_by_id.get(&ws_id);
        panic!(
            "timed out waiting for workspace server/WS/catalog: rt={rt:?}, ws={ws:?}, providers={}, mcp={}, toasts={:?}",
            state.provider_catalog.len(),
            state.mcp_servers.len(),
            state.toasts
        );
    }

    // Ensure workspace defaults point at deterministic mock OpenAI before thread/start.
    state.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
        workspace_id: ws_id.clone(),
        defaults: json!({
            "provider": "openai",
            "model": "gpt-5.4"
        }),
    }));

    state.dispatch(Action::Chat(ChatAction::CreateThread {
        workspace_id: ws_id.clone(),
        title: None,
    }));

    assert!(
        pump_until(&mut state, Duration::from_secs(15), |s| !s
            .threads
            .is_empty()),
        "timed out waiting for thread/start: toasts={:?}",
        state.toasts
    );

    let thread_id = state.threads[0].id.clone();
    state.dispatch(Action::Chat(ChatAction::SelectThread(thread_id.clone())));
    state.dispatch(Action::Chat(ChatAction::SetThreadModel {
        thread_id: thread_id.clone(),
        provider: "openai".to_string(),
        model: "gpt-5.4".to_string(),
        rollback: None,
    }));

    state.dispatch(Action::Chat(ChatAction::SendMessage {
        thread_id: Some(thread_id.clone()),
        text: "Please respond with the E2E greeting.".to_string(),
        busy_policy: ThreadBusyPolicy::Steer,
        attachments: Vec::new(),
        references: Vec::new(),
    }));

    if !pump_until(&mut state, Duration::from_secs(20), |s| {
        let Some(rt) = s.thread_runtime_by_id.get(&thread_id) else {
            return false;
        };
        let has_user = rt.feed.iter().any(|item| {
            matches!(
                item,
                FeedItem::Message {
                    role: FeedMessageRole::User,
                    ..
                }
            )
        });
        let has_reply = rt.feed.iter().any(|item| {
            matches!(
                item,
                FeedItem::Message {
                    role: FeedMessageRole::Assistant,
                    content,
                    streaming: false,
                    ..
                } if content.contains(MOCK_REPLY)
            )
        });
        !rt.streaming && has_user && has_reply
    }) {
        let rt = state.thread_runtime_by_id.get(&thread_id);
        let ws_rt = state.workspace_runtime_by_id.get(&ws_id);
        panic!(
            "timed out waiting for streamed reply: hits={}, ws_last_error={:?}, settings_err={:?}, thread_rt={rt:?}, toasts={:?}",
            mock_openai.hits.load(Ordering::Relaxed),
            ws_rt.and_then(|w| w.last_error.as_deref()),
            state.settings_mutation_error,
            state.toasts
        );
    }

    assert!(mock_openai.hits.load(Ordering::Relaxed) >= 1);
    assert!(state.settings_mutation_error.is_none());
    assert!(
        state
            .workspace_runtime_by_id
            .get(&ws_id)
            .and_then(|rt| rt.last_error.as_ref())
            .is_none()
    );
    assert!(
        state
            .provider_catalog
            .iter()
            .any(|p| p.id == "openai" && !p.models.is_empty()),
        "openai provider models should be populated in catalog"
    );
    assert!(
        !state.default_model_by_provider.is_empty(),
        "default_model_by_provider should be populated"
    );
    assert!(
        !state.provider_auth_methods.is_empty(),
        "provider_auth_methods should be populated from cowork/provider/authMethods/read"
    );
    assert!(
        state
            .workspace_runtime_by_id
            .get(&ws_id)
            .is_some_and(|rt| rt
                .provider_statuses
                .iter()
                .any(|s| s.provider == "openai" && (s.connected || s.healthy))),
        "openai status should report connected with OPENAI_API_KEY"
    );
    assert!(
        pump_until(&mut state, Duration::from_secs(10), |s| s
            .workspace_creation_preflight
            .as_ref()
            .is_some_and(|p| p.ready)),
        "creation preflight should settle to ready once OpenAI provider is active: {:?}",
        state.workspace_creation_preflight
    );
    assert_eq!(
        state.nav.current().active_thread_id.as_deref(),
        Some(thread_id.as_str()),
        "active thread must stay selected after send and reply"
    );

    // Explicitly shut down cleanly so persisted desktop-state.json + transcripts flush before restart.
    drop(state);

    let mut restarted = ShutdownGuard::new(AppState::default());
    let event_tx2 = restarted.services.event_tx.clone();
    restarted.services.ws_tx = Some(spawn_ws_manager(event_tx2.clone(), None));
    restarted.services.native_tx = Some(spawn_native_worker(event_tx2, None));

    assert!(
        pump_until(&mut restarted, Duration::from_secs(10), |s| s.native_ready),
        "timed out waiting for NativeReady on restart"
    );
    assert_eq!(
        restarted.active_workspace_id.as_deref(),
        Some(ws_id.as_str()),
        "restart should restore active workspace"
    );
    assert_eq!(
        restarted.nav.current().active_thread_id.as_deref(),
        Some(thread_id.as_str()),
        "restart should reopen persisted activeThreadId instead of landing"
    );
    assert!(
        pump_until(&mut restarted, Duration::from_secs(30), |s| {
            let Some(rt) = s.thread_runtime_by_id.get(&thread_id) else {
                return false;
            };
            let has_user = rt.feed.iter().any(|item| {
                matches!(
                    item,
                    FeedItem::Message {
                        role: FeedMessageRole::User,
                        content,
                        ..
                    } if content.contains("Please respond with the E2E greeting.")
                )
            });
            let has_reply = rt.feed.iter().any(|item| {
                matches!(
                    item,
                    FeedItem::Message {
                        role: FeedMessageRole::Assistant,
                        content,
                        ..
                    } if content.contains(MOCK_REPLY)
                )
            });
            rt.hydrated && !rt.transcript_only && has_user && has_reply
        }),
        "restarted app should hydrate restored thread from server: runtime={:?}",
        restarted.thread_runtime_by_id.get(&thread_id)
    );

    // Submitting directly from New Chat landing must promote nav from __draft-* to real server thread and stream reply.
    restarted.dispatch(Action::Navigate(
        cowork_desktop::actions::NavAction::OpenNewChat {
            workspace_id: Some(ws_id.clone()),
        },
    ));
    assert!(restarted.nav.current().active_thread_id.is_none());
    restarted.dispatch(Action::Chat(ChatAction::SendMessage {
        thread_id: None,
        text: "Landing E2E prompt.".to_string(),
        busy_policy: ThreadBusyPolicy::Steer,
        attachments: Vec::new(),
        references: Vec::new(),
    }));
    assert!(
        pump_until(&mut restarted, Duration::from_secs(20), |s| {
            let Some(active_tid) = s.nav.current().active_thread_id.as_deref() else {
                return false;
            };
            if active_tid == thread_id || active_tid.starts_with("__draft-") {
                return false;
            }
            let Some(rt) = s.thread_runtime_by_id.get(active_tid) else {
                return false;
            };
            let has_reply = rt.feed.iter().any(|item| {
                matches!(
                    item,
                    FeedItem::Message {
                        role: FeedMessageRole::Assistant,
                        content,
                        ..
                    } if content.contains(MOCK_REPLY)
                )
            });
            !rt.streaming && has_reply
        }),
        "landing SendMessage should promote active_thread_id and stream reply: nav={:?}, threads={:?}",
        restarted.nav.current(),
        restarted.threads
    );
}
