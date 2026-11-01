//! Advanced-memory entry slugs must match TS `slugifyMemoryName` (origin/main
//! `src/advancedMemory/store.ts`) and listed slugs must address the file they were listed from.
//! Users upgrade in place, so memories written by the TS app (`team_preferences.md`,
//! `notes.v2.md`) have to survive desktop list -> edit -> delete round-trips unchanged.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_tools::memory::slugify_memory_name;
use cowork_tools::{
    AdvancedMemoryStore, BuiltinTool, ManageMemoryTool, RecallMemoryTool, ToolExecutionContext,
};
use serde_json::{Map, Value, json};

/// `(input, expected)` pairs produced by running the TS `slugify` from origin/main
/// `src/advancedMemory/store.ts` under Bun (`bun run`, function body copied verbatim to /tmp).
const TS_SLUGIFY_CASES: &[(&str, &str)] = &[
    ("team_preferences", "team_preferences"),
    ("team_preferences.md", "team_preferences"),
    ("Team_Preferences.md", "team_preferences"),
    ("notes.v2", "notes.v2"),
    ("notes.v2.md", "notes.v2"),
    ("\u{3000}Notes.V2.MD\u{3000}", "notes.v2"),
    ("Team Notes", "team-notes"),
    ("Mixed_Case.Notes", "mixed_case.notes"),
    ("MiXeD CaSe", "mixed-case"),
    ("Ünïcode Notes", "n-code-notes"),
    ("日本語メモ", "memory"),
    ("café_menu.v1", "caf-_menu.v1"),
    ("İstanbul", "i-stanbul"),
    ("K\u{212A}elvin", "kkelvin"),
    ("ΣΑΣ", "memory"),
    ("Ｆｕｌｌ", "memory"),
    ("a_b", "a_b"),
    ("a-b", "a-b"),
    ("a_b.md", "a_b"),
    ("a-b.md", "a-b"),
    ("  .hidden..notes.  ", "hidden..notes"),
    ("a..b__c--d", "a..b__c-d"),
    ("--x--", "x"),
    ("foo.md.md", "foo.md"),
    ("../etc/passwd", "etc-passwd"),
    ("Build Commands", "build-commands"),
    ("", "memory"),
    ("   ", "memory"),
    ("MEMORY", "memory"),
    ("Memory.MD", "memory"),
    // ECMAScript trim strips U+FEFF but not U+0085 (Rust `str::trim` is the reverse).
    ("\u{FEFF}Team_Notes.md\u{FEFF}", "team_notes"),
    ("x.md\u{0085}", "x.md"),
    ("\u{0085}team_notes\u{0085}", "team_notes"),
    (
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ),
];

#[test]
fn slugify_memory_name_matches_ts_slugify_memory_name() {
    for (input, expected) in TS_SLUGIFY_CASES {
        assert_eq!(slugify_memory_name(input), *expected, "slug for {input:?}");
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    store: Arc<AdvancedMemoryStore>,
    dir: PathBuf,
    home: PathBuf,
    ws: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = fs::canonicalize(tmp.path()).expect("canonical tmp");
    let home = root.join("home");
    let ws = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let cowork_home = home.join(".cowork");
    let store = Arc::new(AdvancedMemoryStore::new(
        cowork_home.clone(),
        ws.clone(),
        cowork_home.join("workspaces").join("chats"),
    ));
    let dir = store
        .resolve_scope_dir("workspace", None)
        .expect("workspace dir");
    fs::create_dir_all(&dir).unwrap();
    Fixture {
        _tmp: tmp,
        store,
        dir,
        home,
        ws,
    }
}

/// A memory file in the format the TS store wrote.
fn write_ts_memory(dir: &Path, file_name: &str, name: &str, body: &str) {
    fs::write(
        dir.join(file_name),
        format!("---\nname: {name}\ndescription: {name} desc\ntype: project\n---\n\n{body}\n"),
    )
    .unwrap();
}

/// Entry files on disk (excluding the generated index) mapped to their contents.
fn files(dir: &Path) -> BTreeMap<String, String> {
    fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().into_string().unwrap())
        .filter(|n| n != "MEMORY.md")
        .map(|n| {
            let raw = fs::read_to_string(dir.join(&n)).unwrap();
            (n, raw)
        })
        .collect()
}

