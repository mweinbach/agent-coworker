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
    /// or instructions (via headless model call when `remote_model` is provided, or deterministic
    /// preference/instruction extraction offline) and returns the updated cursor.
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
        let mut transcript_lines = Vec::new();
        let mut durable_notes = Vec::new();

        for msg in slice {
            let role = msg.get("role").and_then(Value::as_str).unwrap_or("unknown");
            let text = extract_text_from_json_message(msg);
            if text.is_empty() {
                continue;
            }
            transcript_lines.push(format!("[{role}] {text}"));
            if role == "user"
                && let Some(note) = extract_explicit_user_memory_directive(&text)
            {
                durable_notes.push(note);
            }
        }

        if let Some(remote) = remote_model
            && !transcript_lines.is_empty()
            && let Some(extracted) =
                run_remote_extraction(remote, &transcript_lines.join("\n")).await
        {
            durable_notes.push(extracted);
        }

        for note in durable_notes {
            if let Some(adv) = advanced_store {
                let title: String = note.chars().take(40).collect();
                let _ = adv.upsert_entry(
                    "workspace",
                    None,
                    &title,
                    &title,
                    "Auto-extracted conversation preference",
                    "feedback",
                    &note,
                );
            } else if let Some(sql) = sqlite_store {
                let key = format!("auto-{}", &Uuid::new_v4().simple().to_string()[..8]);
                let _ = sql.upsert(
                    MemoryScope::Workspace,
                    Some(&key),
                    &note,
                    MemoryWriteMode::Upsert,
                );
            }
        }

        Ok(messages.len())
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

async fn run_remote_extraction(remote: RemoteMemoryModel, transcript: &str) -> Option<String> {
    let req = ProviderStepRequest {
        model_id: remote.model_id,
        base_url: remote.base_url,
        api_key: remote.api_key,
        extra_headers: HashMap::new(),
        system_prompt: "Extract at most ONE concise durable engineering preference or convention stated by the user. If there is no durable preference worth remembering across future sessions, reply with NONE.".to_owned(),
        messages: vec![CanonicalMessage {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: transcript.chars().take(4000).collect(),
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
        .ok()?;
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
        None
    } else {
        Some(reply)
    }
}
