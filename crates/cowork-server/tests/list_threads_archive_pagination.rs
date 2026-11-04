//! `list_threads` (thread-management tool bridge) must apply the archive/query filters
//! before computing `total` and slicing to `limit`, matching TS
//! `LocalThreadHost.listThreads`: filter -> total -> sort (pinned first, newest first) ->
//! slice.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::memory_and_fork_routes::ServerThreadControlBridge;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_tools::ThreadControlBridge;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
    }
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
                "clientInfo": { "name": "list-threads-tests", "version": "1.0.0" },
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

async fn start_thread(ws: &mut WsStream, cwd: &str, n: usize) -> String {
    let id = format!("start-{n}");
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": "thread/start",
            "params": { "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val["result"]["thread"]["id"]
                    .as_str()
                    .unwrap_or_else(|| panic!("thread/start failed: {val}"))
                    .to_owned();
            }
        }
    }
}

/// Creates a listable root thread (manual title) and pins its `updatedAt`.
async fn listable_thread(
    ws: &mut WsStream,
    server: &ServerHandle,
    bridge: &ServerThreadControlBridge,
    cwd: &str,
    n: usize,
    title: &str,
    updated_at: &str,
) -> String {
    let id = start_thread(ws, cwd, n).await;
    bridge
        .set_thread_title(json!({ "threadId": id, "title": title }))
        .await
        .unwrap();
    server
        .runtime()
        .get_live_thread(&id)
        .unwrap()
        .lock()
        .updated_at = updated_at.to_owned();
    id
}

fn ids(res: &Value) -> Vec<String> {
    res["threads"]
        .as_array()
        .unwrap_or_else(|| panic!("threads missing: {res}"))
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

struct Fixture {
    _iso: Iso,
    server: ServerHandle,
    bridge: ServerThreadControlBridge,
    _ws: WsStream,
    /// Active root threads, newest first (by `updatedAt`).
    active: Vec<String>,
    archived: Vec<String>,
}

/// Two archived threads are the newest in the workspace; three older threads are active.
async fn fixture(prefix: &str) -> Fixture {
    let iso = Iso::new(prefix);
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();
    let bridge = ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "list-threads-test".to_owned(),
    };

    let mut archived = Vec::new();
    for (n, ts) in [
        (0, "2026-01-01T00:00:09.000Z"),
        (1, "2026-01-01T00:00:08.000Z"),
    ] {
        let id = listable_thread(
            &mut ws,
            &server,
            &bridge,
            &cwd,
            n,
            &format!("archived {n}"),
            ts,
        )
        .await;
        bridge
            .set_thread_archived(json!({ "threadId": id, "archived": true }))
            .await
            .unwrap();
        archived.push(id);
    }
    let mut active = Vec::new();
    for (n, ts) in [
        (2, "2026-01-01T00:00:05.000Z"),
        (3, "2026-01-01T00:00:04.000Z"),
        (4, "2026-01-01T00:00:03.000Z"),
    ] {
        active.push(
            listable_thread(
                &mut ws,
                &server,
                &bridge,
                &cwd,
                n,
                &format!("active {n}"),
                ts,
            )
            .await,
        );
    }
    Fixture {
        _iso: iso,
        server,
        bridge,
        _ws: ws,
        active,
        archived,
    }
}

#[tokio::test]
async fn list_threads_limit_one_skips_archived_newest_thread() {
    let fx = fixture("cowork-list-threads-limit-").await;

    let res = fx.bridge.list_threads(json!({ "limit": 1 })).await.unwrap();
    assert_eq!(ids(&res), vec![fx.active[0].clone()], "{res}");
    assert_eq!(res["total"], json!(fx.active.len()), "{res}");

    // Without a limit (TS default 50) every active root thread is returned.
    let res = fx.bridge.list_threads(json!({})).await.unwrap();
    assert_eq!(ids(&res), fx.active, "{res}");
    assert_eq!(res["total"], json!(fx.active.len()), "{res}");

    fx.server.shutdown().await;
}

#[tokio::test]
async fn list_threads_total_excludes_archived_and_includes_them_on_request() {
    let fx = fixture("cowork-list-threads-total-").await;

    for limit in [1, 2, 3, 50] {
        let res = fx
            .bridge
            .list_threads(json!({ "limit": limit }))
            .await
            .unwrap();
        assert_eq!(res["total"], json!(3), "limit {limit}: {res}");
        assert!(
            ids(&res).iter().all(|id| !fx.archived.contains(id)),
            "limit {limit} leaked archived threads: {res}"
        );
    }

    let res = fx
        .bridge
        .list_threads(json!({ "includeArchived": true, "limit": 1 }))
        .await
        .unwrap();
    assert_eq!(ids(&res), vec![fx.archived[0].clone()], "{res}");
    assert_eq!(res["total"], json!(5), "{res}");

    // A query surfaces matching archived threads (TS: archived hidden unless matched).
    let res = fx
        .bridge
        .list_threads(json!({ "query": "  ARCHIVED 1 " }))
        .await
        .unwrap();
    assert_eq!(ids(&res), vec![fx.archived[1].clone()], "{res}");
    assert_eq!(res["total"], json!(1), "{res}");

    fx.server.shutdown().await;
}

#[tokio::test]
async fn list_threads_pages_are_consistent_prefixes() {
    let fx = fixture("cowork-list-threads-pages-").await;

    let full = fx
        .bridge
        .list_threads(json!({ "limit": 200 }))
        .await
        .unwrap();
    let full_ids = ids(&full);
    assert_eq!(full_ids, fx.active, "{full}");
    for limit in 1..=full_ids.len() + 1 {
        let page = fx
            .bridge
            .list_threads(json!({ "limit": limit }))
            .await
            .unwrap();
        let expected: Vec<String> = full_ids.iter().take(limit).cloned().collect();
        assert_eq!(ids(&page), expected, "limit {limit}: {page}");
        assert_eq!(page["total"], full["total"], "limit {limit}: {page}");
    }

    // Pinned threads sort first (TS `compareThreads`), still after the archive filter.
    let oldest = fx.active[2].clone();
    fx.bridge
        .set_thread_pinned(json!({ "threadId": oldest, "pinned": true }))
        .await
        .unwrap();
    let res = fx.bridge.list_threads(json!({ "limit": 2 })).await.unwrap();
    assert_eq!(ids(&res), vec![oldest, fx.active[0].clone()], "{res}");
    assert_eq!(res["total"], json!(3), "{res}");

    fx.server.shutdown().await;
}
