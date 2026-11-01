use std::collections::HashMap;
use std::sync::Arc;

use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use cowork_storage::{MemoryScope, MemoryStore, MemoryWriteMode};
use cowork_tools::AdvancedMemoryStore;
use serde_json::Value;
use uuid::Uuid;

/// Cap on each transcript batch handed to the memory generation model, measured in UTF-16
/// code units like the TS generator's `TRANSCRIPT_CHAR_CAP`.
const TRANSCRIPT_CHAR_CAP: usize = 24_000;

pub struct RemoteMemoryModel {
    pub transport: Arc<dyn ProviderTransport>,
    pub model_id: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Default, Clone)]
pub struct MemoryGenerator;

impl MemoryGenerator {
    pub fn new() -> Self {
        Self
    }

    /// Inspects conversation messages starting at `last_memory_generated_index`.
    /// When at least 2 new messages (`user` + `assistant`) exist, extracts durable preferences
    /// or instructions (via headless model calls when `remote_model` is provided, or
    /// deterministic preference/instruction extraction offline) and returns the updated cursor.
    ///
    /// With a remote model the delta is sent losslessly as ordered batches of at most 24,000
    /// UTF-16 code units (`TRANSCRIPT_CHAR_CAP`): whole messages are packed together, and a
    /// single oversized message is split into consecutive fragments. Memories are written and
    /// the cursor checkpointed after each successful batch, and the cursor only ever covers
    /// complete messages (a fragment checkpoints its message only when it is the last one).
    ///
    /// On a failed batch the run stops. If earlier batches advanced the cursor, the last fully
    /// processed index is returned as `Ok` so the caller persists that progress and the
    /// unprocessed suffix is retried later; if no complete message was processed the error is
    /// returned and the cursor stays where it was.
    pub async fn maybe_generate_from_transcript(
        &self,
        messages: &[Value],
        last_memory_generated_index: usize,
        sqlite_store: Option<&MemoryStore>,
        advanced_store: Option<&AdvancedMemoryStore>,
        remote_model: Option<RemoteMemoryModel>,
    ) -> Result<usize, String> {
        if messages.len() < last_memory_generated_index.saturating_add(2) {
            return Ok(last_memory_generated_index);
        }

        let slice = &messages[last_memory_generated_index..];
        let mut rendered = Vec::with_capacity(slice.len());
        let mut directives = Vec::with_capacity(slice.len());

        for msg in slice {
            let role = msg.get("role").and_then(Value::as_str).unwrap_or("unknown");
            let text = extract_text_from_json_message(msg);
            if text.is_empty() {
                rendered.push(RenderedMessage::default());
                directives.push(None);
                continue;
            }
            directives.push(if role == "user" {
                extract_explicit_user_memory_directive(&text)
            } else {
                None
            });
            rendered.push(RenderedMessage {
                role: role.to_owned(),
                line: format!("[{role}] {text}"),
            });
        }

        let Some(remote) = remote_model else {
            write_notes(&directives, sqlite_store, advanced_store);
            return Ok(messages.len());
        };

        // Number of leading delta messages whose memories have been written.
        let mut processed = 0usize;
        for (batch_number, batch) in memory_transcript_batches(&rendered).into_iter().enumerate() {
            let prompt = batch_prompt(batch_number + 1, &batch);
            match run_remote_extraction(&remote, &prompt).await {
                Ok(extracted) => {
                    write_notes(
                        &directives[processed..batch.processed_message_count],
                        sqlite_store,
                        advanced_store,
                    );
                    if let Some(note) = extracted {
                        write_note(&note, sqlite_store, advanced_store);
                    }
                    processed = processed.max(batch.processed_message_count);
                }
                Err(err) if processed == 0 => return Err(err),
                Err(err) => {
                    let checkpoint = last_memory_generated_index + processed;
                    tracing::warn!(
                        error = %err,
                        checkpoint,
                        "memory generation batch failed; cursor checkpointed after the last fully processed message"
                    );
                    return Ok(checkpoint);
                }
            }
        }

        // Every batch succeeded; messages with no text (including trailing ones) count as done.
        write_notes(&directives[processed..], sqlite_store, advanced_store);
        Ok(messages.len())
    }
}

#[derive(Default)]
struct RenderedMessage {
    role: String,
    /// Empty when the message has no text to analyze.
    line: String,
}

