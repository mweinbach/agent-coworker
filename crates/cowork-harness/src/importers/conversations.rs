//! External conversation importer (`cowork/conversationImport/{sources/list,preview,workspaceMappings/validate,import}`).
//!
//! Supports Codex (`~/.codex/state_5.sqlite`, `sessions`, `archived_sessions`), Claude Code
//! (`~/.claude/projects/**/*.jsonl` + `~/.claude.json`), and Cowork (`sessions.db`, refusing
//! self-import). Sanitizes `<past_conversation>` handoff context and persists idempotently via
//! `SessionDb::persist_external_conversation_import`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, TimeZone, Utc};
use cowork_config::{
    AgentConfig, ModelRegistry, ProviderName, canonicalize_sync, same_workspace_path,
};
use cowork_storage::{
    AgentExecutionState, PersistedExternalConversationImport,
    PersistedExternalConversationImportMutation, PersistedSessionMutation,
    PersistedSessionSnapshotData, SessionDb, SessionKind, SessionPersistenceStatus,
    SessionTitleSource,
};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const MAX_ITEM_TEXT_CHARS: usize = 80_000;
const MAX_TITLE_CHARS: usize = 180;
const MAX_HANDOFF_CHARS: usize = 80_000;
const MAX_RECENT_VISIBLE_MESSAGES: usize = 40;
const MAX_TOOL_SUMMARY_CHARS: usize = 20_000;
const MAX_SUMMARY_CHARS: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ConversationImportSource {
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "cowork")]
    Cowork,
}

