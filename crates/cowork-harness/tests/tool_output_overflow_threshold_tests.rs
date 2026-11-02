//! `toolOutputOverflowChars` reaches the harness already resolved: an explicit `null` arrives as
//! `None` and must disable spilling, an absent setting resolves to the 25,000-char default at
//! config resolution, and an explicit number is used as-is. Both the batched path and the
//! deferred `toolCall` path must honour the resolved value.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{LoadConfigOptions, ProviderName, load_config};
use cowork_harness::{
    HarnessEventSink, InteractionManager, SteerCoordinator, TurnRunConfig, TurnStepRunner,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    SessionCostTracker, StepBudget, StopReason, StreamEvent, ToolResultPart, TurnUsage,
};
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};
use cowork_tools::{DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS, ToolExecutionContext};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use uuid::Uuid;

// bwrap re-executes the current binary as `__sandbox-exec --linux-seccomp`; dispatch it pre-libtest.
cowork_sandbox::install_sandbox_exec_test_hook!();

const CALL_ID: &str = "call_overflow_1";
/// Matches produce ~58 chars of grep output each.
const LARGE_MATCH_LINES: usize = 2_000;
/// Big enough to exceed a small explicit threshold, small enough to stay under 25,000.
const MID_MATCH_LINES: usize = 200;

struct TestDirs {
    root: PathBuf,
    home: PathBuf,
    ws: PathBuf,
}

impl TestDirs {
    fn new(prefix: &str) -> Self {
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = base.join(format!("cowork-harness-{prefix}-{}", Uuid::new_v4()));
        let home = root.join("home");
        let ws = root.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&ws).unwrap();
        Self {
            root: fs::canonicalize(&root).unwrap(),
            home: fs::canonicalize(home).unwrap(),
            ws: fs::canonicalize(ws).unwrap(),
        }
    }

    fn write_matches(&self, lines: usize) {
        let body: String = (0..lines)
            .map(|i| format!("needle-zz-{i:05}-{}\n", "x".repeat(30)))
            .collect();
        fs::write(self.ws.join("big.txt"), body).unwrap();
    }

    fn scratchpad_files(&self) -> Vec<PathBuf> {
        let dir = self.ws.join(".cowork").join(".cowork-scratchpad");
        match fs::read_dir(dir) {
            Ok(entries) => entries.map(|e| e.unwrap().path()).collect(),
            Err(_) => Vec::new(),
        }
    }
}

impl Drop for TestDirs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct NullSink;

impl HarnessEventSink for NullSink {
    fn send_notification(&self, _method: &str, _params: Value) {}
    fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
}

/// Step 1 issues one `grep` call (directly, or through deferred `toolCall`); step 2 finishes.
struct GrepThenStopTransport {
    deferred: bool,
    step: Mutex<usize>,
}

fn assistant_msg(blocks: Vec<ContentBlock>) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role: MessageRole::Assistant,
        content: blocks,
        phase: None,
        provider: Some("openai".to_owned()),
        api: None,
        model: Some("gpt-5.4".to_owned()),
        stop_reason: Some(StopReason::Stop),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T12:00:00.000Z".to_owned(),
    }
}