struct TranscriptBatch {
    transcript: String,
    /// Contiguous complete delta messages covered once this batch succeeds.
    processed_message_count: usize,
    /// Set when the batch holds a fragment of one oversized message.
    fragment_role: Option<String>,
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Port of the TS `memoryTranscriptBatches`: preserves whole messages where possible and
/// splits an oversized message into ordered fragments without breaking a character.
fn memory_transcript_batches(messages: &[RenderedMessage]) -> Vec<TranscriptBatch> {
    let mut batches = Vec::new();
    let mut transcript = String::new();
    let mut transcript_len = 0usize;
    let mut processed_message_count = 0usize;
    for (index, message) in messages.iter().enumerate() {
        let rendered = message.line.as_str();
        if rendered.is_empty() {
            processed_message_count = index + 1;
            continue;
        }
        let rendered_len = utf16_len(rendered);
        if !transcript.is_empty() && transcript_len + 1 + rendered_len > TRANSCRIPT_CHAR_CAP {
            batches.push(TranscriptBatch {
                transcript: std::mem::take(&mut transcript),
                processed_message_count,
                fragment_role: None,
            });
            transcript_len = 0;
        }
        if rendered_len > TRANSCRIPT_CHAR_CAP {
            let mut fragment = String::new();
            let mut fragment_len = 0usize;
            for ch in rendered.chars() {
                let ch_len = ch.len_utf16();
                if fragment_len + ch_len > TRANSCRIPT_CHAR_CAP {
                    batches.push(TranscriptBatch {
                        transcript: std::mem::take(&mut fragment),
                        // A successful fragment cannot checkpoint the rest of its message.
                        processed_message_count: index,
                        fragment_role: Some(message.role.clone()),
                    });
                    fragment_len = 0;
                }
                fragment.push(ch);
                fragment_len += ch_len;
            }
            batches.push(TranscriptBatch {
                transcript: fragment,
                processed_message_count: index + 1,
                fragment_role: Some(message.role.clone()),
            });
        } else {
            if !transcript.is_empty() {
                transcript.push('\n');
                transcript_len += 1;
            }
            transcript.push_str(rendered);
            transcript_len += rendered_len;
        }
        processed_message_count = index + 1;
    }
    if !transcript.is_empty() {
        batches.push(TranscriptBatch {
            transcript,
            processed_message_count,
            fragment_role: None,
        });
    }
    batches
}

fn batch_prompt(batch_number: usize, batch: &TranscriptBatch) -> String {
    let fragment_note = batch
        .fragment_role
        .as_deref()
        .map(|role| {
            format!(
                "This batch contains a fragment of one {role} message; later batches may continue it.\n"
            )
        })
        .unwrap_or_default();
    format!(
        "Batch {batch_number} of an ordered conversation delta.\n{fragment_note}\nConversation delta since memory was last updated:\n\n{}",
        batch.transcript
    )
}

fn write_notes(
    notes: &[Option<String>],
    sqlite_store: Option<&MemoryStore>,
    advanced_store: Option<&AdvancedMemoryStore>,
) {
    for note in notes.iter().flatten() {
        write_note(note, sqlite_store, advanced_store);
    }
}

fn write_note(
    note: &str,
    sqlite_store: Option<&MemoryStore>,
    advanced_store: Option<&AdvancedMemoryStore>,
) {
    if let Some(adv) = advanced_store {
        let title: String = note.chars().take(40).collect();
        let _ = adv.upsert_entry(
            "workspace",
            None,
            &title,
            &title,
            "Auto-extracted conversation preference",
            "feedback",
            note,
        );
    } else if let Some(sql) = sqlite_store {
        let key = format!("auto-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let _ = sql.upsert(
            MemoryScope::Workspace,
            Some(&key),
            note,
            MemoryWriteMode::Upsert,
        );
    }
}

fn extract_text_from_json_message(msg: &Value) -> String {
    if let Some(s) = msg.get("content").and_then(Value::as_str) {
        return s.trim().to_owned();
    }
    if let Some(arr) = msg.get("content").and_then(Value::as_array) {
        return arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned();
    }
    String::new()
}

fn extract_explicit_user_memory_directive(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        for prefix in [
            "remember:",
            "remember that ",
            "always use ",
            "never use ",
            "convention:",
        ] {
            if lower.starts_with(prefix) && trimmed.len() >= 12 {
                return Some(trimmed.chars().take(300).collect());
            }
        }
    }
    None
}

async fn run_remote_extraction(
    remote: &RemoteMemoryModel,
    prompt: &str,
) -> Result<Option<String>, String> {
    let model_id = remote.model_id.clone();
    let req = ProviderStepRequest {
        model_id: remote.model_id.clone(),
        base_url: remote.base_url.clone(),
        api_key: remote.api_key.clone(),
        extra_headers: HashMap::new(),
        system_prompt: "Extract at most ONE concise durable engineering preference or convention stated by the user. If there is no durable preference worth remembering across future sessions, reply with NONE.".to_owned(),
        messages: vec![CanonicalMessage {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: prompt.to_owned(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }],
            phase: None,
            provider: None,
            api: None,
            model: None,
            stop_reason: None,
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: chrono::Utc::now().to_rfc3339(),
        }],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: Default::default(),
        continuation: None,
        policy: RequestPolicy {
            max_attempts: 1,
            timeout_ms: 20_000,
            ..RequestPolicy::default()
        },
        turn_id: format!("memgen_{}", Uuid::new_v4()),
    };
    let budget = StepBudget::new(20_000, None);
    let mut noop = |_ev| {};
    let res = remote
        .transport
        .stream_step(req, &budget, &mut noop)
        .await
        .map_err(|e| format!("memory generation model '{model_id}' failed: {e}"))?;
    let reply = res
        .assistant
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    if reply.is_empty() || reply.eq_ignore_ascii_case("none") {
        Ok(None)
    } else {
        Ok(Some(reply))
    }
}
