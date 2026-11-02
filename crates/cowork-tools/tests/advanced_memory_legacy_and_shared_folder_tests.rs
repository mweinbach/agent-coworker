//! Advanced memories written by the TS store (origin/main `src/advancedMemory/store.ts`) must
//! keep their meaning after an in-place upgrade:
//!
//! * TS `serializeMemory` kept `type` and `originSessionId` under a nested `metadata:` map. The
//!   loader reads them from there, so a `feedback` entry is not reclassified as `project`, and an
//!   edit of another field (desktop `AdvancedMemoryPanel.openEdit` re-sends `entry.type`, or a
//!   body-only `manageMemory` update) keeps the classification.
//! * Project sessions read the shared `(chats)` folder as well as their own (TS
//!   `resolveAdvancedMemoryAccessRoots` / `createRecallMemoryTool`), so cross-workspace memories
//!   saved there stay recallable.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_tools::memory::CHATS_FOLDER;
use cowork_tools::{
    AdvancedMemoryStore, BuiltinTool, ManageMemoryTool, RecallMemoryTool, ToolExecutionContext,
};
use serde_json::{Map, Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    ws: PathBuf,
    chats_root: PathBuf,
    store: Arc<AdvancedMemoryStore>,
}

impl Fixture {
    fn memories(&self) -> PathBuf {
        self.home.join(".cowork").join("memories")
    }

    fn workspace_dir(&self) -> PathBuf {
        self.store.resolve_scope_dir("workspace", None).unwrap()
    }

    fn chats_dir(&self) -> PathBuf {
        self.memories().join(CHATS_FOLDER)
    }

    fn ctx(&self) -> ToolExecutionContext {
        let mut ctx = ToolExecutionContext::new_for_tests(
            self.home.clone(),
            self.ws.clone(),
            ProviderName::Openai,
            "gpt-5.4",
        );
        ctx.advanced_memory = true;
        ctx.advanced_memory_store = Some(Arc::clone(&self.store));
        ctx
    }
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = fs::canonicalize(tmp.path()).expect("canonical tmp");
    let home = root.join("home");
    let ws = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let cowork_home = home.join(".cowork");
    let chats_root = cowork_home.join("workspaces").join("chats");
    let store = Arc::new(AdvancedMemoryStore::new(
        cowork_home,
        ws.clone(),
        chats_root.clone(),
    ));
    Fixture {
        _tmp: tmp,
        home,
        ws,
        chats_root,
        store,
    }
}

/// A memory file byte-for-byte as TS `serializeMemory` wrote it.
fn write_ts_memory(dir: &Path, slug: &str, name: &str, description: &str, ty: &str, body: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join(format!("{slug}.md")),
        format!(
            "---\nname: \"{name}\"\ndescription: \"{description}\"\nmetadata:\n  node_type: memory\n  type: \"{ty}\"\n  originSessionId: \"sess-ts-1\"\n---\n\n{body}\n"
        ),
    )
    .unwrap();
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

async fn recall(f: &Fixture, a: Value) -> String {
    RecallMemoryTool
        .execute(args(a), &f.ctx())
        .await
        .unwrap()
        .as_text()
        .unwrap()
        .to_owned()
}

