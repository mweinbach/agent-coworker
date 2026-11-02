//! `ModelBackedSkillImprover` on `codex-cli`: the Codex app-server runs its own agent loop and
//! calls the advertised improver tools back through `item/tool/call`, so they must execute in the
//! confined skill editor during the Codex turn (TS `SkillImprover` passes the same tools to the
//! Codex runtime, which executes them as dynamic tools). Driven by a mocked stdio app-server.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use cowork_config::{LoadConfigOptions, load_config};
use cowork_harness::skill_improvement::{
    ModelBackedSkillImprover, SkillImproverRunInput, SkillImproverRunner,
};
use serde_json::{Value, json};
use uuid::Uuid;

/// Mock app-server; logs every client message to `logPath`. On `turn/start` it issues the
/// dynamic tool calls from `callsJson` one at a time (each after the previous reply), then
/// completes the turn with a plain text answer.
const IMPROVER_MOCK: &str = r#"
import readline from "node:readline";
import fs from "node:fs";

const [, , logPath, callsJson] = process.argv;
const calls = JSON.parse(callsJson);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const threadId = "thr-1";
const turnId = "turn-1";
let next = 0;

const callNext = () => {
  if (next < calls.length) {
    const call = calls[next];
    send({ id: `srv-${next}`, method: "item/tool/call", params: { threadId, turnId, callId: `call-${next}`, ...call } });
    next += 1;
    return;
  }
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "f1", delta: "Done." } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(msg) + "\n");
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: turnId } } });
    callNext();
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, result: {} });
  } else if (msg.id !== undefined) {
    // The client's reply to one of our dynamic tool calls.
    callNext();
  }
});
"#;

const ORIGINAL_SKILL: &str =
    "---\nname: demo-skill\ndescription: Demo helper skill\n---\n# Demo\n\nOld guidance.\n";

struct Fixture {
    base: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("cowork-skill-imp-codex-{}", Uuid::new_v4()));
        fs::create_dir_all(base.join("home/.cowork/config")).unwrap();
        fs::create_dir_all(base.join("ws")).unwrap();
        fs::create_dir_all(base.join("builtin")).unwrap();
        fs::create_dir_all(base.join("skills/demo-skill")).unwrap();
        let base = fs::canonicalize(&base).unwrap();
        fs::write(base.join("skills/demo-skill/SKILL.md"), ORIGINAL_SKILL).unwrap();
        fs::write(base.join("mock_codex.mjs"), IMPROVER_MOCK).unwrap();
        Self { base }
    }

    fn skill_root(&self) -> PathBuf {
        self.base.join("skills/demo-skill")
    }

    fn skill_md(&self) -> PathBuf {
        self.skill_root().join("SKILL.md")
    }

    fn log_path(&self) -> PathBuf {
        self.base.join("codex.log")
    }

    fn logged(&self) -> Vec<Value> {
        fs::read_to_string(self.log_path())
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect()
    }

    async fn run(&self, calls: Value) -> cowork_harness::skill_improvement::SkillImproverRunResult {
        let home = self.base.join("home");
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".to_owned(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "PATH".to_owned(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        );
        env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
        env.insert("COWORK_CODEX_APP_SERVER_BIN".to_owned(), "node".to_owned());
        env.insert(
            "COWORK_CODEX_APP_SERVER_ARGS".to_owned(),
            json!([
                self.base.join("mock_codex.mjs").to_string_lossy(),
                self.log_path().to_string_lossy(),
                calls.to_string(),
            ])
            .to_string(),
        );
        let mut cfg = load_config(LoadConfigOptions {
            cwd: Some(self.base.join("ws")),
            homedir: Some(home),
            built_in_dir: Some(self.base.join("builtin")),
            env: Some(env.clone()),
        })
        .unwrap();
        cfg.skill_improvement_model = Some("codex-cli:gpt-5.4".to_owned());

        ModelBackedSkillImprover::new(env)
            .run(
                &cfg,
                SkillImproverRunInput {
                    skill_name: "demo-skill".to_owned(),
                    skill_root_dir: self.skill_root(),
                    skill_path: self.skill_md(),
                    source_kind: "user".to_owned(),
                    usage_events: Vec::new(),
                    transcripts: Vec::new(),
                    all_skills: Vec::new(),
                },
            )
            .await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

/// Text the client sent back for the `srv-<index>` dynamic tool call.
fn tool_reply(log: &[Value], index: usize) -> (String, bool) {
    let id = format!("srv-{index}");
    let reply = log
        .iter()
        .find(|m| m["id"] == json!(id) && m.get("method").is_none())
        .unwrap_or_else(|| panic!("no reply to {id}"));
    (
        reply["result"]["contentItems"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        reply["result"]["success"].as_bool().unwrap_or(false),
    )
}

#[tokio::test]
async fn codex_skill_improver_executes_dynamic_tools_in_the_confined_editor() {
    let fx = Fixture::new();
    let result = fx
        .run(json!([
            { "tool": "read_file", "arguments": { "path": "SKILL.md" } },
            {
                "tool": "edit_file",
                "arguments": {
                    "path": "SKILL.md",
                    "oldText": "Old guidance.",
                    "newText": "Improved guidance."
                }
            },
            { "tool": "finish", "arguments": { "summary": "  Clarified the guidance.  " } }
        ]))
        .await;

    assert!(result.ok, "run failed: {result:?}");
    assert!(result.changed, "the edit must be reported: {result:?}");
    assert_eq!(result.message, "Clarified the guidance.");
    assert_eq!(result.error, None);
    assert_eq!(
        fs::read_to_string(fx.skill_md()).unwrap(),
        ORIGINAL_SKILL.replace("Old guidance.", "Improved guidance.")
    );

    let log = fx.logged();
    let (read, read_ok) = tool_reply(&log, 0);
    assert!(read_ok);
    assert!(read.contains("Old guidance."), "read_file reply: {read}");
    assert_eq!(tool_reply(&log, 1), ("Edited SKILL.md".to_owned(), true));
    assert_eq!(
        tool_reply(&log, 2),
        ("Clarified the guidance.".to_owned(), true)
    );

    let thread = log
        .iter()
        .find(|m| m["method"] == "thread/start")
        .expect("thread/start");
    let names: Vec<&str> = thread["params"]["dynamicTools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    for tool in [
        "list_files",
        "read_file",
        "write_file",
        "edit_file",
        "finish",
    ] {
        assert!(names.contains(&tool), "{tool} not advertised: {names:?}");
    }
    // Edits go only through the confined tools; Codex's native tools cannot write.
    assert_eq!(thread["params"]["sandbox"], "read-only");
}

#[tokio::test]
async fn codex_skill_improver_rejects_escaping_paths_without_reporting_changes() {
    let fx = Fixture::new();
    let result = fx
        .run(json!([
            {
                "tool": "write_file",
                "arguments": { "path": "../outside.md", "content": "escaped" }
            },
            { "tool": "finish", "arguments": { "summary": "No changes needed." } }
        ]))
        .await;

    assert!(result.ok, "run failed: {result:?}");
    assert!(!result.changed);
    assert!(!fx.base.join("skills/outside.md").exists());
    assert_eq!(fs::read_to_string(fx.skill_md()).unwrap(), ORIGINAL_SKILL);
    let (text, ok) = tool_reply(&fx.logged(), 0);
    assert!(!ok);
    assert!(text.contains("escapes"), "write_file reply: {text}");
}
