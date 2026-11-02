//! TS `src/tools/threadManagement.ts` parity for the agent-facing thread tools:
//! - `send_message_to_thread` takes the follow-up text as `prompt` (required, strict schema).
//!   The former Rust `message` argument stays accepted as a deprecated alias that is folded
//!   into `prompt`; conflicting `prompt`/`message` values are rejected.
//! - `fork_thread` takes an optional `threadId` that defaults to the current (calling) thread
//!   (TS `ThreadManagementService.createControl(currentThreadId)`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_tools::thread_tools::{SEND_MESSAGE_PROMPT_CONFLICT, resolve_send_message_prompt_alias};
use cowork_tools::{ThreadControlBridge, ThreadManagementTool, ToolError, ToolExecutionContext};
use serde_json::{Map, Value, json};

#[derive(Default)]
struct RecordingBridge {
    sends: Mutex<Vec<Value>>,
    forks: Mutex<Vec<Value>>,
    setters: Mutex<Vec<(&'static str, Value)>>,
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
        self.sends.lock().unwrap().push(args.clone());
        Ok(args)
    }
    async fn fork_thread(&self, args: Value) -> Result<Value, String> {
        self.forks.lock().unwrap().push(args.clone());
        Ok(args)
    }
    async fn set_thread_title(&self, args: Value) -> Result<Value, String> {
        self.setters
            .lock()
            .unwrap()
            .push(("set_thread_title", args.clone()));
        Ok(args)
    }
    async fn set_thread_pinned(&self, args: Value) -> Result<Value, String> {
        self.setters
            .lock()
            .unwrap()
            .push(("set_thread_pinned", args.clone()));
        Ok(args)
    }
    async fn set_thread_archived(&self, args: Value) -> Result<Value, String> {
        self.setters
            .lock()
            .unwrap()
            .push(("set_thread_archived", args.clone()));
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
    ctx.session_id = "calling-thread".to_owned();
    ctx.thread_control = Some(bridge);
    (dir, ctx)
}

fn required(schema: &Value) -> Vec<String> {
    schema["required"]
        .as_array()
        .map(|r| {
            r.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn schemas_advertise_ts_arguments() {
    let send = tool("send_message_to_thread").input_schema();
    // TS `resolveThreadId`: send/read default to the calling thread when threadId is omitted.
    assert_eq!(required(&send), vec!["prompt"], "{send}");
    assert!(send["properties"].get("threadId").is_some(), "{send}");
    assert_eq!(send["properties"]["prompt"]["type"], json!("string"));
    assert!(send["properties"].get("message").is_none(), "{send}");

    let read = tool("read_thread").input_schema();
    assert!(required(&read).is_empty(), "{read}");
    assert!(read["properties"].get("threadId").is_some(), "{read}");

    let fork = tool("fork_thread").input_schema();
    assert!(!required(&fork).contains(&"threadId".to_owned()), "{fork}");
    assert!(fork["properties"].get("threadId").is_some(), "{fork}");

    for (name, field) in [
        ("set_thread_title", "title"),
        ("set_thread_pinned", "pinned"),
        ("set_thread_archived", "archived"),
    ] {
        let schema = tool(name).input_schema();
        assert_eq!(required(&schema), vec![field], "{schema}");
        assert!(schema["properties"].get("threadId").is_some(), "{schema}");
    }

    let umbrella = tool("threadManagement").input_schema();
    assert!(
        umbrella["properties"].get("message").is_none(),
        "{umbrella}"
    );
    assert_eq!(umbrella["properties"]["prompt"]["type"], json!("string"));
}

#[test]
fn alias_resolution_folds_message_into_prompt() {
    let mut only_message = args(json!({ "threadId": "t", "message": "hi" }));
    resolve_send_message_prompt_alias(&mut only_message).unwrap();
    assert_eq!(
        Value::Object(only_message),
        json!({ "threadId": "t", "prompt": "hi" })
    );

    let mut same = args(json!({ "prompt": "hi", "message": " hi " }));
    resolve_send_message_prompt_alias(&mut same).unwrap();
    assert_eq!(Value::Object(same), json!({ "prompt": "hi" }));

    let mut null_prompt = args(json!({ "prompt": null, "message": "hi" }));
    resolve_send_message_prompt_alias(&mut null_prompt).unwrap();
    assert_eq!(Value::Object(null_prompt), json!({ "prompt": "hi" }));

    let mut null_message = args(json!({ "prompt": "hi", "message": null }));
    resolve_send_message_prompt_alias(&mut null_message).unwrap();
    assert_eq!(Value::Object(null_message), json!({ "prompt": "hi" }));

    let mut conflict = args(json!({ "prompt": "a", "message": "b" }));
    assert_eq!(
        resolve_send_message_prompt_alias(&mut conflict).unwrap_err(),
        SEND_MESSAGE_PROMPT_CONFLICT
    );
}

#[tokio::test]
async fn send_message_tool_forwards_prompt_and_accepts_message_alias() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(bridge.clone());

    for name in ["send_message_to_thread", "threadManagement"] {
        for input in [
            json!({ "threadId": "t", "prompt": "do it" }),
            json!({ "threadId": "t", "message": "do it" }),
            json!({ "threadId": "t", "prompt": "do it", "message": "do it" }),
        ] {
            let mut input = input;
            if name == "threadManagement" {
                input["action"] = json!("send_message_to_thread");
            }
            tool(name)
                .execute(args(input.clone()), &ctx)
                .await
                .unwrap_or_else(|e| panic!("{name} {input}: {e}"));
        }

        // Neither prompt nor message: TS rejects the missing required prompt. The umbrella
        // tool leaves the check to the bridge (its schema serves every action).
        if name == "send_message_to_thread" {
            let err = tool(name)
                .execute(args(json!({ "threadId": "t" })), &ctx)
                .await
                .unwrap_err();
            assert!(matches!(err, ToolError::InvalidArguments(_)), "{err}");
        }

        let mut conflict = json!({ "threadId": "t", "prompt": "a", "message": "b" });
        if name == "threadManagement" {
            conflict["action"] = json!("send_message_to_thread");
        }
        let err = tool(name).execute(args(conflict), &ctx).await.unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidArguments(msg) if msg == SEND_MESSAGE_PROMPT_CONFLICT),
            "{err}"
        );
    }

    let sends = bridge.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 6, "{sends:?}");
    for sent in &sends {
        assert_eq!(sent["prompt"], json!("do it"), "{sent}");
        assert!(sent.get("message").is_none(), "{sent}");
    }
}

