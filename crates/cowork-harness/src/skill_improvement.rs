//! `SkillImprovementService` (`cowork/skills/improvement/{status,run,restore}`).
//!
//! Manages `<coworkHome>/skill-improvement/state.json`, usage-evidence debounced job queueing,
//! cross-process `skill-improvement.lock`, `copy-back` & `delete-shadow` backups under
//! `originals/`, `prerun/` failure rollback snapshots, eligibility scanning, and `SkillMutationBus`
//! refresh notifications.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use cowork_config::{
    AgentConfig, FileLockOptions, ProviderName, SkillImprovementScope, canonicalize_sync,
    ensure_private_dir_sync, file_lock_root_for_cowork_home, get_ai_coworker_paths, host_platform,
    is_inside, parse_child_model_ref, read_connection_store, resolve_home_dir, with_file_lock_sync,
    write_text_file_atomic,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState, ProviderOpaqueMeta,
    RequestPolicy, StepBudget, ToolDefinition, ToolResultPart,
};
use cowork_providers::bedrock::{extract_bedrock_region_override, resolve_bedrock_auth_config};
use cowork_providers::chat_completions::lmstudio::resolve_lmstudio_options;
use cowork_providers::{
    AnthropicMessagesTransport, BedrockConverseTransport, ChatCompletionsTransport,
    CodexAppServerTransport, GoogleInteractionsTransport, OpenAiResponsesTransport,
    ProviderStepRequest, ProviderTransport, resolve_provider_api_key,
};
use cowork_storage::process_alive;
use cowork_tools::{
    BuiltinTool, DiscoveredSkill, SkillScope, ToolExecutionContext, WebSearchTool,
    discover_skills_for_config, parse_and_validate_skill_md,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::extensions::{ExtensionManager, SkillInstallationEntry, copy_dir_confined};

pub const SKILL_IMPROVEMENT_DEBOUNCE_SECS: i64 = 15 * 60;
pub const SKILL_IMPROVEMENT_STALE_RUNNING_SECS: i64 = 30 * 60;
pub const SKILL_IMPROVEMENT_STALE_LOCK_SECS: i64 = 15 * 60;
pub const SKILL_IMPROVEMENT_RESCHEDULE_BUSY_SECS: i64 = 60;
pub const SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB: usize = 25;
pub const SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB: usize = 8;
pub const RUN_HISTORY_LIMIT: usize = 50;
pub const MAX_SKILL_IMPROVER_FILE_BYTES: usize = 96 * 1024;
pub const MAX_SKILL_IMPROVER_FILE_LIST_ENTRIES: usize = 250;
pub const MAX_SKILL_IMPROVER_STEPS: usize = 20;

const EMBEDDED_SKILL_IMPROVER_PROMPT: &str = include_str!("../../../prompts/skill-improver.md");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsageEvent {
    pub skill_name: String,
    pub kind: String,   // "tool" | "reference"
    pub source: String, // "skill-tool" | "at-mention"
    pub turn_id: String,
    pub used_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_source: Option<String>, // "project" | "user" | "global" | "built-in"
    pub session_id: String,
    pub working_directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTranscriptRecord {
    pub session_id: String,
    pub turn_id: String,
    pub working_directory: String,
    pub message_start_index: usize,
    pub message_end_index: usize,
    pub transcript: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTurnSkillUsageInput {
    pub skill_name: String,
    pub kind: String,
    pub source: String,
    pub turn_id: String,
    pub used_at: String,
    pub skill_path: Option<String>,
    pub skill_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTurnSkillUsage {
    pub session_id: String,
    pub turn_id: String,
    pub working_directory: String,
    pub message_start_index: usize,
    pub message_end_index: usize,
    pub transcript: String,
    pub usages: Vec<CompletedTurnSkillUsageInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementJob {
    pub skill_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    pub run_at: String,
    pub last_usage_at: String,
    pub usage_events: Vec<SkillUsageEvent>,
    pub transcripts: Vec<SkillTranscriptRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>, // "pending" | "running"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementRunHistoryEntry {
    pub id: String,
    pub skill_name: String,
    pub status: String, // "completed" | "failed" | "skipped"
    pub started_at: String,
    pub finished_at: String,
    pub message: String,
    pub usage_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementBackupRecord {
    pub key: String,
    pub skill_name: String,
    pub source_root_dir: String,
    pub backup_root_dir: String,
    pub created_at: String,
    pub restore_mode: String, // "copy-back" | "delete-shadow"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_root_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementState {
    pub version: u32,
    #[serde(default)]
    pub pending_jobs: BTreeMap<String, SkillImprovementJob>,
    #[serde(default)]
    pub run_history: Vec<SkillImprovementRunHistoryEntry>,
    #[serde(default)]
    pub backups: BTreeMap<String, SkillImprovementBackupRecord>,
}

impl Default for SkillImprovementState {
    fn default() -> Self {
        Self {
            version: 1,
            pending_jobs: BTreeMap::new(),
            run_history: Vec::new(),
            backups: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementPendingJobSummary {
    pub key: String,
    pub skill_name: String,
    pub run_at: String,
    pub last_usage_at: String,
    pub usage_count: usize,
    pub status: String,
    pub sources: Vec<String>,
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementEligibility {
    pub skill_name: String,
    pub installation_id: String,
    pub scope: String,
    pub enabled: bool,
    pub effective: bool,
    pub eligible: bool,
    pub included: bool,
    pub excluded: bool,
    pub writable: bool,
    pub source_kind: String, // "user" | "marketplace" | "plugin" | "built-in" | "invalid"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub root_dir: String,
    pub skill_path: String,
    pub has_backup: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImprovementStatusEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub scope: String,
    pub excluded_skills: Vec<String>,
    pub busy: bool,
    pub block_reason: Option<String>,
    pub pending_jobs: Vec<SkillImprovementPendingJobSummary>,
    pub run_history: Vec<SkillImprovementRunHistoryEntry>,
    pub backups: Vec<SkillImprovementBackupRecord>,
    pub skills: Vec<SkillImprovementEligibility>,
}

#[derive(Debug, Clone)]
pub struct ClaimedSkillImprovementJob {
    pub key: String,
    pub job: SkillImprovementJob,
}

#[derive(Debug, Clone)]
pub struct SkillImproverRunInput {
    pub skill_name: String,
    pub skill_root_dir: PathBuf,
    pub skill_path: PathBuf,
    pub source_kind: String,
    pub usage_events: Vec<SkillUsageEvent>,
    pub transcripts: Vec<SkillTranscriptRecord>,
    pub all_skills: Vec<DiscoveredSkill>,
}

#[derive(Debug, Clone)]
pub struct SkillImproverRunResult {
    pub ok: bool,
    pub changed: bool,
    pub message: String,
    pub error: Option<String>,
}

#[async_trait]
pub trait SkillImproverRunner: Send + Sync {
    async fn run(&self, cfg: &AgentConfig, input: SkillImproverRunInput) -> SkillImproverRunResult;
}

/// Confined file helper used by `SkillImproverRunner` implementations to read/edit skill bundles safely.
pub struct ConfinedSkillDirectoryEditor {
    root_dir: PathBuf,
    real_root: PathBuf,
}

impl ConfinedSkillDirectoryEditor {
    pub fn open(root_dir: &Path) -> Result<Self, String> {
        let resolved = canonicalize_sync(root_dir);
        if !resolved.is_dir() {
            return Err(format!(
                "Skill root directory does not exist: {}",
                root_dir.display()
            ));
        }
        Ok(Self {
            root_dir: root_dir.to_path_buf(),
            real_root: resolved,
        })
    }

    pub fn resolve_inside(&self, raw_rel: &str) -> Result<PathBuf, String> {
        let trimmed = raw_rel.trim();
        if trimmed.is_empty() || trimmed.contains('\0') {
            return Err("Path must not be empty.".to_owned());
        }
        if Path::new(trimmed).is_absolute() || trimmed.starts_with('/') || trimmed.starts_with('\\')
        {
            return Err("Path escapes the target skill directory.".to_owned());
        }
        let mut clean = PathBuf::new();
        for comp in trimmed.replace('\\', "/").split('/') {
            if comp.is_empty() || comp == "." {
                continue;
            }
            if comp == ".." {
                if !clean.pop() {
                    return Err("Path escapes the target skill directory.".to_owned());
                }
            } else {
                clean.push(comp);
            }
        }
        let candidate = self.root_dir.join(&clean);
        let mut probe = candidate.as_path();
        loop {
            if probe.exists() {
                let real_probe = canonicalize_sync(probe);
                if real_probe != self.real_root && !is_inside(&self.real_root, &real_probe) {
                    return Err("Path escapes the target skill directory.".to_owned());
                }
                break;
            }
            let Some(parent) = probe.parent() else {
                break;
            };
            if parent == probe {
                break;
            }
            probe = parent;
        }
        Ok(candidate)
    }

    pub fn list_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        fn walk(base: &Path, current: &Path, out: &mut Vec<String>) {
            if out.len() >= MAX_SKILL_IMPROVER_FILE_LIST_ENTRIES {
                return;
            }
            let Ok(rd) = fs::read_dir(current) else {
                return;
            };
            let mut entries: Vec<_> = rd.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                if out.len() >= MAX_SKILL_IMPROVER_FILE_LIST_ENTRIES {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" || name == "node_modules" {
                    continue;
                }
                let full = entry.path();
                let Ok(rel) = full.strip_prefix(base) else {
                    continue;
                };
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if ft.is_dir() {
                    out.push(format!("{rel_str}/"));
                    walk(base, &full, out);
                } else if ft.is_file() {
                    out.push(rel_str);
                }
            }
        }
        walk(&self.root_dir, &self.root_dir, &mut out);
        out
    }

    pub fn read_file(&self, rel_path: &str) -> Result<String, String> {
        let target = self.resolve_inside(rel_path)?;
        let meta = fs::metadata(&target).map_err(|e| format!("Failed stating file: {e}"))?;
        if !meta.is_file() {
            return Err("Path is not a file.".to_owned());
        }
        if meta.len() as usize > MAX_SKILL_IMPROVER_FILE_BYTES {
            return Err(format!(
                "File is too large ({} bytes, max {MAX_SKILL_IMPROVER_FILE_BYTES}).",
                meta.len()
            ));
        }
        fs::read_to_string(&target).map_err(|e| format!("Failed reading file: {e}"))
    }

    pub fn write_file(&self, rel_path: &str, content: &str) -> Result<PathBuf, String> {
        if content.len() > MAX_SKILL_IMPROVER_FILE_BYTES {
            return Err(format!(
                "Content is too large ({} bytes, max {MAX_SKILL_IMPROVER_FILE_BYTES}).",
                content.len()
            ));
        }
        let target = self.resolve_inside(rel_path)?;
        if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Path escapes the target skill directory.".to_owned());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed creating parent dir: {e}"))?;
        }
        fs::write(&target, content).map_err(|e| format!("Failed writing file: {e}"))?;
        Ok(target)
    }

    pub fn edit_file(
        &self,
        rel_path: &str,
        old_text: &str,
        new_text: &str,
    ) -> Result<PathBuf, String> {
        if old_text.is_empty() {
            return Err("oldText must not be empty.".to_owned());
        }
        let current = self.read_file(rel_path)?;
        let Some(pos) = current.find(old_text) else {
            return Err("oldText was not found.".to_owned());
        };
        if current[pos + old_text.len()..].contains(old_text) {
            return Err("oldText matched multiple locations; provide more context.".to_owned());
        }
        let mut next = String::with_capacity(current.len() - old_text.len() + new_text.len());
        next.push_str(&current[..pos]);
        next.push_str(new_text);
        next.push_str(&current[pos + old_text.len()..]);
        self.write_file(rel_path, &next)
    }
}

/// Validates that `SKILL.md` parses and keeps its original `name` frontmatter after an improvement run.
pub fn validate_improved_skill_frontmatter(
    skill_path: &Path,
    expected_name: &str,
) -> Result<(), String> {
    let meta = fs::metadata(skill_path)
        .map_err(|e| format!("Failed stating SKILL.md after improvement: {e}"))?;
    if !meta.is_file() {
        return Err("SKILL.md is not a regular file.".to_owned());
    }
    if meta.len() as usize > MAX_SKILL_IMPROVER_FILE_BYTES {
        return Err(format!(
            "SKILL.md exceeds {MAX_SKILL_IMPROVER_FILE_BYTES} bytes ({} bytes).",
            meta.len()
        ));
    }
    let raw = fs::read_to_string(skill_path)
        .map_err(|e| format!("Failed reading SKILL.md after improvement: {e}"))?;
    let dir_path = skill_path
        .parent()
        .ok_or_else(|| "Invalid SKILL.md path without parent directory.".to_owned())?;
    let expected_slug = expected_name
        .rsplit_once(':')
        .map(|(_, s)| s)
        .unwrap_or(expected_name);
    let parsed = parse_and_validate_skill_md(dir_path, skill_path, &raw, SkillScope::Global, true)
        .map_err(|e| format!("Skill improvement produced invalid frontmatter: {e}"))?;
    if parsed.name != expected_slug {
        return Err("Skill improvement produced invalid frontmatter.".to_owned());
    }
    Ok(())
}

pub type SkillImproverEnvProvider = Arc<dyn Fn() -> HashMap<String, String> + Send + Sync>;

/// Model-backed `SkillImproverRunner` executing the bounded 20-step `prompts/skill-improver.md`
/// tool loop (`list_files`, `read_file`, `write_file`, `edit_file`, `webSearch`, `finish`) inside
/// the confined target/shadow skill directory.
pub struct ModelBackedSkillImprover {
    env_provider: SkillImproverEnvProvider,
}

impl ModelBackedSkillImprover {
    pub fn new(env: HashMap<String, String>) -> Self {
        Self {
            env_provider: Arc::new(move || env.clone()),
        }
    }

    pub fn with_env_provider<F>(provider: F) -> Self
    where
        F: Fn() -> HashMap<String, String> + Send + Sync + 'static,
    {
        Self {
            env_provider: Arc::new(provider),
        }
    }
}

fn load_skill_improver_prompt(cfg: &AgentConfig) -> String {
    let prompt_path = cfg.built_in_dir.join("prompts").join("skill-improver.md");
    let raw = fs::read_to_string(&prompt_path)
        .unwrap_or_else(|_| EMBEDDED_SKILL_IMPROVER_PROMPT.to_owned());
    raw.replace("\r\n", "\n").trim().to_owned()
}

fn render_usage_events_for_prompt(events: &[SkillUsageEvent]) -> String {
    if events.is_empty() {
        return "- (none recorded; manual run)".to_owned();
    }
    events
        .iter()
        .map(|evt| {
            let src = evt.skill_source.as_deref().unwrap_or("unknown");
            format!(
                "- {} | kind={} | source={} | skillSource={src} | session={} | turn={} | cwd={}",
                evt.used_at,
                evt.kind,
                evt.source,
                evt.session_id,
                evt.turn_id,
                evt.working_directory
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_transcripts_for_prompt(transcripts: &[SkillTranscriptRecord]) -> String {
    if transcripts.is_empty() {
        return "(no turn transcripts recorded)".to_owned();
    }
    transcripts
        .iter()
        .map(|entry| {
            format!(
                "### Turn {} (session {}, messages {}..{}, cwd {})\n{}",
                entry.turn_id,
                entry.session_id,
                entry.message_start_index,
                entry.message_end_index,
                entry.working_directory,
                entry.transcript
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_skill_catalog_for_prompt(skills: &[DiscoveredSkill], target_name: &str) -> String {
    let mut lines: Vec<String> = skills
        .iter()
        .filter(|s| s.name != target_name)
        .take(80)
        .map(|s| format!("- {} ({:?}): {}", s.name, s.scope, s.description))
        .collect();
    if lines.is_empty() {
        lines.push("- (no other skills discovered)".to_owned());
    }
    lines.join("\n")
}

fn build_skill_improver_tool_definitions() -> Vec<ToolDefinition> {
    let web_search_def = BuiltinTool::definition(&WebSearchTool);
    vec![
        ToolDefinition {
            name: "list_files".to_owned(),
            description: "List files inside the target skill directory.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "read_file".to_owned(),
            description:
                "Read a UTF-8 text file inside the target skill directory by relative path."
                    .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Relative path inside the target skill directory, e.g. SKILL.md"
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "write_file".to_owned(),
            description:
                "Create or replace a UTF-8 text file inside the target skill directory by relative path."
                    .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Relative path inside the target skill directory"
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete UTF-8 file contents"
                    }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "edit_file".to_owned(),
            description:
                "Replace one exact text span in a UTF-8 file inside the target skill directory."
                    .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Relative path inside the target skill directory"
                    },
                    "oldText": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Exact existing text to replace once"
                    },
                    "newText": {
                        "type": "string",
                        "description": "Replacement text"
                    }
                },
                "required": ["path", "oldText", "newText"],
                "additionalProperties": false
            }),
        },
        web_search_def,
        ToolDefinition {
            name: "finish".to_owned(),
            description:
                "Finish the skill-improvement run with a concise summary of changes or why no changes were needed."
                    .to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Short summary for the skill-improvement run log"
                    }
                },
                "required": ["summary"],
                "additionalProperties": false
            }),
        },
    ]
}

fn require_exact_keys(args: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    for k in args.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("Unexpected argument \"{k}\"."));
        }
    }
    Ok(())
}

