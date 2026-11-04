//! Generated-memory storage failures keep their source messages retryable: when a note cannot
//! be saved (a full advanced-memory folder, an unwritable memory directory) the returned cursor
//! stops before the batch that produced it, so repairing storage later regenerates the note.
//! A model that finds nothing worth remembering is not a failure and still advances the cursor.

use std::fs;
use std::path::PathBuf;
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
use cowork_tools::AdvancedMemoryStore;
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

/// `MAX_MEMORY_ENTRIES_PER_DIR` in `cowork_tools::memory`.
const FOLDER_LIMIT: usize = 200;

struct Fixture {
    root: PathBuf,
    cowork_home: PathBuf,
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
        let cowork_home = home.join(".cowork");
        Self {
            sqlite: MemoryStore::new(ws.join("memory.db"), home.join("memory.db")),
            advanced: AdvancedMemoryStore::new(cowork_home.clone(), ws, chats),
            cowork_home,
            root,
        }
    }

    fn workspace_dir(&self) -> PathBuf {
        self.advanced.resolve_scope_dir("workspace", None).unwrap()
    }

    fn bodies(&self) -> Vec<String> {
        let mut bodies: Vec<String> = self
            .advanced
            .list_entries_in_dir(&self.workspace_dir(), "workspace")
            .unwrap()
            .into_iter()
            .map(|e| e.body)
            .collect();
        bodies.sort();
        bodies
    }

    /// Fills the workspace folder with `count` unrelated user-authored memories.
    fn fill(&self, count: usize) {
        for i in 0..count {
            self.advanced
                .upsert_entry(
                    "workspace",
                    None,
                    &format!("stale-{i}"),
                    &format!("Stale {i}"),
                    "Older memory",
                    "feedback",
                    &format!("Stale memory number {i}"),
                )
                .unwrap();
        }
    }

    /// Frees capacity by deleting `count` of the stale memories written by [`Self::fill`].
    fn free(&self, count: usize) {
        for i in 0..count {
            assert!(
                self.advanced
                    .delete_entry("workspace", None, &format!("stale-{i}"))
                    .unwrap()
            );
        }
    }

    async fn generate(
        &self,
        messages: &[Value],
        start: usize,
        remote: Option<RemoteMemoryModel>,
    ) -> Result<usize, String> {
        MemoryGenerator::new()
            .maybe_generate_from_transcript(
                messages,
                start,
                Some(&self.sqlite),
                Some(&self.advanced),
                remote,
            )
            .await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Mock memory model that either extracts one numbered note per call or reports `NONE`.
struct MockMemoryModel {
    calls: Mutex<usize>,
    reply_none: bool,
}

impl MockMemoryModel {
    fn notes() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(0),
            reply_none: false,
        })
    }

    fn nothing_to_save() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(0),
            reply_none: true,
        })
    }

    fn calls(&self) -> usize {
        *self.calls.lock()
    }

    fn remote(self: &Arc<Self>) -> Option<RemoteMemoryModel> {
        Some(RemoteMemoryModel {
            transport: self.clone(),
            model_id: "mock-memory-model".to_owned(),
            base_url: None,
            api_key: None,
        })
    }
}

