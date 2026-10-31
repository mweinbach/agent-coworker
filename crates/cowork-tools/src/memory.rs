use std::fs;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::Utc;
use cowork_storage::{
    FileLockOptions, HOT_MEMORY_ID, MemoryScope, MemoryWriteMode, normalize_stored_memory_id,
    with_file_lock_sync,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};
use crate::interactive::split_yaml_frontmatter;

const MAX_MEMORY_ENTRIES_PER_DIR: usize = 200;

pub struct MemoryTool;

#[async_trait]
impl BuiltinTool for MemoryTool {
    fn name(&self) -> &str {
        "memory"
    }

    fn description(&self) -> &str {
        "Read, write, search, or delete persistent SQLite memory entries across workspace and global scopes."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "write", "search", "delete"],
                    "description": "Operation to perform."
                },
                "key": {
                    "type": "string",
                    "description": "Memory key (defaults to 'AGENT.md' for read; required for write/delete)."
                },
                "content": {
                    "type": "string",
                    "description": "Content to store when action is 'write'."
                },
                "query": {
                    "type": "string",
                    "description": "Search query when action is 'search'."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "global", "both"],
                    "description": "Memory scope (default: workspace for write/delete, both for search)."
                }
            },
            "required": ["action"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let store = ctx.memory_store.as_ref().ok_or_else(|| {
            ToolError::Execution("MemoryStore is not configured for this session.".to_owned())
        })?;
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("action is required".to_owned()))?;
        let scope_str = args.get("scope").and_then(Value::as_str);

        let parse_single_scope = |default_scope: MemoryScope| -> MemoryScope {
            match scope_str {
                Some("global") | Some("user") => MemoryScope::User,
                Some("workspace") => MemoryScope::Workspace,
                _ => default_scope,
            }
        };

        match action {
            "read" => {
                let key = args
                    .get("key")
                    .and_then(Value::as_str)
                    .unwrap_or("AGENT.md");
                let normalized_id = normalize_stored_memory_id(key);
                let scope = parse_single_scope(MemoryScope::Workspace);
                let entries = store
                    .list(Some(scope))
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                if let Some(found) = entries.into_iter().find(|e| e.id == normalized_id) {
                    Ok(ToolOutput::Text(found.content))
                } else {
                    Ok(ToolOutput::Text(format!(
                        "No memory entry found for key '{key}'."
                    )))
                }
            }
            "write" => {
                if ctx.read_only_role {
                    return Err(ToolError::PathDenied(
                        "Memory writes are disabled in read-only sessions.".to_owned(),
                    ));
                }
                let key = args
                    .get("key")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ToolError::InvalidArguments("key is required for memory write".to_owned())
                    })?;
                let content = args.get("content").and_then(Value::as_str).ok_or_else(|| {
                    ToolError::InvalidArguments("content is required for memory write".to_owned())
                })?;
                let scope = parse_single_scope(MemoryScope::Workspace);
                let entry = store
                    .upsert(scope, Some(key), content, MemoryWriteMode::Upsert)
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let tier = if entry.id == HOT_MEMORY_ID {
                    "hot"
                } else {
                    "cold"
                };
                Ok(ToolOutput::Json(json!({
                    "ok": true,
                    "scope": scope,
                    "key": entry.id,
                    "tier": tier,
                    "updatedAt": entry.updated_at,
                })))
            }
            "search" => {
                let query = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let filter_scope = match scope_str {
                    Some("workspace") => Some(MemoryScope::Workspace),
                    Some("global") | Some("user") => Some(MemoryScope::User),
                    _ => None,
                };
                let matches = store
                    .search(query, filter_scope)
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                if matches.is_empty() {
                    return Ok(ToolOutput::Text("No matching memory entries.".to_owned()));
                }
                let lines: Vec<String> = matches
                    .into_iter()
                    .map(|m| {
                        let scope_label = match m.scope {
                            MemoryScope::Workspace => "workspace",
                            MemoryScope::User => "global",
                        };
                        let tier_label = if m.id == HOT_MEMORY_ID { "hot" } else { "cold" };
                        format!("[{scope_label}] {tier_label}: {} — {}", m.id, m.content)
                    })
                    .collect();
                Ok(ToolOutput::Text(lines.join("\n")))
            }
            "delete" => {
                if ctx.read_only_role {
                    return Err(ToolError::PathDenied(
                        "Memory deletes are disabled in read-only sessions.".to_owned(),
                    ));
                }
                let key = args
                    .get("key")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ToolError::InvalidArguments("key is required for memory delete".to_owned())
                    })?;
                let scope = parse_single_scope(MemoryScope::Workspace);
                let deleted = store
                    .remove(scope, key)
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolOutput::Json(json!({
                    "ok": true,
                    "deleted": deleted,
                    "key": key,
                    "scope": scope,
                })))
            }
            other => Err(ToolError::InvalidArguments(format!(
                "Unsupported memory action '{other}'"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedMemoryEntry {
    pub slug: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub memory_type: String,
    pub scope: String,
    pub body: String,
    pub updated_at: String,
}

#[derive(Debug, Default, Deserialize)]
struct AdvancedFrontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(rename = "type")]
    memory_type: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AdvancedMemoryStore {
    cowork_home: PathBuf,
    working_directory: PathBuf,
    default_chats_dir: PathBuf,
}

impl AdvancedMemoryStore {
    pub fn new(
        cowork_home: PathBuf,
        working_directory: PathBuf,
        default_chats_dir: PathBuf,
    ) -> Self {
        Self {
            cowork_home,
            working_directory,
            default_chats_dir,
        }
    }

    pub fn memories_base_dir(&self) -> PathBuf {
        self.cowork_home.join("memories")
    }

    pub fn folder_key_for_workspace(working_directory: &Path, default_chats_dir: &Path) -> String {
        if working_directory == default_chats_dir {
            return "_general".to_owned();
        }
        let leaf = working_directory
            .file_name()
            .map(|n| slugify(&n.to_string_lossy()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "workspace".to_owned());
        let mut hasher = Sha256::new();
        hasher.update(working_directory.to_string_lossy().as_bytes());
        let short_hash = &hex::encode(hasher.finalize())[..8];
        format!("{leaf}-{short_hash}")
    }

    pub fn workspace_folder_key(&self) -> String {
        Self::folder_key_for_workspace(&self.working_directory, &self.default_chats_dir)
    }

    pub fn resolve_scope_dir(
        &self,
        scope: &str,
        explicit_folder: Option<&str>,
    ) -> ToolResult<PathBuf> {
        let base = self.memories_base_dir();
        if let Some(folder) = explicit_folder {
            let clean = sanitize_folder_key(folder)?;
            return Ok(base.join(clean));
        }
        match scope {
            "global" => Ok(base.join("_global")),
            "general" => Ok(base.join("_general")),
            _ => Ok(base.join(self.workspace_folder_key())),
        }
    }

    fn with_dir_lock<F, R>(&self, dir: &Path, op: F) -> ToolResult<R>
    where
        F: FnOnce() -> ToolResult<R>,
    {
        let lock_root = self.cowork_home.join("locks").join("files");
        fs::create_dir_all(&lock_root)
            .map_err(|e| ToolError::Execution(format!("Failed to create memory lock dir: {e}")))?;
        with_file_lock_sync(
            dir,
            op,
            FileLockOptions {
                acquire_timeout_ms: Some(10_000),
                retry_delay_ms: Some(10),
                lock_root: Some(lock_root),
            },
        )
    }

    pub fn list_entries_in_dir(
        &self,
        dir: &Path,
        scope_label: &str,
    ) -> ToolResult<Vec<AdvancedMemoryEntry>> {
        let Ok(rd) = fs::read_dir(dir) else {
            return Ok(Vec::new());
        };
        let mut entries = Vec::new();
        for item in rd.flatten() {
            let p = item.path();
            if !p.is_file() {
                continue;
            }
            let Some(fname) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if fname == "MEMORY.md" || !fname.ends_with(".md") {
                continue;
            }
            let slug = fname.trim_end_matches(".md").to_owned();
            if let Ok(raw) = fs::read_to_string(&p) {
                entries.push(parse_advanced_entry(&slug, scope_label, &raw));
            }
        }
        entries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        Ok(entries)
    }

    pub fn list_folders(&self) -> ToolResult<Vec<String>> {
        let base = self.memories_base_dir();
        let Ok(rd) = fs::read_dir(&base) else {
            return Ok(Vec::new());
        };
        let mut folders = Vec::new();
        for item in rd.flatten() {
            let p = item.path();
            if !p.is_dir() {
                continue;
            }
            folders.push(item.file_name().to_string_lossy().into_owned());
        }
        folders.sort();
        Ok(folders)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_entry(
        &self,
        scope: &str,
        explicit_folder: Option<&str>,
        slug_or_name: &str,
        name: &str,
        description: &str,
        memory_type: &str,
        body: &str,
    ) -> ToolResult<AdvancedMemoryEntry> {
        let dir = self.resolve_scope_dir(scope, explicit_folder)?;
        let slug = slugify(slug_or_name);
        if slug.is_empty() || slug.eq_ignore_ascii_case("memory") {
            return Err(ToolError::InvalidArguments(
                "Invalid memory name/slug.".to_owned(),
            ));
        }

        self.with_dir_lock(&dir, || {
            fs::create_dir_all(&dir).map_err(|e| {
                ToolError::Execution(format!("Failed to create memory dir '{}': {e}", dir.display()))
            })?;
            let existing = self.list_entries_in_dir(&dir, scope)?;
            let is_update = existing.iter().any(|e| e.slug == slug);
            if !is_update && existing.len() >= MAX_MEMORY_ENTRIES_PER_DIR {
                return Err(ToolError::Execution(format!(
                    "Memory folder reached maximum of {MAX_MEMORY_ENTRIES_PER_DIR} entries; consolidate or delete stale memories first."
                )));
            }

            let now = Utc::now().to_rfc3339();
            let entry = AdvancedMemoryEntry {
                slug: slug.clone(),
                name: name.trim().to_owned(),
                description: description.trim().to_owned(),
                memory_type: memory_type.trim().to_owned(),
                scope: scope.to_owned(),
                body: body.trim().to_owned(),
                updated_at: now.clone(),
            };
            let serialized = format!(
                "---\nname: {}\ndescription: {}\ntype: {}\nupdated_at: {}\n---\n\n{}\n",
                yaml_quote(&entry.name),
                yaml_quote(&entry.description),
                yaml_quote(&entry.memory_type),
                yaml_quote(&entry.updated_at),
                entry.body
            );
            let target = dir.join(format!("{slug}.md"));
            fs::write(&target, serialized).map_err(|e| {
                ToolError::Execution(format!("Failed to write '{}': {e}", target.display()))
            })?;
            self.rebuild_index_locked(&dir, scope)?;
            Ok(entry)
        })
    }

    pub fn delete_entry(
        &self,
        scope: &str,
        explicit_folder: Option<&str>,
        slug_or_name: &str,
    ) -> ToolResult<bool> {
        let dir = self.resolve_scope_dir(scope, explicit_folder)?;
        let slug = slugify(slug_or_name);
        self.with_dir_lock(&dir, || {
            let target = dir.join(format!("{slug}.md"));
            if !target.exists() {
                return Ok(false);
            }
            fs::remove_file(&target)
                .map_err(|e| ToolError::Execution(format!("Failed to delete memory: {e}")))?;
            self.rebuild_index_locked(&dir, scope)?;
            Ok(true)
        })
    }

    pub fn rename_folder(&self, from_folder: &str, to_folder: &str) -> ToolResult<()> {
        let from_clean = sanitize_folder_key(from_folder)?;
        let to_clean = sanitize_folder_key(to_folder)?;
        let base = self.memories_base_dir();
        let src = base.join(from_clean);
        let dst = base.join(to_clean);
        if !src.exists() {
            return Err(ToolError::Execution(format!(
                "Memory folder '{from_folder}' does not exist."
            )));
        }
        fs::rename(src, dst)
            .map_err(|e| ToolError::Execution(format!("Failed to rename memory folder: {e}")))
    }

    pub fn delete_folder(&self, folder: &str) -> ToolResult<bool> {
        let clean = sanitize_folder_key(folder)?;
        let target = self.memories_base_dir().join(clean);
        if !target.exists() {
            return Ok(false);
        }
        fs::remove_dir_all(target)
            .map_err(|e| ToolError::Execution(format!("Failed to delete memory folder: {e}")))?;
        Ok(true)
    }

    pub fn read_index_summary(&self) -> String {
        let mut sections = Vec::new();
        for (label, dir) in [
            ("Global Memories", self.memories_base_dir().join("_global")),
            (
                "Workspace Memories",
                self.memories_base_dir().join(self.workspace_folder_key()),
            ),
        ] {
            let idx_path = dir.join("MEMORY.md");
            if let Ok(content) = fs::read_to_string(idx_path) {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    sections.push(format!("### {label}\n{trimmed}"));
                }
            }
        }
        sections.join("\n\n")
    }

    fn rebuild_index_locked(&self, dir: &Path, scope_label: &str) -> ToolResult<()> {
        let entries = self.list_entries_in_dir(dir, scope_label)?;
        let mut lines = Vec::with_capacity(entries.len() + 2);
        lines.push("# Memory Index".to_owned());
        lines.push(String::new());
        for e in entries {
            lines.push(format!(
                "- **{}** (`{}` [{}]): {}",
                e.name, e.slug, e.memory_type, e.description
            ));
        }
        fs::write(dir.join("MEMORY.md"), lines.join("\n") + "\n")
            .map_err(|e| ToolError::Execution(format!("Failed to update MEMORY.md: {e}")))
    }
}

fn yaml_quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

fn sanitize_folder_key(raw: &str) -> ToolResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(ToolError::InvalidArguments(format!(
            "Invalid memory folder name '{raw}'."
        )));
    }
    Ok(trimmed.to_owned())
}

pub fn slugify(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').chars().take(64).collect()
}

fn parse_advanced_entry(slug: &str, scope: &str, raw: &str) -> AdvancedMemoryEntry {
    let (yaml_opt, body) = split_yaml_frontmatter(raw);
    let fm: AdvancedFrontmatter = yaml_opt
        .as_deref()
        .and_then(|y| serde_saphyr::from_str(y).ok())
        .unwrap_or_default();
    AdvancedMemoryEntry {
        slug: slug.to_owned(),
        name: fm.name.unwrap_or_else(|| slug.to_owned()),
        description: fm.description.unwrap_or_default(),
        memory_type: fm.memory_type.unwrap_or_else(|| "project".to_owned()),
        scope: scope.to_owned(),
        body: body.trim().to_owned(),
        updated_at: fm.updated_at.unwrap_or_default(),
    }
}

pub struct RecallMemoryTool;

#[async_trait]
impl BuiltinTool for RecallMemoryTool {
    fn name(&self) -> &str {
        "recallMemory"
    }

    fn description(&self) -> &str {
        "Read or search Markdown memories in the advanced memory store by name, slug, or keyword query."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Exact memory name or slug to read."
                },
                "query": {
                    "type": "string",
                    "description": "Optional search keyword across workspace and global memories."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "global", "both"]
                }
            }
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let store = ctx.advanced_memory_store.clone().unwrap_or_else(|| {
            std::sync::Arc::new(AdvancedMemoryStore::new(
                ctx.cowork_home.clone(),
                ctx.working_directory.clone(),
                ctx.cowork_home.join("workspaces").join("chats"),
            ))
        });

        let scope = args.get("scope").and_then(Value::as_str).unwrap_or("both");
        let mut all_entries = Vec::new();
        if scope == "workspace" || scope == "both" {
            let dir = store.resolve_scope_dir("workspace", None)?;
            all_entries.extend(store.list_entries_in_dir(&dir, "workspace")?);
        }
        if scope == "global" || scope == "both" {
            let dir = store.resolve_scope_dir("global", None)?;
            all_entries.extend(store.list_entries_in_dir(&dir, "global")?);
        }

        if let Some(target_name) = args.get("name").and_then(Value::as_str) {
            let target_slug = slugify(target_name);
            if let Some(found) = all_entries
                .into_iter()
                .find(|e| e.slug == target_slug || e.name.eq_ignore_ascii_case(target_name.trim()))
            {
                return Ok(ToolOutput::Text(format!(
                    "# {} ({}, scope={})\n{}\n\n{}",
                    found.name, found.memory_type, found.scope, found.description, found.body
                )));
            }
            return Ok(ToolOutput::Text(format!(
                "No memory entry named '{target_name}' found."
            )));
        }

        let q = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let filtered: Vec<AdvancedMemoryEntry> = all_entries
            .into_iter()
            .filter(|e| {
                q.is_empty()
                    || e.name.to_ascii_lowercase().contains(&q)
                    || e.description.to_ascii_lowercase().contains(&q)
                    || e.body.to_ascii_lowercase().contains(&q)
            })
            .collect();
        if filtered.is_empty() {
            return Ok(ToolOutput::Text("No matching memories found.".to_owned()));
        }
        let formatted: Vec<String> = filtered
            .into_iter()
            .map(|e| {
                format!(
                    "- [{}] {} (`{}`): {}\n  {}",
                    e.scope, e.name, e.slug, e.description, e.body
                )
            })
            .collect();
        Ok(ToolOutput::Text(formatted.join("\n\n")))
    }
}

