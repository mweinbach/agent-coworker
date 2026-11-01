//! Regression: with `memoryRequireApproval` enabled, `memory` writes must ask the user first and
//! must not touch storage unless the answer is "approve" (legacy `src/tools/memory.ts`).

use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{LoadConfigOptions, ProviderName, load_config};
use cowork_storage::{MemoryScope, MemoryStore};
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, ToolExecutionContext, ToolOutput,
    create_builtin_tools,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

struct ScriptedAsker {
    answer: String,
    questions: Mutex<Vec<(String, Option<Vec<String>>)>>,
}

#[async_trait]
impl ApprovalHandler for ScriptedAsker {
    async fn approve_command(&self, _req: ApprovalDecisionRequest) -> Result<bool, String> {
        Ok(true)
    }

    async fn ask_user(
        &self,
        question: &str,
        options: Option<Vec<String>>,
    ) -> Result<String, String> {
        self.questions.lock().push((question.to_owned(), options));
        Ok(self.answer.clone())
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    ctx: ToolExecutionContext,
    store: Arc<MemoryStore>,
}

fn fixture(require_approval: bool) -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let home = root.join("home");
    let ws = root.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&ws).unwrap();

    let mut cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        ..Default::default()
    })
    .expect("load config");
    cfg.memory_require_approval = require_approval;

    let store = Arc::new(MemoryStore::new(
        ws.join(".cowork/memory.sqlite"),
        home.join(".cowork/memory.sqlite"),
    ));
    let mut ctx = ToolExecutionContext::new_for_tests(home, ws, ProviderName::Openai, "gpt-5.4");
    ctx.agent_config = Some(Arc::new(cfg));
    ctx.memory_store = Some(Arc::clone(&store));
    Fixture {
        _tmp: tmp,
        ctx,
        store,
    }
}

fn asker(answer: &str) -> Arc<ScriptedAsker> {
    Arc::new(ScriptedAsker {
        answer: answer.to_owned(),
        questions: Mutex::new(Vec::new()),
    })
}

async fn write_memory(ctx: &ToolExecutionContext) -> ToolOutput {
    let tools = create_builtin_tools(ctx);
    let args: Map<String, Value> = serde_json::from_value(json!({
        "action": "write",
        "key": "AGENT.md",
        "content": "Prefer small commits.",
        "scope": "workspace"
    }))
    .unwrap();
    tools
        .get("memory")
        .expect("memory tool")
        .execute(args, ctx)
        .await
        .expect("memory write")
}

fn stored_entries(store: &MemoryStore) -> Vec<String> {
    store
        .list(Some(MemoryScope::Workspace))
        .expect("list memory")
        .into_iter()
        .map(|e| e.content)
        .collect()
}

#[tokio::test]
async fn approved_write_asks_then_persists() {
    let mut f = fixture(true);
    let handler = asker("approve");
    f.ctx.approval_handler = Some(handler.clone());

    let out = write_memory(&f.ctx).await;
    assert_eq!(out.to_json_value()["ok"], json!(true), "{out:?}");
    assert_eq!(stored_entries(&f.store), vec!["Prefer small commits."]);
    let questions = handler.questions.lock();
    assert_eq!(questions.len(), 1);
    assert_eq!(questions[0].0, "Allow saving this memory?");
    assert_eq!(
        questions[0].1,
        Some(vec!["approve".to_owned(), "deny".to_owned()])
    );
}

#[tokio::test]
async fn denied_write_does_not_touch_storage() {
    let mut f = fixture(true);
    let handler = asker("deny");
    f.ctx.approval_handler = Some(handler.clone());

    let out = write_memory(&f.ctx).await;
    assert_eq!(
        out.as_text().as_deref(),
        Some("Memory save denied by user."),
        "{out:?}"
    );
    assert!(stored_entries(&f.store).is_empty());
    assert_eq!(handler.questions.lock().len(), 1);
}

#[tokio::test]
async fn required_approval_without_handler_denies() {
    let f = fixture(true);
    assert!(f.ctx.approval_handler.is_none());

    let out = write_memory(&f.ctx).await;
    assert_eq!(
        out.as_text().as_deref(),
        Some("Memory save denied by user."),
        "{out:?}"
    );
    assert!(stored_entries(&f.store).is_empty());

    // A context that cannot ask the user (e.g. a task worker) is also denied.
    let mut f = fixture(true);
    let handler = asker("approve");
    f.ctx.approval_handler = Some(handler.clone());
    f.ctx.can_ask_user = false;
    let out = write_memory(&f.ctx).await;
    assert_eq!(
        out.as_text().as_deref(),
        Some("Memory save denied by user."),
        "{out:?}"
    );
    assert!(stored_entries(&f.store).is_empty());
    assert!(handler.questions.lock().is_empty());
}

#[tokio::test]
async fn approval_not_required_writes_without_asking() {
    let mut f = fixture(false);
    let handler = asker("deny");
    f.ctx.approval_handler = Some(handler.clone());

    let out = write_memory(&f.ctx).await;
    assert_eq!(out.to_json_value()["ok"], json!(true), "{out:?}");
    assert_eq!(stored_entries(&f.store), vec!["Prefer small commits."]);
    assert!(handler.questions.lock().is_empty());
}
