//! Regression (Codex Security P1): `cowork/skills/*` must never return a file a workspace
//! symlinked into its skills directory. A local client can point `cwd` at a directory it owns
//! (TS `requireWorkspacePath` accepts any existing directory for these routes) containing
//! `.cowork/skills/leak/SKILL.md -> ~/.cowork/auth/connections.json`; the server runs as the
//! victim, so following that link would bypass the file's 0600 mode and the read-tool path gate.
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const SECRET: &str = "sk-victim-connections-secret-marker";

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

struct Fixture {
    _root: TempDir,
    base: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-skill-confine-")
            .tempdir_in(test_temp_base())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(home.join(".cowork/auth")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            home.join(".cowork/auth/connections.json"),
            format!(r#"{{"openai":{{"type":"api_key","apiKey":"{SECRET}"}}}}"#),
        )
        .unwrap();
        Self {
            _root: root,
            base,
            home,
            workspace,
        }
    }

    fn secret_path(&self) -> PathBuf {
        self.home.join(".cowork/auth/connections.json")
    }

    fn options(&self) -> ServerOptions {
        let mut env = HashMap::new();
        env.insert("HOME".into(), self.home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            self.home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            self.base.join("electron").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            self.base.join("desktop").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
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
            env,
        }
    }
}

/// Seeds `<cwd>/.cowork/skills` with a valid skill plus the two link attacks.
fn seed_attacker_skills(fx: &Fixture, cwd: &Path) {
    let skills = cwd.join(".cowork/skills");
    let good = skills.join("good-skill");
    fs::create_dir_all(&good).unwrap();
    fs::write(
        good.join("SKILL.md"),
        "---\nname: good-skill\ndescription: A regular project skill\n---\nRegular body.\n",
    )
    .unwrap();

    // 1. `SKILL.md` symlinked at the victim's credential file.
    let leak = skills.join("leak");
    fs::create_dir_all(&leak).unwrap();
    symlink(fx.secret_path(), leak.join("SKILL.md")).unwrap();

    // 2. The whole skill directory symlinked outside the skills root.
    let outside = cwd.join("outside-skill");
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        outside.join("SKILL.md"),
        format!("---\nname: escape\ndescription: escaped\n---\n{SECRET}\n"),
    )
    .unwrap();
    symlink(&outside, skills.join("escape")).unwrap();
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
            "id": "init-1",
            "method": "initialize",
            "params": { "clientInfo": { "name": "skill-confine-e2e", "version": "1.0.0" } }
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

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("ws call timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            // No frame of any kind (response or notification) may carry the secret.
            assert!(!txt.contains(SECRET), "{method} leaked the secret: {txt}");
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
        }
    }
}

fn skill_names(list_res: &Value) -> Vec<String> {
    list_res["result"]["event"]["skills"]
        .as_array()
        .unwrap_or_else(|| panic!("skills list: {list_res}"))
        .iter()
        .filter_map(|s| s["name"].as_str().map(str::to_owned))
        .collect()
}

async fn assert_cwd_is_confined(ws: &mut WsStream, cwd: Option<&Path>) {
    let with_cwd = |extra: Value| {
        let mut params = extra;
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd.to_string_lossy());
        }
        params
    };

    let list = call(ws, "list", "cowork/skills/list", with_cwd(json!({}))).await;
    let names = skill_names(&list);
    assert!(names.contains(&"good-skill".to_owned()), "list={list}");
    assert!(!names.contains(&"leak".to_owned()), "list={list}");
    assert!(!names.contains(&"escape".to_owned()), "list={list}");

    for name in ["leak", "escape"] {
        let read = call(
            ws,
            &format!("read-{name}"),
            "cowork/skills/read",
            with_cwd(json!({ "skillName": name })),
        )
        .await;
        assert!(read.get("error").is_some(), "read {name}: {read}");
    }

    let good = call(
        ws,
        "read-good",
        "cowork/skills/read",
        with_cwd(json!({ "skillName": "good-skill" })),
    )
    .await;
    assert!(
        good["result"]["event"]["content"]
            .as_str()
            .is_some_and(|c| c.contains("Regular body.")),
        "good={good}"
    );

    // Every installation in the catalog (including the invalid `leak` entry) reads back
    // without the secret.
    let catalog = call(
        ws,
        "catalog",
        "cowork/skills/catalog/read",
        with_cwd(json!({})),
    )
    .await;
    let installations = catalog["result"]["event"]["catalog"]["installations"]
        .as_array()
        .unwrap_or_else(|| panic!("catalog: {catalog}"))
        .clone();
    assert!(
        installations
            .iter()
            .any(|i| i["name"] == "leak" && i["state"] == "invalid"),
        "catalog={catalog}"
    );
    assert!(
        !installations.iter().any(|i| i["name"] == "escape"),
        "catalog={catalog}"
    );
    for (idx, inst) in installations.iter().enumerate() {
        let Some(id) = inst["installationId"].as_str() else {
            continue;
        };
        let res = call(
            ws,
            &format!("inst-{idx}"),
            "cowork/skills/installation/read",
            with_cwd(json!({ "installationId": id })),
        )
        .await;
        if inst["name"] == "leak" {
            assert!(res["result"]["event"]["content"].is_null(), "leak={res}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skills_routes_never_follow_links_out_of_a_skill_root() {
    let fx = Fixture::new();
    // The server workspace itself, and an arbitrary client-chosen directory outside it.
    seed_attacker_skills(&fx, &fx.workspace);
    let attacker_cwd = fx.base.join("attacker");
    fs::create_dir_all(&attacker_cwd).unwrap();
    seed_attacker_skills(&fx, &attacker_cwd);

    let server = start_server(fx.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;

    assert_cwd_is_confined(&mut ws, None).await;
    assert_cwd_is_confined(&mut ws, Some(&attacker_cwd)).await;
}