pub struct ManageMemoryTool;

#[async_trait]
impl BuiltinTool for ManageMemoryTool {
    fn name(&self) -> &str {
        "manageMemory"
    }

    fn description(&self) -> &str {
        "Create, update, or delete structured Markdown memories in workspace or global scope."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "update", "delete"]
                },
                "name": {
                    "type": "string",
                    "description": "Memory title or slug."
                },
                "description": {
                    "type": "string",
                    "description": "Concise 1-line summary shown in MEMORY.md."
                },
                "type": {
                    "type": "string",
                    "enum": ["user", "feedback", "project", "reference"]
                },
                "body": {
                    "type": "string",
                    "description": "Markdown body content."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "global"]
                }
            },
            "required": ["action", "name"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "manageMemory is disabled in read-only sessions.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let store = ctx.advanced_memory_store.clone().unwrap_or_else(|| {
            std::sync::Arc::new(AdvancedMemoryStore::new(
                ctx.cowork_home.clone(),
                ctx.working_directory.clone(),
                ctx.cowork_home.join("workspaces").join("chats"),
            ))
        });

        let action = args
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("action is required".to_owned()))?;
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("name is required".to_owned()))?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("workspace");

        match action {
            "create" | "update" => {
                let description = args
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or(name);
                let mem_type = args
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("project");
                let body = args.get("body").and_then(Value::as_str).ok_or_else(|| {
                    ToolError::InvalidArguments("body is required for create/update".to_owned())
                })?;
                let saved =
                    store.upsert_entry(scope, None, name, name, description, mem_type, body)?;
                Ok(ToolOutput::Json(json!({
                    "ok": true,
                    "action": action,
                    "entry": saved,
                })))
            }
            "delete" => {
                let deleted = store.delete_entry(scope, None, name)?;
                Ok(ToolOutput::Json(json!({
                    "ok": true,
                    "deleted": deleted,
                    "slug": slugify(name),
                    "scope": scope,
                })))
            }
            other => Err(ToolError::InvalidArguments(format!(
                "Unsupported manageMemory action '{other}'"
            ))),
        }
    }
}