fn require_string_arg<'a>(
    args: &'a Map<String, Value>,
    key: &str,
    non_empty: bool,
) -> Result<&'a str, String> {
    let Some(val) = args.get(key).and_then(Value::as_str) else {
        return Err(format!("Missing required string argument \"{key}\"."));
    };
    if non_empty && val.is_empty() {
        return Err(format!("Argument \"{key}\" must not be empty."));
    }
    Ok(val)
}

struct ResolvedImproverTransport {
    transport: Arc<dyn ProviderTransport>,
    base_url: Option<String>,
    api_key: Option<String>,
}

fn resolve_improver_transport_and_endpoint(
    provider: ProviderName,
    homedir: &Path,
    env: &HashMap<String, String>,
    conn_store: Option<&cowork_config::ConnectionStore>,
    provider_opts: &Map<String, Value>,
) -> Result<ResolvedImproverTransport, String> {
    let api_key = resolve_provider_api_key(provider, conn_store, env);
    let bedrock_auth = if provider == ProviderName::Bedrock {
        let mut auth = resolve_bedrock_auth_config(homedir, env, conn_store);
        if let (Some(reg), Some(b_cfg)) = (
            extract_bedrock_region_override(provider_opts),
            auth.as_mut(),
        ) {
            b_cfg.region = reg;
            b_cfg.has_configured_region = true;
        }
        auth
    } else {
        None
    };

    let base_url = match provider {
        ProviderName::Lmstudio => {
            let lms = resolve_lmstudio_options(env, Some(provider_opts), None);
            Some(lms.inference_base_url)
        }
        other => {
            let env_key = match other {
                ProviderName::Google => "GEMINI_BASE_URL".to_owned(),
                ProviderName::Bedrock => "AWS_BEDROCK_ENDPOINT_URL".to_owned(),
                p => format!(
                    "{}_BASE_URL",
                    p.as_str().to_ascii_uppercase().replace('-', "_")
                ),
            };
            provider_opts
                .get(other.as_str())
                .and_then(Value::as_object)
                .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
                .or_else(|| {
                    provider_opts
                        .get("baseUrl")
                        .or_else(|| provider_opts.get("base_url"))
                })
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    env.get(&env_key)
                        .map(String::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                })
        }
    };

    let transport: Arc<dyn ProviderTransport> = match provider {
        ProviderName::Openai => Arc::new(OpenAiResponsesTransport::new()),
        ProviderName::Anthropic => Arc::new(AnthropicMessagesTransport::new()),
        ProviderName::Google => Arc::new(GoogleInteractionsTransport::new()),
        ProviderName::Bedrock => match bedrock_auth {
            Some(auth) => Arc::new(BedrockConverseTransport::with_auth(auth)),
            None => Arc::new(BedrockConverseTransport::with_isolated_env(
                homedir.to_path_buf(),
                env.clone(),
            )),
        },
        ProviderName::CodexCli => Arc::new(CodexAppServerTransport::with_env(env.clone())),
        other => ChatCompletionsTransport::new(other)
            .map(|t| Arc::new(t) as Arc<dyn ProviderTransport>)
            .ok_or_else(|| format!("Unsupported provider transport: {}", other.as_str()))?,
    };

    Ok(ResolvedImproverTransport {
        transport,
        base_url,
        api_key,
    })
}