fn listed_slugs(f: &Fixture) -> Vec<String> {
    let mut slugs: Vec<String> = f
        .store
        .list_entries_in_dir(&f.dir, "workspace")
        .unwrap()
        .into_iter()
        .map(|e| e.slug)
        .collect();
    slugs.sort();
    slugs
}

/// Desktop edit: re-send the listed slug with new content (server upsert route shape).
fn edit(f: &Fixture, slug: &str, body: &str) -> String {
    f.store
        .upsert_entry("workspace", None, slug, "Edited", "edited", "project", body)
        .expect("edit")
        .slug
}

#[test]
fn ts_written_underscore_memory_round_trips_list_edit_delete() {
    let f = fixture();
    write_ts_memory(&f.dir, "team_preferences.md", "Team Preferences", "tabs");

    assert_eq!(listed_slugs(&f), vec!["team_preferences"]);

    assert_eq!(edit(&f, "team_preferences", "spaces"), "team_preferences");
    let on_disk = files(&f.dir);
    assert_eq!(
        on_disk.keys().collect::<Vec<_>>(),
        vec!["team_preferences.md"],
        "edit must not create a duplicate"
    );
    assert!(on_disk["team_preferences.md"].contains("spaces"));
    assert_eq!(listed_slugs(&f), vec!["team_preferences"]);

    assert!(
        f.store
            .delete_entry("workspace", None, "team_preferences")
            .unwrap()
    );
    assert!(files(&f.dir).is_empty(), "delete must remove the original");
    assert!(listed_slugs(&f).is_empty());
    assert!(
        !fs::read_to_string(f.dir.join("MEMORY.md"))
            .unwrap()
            .contains("team_preferences")
    );
}

#[test]
fn dotted_memory_round_trips_list_edit_delete() {
    let f = fixture();
    write_ts_memory(&f.dir, "notes.v2.md", "Notes v2", "first");

    assert_eq!(listed_slugs(&f), vec!["notes.v2"]);
    assert_eq!(edit(&f, "notes.v2", "second"), "notes.v2");
    let on_disk = files(&f.dir);
    assert_eq!(on_disk.keys().collect::<Vec<_>>(), vec!["notes.v2.md"]);
    assert!(on_disk["notes.v2.md"].contains("second"));

    assert!(f.store.delete_entry("workspace", None, "notes.v2").unwrap());
    assert!(files(&f.dir).is_empty());
}

#[test]
fn underscore_and_dash_collision_touches_only_the_listed_file() {
    let f = fixture();
    write_ts_memory(&f.dir, "a_b.md", "underscore", "under-original");
    write_ts_memory(&f.dir, "a-b.md", "dash", "dash-original");
    assert_eq!(listed_slugs(&f), vec!["a-b", "a_b"]);

    assert_eq!(edit(&f, "a_b", "under-edited"), "a_b");
    let on_disk = files(&f.dir);
    assert_eq!(on_disk.len(), 2);
    assert!(on_disk["a_b.md"].contains("under-edited"));
    assert!(on_disk["a-b.md"].contains("dash-original"));

    assert_eq!(edit(&f, "a-b", "dash-edited"), "a-b");
    let on_disk = files(&f.dir);
    assert!(on_disk["a_b.md"].contains("under-edited"));
    assert!(on_disk["a-b.md"].contains("dash-edited"));

    assert!(f.store.delete_entry("workspace", None, "a-b").unwrap());
    let on_disk = files(&f.dir);
    assert_eq!(on_disk.keys().collect::<Vec<_>>(), vec!["a_b.md"]);
    assert!(on_disk["a_b.md"].contains("under-edited"));

    assert!(f.store.delete_entry("workspace", None, "a_b").unwrap());
    assert!(files(&f.dir).is_empty());
}