#[test]
fn ts_metadata_type_loads_and_survives_an_edit_of_another_field() {
    let f = fixture();
    let dir = f.workspace_dir();
    write_ts_memory(
        &dir,
        "indent-style",
        "Indent style",
        "User prefers tabs",
        "feedback",
        "Always use tabs.",
    );
    write_ts_memory(&dir, "scratch", "Scratch", "A note", "note", "n");

    let listed = f.store.list_entries_in_dir(&dir, "workspace").unwrap();
    let entry = listed.iter().find(|e| e.slug == "indent-style").unwrap();
    assert_eq!(entry.memory_type, "feedback");
    assert_eq!(entry.name, "Indent style");
    assert_eq!(entry.description, "User prefers tabs");
    assert_eq!(entry.origin_session_id.as_deref(), Some("sess-ts-1"));
    assert!(
        !entry.updated_at.is_empty(),
        "TS files carry no updated_at; the file mtime stands in (TS listMemories)"
    );
    let wire = serde_json::to_value(entry).unwrap();
    assert_eq!(wire["type"], json!("feedback"));
    assert_eq!(wire["originSessionId"], json!("sess-ts-1"));
    let note = listed.iter().find(|e| e.slug == "scratch").unwrap();
    assert_eq!(note.memory_type, "note");

    // Desktop edit: the draft starts from the listed entry and only the description changes.
    f.store
        .upsert_entry(
            "workspace",
            None,
            &entry.slug,
            &entry.name,
            "User prefers tabs everywhere",
            &entry.memory_type,
            &entry.body,
        )
        .unwrap();
    let reread = f.store.list_entries_in_dir(&dir, "workspace").unwrap();
    let edited = reread.iter().find(|e| e.slug == "indent-style").unwrap();
    assert_eq!(edited.memory_type, "feedback");
    assert_eq!(edited.description, "User prefers tabs everywhere");
    assert_eq!(edited.body, "Always use tabs.");
    assert_eq!(edited.origin_session_id.as_deref(), Some("sess-ts-1"));
    // The rewrite is normalized to the current flat frontmatter.
    let raw = fs::read_to_string(dir.join("indent-style.md")).unwrap();
    assert!(raw.contains("\ntype: \"feedback\"\n"), "{raw}");
    assert!(!raw.contains("metadata:"), "{raw}");
}

#[test]
fn top_level_type_wins_and_malformed_metadata_keeps_the_rest() {
    let f = fixture();
    let dir = f.workspace_dir();
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("both.md"),
        "---\nname: Both\ntype: reference\nmetadata:\n  type: feedback\n---\n\nb\n",
    )
    .unwrap();
    fs::write(
        dir.join("odd.md"),
        "---\nname: Odd\ndescription: kept\nmetadata: just-a-string\n---\n\no\n",
    )
    .unwrap();
    let listed = f.store.list_entries_in_dir(&dir, "workspace").unwrap();
    let both = listed.iter().find(|e| e.slug == "both").unwrap();
    assert_eq!(both.memory_type, "reference");
    let odd = listed.iter().find(|e| e.slug == "odd").unwrap();
    assert_eq!(odd.name, "Odd");
    assert_eq!(odd.description, "kept");
    assert_eq!(odd.memory_type, "note");
}

#[tokio::test]
async fn manage_memory_update_of_the_body_keeps_ts_type_and_description() {
    let f = fixture();
    let dir = f.workspace_dir();
    write_ts_memory(
        &dir,
        "indent-style",
        "Indent style",
        "User prefers tabs",
        "feedback",
        "Always use tabs.",
    );
    ManageMemoryTool
        .execute(
            args(json!({
                "action": "update",
                "name": "indent-style",
                "body": "Always use tabs, width 4.",
            })),
            &f.ctx(),
        )
        .await
        .unwrap();
    let listed = f.store.list_entries_in_dir(&dir, "workspace").unwrap();
    let entry = listed.iter().find(|e| e.slug == "indent-style").unwrap();
    assert_eq!(entry.memory_type, "feedback");
    assert_eq!(entry.description, "User prefers tabs");
    assert_eq!(entry.body, "Always use tabs, width 4.");
}