#[async_trait]
impl SkillImproverRunner for ModelBackedSkillImprover {
    async fn run(&self, cfg: &AgentConfig, input: SkillImproverRunInput) -> SkillImproverRunResult {
        let editor = match ConfinedSkillDirectoryEditor::open(&input.skill_root_dir) {
            Ok(ed) => ed,
            Err(err) => {
                return SkillImproverRunResult {
                    ok: false,
                    changed: false,
                    message: "Skill frontmatter is invalid before improvement.".to_owned(),
                    error: Some(err),
                };
            }
        };

        let initial_name = {
            let meta = match fs::metadata(&input.skill_path) {
                Ok(m) if m.is_file() && (m.len() as usize) <= MAX_SKILL_IMPROVER_FILE_BYTES => m,
                Ok(m) if !m.is_file() => {
                    return SkillImproverRunResult {
                        ok: false,
                        changed: false,
                        message: "Skill frontmatter is invalid before improvement.".to_owned(),
                        error: Some("SKILL.md is not a regular file.".to_owned()),
                    };
                }
                Ok(m) => {
                    return SkillImproverRunResult {
                        ok: false,
                        changed: false,
                        message: "Skill frontmatter is invalid before improvement.".to_owned(),
                        error: Some(format!(
                            "SKILL.md exceeds {MAX_SKILL_IMPROVER_FILE_BYTES} bytes ({} bytes).",
                            m.len()
                        )),
                    };
                }
                Err(err) => {
                    return SkillImproverRunResult {
                        ok: false,
                        changed: false,
                        message: "Skill frontmatter is invalid before improvement.".to_owned(),
                        error: Some(format!("Failed stating SKILL.md: {err}")),
                    };
                }
            };
            let _ = meta;
            let raw = match fs::read_to_string(&input.skill_path) {
                Ok(s) => s,
                Err(err) => {
                    return SkillImproverRunResult {
                        ok: false,
                        changed: false,
                        message: "Skill frontmatter is invalid before improvement.".to_owned(),
                        error: Some(format!("Failed reading SKILL.md: {err}")),
                    };
                }
            };
            match parse_and_validate_skill_md(
                &input.skill_root_dir,
                &input.skill_path,
                &raw,
                SkillScope::Global,
                true,
            ) {
                Ok(parsed) => parsed.name,
                Err(err) => {
                    return SkillImproverRunResult {
                        ok: false,
                        changed: false,
                        message: "Skill frontmatter is invalid before improvement.".to_owned(),
                        error: Some(err.to_string()),
                    };
                }
            }
        };

        let requested_model = cfg
            .skill_improvement_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let s = cfg.preferred_child_model_ref.trim();
                (!s.is_empty()).then_some(s)
            })
            .or_else(|| {
                let s = cfg.preferred_child_model.trim();
                (!s.is_empty()).then_some(s)
            })
            .unwrap_or(&cfg.model);
        let (provider, model_id) = parse_child_model_ref(requested_model, Some(cfg.provider))
            .map(|(prov, mid, _, _)| (prov, mid))
            .unwrap_or_else(|| (cfg.provider, cfg.model.clone()));

        let eff_env = (self.env_provider)();
        let homedir = if cfg.user_cowork_dir.file_name().and_then(|n| n.to_str()) == Some(".cowork")
            && let Some(parent) = cfg.user_cowork_dir.parent()
        {
            parent.to_path_buf()
        } else {
            resolve_home_dir(&eff_env, host_platform())
        };
        let ai_paths = get_ai_coworker_paths(Some(&homedir), &eff_env);
        let conn_store = read_connection_store(&ai_paths).await.ok();

        let mut merged_provider_opts = cfg.provider_options.clone().unwrap_or_default();
        merged_provider_opts.insert(
            "coworkHome".to_owned(),
            Value::String(ai_paths.root_dir.to_string_lossy().into_owned()),
        );
        merged_provider_opts.insert(
            "cwd".to_owned(),
            Value::String(cfg.working_directory.to_string_lossy().into_owned()),
        );

        let ResolvedImproverTransport {
            transport,
            base_url,
            api_key,
        } = match resolve_improver_transport_and_endpoint(
            provider,
            &homedir,
            &eff_env,
            conn_store.as_ref(),
            &merged_provider_opts,
        ) {
            Ok(resolved) => resolved,
            Err(err) => {
                return SkillImproverRunResult {
                    ok: false,
                    changed: false,
                    message: "Skill improvement run failed.".to_owned(),
                    error: Some(err),
                };
            }
        };

        let system_prompt = load_skill_improver_prompt(cfg);
        let user_message = [
            format!("Target skill: {}", input.skill_name),
            format!("Target root directory: {}", input.skill_root_dir.display()),
            format!("Target SKILL.md: {}", input.skill_path.display()),
            format!("Source kind: {}", input.source_kind),
            String::new(),
            "## Usage events".to_owned(),
            render_usage_events_for_prompt(&input.usage_events),
            String::new(),
            "## Relevant turn transcripts".to_owned(),
            render_transcripts_for_prompt(&input.transcripts),
            String::new(),
            "## Installed skills catalog".to_owned(),
            render_skill_catalog_for_prompt(&input.all_skills, &input.skill_name),
            String::new(),
            "Inspect the target skill directory before deciding whether to edit anything. Call finish when done.".to_owned(),
        ]
        .join("\n");

        let tools = build_skill_improver_tool_definitions();
        let authorized_tool_names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();

        let mut web_tool_ctx = ToolExecutionContext::new_for_tests(
            homedir.clone(),
            cfg.working_directory.clone(),
            provider,
            model_id.clone(),
        );
        web_tool_ctx.session_id = format!("skill-improvement:{}", input.skill_name);
        web_tool_ctx.cowork_home = ai_paths.root_dir.clone();
        web_tool_ctx.env = eff_env;
        web_tool_ctx.provider_options = merged_provider_opts.clone();
        web_tool_ctx.agent_config = Some(Arc::new(cfg.clone()));

        let mut messages = vec![CanonicalMessage {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: user_message,
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
            created_at: Utc::now().to_rfc3339(),
        }];

        let mut mutated_paths: BTreeSet<PathBuf> = BTreeSet::new();
        let mut finish_message = String::new();
        let mut continuation: Option<ProviderContinuationState> = None;

        for _step in 0..MAX_SKILL_IMPROVER_STEPS {
            let req = ProviderStepRequest {
                model_id: model_id.clone(),
                base_url: base_url.clone(),
                api_key: api_key.clone(),
                extra_headers: HashMap::new(),
                system_prompt: system_prompt.clone(),
                messages: messages.clone(),
                tools: tools.clone(),
                authorized_tool_names: Some(authorized_tool_names.clone()),
                provider_options: merged_provider_opts.clone(),
                continuation: continuation.clone(),
                policy: RequestPolicy {
                    max_attempts: 2,
                    timeout_ms: 90_000,
                    ..RequestPolicy::default()
                },
                turn_id: format!("skill_imp_{}", Uuid::new_v4()),
            };
            let budget = StepBudget::new(90_000, None);
            let mut noop = |_ev| {};
            let step_res = match transport.stream_step(req, &budget, &mut noop).await {
                Ok(res) => res,
                Err(err) => {
                    return SkillImproverRunResult {
                        ok: false,
                        changed: !mutated_paths.is_empty(),
                        message: "Skill improvement run failed.".to_owned(),
                        error: Some(err.to_string()),
                    };
                }
            };
            continuation = step_res.continuation;

            let mut tool_calls: Vec<(String, String, Map<String, Value>)> = Vec::new();
            for block in &step_res.assistant.content {
                if let ContentBlock::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                } = block
                {
                    tool_calls.push((id.clone(), name.clone(), arguments.clone()));
                }
            }

            messages.push(step_res.persisted_assistant.unwrap_or(step_res.assistant));

            if tool_calls.is_empty() {
                break;
            }

            let mut tool_results: Vec<ContentBlock> = Vec::with_capacity(tool_calls.len());
            let mut did_finish = false;

            for (call_id, call_name, call_args) in tool_calls {
                let exec_res: Result<String, String> = match call_name.as_str() {
                    "list_files" => require_exact_keys(&call_args, &[]).and_then(|()| {
                        serde_json::to_string_pretty(&json!({ "files": editor.list_files() }))
                            .map_err(|e| e.to_string())
                    }),
                    "read_file" => require_exact_keys(&call_args, &["path"]).and_then(|()| {
                        let rel = require_string_arg(&call_args, "path", true)?;
                        editor.read_file(rel)
                    }),
                    "write_file" => {
                        require_exact_keys(&call_args, &["path", "content"]).and_then(|()| {
                            let rel = require_string_arg(&call_args, "path", true)?;
                            let content = require_string_arg(&call_args, "content", false)?;
                            let target = editor.write_file(rel, content)?;
                            let rel_disp = target
                                .strip_prefix(&input.skill_root_dir)
                                .unwrap_or(&target)
                                .to_string_lossy()
                                .replace('\\', "/");
                            mutated_paths.insert(target);
                            Ok(format!("Wrote {rel_disp}"))
                        })
                    }
                    "edit_file" => require_exact_keys(&call_args, &["path", "oldText", "newText"])
                        .and_then(|()| {
                            let rel = require_string_arg(&call_args, "path", true)?;
                            let old_text = require_string_arg(&call_args, "oldText", true)?;
                            let new_text = require_string_arg(&call_args, "newText", false)?;
                            let target = editor.edit_file(rel, old_text, new_text)?;
                            let rel_disp = target
                                .strip_prefix(&input.skill_root_dir)
                                .unwrap_or(&target)
                                .to_string_lossy()
                                .replace('\\', "/");
                            mutated_paths.insert(target);
                            Ok(format!("Edited {rel_disp}"))
                        }),
                    "webSearch" => BuiltinTool::execute(&WebSearchTool, call_args, &web_tool_ctx)
                        .await
                        .map(|out| match out.to_json_value() {
                            Value::String(s) => s,
                            other => serde_json::to_string_pretty(&other)
                                .unwrap_or_else(|_| other.to_string()),
                        })
                        .map_err(|e| e.to_string()),
                    "finish" => require_exact_keys(&call_args, &["summary"]).and_then(|()| {
                        let summary = require_string_arg(&call_args, "summary", true)?;
                        finish_message = summary.trim().to_owned();
                        did_finish = true;
                        Ok(finish_message.clone())
                    }),
                    other => Err(format!("Unsupported skill improver tool: {other}")),
                };

                let (text, is_error) = match exec_res {
                    Ok(t) => (t, false),
                    Err(e) => (e, true),
                };
                tool_results.push(ContentBlock::ToolResult {
                    tool_call_id: call_id,
                    tool_name: Some(call_name),
                    content: vec![ToolResultPart::Text { text }],
                    structured_meta: None,
                    is_error,
                    provider_meta: ProviderOpaqueMeta::default(),
                });
            }

            messages.push(CanonicalMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::Tool,
                content: tool_results,
                phase: None,
                provider: None,
                api: None,
                model: None,
                stop_reason: None,
                provider_meta: ProviderOpaqueMeta::default(),
                created_at: Utc::now().to_rfc3339(),
            });

            if did_finish {
                break;
            }
        }

        let changed = !mutated_paths.is_empty();
        if let Err(err) = validate_improved_skill_frontmatter(&input.skill_path, &initial_name) {
            return SkillImproverRunResult {
                ok: false,
                changed,
                message: "Skill improvement produced invalid frontmatter.".to_owned(),
                error: Some(err),
            };
        }

        SkillImproverRunResult {
            ok: true,
            changed,
            message: if !finish_message.is_empty() {
                finish_message
            } else if changed {
                "Skill improved.".to_owned()
            } else {
                "No changes needed.".to_owned()
            },
            error: None,
        }
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_iso_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn job_key_for_usage(
    skill_name: &str,
    skill_source: Option<&str>,
    working_directory: &str,
) -> String {
    let trimmed = skill_name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if skill_source == Some("project") {
        format!("{trimmed}@@{working_directory}")
    } else {
        trimmed.to_owned()
    }
}

