//! Native Codex approvals (`item/commandExecution/requestApproval`,
//! `item/fileChange/requestApproval` and their legacy aliases) must preserve the sandbox hard
//! floors the turn was started with (TS `assertApprovalPreservesPolicy`): escalation from a
//! scoped, read-only or network-disabled child is declined even under YOLO and never shown to the
//! user, and scoped file grants are checked against `grantRoot`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cowork_config::{ProviderName, SandboxConfig, SandboxMode};
use cowork_harness::{HarnessEventSink, InteractionManager, TurnStepRunner};
use cowork_providers::codex_app_server::DynamicToolHandler;
use cowork_sandbox::{ResolveSandboxPolicyInput, resolve_sandbox_policy};
use cowork_tools::{ToolExecutionContext, ToolMap};
use parking_lot::Mutex;
use serde_json::{Value, json};

const COMMAND: &str = "item/commandExecution/requestApproval";
const FILE_CHANGE: &str = "item/fileChange/requestApproval";
const LEGACY_COMMAND: &str = "execCommandApproval";
const LEGACY_PATCH: &str = "applyPatchApproval";

#[derive(Default)]
struct RecordingSink {
    server_requests: Mutex<Vec<(String, String, Value)>>,
}

impl HarnessEventSink for RecordingSink {
    fn send_notification(&self, _method: &str, _params: Value) {}
    fn send_server_request(&self, request_id: &str, method: &str, params: Value) {
        self.server_requests
            .lock()
            .push((request_id.to_owned(), method.to_owned(), params));
    }
}

#[derive(Default)]
struct Turn {
    yolo: bool,
    mode: Option<SandboxMode>,
    network: Option<bool>,
    read_only_role: bool,
    /// Relative to the workspace.
    targets: Vec<&'static str>,
}

struct Harness {
    _dir: tempfile::TempDir,
    ws: PathBuf,
    sink: Arc<RecordingSink>,
    interactions: Arc<InteractionManager>,
    bridge: Arc<dyn DynamicToolHandler>,
}

impl Harness {
    fn new(turn: Turn) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let ws = root.join("ws");
        let home = root.join("home");
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::create_dir_all(ws.join("docs")).unwrap();
        std::fs::create_dir_all(&home).unwrap();

