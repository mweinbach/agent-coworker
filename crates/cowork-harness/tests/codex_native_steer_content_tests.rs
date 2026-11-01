//! Native Codex `turn/steer` forwards the steer's structured content (injected skill reference
//! context + attachment images), and steers whose content cannot be sent natively stay owed to the
//! provider instead of being marked delivered.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use cowork_harness::{HarnessEventSink, SteerCoordinator};
use cowork_inference::{ContentBlock, MediaKind, MediaSource, ProviderOpaqueMeta};
use cowork_providers::codex_app_server::{CodexAppServerClient, CodexTurnObserver};
use serde_json::Value;
use uuid::Uuid;

const STEER_MOCK: &str = r#"
import readline from "node:readline";
import fs from "node:fs";

const [, , logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method) fs.appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params ?? null }) + "\n");
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "turn/steer") {
    send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, result: {} });
  }
});
"#;

struct NullSink;

impl HarnessEventSink for NullSink {
    fn send_notification(&self, _method: &str, _params: Value) {}
    fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
}

fn text_block(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.into(),
        phase: None,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn media(kind: MediaKind, mime_type: &str, data: &str) -> ContentBlock {
    ContentBlock::Media {
        kind,
        source: MediaSource::Base64 {
            mime_type: mime_type.into(),
            data: data.into(),
        },
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn steer_requests(log_path: &PathBuf) -> Vec<Value> {
    std::fs::read_to_string(log_path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|m| m["method"] == "turn/steer")
        .collect()
}

#[tokio::test]
async fn native_codex_steer_forwards_skill_reference_context_and_images() {
    let base = std::env::temp_dir().join(format!("cowork-codex-steer-{}", Uuid::new_v4()));
    std::fs::create_dir_all(base.join("home/.cowork")).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();
    let script = base.join("mock_codex_steer.mjs");
    std::fs::write(&script, STEER_MOCK).unwrap();
    let log_path = base.join("steer.log");

    let mut env = HashMap::new();
    env.insert(
        "PATH".into(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
    );
    env.insert("HOME".into(), base.join("home").to_string_lossy().into());
    let client = CodexAppServerClient::spawn_stdio(
        "node",
        &[
            script.to_string_lossy().into_owned(),
            log_path.to_string_lossy().into_owned(),
        ],
        &base,
        &base.join("home/.cowork"),
        &env,
        None,
    )
    .await
    .unwrap();

    let steer = SteerCoordinator::new("thread-1", "turn-1", Arc::new(NullSink), None);
    steer.on_turn_started(Arc::clone(&client), "codex-thr-1", Some("codex-turn-1"));

    // Steer with a referenced skill (injected reference context) and an image attachment, shaped
    // like `handle_turn_steer` materializes it.
    let accepted = steer
        .enqueue_steer_with_content(
            "Compare with this screenshot".into(),
            vec![
                text_block("Reference context for this steer:\n\nSKILL: review checklist"),
                text_block("Compare with this screenshot"),
                media(MediaKind::Image, "image/png", "iVBORw0KGgo="),
            ],
            None,
            None,
        )
        .unwrap();
    let image_request_id = accepted["steerRequestId"].as_str().unwrap().to_owned();
    steer.settle_native_deliveries().await;

    let requests = steer_requests(&log_path);
    assert_eq!(requests.len(), 1);
    let params = &requests[0]["params"];
    assert_eq!(params["threadId"], "codex-thr-1");
    assert_eq!(params["expectedTurnId"], "codex-turn-1");
    let input = params["input"].as_array().unwrap();
    assert_eq!(input.len(), 2, "{input:?}");
    assert_eq!(input[0]["type"], "text");
    let text = input[0]["text"].as_str().unwrap();
    assert!(text.contains("SKILL: review checklist"), "{text}");
    assert!(text.contains("Compare with this screenshot"), "{text}");
    assert_eq!(input[1]["type"], "image");
    assert_eq!(input[1]["url"], "data:image/png;base64,iVBORw0KGgo=");

    let delivered = steer.take_natively_delivered();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].request_id, image_request_id);
    assert!(!steer.has_pending());

    // Inline non-image data cannot ride the native input: no `turn/steer`, and the entry stays
    // owed to the provider so the next step submits it with its full content.
    steer
        .enqueue_steer_with_content(
            "See the attached spec".into(),
            vec![
                text_block("See the attached spec"),
                media(MediaKind::Document, "application/pdf", "JVBERi0="),
            ],
            None,
            None,
        )
        .unwrap();
    steer.settle_native_deliveries().await;
    assert_eq!(steer_requests(&log_path).len(), 1);
    assert!(steer.take_natively_delivered().is_empty());
    assert!(steer.has_pending());
    let pending = steer.drain_pending();
    assert_eq!(pending.len(), 1);
    assert!(!pending[0].delivered_natively);

    client.close().await;
    let _ = std::fs::remove_dir_all(&base);
}