/// Persistent `state.json` store for `SkillImprovementService`.
#[derive(Debug, Clone)]
pub struct SkillImprovementJobStore {
    pub root_dir: PathBuf,
    pub state_path: PathBuf,
    cowork_home: PathBuf,
}

impl SkillImprovementJobStore {
    pub fn new(cowork_home: &Path) -> Self {
        let root_dir = cowork_home.join("skill-improvement");
        let state_path = root_dir.join("state.json");
        Self {
            root_dir,
            state_path,
            cowork_home: cowork_home.to_path_buf(),
        }
    }

    fn lock_options(&self) -> FileLockOptions {
        FileLockOptions {
            lock_root: Some(file_lock_root_for_cowork_home(&self.cowork_home)),
            ..FileLockOptions::default()
        }
    }

    pub fn read(&self) -> SkillImprovementState {
        if !self.state_path.exists() {
            return SkillImprovementState::default();
        }
        let Ok(raw) = fs::read_to_string(&self.state_path) else {
            return self.recover_corrupt_state();
        };
        let Ok(mut parsed) = serde_json::from_str::<SkillImprovementState>(&raw) else {
            return self.recover_corrupt_state();
        };
        if parsed.version != 1 {
            return self.recover_corrupt_state();
        }
        parsed.run_history.truncate(RUN_HISTORY_LIMIT);
        parsed
    }

    fn recover_corrupt_state(&self) -> SkillImprovementState {
        if self.state_path.exists() {
            let corrupt_name =
                format!("state.corrupt.{}.json", Utc::now().format("%Y%m%dT%H%M%SZ"));
            let _ = fs::rename(&self.state_path, self.root_dir.join(corrupt_name));
        }
        SkillImprovementState::default()
    }

    fn update<T, F>(&self, mutator: F) -> Result<T, String>
    where
        F: FnOnce(&mut SkillImprovementState) -> T,
    {
        ensure_private_dir_sync(&self.root_dir).map_err(|e| e.to_string())?;
        with_file_lock_sync::<T, anyhow::Error, _>(
            &self.state_path,
            || {
                let mut state = self.read();
                let now_ms = Utc::now().timestamp_millis();
                Self::recover_stale_running_in_memory(&mut state, now_ms);
                let out = mutator(&mut state);
                state.run_history.truncate(RUN_HISTORY_LIMIT);
                let serialized =
                    serde_json::to_string_pretty(&state).map_err(|e| anyhow::anyhow!(e))?;
                write_text_file_atomic(&self.state_path, &serialized, Some(0o600))
                    .map_err(|e| anyhow::anyhow!(e))?;
                Ok(out)
            },
            self.lock_options(),
        )
        .map_err(|e| e.to_string())
    }