pub struct ReadPastConversationTool;

#[async_trait]
impl BuiltinTool for ReadPastConversationTool {
    fn name(&self) -> &str {
        "readPastConversation"
    }

    fn description(&self) -> &str {
        "List or inspect past conversation transcripts from the current workspace stored in SessionDb."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "list": {
                    "type": "boolean",
                    "description": "When true, list recent past conversations in this workspace."
                },
                "sessionId": {
                    "type": "string",
                    "description": "Specific past session ID to read."
                },
                "maxTurns": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "Maximum messages to return when reading a session (default: 30)."
                }
            }
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let db = ctx.session_db.as_ref().ok_or_else(|| {
            ToolError::Execution("SessionDb is not attached to this tool context.".to_owned())
        })?;
        let ws_str = ctx.working_directory.to_string_lossy().into_owned();

        if let Some(session_id) = args.get("sessionId").and_then(Value::as_str) {
            if session_id == ctx.session_id {
                return Err(ToolError::InvalidArguments(
                    "Cannot read the currently active session as a past conversation.".to_owned(),
                ));
            }
            let detail = db
                .get_session_record(session_id)
                .map_err(|e| ToolError::Execution(e.to_string()))?
                .ok_or_else(|| {
                    ToolError::Execution(format!("Past session '{session_id}' not found."))
                })?;
            if detail.working_directory != ws_str {
                return Err(ToolError::PathDenied(
                    "Access denied: requested session belongs to a different workspace.".to_owned(),
                ));
            }
            let max_turns = args.get("maxTurns").and_then(Value::as_u64).unwrap_or(30) as usize;
            let mut lines = vec![format!(
                "# {} ({})\nUpdated: {}",
                detail.title, detail.session_id, detail.updated_at
            )];
            for msg in detail.messages.iter().take(max_turns) {
                let role = msg.get("role").and_then(Value::as_str).unwrap_or("unknown");
                let text = extract_message_text_preview(msg);
                if !text.is_empty() {
                    lines.push(format!("[{role}] {text}"));
                }
            }
            return Ok(ToolOutput::Text(lines.join("\n\n")));
        }

        let sessions = db
            .list_sessions(Some(&ws_str))
            .map_err(|e| ToolError::Execution(e.to_string()))?;

        let past: Vec<String> = sessions
            .into_iter()
            .filter(|s| s.session_id != ctx.session_id)
            .take(25)
            .map(|s| {
                format!(
                    "- `{}` — **{}** (updated {}, {} messages)",
                    s.session_id, s.title, s.updated_at, s.message_count
                )
            })
            .collect();
        if past.is_empty() {
            Ok(ToolOutput::Text(
                "No past conversations found in this workspace.".to_owned(),
            ))
        } else {
            Ok(ToolOutput::Text(past.join("\n")))
        }
    }
}

fn extract_message_text_preview(msg: &Value) -> String {
    if let Some(s) = msg.get("content").and_then(Value::as_str) {
        return s.to_owned();
    }
    if let Some(arr) = msg.get("content").and_then(Value::as_array) {
        let parts: Vec<&str> = arr
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect();
        return parts.join("\n");
    }
    String::new()
}