        let mut ctx =
            ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::CodexCli, "m");
        let defaults = SandboxConfig::default();
        let config = SandboxConfig {
            mode: turn.mode.unwrap_or(defaults.mode),
            network: turn.network.unwrap_or(defaults.network),
            ..defaults
        };
        let targets: Vec<PathBuf> = turn.targets.iter().map(|t| ws.join(t)).collect();
        ctx.sandbox_policy = resolve_sandbox_policy(&ResolveSandboxPolicyInput {
            config: Some(config.clone()),
            working_directory: ws.clone(),
            project_root: Some(ws.clone()),
            output_directory: Some(ctx.output_directory.clone()),
            uploads_directory: Some(ctx.uploads_directory.clone()),
            tool_runtime_writable_roots: Vec::new(),
            target_paths: (!targets.is_empty()).then(|| {
                targets
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect()
            }),
            read_only_role: turn.read_only_role,
            yolo: turn.yolo,
            platform: None,
        });
        ctx.sandbox_config = config;
        ctx.yolo = turn.yolo;
        ctx.read_only_role = turn.read_only_role;
        ctx.target_paths = (!targets.is_empty()).then_some(targets);

        let sink = Arc::new(RecordingSink::default());
        // The session-level manager mirrors the turn's YOLO flag, as in production; the bridge
        // must decline floor-violating requests before ever reaching it.
        let interactions = Arc::new(
            InteractionManager::new("t", Arc::clone(&sink) as Arc<dyn HarnessEventSink>)
                .with_yolo(turn.yolo),
        );
        let bridge = TurnStepRunner::build_codex_dynamic_tool_handler(
            ToolMap::new(),
            ctx,
            Arc::clone(&interactions),
            None,
        );
        Self {
            _dir: dir,
            ws,
            sink,
            interactions,
            bridge,
        }
    }

    fn path(&self, rel: &str) -> String {
        self.ws.join(rel).to_string_lossy().into_owned()
    }

    fn prompts(&self) -> usize {
        self.sink.server_requests.lock().len()
    }

    /// Runs an approval that must be decided without asking the user.
    async fn decide_silently(&self, method: &str, params: Value) -> bool {
        let decision = tokio::time::timeout(
            Duration::from_secs(5),
            self.bridge.request_approval(method, &params),
        )
        .await
        .unwrap_or_else(|_| panic!("{method} {params} must not wait on the user"));
        assert_eq!(
            self.prompts(),
            0,
            "{method} {params} must never be shown to the user as approvable"
        );
        decision
    }

    /// Runs an approval that must be shown to the user, answering it with `approve`.
    async fn decide_interactively(&self, method: &str, params: Value, approve: bool) -> bool {
        let before = self.prompts();
        let bridge = Arc::clone(&self.bridge);
        let owned_method = method.to_owned();
        let call =
            tokio::spawn(async move { bridge.request_approval(&owned_method, &params).await });
        let mut request_id = None;
        for _ in 0..200 {
            if let Some((id, m, _)) = self.sink.server_requests.lock().get(before).cloned() {
                assert_eq!(m, COMMAND, "native approvals surface as command approvals");
                request_id = Some(id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let request_id = request_id.unwrap_or_else(|| panic!("{method} was never prompted"));
        self.interactions
            .resolve_client_response(&request_id, &json!({ "approved": approve }))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("approval must resolve after the user answers")
            .unwrap()
    }
}

fn command(cmd: &str) -> Value {
    json!({ "threadId": "th", "turnId": "tu", "itemId": "it", "command": cmd, "reason": "needs network" })
}

async fn assert_no_command_escalation(h: &Harness) {
    for method in [COMMAND, LEGACY_COMMAND] {
        assert!(
            !h.decide_silently(method, command("curl https://example.com"))
                .await,
            "{method} escalation must be declined"
        );
        assert!(
            !h.decide_silently(method, json!({ "command": ["ls", "-la"] }))
                .await,
            "even a harmless-looking {method} must be declined"
        );
    }
}

#[tokio::test]
async fn scoped_child_command_escalation_is_declined_even_under_yolo() {
    for yolo in [true, false] {
        let h = Harness::new(Turn {
            yolo,
            targets: vec!["src"],
            ..Turn::default()
        });
        assert_no_command_escalation(&h).await;
    }
}

#[tokio::test]
async fn read_only_child_command_escalation_is_declined_even_under_yolo() {
    for yolo in [true, false] {
        let read_only = Harness::new(Turn {
            yolo,
            mode: Some(SandboxMode::ReadOnly),
            ..Turn::default()
        });
        assert_no_command_escalation(&read_only).await;

        let explorer_role = Harness::new(Turn {
            yolo,
            read_only_role: true,
            ..Turn::default()
        });
        assert_no_command_escalation(&explorer_role).await;
    }
}

#[tokio::test]
async fn network_disabled_command_escalation_is_declined_even_under_yolo() {
    for yolo in [true, false] {
        for mode in [SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess] {
            let h = Harness::new(Turn {
                yolo,
                mode: Some(mode),
                network: Some(false),
                ..Turn::default()
            });
            assert_no_command_escalation(&h).await;
        }
    }
}

#[tokio::test]
async fn read_only_file_approval_is_declined_even_under_yolo() {
    for yolo in [true, false] {
        for turn in [
            Turn {
                yolo,
                mode: Some(SandboxMode::ReadOnly),
                ..Turn::default()
            },
            Turn {
                yolo,
                read_only_role: true,
                ..Turn::default()
            },
        ] {
            let h = Harness::new(turn);
            let grant = json!({ "grantRoot": h.path(""), "reason": "edit" });
            assert!(!h.decide_silently(FILE_CHANGE, grant.clone()).await);
            assert!(!h.decide_silently(LEGACY_PATCH, grant).await);
        }
    }
}

#[tokio::test]
async fn scoped_file_grant_outside_target_roots_is_declined() {
    for yolo in [true, false] {
        let h = Harness::new(Turn {
            yolo,
            targets: vec!["src"],
            ..Turn::default()
        });
        let outside = [
            // Grant root wider than the scope (the whole workspace).
            json!({ "grantRoot": h.path("") }),
            // Sibling directory.
            json!({ "grantRoot": h.path("docs") }),
            // Relative escape resolved against cwd.
            json!({ "grantRoot": "../docs", "cwd": h.path("src") }),
            // Root inside, but a listed path escapes.
            json!({ "grantRoot": h.path("src"), "path": h.path("docs/a.md") }),
            json!({ "grantRoot": h.path("src"), "paths": [h.path("src/a.rs"), h.path("Cargo.toml")] }),
            json!({ "grantRoot": h.path("src"), "files": ["/etc/passwd"] }),
            // Legacy `applyPatchApproval` paths live in `fileChanges` keys.
            json!({ "grantRoot": h.path("src"), "fileChanges": { h.path("docs/b.md"): { "type": "add" } } }),
            // Without an explicit grantRoot the extent of the grant is ambiguous.
            json!({ "path": h.path("src/a.rs") }),
            json!({ "grantRoot": "   ", "path": h.path("src/a.rs") }),
            // Ambiguous or malformed targets.
            json!({ "grantRoot": h.path("src"), "paths": [""] }),
            json!({ "grantRoot": h.path("src"), "paths": [42] }),
            json!({ "grantRoot": h.path("src"), "paths": h.path("src/a.rs") }),
        ];
        for params in outside {
            for method in [FILE_CHANGE, LEGACY_PATCH] {
                assert!(
                    !h.decide_silently(method, params.clone()).await,
                    "yolo={yolo}: {method} {params} must be declined"
                );
            }
        }
    }
}

#[tokio::test]
async fn scoped_file_grant_inside_target_roots_is_allowed() {
    let yolo = Harness::new(Turn {
        yolo: true,
        targets: vec!["src"],
        ..Turn::default()
    });
    let inside = [
        json!({ "grantRoot": yolo.path("src") }),
        json!({ "grantRoot": "src", "cwd": yolo.path("") }),
        json!({
            "grantRoot": yolo.path("src"),
            "path": yolo.path("src/a.rs"),
            "paths": [yolo.path("src/nested/b.rs")],
            "files": ["c.rs"],
            "cwd": yolo.path("src"),
        }),
        json!({ "grantRoot": yolo.path("src"), "fileChanges": { yolo.path("src/d.rs"): { "type": "add" } } }),
    ];
    for params in inside {
        for method in [FILE_CHANGE, LEGACY_PATCH] {
            assert!(
                yolo.decide_silently(method, params.clone()).await,
                "{method} {params} must be auto-accepted under yolo"
            );
        }
    }

    // Interactive scoped turns still ask the user and honor their answer.
    let interactive = Harness::new(Turn {
        targets: vec!["src"],
        ..Turn::default()
    });
    let grant =
        json!({ "grantRoot": interactive.path("src"), "path": interactive.path("src/a.rs") });
    assert!(
        interactive
            .decide_interactively(FILE_CHANGE, grant.clone(), true)
            .await
    );
    assert!(
        !interactive
            .decide_interactively(FILE_CHANGE, grant, false)
            .await
    );
    let (_, _, prompt) = interactive.sink.server_requests.lock()[0].clone();
    assert_eq!(prompt["category"], json!("filesystem"));
    assert!(
        prompt["command"]
            .as_str()
            .unwrap()
            .ends_with(&interactive.path("src")),
        "the prompt names the grant root: {prompt}"
    );
}

#[tokio::test]
async fn unrestricted_turn_approvals_behave_as_before() {
    // YOLO without hard floors: accepted automatically, never prompted.
    let yolo = Harness::new(Turn {
        yolo: true,
        ..Turn::default()
    });
    for method in [COMMAND, LEGACY_COMMAND] {
        assert!(
            yolo.decide_silently(method, command("curl https://example.com"))
                .await
        );
    }
    for method in [FILE_CHANGE, LEGACY_PATCH] {
        // Unscoped grants carry no path check, with or without grantRoot.
        assert!(
            yolo.decide_silently(method, json!({ "reason": "edit" }))
                .await
        );
        assert!(
            yolo.decide_silently(method, json!({ "grantRoot": "/somewhere/else" }))
                .await
        );
    }

    // Interactive without hard floors: the user decides.
    let interactive = Harness::new(Turn::default());
    assert!(
        interactive
            .decide_interactively(COMMAND, command("curl https://example.com"), true)
            .await
    );
    assert!(
        !interactive
            .decide_interactively(COMMAND, command("rm -rf build"), false)
            .await
    );
    assert!(
        interactive
            .decide_interactively(FILE_CHANGE, json!({ "reason": "edit" }), true)
            .await
    );
    let requests = interactive.sink.server_requests.lock().clone();
    assert_eq!(requests[0].2["command"], json!("curl https://example.com"));
    assert_eq!(requests[1].2["command"], json!("rm -rf build"));
}