    fn recover_stale_running_in_memory(state: &mut SkillImprovementState, now_ms: i64) {
        let stale_ms = SKILL_IMPROVEMENT_STALE_RUNNING_SECS * 1000;
        for job in state.pending_jobs.values_mut() {
            if job.status.as_deref() == Some("running") {
                let is_stale = match job.started_at.as_deref().and_then(parse_iso_ms) {
                    Some(started_ms) => now_ms - started_ms >= stale_ms,
                    None => true,
                };
                if is_stale {
                    job.status = Some("pending".to_owned());
                    job.started_at = None;
                }
            }
        }
    }

    pub fn recover_stale_running(&self) -> Result<(), String> {
        self.update(|_| ())
    }

    pub fn enqueue_completed_turn(&self, completed: CompletedTurnSkillUsage) -> Result<(), String> {
        if completed.usages.is_empty() {
            return Ok(());
        }
        let transcript_rec = SkillTranscriptRecord {
            session_id: completed.session_id.clone(),
            turn_id: completed.turn_id.clone(),
            working_directory: completed.working_directory.clone(),
            message_start_index: completed.message_start_index,
            message_end_index: completed.message_end_index,
            transcript: completed.transcript.clone(),
        };

        self.update(|state| {
            let now = now_iso();
            for u in &completed.usages {
                let key = job_key_for_usage(
                    &u.skill_name,
                    u.skill_source.as_deref(),
                    &completed.working_directory,
                );
                if key.is_empty() {
                    continue;
                }
                let run_at = DateTime::parse_from_rfc3339(&u.used_at)
                    .map(|dt| {
                        (dt.with_timezone(&Utc)
                            + ChronoDuration::seconds(SKILL_IMPROVEMENT_DEBOUNCE_SECS))
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    })
                    .unwrap_or_else(|_| {
                        (Utc::now() + ChronoDuration::seconds(SKILL_IMPROVEMENT_DEBOUNCE_SECS))
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    });
                let event = SkillUsageEvent {
                    skill_name: u.skill_name.clone(),
                    kind: u.kind.clone(),
                    source: u.source.clone(),
                    turn_id: u.turn_id.clone(),
                    used_at: u.used_at.clone(),
                    skill_path: u.skill_path.clone(),
                    skill_source: u.skill_source.clone(),
                    session_id: completed.session_id.clone(),
                    working_directory: completed.working_directory.clone(),
                };

                if let Some(current) = state.pending_jobs.get_mut(&key) {
                    if current.status.as_deref() != Some("running") {
                        current.run_at = run_at;
                    }
                    if u.used_at > current.last_usage_at {
                        current.last_usage_at = u.used_at.clone();
                    }
                    current.usage_events.push(event);
                    if current.usage_events.len() > SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB {
                        let drop_n =
                            current.usage_events.len() - SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB;
                        current.usage_events.drain(0..drop_n);
                    }
                    if !current
                        .transcripts
                        .iter()
                        .any(|t| t.turn_id == transcript_rec.turn_id)
                    {
                        current.transcripts.push(transcript_rec.clone());
                        if current.transcripts.len() > SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB {
                            let drop_n = current.transcripts.len()
                                - SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB;
                            current.transcripts.drain(0..drop_n);
                        }
                    }
                    current.updated_at = now.clone();
                } else {
                    state.pending_jobs.insert(
                        key,
                        SkillImprovementJob {
                            skill_name: u.skill_name.clone(),
                            working_directory: (u.skill_source.as_deref() == Some("project"))
                                .then(|| completed.working_directory.clone()),
                            run_at,
                            last_usage_at: u.used_at.clone(),
                            usage_events: vec![event],
                            transcripts: vec![transcript_rec.clone()],
                            status: Some("pending".to_owned()),
                            started_at: None,
                            updated_at: now.clone(),
                        },
                    );
                }
            }
        })
    }

    pub fn claim_due_job(&self) -> Result<Option<ClaimedSkillImprovementJob>, String> {
        let now_ms = Utc::now().timestamp_millis();
        self.update(|state| {
            let mut due_keys: Vec<(String, i64)> = state
                .pending_jobs
                .iter()
                .filter(|(_, job)| job.status.as_deref().unwrap_or("pending") == "pending")
                .filter_map(|(k, job)| {
                    let run_ms = parse_iso_ms(&job.run_at)?;
                    (run_ms <= now_ms).then_some((k.clone(), run_ms))
                })
                .collect();
            due_keys.sort_by_key(|(_, ms)| *ms);
            let (key, _) = due_keys.into_iter().next()?;
            Self::claim_in_state(state, &key)
        })
    }

    pub fn claim_job_by_key(
        &self,
        key: &str,
    ) -> Result<Option<ClaimedSkillImprovementJob>, String> {
        self.update(|state| Self::claim_in_state(state, key))
    }

    pub fn claim_job(
        &self,
        skill_name: &str,
        cwd: Option<&str>,
    ) -> Result<Option<ClaimedSkillImprovementJob>, String> {
        let trimmed = skill_name.trim();
        self.update(|state| {
            if let Some(ws) = cwd {
                let proj_key = format!("{trimmed}@@{ws}");
                if state
                    .pending_jobs
                    .get(&proj_key)
                    .is_some_and(|j| j.status.as_deref().unwrap_or("pending") == "pending")
                {
                    return Self::claim_in_state(state, &proj_key);
                }
            }
            if state
                .pending_jobs
                .get(trimmed)
                .is_some_and(|j| j.status.as_deref().unwrap_or("pending") == "pending")
            {
                return Self::claim_in_state(state, trimmed);
            }
            let fallback_key = state
                .pending_jobs
                .iter()
                .find(|(_, j)| {
                    j.skill_name.trim() == trimmed
                        && j.status.as_deref().unwrap_or("pending") == "pending"
                })
                .map(|(k, _)| k.clone())?;
            Self::claim_in_state(state, &fallback_key)
        })
    }

    fn claim_in_state(
        state: &mut SkillImprovementState,
        key: &str,
    ) -> Option<ClaimedSkillImprovementJob> {
        let job = state.pending_jobs.get_mut(key)?;
        if job.status.as_deref().unwrap_or("pending") != "pending" {
            return None;
        }
        let now = now_iso();
        job.status = Some("running".to_owned());
        job.started_at = Some(now.clone());
        job.updated_at = now;
        Some(ClaimedSkillImprovementJob {
            key: key.to_owned(),
            job: job.clone(),
        })
    }