#[async_trait]
impl ProviderTransport for GrepThenStopTransport {
    async fn stream_step(
        &self,
        req: ProviderStepRequest,
        _budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let step = {
            let mut guard = self.step.lock();
            *guard += 1;
            *guard
        };
        let block = if step == 1 {
            let grep_args = json!({ "pattern": "needle-zz", "path": "big.txt" });
            let (name, args) = if self.deferred {
                (
                    "toolCall",
                    json!({ "name": "grep", "arguments": grep_args }),
                )
            } else {
                ("grep", grep_args)
            };
            let arguments: Map<String, Value> = serde_json::from_value(args).unwrap();
            on_event(StreamEvent::ToolCallStart {
                turn_id: req.turn_id.clone(),
                key: CALL_ID.to_owned(),
                name: name.to_owned(),
                initial_args: None,
            });
            on_event(StreamEvent::ToolCallEnd {
                turn_id: req.turn_id.clone(),
                key: CALL_ID.to_owned(),
                name: name.to_owned(),
                arguments: Some(arguments.clone()),
                input_digest: None,
                retry_of: None,
            });
            ContentBlock::ToolCall {
                id: CALL_ID.to_owned(),
                name: name.to_owned(),
                arguments,
                partial_json: None,
                provider_meta: ProviderOpaqueMeta::default(),
            }
        } else {
            ContentBlock::Text {
                text: "done".to_owned(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }
        };
        Ok(ProviderStepResult {
            assistant: assistant_msg(vec![block]),
            persisted_assistant: None,
            usage: TurnUsage::default(),
            continuation: None,
            raw_events: Vec::new(),
        })
    }
}

struct GrepResult {
    /// `structured_meta` of the tool result block.
    meta: Value,
    /// Concatenated text the model sees for the tool result.
    inline_text: String,
}

impl GrepResult {
    fn spilled(&self) -> bool {
        self.meta.get("overflow") == Some(&Value::Bool(true))
    }
}

async fn run_grep_turn(dirs: &TestDirs, deferred: bool, threshold: Option<usize>) -> GrepResult {
    let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
    let interactions = Arc::new(InteractionManager::new("thread-1", sink.clone()));
    let steer = Arc::new(SteerCoordinator::new(
        "thread-1",
        "turn-1",
        sink.clone(),
        None,
    ));
    let mut tool_ctx = ToolExecutionContext::new_for_tests(
        dirs.home.clone(),
        dirs.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    tool_ctx.approval_handler = Some(interactions.clone());
    let mut cost_tracker = SessionCostTracker::new("thread-1", None);

    let runner = TurnStepRunner::new(TurnRunConfig {
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: Some("test-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Test system prompt".to_owned(),
        provider_options: Default::default(),
        deferred_tool_search: deferred,
        max_steps: 5,
        step_timeout_ms: 30_000,
        overflow_threshold_chars: threshold,
        tool_retry_lineage: false,
        initial_user_message: None,
        model_max_retries: None,
    });
    let transport = Arc::new(GrepThenStopTransport {
        deferred,
        step: Mutex::new(0),
    });
    let initial = vec![CanonicalMessage {
        id: "u1".to_owned(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "grep big.txt".to_owned(),
            phase: None,
            citations: Vec::new(),
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T12:00:00Z".to_owned(),
    }];

    let outcome = runner
        .run_turn(
            transport,
            initial,
            &mut tool_ctx,
            &interactions,
            &steer,
            &mut cost_tracker,
            None,
            sink,
        )
        .await;
    assert_eq!(outcome.status, "completed");

    outcome
        .messages
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|block| match block {
            ContentBlock::ToolResult {
                tool_call_id,
                content,
                structured_meta,
                is_error,
                ..
            } if tool_call_id == CALL_ID => {
                assert!(!is_error, "grep failed: {structured_meta:?}");
                let inline_text = content
                    .iter()
                    .filter_map(|p| match p {
                        ToolResultPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Some(GrepResult {
                    meta: structured_meta.clone().unwrap_or(Value::Null),
                    inline_text,
                })
            }
            _ => None,
        })
        .expect("tool result for the grep call")
}

fn assert_full_inline(result: &GrepResult, lines: usize) {
    assert!(!result.spilled(), "unexpected spill: {}", result.meta);
    assert_eq!(
        result.inline_text.matches("needle-zz-").count(),
        lines,
        "every match must stay inline"
    );
}

fn assert_spilled(result: &GrepResult, dirs: &TestDirs) {
    assert!(result.spilled(), "expected spill pointer: {}", result.meta);
    let path = PathBuf::from(result.meta["filePath"].as_str().unwrap());
    assert!(path.starts_with(dirs.ws.join(".cowork").join(".cowork-scratchpad")));
    assert!(path.is_file(), "spill file missing: {}", path.display());
}

#[tokio::test]
async fn explicit_null_threshold_keeps_large_output_inline_without_spill_file() {
    let dirs = TestDirs::new("overflow-null");
    dirs.write_matches(LARGE_MATCH_LINES);

    let result = run_grep_turn(&dirs, false, None).await;

    assert!(result.inline_text.chars().count() > DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);
    assert_full_inline(&result, LARGE_MATCH_LINES);
    assert!(dirs.scratchpad_files().is_empty(), "no spill file expected");
}

#[tokio::test]
async fn explicit_null_threshold_keeps_large_deferred_tool_call_output_inline_without_spill_file() {
    let dirs = TestDirs::new("overflow-null-deferred");
    dirs.write_matches(LARGE_MATCH_LINES);

    let result = run_grep_turn(&dirs, true, None).await;

    assert!(result.inline_text.chars().count() > DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);
    assert_full_inline(&result, LARGE_MATCH_LINES);
    assert!(dirs.scratchpad_files().is_empty(), "no spill file expected");
}

#[tokio::test]
async fn default_threshold_spills_only_output_above_25k_on_both_paths() {
    for deferred in [false, true] {
        let dirs = TestDirs::new("overflow-default");
        dirs.write_matches(MID_MATCH_LINES);
        let kept = run_grep_turn(&dirs, deferred, Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS)).await;
        assert_full_inline(&kept, MID_MATCH_LINES);
        assert!(dirs.scratchpad_files().is_empty());

        dirs.write_matches(LARGE_MATCH_LINES);
        let spilled =
            run_grep_turn(&dirs, deferred, Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS)).await;
        assert_spilled(&spilled, &dirs);
        assert!(
            spilled.inline_text.chars().count() < DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS,
            "inline output must be replaced by the pointer"
        );
    }
}

#[tokio::test]
async fn explicit_threshold_is_used_as_is_on_both_paths() {
    for deferred in [false, true] {
        let dirs = TestDirs::new("overflow-explicit");
        dirs.write_matches(MID_MATCH_LINES);

        // Under the 25k default, but above the explicit 2,000-char threshold.
        let result = run_grep_turn(&dirs, deferred, Some(2_000)).await;

        assert_spilled(&result, &dirs);
        let total = result.meta["totalChars"].as_u64().unwrap() as usize;
        assert!(total > 2_000 && total < DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf()
}

/// Resolves the workspace config with `toolOutputOverflowChars` set to `raw` (or absent when
/// `None`) and returns the threshold the server hands to the harness.
fn resolved_threshold(dirs: &TestDirs, raw: Option<Value>) -> Option<usize> {
    let mut project = Map::new();
    if let Some(raw) = raw {
        project.insert("toolOutputOverflowChars".to_owned(), raw);
    }
    let cfg_path = dirs.ws.join(".cowork").join("config.json");
    fs::create_dir_all(cfg_path.parent().unwrap()).unwrap();
    fs::write(&cfg_path, Value::Object(project).to_string()).unwrap();

    let userdata = dirs.root.join("userdata").to_string_lossy().into_owned();
    let home = dirs.home.to_string_lossy().into_owned();
    let env = HashMap::from([
        ("HOME".to_owned(), home.clone()),
        ("COWORK_HOME_OVERRIDE".to_owned(), home),
        ("COWORK_ELECTRON_USER_DATA_DIR".to_owned(), userdata.clone()),
        ("COWORK_DESKTOP_USER_DATA_DIR".to_owned(), userdata),
        ("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned()),
        ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
    ]);
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(dirs.ws.clone()),
        homedir: Some(dirs.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(env),
    })
    .unwrap();
    fs::remove_file(&cfg_path).unwrap();
    cfg.tool_output_overflow_chars.map(|n| n as usize)
}

#[tokio::test]
async fn config_resolution_distinguishes_absent_null_and_explicit_threshold() {
    let dirs = TestDirs::new("overflow-config");

    let absent = resolved_threshold(&dirs, None);
    assert_eq!(absent, Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));
    let null = resolved_threshold(&dirs, Some(Value::Null));
    assert_eq!(null, None);
    let explicit = resolved_threshold(&dirs, Some(json!(2_000)));
    assert_eq!(explicit, Some(2_000));

    // Resolved `null` flows through the harness with spilling disabled; resolved absent spills.
    dirs.write_matches(LARGE_MATCH_LINES);
    let kept = run_grep_turn(&dirs, true, null).await;
    assert_full_inline(&kept, LARGE_MATCH_LINES);
    assert!(dirs.scratchpad_files().is_empty());
    let spilled = run_grep_turn(&dirs, false, absent).await;
    assert_spilled(&spilled, &dirs);
}