impl ConversationImportSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::Cowork => "cowork",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationImportWarningCode {
    MissingCwd,
    MissingWorkspace,
    UnsupportedModel,
    Truncated,
    ReasoningRedacted,
    ToolProtocolRedacted,
    ParsePartial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationImportWarning {
    pub code: ConversationImportWarningCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExternalConversationItem {
    User {
        id: String,
        ts: String,
        text: String,
    },
    Assistant {
        id: String,
        ts: String,
        text: String,
    },
    Tool {
        id: String,
        ts: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Reasoning {
        id: String,
        ts: String,
        mode: String,
        text: String,
    },
    System {
        id: String,
        ts: String,
        text: String,
    },
}

impl ExternalConversationItem {
    pub fn ts(&self) -> &str {
        match self {
            Self::User { ts, .. }
            | Self::Assistant { ts, .. }
            | Self::Tool { ts, .. }
            | Self::Reasoning { ts, .. }
            | Self::System { ts, .. } => ts,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalConversation {
    pub source: ConversationImportSource,
    pub source_id: String,
    pub source_path: Option<String>,
    pub fingerprint: String,
    pub cwd: Option<String>,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub original_provider: Option<String>,
    pub original_model: Option<String>,
    pub items: Vec<ExternalConversationItem>,
    pub summary: Option<String>,
    pub warnings: Vec<ConversationImportWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSourceCandidate {
    pub source: ConversationImportSource,
    pub id: String,
    pub path: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationSourceRequest {
    pub source: ConversationImportSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationSourceSelectionOptions {
    #[serde(default)]
    pub sources: Option<Vec<ConversationSourceRequest>>,
    #[serde(default)]
    pub include_codex: Option<bool>,
    #[serde(default)]
    pub include_claude_code: Option<bool>,
    #[serde(default)]
    pub include_cowork: Option<bool>,
    #[serde(default)]
    pub explicit_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConversationWorkspaceMapping {
    #[serde(rename_all = "camelCase")]
    Matched {
        workspace_id: String,
        workspace_path: String,
    },
    #[serde(rename_all = "camelCase")]
    Create {
        workspace_path: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    Missing {
        original_path: Option<String>,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ConversationWorkspaceMappingInput {
    #[serde(rename_all = "camelCase")]
    Existing { workspace_id: String },
    #[serde(rename_all = "camelCase")]
    Fallback { workspace_id: String },
    #[serde(rename_all = "camelCase")]
    Create {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPreviewItem {
    pub source: ConversationImportSource,
    pub source_id: String,
    pub source_path: Option<String>,
    pub fingerprint: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub original_provider: Option<String>,
    pub original_model: Option<String>,
    pub message_count: usize,
    pub tool_count: usize,
    pub warnings: Vec<ConversationImportWarning>,
    pub mapping: ConversationWorkspaceMapping,
    pub already_imported_thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationImportPreviewResult {
    pub conversations: Vec<ConversationPreviewItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMappingValidationError {
    pub fingerprint: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWorkspaceMappingsValidateResult {
    pub valid: bool,
    pub mappings: BTreeMap<String, ConversationWorkspaceMapping>,
    pub errors: Vec<WorkspaceMappingValidationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedConversationInput {
    pub source: ConversationImportSource,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversationSummary {
    pub source: ConversationImportSource,
    pub fingerprint: String,
    pub thread_id: String,
    pub workspace_id: Option<String>,
    pub workspace_path: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedConversationSummary {
    pub source: ConversationImportSource,
    pub fingerprint: String,
    pub existing_thread_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedConversationSummary {
    pub source: ConversationImportSource,
    pub fingerprint: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkspaceSummary {
    pub workspace_id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationImportImportResult {
    pub imported: Vec<ImportedConversationSummary>,
    pub skipped: Vec<SkippedConversationSummary>,
    pub failed: Vec<FailedConversationSummary>,
    pub created_workspaces: Vec<CreatedWorkspaceSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownWorkspaceEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct EnsuredWorkspaceOutcome {
    pub workspace_id: Option<String>,
    pub workspace_path: String,
    pub name: String,
    pub created: bool,
}

#[derive(Debug, Clone)]
pub struct ConversationImportRunInput {
    pub selection: ConversationSourceSelectionOptions,
    pub selected: Vec<SelectedConversationInput>,
    pub mappings: Option<BTreeMap<String, ConversationWorkspaceMappingInput>>,
    pub provider: Option<ProviderName>,
    pub model: Option<String>,
    pub default_provider: Option<ProviderName>,
    pub default_model: Option<String>,
    pub include_archived: Option<bool>,
}

// =============================================================================
// Normalization & Redaction Helpers
// =============================================================================

fn stable_hash(val: &Value) -> String {
    let text = match val {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub fn short_hash(val: &Value, len: usize) -> String {
    let full = stable_hash(val);
    full.chars().take(len).collect()
}

pub fn normalize_iso_timestamp(val: Option<&Value>, fallback: &str) -> String {
    let Some(v) = val else {
        return fallback.to_owned();
    };
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if !trimmed.is_empty()
            && let Ok(dt) = DateTime::parse_from_rfc3339(trimmed)
        {
            return dt
                .with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        }
    }
    if let Some(num) = v.as_f64().filter(|n| n.is_finite()) {
        let millis = if num.abs() > 10_000_000_000.0 {
            num as i64
        } else {
            (num * 1000.0) as i64
        };
        if let Some(dt) = Utc.timestamp_millis_opt(millis).single() {
            return dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        }
    }
    fallback.to_owned()
}

pub fn normalize_text(raw: &str) -> String {
    let lf = raw.replace("\r\n", "\n");
    let mut lines = Vec::new();
    for line in lf.split('\n') {
        lines.push(line.trim_end_matches([' ', '\t']));
    }
    lines.join("\n").trim().to_owned()
}

fn truncate_chars(
    value: &str,
    limit: usize,
    warnings: Option<&mut Vec<ConversationImportWarning>>,
) -> String {
    let count = value.chars().count();
    if count <= limit {
        return value.to_owned();
    }
    if let Some(w) = warnings {
        w.push(ConversationImportWarning {
            code: ConversationImportWarningCode::Truncated,
            message: format!("Imported text was truncated to {limit} characters."),
        });
    }
    let prefix: String = value.chars().take(limit).collect();
    format!("{prefix}\n\n[truncated]")
}

fn title_from_text(value: &str, fallback: &str) -> String {
    let norm = normalize_text(value);
    let line = norm
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.is_empty() {
        return fallback.to_owned();
    }
    let count = line.chars().count();
    if count > MAX_TITLE_CHARS {
        let head: String = line.chars().take(MAX_TITLE_CHARS - 1).collect();
        format!("{head}...")
    } else {
        line.to_owned()
    }
}

pub fn extract_text_from_content(value: Option<&Value>) -> String {
    let Some(v) = value else {
        return String::new();
    };
    match v {
        Value::String(s) => normalize_text(s),
        Value::Array(arr) => {
            let mut parts = Vec::new();
            for part in arr {
                match part {
                    Value::String(s) if !s.is_empty() => parts.push(s.clone()),
                    Value::Object(obj) => {
                        for key in ["text", "input_text", "inputText", "content"] {
                            if let Some(s) = obj.get(key).and_then(Value::as_str)
                                && !s.is_empty()
                            {
                                parts.push(s.to_owned());
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            normalize_text(&parts.join("\n"))
        }
        Value::Object(obj) => {
            if let Some(s) = obj.get("text").and_then(Value::as_str) {
                normalize_text(s)
            } else if let Some(s) = obj.get("content").and_then(Value::as_str) {
                normalize_text(s)
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

fn make_external_item_id(
    source: ConversationImportSource,
    source_id: &str,
    index: usize,
    kind: &str,
    seed: &Value,
) -> String {
    let h = short_hash(
        &json!({
            "sourceId": source_id,
            "index": index,
            "kind": kind,
            "seed": seed,
        }),
        16,
    );
    format!("import-{}-{h}", source.as_str())
}

#[allow(clippy::too_many_arguments)]
fn normalize_external_conversation(
    source: ConversationImportSource,
    source_id: String,
    source_path: Option<String>,
    cwd: Option<String>,
    raw_title: String,
    raw_created_at: String,
    raw_updated_at: String,
    original_provider: Option<String>,
    original_model: Option<String>,
    raw_items: Vec<ExternalConversationItem>,
    raw_summary: Option<String>,
    mut warnings: Vec<ConversationImportWarning>,
) -> ExternalConversation {
    let epoch = "1970-01-01T00:00:00.000Z";
    let fallback_ts = normalize_iso_timestamp(Some(&Value::String(raw_updated_at.clone())), epoch);

    let mut items: Vec<ExternalConversationItem> = raw_items
        .into_iter()
        .enumerate()
        .filter_map(|(idx, item)| match item {
            ExternalConversationItem::Tool {
                id,
                ts,
                name,
                args,
                result,
                error,
            } => {
                let norm_ts = normalize_iso_timestamp(Some(&Value::String(ts)), &fallback_ts);
                let norm_name = {
                    let t = normalize_text(&name);
                    if t.is_empty() { "tool".to_owned() } else { t }
                };
                let norm_err = error.map(|e| {
                    truncate_chars(
                        &normalize_text(&e),
                        MAX_ITEM_TEXT_CHARS,
                        Some(&mut warnings),
                    )
                });
                let final_id = if id.is_empty() {
                    make_external_item_id(source, &source_id, idx, "tool", &json!(norm_name))
                } else {
                    id
                };
                Some(ExternalConversationItem::Tool {
                    id: final_id,
                    ts: norm_ts,
                    name: norm_name,
                    args,
                    result,
                    error: norm_err,
                })
            }
            ExternalConversationItem::User { id, ts, text } => {
                let norm_text = truncate_chars(
                    &normalize_text(&text),
                    MAX_ITEM_TEXT_CHARS,
                    Some(&mut warnings),
                );
                if norm_text.is_empty() {
                    return None;
                }
                let norm_ts = normalize_iso_timestamp(Some(&Value::String(ts)), &fallback_ts);
                let final_id = if id.is_empty() {
                    make_external_item_id(source, &source_id, idx, "user", &json!(norm_text))
                } else {
                    id
                };
                Some(ExternalConversationItem::User {
                    id: final_id,
                    ts: norm_ts,
                    text: norm_text,
                })
            }
            ExternalConversationItem::Assistant { id, ts, text } => {
                let norm_text = truncate_chars(
                    &normalize_text(&text),
                    MAX_ITEM_TEXT_CHARS,
                    Some(&mut warnings),
                );
                if norm_text.is_empty() {
                    return None;
                }
                let norm_ts = normalize_iso_timestamp(Some(&Value::String(ts)), &fallback_ts);
                let final_id = if id.is_empty() {
                    make_external_item_id(source, &source_id, idx, "assistant", &json!(norm_text))
                } else {
                    id
                };
                Some(ExternalConversationItem::Assistant {
                    id: final_id,
                    ts: norm_ts,
                    text: norm_text,
                })
            }
            ExternalConversationItem::Reasoning { id, ts, mode, text } => {
                let norm_text = truncate_chars(
                    &normalize_text(&text),
                    MAX_ITEM_TEXT_CHARS,
                    Some(&mut warnings),
                );
                if norm_text.is_empty() {
                    return None;
                }
                let norm_ts = normalize_iso_timestamp(Some(&Value::String(ts)), &fallback_ts);
                let final_id = if id.is_empty() {
                    make_external_item_id(source, &source_id, idx, "reasoning", &json!(norm_text))
                } else {
                    id
                };
                Some(ExternalConversationItem::Reasoning {
                    id: final_id,
                    ts: norm_ts,
                    mode,
                    text: norm_text,
                })
            }
            ExternalConversationItem::System { id, ts, text } => {
                let norm_text = truncate_chars(
                    &normalize_text(&text),
                    MAX_ITEM_TEXT_CHARS,
                    Some(&mut warnings),
                );
                if norm_text.is_empty() {
                    return None;
                }
                let norm_ts = normalize_iso_timestamp(Some(&Value::String(ts)), &fallback_ts);
                let final_id = if id.is_empty() {
                    make_external_item_id(source, &source_id, idx, "system", &json!(norm_text))
                } else {
                    id
                };
                Some(ExternalConversationItem::System {
                    id: final_id,
                    ts: norm_ts,
                    text: norm_text,
                })
            }
        })
        .collect();

    items.sort_by(|a, b| a.ts().cmp(b.ts()));

    let first_ts = items.first().map(|i| i.ts()).unwrap_or(&fallback_ts);
    let created_at = normalize_iso_timestamp(Some(&Value::String(raw_created_at)), first_ts);
    let last_ts = items.last().map(|i| i.ts()).unwrap_or(&created_at);
    let updated_at = normalize_iso_timestamp(Some(&Value::String(raw_updated_at)), last_ts);

    let first_user_text = items
        .iter()
        .find_map(|i| match i {
            ExternalConversationItem::User { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("");
    let fallback_title = title_from_text(first_user_text, "Imported chat");
    let title = title_from_text(&raw_title, &fallback_title);

    let summary = raw_summary.map(|s| {
        truncate_chars(
            &normalize_text(&s),
            MAX_ITEM_TEXT_CHARS,
            Some(&mut warnings),
        )
    });

    let fingerprint = stable_hash(&json!({
        "source": source.as_str(),
        "sourceId": source_id,
        "sourcePath": source_path,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "count": items.len(),
        "first": items.first(),
        "last": items.last(),
    }));

    ExternalConversation {
        source,
        source_id,
        source_path,
        fingerprint,
        cwd,
        title,
        created_at,
        updated_at,
        original_provider,
        original_model,
        items,
        summary,
        warnings,
    }
}

fn sensitive_token_regexes() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"call_[A-Za-z0-9_-]+",
            r"toolu_[A-Za-z0-9_-]+",
            r"resp_[A-Za-z0-9_-]+",
            r"response_[A-Za-z0-9_-]+",
            r"thread_[A-Za-z0-9_-]+",
            r"run_[A-Za-z0-9_-]+",
            r"msg_[A-Za-z0-9_-]+",
            r"gAAAAA[A-Za-z0-9_-]+",
            r"[A-Za-z0-9+/=]{160,}",
        ]
        .into_iter()
        .map(|pat| Regex::new(pat).expect("valid token redaction regex"))
        .collect()
    })
}

pub fn redact_provider_continuation_tokens(value: &str) -> String {
    let mut next = value.to_owned();
    for re in sensitive_token_regexes() {
        next = re
            .replace_all(&next, "[redacted-provider-token]")
            .into_owned();
    }
    next
}

pub fn build_safe_handoff_text(conversation: &ExternalConversation) -> String {
    let mut sections = Vec::new();
    sections.push(format!(
        "<past_conversation source=\"{}\" original_model=\"{}\">",
        conversation.source.as_str(),
        conversation.original_model.as_deref().unwrap_or("unknown")
    ));
    sections.push(format!("Title:\n{}", conversation.title));
    if let Some(ref cwd) = conversation.cwd {
        sections.push(format!("Original workspace:\n{cwd}"));
    }
    if let Some(ref sum) = conversation.summary {
        let redacted = redact_provider_continuation_tokens(sum);
        if !redacted.is_empty() {
            sections.push(format!("Summary:\n{redacted}"));
        }
    }

    let visible: Vec<String> = conversation
        .items
        .iter()
        .filter_map(|item| match item {
            ExternalConversationItem::User { text, .. } => Some(format!(
                "User: {}",
                redact_provider_continuation_tokens(text)
            )),
            ExternalConversationItem::Assistant { text, .. } => Some(format!(
                "Assistant: {}",
                redact_provider_continuation_tokens(text)
            )),
            _ => None,
        })
        .collect();
    if !visible.is_empty() {
        let recent_start = visible.len().saturating_sub(MAX_RECENT_VISIBLE_MESSAGES);
        sections.push(format!(
            "Recent visible transcript:\n{}",
            visible[recent_start..].join("\n\n")
        ));
    }

    let tool_lines: Vec<String> = conversation
        .items
        .iter()
        .filter_map(|item| match item {
            ExternalConversationItem::Tool {
                name,
                result,
                error,
                ..
            } => {
                let status = if let Some(err) = error {
                    format!("error: {err}")
                } else if let Some(res) = result {
                    let s = match res {
                        Value::String(s) => normalize_text(s),
                        other => normalize_text(&serde_json::to_string(other).unwrap_or_default()),
                    };
                    if s.is_empty() {
                        "completed".to_owned()
                    } else {
                        s
                    }
                } else {
                    "completed".to_owned()
                };
                Some(format!("- {name}: {status}"))
            }
            _ => None,
        })
        .collect();
    if !tool_lines.is_empty() {
        let summary = truncate_chars(
            &redact_provider_continuation_tokens(&tool_lines.join("\n")),
            MAX_TOOL_SUMMARY_CHARS,
            None,
        );
        sections.push(format!("Tool activity summary:\n{summary}"));
    }

    let reasoning_lines: Vec<String> = conversation
        .items
        .iter()
        .filter_map(|item| match item {
            ExternalConversationItem::Reasoning { text, .. } => {
                Some(redact_provider_continuation_tokens(text))
            }
            _ => None,
        })
        .collect();
    if !reasoning_lines.is_empty() {
        let summary = truncate_chars(&reasoning_lines.join("\n\n"), MAX_SUMMARY_CHARS, None);
        sections.push(format!("Visible reasoning summaries:\n{summary}"));
    }

    sections.push(
        "Safety note:\nThis conversation was imported. Provider-specific continuation IDs, raw tool-call protocol, thinking signatures, encrypted reasoning, and hidden chain-of-thought were intentionally omitted."
            .to_owned(),
    );
    sections.push("</past_conversation>".to_owned());

    truncate_chars(
        &redact_provider_continuation_tokens(&sections.join("\n\n")),
        MAX_HANDOFF_CHARS,
        None,
    )
}

pub fn count_visible_messages(conversation: &ExternalConversation) -> usize {
    conversation
        .items
        .iter()
        .filter(|i| {
            matches!(
                i,
                ExternalConversationItem::User { .. } | ExternalConversationItem::Assistant { .. }
            )
        })
        .count()
}

fn preview_text(conversation: &ExternalConversation) -> Option<String> {
    for item in conversation.items.iter().rev() {
        match item {
            ExternalConversationItem::User { text, .. }
            | ExternalConversationItem::Assistant { text, .. } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.chars().take(240).collect());
                }
            }
            _ => {}
        }
    }
    None
}

pub fn conversation_to_session_feed(
    conversation: &ExternalConversation,
    imported_at: &str,
) -> Vec<Value> {
    let mut feed = Vec::with_capacity(conversation.items.len() + 1);
    let orig_suffix = conversation
        .original_model
        .as_deref()
        .map(|m| format!(" Original model: {m}."))
        .unwrap_or_default();
    let banner_id = format!(
        "import-banner-{}",
        short_hash(
            &json!({ "fingerprint": conversation.fingerprint, "importedAt": imported_at }),
            16
        )
    );
    feed.push(json!({
        "id": banner_id,
        "kind": "system",
        "ts": imported_at,
        "line": format!(
            "Imported from {} on {}.{orig_suffix} Future Cowork turns use sanitized summarized context, not the original provider continuation state.",
            conversation.source.as_str(),
            imported_at
        ),
    }));

    for item in &conversation.items {
        match item {
            ExternalConversationItem::User { id, ts, text } => {
                let fid = format!(
                    "import-feed-{}",
                    short_hash(
                        &json!({ "fingerprint": conversation.fingerprint, "itemId": id }),
                        16
                    )
                );
                feed.push(json!({
                    "id": fid,
                    "kind": "message",
                    "role": "user",
                    "ts": ts,
                    "text": text,
                }));
            }
            ExternalConversationItem::Assistant { id, ts, text } => {
                let fid = format!(
                    "import-feed-{}",
                    short_hash(
                        &json!({ "fingerprint": conversation.fingerprint, "itemId": id }),
                        16
                    )
                );
                feed.push(json!({
                    "id": fid,
                    "kind": "message",
                    "role": "assistant",
                    "ts": ts,
                    "text": text,
                }));
            }
            ExternalConversationItem::Reasoning { id, ts, text, .. } => {
                let fid = format!(
                    "import-feed-{}",
                    short_hash(
                        &json!({ "fingerprint": conversation.fingerprint, "itemId": id }),
                        16
                    )
                );
                feed.push(json!({
                    "id": fid,
                    "kind": "reasoning",
                    "mode": "summary",
                    "ts": ts,
                    "text": text,
                }));
            }
            ExternalConversationItem::System { id, ts, text } => {
                let fid = format!(
                    "import-feed-{}",
                    short_hash(
                        &json!({ "fingerprint": conversation.fingerprint, "itemId": id }),
                        16
                    )
                );
                feed.push(json!({
                    "id": fid,
                    "kind": "system",
                    "ts": ts,
                    "line": text,
                }));
            }
            ExternalConversationItem::Tool {
                id,
                ts,
                name,
                args,
                result,
                error,
            } => {
                let fid = format!(
                    "import-feed-{}",
                    short_hash(
                        &json!({ "fingerprint": conversation.fingerprint, "itemId": id }),
                        16
                    )
                );
                let mut tool_obj = json!({
                    "id": fid,
                    "kind": "tool",
                    "ts": ts,
                    "name": name,
                    "state": if error.is_some() { "output-error" } else { "output-available" },
                    "completedAt": ts,
                });
                if let Some(obj) = tool_obj.as_object_mut() {
                    if let Some(a) = args {
                        obj.insert("args".to_owned(), a.clone());
                    }
                    if let Some(e) = error {
                        obj.insert("result".to_owned(), Value::String(e.clone()));
                    } else if let Some(r) = result {
                        obj.insert("result".to_owned(), r.clone());
                    }
                }
                feed.push(tool_obj);
            }
        }
    }
    feed
}

// =============================================================================
// Adapters: Codex, Claude Code, Cowork
// =============================================================================

fn list_jsonl_files_recursive(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                walk(&p, out);
            } else if ft.is_file() && p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(p);
            }
        }
    }
    if root.is_file() {
        if root.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(root.to_path_buf());
        }
    } else if root.is_dir() {
        walk(root, &mut out);
    }
    out.sort_by(|a, b| {
        let ma = fs::metadata(a).and_then(|m| m.modified()).ok();
        let mb = fs::metadata(b).and_then(|m| m.modified()).ok();
        mb.cmp(&ma).then_with(|| a.cmp(b))
    });
    out
}

fn read_jsonl_records(
    path: &Path,
    warnings: &mut Vec<ConversationImportWarning>,
) -> Vec<Map<String, Value>> {
    let Ok(raw) = fs::read_to_string(path) else {
        warnings.push(ConversationImportWarning {
            code: ConversationImportWarningCode::ParsePartial,
            message: format!("Could not read transcript file {}.", path.display()),
        });
        return Vec::new();
    };
    let mut records = Vec::new();
    let mut had_parse_error = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Object(map)) => records.push(map),
            _ => had_parse_error = true,
        }
    }
    if had_parse_error {
        warnings.push(ConversationImportWarning {
            code: ConversationImportWarningCode::ParsePartial,
            message: "Some malformed JSONL lines were skipped during import.".to_owned(),
        });
    }
    records
}

fn is_sqlite_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.ends_with(".sqlite") || name.ends_with(".sqlite3") || name.ends_with(".db")
}

fn parse_codex_rollout(
    rollout_path: &Path,
    source_id: &str,
    fallback_updated_at: &str,
) -> (
    Vec<ExternalConversationItem>,
    Vec<ConversationImportWarning>,
) {
    let mut warnings = Vec::new();
    let records = read_jsonl_records(rollout_path, &mut warnings);
    let mut items: Vec<ExternalConversationItem> = Vec::new();
    let mut pending_tool_by_call_id: HashMap<String, usize> = HashMap::new();

    for record in records {
        let ts = normalize_iso_timestamp(record.get("timestamp"), fallback_updated_at);
        let Some(rec_type) = record.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some(payload) = record.get("payload").and_then(Value::as_object) else {
            continue;
        };

        if rec_type == "event_msg"
            && payload.get("type").and_then(Value::as_str) == Some("user_message")
        {
            let text = extract_text_from_content(payload.get("message"));
            if !text.is_empty() {
                let id = make_external_item_id(
                    ConversationImportSource::Codex,
                    source_id,
                    items.len(),
                    "user",
                    &json!(text),
                );
                items.push(ExternalConversationItem::User { id, ts, text });
            }
            continue;
        }

        if rec_type != "response_item" {
            continue;
        }
        let Some(payload_type) = payload.get("type").and_then(Value::as_str) else {
            continue;
        };
        match payload_type {
            "message" => {
                if payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    let text = extract_text_from_content(payload.get("content"));
                    if !text.is_empty() {
                        let id = make_external_item_id(
                            ConversationImportSource::Codex,
                            source_id,
                            items.len(),
                            "assistant",
                            &json!(text),
                        );
                        items.push(ExternalConversationItem::Assistant { id, ts, text });
                    }
                }
            }
            "reasoning" => {
                let summary_text = match payload.get("summary") {
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .map(|p| extract_text_from_content(Some(p)))
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    other => extract_text_from_content(other),
                };
                if !summary_text.is_empty() {
                    let id = make_external_item_id(
                        ConversationImportSource::Codex,
                        source_id,
                        items.len(),
                        "reasoning",
                        &json!(summary_text),
                    );
                    items.push(ExternalConversationItem::Reasoning {
                        id,
                        ts,
                        mode: "summary".to_owned(),
                        text: summary_text,
                    });
                }
                if payload.get("encrypted_content").is_some() || payload.get("content").is_some() {
                    warnings.push(ConversationImportWarning {
                        code: ConversationImportWarningCode::ReasoningRedacted,
                        message: "Codex reasoning content was redacted; only visible reasoning summaries were imported.".to_owned(),
                    });
                }
            }
            "function_call" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .map(normalize_text)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "tool".to_owned());
                let args = payload.get("arguments").map(|v| match v {
                    Value::String(s) => serde_json::from_str::<Value>(s)
                        .unwrap_or_else(|_| Value::String(s.clone())),
                    other => other.clone(),
                });
                let id = make_external_item_id(
                    ConversationImportSource::Codex,
                    source_id,
                    items.len(),
                    "tool",
                    &Value::Object(payload.clone()),
                );
                let idx = items.len();
                items.push(ExternalConversationItem::Tool {
                    id,
                    ts,
                    name,
                    args,
                    result: None,
                    error: None,
                });
                if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                    pending_tool_by_call_id.insert(call_id.to_owned(), idx);
                }
                warnings.push(ConversationImportWarning {
                    code: ConversationImportWarningCode::ToolProtocolRedacted,
                    message: "Codex tool-call protocol identifiers were used only for pairing and were not imported as continuation state.".to_owned(),
                });
            }
            "function_call_output" => {
                let res_val = payload
                    .get("output")
                    .or_else(|| payload.get("result"))
                    .or_else(|| payload.get("content"))
                    .cloned();
                let call_id = payload.get("call_id").and_then(Value::as_str);
                if let Some(cid) = call_id
                    && let Some(&idx) = pending_tool_by_call_id.get(cid)
                    && let Some(ExternalConversationItem::Tool { result, .. }) = items.get_mut(idx)
                {
                    *result = res_val;
                } else {
                    let id = make_external_item_id(
                        ConversationImportSource::Codex,
                        source_id,
                        items.len(),
                        "tool",
                        &Value::Object(payload.clone()),
                    );
                    items.push(ExternalConversationItem::Tool {
                        id,
                        ts,
                        name: "tool".to_owned(),
                        args: None,
                        result: res_val,
                        error: None,
                    });
                }
            }
            _ => {}
        }
    }

    (items, warnings)
}

fn discover_codex_sources(
    homedir: &Path,
    explicit_paths: Option<&[String]>,
) -> Vec<ConversationSourceCandidate> {
    let paths: Vec<PathBuf> = match explicit_paths.filter(|p| !p.is_empty()) {
        Some(list) => list.iter().map(PathBuf::from).collect(),
        None => vec![
            homedir.join(".codex").join("state_5.sqlite"),
            homedir.join(".codex").join("sessions"),
            homedir.join(".codex").join("archived_sessions"),
        ],
    };

    let mut out = Vec::new();
    for p in paths {
        let p_str = p.to_string_lossy().into_owned();
        let available = p.exists();
        let count = if !available {
            None
        } else if is_sqlite_path(&p) {
            Connection::open_with_flags(&p, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .ok()
                .and_then(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM threads", [], |r| r.get::<_, i64>(0))
                        .ok()
                        .map(|n| n.max(0) as usize)
                })
        } else {
            Some(list_jsonl_files_recursive(&p).len())
        };
        out.push(ConversationSourceCandidate {
            source: ConversationImportSource::Codex,
            id: format!("codex:{p_str}"),
            path: p_str,
            available,
            conversation_count: count,
            warning: if available {
                None
            } else {
                Some("Codex conversation source was not found.".to_owned())
            },
        });
    }
    out
}

fn preview_codex_candidate(
    candidate: &ConversationSourceCandidate,
    include_archived: bool,
) -> Vec<ExternalConversation> {
    if !candidate.available {
        return Vec::new();
    }
    let path = Path::new(&candidate.path);
    if !is_sqlite_path(path) {
        let mut out = Vec::new();
        for file_path in list_jsonl_files_recursive(path) {
            let source_id = file_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "rollout.jsonl".to_owned());
            let fallback_ts = fs::metadata(&file_path)
                .and_then(|m| m.modified())
                .ok()
                .map(|t| {
                    DateTime::<Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                })
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned());
            let (items, mut warnings) = parse_codex_rollout(&file_path, &source_id, &fallback_ts);
            warnings.push(ConversationImportWarning {
                code: ConversationImportWarningCode::MissingCwd,
                message:
                    "Codex rollout file did not include thread metadata with a working directory."
                        .to_owned(),
            });
            let first_user = items
                .iter()
                .find_map(|i| match i {
                    ExternalConversationItem::User { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| "Imported Codex chat".to_owned());
            out.push(normalize_external_conversation(
                ConversationImportSource::Codex,
                source_id,
                Some(file_path.to_string_lossy().into_owned()),
                None,
                first_user,
                fallback_ts.clone(),
                fallback_ts,
                Some("openai".to_owned()),
                None,
                items,
                None,
                warnings,
            ));
        }
        return out;
    }

    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let mut cols = BTreeSet::new();
    if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(threads)")
        && let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1))
    {
        for col in rows.flatten() {
            cols.insert(col);
        }
    }
    if cols.is_empty() {
        return Vec::new();
    }
    let where_clause = if !include_archived && cols.contains("archived") {
        "WHERE archived = 0"
    } else {
        ""
    };
    let order_col = if cols.contains("updated_at_ms") {
        "updated_at_ms"
    } else if cols.contains("updated_at") {
        "updated_at"
    } else {
        "rowid"
    };
    let sql = format!("SELECT * FROM threads {where_clause} ORDER BY {order_col} DESC");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let col_names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
    let Ok(rows) = stmt.query_map([], |row| {
        let mut map = Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let val = match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(n) => json!(n),
                rusqlite::types::ValueRef::Real(f) => json!(f),
                rusqlite::types::ValueRef::Text(bytes) => {
                    Value::String(String::from_utf8_lossy(bytes).into_owned())
                }
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            map.insert(name.clone(), val);
        }
        Ok(map)
    }) else {
        return Vec::new();
    };

    let codex_root = path.parent().unwrap_or_else(|| Path::new("."));
    let mut out = Vec::new();
    for row in rows.flatten() {
        let Some(source_id) = row
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| row.get("thread_id").and_then(Value::as_str))
            .map(str::to_owned)
        else {
            continue;
        };
        let epoch = "1970-01-01T00:00:00.000Z";
        let created_at = normalize_iso_timestamp(
            row.get("created_at_ms").or_else(|| row.get("created_at")),
            epoch,
        );
        let updated_at = normalize_iso_timestamp(
            row.get("updated_at_ms").or_else(|| row.get("updated_at")),
            &created_at,
        );
        let rollout_path = row
            .get("rollout_path")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|rel| {
                let p = Path::new(rel);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    for cand in [
                        codex_root.join(rel),
                        codex_root.join("sessions").join(rel),
                        codex_root.join("archived_sessions").join(rel),
                    ] {
                        if cand.exists() {
                            return cand;
                        }
                    }
                    codex_root.join("sessions").join(rel)
                }
            });

        let (items, mut warnings) = match rollout_path.as_deref() {
            Some(rp) if rp.exists() => parse_codex_rollout(rp, &source_id, &updated_at),
            Some(rp) => {
                let (it, w) = parse_codex_rollout(rp, &source_id, &updated_at);
                (it, w)
            }
            None => (
                Vec::new(),
                vec![ConversationImportWarning {
                    code: ConversationImportWarningCode::ParsePartial,
                    message: "Codex thread did not include a rollout path.".to_owned(),
                }],
            ),
        };
        let cwd = row
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if cwd.is_none() {
            warnings.push(ConversationImportWarning {
                code: ConversationImportWarningCode::MissingCwd,
                message: "Codex thread did not include a working directory.".to_owned(),
            });
        }
        let title = row
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| row.get("preview").and_then(Value::as_str))
            .or_else(|| row.get("first_user_message").and_then(Value::as_str))
            .unwrap_or("Imported Codex chat")
            .to_owned();
        let original_provider = row
            .get("model_provider")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("openai")
            .to_owned();
        let original_model = row
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        out.push(normalize_external_conversation(
            ConversationImportSource::Codex,
            source_id,
            rollout_path.map(|p| p.to_string_lossy().into_owned()),
            cwd,
            title,
            created_at,
            updated_at,
            Some(original_provider),
            original_model,
            items,
            None,
            warnings,
        ));
    }
    out
}

fn encode_claude_project_path(project_path: &str) -> String {
    project_path
        .chars()
        .map(|c| {
            if matches!(c, ':' | '\\' | '/') {
                '-'
            } else {
                c
            }
        })
        .collect()
}

fn decode_claude_project_path(dir_name: &str) -> Option<String> {
    if let Some(rest) = dir_name.strip_prefix('-') {
        return Some(format!("/{}", rest.replace('-', "/")));
    }
    None
}

fn read_known_claude_project_paths(projects_root: &Path) -> HashMap<String, Option<String>> {
    let mut map: HashMap<String, Option<String>> = HashMap::new();
    let Some(claude_dir) = projects_root.parent() else {
        return map;
    };
    if projects_root.file_name().and_then(|s| s.to_str()) != Some("projects")
        || claude_dir.file_name().and_then(|s| s.to_str()) != Some(".claude")
    {
        return map;
    }
    let Some(home_parent) = claude_dir.parent() else {
        return map;
    };
    let config_path = home_parent.join(".claude.json");
    let Ok(raw) = fs::read_to_string(config_path) else {
        return map;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return map;
    };
    let Some(projects) = parsed.get("projects").and_then(Value::as_object) else {
        return map;
    };
    for proj_path in projects.keys() {
        let encoded = encode_claude_project_path(proj_path);
        match map.get(&encoded) {
            None => {
                map.insert(encoded, Some(proj_path.clone()));
            }
            Some(Some(prev)) if same_workspace_path(prev, proj_path) => {}
            _ => {
                map.insert(encoded, None);
            }
        }
    }
    map
}

fn parse_claude_code_jsonl(
    file_path: &Path,
    project_fallback: Option<String>,
) -> ExternalConversation {
    let mut warnings = Vec::new();
    let records = read_jsonl_records(file_path, &mut warnings);
    let epoch = "1970-01-01T00:00:00.000Z";
    let default_sid = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "claude-chat".to_owned());

    let mut title: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut created_at: Option<String> = None;
    let mut updated_at: Option<String> = None;

    for rec in &records {
        if let Some(ts_val) = rec.get("timestamp") {
            let iso = normalize_iso_timestamp(Some(ts_val), epoch);
            if created_at.is_none() {
                created_at = Some(iso.clone());
            }
            updated_at = Some(iso);
        }
        if rec.get("type").and_then(Value::as_str) == Some("ai-title")
            && let Some(t) = rec.get("aiTitle").and_then(Value::as_str)
        {
            title = Some(t.to_owned());
        }
        if cwd.is_none() {
            cwd = rec
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
        }
        if session_id.is_none() {
            session_id = rec
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
        }
        if let Some(msg) = rec.get("message").and_then(Value::as_object) {
            if model.is_none() {
                model = msg
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
            }
            if rec.get("type").and_then(Value::as_str) == Some("summary") {
                let s = extract_text_from_content(msg.get("content"));
                if !s.is_empty() {
                    summary = Some(s);
                }
            }
        }
        if rec.get("type").and_then(Value::as_str) == Some("summary") {
            let s = extract_text_from_content(rec.get("summary"));
            if !s.is_empty() {
                summary = Some(s);
            }
        }
    }

    let source_id = session_id.unwrap_or(default_sid);
    let created = created_at.unwrap_or_else(|| epoch.to_owned());
    let updated = updated_at.unwrap_or_else(|| created.clone());
    let mut items: Vec<ExternalConversationItem> = Vec::new();
    let mut pending_tool_by_id: HashMap<String, usize> = HashMap::new();

    for rec in &records {
        let Some(rec_type) = rec.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some(msg) = rec.get("message").and_then(Value::as_object) else {
            continue;
        };
        let ts = normalize_iso_timestamp(rec.get("timestamp"), &updated);
        let blocks: Vec<&Value> = match msg.get("content") {
            Some(Value::Array(arr)) => arr.iter().collect(),
            Some(other) => vec![other],
            None => Vec::new(),
        };

        if rec_type == "user" {
            let mut handled_tool_result = false;
            for b in &blocks {
                let Some(b_obj) = b.as_object() else {
                    continue;
                };
                if b_obj.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                handled_tool_result = true;
                let tid = b_obj
                    .get("id")
                    .or_else(|| b_obj.get("tool_use_id"))
                    .or_else(|| b_obj.get("toolUseId"))
                    .and_then(Value::as_str);
                let result_val = rec.get("toolUseResult").cloned().or_else(|| {
                    b_obj.get("content").map(|c| {
                        let txt = extract_text_from_content(Some(c));
                        if txt.is_empty() {
                            c.clone()
                        } else {
                            Value::String(txt)
                        }
                    })
                });
                let is_err = b_obj.get("is_error").and_then(Value::as_bool) == Some(true)
                    || b_obj.get("isError").and_then(Value::as_bool) == Some(true);
                if let Some(id_str) = tid
                    && let Some(&idx) = pending_tool_by_id.get(id_str)
                    && let Some(ExternalConversationItem::Tool { result, error, .. }) =
                        items.get_mut(idx)
                {
                    if is_err {
                        let e_txt = extract_text_from_content(result_val.as_ref());
                        *error = Some(if e_txt.is_empty() {
                            "Tool error".to_owned()
                        } else {
                            e_txt
                        });
                    } else {
                        *result = result_val;
                    }
                } else {
                    let id = make_external_item_id(
                        ConversationImportSource::ClaudeCode,
                        &source_id,
                        items.len(),
                        "tool",
                        &Value::Object(rec.clone()),
                    );
                    let err_str = if is_err {
                        let e_txt = extract_text_from_content(result_val.as_ref());
                        Some(if e_txt.is_empty() {
                            "Tool error".to_owned()
                        } else {
                            e_txt
                        })
                    } else {
                        None
                    };
                    items.push(ExternalConversationItem::Tool {
                        id,
                        ts: ts.clone(),
                        name: "tool".to_owned(),
                        args: None,
                        result: if is_err { None } else { result_val },
                        error: err_str,
                    });
                }
            }
            if handled_tool_result {
                warnings.push(ConversationImportWarning {
                    code: ConversationImportWarningCode::ToolProtocolRedacted,
                    message: "Claude Code tool-use identifiers were used only for pairing and were not imported as continuation state.".to_owned(),
                });
            }
            let non_tool: Vec<Value> = blocks
                .iter()
                .filter(|b| {
                    b.as_object()
                        .and_then(|o| o.get("type"))
                        .and_then(Value::as_str)
                        != Some("tool_result")
                })
                .map(|b| (*b).clone())
                .collect();
            let text = extract_text_from_content(Some(&Value::Array(non_tool)));
            if !text.is_empty() {
                let seed = rec.get("uuid").cloned().unwrap_or_else(|| json!(text));
                let id = make_external_item_id(
                    ConversationImportSource::ClaudeCode,
                    &source_id,
                    items.len(),
                    "user",
                    &seed,
                );
                items.push(ExternalConversationItem::User { id, ts, text });
            }
            continue;
        }

        if rec_type != "assistant" {
            continue;
        }
        for b in &blocks {
            let Some(b_obj) = b.as_object() else {
                let text = extract_text_from_content(Some(b));
                if !text.is_empty() {
                    let id = make_external_item_id(
                        ConversationImportSource::ClaudeCode,
                        &source_id,
                        items.len(),
                        "assistant",
                        b,
                    );
                    items.push(ExternalConversationItem::Assistant {
                        id,
                        ts: ts.clone(),
                        text,
                    });
                }
                continue;
            };
            match b_obj.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = extract_text_from_content(Some(b));
                    if !text.is_empty() {
                        let id = make_external_item_id(
                            ConversationImportSource::ClaudeCode,
                            &source_id,
                            items.len(),
                            "assistant",
                            b,
                        );
                        items.push(ExternalConversationItem::Assistant {
                            id,
                            ts: ts.clone(),
                            text,
                        });
                    }
                }
                Some("thinking") => {
                    let sum = b_obj
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(normalize_text)
                        .unwrap_or_else(|| extract_text_from_content(b_obj.get("summary")));
                    if !sum.is_empty() {
                        let id = make_external_item_id(
                            ConversationImportSource::ClaudeCode,
                            &source_id,
                            items.len(),
                            "reasoning",
                            &json!(sum),
                        );
                        items.push(ExternalConversationItem::Reasoning {
                            id,
                            ts: ts.clone(),
                            mode: "summary".to_owned(),
                            text: sum,
                        });
                    }
                    warnings.push(ConversationImportWarning {
                        code: ConversationImportWarningCode::ReasoningRedacted,
                        message: "Claude Code thinking signatures and hidden thinking content were redacted.".to_owned(),
                    });
                }
                Some("tool_use") => {
                    let name = b_obj
                        .get("name")
                        .and_then(Value::as_str)
                        .map(normalize_text)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "tool".to_owned());
                    let tid = b_obj
                        .get("id")
                        .or_else(|| b_obj.get("tool_use_id"))
                        .or_else(|| b_obj.get("toolUseId"))
                        .and_then(Value::as_str);
                    let id = make_external_item_id(
                        ConversationImportSource::ClaudeCode,
                        &source_id,
                        items.len(),
                        "tool",
                        b,
                    );
                    let idx = items.len();
                    items.push(ExternalConversationItem::Tool {
                        id,
                        ts: ts.clone(),
                        name,
                        args: b_obj.get("input").cloned(),
                        result: None,
                        error: None,
                    });
                    if let Some(id_str) = tid {
                        pending_tool_by_id.insert(id_str.to_owned(), idx);
                    }
                    warnings.push(ConversationImportWarning {
                        code: ConversationImportWarningCode::ToolProtocolRedacted,
                        message: "Claude Code tool-use identifiers were used only for pairing and were not imported as continuation state.".to_owned(),
                    });
                }
                _ => {}
            }
        }
    }

    let final_cwd = cwd.or(project_fallback);
    if final_cwd.is_none() {
        warnings.push(ConversationImportWarning {
            code: ConversationImportWarningCode::MissingCwd,
            message: "Claude Code chat did not include a working directory.".to_owned(),
        });
    }
    let resolved_title = title.unwrap_or_else(|| "Imported Claude Code chat".to_owned());

    normalize_external_conversation(
        ConversationImportSource::ClaudeCode,
        source_id,
        Some(file_path.to_string_lossy().into_owned()),
        final_cwd,
        resolved_title,
        created,
        updated,
        Some("anthropic".to_owned()),
        model,
        items,
        summary,
        warnings,
    )
}

fn discover_claude_code_sources(
    homedir: &Path,
    explicit_paths: Option<&[String]>,
) -> Vec<ConversationSourceCandidate> {
    let roots: Vec<PathBuf> = match explicit_paths.filter(|p| !p.is_empty()) {
        Some(list) => list.iter().map(PathBuf::from).collect(),
        None => vec![homedir.join(".claude").join("projects")],
    };
    let mut out = Vec::new();
    for root in roots {
        let p_str = root.to_string_lossy().into_owned();
        let available = root.exists();
        let count = available.then(|| list_jsonl_files_recursive(&root).len());
        out.push(ConversationSourceCandidate {
            source: ConversationImportSource::ClaudeCode,
            id: format!("claude-code:{p_str}"),
            path: p_str,
            available,
            conversation_count: count,
            warning: if available {
                None
            } else {
                Some("Claude Code projects directory was not found.".to_owned())
            },
        });
    }
    out
}

fn preview_claude_code_candidate(
    candidate: &ConversationSourceCandidate,
) -> Vec<ExternalConversation> {
    if !candidate.available {
        return Vec::new();
    }
    let root = Path::new(&candidate.path);
    let known_projects = if root.is_dir() {
        read_known_claude_project_paths(root)
    } else {
        HashMap::new()
    };
    let mut out = Vec::new();
    for file_path in list_jsonl_files_recursive(root) {
        let project_fallback = if root.is_dir() {
            let proj_dir = file_path
                .strip_prefix(root)
                .ok()
                .and_then(|rel| rel.components().next())
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Some(known) = known_projects.get(&proj_dir) {
                known.clone()
            } else {
                decode_claude_project_path(&proj_dir)
            }
        } else {
            None
        };
        out.push(parse_claude_code_jsonl(&file_path, project_fallback));
    }
    out
}

fn resolve_cowork_db_path(raw: &str) -> PathBuf {
    let p = PathBuf::from(raw);
    if p.is_dir() { p.join("sessions.db") } else { p }
}

fn same_file_path(left: &Path, right: &Path) -> bool {
    canonicalize_sync(left) == canonicalize_sync(right)
}

fn discover_cowork_sources(
    explicit_paths: Option<&[String]>,
    current_cowork_db_path: &Path,
) -> Vec<ConversationSourceCandidate> {
    let Some(paths) = explicit_paths else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for raw in paths {
        let db_path = resolve_cowork_db_path(raw);
        let p_str = db_path.to_string_lossy().into_owned();
        let exists = db_path.exists();
        let is_current = exists && same_file_path(&db_path, current_cowork_db_path);
        let available = exists && !is_current;
        let count = if available {
            Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .ok()
                .and_then(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM sessions WHERE COALESCE(session_kind, 'root') = 'root'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .ok()
                    .map(|n| n.max(0) as usize)
                })
        } else {
            None
        };
        let warning = if !exists {
            Some("Cowork sessions database was not found.".to_owned())
        } else if is_current {
            Some("The current Cowork sessions database cannot be imported into itself.".to_owned())
        } else {
            None
        };
        out.push(ConversationSourceCandidate {
            source: ConversationImportSource::Cowork,
            id: format!("cowork:{p_str}"),
            path: p_str,
            available,
            conversation_count: count,
            warning,
        });
    }
    out
}

fn preview_cowork_candidate(
    candidate: &ConversationSourceCandidate,
    current_cowork_db_path: &Path,
) -> Vec<ExternalConversation> {
    if !candidate.available {
        return Vec::new();
    }
    let db_path = Path::new(&candidate.path);
    if same_file_path(db_path, current_cowork_db_path) {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let sql = "SELECT s.session_id, s.title, s.provider, s.model, s.working_directory,
                      s.created_at, s.updated_at, st.messages_json, snap.snapshot_json
               FROM sessions s
               JOIN session_state st ON st.session_id = s.session_id
               LEFT JOIN session_snapshots snap ON snap.session_id = s.session_id
               WHERE COALESCE(s.session_kind, 'root') = 'root'
               ORDER BY s.updated_at DESC";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
        ))
    }) else {
        return Vec::new();
    };

    let epoch = "1970-01-01T00:00:00.000Z";
    let mut out = Vec::new();
    for (
        source_id,
        title,
        provider,
        model,
        cwd,
        created_raw,
        updated_raw,
        messages_json,
        snapshot_json,
    ) in rows.flatten()
    {
        let created_at = normalize_iso_timestamp(created_raw.map(Value::String).as_ref(), epoch);
        let updated_at =
            normalize_iso_timestamp(updated_raw.map(Value::String).as_ref(), &created_at);

        let mut items = Vec::new();
        if let Some(snap_str) = snapshot_json.as_deref()
            && let Ok(snap_val) = serde_json::from_str::<Value>(snap_str)
            && let Some(feed_arr) = snap_val.get("feed").and_then(Value::as_array)
        {
            for item in feed_arr {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("");
                let ts = obj
                    .get("ts")
                    .and_then(Value::as_str)
                    .unwrap_or(&updated_at)
                    .to_owned();
                let seed = obj.get("id").cloned().unwrap_or(Value::Null);
                match kind {
                    "message" => {
                        let role = obj.get("role").and_then(Value::as_str).unwrap_or("");
                        let text = obj
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        if role == "user" {
                            let id = make_external_item_id(
                                ConversationImportSource::Cowork,
                                &source_id,
                                items.len(),
                                "user",
                                &seed,
                            );
                            items.push(ExternalConversationItem::User { id, ts, text });
                        } else if role == "assistant" {
                            let id = make_external_item_id(
                                ConversationImportSource::Cowork,
                                &source_id,
                                items.len(),
                                "assistant",
                                &seed,
                            );
                            items.push(ExternalConversationItem::Assistant { id, ts, text });
                        }
                    }
                    "tool" => {
                        let name = obj
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_owned();
                        let state = obj.get("state").and_then(Value::as_str).unwrap_or("");
                        let res = obj.get("result").cloned();
                        let is_err = state == "output-error" || state == "output-denied";
                        let id = make_external_item_id(
                            ConversationImportSource::Cowork,
                            &source_id,
                            items.len(),
                            "tool",
                            &seed,
                        );
                        items.push(ExternalConversationItem::Tool {
                            id,
                            ts,
                            name,
                            args: obj.get("args").cloned(),
                            result: if is_err { None } else { res.clone() },
                            error: if is_err {
                                Some(extract_text_from_content(res.as_ref()))
                            } else {
                                None
                            },
                        });
                    }
                    "reasoning" => {
                        let text = obj
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let id = make_external_item_id(
                            ConversationImportSource::Cowork,
                            &source_id,
                            items.len(),
                            "reasoning",
                            &seed,
                        );
                        items.push(ExternalConversationItem::Reasoning {
                            id,
                            ts,
                            mode: "summary".to_owned(),
                            text,
                        });
                    }
                    "system" | "log" => {
                        let text = obj
                            .get("line")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let id = make_external_item_id(
                            ConversationImportSource::Cowork,
                            &source_id,
                            items.len(),
                            "system",
                            &seed,
                        );
                        items.push(ExternalConversationItem::System { id, ts, text });
                    }
                    _ => {}
                }
            }
        } else if let Some(msgs_str) = messages_json.as_deref()
            && let Ok(Value::Array(msgs)) = serde_json::from_str::<Value>(msgs_str)
        {
            for (i, msg) in msgs.iter().enumerate() {
                let Some(obj) = msg.as_object() else {
                    continue;
                };
                let role = obj.get("role").and_then(Value::as_str).unwrap_or("");
                let text = extract_text_from_content(obj.get("content"));
                if text.is_empty() {
                    continue;
                }
                if role == "user" {
                    let id = make_external_item_id(
                        ConversationImportSource::Cowork,
                        &source_id,
                        i,
                        "user",
                        &json!(text),
                    );
                    items.push(ExternalConversationItem::User {
                        id,
                        ts: updated_at.clone(),
                        text,
                    });
                } else if role == "assistant" {
                    let id = make_external_item_id(
                        ConversationImportSource::Cowork,
                        &source_id,
                        i,
                        "assistant",
                        &json!(text),
                    );
                    items.push(ExternalConversationItem::Assistant {
                        id,
                        ts: updated_at.clone(),
                        text,
                    });
                }
            }
        }

        let clean_cwd = cwd.filter(|s| !s.trim().is_empty());
        let mut warnings = Vec::new();
        if clean_cwd.is_none() {
            warnings.push(ConversationImportWarning {
                code: ConversationImportWarningCode::MissingCwd,
                message: "Cowork session did not include a working directory.".to_owned(),
            });
        }
        out.push(normalize_external_conversation(
            ConversationImportSource::Cowork,
            source_id,
            Some(candidate.path.clone()),
            clean_cwd,
            title.unwrap_or_else(|| "Imported Cowork chat".to_owned()),
            created_at,
            updated_at,
            provider.filter(|s| !s.is_empty()),
            model.filter(|s| !s.is_empty()),
            items,
            None,
            warnings,
        ));
    }
    out
}

// =============================================================================
// Workspace Mapping & ConversationImportService
// =============================================================================

fn canonicalize_existing_dir(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let real = fs::canonicalize(trimmed).ok()?;
    real.is_dir().then_some(real)
}

pub fn map_conversation_workspace(
    cwd: Option<&str>,
    workspaces: &[KnownWorkspaceEntry],
) -> ConversationWorkspaceMapping {
    let Some(raw_cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return ConversationWorkspaceMapping::Missing {
            original_path: None,
            reason: "no_cwd".to_owned(),
        };
    };
    let Some(real_cwd) = canonicalize_existing_dir(raw_cwd) else {
        return ConversationWorkspaceMapping::Missing {
            original_path: Some(raw_cwd.to_owned()),
            reason: "path_missing".to_owned(),
        };
    };
    let real_str = real_cwd.to_string_lossy().into_owned();
    for ws in workspaces {
        if let Some(ws_real) = canonicalize_existing_dir(&ws.path)
            && ws_real == real_cwd
        {
            return ConversationWorkspaceMapping::Matched {
                workspace_id: ws.id.clone(),
                workspace_path: ws.path.clone(),
            };
        }
    }
    let name = real_cwd
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| real_str.clone());
    ConversationWorkspaceMapping::Create {
        workspace_path: real_str,
        name,
    }
}

pub fn validate_workspace_mapping_input(
    mapping: &ConversationWorkspaceMappingInput,
    workspaces: &[KnownWorkspaceEntry],
) -> Result<ConversationWorkspaceMapping, String> {
    match mapping {
        ConversationWorkspaceMappingInput::Create { path, name } => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return Err("Workspace path is required.".to_owned());
            }
            let Some(real) = canonicalize_existing_dir(trimmed) else {
                return Ok(ConversationWorkspaceMapping::Missing {
                    original_path: Some(trimmed.to_owned()),
                    reason: "path_missing".to_owned(),
                });
            };
            let real_str = real.to_string_lossy().into_owned();
            let fallback_name = real
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| real_str.clone());
            let final_name = name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or(fallback_name);
            Ok(ConversationWorkspaceMapping::Create {
                workspace_path: real_str,
                name: final_name,
            })
        }
        ConversationWorkspaceMappingInput::Existing { workspace_id }
        | ConversationWorkspaceMappingInput::Fallback { workspace_id } => {
            let found = workspaces
                .iter()
                .find(|w| w.id == *workspace_id)
                .ok_or_else(|| format!("Unknown workspace: {workspace_id}"))?;
            Ok(ConversationWorkspaceMapping::Matched {
                workspace_id: found.id.clone(),
                workspace_path: found.path.clone(),
            })
        }
    }
}