    pub fn reschedule_job(
        &self,
        key: &str,
        run_at: String,
        history_message: Option<(&str, usize, String)>,
    ) -> Result<(), String> {
        self.update(|state| {
            if let Some(job) = state.pending_jobs.get_mut(key) {
                job.status = Some("pending".to_owned());
                job.started_at = None;
                job.run_at = run_at;
                job.updated_at = now_iso();
            }
            if let Some((skill_name, usage_count, msg)) = history_message {
                let now = now_iso();
                state.run_history.insert(
                    0,
                    SkillImprovementRunHistoryEntry {
                        id: Uuid::new_v4().to_string(),
                        skill_name: skill_name.to_owned(),
                        status: "skipped".to_owned(),
                        started_at: now.clone(),
                        finished_at: now,
                        message: msg,
                        usage_count,
                        error: None,
                    },
                );
            }
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_job(
        &self,
        key: &str,
        skill_name: &str,
        status: &str,
        started_at: &str,
        finished_at: &str,
        message: &str,
        processed_usage_count: usize,
        processed_transcript_count: usize,
        error: Option<String>,
    ) -> Result<(), String> {
        self.update(|state| {
            state.run_history.insert(
                0,
                SkillImprovementRunHistoryEntry {
                    id: Uuid::new_v4().to_string(),
                    skill_name: skill_name.to_owned(),
                    status: status.to_owned(),
                    started_at: started_at.to_owned(),
                    finished_at: finished_at.to_owned(),
                    message: message.to_owned(),
                    usage_count: processed_usage_count,
                    error,
                },
            );

            if let Some(mut job) = state.pending_jobs.remove(key)
                && job.usage_events.len() > processed_usage_count
            {
                job.usage_events.drain(0..processed_usage_count);
                let drain_t = processed_transcript_count.min(job.transcripts.len());
                job.transcripts.drain(0..drain_t);
                job.status = Some("pending".to_owned());
                job.started_at = None;
                job.updated_at = now_iso();
                state.pending_jobs.insert(key.to_owned(), job);
            }
        })
    }

    pub fn record_history(&self, entry: SkillImprovementRunHistoryEntry) -> Result<(), String> {
        self.update(|state| {
            state.run_history.insert(0, entry);
        })
    }

    pub fn register_backup(&self, backup: SkillImprovementBackupRecord) -> Result<(), String> {
        self.update(|state| {
            state.backups.insert(backup.key.clone(), backup);
        })
    }

    pub fn remove_backup(&self, key: &str) -> Result<(), String> {
        self.update(|state| {
            state.backups.remove(key);
        })
    }
}

// =============================================================================
// Backup & Eligibility Helpers
// =============================================================================

fn sanitize_segment(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "skill".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn backup_key_for_skill(skill_name: &str, source_root_dir: &Path) -> String {
    let digest = hex::encode(Sha256::digest(
        canonicalize_sync(source_root_dir)
            .to_string_lossy()
            .as_bytes(),
    ));
    format!("{}-{}", sanitize_segment(skill_name), &digest[..16])
}

pub fn skill_improvement_write_restriction(
    installation: &SkillInstallationEntry,
) -> Option<String> {
    if installation.plugin.is_some() {
        return Some("Plugin-owned skills are read-only and cannot be improved.".to_owned());
    }
    if !installation.writable && installation.scope != "built-in" {
        return Some("This skill installation is read-only and cannot be improved.".to_owned());
    }
    None
}

fn source_kind_for_installation(installation: &SkillInstallationEntry) -> &'static str {
    if installation.state == "invalid" {
        return "invalid";
    }
    if installation.plugin.is_some() {
        return "plugin";
    }
    if installation.scope == "built-in" {
        return "built-in";
    }
    if let Some(ref origin) = installation.origin
        && origin.kind != "local"
        && origin.kind != "manual"
    {
        return "marketplace";
    }
    "user"
}

fn is_included_by_scope(source_kind: &str, scope: SkillImprovementScope) -> bool {
    match scope {
        SkillImprovementScope::All => source_kind != "invalid",
        SkillImprovementScope::User => source_kind == "user",
    }
}

fn build_eligibility_entries(
    cfg: &AgentConfig,
    state: &SkillImprovementState,
    installations: &[SkillInstallationEntry],
) -> Vec<SkillImprovementEligibility> {
    let scope = cfg.skill_improvement_scope;
    let excluded: BTreeSet<&str> = cfg
        .skill_improvement_excluded_skills
        .iter()
        .map(String::as_str)
        .collect();

    let mut out: Vec<SkillImprovementEligibility> = installations
        .iter()
        .map(|inst| {
            let source_kind = source_kind_for_installation(inst);
            let included = is_included_by_scope(source_kind, scope);
            let is_excluded = excluded.contains(inst.name.as_str());
            let reason = if inst.state == "invalid" {
                Some("Invalid skill installation.".to_owned())
            } else if !inst.enabled {
                Some("Skill is disabled.".to_owned())
            } else if !inst.effective {
                Some("Skill is shadowed by another installation.".to_owned())
            } else if let Some(rest) = skill_improvement_write_restriction(inst) {
                Some(rest)
            } else if is_excluded {
                Some("Excluded in settings.".to_owned())
            } else if !included {
                Some(if source_kind == "user" {
                    "Outside the configured improvement scope.".to_owned()
                } else {
                    "Included only in the all-skills scope.".to_owned()
                })
            } else if inst.skill_path.is_none() {
                Some("Missing SKILL.md.".to_owned())
            } else {
                None
            };
            let eligible = reason.is_none() && included && !is_excluded;
            let skill_path = inst.skill_path.clone().unwrap_or_else(|| {
                Path::new(&inst.root_dir)
                    .join("SKILL.md")
                    .to_string_lossy()
                    .into_owned()
            });
            let has_backup = state.backups.values().any(|b| b.skill_name == inst.name);

            SkillImprovementEligibility {
                skill_name: inst.name.clone(),
                installation_id: inst.installation_id.clone(),
                scope: inst.scope.clone(),
                enabled: inst.enabled,
                effective: inst.effective,
                eligible,
                included,
                excluded: is_excluded,
                writable: inst.writable,
                source_kind: source_kind.to_owned(),
                reason,
                root_dir: inst.root_dir.clone(),
                skill_path,
                has_backup,
                plugin_name: inst.plugin.as_ref().map(|p| p.display_name.clone()),
            }
        })
        .collect();

    out.sort_by(|a, b| a.skill_name.cmp(&b.skill_name));
    out
}

fn prepare_skill_improvement_target(
    cfg: &AgentConfig,
    store: &SkillImprovementJobStore,
    installation: &SkillInstallationEntry,
) -> Result<(SkillImprovementBackupRecord, PathBuf, PathBuf), String> {
    if let Some(restriction) = skill_improvement_write_restriction(installation) {
        return Err(restriction);
    }
    let source_root_dir = canonicalize_sync(Path::new(&installation.root_dir));
    let existing_state = store.read();

    if let Some(shadow_owner) = existing_state.backups.values().find(|b| {
        b.restore_mode == "delete-shadow"
            && b.shadow_root_dir
                .as_deref()
                .is_some_and(|sr| canonicalize_sync(Path::new(sr)) == source_root_dir)
    }) {
        let skill_path = installation
            .skill_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| source_root_dir.join("SKILL.md"));
        return Ok((shadow_owner.clone(), source_root_dir, skill_path));
    }

    let backup_key = backup_key_for_skill(&installation.name, &source_root_dir);
    let backup_root_dir = store.root_dir.join("originals").join(&backup_key);
    let existing_backup = existing_state.backups.get(&backup_key).cloned();

    if existing_backup.is_none() && !backup_root_dir.exists() {
        if let Some(parent) = backup_root_dir.parent() {
            ensure_private_dir_sync(parent).map_err(|e| e.to_string())?;
        }
        copy_dir_confined(&source_root_dir, &backup_root_dir)?;
    }

    let (target_root_dir, target_skill_path, restore_mode, shadow_root_dir) =
        if installation.scope == "built-in" {
            let global_skills_dir = cfg.user_cowork_dir.join("skills");
            let shadow = global_skills_dir.join(&installation.name);
            if !shadow.exists() {
                if let Some(parent) = shadow.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed creating global skills dir: {e}"))?;
                }
                copy_dir_confined(&source_root_dir, &shadow)?;
            }
            let sp = shadow.join("SKILL.md");
            (
                shadow.clone(),
                sp,
                "delete-shadow".to_owned(),
                Some(shadow.to_string_lossy().into_owned()),
            )
        } else {
            let sp = installation
                .skill_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| source_root_dir.join("SKILL.md"));
            (source_root_dir.clone(), sp, "copy-back".to_owned(), None)
        };

    let record = SkillImprovementBackupRecord {
        key: backup_key,
        skill_name: installation.name.clone(),
        source_root_dir: source_root_dir.to_string_lossy().into_owned(),
        backup_root_dir: backup_root_dir.to_string_lossy().into_owned(),
        created_at: existing_backup
            .map(|b| b.created_at)
            .unwrap_or_else(now_iso),
        restore_mode,
        shadow_root_dir,
    };
    store.register_backup(record.clone())?;
    Ok((record, target_root_dir, target_skill_path))
}

fn replace_skill_dir_atomic(src: &Path, dst: &Path) -> Result<(), String> {
    let parent = dst
        .parent()
        .ok_or_else(|| format!("Invalid skill target directory: {}", dst.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed creating parent dir: {e}"))?;
    let staging = parent.join(format!(".skill-restore-stage-{}", Uuid::new_v4().simple()));
    let backup = parent.join(format!(".skill-restore-prev-{}", Uuid::new_v4().simple()));
    copy_dir_confined(src, &staging)?;
    let had_dst = dst.exists();
    if had_dst && let Err(e) = fs::rename(dst, &backup) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed moving previous skill dir aside: {e}"));
    }
    if let Err(e) = fs::rename(&staging, dst) {
        let _ = fs::remove_dir_all(&staging);
        if had_dst {
            let _ = fs::rename(&backup, dst);
        }
        return Err(format!("Failed placing restored skill dir: {e}"));
    }
    if had_dst {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn create_prerun_snapshot(
    store: &SkillImprovementJobStore,
    key: &str,
    target_root_dir: &Path,
) -> Result<PathBuf, String> {
    let prerun_parent = store.root_dir.join("prerun");
    ensure_private_dir_sync(&prerun_parent).map_err(|e| e.to_string())?;
    let snap_dir = prerun_parent.join(format!("{key}-{}", Uuid::new_v4().simple()));
    copy_dir_confined(target_root_dir, &snap_dir)?;
    Ok(snap_dir)
}

fn restore_skill_improvement_backup_record(
    backup: &SkillImprovementBackupRecord,
) -> Result<(), String> {
    if backup.restore_mode == "delete-shadow" {
        if let Some(ref shadow) = backup.shadow_root_dir {
            let p = Path::new(shadow);
            if p.exists() {
                fs::remove_dir_all(p)
                    .map_err(|e| format!("Failed removing shadow skill {}: {e}", p.display()))?;
            }
        }
        return Ok(());
    }

    let backup_root = Path::new(&backup.backup_root_dir);
    if !backup_root.join("SKILL.md").is_file() {
        return Err(format!(
            "Backup for \"{}\" is missing at {}; the skill was left unchanged.",
            backup.skill_name, backup.backup_root_dir
        ));
    }
    replace_skill_dir_atomic(backup_root, Path::new(&backup.source_root_dir))
}

struct ProcessLockGuard {
    lock_path: PathBuf,
}

impl Drop for ProcessLockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.lock_path);
    }
}