#[async_trait]
impl ProviderTransport for MockMemoryModel {
    async fn stream_step(
        &self,
        _req: ProviderStepRequest,
        _budget: &StepBudget,
        _on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let call = {
            let mut calls = self.calls.lock();
            *calls += 1;
            *calls
        };
        let text = if self.reply_none {
            "NONE".to_owned()
        } else {
            format!("Generated preference number {call}")
        };
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

fn msg(role: &str, text: &str) -> Value {
    json!({ "role": role, "content": text })
}

fn filler(tag: &str, len: usize) -> String {
    let mut out = String::with_capacity(len + 16);
    let mut i = 0usize;
    while out.len() < len {
        out.push_str(&format!("{tag}{i} "));
        i += 1;
    }
    out.truncate(len);
    out.trim_end().to_owned() + "."
}

/// Four messages that pack into three remote batches: [m0], [m1], [m2 + m3].
fn long_delta() -> Vec<Value> {
    vec![
        msg(
            "user",
            &format!(
                "remember: always run cargo fmt. {}",
                filler("alpha", 15_000)
            ),
        ),
        msg("assistant", &filler("bravo", 15_000)),
        msg("user", &filler("charlie", 15_000)),
        msg("assistant", "Understood."),
    ]
}

#[tokio::test]
async fn full_memory_folder_keeps_the_cursor_until_capacity_is_freed() {
    let fx = Fixture::new("memgen-full-folder");
    fx.fill(FOLDER_LIMIT);
    let messages = vec![
        msg("user", "Please format JSON with two spaces."),
        msg("assistant", "Will do."),
    ];

    let model = MockMemoryModel::notes();
    let res = fx.generate(&messages, 0, model.remote()).await;
    let err = res.expect_err("an unsaved memory must not advance the cursor");
    assert!(err.contains("maximum of 200 entries"), "{err}");
    assert_eq!(model.calls(), 1);
    assert!(
        !fx.bodies()
            .contains(&"Generated preference number 1".to_owned())
    );

    // Freeing capacity lets the same transcript be regenerated and saved.
    fx.free(1);
    let model = MockMemoryModel::notes();
    let next = fx.generate(&messages, 0, model.remote()).await.unwrap();
    assert_eq!(next, messages.len());
    assert!(
        fx.bodies()
            .contains(&"Generated preference number 1".to_owned())
    );
}

#[tokio::test]
async fn storage_failure_in_a_later_batch_checkpoints_before_that_batch() {
    let fx = Fixture::new("memgen-full-later-batch");
    // Batch 1 saves its directive and its extracted note, filling the folder exactly.
    fx.fill(FOLDER_LIMIT - 2);
    let mut messages = vec![msg("user", "Earlier."), msg("assistant", "Earlier answer.")];
    let start = messages.len();
    messages.extend(long_delta());

    let model = MockMemoryModel::notes();
    let next = fx
        .generate(&messages, start, model.remote())
        .await
        .expect("batch 1 progress is reported so the caller persists it");
    assert_eq!(next, start + 1, "cursor stops at the start of batch 2");
    assert_eq!(model.calls(), 2, "the run stops at the unsaved batch");
    let bodies = fx.bodies();
    assert_eq!(bodies.len(), FOLDER_LIMIT);
    assert!(
        bodies
            .iter()
            .any(|b| b.starts_with("remember: always run cargo fmt"))
    );
    assert!(bodies.contains(&"Generated preference number 1".to_owned()));
    assert!(!bodies.contains(&"Generated preference number 2".to_owned()));

    // Once capacity is freed, resuming from the checkpoint regenerates batches 2 and 3.
    fx.free(2);
    let model = MockMemoryModel::notes();
    let next = fx.generate(&messages, next, model.remote()).await.unwrap();
    assert_eq!(next, messages.len());
    assert_eq!(model.calls(), 2);
    let bodies = fx.bodies();
    assert!(bodies.contains(&"Generated preference number 1".to_owned()));
    assert!(bodies.contains(&"Generated preference number 2".to_owned()));
}

#[tokio::test]
async fn unwritable_memory_directory_keeps_the_cursor_and_retry_succeeds() {
    let fx = Fixture::new("memgen-unwritable");
    // A regular file where the memories directory belongs makes every write fail, even as root.
    fs::create_dir_all(&fx.cowork_home).unwrap();
    let blocker = fx.advanced.memories_base_dir();
    fs::write(&blocker, "not a directory").unwrap();
    let messages = vec![
        msg("user", "Prefer rustls over openssl."),
        msg("assistant", "Noted."),
    ];

    let model = MockMemoryModel::notes();
    let err = fx
        .generate(&messages, 0, model.remote())
        .await
        .expect_err("a failed write keeps the transcript retryable");
    assert!(
        err.contains("failed to save generated memory note"),
        "{err}"
    );

    fs::remove_file(&blocker).unwrap();
    let model = MockMemoryModel::notes();
    let next = fx.generate(&messages, 0, model.remote()).await.unwrap();
    assert_eq!(next, messages.len());
    assert_eq!(
        fx.bodies(),
        vec!["Generated preference number 1".to_owned()]
    );
}

#[tokio::test]
async fn nothing_to_save_advances_the_cursor_even_when_storage_is_full() {
    let fx = Fixture::new("memgen-nothing-to-save");
    fx.fill(FOLDER_LIMIT);
    let messages = vec![
        msg("user", "What time is it in Tokyo?"),
        msg("assistant", "It is evening there."),
    ];

    let model = MockMemoryModel::nothing_to_save();
    let next = fx.generate(&messages, 0, model.remote()).await.unwrap();
    assert_eq!(next, messages.len(), "no memory to write is not a failure");
    assert_eq!(model.calls(), 1);
    assert_eq!(fx.bodies().len(), FOLDER_LIMIT);
}

#[tokio::test]
async fn offline_directive_storage_failure_stops_at_its_message() {
    let fx = Fixture::new("memgen-offline-full");
    fx.fill(FOLDER_LIMIT);
    let messages = vec![
        msg("user", "Hello there, quick question."),
        msg("assistant", "Sure."),
        msg("user", "remember: always use tabs for Makefiles."),
        msg("assistant", "Got it."),
    ];

    let next = fx.generate(&messages, 0, None).await.unwrap();
    assert_eq!(
        next, 2,
        "cursor stops before the message whose directive was not saved"
    );

    let err = fx
        .generate(&messages, next, None)
        .await
        .expect_err("no progress past an unsaved directive");
    assert!(err.contains("maximum of 200 entries"), "{err}");

    fx.free(1);
    let next = fx.generate(&messages, next, None).await.unwrap();
    assert_eq!(next, messages.len());
    assert!(
        fx.bodies()
            .contains(&"remember: always use tabs for Makefiles.".to_owned())
    );
}