fn normalize_source_requests(
    opts: &ConversationSourceSelectionOptions,
) -> Vec<ConversationSourceRequest> {
    if let Some(ref explicit_sources) = opts.sources
        && !explicit_sources.is_empty()
    {
        return explicit_sources.clone();
    }
    let explicit_paths: Vec<String> = opts
        .explicit_paths
        .as_ref()
        .map(|v| {
            v.iter()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let has_flag = opts.include_codex.is_some()
        || opts.include_claude_code.is_some()
        || opts.include_cowork.is_some();
    let sources: Vec<ConversationImportSource> = if has_flag {
        let mut s = Vec::new();
        if opts.include_codex == Some(true) {
            s.push(ConversationImportSource::Codex);
        }
        if opts.include_claude_code == Some(true) {
            s.push(ConversationImportSource::ClaudeCode);
        }
        if opts.include_cowork == Some(true) {
            s.push(ConversationImportSource::Cowork);
        }
        s
    } else {
        vec![
            ConversationImportSource::Codex,
            ConversationImportSource::ClaudeCode,
        ]
    };

    if explicit_paths.is_empty() {
        sources
            .into_iter()
            .map(|source| ConversationSourceRequest { source, path: None })
            .collect()
    } else {
        let mut out = Vec::new();
        for source in sources {
            for p in &explicit_paths {
                out.push(ConversationSourceRequest {
                    source,
                    path: Some(p.clone()),
                });
            }
        }
        out
    }
}

fn mark_unsupported_original_model(
    conversation: &mut ExternalConversation,
    model_registry: Option<&ModelRegistry>,
) {
    let (Some(raw_prov), Some(raw_model)) = (
        conversation.original_provider.as_deref(),
        conversation.original_model.as_deref(),
    ) else {
        return;
    };
    let mapped_prov =
        if raw_prov == "openai" && conversation.source == ConversationImportSource::Codex {
            "codex-cli"
        } else {
            raw_prov
        };
    let Some(prov) = ProviderName::parse(mapped_prov) else {
        conversation.warnings.push(ConversationImportWarning {
            code: ConversationImportWarningCode::UnsupportedModel,
            message: format!(
                "Original provider {raw_prov} is not a Cowork provider; the import will use the selected Cowork model."
            ),
        });
        return;
    };
    if let Some(reg) = model_registry
        && !prov.is_runtime_discovery_provider()
        && reg.get(prov, raw_model).is_none()
    {
        conversation.warnings.push(ConversationImportWarning {
            code: ConversationImportWarningCode::UnsupportedModel,
            message: format!(
                "Original model {raw_model} is not registered in Cowork; the import will use the selected Cowork model."
            ),
        });
    }
}

pub struct ConversationImportService {
    session_db: Arc<SessionDb>,
    homedir: PathBuf,
    model_registry: Option<ModelRegistry>,
}

impl ConversationImportService {
    pub fn new(
        session_db: Arc<SessionDb>,
        homedir: PathBuf,
        model_registry: Option<ModelRegistry>,
    ) -> Self {
        Self {
            session_db,
            homedir,
            model_registry,
        }
    }

    pub fn discover_sources(
        &self,
        selection: &ConversationSourceSelectionOptions,
    ) -> Vec<ConversationSourceCandidate> {
        let requests = normalize_source_requests(selection);
        let mut grouped: Vec<(ConversationImportSource, Vec<String>)> = Vec::new();
        for req in requests {
            if let Some((_, list)) = grouped.iter_mut().find(|(s, _)| *s == req.source) {
                if let Some(p) = req.path {
                    list.push(p);
                }
            } else {
                grouped.push((req.source, req.path.into_iter().collect()));
            }
        }

        let mut candidates = Vec::new();
        for (source, explicit) in grouped {
            let exp_slice = (!explicit.is_empty()).then_some(explicit.as_slice());
            match source {
                ConversationImportSource::Codex => {
                    candidates.extend(discover_codex_sources(&self.homedir, exp_slice));
                }
                ConversationImportSource::ClaudeCode => {
                    candidates.extend(discover_claude_code_sources(&self.homedir, exp_slice));
                }
                ConversationImportSource::Cowork => {
                    candidates.extend(discover_cowork_sources(
                        exp_slice,
                        self.session_db.db_path(),
                    ));
                }
            }
        }
        candidates
    }

    fn load_conversations(
        &self,
        selection: &ConversationSourceSelectionOptions,
        include_archived: bool,
    ) -> Vec<ExternalConversation> {
        let candidates = self.discover_sources(selection);
        let mut conversations = Vec::new();
        for cand in &candidates {
            if !cand.available {
                continue;
            }
            let parsed = match cand.source {
                ConversationImportSource::Codex => preview_codex_candidate(cand, include_archived),
                ConversationImportSource::ClaudeCode => preview_claude_code_candidate(cand),
                ConversationImportSource::Cowork => {
                    preview_cowork_candidate(cand, self.session_db.db_path())
                }
            };
            conversations.extend(parsed);
        }
        for conv in &mut conversations {
            mark_unsupported_original_model(conv, self.model_registry.as_ref());
        }
        conversations
    }

    pub fn preview(
        &self,
        selection: &ConversationSourceSelectionOptions,
        limit: Option<usize>,
        include_archived: bool,
        workspaces: &[KnownWorkspaceEntry],
    ) -> ConversationImportPreviewResult {
        let clamped_limit = limit.unwrap_or(250).clamp(1, 1000);
        let mut conversations = self.load_conversations(selection, include_archived);

        let mut imported_map: HashMap<(ConversationImportSource, String), Option<String>> =
            HashMap::new();
        for conv in &conversations {
            let key = (conv.source, conv.fingerprint.clone());
            imported_map.entry(key).or_insert_with(|| {
                self.session_db
                    .get_external_conversation_import(conv.source.as_str(), &conv.fingerprint)
                    .ok()
                    .flatten()
                    .map(|r| r.imported_session_id)
            });
        }

        conversations.sort_by(|left, right| {
            let l_imp = imported_map
                .get(&(left.source, left.fingerprint.clone()))
                .and_then(|v| v.as_ref())
                .is_some();
            let r_imp = imported_map
                .get(&(right.source, right.fingerprint.clone()))
                .and_then(|v| v.as_ref())
                .is_some();
            l_imp
                .cmp(&r_imp)
                .then_with(|| right.updated_at.cmp(&left.updated_at))
        });

        let previews = conversations
            .into_iter()
            .take(clamped_limit)
            .map(|conv| {
                let already_imported_thread_id = imported_map
                    .get(&(conv.source, conv.fingerprint.clone()))
                    .and_then(|v| v.clone());
                let mapping = map_conversation_workspace(conv.cwd.as_deref(), workspaces);
                let message_count = count_visible_messages(&conv);
                let tool_count = conv
                    .items
                    .iter()
                    .filter(|i| matches!(i, ExternalConversationItem::Tool { .. }))
                    .count();
                ConversationPreviewItem {
                    source: conv.source,
                    source_id: conv.source_id,
                    source_path: conv.source_path,
                    fingerprint: conv.fingerprint,
                    title: conv.title,
                    cwd: conv.cwd,
                    created_at: conv.created_at,
                    updated_at: conv.updated_at,
                    original_provider: conv.original_provider,
                    original_model: conv.original_model,
                    message_count,
                    tool_count,
                    warnings: conv.warnings,
                    mapping,
                    already_imported_thread_id,
                }
            })
            .collect();

        ConversationImportPreviewResult {
            conversations: previews,
        }
    }

    pub fn validate_workspace_mappings(
        &self,
        mappings: &BTreeMap<String, ConversationWorkspaceMappingInput>,
        workspaces: &[KnownWorkspaceEntry],
    ) -> ConversationWorkspaceMappingsValidateResult {
        let mut valid = true;
        let mut out_mappings = BTreeMap::new();
        let mut errors = Vec::new();

        for (fp, mapping_input) in mappings {
            match validate_workspace_mapping_input(mapping_input, workspaces) {
                Err(msg) => {
                    valid = false;
                    errors.push(WorkspaceMappingValidationError {
                        fingerprint: fp.clone(),
                        message: msg,
                    });
                }
                Ok(resolved) => {
                    if matches!(resolved, ConversationWorkspaceMapping::Missing { .. }) {
                        valid = false;
                        errors.push(WorkspaceMappingValidationError {
                            fingerprint: fp.clone(),
                            message: "Workspace path must be an existing directory.".to_owned(),
                        });
                    }
                    out_mappings.insert(fp.clone(), resolved);
                }
            }
        }

        ConversationWorkspaceMappingsValidateResult {
            valid,
            mappings: out_mappings,
            errors,
        }
    }

    pub async fn import_selected<F>(
        &self,
        cfg: &AgentConfig,
        input: ConversationImportRunInput,
        workspaces: &[KnownWorkspaceEntry],
        mut ensure_workspace: F,
    ) -> ConversationImportImportResult
    where
        F: FnMut(&str, Option<&str>) -> Result<EnsuredWorkspaceOutcome, String>,
    {
        let conversations =
            self.load_conversations(&input.selection, input.include_archived.unwrap_or(false));
        let mut by_key: HashMap<(ConversationImportSource, String), ExternalConversation> =
            HashMap::new();
        for conv in conversations {
            by_key.insert((conv.source, conv.fingerprint.clone()), conv);
        }

        let provider = input
            .provider
            .or(input.default_provider)
            .unwrap_or(cfg.provider);
        let model = input
            .model
            .or(input.default_model)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cfg.model.clone());

        let mut result = ConversationImportImportResult {
            imported: Vec::new(),
            skipped: Vec::new(),
            failed: Vec::new(),
            created_workspaces: Vec::new(),
        };

        for selected in &input.selected {
            let key = (selected.source, selected.fingerprint.clone());
            let Some(conversation) = by_key.get(&key) else {
                result.failed.push(FailedConversationSummary {
                    source: selected.source,
                    fingerprint: selected.fingerprint.clone(),
                    message: "Selected conversation was not found in the scanned sources."
                        .to_owned(),
                });
                continue;
            };

            if let Ok(Some(existing)) = self.session_db.get_external_conversation_import(
                conversation.source.as_str(),
                &conversation.fingerprint,
            ) {
                result.skipped.push(SkippedConversationSummary {
                    source: conversation.source,
                    fingerprint: conversation.fingerprint.clone(),
                    existing_thread_id: existing.imported_session_id,
                    reason: "already_imported".to_owned(),
                });
                continue;
            }

            let composite_key = format!(
                "{}:{}",
                conversation.source.as_str(),
                conversation.fingerprint
            );
            let mapping_override = input.mappings.as_ref().and_then(|m| {
                m.get(&conversation.fingerprint)
                    .or_else(|| m.get(&composite_key))
            });

            let resolved_ws: Result<(String, Option<String>), String> = (|| {
                if let Some(m_in) = mapping_override {
                    let validated = validate_workspace_mapping_input(m_in, workspaces)?;
                    match validated {
                        ConversationWorkspaceMapping::Missing { .. } => {
                            Err("Workspace path must be an existing directory.".to_owned())
                        }
                        ConversationWorkspaceMapping::Matched {
                            workspace_id,
                            workspace_path,
                        } => Ok((workspace_path, Some(workspace_id))),
                        ConversationWorkspaceMapping::Create {
                            workspace_path,
                            name,
                        } => {
                            let ensured = ensure_workspace(&workspace_path, Some(&name))?;
                            if ensured.created
                                && let Some(ref wid) = ensured.workspace_id
                            {
                                result.created_workspaces.push(CreatedWorkspaceSummary {
                                    workspace_id: wid.clone(),
                                    path: ensured.workspace_path.clone(),
                                    name: ensured.name.clone(),
                                });
                            }
                            Ok((ensured.workspace_path, ensured.workspace_id))
                        }
                    }
                } else {
                    match map_conversation_workspace(conversation.cwd.as_deref(), workspaces) {
                        ConversationWorkspaceMapping::Missing { .. } => Err(
                            "Conversation needs an explicit workspace mapping before import."
                                .to_owned(),
                        ),
                        ConversationWorkspaceMapping::Matched {
                            workspace_id,
                            workspace_path,
                        } => Ok((workspace_path, Some(workspace_id))),
                        ConversationWorkspaceMapping::Create {
                            workspace_path,
                            name,
                        } => {
                            let ensured = ensure_workspace(&workspace_path, Some(&name))?;
                            if ensured.created
                                && let Some(ref wid) = ensured.workspace_id
                            {
                                result.created_workspaces.push(CreatedWorkspaceSummary {
                                    workspace_id: wid.clone(),
                                    path: ensured.workspace_path.clone(),
                                    name: ensured.name.clone(),
                                });
                            }
                            Ok((ensured.workspace_path, ensured.workspace_id))
                        }
                    }
                }
            })();

            let (workspace_path, workspace_id) = match resolved_ws {
                Ok(pair) => pair,
                Err(msg) => {
                    result.failed.push(FailedConversationSummary {
                        source: conversation.source,
                        fingerprint: conversation.fingerprint.clone(),
                        message: msg,
                    });
                    continue;
                }
            };

            match self
                .persist_single_import(
                    conversation,
                    &workspace_path,
                    provider,
                    &model,
                    cfg.enable_mcp,
                )
                .await
            {
                Ok(thread_id) => {
                    result.imported.push(ImportedConversationSummary {
                        source: conversation.source,
                        fingerprint: conversation.fingerprint.clone(),
                        thread_id,
                        workspace_id,
                        workspace_path,
                        title: conversation.title.clone(),
                    });
                }
                Err(msg) => {
                    result.failed.push(FailedConversationSummary {
                        source: conversation.source,
                        fingerprint: conversation.fingerprint.clone(),
                        message: msg,
                    });
                }
            }
        }

        result
    }

    async fn persist_single_import(
        &self,
        conversation: &ExternalConversation,
        workspace_path: &str,
        provider: ProviderName,
        model: &str,
        enable_mcp: bool,
    ) -> Result<String, String> {
        let session_id = format!(
            "import_{}_{}",
            conversation.source.as_str(),
            short_hash(&Value::String(conversation.fingerprint.clone()), 24)
        );
        let imported_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let handoff = build_safe_handoff_text(conversation);
        let model_messages = vec![json!({
            "role": "user",
            "content": handoff,
        })];
        let visible_count = count_visible_messages(conversation);
        let preview = preview_text(conversation);
        let feed = conversation_to_session_feed(conversation, &imported_at);

        let snapshot_data = PersistedSessionSnapshotData {
            session_kind: SessionKind::Root,
            parent_session_id: None,
            role: None,
            mode: None,
            depth: None,
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: None,
            effective_model: None,
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            execution_state: Some(AgentExecutionState::Completed),
            last_message_preview: preview.clone(),
            title: conversation.title.clone(),
            title_source: SessionTitleSource::Heuristic,
            title_model: None,
            provider,
            model: model.to_owned(),
            working_directory: workspace_path.to_owned(),
            output_directory: None,
            uploads_directory: None,
            provider_options: None,
            sandbox: None,
            enable_mcp,
            backups_enabled_override: None,
            created_at: conversation.created_at.clone(),
            updated_at: conversation.updated_at.clone(),
            status: SessionPersistenceStatus::Active,
            has_pending_ask: false,
            has_pending_approval: false,
            system_prompt: String::new(),
            messages: model_messages,
            last_memory_generated_index: Some(1),
            provider_state: None,
            todos: Vec::new(),
            harness_context: None,
            cost_tracker: None,
        };

        let snapshot_json = json!({
            "sessionId": session_id,
            "title": conversation.title,
            "titleSource": "heuristic",
            "titleModel": Value::Null,
            "provider": provider.as_str(),
            "model": model,
            "sessionKind": "root",
            "parentSessionId": Value::Null,
            "role": Value::Null,
            "mode": Value::Null,
            "depth": Value::Null,
            "nickname": Value::Null,
            "taskType": Value::Null,
            "targetPaths": Value::Null,
            "profile": Value::Null,
            "requestedModel": Value::Null,
            "effectiveModel": Value::Null,
            "requestedReasoningEffort": Value::Null,
            "effectiveReasoningEffort": Value::Null,
            "executionState": "completed",
            "lastMessagePreview": preview,
            "createdAt": conversation.created_at,
            "updatedAt": conversation.updated_at,
            "messageCount": visible_count,
            "feed": feed,
            "agents": [],
            "todos": [],
            "sessionUsage": Value::Null,
            "lastTurnUsage": Value::Null,
            "hasPendingAsk": false,
            "hasPendingApproval": false,
        });

        let persisted = self
            .session_db
            .persist_external_conversation_import(PersistedExternalConversationImportMutation {
                mutation: PersistedSessionMutation {
                    session_id: session_id.clone(),
                    event_type: "external_conversation_imported".to_owned(),
                    event_ts: Some(imported_at.clone()),
                    direction: Some("system".to_owned()),
                    payload: Some(json!({
                        "source": conversation.source.as_str(),
                        "fingerprint": conversation.fingerprint,
                        "sourceId": conversation.source_id,
                        "sourcePath": conversation.source_path,
                        "originalProvider": conversation.original_provider,
                        "originalModel": conversation.original_model,
                    })),
                    snapshot: snapshot_data,
                },
                snapshot: snapshot_json,
                record: PersistedExternalConversationImport {
                    source: conversation.source.as_str().to_owned(),
                    fingerprint: conversation.fingerprint.clone(),
                    imported_session_id: session_id,
                    source_id: conversation.source_id.clone(),
                    source_path: conversation.source_path.clone(),
                    original_provider: conversation.original_provider.clone(),
                    original_model: conversation.original_model.clone(),
                    imported_at,
                    metadata: json!({
                        "cwd": conversation.cwd,
                        "title": conversation.title,
                        "provider": provider.as_str(),
                        "model": model,
                        "visibleMessageCount": visible_count,
                    }),
                },
            })
            .await
            .map_err(|e| e.to_string())?;

        Ok(persisted.thread_id)
    }
}
