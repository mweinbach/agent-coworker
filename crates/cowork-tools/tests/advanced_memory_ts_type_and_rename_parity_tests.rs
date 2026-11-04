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

/// TS `manageMemory` create (origin/main `src/tools/manageMemory.ts`) rejected a slug that
/// already exists in the active folder instead of overwriting it, so creating `Style` twice must
/// keep the original instructions and classification.
#[tokio::test]
async fn manage_memory_create_rejects_an_existing_slug() {
    let f = fixture();
    f.manage(json!({
        "action": "create",
        "name": "Style",
        "description": "Formatting rules",
        "type": "feedback",
        "body": "Prefer tabs."
    }))
    .await
    .unwrap();

    let err = f
        .manage(json!({ "action": "create", "name": "Style", "body": "Prefer spaces." }))
        .await
        .expect_err("a second create of the same name must not overwrite");
    assert!(err.to_string().contains("already exists"), "{err}");

    // An explicit slug that collides is rejected the same way.
    let err = f
        .manage(json!({ "action": "create", "name": "Other", "slug": "style", "body": "x" }))
        .await
        .expect_err("a colliding slug must not overwrite");
    assert!(err.to_string().contains("already exists"), "{err}");

    let e = f.entry("style");
    assert_eq!(e.name, "Style");
    assert_eq!(e.description, "Formatting rules");
    assert_eq!(e.memory_type, "feedback");
    assert_eq!(e.body, "Prefer tabs.");

    // `update` stays the explicit overwrite path.
    f.manage(json!({ "action": "update", "slug": "style", "body": "Prefer spaces." }))
        .await
        .unwrap();
    assert_eq!(f.entry("style").body, "Prefer spaces.");
}

/// The bundled memories skill (`skills/memories/SKILL.md`) drives `manageMemory` with
/// `list`, `read`, `create`, `edit`, and `refresh_index`, the TS action set; every action it
/// names must stay in the tool's schema.
#[test]
fn manage_memory_schema_accepts_every_action_the_memories_skill_uses() {
    let skill = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills/memories/SKILL.md"),
    )
    .expect("bundled memories skill");
    let schema = ManageMemoryTool.input_schema();
    let actions: Vec<&str> = schema["properties"]["action"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let mut named = Vec::new();
    for chunk in skill.split("action `").skip(1) {
        named.push(chunk.split('`').next().unwrap().to_owned());
    }
    for action in ["list", "read", "create", "edit", "refresh_index"] {
        assert!(
            actions.contains(&action),
            "{action} missing from {actions:?}"
        );
    }
    assert!(!named.is_empty());
    for action in &named {
        assert!(
            actions.contains(&action.as_str()),
            "skill action {action} missing from {actions:?}"
        );
    }
}

/// TS `list` / `read` / `edit` / `refresh_index` behavior, the workflow the memories skill
/// prescribes.
#[tokio::test]
async fn manage_memory_list_read_edit_and_refresh_index_match_ts() {
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

    // list: folders with body-less summaries; the session's folder is writable, (chats) is not.
    let listed = f.manage(json!({ "action": "list" })).await.unwrap();
    let active = listed["activeFolder"].as_str().unwrap().to_owned();
    assert_eq!(listed["writableFolder"], json!(active), "{listed}");
    let folders = listed["folders"].as_array().unwrap();
    let own = folders
        .iter()
        .find(|folder| folder["folder"] == json!(active))
        .expect("active folder listed");
    assert_eq!(own["writable"], json!(true));
    assert_eq!(own["memories"][0]["slug"], json!("team-notes"), "{listed}");
    assert_eq!(own["memories"][0]["type"], json!("project"));
    assert!(own["memories"][0].get("body").is_none(), "{listed}");
    let chats = folders
        .iter()
        .find(|folder| folder["folder"] == json!("(chats)"))
        .expect("shared chats folder listed");
    assert_eq!(chats["writable"], json!(false));

    // read: by display name or slug, with the body.
    let read = f
        .manage(json!({ "action": "read", "name": "team notes" }))
        .await
        .unwrap();
    assert_eq!(read["found"], json!(true), "{read}");
    assert_eq!(read["folder"], json!(active));
    assert_eq!(read["memory"]["body"], json!("v1"));
    let missing = f
        .manage(json!({ "action": "read", "slug": "nope" }))
        .await
        .unwrap();
    assert_eq!(missing["found"], json!(false), "{missing}");
    let chats_only = f
        .manage(json!({ "action": "read", "slug": "team-notes", "source": "chats" }))
        .await
        .unwrap();
    assert_eq!(chats_only["found"], json!(false), "{chats_only}");
    assert_eq!(chats_only["searchedFolders"], json!(["(chats)"]));

    // edit: slug targets, omitted fields are kept, a new name renames.
    let edited = f
        .manage(json!({ "action": "edit", "slug": "team-notes", "body": "v2" }))
        .await
        .unwrap();
    assert_eq!(edited["ok"], json!(true), "{edited}");
    let e = f.entry("team-notes");
    assert_eq!(
        (
            e.name.as_str(),
            e.description.as_str(),
            e.memory_type.as_str(),
            e.body.as_str()
        ),
        ("Team Notes", "Team conventions", "project", "v2")
    );
    f.manage(json!({ "action": "edit", "slug": "team-notes", "name": "Conventions" }))
        .await
        .unwrap();
    let e = f.entry("team-notes");
    assert_eq!((e.name.as_str(), e.body.as_str()), ("Conventions", "v2"));

    // edit never creates: a missing slug is reported, not written.
    let not_found = f
        .manage(json!({ "action": "edit", "slug": "ghost", "body": "boo" }))
        .await
        .unwrap();
    assert_eq!(not_found["ok"], json!(false), "{not_found}");
    assert_eq!(not_found["reason"], json!("not_found"));
    assert!(!f.dir().join("ghost.md").exists());
    let err = f
        .manage(json!({ "action": "edit", "slug": "team-notes" }))
        .await
        .expect_err("edit needs a field");
    assert!(err.to_string().contains("at least one field"), "{err}");
    let err = f
        .manage(json!({ "action": "edit", "name": "Conventions", "body": "x" }))
        .await
        .expect_err("edit needs a slug");
    assert!(err.to_string().contains("slug"), "{err}");

    // refresh_index: regenerates MEMORY.md after a manual file repair.
    fs::write(
        f.dir().join("manual.md"),
        "---\nname: Manual\ndescription: hand written\n---\n\nbody\n",
    )
    .unwrap();
    let refreshed = f
        .manage(json!({ "action": "refresh_index" }))
        .await
        .unwrap();
    assert_eq!(refreshed["ok"], json!(true), "{refreshed}");
    assert_eq!(refreshed["folder"], json!(active));
    let index = fs::read_to_string(f.dir().join("MEMORY.md")).unwrap();
    assert!(
        index.contains("**Manual** (`manual` [note]): hand written"),
        "{index}"
    );
    assert!(index.contains("`team-notes`"), "{index}");
}
