//! Lossless transcript batching for remote memory generation: oversized deltas are sent as
//! ordered batches covering every character, and the cursor only advances over messages whose
//! batches all succeeded (parity with the TS `memoryTranscriptBatches` generator).

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
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

const CAP: usize = 24_000;
const DELTA_MARKER: &str = "Conversation delta since memory was last updated:\n\n";

fn isolated_store(prefix: &str) -> (PathBuf, MemoryStore) {
    let root = std::env::temp_dir().join(format!("cowork-harness-{prefix}-{}", Uuid::new_v4()));
    let home = root.join("home");
    let ws = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let store = MemoryStore::new(ws.join("memory.db"), home.join("memory.db"));
    (root, store)
}

/// Mock memory model: records every prompt, replies with a per-call note, and fails the
/// configured (1-based) call.
struct MockMemoryModel {
    prompts: Mutex<Vec<String>>,
    fail_on_call: Option<usize>,
}

impl MockMemoryModel {
    fn new(fail_on_call: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            prompts: Mutex::new(Vec::new()),
            fail_on_call,
        })
    }

    fn prompts(&self) -> Vec<String> {
        self.prompts.lock().clone()
    }

    /// The transcript portion of each recorded prompt, in send order.
    fn transcripts(&self) -> Vec<String> {
        self.prompts()
            .iter()
            .map(|p| {
                p.split_once(DELTA_MARKER)
                    .expect("prompt carries the delta marker")
                    .1
                    .to_owned()
            })
            .collect()
    }
}

