use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::error::{Result, StorageError};
use crate::hardening::{ensure_private_directory, harden_sqlite_family};
use crate::write_coordinator::now_iso_millis;

pub const HOT_MEMORY_ID: &str = "hot";
pub const HOT_CACHE_PROMPT_LIMIT: usize = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Workspace,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWriteMode {
    Create,
    #[default]
    Upsert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub scope: MemoryScope,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

/// SQLite-backed memory store compatible with `src/memoryStore.ts`.
#[derive(Debug, Clone)]
pub struct MemoryStore {
    workspace_db_path: PathBuf,
    user_db_path: PathBuf,
}

impl MemoryStore {
    pub fn new(workspace_db_path: PathBuf, user_db_path: PathBuf) -> Self {
        Self {
            workspace_db_path,
            user_db_path,
        }
    }

    fn db_path(&self, scope: MemoryScope) -> &Path {
        match scope {
            MemoryScope::Workspace => &self.workspace_db_path,
            MemoryScope::User => &self.user_db_path,
        }
    }

    fn with_db<T, F>(&self, scope: MemoryScope, op: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let db_path = self.db_path(scope);
        if let Some(parent) = db_path.parent() {
            ensure_private_directory(parent)?;
        }
        let conn = Connection::open(db_path)?;
        harden_sqlite_family(db_path);
        ensure_schema(&conn)?;
        ensure_legacy_imported(&conn, db_path)?;
        op(&conn)
    }

    pub fn list(&self, scope: Option<MemoryScope>) -> Result<Vec<MemoryEntry>> {
        if let Some(s) = scope {
            return self.list_scope(s);
        }
        let mut combined = self.list_scope(MemoryScope::Workspace)?;
        combined.extend(self.list_scope(MemoryScope::User)?);
        combined.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(combined)
    }

    fn list_scope(&self, scope: MemoryScope) -> Result<Vec<MemoryEntry>> {
        self.with_db(scope, |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, created_at, updated_at
                 FROM memories
                 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    scope,
                    content: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn get_by_id(&self, id: &str, scope: Option<MemoryScope>) -> Result<Option<MemoryEntry>> {
        let normalized_id = normalize_stored_memory_id(id);
        let scopes: &[MemoryScope] = match scope {
            Some(MemoryScope::Workspace) => &[MemoryScope::Workspace],
            Some(MemoryScope::User) => &[MemoryScope::User],
            None => &[MemoryScope::Workspace, MemoryScope::User],
        };

        for &cur_scope in scopes {
            let found = self.with_db(cur_scope, |conn| {
                conn.query_row(
                    "SELECT id, content, created_at, updated_at FROM memories WHERE id = ?1",
                    params![normalized_id],
                    |row| {
                        Ok(MemoryEntry {
                            id: row.get(0)?,
                            scope: cur_scope,
                            content: row.get(1)?,
                            created_at: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(StorageError::from)
            })?;
            if found.is_some() {
                return Ok(found);
            }
        }
        Ok(None)
    }

    pub fn upsert(
        &self,
        scope: MemoryScope,
        id: Option<&str>,
        content: &str,
        mode: MemoryWriteMode,
    ) -> Result<MemoryEntry> {
        let normalized_id = match id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => normalize_stored_memory_id(raw),
            None => Uuid::new_v4().to_string(),
        };
        let trimmed_content = content.trim().to_string();
        let timestamp = now_iso_millis();

        self.with_db(scope, |conn| {
            let existing_created_at: Option<String> = conn
                .query_row(
                    "SELECT created_at FROM memories WHERE id = ?1",
                    params![normalized_id],
                    |row| row.get(0),
                )
                .optional()?;
            let created_at = existing_created_at
                .clone()
                .unwrap_or_else(|| timestamp.clone());

            let sql = match mode {
                MemoryWriteMode::Create => {
                    "INSERT INTO memories(id, content, created_at, updated_at)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO NOTHING"
                }
                MemoryWriteMode::Upsert => {
                    "INSERT INTO memories(id, content, created_at, updated_at)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                       content = excluded.content,
                       updated_at = excluded.updated_at"
                }
            };

            let changed = conn.execute(
                sql,
                params![normalized_id, trimmed_content, created_at, timestamp],
            )?;
            if mode == MemoryWriteMode::Create && changed == 0 {
                return Err(StorageError::Conflict(format!(
                    "Memory \"{normalized_id}\" already exists. Edit it or use a different title."
                )));
            }

            Ok(MemoryEntry {
                id: normalized_id,
                scope,
                content: trimmed_content,
                created_at,
                updated_at: timestamp,
            })
        })
    }

    pub fn remove(&self, scope: MemoryScope, id_raw: &str) -> Result<bool> {
        let normalized_id = normalize_stored_memory_id(id_raw);
        self.with_db(scope, |conn| {
            let deleted =
                conn.execute("DELETE FROM memories WHERE id = ?1", params![normalized_id])?;
            Ok(deleted > 0)
        })
    }

    pub fn search(&self, query: &str, scope: Option<MemoryScope>) -> Result<Vec<MemoryEntry>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let entries = self.list(scope)?;
        Ok(entries
            .into_iter()
            .filter(|entry| {
                entry.id.to_lowercase().contains(&needle)
                    || entry.content.to_lowercase().contains(&needle)
            })
            .collect())
    }

    pub fn render_prompt_section(&self) -> Result<String> {
        let active = match self.get_by_id(HOT_MEMORY_ID, Some(MemoryScope::Workspace))? {
            Some(ws) => Some(ws),
            None => self.get_by_id(HOT_MEMORY_ID, Some(MemoryScope::User))?,
        };
        let Some(entry) = active else {
            return Ok(String::new());
        };

        let scope_name = match entry.scope {
            MemoryScope::Workspace => "workspace",
            MemoryScope::User => "user",
        };
        let heading = match entry.scope {
            MemoryScope::Workspace => "Workspace",
            MemoryScope::User => "User",
        };

        Ok([
            "## Memory".to_string(),
            String::new(),
            format!("This {scope_name} hot-cache memory is loaded into the system prompt."),
            "Use the `memory` tool to read, write, search, or delete entries when the user asks to update memory.".to_string(),
            "Treat memories as helpful context, but resolve conflicts in favor of the latest explicit user instruction.".to_string(),
            String::new(),
            "### Loaded Hot Cache".to_string(),
            String::new(),
            format!("#### {heading} Hot Cache"),
            String::new(),
            truncate_for_prompt(&entry.content, HOT_CACHE_PROMPT_LIMIT),
        ]
        .join("\n"))
    }
}

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memories (
           id TEXT PRIMARY KEY,
           content TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);",
    )?;
    Ok(())
}

fn ensure_legacy_imported(conn: &Connection, db_path: &Path) -> Result<()> {
    let imported: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'legacy_import_done'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if imported.as_deref() == Some("1") {
        return Ok(());
    }

    let Some(agent_dir) = db_path.parent() else {
        return Ok(());
    };
    let mut to_import: Vec<(String, String)> = Vec::new();

    let hot_path = agent_dir.join("AGENT.md");
    if let Ok(hot) = fs::read_to_string(&hot_path)
        && !hot.trim().is_empty()
    {
        to_import.push((HOT_MEMORY_ID.to_string(), hot));
    }

    let memory_dir = agent_dir.join("memory");
    if memory_dir.exists() {
        let mut md_files: Vec<PathBuf> = WalkDir::new(&memory_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            })
            .map(|e| e.into_path())
            .collect();
        md_files.sort();

        for file_path in md_files {
            if let Ok(content) = fs::read_to_string(&file_path)
                && !content.trim().is_empty()
                && let Ok(rel) = file_path.strip_prefix(&memory_dir)
            {
                let rel_str = rel.to_string_lossy();
                to_import.push((normalize_memory_id(&rel_str), content));
            }
        }
    }

    if !to_import.is_empty() {
        let timestamp = now_iso_millis();
        let mut existing_ids = HashSet::new();
        {
            let mut stmt = conn.prepare("SELECT id FROM memories")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for r in rows {
                existing_ids.insert(r?);
            }
        }
        let mut seen = HashSet::new();
        for (id, content) in to_import {
            if existing_ids.contains(&id) || !seen.insert(id.clone()) {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO memories(id, content, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4)",
                params![id, content.trim(), timestamp, timestamp],
            )?;
        }
    }

    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('legacy_import_done', '1')",
        [],
    )?;
    Ok(())
}

pub fn normalize_memory_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "memory".to_string();
    }
    let lowered = trimmed.to_lowercase().replace('\\', "/");
    let without_ext = lowered.strip_suffix(".md").unwrap_or(&lowered);

    let mut sanitized = String::with_capacity(without_ext.len());
    let mut prev_dash = false;
    for ch in without_ext.chars() {
        let keep = ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-');
        if keep {
            if ch == '-' {
                if !prev_dash {
                    sanitized.push('-');
                }
                prev_dash = true;
            } else {
                sanitized.push(ch);
                prev_dash = false;
            }
        } else if !prev_dash {
            sanitized.push('-');
            prev_dash = true;
        }
    }
    let cleaned = sanitized.trim_matches('-');
    if cleaned.is_empty() {
        "memory".to_string()
    } else {
        cleaned.to_string()
    }
}

pub fn normalize_stored_memory_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "memory".to_string();
    }
    if trimmed.eq_ignore_ascii_case("hot") || trimmed.eq_ignore_ascii_case("agent.md") {
        return HOT_MEMORY_ID.to_string();
    }
    normalize_memory_id(trimmed)
}

fn truncate_for_prompt(content: &str, limit: usize) -> String {
    if content.chars().count() <= limit {
        return content.to_string();
    }
    let prefix: String = content.chars().take(limit).collect();
    format!("{prefix}\n\n…[hot cache truncated at {limit} characters]")
}
