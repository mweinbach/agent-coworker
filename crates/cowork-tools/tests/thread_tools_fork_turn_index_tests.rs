//! TS `fork_thread` has no turn cutoff: its input schema is strict and has no `fromTurnIndex`,
//! and a fork always copies the source thread's whole history. The Rust tools used to
//! advertise and accept `fromTurnIndex` but never forward it, so a "fork from turn N" silently
//! copied every later turn too. The argument is now absent from the schemas and rejected
//! before the bridge is ever called.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_tools::thread_tools::FORK_FROM_TURN_INDEX_UNSUPPORTED;
use cowork_tools::{ThreadControlBridge, ThreadManagementTool, ToolError, ToolExecutionContext};
use serde_json::{Map, Value, json};

#[derive(Default)]
struct RecordingBridge {
    forks: Mutex<Vec<Value>>,
}

#[async_trait]
impl ThreadControlBridge for RecordingBridge {
    async fn list_projects(&self) -> Result<Value, String> {
        Ok(json!({ "projects": [] }))
    }
    async fn list_threads(&self, _args: Value) -> Result<Value, String> {
        Ok(json!({ "threads": [] }))
    }
    async fn read_thread(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
    async fn create_thread(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
    async fn send_message_to_thread(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
    async fn fork_thread(&self, args: Value) -> Result<Value, String> {
        self.forks.lock().unwrap().push(args.clone());
        Ok(json!({ "forked": args }))
    }
    async fn set_thread_title(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
    async fn set_thread_pinned(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
    async fn set_thread_archived(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
}

fn tool(name: &str) -> Arc<dyn cowork_tools::BuiltinTool> {
    ThreadManagementTool::all_tools()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("missing tool {name}"))
}

fn args(value: Value) -> Map<String, Value> {
    serde_json::from_value(value).unwrap()
}

fn root_ctx(bridge: Arc<RecordingBridge>) -> (tempfile::TempDir, ToolExecutionContext) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let ws = dir.path().join("ws");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&ws).unwrap();
    let mut ctx = ToolExecutionContext::new_for_tests(home, ws, ProviderName::Openai, "gpt-5.4");
    ctx.thread_control = Some(bridge);
    (dir, ctx)
}

#[test]
fn fork_schemas_do_not_advertise_from_turn_index() {
    for name in ["fork_thread", "threadManagement"] {
        let schema = tool(name).input_schema();
        assert!(
            schema["properties"].get("fromTurnIndex").is_none(),
            "{name} still advertises fromTurnIndex: {schema}"
        );
    }
}

#[tokio::test]
async fn fork_thread_rejects_from_turn_index_instead_of_forking_everything() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(bridge.clone());

    for index in [json!(0), json!(1), json!(99)] {
        let err = tool("fork_thread")
            .execute(
                args(json!({ "threadId": "src", "fromTurnIndex": index })),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidArguments(msg) if msg == FORK_FROM_TURN_INDEX_UNSUPPORTED),
            "{err}"
        );

        let err = tool("threadManagement")
            .execute(
                args(json!({
                    "action": "fork_thread",
                    "threadId": "src",
                    "fromTurnIndex": index
                })),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidArguments(msg) if msg == FORK_FROM_TURN_INDEX_UNSUPPORTED),
            "{err}"
        );
    }
    assert!(
        bridge.forks.lock().unwrap().is_empty(),
        "a fork was created despite the unsupported cutoff"
    );

    // Without the cutoff (or with an explicit null, which models emit for omitted optionals)
    // the fork still goes through.
    tool("fork_thread")
        .execute(args(json!({ "threadId": "src" })), &ctx)
        .await
        .unwrap();
    tool("threadManagement")
        .execute(
            args(json!({
                "action": "fork_thread",
                "threadId": "src",
                "fromTurnIndex": null
            })),
            &ctx,
        )
        .await
        .unwrap();
    let forks = bridge.forks.lock().unwrap().clone();
    assert_eq!(forks.len(), 2, "{forks:?}");
    assert!(forks.iter().all(|f| f["threadId"] == json!("src")));
}
