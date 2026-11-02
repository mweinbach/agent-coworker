//! TS parity for advanced-memory types and `manageMemory` edits (origin/main
//! `src/advancedMemory/store.ts`, `src/tools/manageMemory.ts`):
//!
//! * A memory with no type anywhere (file, write input, tool call) is a `note`
//!   (`parseMemoryFile` / `normalizeAdvancedMemoryWriteInput` / `input.type ?? "note"`), and the
//!   tool's type enum is TS `memoryTypeSchema` (`feedback | project | note`).
//! * An edit keeps the entry's display name unless a new one is explicitly given (TS
//!   `editMemory`: `name: patch.name ?? existing.name`, where the target is the separate `slug`).

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_tools::{AdvancedMemoryStore, BuiltinTool, ManageMemoryTool, ToolExecutionContext};
use serde_json::{Map, Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    ws: PathBuf,
    store: Arc<AdvancedMemoryStore>,
}

impl Fixture {
    fn dir(&self) -> PathBuf {
        self.store.resolve_scope_dir("workspace", None).unwrap()
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

    fn entry(&self, slug: &str) -> cowork_tools::AdvancedMemoryEntry {
        self.store
            .list_entries_in_dir(&self.dir(), "workspace")
            .unwrap()
            .into_iter()
            .find(|e| e.slug == slug)
            .unwrap_or_else(|| panic!("memory {slug} missing"))
    }

    async fn manage(&self, a: Value) -> Result<Value, cowork_tools::ToolError> {
        let a: Map<String, Value> = serde_json::from_value(a).unwrap();
        ManageMemoryTool
            .execute(a, &self.ctx())
            .await
            .map(|out| out.to_json_value())
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
        chats_root,
    ));
    Fixture {
        _tmp: tmp,
        home,
        ws,
        store,
    }
}

#[test]
fn untyped_memory_files_default_to_note() {
    let f = fixture();
    let dir = f.dir();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("bare.md"), "just a body\n").unwrap();
    fs::write(
        dir.join("named.md"),
        "---\nname: Named\ndescription: d\n---\n\nbody\n",
    )
    .unwrap();
    fs::write(
        dir.join("blank.md"),
        "---\nname: Blank\ntype: \"  \"\n---\n\nbody\n",
    )
    .unwrap();
    for slug in ["bare", "named", "blank"] {
        assert_eq!(f.entry(slug).memory_type, "note", "{slug}");
    }
}

#[test]
fn store_write_with_blank_type_is_a_note() {
    let f = fixture();
    let saved = f
        .store
        .upsert_entry(
            "workspace",
            None,
            "Blank Type",
            "Blank Type",
            "d",
            "  ",
            "b",
        )
        .unwrap();
    assert_eq!(saved.memory_type, "note");
    assert_eq!(f.entry("blank-type").memory_type, "note");
}

#[tokio::test]
async fn manage_memory_type_enum_and_create_default_match_ts() {
    let schema = ManageMemoryTool.input_schema();
    assert_eq!(
        schema["properties"]["type"]["enum"],
        json!(["feedback", "project", "note"])
    );

    let f = fixture();
    let created = f
        .manage(json!({
            "action": "create",
            "name": "Release Steps",
            "description": "How we ship",
            "body": "Tag, then publish."
        }))
        .await
        .unwrap();
    assert_eq!(created["entry"]["type"], json!("note"), "{created}");
    assert_eq!(f.entry("release-steps").memory_type, "note");

    let explicit = f
        .manage(json!({
            "action": "create",
            "name": "Style",
            "type": "note",
            "body": "Prefer tabs."
        }))
        .await
        .unwrap();
    assert_eq!(explicit["ok"], json!(true), "{explicit}");

    let err = f
        .manage(json!({ "action": "create", "name": "Who", "type": "user", "body": "b" }))
        .await
        .expect_err("`user` is not a TS memory type");
    assert!(err.to_string().contains("\"user\" is not one of"), "{err}");
}

#[tokio::test]
async fn manage_memory_update_by_slug_keeps_the_display_name() {
    let f = fixture();
    f.manage(json!({
        "action": "create",
        "name": "Team Notes",
        "description": "Team conventions",
        "type": "project",
        "body": "v1"
    }))
    .await
    .unwrap();
    assert_eq!(f.entry("team-notes").name, "Team Notes");

    // `name` used as the target (the slug) must not rename the entry.
    f.manage(json!({ "action": "update", "name": "team-notes", "body": "v2" }))
        .await
        .unwrap();
    let e = f.entry("team-notes");
    assert_eq!(e.name, "Team Notes");
    assert_eq!(e.description, "Team conventions");
    assert_eq!(e.memory_type, "project");
    assert_eq!(e.body, "v2");

    // TS shape: `slug` targets, so no `name` keeps the display name ...
    f.manage(json!({ "action": "update", "slug": "team-notes", "body": "v3" }))
        .await
        .unwrap();
    assert_eq!(f.entry("team-notes").name, "Team Notes");

    // ... and an explicit `name` next to `slug` renames (TS `patch.name`).
    let renamed = f
        .manage(json!({
            "action": "update",
            "slug": "team-notes",
            "name": "Team Conventions",
            "body": "v4"
        }))
        .await
        .unwrap();
    assert_eq!(renamed["entry"]["slug"], json!("team-notes"), "{renamed}");
    let e = f.entry("team-notes");
    assert_eq!(e.name, "Team Conventions");
    assert_eq!(e.body, "v4");

    // Delete accepts the slug target too.
    let deleted = f
        .manage(json!({ "action": "delete", "slug": "team-notes" }))
        .await
        .unwrap();
    assert_eq!(deleted["deleted"], json!(true), "{deleted}");
}

#[tokio::test]
async fn manage_memory_create_with_slug_uses_it_as_the_file_name() {
    let f = fixture();
    f.manage(json!({
        "action": "create",
        "name": "Deploy Checklist",
        "slug": "deploy",
        "body": "Smoke test first."
    }))
    .await
    .unwrap();
    let e = f.entry("deploy");
    assert_eq!(e.name, "Deploy Checklist");
    assert_eq!(e.memory_type, "note");

    let err = f
        .manage(json!({ "action": "create", "slug": "nameless", "body": "b" }))
        .await
        .expect_err("create requires a name");
    assert!(err.to_string().contains("name"), "{err}");
    let err = f
        .manage(json!({ "action": "delete" }))
        .await
        .expect_err("a target is required");
    assert!(err.to_string().contains("name or slug"), "{err}");
}

/// A write with a blank type (the desktop upsert routes when `type` is omitted) keeps an
/// existing entry's type, like TS `editMemory` (`patch.type ?? existing.type`), and defaults a new
/// entry to `note`.
#[test]
fn blank_type_keeps_the_existing_type_on_edit_and_defaults_new_entries_to_note() {
    let fx = fixture();
    fx.store
        .upsert_entry(
            "workspace",
            None,
            "pref",
            "Pref",
            "d",
            "feedback",
            "body one",
        )
        .unwrap();
    fx.store
        .upsert_entry("workspace", None, "pref", "Pref", "d2", "", "body two")
        .unwrap();
    let edited = fx.entry("pref");
    assert_eq!(edited.memory_type, "feedback");
    assert_eq!(edited.body, "body two");

    fx.store
        .upsert_entry("workspace", None, "fresh", "Fresh", "d", "", "new body")
        .unwrap();
    assert_eq!(fx.entry("fresh").memory_type, "note");
}
