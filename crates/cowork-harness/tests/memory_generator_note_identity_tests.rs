//! Generated memory notes get a collision-resistant identity: two preferences that share their
//! first 40 characters (the display title) are stored as separate advanced-memory files, while
//! re-saving the exact same preference updates its existing file instead of duplicating it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_harness::{MemoryGenerator, RemoteMemoryModel};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    StepBudget, StopReason, TurnUsage,
};
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};
use cowork_storage::MemoryStore;
use cowork_tools::{AdvancedMemoryEntry, AdvancedMemoryStore};
use serde_json::{Value, json};
use uuid::Uuid;

const PYTHON: &str = "Remember: for this project, always use Python for scripts.";
const POSTGRES: &str = "Remember: for this project, always use PostgreSQL for persistence.";

struct Fixture {
    root: PathBuf,
    sqlite: MemoryStore,
    advanced: AdvancedMemoryStore,
}

impl Fixture {
    fn new(prefix: &str) -> Self {
        let root = std::env::temp_dir().join(format!("cowork-harness-{prefix}-{}", Uuid::new_v4()));
        let home = root.join("home");
        let ws = root.join("workspace");
        let chats = root.join("chats");
        for dir in [&home, &ws, &chats] {
            fs::create_dir_all(dir).unwrap();
        }
        Self {
            sqlite: MemoryStore::new(ws.join("memory.db"), home.join("memory.db")),
            advanced: AdvancedMemoryStore::new(home.join(".cowork"), ws, chats),
            root,
        }
    }

    fn workspace_dir(&self) -> PathBuf {
        self.advanced.resolve_scope_dir("workspace", None).unwrap()
    }

    fn entries(&self) -> Vec<AdvancedMemoryEntry> {
        self.advanced
            .list_entries_in_dir(&self.workspace_dir(), "workspace")
            .unwrap()
    }