#[tokio::test]
async fn project_session_recalls_shared_chats_memories_by_default() {
    let f = fixture();
    write_ts_memory(
        &f.chats_dir(),
        "commit-style",
        "Commit style",
        "Conventional commits",
        "feedback",
        "Use conventional commit subjects.",
    );
    write_ts_memory(
        &f.workspace_dir(),
        "build",
        "Build",
        "How to build",
        "project",
        "workspace build body",
    );

    // Default recall by name (TS: active folder, then `(chats)`).
    let by_name = recall(&f, json!({ "name": "Commit style" })).await;
    assert!(
        by_name.contains("Use conventional commit subjects."),
        "{by_name}"
    );
    // Keyword search and the cross-workspace scope include it too.
    let by_query = recall(&f, json!({ "query": "conventional" })).await;
    assert!(by_query.contains("commit-style"), "{by_query}");
    let global = recall(&f, json!({ "name": "commit-style", "scope": "global" })).await;
    assert!(
        global.contains("Use conventional commit subjects."),
        "{global}"
    );
    // The workspace-only scope stays on the session's own folder.
    let workspace_only = recall(&f, json!({ "name": "commit-style", "scope": "workspace" })).await;
    assert!(
        workspace_only.starts_with("No memory entry"),
        "{workspace_only}"
    );
    let listing = recall(&f, json!({})).await;
    assert!(listing.contains("workspace build body"), "{listing}");
    assert!(listing.contains("commit-style"), "{listing}");
}

#[tokio::test]
async fn own_folder_wins_name_lookups_over_shared_chats() {
    let f = fixture();
    write_ts_memory(
        &f.chats_dir(),
        "prefs",
        "Prefs",
        "shared",
        "note",
        "shared body",
    );
    write_ts_memory(
        &f.workspace_dir(),
        "prefs",
        "Prefs",
        "local",
        "note",
        "local body",
    );
    let recalled = recall(&f, json!({ "name": "prefs" })).await;
    assert!(recalled.contains("local body"), "{recalled}");
}

#[test]
fn readable_scope_dirs_list_chats_once_for_one_off_chats() {
    let f = fixture();
    let project: Vec<_> = f
        .store
        .readable_scope_dirs()
        .into_iter()
        .map(|(label, dir)| {
            (
                label,
                dir.file_name().unwrap().to_string_lossy().into_owned(),
            )
        })
        .collect();
    assert_eq!(project.len(), 3, "{project:?}");
    assert_eq!(project[0].0, "workspace");
    assert_eq!(project[1], ("chats", CHATS_FOLDER.to_owned()));
    assert_eq!(project[2], ("global", "_global".to_owned()));

    let chat_ws = f.chats_root.join("chat-1");
    fs::create_dir_all(&chat_ws).unwrap();
    let chat_store =
        AdvancedMemoryStore::new(f.home.join(".cowork"), chat_ws, f.chats_root.clone());
    let chat: Vec<_> = chat_store
        .readable_scope_dirs()
        .into_iter()
        .map(|(label, dir)| {
            (
                label,
                dir.file_name().unwrap().to_string_lossy().into_owned(),
            )
        })
        .collect();
    assert_eq!(
        chat,
        vec![
            ("workspace", CHATS_FOLDER.to_owned()),
            ("global", "_global".to_owned()),
        ]
    );
}

#[test]
fn render_index_reflects_entry_files_not_a_stale_memory_md() {
    let f = fixture();
    let chats = f.chats_dir();
    assert_eq!(f.store.render_index(&chats, "chats").unwrap(), "");
    write_ts_memory(&chats, "kept", "Kept", "kept-desc", "feedback", "k");
    fs::write(
        chats.join("MEMORY.md"),
        "# Memory Index\n\n- [Ghost](ghost.md) \u{2014} ghost-desc\n",
    )
    .unwrap();
    let index = f.store.render_index(&chats, "chats").unwrap();
    assert!(index.starts_with("# Memory Index\n\n"), "{index}");
    assert!(index.contains("kept-desc"), "{index}");
    assert!(index.contains("[feedback]"), "{index}");
    assert!(!index.contains("ghost-desc"), "{index}");
    // Rendering is read-only; the generated file is left for the next write to regenerate.
    assert!(
        fs::read_to_string(chats.join("MEMORY.md"))
            .unwrap()
            .contains("ghost-desc")
    );
    let summary = f.store.read_index_summary();
    assert!(summary.contains("### Shared (chats) Memories"), "{summary}");
    assert!(summary.contains("kept-desc"), "{summary}");
}
