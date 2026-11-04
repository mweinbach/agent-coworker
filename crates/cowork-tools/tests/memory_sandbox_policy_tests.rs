//! Regression: memory stores live outside the OS sandbox (host-side SQLite for `memory`, Markdown
//! files for `manageMemory`), so a root session whose effective sandbox policy is `read-only` or
//! `no-project-write` must not mutate them even though its role is writable. Mirrors TS
//! `assertSandboxAllowsMemoryMutation` in origin/main `src/tools/memory.ts` and
//! `src/tools/manageMemory.ts`; reads stay allowed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_sandbox::SandboxPolicy;
use cowork_storage::{MemoryScope, MemoryStore};
use cowork_tools::{
    AdvancedMemoryStore, BuiltinTool, ManageMemoryTool, MemoryTool, RecallMemoryTool, ToolError,
    ToolExecutionContext,
};
use serde_json::{Map, Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    memory_store: Arc<MemoryStore>,
    advanced_store: Arc<AdvancedMemoryStore>,
    ctx: ToolExecutionContext,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = fs::canonicalize(tmp.path()).expect("canonical tmp");
    let home = root.join("home");
    let ws = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let cowork_home = home.join(".cowork");

    let memory_store = Arc::new(MemoryStore::new(
        ws.join(".cowork/memory.sqlite"),
        cowork_home.join("memory.sqlite"),
    ));
    let advanced_store = Arc::new(AdvancedMemoryStore::new(
        cowork_home.clone(),
        ws.clone(),
        cowork_home.join("workspaces").join("chats"),
    ));
    let mut ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    ctx.memory_store = Some(Arc::clone(&memory_store));
    ctx.advanced_memory = true;
    ctx.advanced_memory_store = Some(Arc::clone(&advanced_store));
    ctx.sandbox_policy = workspace_write(&ws);
    assert!(!ctx.read_only_role, "fixture must be a writable root role");
    Fixture {
        _tmp: tmp,
        ws,
        memory_store,
        advanced_store,
        ctx,
    }
}

fn workspace_write(ws: &Path) -> SandboxPolicy {
    SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.to_path_buf()],
        writable_root_kinds: Default::default(),
        network: false,
    }
}