    fn bodies(&self) -> Vec<String> {
        let mut bodies: Vec<String> = self.entries().into_iter().map(|e| e.body).collect();
        bodies.sort();
        bodies
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn msg(role: &str, text: &str) -> Value {
    json!({ "role": role, "content": text })
}

fn exchange(user: &str) -> Vec<Value> {
    vec![msg("user", user), msg("assistant", "Noted.")]
}

async fn run_offline(fx: &Fixture, messages: &[Value]) {
    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(messages, 0, Some(&fx.sqlite), Some(&fx.advanced), None)
        .await
        .unwrap();
    assert_eq!(next, messages.len());
}

fn md_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md") && n != "MEMORY.md")
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn offline_directives_sharing_a_40_char_prefix_are_both_retained() {
    assert_eq!(
        PYTHON.chars().take(40).collect::<String>(),
        POSTGRES.chars().take(40).collect::<String>(),
        "fixture: both preferences share the truncated display title"
    );
    let fx = Fixture::new("memgen-identity-offline");

    run_offline(&fx, &exchange(PYTHON)).await;
    run_offline(&fx, &exchange(POSTGRES)).await;

    assert_eq!(fx.bodies(), vec![POSTGRES.to_owned(), PYTHON.to_owned()]);
    let entries = fx.entries();
    assert_ne!(entries[0].slug, entries[1].slug);
    // The shortened title is only the display name; the identity is distinct per note.
    let title: String = PYTHON.chars().take(40).collect();
    assert!(entries.iter().all(|e| e.name == title), "{entries:?}");
    assert_eq!(md_files(&fx.workspace_dir()).len(), 2);
}

#[tokio::test]
async fn re_saving_identical_content_updates_in_place_without_duplicating() {
    let fx = Fixture::new("memgen-identity-resave");

    run_offline(&fx, &exchange(PYTHON)).await;
    let first = fx.entries();
    assert_eq!(first.len(), 1);

    run_offline(&fx, &exchange(PYTHON)).await;
    // The same directive repeated within one delta is still one memory.
    let mut twice = exchange(PYTHON);
    twice.extend(exchange(PYTHON));
    run_offline(&fx, &twice).await;

    let after = fx.entries();
    assert_eq!(after.len(), 1, "{after:?}");
    assert_eq!(after[0].slug, first[0].slug);
    assert_eq!(after[0].body, PYTHON);
}

#[tokio::test]
async fn identical_content_reuses_a_legacy_truncated_slug_file() {
    let fx = Fixture::new("memgen-identity-legacy");
    // A note written by the old generator under its bare truncated-title slug.
    let title: String = PYTHON.chars().take(40).collect();
    fx.advanced
        .upsert_entry(
            "workspace",
            None,
            &title,
            &title,
            "Auto-extracted conversation preference",
            "feedback",
            PYTHON,
        )
        .unwrap();
    let legacy = fx.entries();
    assert_eq!(legacy[0].slug, "remember-for-this-project-always-use-p");

    run_offline(&fx, &exchange(PYTHON)).await;
    let after = fx.entries();
    assert_eq!(after.len(), 1, "{after:?}");
    assert_eq!(after[0].slug, legacy[0].slug);

    // A different note with the same prefix must not overwrite the legacy file.
    run_offline(&fx, &exchange(POSTGRES)).await;
    assert_eq!(fx.bodies(), vec![POSTGRES.to_owned(), PYTHON.to_owned()]);
}

#[tokio::test]
async fn edited_generated_note_is_not_clobbered_by_a_new_note_with_its_identity() {
    let fx = Fixture::new("memgen-identity-edited");
    run_offline(&fx, &exchange(PYTHON)).await;
    let slug = fx.entries()[0].slug.clone();
    // The user refines the generated memory through the memory tool (same slug, new body).
    let edited = "Use Python 3.12 for scripts; uv manages the venv.";
    fx.advanced
        .upsert_entry("workspace", None, &slug, "Python", "d", "feedback", edited)
        .unwrap();

    run_offline(&fx, &exchange(PYTHON)).await;

    let bodies = fx.bodies();
    assert_eq!(bodies.len(), 2, "{bodies:?}");
    assert!(bodies.contains(&edited.to_owned()));
    assert!(bodies.contains(&PYTHON.to_owned()));
}

#[tokio::test]
async fn sqlite_fallback_keeps_distinct_notes_and_dedupes_identical_ones() {
    let fx = Fixture::new("memgen-identity-sqlite");
    for user in [PYTHON, POSTGRES, PYTHON] {
        let messages = exchange(user);
        MemoryGenerator::new()
            .maybe_generate_from_transcript(&messages, 0, Some(&fx.sqlite), None, None)
            .await
            .unwrap();
    }
    let mut contents: Vec<String> = fx
        .sqlite
        .list(None)
        .unwrap()
        .into_iter()
        .map(|e| e.content)
        .collect();
    contents.sort();
    assert_eq!(contents, vec![POSTGRES.to_owned(), PYTHON.to_owned()]);
}

/// Mock memory model that replies with the next scripted note on each call.
struct ScriptedModel {
    replies: parking_lot::Mutex<Vec<String>>,
}

#[async_trait]
impl ProviderTransport for ScriptedModel {
    async fn stream_step(
        &self,
        _req: ProviderStepRequest,
        _budget: &StepBudget,
        _on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let text = self.replies.lock().remove(0);
        Ok(ProviderStepResult {
            assistant: CanonicalMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::Assistant,
                content: vec![ContentBlock::Text {
                    text,
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }],
                phase: None,
                provider: None,
                api: None,
                model: None,
                stop_reason: Some(StopReason::Stop),
                provider_meta: ProviderOpaqueMeta::default(),
                created_at: "2026-11-01T00:00:00.000Z".to_owned(),
            },
            persisted_assistant: None,
            usage: TurnUsage::default(),
            continuation: None,
            raw_events: Vec::new(),
        })
    }
}

#[tokio::test]
async fn model_extracted_notes_sharing_a_prefix_are_both_retained() {
    let fx = Fixture::new("memgen-identity-remote");
    let python = "Prefer Python for all one-off automation scripts in this repo.";
    let postgres = "Prefer Python for all one-off automation and PostgreSQL for data.";
    let model = Arc::new(ScriptedModel {
        replies: parking_lot::Mutex::new(vec![
            python.to_owned(),
            postgres.to_owned(),
            python.to_owned(),
        ]),
    });
    let messages = vec![
        msg("user", "Some chat without directives."),
        msg("assistant", "Ok."),
    ];
    for _ in 0..3 {
        MemoryGenerator::new()
            .maybe_generate_from_transcript(
                &messages,
                0,
                Some(&fx.sqlite),
                Some(&fx.advanced),
                Some(RemoteMemoryModel {
                    transport: model.clone(),
                    model_id: "mock-memory-model".to_owned(),
                    base_url: None,
                    api_key: None,
                }),
            )
            .await
            .unwrap();
    }
    assert_eq!(fx.bodies(), vec![postgres.to_owned(), python.to_owned()]);
}