#[tokio::test]
async fn fork_thread_defaults_to_the_calling_thread() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(bridge.clone());

    tool("fork_thread")
        .execute(args(json!({})), &ctx)
        .await
        .unwrap();
    tool("fork_thread")
        .execute(args(json!({ "threadId": null, "title": "copy" })), &ctx)
        .await
        .unwrap();
    tool("threadManagement")
        .execute(args(json!({ "action": "fork_thread" })), &ctx)
        .await
        .unwrap();
    // An explicit threadId is kept.
    tool("fork_thread")
        .execute(args(json!({ "threadId": "other" })), &ctx)
        .await
        .unwrap();
    tool("threadManagement")
        .execute(
            args(json!({ "action": "fork_thread", "threadId": "other" })),
            &ctx,
        )
        .await
        .unwrap();

    let forks = bridge.forks.lock().unwrap().clone();
    let ids: Vec<&str> = forks
        .iter()
        .map(|f| f["threadId"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "calling-thread",
            "calling-thread",
            "calling-thread",
            "other",
            "other"
        ]
    );
}

#[tokio::test]
async fn thread_setters_default_to_the_calling_thread() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(bridge.clone());

    let cases = [
        ("set_thread_title", json!({ "title": "Renamed" })),
        ("set_thread_pinned", json!({ "pinned": true })),
        ("set_thread_archived", json!({ "archived": false })),
    ];
    for (name, extra) in &cases {
        // Direct tool, threadId omitted.
        tool(name).execute(args(extra.clone()), &ctx).await.unwrap();
        // Direct tool, explicit null threadId.
        let mut with_null = extra.clone();
        with_null["threadId"] = Value::Null;
        tool(name).execute(args(with_null), &ctx).await.unwrap();
        // Umbrella tool, threadId omitted.
        let mut umbrella = extra.clone();
        umbrella["action"] = json!(name);
        tool("threadManagement")
            .execute(args(umbrella.clone()), &ctx)
            .await
            .unwrap();
        // An explicit threadId is kept, on both tools.
        let mut explicit = extra.clone();
        explicit["threadId"] = json!("other");
        tool(name).execute(args(explicit), &ctx).await.unwrap();
        umbrella["threadId"] = json!("other");
        tool("threadManagement")
            .execute(args(umbrella), &ctx)
            .await
            .unwrap();
    }

    let calls = bridge.setters.lock().unwrap().clone();
    assert_eq!(calls.len(), cases.len() * 5);
    for (chunk, (name, extra)) in calls.chunks(5).zip(cases.iter()) {
        let ids: Vec<&str> = chunk
            .iter()
            .map(|(called, args)| {
                assert_eq!(called, name);
                let field = extra.as_object().unwrap().keys().next().unwrap();
                assert_eq!(args[field], extra[field], "{name}: {args}");
                args["threadId"].as_str().unwrap()
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                "calling-thread",
                "calling-thread",
                "calling-thread",
                "other",
                "other"
            ],
            "{name}"
        );
    }
}

/// TS `resolveThreadId` also covers `read_thread` and `send_message_to_thread`: an omitted
/// `threadId` targets the calling thread, an explicit one is kept.
#[tokio::test]
async fn read_and_send_default_to_the_calling_thread() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(bridge.clone());

    let read = tool("read_thread")
        .execute(args(json!({})), &ctx)
        .await
        .unwrap();
    assert_eq!(read.to_json_value()["threadId"], json!("calling-thread"));
    let read_umbrella = tool("threadManagement")
        .execute(args(json!({ "action": "read_thread" })), &ctx)
        .await
        .unwrap();
    assert_eq!(
        read_umbrella.to_json_value()["threadId"],
        json!("calling-thread")
    );
    let read_explicit = tool("read_thread")
        .execute(args(json!({ "threadId": "other" })), &ctx)
        .await
        .unwrap();
    assert_eq!(read_explicit.to_json_value()["threadId"], json!("other"));

    tool("send_message_to_thread")
        .execute(args(json!({ "prompt": "hi" })), &ctx)
        .await
        .unwrap();
    tool("threadManagement")
        .execute(
            args(json!({ "action": "send_message_to_thread", "prompt": "hi" })),
            &ctx,
        )
        .await
        .unwrap();
    tool("send_message_to_thread")
        .execute(args(json!({ "threadId": "other", "prompt": "hi" })), &ctx)
        .await
        .unwrap();
    let sends = bridge.sends.lock().unwrap().clone();
    let ids: Vec<&str> = sends
        .iter()
        .map(|s| s["threadId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["calling-thread", "calling-thread", "other"]);
}