fn restricted_policies(ws: &Path) -> Vec<(SandboxPolicy, &'static str)> {
    vec![
        (SandboxPolicy::ReadOnly { network: false }, "read-only"),
        (
            SandboxPolicy::NoProjectWrite {
                project_roots: vec![ws.to_path_buf()],
                network: false,
            },
            "no-project-write",
        ),
    ]
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn expect_denied(result: Result<cowork_tools::ToolOutput, ToolError>, expected: &str) {
    match result {
        Err(ToolError::PathDenied(msg)) => assert_eq!(msg, expected),
        other => panic!("expected PathDenied({expected:?}), got {other:?}"),
    }
}

/// Every stored SQLite entry across both scopes, with timestamps, so any mutation shows up.
fn sqlite_snapshot(store: &MemoryStore) -> Vec<(String, String, String)> {
    let mut rows: Vec<_> = store
        .list(None)
        .expect("list memory")
        .into_iter()
        .map(|e| (e.id, e.content, e.updated_at))
        .collect();
    rows.sort();
    rows
}

/// Every file under the advanced-memory base directory, keyed by relative path.
fn tree_snapshot(base: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for item in rd.flatten() {
            let p = item.path();
            if p.is_dir() {
                out.insert(
                    format!("{}/", p.strip_prefix(base).unwrap().display()),
                    String::new(),
                );
                walk(base, &p, out);
            } else {
                out.insert(
                    p.strip_prefix(base).unwrap().display().to_string(),
                    fs::read_to_string(&p).unwrap_or_default(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(base, base, &mut out);
    out
}

#[tokio::test]
async fn memory_write_and_delete_are_rejected_under_restricted_sandbox_policies() {
    let f = fixture();
    // Seed under workspace-write so delete has something to remove.
    MemoryTool
        .execute(
            args(json!({ "action": "write", "key": "AGENT.md", "content": "seeded" })),
            &f.ctx,
        )
        .await
        .expect("seed write under workspace-write");
    let before = sqlite_snapshot(&f.memory_store);
    assert_eq!(before.len(), 1, "{before:?}");

    for (policy, kind) in restricted_policies(&f.ws) {
        let mut ctx = f.ctx.clone();
        ctx.sandbox_policy = policy;
        let expected = format!("memory mutation blocked: sandbox is {kind}.");

        for scope in ["workspace", "global"] {
            expect_denied(
                MemoryTool
                    .execute(
                        args(json!({
                            "action": "write",
                            "key": "AGENT.md",
                            "content": "overwritten",
                            "scope": scope
                        })),
                        &ctx,
                    )
                    .await,
                &expected,
            );
            expect_denied(
                MemoryTool
                    .execute(
                        args(json!({ "action": "delete", "key": "AGENT.md", "scope": scope })),
                        &ctx,
                    )
                    .await,
                &expected,
            );
        }
        assert_eq!(sqlite_snapshot(&f.memory_store), before, "policy {kind}");

        // Reads and searches are not mutations and stay allowed.
        let read = MemoryTool
            .execute(args(json!({ "action": "read", "key": "AGENT.md" })), &ctx)
            .await
            .expect("read allowed")
            .as_text()
            .unwrap();
        assert_eq!(read, "seeded", "policy {kind}");
        let found = MemoryTool
            .execute(args(json!({ "action": "search", "query": "seeded" })), &ctx)
            .await
            .expect("search allowed")
            .as_text()
            .unwrap();
        assert!(found.contains("seeded"), "policy {kind}: {found}");
    }
}

#[tokio::test]
async fn manage_memory_mutations_are_rejected_under_restricted_sandbox_policies() {
    let f = fixture();
    f.advanced_store
        .upsert_entry(
            "workspace",
            None,
            "Build Commands",
            "Build Commands",
            "How to build",
            "project",
            "cargo build",
        )
        .expect("seed advanced memory");
    let base = f.advanced_store.memories_base_dir();
    let before = tree_snapshot(&base);
    assert!(
        before.keys().any(|k| k.ends_with("build-commands.md")),
        "{before:?}"
    );

    for (policy, kind) in restricted_policies(&f.ws) {
        let mut ctx = f.ctx.clone();
        ctx.sandbox_policy = policy;
        let expected = format!("manageMemory mutation blocked: sandbox is {kind}.");

        for scope in ["workspace", "global"] {
            for action in ["create", "update"] {
                expect_denied(
                    ManageMemoryTool
                        .execute(
                            args(json!({
                                "action": action,
                                "name": "Build Commands",
                                "body": "rm -rf",
                                "scope": scope
                            })),
                            &ctx,
                        )
                        .await,
                    &expected,
                );
            }
            expect_denied(
                ManageMemoryTool
                    .execute(
                        args(json!({
                            "action": "delete",
                            "name": "build-commands",
                            "scope": scope
                        })),
                        &ctx,
                    )
                    .await,
                &expected,
            );
        }
        // No memory file, folder, or MEMORY.md index was created, changed, or removed.
        assert_eq!(tree_snapshot(&base), before, "policy {kind}");

        // Recall (read) stays allowed.
        let recalled = RecallMemoryTool
            .execute(
                args(json!({ "name": "build-commands", "scope": "workspace" })),
                &ctx,
            )
            .await
            .expect("recall allowed")
            .as_text()
            .unwrap();
        assert!(
            recalled.contains("cargo build"),
            "policy {kind}: {recalled}"
        );
    }
}

#[tokio::test]
async fn workspace_write_policy_still_allows_memory_mutations() {
    let f = fixture();
    let ctx = &f.ctx;

    let written = MemoryTool
        .execute(
            args(json!({ "action": "write", "key": "notes", "content": "keep" })),
            ctx,
        )
        .await
        .expect("memory write")
        .to_json_value();
    assert_eq!(written["ok"], json!(true), "{written}");
    assert_eq!(
        f.memory_store
            .list(Some(MemoryScope::Workspace))
            .unwrap()
            .into_iter()
            .map(|e| e.content)
            .collect::<Vec<_>>(),
        vec!["keep"]
    );
    let deleted = MemoryTool
        .execute(args(json!({ "action": "delete", "key": "notes" })), ctx)
        .await
        .expect("memory delete")
        .to_json_value();
    assert_eq!(deleted["deleted"], json!(true), "{deleted}");
    assert!(sqlite_snapshot(&f.memory_store).is_empty());

    let dir = f
        .advanced_store
        .resolve_scope_dir("workspace", None)
        .unwrap();
    let created = ManageMemoryTool
        .execute(
            args(json!({ "action": "create", "name": "Build Commands", "body": "cargo build" })),
            ctx,
        )
        .await
        .expect("manageMemory create")
        .to_json_value();
    assert_eq!(created["ok"], json!(true), "{created}");
    assert!(dir.join("build-commands.md").is_file());
    let updated = ManageMemoryTool
        .execute(
            args(json!({ "action": "update", "name": "Build Commands", "body": "cargo check" })),
            ctx,
        )
        .await
        .expect("manageMemory update")
        .to_json_value();
    assert_eq!(updated["ok"], json!(true), "{updated}");
    assert!(
        fs::read_to_string(dir.join("build-commands.md"))
            .unwrap()
            .contains("cargo check")
    );
    let removed = ManageMemoryTool
        .execute(
            args(json!({ "action": "delete", "name": "build-commands" })),
            ctx,
        )
        .await
        .expect("manageMemory delete")
        .to_json_value();
    assert_eq!(removed["deleted"], json!(true), "{removed}");
    assert!(!dir.join("build-commands.md").exists());
}