#[test]
fn non_canonical_filenames_round_trip_by_listed_slug() {
    let f = fixture();
    write_ts_memory(&f.dir, "Mixed_Case.md", "Mixed", "mixed-original");
    write_ts_memory(&f.dir, "Team Notes.MD", "Team Notes", "notes-original");
    write_ts_memory(&f.dir, "café_menu.md", "Cafe", "cafe-original");
    // TS lists `foo.md.md` as `foo.md`, which slugifies to `foo`; it must not hit `foo.md`.
    write_ts_memory(&f.dir, "foo.md.md", "Double ext", "double-original");
    write_ts_memory(&f.dir, "foo.md", "Foo", "foo-original");
    assert_eq!(
        listed_slugs(&f),
        vec!["Mixed_Case", "Team Notes", "café_menu", "foo", "foo.md"]
    );

    for (slug, file) in [
        ("Mixed_Case", "Mixed_Case.md"),
        ("Team Notes", "Team Notes.MD"),
        ("café_menu", "café_menu.md"),
        ("foo.md", "foo.md.md"),
    ] {
        assert_eq!(edit(&f, slug, &format!("{slug}-edited")), slug);
        let on_disk = files(&f.dir);
        assert_eq!(on_disk.len(), 5, "editing {slug:?} must not add a file");
        assert!(on_disk[file].contains(&format!("{slug}-edited")), "{file}");
    }
    assert!(files(&f.dir)["foo.md"].contains("foo-original"));

    for slug in ["Mixed_Case", "Team Notes", "café_menu", "foo.md"] {
        assert!(
            f.store.delete_entry("workspace", None, slug).unwrap(),
            "{slug}"
        );
    }
    let on_disk = files(&f.dir);
    assert_eq!(on_disk.keys().collect::<Vec<_>>(), vec!["foo.md"]);
    assert!(on_disk["foo.md"].contains("foo-original"));
}

#[test]
fn new_entries_use_ts_slugs_and_reserved_index_is_rejected() {
    let f = fixture();
    for (name, slug) in [
        ("Team_Preferences", "team_preferences"),
        ("Notes.v2", "notes.v2"),
        ("MiXeD CaSe", "mixed-case"),
        ("Ünïcode Notes", "n-code-notes"),
    ] {
        let saved = f
            .store
            .upsert_entry("workspace", None, name, name, "d", "project", "body")
            .unwrap();
        assert_eq!(saved.slug, slug, "{name}");
        assert!(f.dir.join(format!("{slug}.md")).is_file(), "{slug}.md");
    }
    assert_eq!(
        listed_slugs(&f),
        vec!["mixed-case", "n-code-notes", "notes.v2", "team_preferences"]
    );

    let index_before = fs::read_to_string(f.dir.join("MEMORY.md")).unwrap();
    for reserved in ["MEMORY", "memory.md", "  ", "日本語"] {
        let err = f
            .store
            .upsert_entry("workspace", None, reserved, "x", "d", "project", "b")
            .unwrap_err();
        assert!(err.to_string().contains("reserved"), "{reserved:?}: {err}");
        let err = f
            .store
            .delete_entry("workspace", None, reserved)
            .unwrap_err();
        assert!(err.to_string().contains("reserved"), "{reserved:?}: {err}");
    }
    assert_eq!(
        fs::read_to_string(f.dir.join("MEMORY.md")).unwrap(),
        index_before
    );
    assert!(
        !f.store
            .delete_entry("workspace", None, "does-not-exist")
            .unwrap()
    );
}

fn tool_ctx(f: &Fixture) -> ToolExecutionContext {
    let mut ctx = ToolExecutionContext::new_for_tests(
        f.home.clone(),
        f.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.advanced_memory = true;
    ctx.advanced_memory_store = Some(Arc::clone(&f.store));
    ctx
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn memory_tools_address_listed_slugs_exactly() {
    let f = fixture();
    write_ts_memory(&f.dir, "a_b.md", "underscore", "under-body");
    write_ts_memory(&f.dir, "a-b.md", "dash", "dash-body");
    let ctx = tool_ctx(&f);

    let recalled = RecallMemoryTool
        .execute(args(json!({ "name": "a_b", "scope": "workspace" })), &ctx)
        .await
        .unwrap()
        .as_text()
        .unwrap();
    assert!(recalled.contains("under-body"), "{recalled}");

    let deleted = ManageMemoryTool
        .execute(
            args(json!({ "action": "delete", "name": "a_b", "scope": "workspace" })),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();
    assert_eq!(deleted["deleted"], json!(true));
    assert_eq!(deleted["slug"], json!("a_b"));
    let on_disk = files(&f.dir);
    assert_eq!(on_disk.keys().collect::<Vec<_>>(), vec!["a-b.md"]);
    assert!(on_disk["a-b.md"].contains("dash-body"));
}