pub type LoadConfigFn = Arc<dyn Fn(Option<&Path>) -> Result<AgentConfig, String> + Send + Sync>;
pub type HasBusySessionsFn = Arc<dyn Fn() -> bool + Send + Sync>;
pub type SignalSkillMutationFn = Arc<dyn Fn() + Send + Sync>;
pub type BroadcastSkillStatusFn = Arc<dyn Fn(SkillImprovementStatusEvent) + Send + Sync>;

pub struct SkillImprovementServiceDeps {
    pub cowork_home: PathBuf,
    pub env: std::collections::HashMap<String, String>,
    pub load_config: LoadConfigFn,
    pub has_busy_sessions: HasBusySessionsFn,
    pub signal_skill_mutation: SignalSkillMutationFn,
    pub broadcast_status: Option<BroadcastSkillStatusFn>,
    pub improver: Option<Arc<dyn SkillImproverRunner>>,
}

/// Coordinates skill improvement status, manual/due runs, backups, and restores.
pub struct SkillImprovementService {
    store: SkillImprovementJobStore,
    ext: ExtensionManager,
    load_config: LoadConfigFn,
    has_busy_sessions: HasBusySessionsFn,
    signal_skill_mutation: SignalSkillMutationFn,
    broadcast_status: Option<BroadcastSkillStatusFn>,
    improver: Arc<dyn SkillImproverRunner>,
    run_queue: AsyncMutex<()>,
}

impl SkillImprovementService {
    pub fn new(deps: SkillImprovementServiceDeps) -> Self {
        let store = SkillImprovementJobStore::new(&deps.cowork_home);
        let _ = store.recover_stale_running();
        let default_env = deps.env.clone();
        Self {
            store,
            ext: ExtensionManager::new(deps.env),
            load_config: deps.load_config,
            has_busy_sessions: deps.has_busy_sessions,
            signal_skill_mutation: deps.signal_skill_mutation,
            broadcast_status: deps.broadcast_status,
            improver: deps
                .improver
                .unwrap_or_else(|| Arc::new(ModelBackedSkillImprover::new(default_env))),
            run_queue: AsyncMutex::new(()),
        }
    }

    pub fn store(&self) -> &SkillImprovementJobStore {
        &self.store
    }

    pub fn record_completed_turn_usage(
        &self,
        completed: CompletedTurnSkillUsage,
    ) -> Result<(), String> {
        let cfg = (self.load_config)(Some(Path::new(&completed.working_directory)))?;
        if !cfg.skill_improvement_enabled || completed.usages.is_empty() {
            return Ok(());
        }
        self.store.enqueue_completed_turn(completed)
    }

