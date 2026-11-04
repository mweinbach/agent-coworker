use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
        // `<home>/.cowork/memory.sqlite` doubles as the workspace database when the workspace is
        // the home directory; it is the user's own cowork home, so it gets the user-scope policy.
        let confinement =
            if scope == MemoryScope::Workspace && self.workspace_db_path != self.user_db_path {
                LegacyImportConfinement::WorkspaceRoot
            } else {
                LegacyImportConfinement::CoworkHome
            };
        ensure_legacy_imported(&conn, db_path, confinement)?;
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

/// Which canonical root legacy Markdown memory sources must resolve inside before they are
/// imported (TS `src/memoryStore.ts` read them unconfined; see `ensure_legacy_imported`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LegacyImportConfinement {
    /// `<workspace>/.cowork/memory.sqlite`: sources must stay inside the canonical workspace
    /// root (the parent of `.cowork`), and `.cowork` itself must be a real directory.
    WorkspaceRoot,
    /// `~/.cowork/memory.sqlite`: sources must stay inside the canonical user cowork home.
    CoworkHome,
}

/// One-time import of the pre-SQLite Markdown memory layout (`AGENT.md` + `memory/**/*.md`).
///
/// TS `readTextIfExists` / `walkMarkdownFiles` followed symlinks anywhere on disk. Because a
/// workspace `.cowork` comes from an untrusted repository, symlinks are followed only when their
/// canonical target stays inside the canonical root the store belongs to (see
/// [`LegacyImportConfinement`]); this keeps TS parity for in-tree links while refusing links to
/// host secrets such as `~/.ssh/id_ed25519` or `~/.cowork/auth/**`.
///
/// - A symlinked workspace `.cowork` skips the import entirely and leaves the marker unset: the
///   database it would mark lives at the link target, which may be another workspace's store.
/// - A source that resolves outside the root is a deliberate, permanent refusal: it is skipped
///   (with a warning) and the import can still be marked done.
/// - Only a missing file or directory (including a dangling symlink) is otherwise skipped. Any
///   other read or traversal failure (`ELOOP`, permissions, I/O) propagates before the completion
///   marker is written, so a transient error leaves the import retryable.
fn ensure_legacy_imported(
    conn: &Connection,
    db_path: &Path,
    confinement: LegacyImportConfinement,
) -> Result<()> {
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
    let Some(root) = legacy_import_root(agent_dir, confinement)? else {
        return Ok(());
    };
    let mut to_import: Vec<(String, String)> = Vec::new();

    let hot_path = agent_dir.join("AGENT.md");
    if let Some(hot) = read_confined_text(&hot_path, &root)?
        && !hot.trim().is_empty()
    {
        to_import.push((HOT_MEMORY_ID.to_string(), hot));
    }

    let memory_dir = agent_dir.join("memory");
    let mut md_files = walk_markdown_files(&memory_dir, &root)?;
    md_files.sort();

    for file_path in md_files {
        let Some(content) = read_confined_text(&file_path, &root)? else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        if let Ok(rel) = file_path.strip_prefix(&memory_dir) {
            let rel_str = rel.to_string_lossy();
            to_import.push((normalize_memory_id(&rel_str), content));
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

/// Canonical confinement root for a legacy import, or `None` when the import must be skipped
/// without marking it done (a symlinked workspace `.cowork`).
fn legacy_import_root(
    agent_dir: &Path,
    confinement: LegacyImportConfinement,
) -> Result<Option<PathBuf>> {
    match confinement {
        LegacyImportConfinement::WorkspaceRoot => {
            if fs::symlink_metadata(agent_dir)?.file_type().is_symlink() {
                tracing::warn!(
                    path = %agent_dir.display(),
                    "skipping legacy memory import: workspace .cowork is a symlink"
                );
                return Ok(None);
            }
            let workspace_root = match agent_dir.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent,
                _ => Path::new("."),
            };
            Ok(Some(fs::canonicalize(workspace_root)?))
        }
        LegacyImportConfinement::CoworkHome => Ok(Some(fs::canonicalize(agent_dir)?)),
    }
}

/// Resolves `path` (following symlinks like TS `fs.stat`) and reports whether it exists and
/// stays inside `root`. `Ok(None)` means the entry is missing (including a dangling symlink) or
/// was refused for resolving outside the root; other errors (`ELOOP`, permissions) propagate.
fn resolve_confined(path: &Path, root: &Path) -> Result<Option<PathBuf>> {
    let canonical = match fs::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    if !canonical.starts_with(root) {
        tracing::warn!(
            path = %path.display(),
            "skipping legacy memory source that resolves outside its root"
        );
        return Ok(None);
    }
    Ok(Some(canonical))
}

/// TS `readTextIfExists`, confined to `root`: `None` for a missing file or one that resolves
/// outside `root`; every other error propagates. The resolved path is opened without following
/// a final symlink (`O_NOFOLLOW` / `FILE_FLAG_OPEN_REPARSE_POINT`), so a link swapped in after
/// resolution fails the (retryable) import instead of being read. Bytes are decoded lossily like
/// `Bun.file().text()`, so non-UTF-8 content never blocks the import.
fn read_confined_text(path: &Path, root: &Path) -> Result<Option<String>> {
    use std::io::Read;

    let Some(canonical) = resolve_confined(path, root)? else {
        return Ok(None);
    };
    let mut file = match open_no_follow(&canonical) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    if file.metadata()?.file_type().is_symlink() {
        return Err(std::io::Error::other(format!(
            "legacy memory source changed into a link while importing: {}",
            canonical.display()
        ))
        .into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_no_follow(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_FLAG_OPEN_REPARSE_POINT: open a symlink/junction itself instead of its target.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_no_follow(path: &Path) -> std::io::Result<fs::File> {
    fs::File::open(path)
}

/// TS `walkMarkdownFiles`, confined to `root`: follows symlinked files and directories
/// (`fs.stat`, not `lstat`) whose canonical target stays inside `root`, and guards against
/// cycles by skipping any directory whose canonical path was already walked. Entries that are
/// missing (including dangling symlinks) or resolve outside `root` are skipped; every other
/// error propagates so the caller leaves the legacy import retryable. Returned paths keep the
/// walked (non-canonical) spelling so ids derive from the path under the memory directory.
fn walk_markdown_files(dir: &Path, root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    walk_markdown_dir(dir, root, &mut visited, &mut out)?;
    Ok(out)
}

fn walk_markdown_dir(
    dir: &Path,
    root: &Path,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<PathBuf>,
) -> Result<()> {
    let Some(canonical) = resolve_confined(dir, root)? else {
        return Ok(());
    };
    if !visited.insert(canonical.clone()) {
        return Ok(());
    }
    // List the resolved directory so a link swapped in after the containment check is not
    // followed out of `root`; children are still reported under the walked spelling.
    let read_dir = match fs::read_dir(&canonical) {
        Ok(read_dir) => read_dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let mut names = Vec::new();
    for entry in read_dir {
        names.push(entry?.file_name());
    }
    names.sort();
    for name in names {
        let full = dir.join(&name);
        let metadata = match fs::metadata(&full) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.into()),
        };
        if metadata.is_dir() {
            walk_markdown_dir(&full, root, visited, out)?;
        } else if metadata.is_file() && name.to_string_lossy().to_lowercase().ends_with(".md") {
            // Containment is enforced when the file is read (`read_confined_text`).
            out.push(full);
        }
    }
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
