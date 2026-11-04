use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use axum::{Json, Router, routing::post};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use url::Url;

fn cli(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_cowork"));
    let workspace = home.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    cmd.env_clear()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("COWORK_HOME_OVERRIDE", home)
        .env("COWORK_DISABLE_RUNTIME", "1")
        .env("COWORK_RUNTIME_ALLOW_NETWORK", "0")
        .env("COWORK_DISABLE_NETWORK_TELEMETRY", "1")
        .env("LM_STUDIO_BASE_URL", "http://127.0.0.1:9")
        .env("OPENCODE_GO_BASE_URL", "http://127.0.0.1:9/v1")
        .env("OPENCODE_ZEN_BASE_URL", "http://127.0.0.1:9/v1")
        .arg("--dir")
        .arg(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    cmd
}

fn connections(home: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(home.join(".cowork/auth/connections.json")).unwrap())
        .unwrap()
}

#[tokio::test]
async fn connect_prompts_for_keys_and_structured_fields_without_replaying_them() {
    let home = tempfile::tempdir().unwrap();
    let mut child = cli(home.path()).spawn().unwrap();
    let input = concat!(
        "/connect GOOGLE\ninvalid\n2\nexa-private-fixture\n",
        "/connect bedrock\naws_keys\naccess-id\naws-private-fixture\n\nus-east-2\n",
        "/connect openai\nopenai-private-fixture\n",
        "/help\n/connect anthropic\n",
    );
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .await
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let transcript = String::from_utf8(output.stdout).unwrap();
    assert!(transcript.contains("Invalid selection."));
    assert!(transcript.contains("Connect cancelled."));
    assert!(transcript.contains("Goodbye."));
    let store = connections(home.path());
    assert_eq!(store["toolApiKeys"]["exa"], "exa-private-fixture");
    assert_eq!(
        store["services"]["openai"]["apiKey"],
        "openai-private-fixture"
    );
    let bedrock = &store["services"]["bedrock"];
    assert_eq!(bedrock["methodId"], "aws_keys");
    assert_eq!(bedrock["values"]["secretAccessKey"], "aws-private-fixture");
    assert_eq!(bedrock["values"]["region"], "us-east-2");
    let history =
        std::fs::read_to_string(home.path().join(".cowork/state/repl_history.txt")).unwrap();
    assert!(history.contains("/help"));
    assert!(!transcript.contains("private-fixture"));
    assert!(!history.contains("private-fixture"));
}

#[tokio::test]
async fn connect_oauth_displays_the_challenge_and_completes_its_loopback_callback() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let home = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/token",
            post(|| async { Json(json!({ "access_token": "oauth-private-fixture" })) }),
        );
        tokio::spawn(axum::serve(listener, app).into_future());
        let mut child = cli(home.path())
            .env("COWORK_OAUTH_AUTHORIZE_URL", format!("{base}/authorize"))
            .env("COWORK_OAUTH_TOKEN_URL", format!("{base}/token"))
            .env("COWORK_OAUTH_REDIRECT_HOST", "127.0.0.1")
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"/connect codex-cli\n/exit\n")
            .await
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let auth_url = loop {
            let line = lines.next_line().await.unwrap().expect("missing OAuth URL");
            if line.starts_with(&base) {
                break Url::parse(&line).unwrap();
            }
        };
        let query: std::collections::HashMap<_, _> = auth_url.query_pairs().collect();
        let mut callback = Url::parse(&query["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("state", &query["state"])
            .append_pair("code", "local-fixture-code");
        let mut socket = TcpStream::connect(("127.0.0.1", callback.port().unwrap()))
            .await
            .unwrap();
        let get = format!(
            "GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            callback.path(),
            callback.query().unwrap()
        );
        socket.write_all(get.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        let mut completed = false;
        while let Some(line) = lines.next_line().await.unwrap() {
            completed |= line.contains("OAuth connected.");
        }
        assert!(child.wait().await.unwrap().success());
        assert!(completed);
        assert_eq!(
            connections(home.path())["services"]["codex-cli"]["apiKey"],
            "oauth-private-fixture"
        );
    })
    .await
    .expect("local OAuth flow timed out");
}