    pub fn get_status(
        &self,
        session_id: Option<String>,
        cwd: Option<&Path>,
    ) -> Result<SkillImprovementStatusEvent, String> {
        let cfg = (self.load_config)(cwd)?;
        let state = self.store.read();
        let scope_str = match cfg.skill_improvement_scope {
            SkillImprovementScope::User => "user".to_owned(),
            SkillImprovementScope::All => "all".to_owned(),
        };
        let mut excluded: Vec<String> = cfg
            .skill_improvement_excluded_skills
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        excluded.sort();

        let installations = self.ext.collect_skill_installations(&cfg);
        let skills = build_eligibility_entries(&cfg, &state, &installations);
        let busy = (self.has_busy_sessions)();

        let mut pending_jobs: Vec<SkillImprovementPendingJobSummary> = state
            .pending_jobs
            .iter()
            .map(|(key, job)| {
                let sources: Vec<String> = job
                    .usage_events
                    .iter()
                    .map(|e| e.source.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let kinds: Vec<String> = job
                    .usage_events
                    .iter()
                    .map(|e| e.kind.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                SkillImprovementPendingJobSummary {
                    key: key.clone(),
                    skill_name: job.skill_name.clone(),
                    run_at: job.run_at.clone(),
                    last_usage_at: job.last_usage_at.clone(),
                    usage_count: job.usage_events.len(),
                    status: job.status.clone().unwrap_or_else(|| "pending".to_owned()),
                    sources,
                    kinds,
                }
            })
            .collect();
        pending_jobs.sort_by(|a, b| a.run_at.cmp(&b.run_at));

        let mut backups: Vec<SkillImprovementBackupRecord> =
            state.backups.values().cloned().collect();
        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(SkillImprovementStatusEvent {
            event_type: "skill_improvement_status".to_owned(),
            session_id,
            enabled: cfg.skill_improvement_enabled,
            model: cfg.skill_improvement_model.clone(),
            scope: scope_str,
            excluded_skills: excluded,
            busy,
            block_reason: busy
                .then(|| "Skill improvement is paused while a session is running.".to_owned()),
            pending_jobs,
            run_history: state.run_history,
            backups,
            skills,
        })
    }

    pub async fn run_due_job(&self) -> Result<(), String> {
        let _guard = self.run_queue.lock().await;
        let cfg = (self.load_config)(None)?;
        if !cfg.skill_improvement_enabled {
            return Ok(());
        }
        let Some(claimed) = self.store.claim_due_job()? else {
            return Ok(());
        };
        let outcome = self.run_claimed_job(claimed, false).await?;
        if outcome == "done" {
            self.broadcast_status_safe(None);
        }
        Ok(())
    }

    pub async fn run_now(
        &self,
        skill_name: Option<&str>,
        cwd: Option<&Path>,
    ) -> Result<(), String> {
        let _guard = self.run_queue.lock().await;
        let cfg = (self.load_config)(cwd)?;
        if !cfg.skill_improvement_enabled {
            return Ok(());
        }
        let res = if let Some(name) = skill_name.map(str::trim).filter(|s| !s.is_empty()) {
            self.run_named_skill_now(name, cwd).await
        } else {
            loop {
                let state = self.store.read();
                let next_key = state
                    .pending_jobs
                    .iter()
                    .filter(|(_, j)| j.status.as_deref().unwrap_or("pending") == "pending")
                    .min_by(|(_, a), (_, b)| a.run_at.cmp(&b.run_at))
                    .map(|(k, _)| k.clone());
                let Some(key) = next_key else {
                    break Ok(());
                };
                let Some(claimed) = self.store.claim_job_by_key(&key)? else {
                    break Ok(());
                };
                let outcome = self.run_claimed_job(claimed, true).await?;
                if outcome == "rescheduled" {
                    break Ok(());
                }
            }
        };
        self.broadcast_status_safe(cwd);
        res
    }

    async fn run_named_skill_now(
        &self,
        skill_name: &str,
        cwd: Option<&Path>,
    ) -> Result<(), String> {
        let state = self.store.read();
        if let Some(running) = state.pending_jobs.values().find(|j| {
            j.skill_name.trim() == skill_name.trim()
                && j.status.as_deref().unwrap_or("pending") == "running"
        }) {
            let now = now_iso();
            self.store.record_history(SkillImprovementRunHistoryEntry {
                id: Uuid::new_v4().to_string(),
                skill_name: skill_name.to_owned(),
                status: "skipped".to_owned(),
                started_at: now.clone(),
                finished_at: now,
                message: "An improvement run for this skill is already in progress.".to_owned(),
                usage_count: running.usage_events.len(),
                error: None,
            })?;
            return Ok(());
        }

        let cwd_str = cwd.map(|p| p.to_string_lossy().into_owned());
        let Some(claimed) = self.store.claim_job(skill_name, cwd_str.as_deref())? else {
            let now = now_iso();
            self.store.record_history(SkillImprovementRunHistoryEntry {
                id: Uuid::new_v4().to_string(),
                skill_name: skill_name.to_owned(),
                status: "skipped".to_owned(),
                started_at: now.clone(),
                finished_at: now,
                message: "No recorded usage evidence for this skill yet; use it in a turn first."
                    .to_owned(),
                usage_count: 0,
                error: None,
            })?;
            return Ok(());
        };
        let _ = self.run_claimed_job(claimed, true).await?;
        Ok(())
    }

    pub async fn restore(&self, skill_name: &str, cwd: Option<&Path>) -> Result<(), String> {
        {
            let _guard = self.run_queue.lock().await;
            if (self.has_busy_sessions)() {
                return Err(
                    "Cannot restore a skill while a session is running. Try again when the workspace is idle."
                        .to_owned(),
                );
            }
            let _proc_lock = self
                .acquire_process_lock(&format!("restore:{skill_name}"))?
                .ok_or_else(|| {
                    "Skill improvement is busy in another process. Try again in a moment."
                        .to_owned()
                })?;

            let state = self.store.read();
            let mut backups: Vec<SkillImprovementBackupRecord> = state
                .backups
                .values()
                .filter(|b| b.skill_name == skill_name)
                .cloned()
                .collect();
            backups.sort_by(
                |a, b| match (a.restore_mode.as_str(), b.restore_mode.as_str()) {
                    ("copy-back", "delete-shadow") => std::cmp::Ordering::Less,
                    ("delete-shadow", "copy-back") => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                },
            );
            if backups.is_empty() {
                return Err(format!(
                    "No skill improvement backup found for \"{skill_name}\"."
                ));
            }

            for backup in backups {
                restore_skill_improvement_backup_record(&backup)?;
                let orig_dir = Path::new(&backup.backup_root_dir);
                if orig_dir.exists() {
                    let _ = fs::remove_dir_all(orig_dir);
                }
                let meta_sidecar = self
                    .store
                    .root_dir
                    .join("originals")
                    .join(format!("{}.meta.json", backup.key));
                let _ = fs::remove_file(meta_sidecar);
                self.store.remove_backup(&backup.key)?;
            }
            (self.signal_skill_mutation)();
        }
        self.broadcast_status_safe(cwd);
        Ok(())
    }

    async fn run_claimed_job(
        &self,
        claimed: ClaimedSkillImprovementJob,
        manual: bool,
    ) -> Result<&'static str, String> {
        let key = claimed.key;
        let job = claimed.job;
        let started_at = job.started_at.clone().unwrap_or_else(now_iso);
        let usage_count = job.usage_events.len();
        let transcript_count = job.transcripts.len();

        let reschedule_at = (Utc::now()
            + ChronoDuration::seconds(SKILL_IMPROVEMENT_RESCHEDULE_BUSY_SECS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        if (self.has_busy_sessions)() {
            let hist = manual.then(|| {
                (
                    job.skill_name.as_str(),
                    usage_count,
                    "Skill improvement paused while a session is running.".to_owned(),
                )
            });
            self.store.reschedule_job(&key, reschedule_at, hist)?;
            return Ok("rescheduled");
        }

        let Some(_proc_lock) = self.acquire_process_lock(&job.skill_name)? else {
            let hist = manual.then(|| {
                (
                    job.skill_name.as_str(),
                    usage_count,
                    "Skill improvement skipped because another process holds the lock.".to_owned(),
                )
            });
            self.store.reschedule_job(&key, reschedule_at, hist)?;
            return Ok("rescheduled");
        };

        let job_cwd = job.working_directory.as_deref().map(Path::new).or_else(|| {
            job.usage_events
                .last()
                .map(|u| Path::new(u.working_directory.as_str()))
        });
        let cfg = (self.load_config)(job_cwd)?;
        let installations = self.ext.collect_skill_installations(&cfg);
        let state = self.store.read();
        let eligibility_list = build_eligibility_entries(&cfg, &state, &installations);

        let latest_usage_path = job
            .usage_events
            .iter()
            .rev()
            .find_map(|u| u.skill_path.as_deref());
        let installation = latest_usage_path
            .and_then(|sp| {
                installations
                    .iter()
                    .find(|i| i.effective && i.skill_path.as_deref() == Some(sp))
            })
            .or_else(|| {
                installations
                    .iter()
                    .find(|i| i.effective && i.name == job.skill_name)
            });
        let target_elig = installation.and_then(|inst| {
            eligibility_list
                .iter()
                .find(|e| e.installation_id == inst.installation_id)
        });

        let (Some(inst), Some(elig)) = (installation, target_elig) else {
            self.store.finish_job(
                &key,
                &job.skill_name,
                "skipped",
                &started_at,
                &now_iso(),
                "Skill is not eligible for improvement.",
                usage_count,
                transcript_count,
                None,
            )?;
            return Ok("done");
        };
        if !elig.eligible || inst.skill_path.is_none() {
            let msg = elig
                .reason
                .as_deref()
                .unwrap_or("Skill is not eligible for improvement.");
            self.store.finish_job(
                &key,
                &job.skill_name,
                "skipped",
                &started_at,
                &now_iso(),
                msg,
                usage_count,
                transcript_count,
                None,
            )?;
            return Ok("done");
        }

        let (backup, target_root_dir, target_skill_path) =
            match prepare_skill_improvement_target(&cfg, &self.store, inst) {
                Ok(t) => t,
                Err(err) => {
                    self.store.finish_job(
                        &key,
                        &job.skill_name,
                        "failed",
                        &started_at,
                        &now_iso(),
                        &format!("Skill improvement failed: {err}"),
                        usage_count,
                        transcript_count,
                        Some(err),
                    )?;
                    return Ok("done");
                }
            };

        let snapshot_dir = match create_prerun_snapshot(&self.store, &backup.key, &target_root_dir)
        {
            Ok(d) => d,
            Err(err) => {
                self.store.finish_job(
                    &key,
                    &job.skill_name,
                    "failed",
                    &started_at,
                    &now_iso(),
                    &format!("Skill improvement failed: {err}"),
                    usage_count,
                    transcript_count,
                    Some(err),
                )?;
                return Ok("done");
            }
        };

        let all_skills = discover_skills_for_config(&cfg).into_values().collect();
        let run_res = self
            .improver
            .run(
                &cfg,
                SkillImproverRunInput {
                    skill_name: job.skill_name.clone(),
                    skill_root_dir: target_root_dir.clone(),
                    skill_path: target_skill_path.clone(),
                    source_kind: elig.source_kind.clone(),
                    usage_events: job.usage_events,
                    transcripts: job.transcripts,
                    all_skills,
                },
            )
            .await;

        // Post-validate SKILL.md frontmatter if the runner reported ok.
        let validated_res = if run_res.ok {
            if let Err(fm_err) =
                validate_improved_skill_frontmatter(&target_skill_path, &job.skill_name)
            {
                SkillImproverRunResult {
                    ok: false,
                    changed: true,
                    message: "Skill improvement produced invalid frontmatter.".to_owned(),
                    error: Some(fm_err),
                }
            } else {
                run_res
            }
        } else {
            run_res
        };

        if !validated_res.ok {
            let rollback_err = replace_skill_dir_atomic(&snapshot_dir, &target_root_dir).err();
            if rollback_err.is_none() {
                let _ = fs::remove_dir_all(&snapshot_dir);
            }
            let final_msg = match rollback_err {
                Some(ref r_err) => format!(
                    "{} Rollback also failed: {r_err}. The pre-run recovery copy was kept at {}.",
                    validated_res.message,
                    snapshot_dir.display()
                ),
                None => validated_res.message,
            };
            self.store.finish_job(
                &key,
                &job.skill_name,
                "failed",
                &started_at,
                &now_iso(),
                &final_msg,
                usage_count,
                transcript_count,
                validated_res.error,
            )?;
            return Ok("done");
        }

        let _ = fs::remove_dir_all(&snapshot_dir);
        self.store.finish_job(
            &key,
            &job.skill_name,
            if validated_res.changed {
                "completed"
            } else {
                "skipped"
            },
            &started_at,
            &now_iso(),
            &validated_res.message,
            usage_count,
            transcript_count,
            None,
        )?;
        if validated_res.changed {
            (self.signal_skill_mutation)();
        }
        Ok("done")
    }

    fn acquire_process_lock(&self, label: &str) -> Result<Option<ProcessLockGuard>, String> {
        ensure_private_dir_sync(&self.store.root_dir).map_err(|e| e.to_string())?;
        let lock_path = self.store.root_dir.join("skill-improvement.lock");
        for _attempt in 0..2 {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut f) => {
                    let payload = serde_json::json!({
                        "pid": std::process::id(),
                        "label": label,
                        "startedAt": now_iso(),
                    });
                    let _ = f.write_all(payload.to_string().as_bytes());
                    return Ok(Some(ProcessLockGuard { lock_path }));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if !self.is_process_lock_stale(&lock_path) {
                        return Ok(None);
                    }
                    let _ = fs::remove_file(&lock_path);
                }
                Err(e) => return Err(format!("Failed acquiring skill-improvement.lock: {e}")),
            }
        }
        Ok(None)
    }

    fn is_process_lock_stale(&self, lock_path: &Path) -> bool {
        let mut started_ms: Option<i64> = None;
        let mut pid: Option<u32> = None;
        if let Ok(raw) = fs::read_to_string(lock_path)
            && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
        {
            started_ms = val
                .get("startedAt")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_iso_ms);
            pid = val
                .get("pid")
                .and_then(serde_json::Value::as_u64)
                .and_then(|n| u32::try_from(n).ok());
        }
        if pid == Some(std::process::id()) {
            return true;
        }
        if let Some(p) = pid
            && !process_alive(p)
        {
            return true;
        }
        let now_ms = Utc::now().timestamp_millis();
        match started_ms {
            Some(ms) => now_ms - ms >= SKILL_IMPROVEMENT_STALE_LOCK_SECS * 1000,
            None => true,
        }
    }

    fn broadcast_status_safe(&self, cwd: Option<&Path>) {
        if let Some(ref bcast) = self.broadcast_status
            && let Ok(evt) = self.get_status(Some("skill-improvement".to_owned()), cwd)
        {
            bcast(evt);
        }
    }
}