#[async_trait]
impl ProviderTransport for MockMemoryModel {
    async fn stream_step(
        &self,
        req: ProviderStepRequest,
        _budget: &StepBudget,
        _on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        assert_eq!(req.messages.len(), 1);
        let prompt = req.messages[0]
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let call = {
            let mut prompts = self.prompts.lock();
            prompts.push(prompt);
            prompts.len()
        };
        if self.fail_on_call == Some(call) {
            return Err(ProviderTransportError::protocol("upstream overloaded"));
        }
        Ok(ProviderStepResult {
            assistant: CanonicalMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::Assistant,
                content: vec![ContentBlock::Text {
                    text: format!("Batch preference number {call}"),
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

fn remote(model: &Arc<MockMemoryModel>) -> RemoteMemoryModel {
    RemoteMemoryModel {
        transport: model.clone(),
        model_id: "mock-memory-model".to_owned(),
        base_url: None,
        api_key: None,
    }
}

fn msg(role: &str, text: &str) -> Value {
    json!({ "role": role, "content": text })
}

fn line(message: &Value) -> String {
    format!(
        "[{}] {}",
        message["role"].as_str().unwrap(),
        message["content"].as_str().unwrap()
    )
}

/// `len` characters of distinct, position-identifying filler.
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

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn notes(store: &MemoryStore) -> Vec<String> {
    let mut notes: Vec<String> = store
        .list(None)
        .unwrap()
        .into_iter()
        .map(|e| e.content)
        .collect();
    notes.sort();
    notes
}

/// Four messages that pack into three batches: [m0], [m1], [m2 + m3].
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
        msg(
            "user",
            &format!(
                "{} Correction: never use unwrap in library code.",
                filler("charlie", 15_000)
            ),
        ),
        msg("assistant", "Understood, no unwrap in library code."),
    ]
}

#[tokio::test]
async fn long_delta_is_sent_in_ordered_lossless_batches_and_cursor_reaches_end() {
    let (root, store) = isolated_store("memgen-batches");
    let messages = long_delta();
    let model = MockMemoryModel::new(None);

    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(&messages, 0, Some(&store), None, Some(remote(&model)))
        .await
        .unwrap();
    assert_eq!(next, messages.len());

    let prompts = model.prompts();
    assert_eq!(prompts.len(), 3, "delta must be split into three batches");
    for (i, prompt) in prompts.iter().enumerate() {
        assert!(
            prompt.starts_with(&format!(
                "Batch {} of an ordered conversation delta.",
                i + 1
            )),
            "batches are numbered in order: {}",
            &prompt[..80]
        );
        assert!(!prompt.contains("fragment"), "no batch is a fragment here");
    }
    let transcripts = model.transcripts();
    assert_eq!(transcripts[0], line(&messages[0]));
    assert_eq!(transcripts[1], line(&messages[1]));
    assert_eq!(
        transcripts[2],
        format!("{}\n{}", line(&messages[2]), line(&messages[3]))
    );
    assert!(transcripts.iter().all(|t| utf16_len(t) <= CAP));
    // Nothing past the old 4,000-character cutoff is lost, including the late correction.
    let full: Vec<String> = messages.iter().map(line).collect();
    assert_eq!(transcripts.join("\n"), full.join("\n"));
    assert!(transcripts[2].ends_with("no unwrap in library code."));

    // The offline directive plus one extracted note per successful batch.
    let saved = notes(&store);
    assert_eq!(saved.len(), 4, "{saved:?}");
    assert!(
        saved
            .iter()
            .any(|n| n.starts_with("remember: always run cargo fmt"))
    );
    for call in 1..=3 {
        assert!(saved.contains(&format!("Batch preference number {call}")));
    }
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn oversized_message_is_split_into_fragments_that_checkpoint_only_when_complete() {
    let (root, store) = isolated_store("memgen-fragments");
    // Astral-plane characters are two UTF-16 code units; fragments must never split one.
    let huge: String = "ab\u{1F600}".repeat(16_000) + " end-of-huge-message";
    let messages = vec![
        msg("user", "Short opener before the big paste."),
        msg("user", &huge),
        msg("assistant", "Done."),
    ];
    assert!(utf16_len(&line(&messages[1])) > 2 * CAP);

    let model = MockMemoryModel::new(None);
    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(&messages, 0, Some(&store), None, Some(remote(&model)))
        .await
        .unwrap();
    assert_eq!(next, 3);

    let prompts = model.prompts();
    let transcripts = model.transcripts();
    // [opener] flushed before the oversized message, three fragments, then [assistant].
    assert_eq!(
        prompts.len(),
        5,
        "{:?}",
        transcripts.iter().map(|t| t.len()).collect::<Vec<_>>()
    );
    assert_eq!(transcripts[0], line(&messages[0]));
    assert_eq!(transcripts[1..4].concat(), line(&messages[1]));
    assert_eq!(transcripts[4], line(&messages[2]));
    for (i, prompt) in prompts.iter().enumerate() {
        let is_fragment = (1..4).contains(&i);
        assert_eq!(
            prompt.contains(
                "This batch contains a fragment of one user message; later batches may continue it."
            ),
            is_fragment,
            "batch {}",
            i + 1
        );
    }
    for t in &transcripts[1..3] {
        // Full fragments stop at the cap or one unit short when a surrogate pair would straddle it.
        let len = utf16_len(t);
        assert!(len == CAP || len == CAP - 1, "fragment length {len}");
    }
    assert!(transcripts.iter().all(|t| utf16_len(t) <= CAP));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn failure_in_second_batch_checkpoints_after_first_batch_and_retry_resumes_there() {
    let (root, store) = isolated_store("memgen-partial");
    let mut messages = vec![
        msg("user", "Earlier question already processed."),
        msg("assistant", "Earlier answer."),
    ];
    let start = messages.len();
    messages.extend(long_delta());
    let mut directive_in_batch_two = messages[start + 1].clone();
    directive_in_batch_two["content"] = json!(format!(
        "remember: prefer tokio over async-std. {}",
        filler("bravo", 15_000)
    ));
    directive_in_batch_two["role"] = json!("user");
    messages[start + 1] = directive_in_batch_two;

    let failing = MockMemoryModel::new(Some(2));
    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(
            &messages,
            start,
            Some(&store),
            None,
            Some(remote(&failing)),
        )
        .await
        .expect("progress from batch 1 is reported so the caller persists it");
    assert_eq!(
        next,
        start + 1,
        "cursor sits after the first batch's message"
    );
    assert_eq!(
        failing.prompts().len(),
        2,
        "the run stops at the failed batch"
    );
    assert_eq!(failing.transcripts()[0], line(&messages[start]));

    let saved = notes(&store);
    assert_eq!(
        saved.len(),
        2,
        "only batch 1 memories are written: {saved:?}"
    );
    assert!(
        saved
            .iter()
            .any(|n| n.starts_with("remember: always run cargo fmt"))
    );
    assert!(saved.contains(&"Batch preference number 1".to_owned()));
    assert!(!saved.iter().any(|n| n.contains("tokio")));

    // Retrying from the checkpoint resends exactly the unprocessed suffix.
    let healthy = MockMemoryModel::new(None);
    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(&messages, next, Some(&store), None, Some(remote(&healthy)))
        .await
        .unwrap();
    assert_eq!(next, messages.len());
    let full: Vec<String> = messages[start + 1..].iter().map(line).collect();
    assert_eq!(healthy.transcripts().join("\n"), full.join("\n"));
    assert!(notes(&store).iter().any(|n| n.contains("prefer tokio")));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn failed_fragment_never_checkpoints_its_partially_processed_message() {
    let (root, store) = isolated_store("memgen-fragment-fail");
    let messages = vec![
        msg("user", "Short opener before the big paste."),
        msg("user", &filler("delta", 2 * CAP + 10)),
        msg("assistant", "Done."),
    ];

    // Batch 1 = opener, batches 2..=4 = fragments: the first two fragments succeed, the last fails.
    let model = MockMemoryModel::new(Some(4));
    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(&messages, 0, Some(&store), None, Some(remote(&model)))
        .await
        .unwrap();
    assert_eq!(model.prompts().len(), 4);
    assert_eq!(next, 1, "a partially sent message is retried in full later");

    // A failure before any complete message is processed is an error and leaves the cursor.
    let (root2, store2) = isolated_store("memgen-fragment-fail-first");
    let only_huge = vec![
        msg("user", &filler("echo", 2 * CAP)),
        msg("assistant", "Done."),
    ];
    let model = MockMemoryModel::new(Some(2));
    let res = MemoryGenerator::new()
        .maybe_generate_from_transcript(&only_huge, 0, Some(&store2), None, Some(remote(&model)))
        .await;
    assert!(res.is_err(), "no complete message processed: {res:?}");
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(root2);
}
