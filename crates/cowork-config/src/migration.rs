use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{ConfigError, Result};
use crate::paths::{env_map_from_process, host_platform, resolve_home_dir, write_text_file_atomic};

#[derive(Debug, Clone, Default)]
pub struct MigrateAgentConfigOptions {
    pub cwd: Option<PathBuf>,
    pub homedir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigMigrationScopeResult {
    pub scope: String,
    pub source_dir: String,
    pub target_dir: String,
    pub archived_path: Option<String>,
    pub config_imported: usize,
    pub config_skipped_conflicts: usize,
    pub mcp_imported: usize,
    pub mcp_skipped_conflicts: usize,
    pub entries_imported: usize,
    pub entries_skipped_conflicts: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigMigrationResult {
    pub scopes: Vec<AgentConfigMigrationScopeResult>,
}

struct ScopePaths {
    scope: &'static str,
    source_dir: PathBuf,
    target_dir: PathBuf,
    source_config_file: PathBuf,
    target_config_file: PathBuf,
    source_mcp_file: PathBuf,
    target_mcp_file: PathBuf,
}

fn read_json_object_if_exists(path: &Path) -> Result<Option<Map<String, Value>>> {
    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ConfigError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| ConfigError::InvalidJson {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    match parsed {
        Value::Object(map) => Ok(Some(map)),
        _ => Err(ConfigError::NotJsonObject(path.to_path_buf())),
    }
}

fn merge_json_preserving_target(
    source: &Map<String, Value>,
    target: &Map<String, Value>,
) -> (Map<String, Value>, usize, usize) {
    let mut out = target.clone();
    let mut imported = 0;
    let mut skipped_conflicts = 0;

    for (key, source_val) in source {
        let Some(target_val) = target.get(key) else {
            out.insert(key.clone(), source_val.clone());
            imported += 1;
            continue;
        };
        if let (Value::Object(s_obj), Value::Object(t_obj)) = (source_val, target_val) {
            let (nested, n_imp, n_skip) = merge_json_preserving_target(s_obj, t_obj);
            out.insert(key.clone(), Value::Object(nested));
            imported += n_imp;
            skipped_conflicts += n_skip;
        } else {
            skipped_conflicts += 1;
        }
    }

    (out, imported, skipped_conflicts)
}

fn migrate_json_config(source_file: &Path, target_file: &Path) -> Result<(usize, usize)> {
    let Some(source) = read_json_object_if_exists(source_file)? else {
        return Ok((0, 0));
    };
    let target = read_json_object_if_exists(target_file)?.unwrap_or_default();
    let (merged, imported, skipped) = merge_json_preserving_target(&source, &target);
    let payload = format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(merged))
            .map_err(|e| ConfigError::Validation(e.to_string()))?
    );
    write_text_file_atomic(target_file, &payload, None)?;
    Ok((imported, skipped))
}

fn read_mcp_servers_if_exists(path: &Path) -> Result<Option<Vec<Value>>> {
    let Some(obj) = read_json_object_if_exists(path)? else {
        return Ok(None);
    };
    let Some(arr) = obj.get("servers").and_then(Value::as_array) else {
        return Err(ConfigError::Validation(format!(
            "{}: expected servers array",
            path.display()
        )));
    };
    for srv in arr {
        let name = srv
            .as_object()
            .and_then(|o| o.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() {
            return Err(ConfigError::Validation(format!(
                "{}: server missing non-empty name",
                path.display()
            )));
        }
    }
    Ok(Some(arr.clone()))
}

fn migrate_mcp_servers(source_file: &Path, target_file: &Path) -> Result<(usize, usize)> {
    let Some(source_servers) = read_mcp_servers_if_exists(source_file)? else {
        return Ok((0, 0));
    };
    let target_servers = read_mcp_servers_if_exists(target_file)?.unwrap_or_default();
    let mut existing_names: HashSet<String> = target_servers
        .iter()
        .filter_map(|s| s.get("name").and_then(Value::as_str).map(ToOwned::to_owned))
        .collect();
    let mut merged = target_servers;
    let mut imported = 0;
    let mut skipped = 0;

    for server in source_servers {
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if existing_names.contains(&name) {
            skipped += 1;
            continue;
        }
        existing_names.insert(name);
        merged.push(server);
        imported += 1;
    }

    merged.sort_by(|a, b| {
        let na = a.get("name").and_then(Value::as_str).unwrap_or("");
        let nb = b.get("name").and_then(Value::as_str).unwrap_or("");
        na.cmp(nb)
    });

    let payload = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({ "servers": merged }))
            .map_err(|e| ConfigError::Validation(e.to_string()))?
    );
    write_text_file_atomic(target_file, &payload, Some(0o600))?;
    Ok((imported, skipped))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn move_path(source: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|s| ConfigError::Io {
            path: parent.to_path_buf(),
            source: s,
        })?;
    }
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            if source.is_dir() {
                copy_dir_recursive(source, target).map_err(|s| ConfigError::Io {
                    path: target.to_path_buf(),
                    source: s,
                })?;
                fs::remove_dir_all(source).map_err(|s| ConfigError::Io {
                    path: source.to_path_buf(),
                    source: s,
                })?;
            } else {
                fs::copy(source, target).map_err(|s| ConfigError::Io {
                    path: target.to_path_buf(),
                    source: s,
                })?;
                fs::remove_file(source).map_err(|s| ConfigError::Io {
                    path: source.to_path_buf(),
                    source: s,
                })?;
            }
            Ok(())
        }
    }
}

fn merge_directory_entries(source_dir: &Path, target_dir: &Path) -> Result<(usize, usize)> {
    if !source_dir.exists() {
        return Ok((0, 0));
    }
    fs::create_dir_all(target_dir).map_err(|source| ConfigError::Io {
        path: target_dir.to_path_buf(),
        source,
    })?;
    let mut imported = 0;
    let mut skipped = 0;
    let entries = fs::read_dir(source_dir).map_err(|source| ConfigError::Io {
        path: source_dir.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| ConfigError::Io {
            path: source_dir.to_path_buf(),
            source,
        })?;
        let src_path = entry.path();
        let dst_path = target_dir.join(entry.file_name());
        if dst_path.exists() {
            skipped += 1;
            continue;
        }
        move_path(&src_path, &dst_path)?;
        imported += 1;
    }
    Ok((imported, skipped))
}

fn archive_source_dir(source_dir: &Path) -> Result<Option<String>> {
    if !source_dir.exists() {
        return Ok(None);
    }
    let parent = source_dir.parent().unwrap_or_else(|| Path::new("."));
    let base = source_dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".agent".to_string());
    let ts = Utc::now().timestamp_millis();
    let mut candidate = parent.join(format!("{base}.legacy-migrated.{ts}"));
    let mut attempt = 1usize;
    while candidate.exists() {
        candidate = parent.join(format!("{base}.legacy-migrated.{ts}.{attempt}"));
        attempt += 1;
    }
    fs::rename(source_dir, &candidate).map_err(|source| ConfigError::Io {
        path: source_dir.to_path_buf(),
        source,
    })?;
    Ok(Some(candidate.to_string_lossy().into_owned()))
}

fn migrate_scope(paths: ScopePaths) -> Result<AgentConfigMigrationScopeResult> {
    let mut res = AgentConfigMigrationScopeResult {
        scope: paths.scope.to_string(),
        source_dir: paths.source_dir.to_string_lossy().into_owned(),
        target_dir: paths.target_dir.to_string_lossy().into_owned(),
        archived_path: None,
        config_imported: 0,
        config_skipped_conflicts: 0,
        mcp_imported: 0,
        mcp_skipped_conflicts: 0,
        entries_imported: 0,
        entries_skipped_conflicts: 0,
        warnings: Vec::new(),
    };

    if !paths.source_dir.exists() {
        return Ok(res);
    }

    match migrate_json_config(&paths.source_config_file, &paths.target_config_file) {
        Ok((imp, skip)) => {
            res.config_imported = imp;
            res.config_skipped_conflicts = skip;
        }
        Err(e) => res.warnings.push(format!("Skipped config migration: {e}")),
    }

    match migrate_mcp_servers(&paths.source_mcp_file, &paths.target_mcp_file) {
        Ok((imp, skip)) => {
            res.mcp_imported = imp;
            res.mcp_skipped_conflicts = skip;
        }
        Err(e) => res.warnings.push(format!("Skipped MCP migration: {e}")),
    }

    for dir_name in ["skills", "disabled-skills", "memory"] {
        let (imp, skip) = merge_directory_entries(
            &paths.source_dir.join(dir_name),
            &paths.target_dir.join(dir_name),
        )?;
        res.entries_imported += imp;
        res.entries_skipped_conflicts += skip;
    }

    for file_name in ["AGENT.md", "memory.sqlite"] {
        let src_file = paths.source_dir.join(file_name);
        let dst_file = paths.target_dir.join(file_name);
        if !src_file.exists() {
            continue;
        }
        if dst_file.exists() {
            res.entries_skipped_conflicts += 1;
            continue;
        }
        move_path(&src_file, &dst_file)?;
        res.entries_imported += 1;
    }

    if res.warnings.is_empty() {
        res.archived_path = archive_source_dir(&paths.source_dir)?;
    }

    Ok(res)
}

/// Idempotently migrates legacy `<workspace>/.agent` and `<home>/.agent` directories into `.cowork` (`src/migrateAgentConfig.ts`).
pub async fn migrate_agent_config(
    opts: MigrateAgentConfigOptions,
) -> Result<AgentConfigMigrationResult> {
    let env = env_map_from_process();
    let cwd = opts
        .cwd
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let homedir = opts
        .homedir
        .unwrap_or_else(|| resolve_home_dir(&env, host_platform()));

    let ws_source = cwd.join(".agent");
    let ws_target = cwd.join(".cowork");
    let workspace_paths = ScopePaths {
        scope: "workspace",
        source_config_file: ws_source.join("config.json"),
        target_config_file: ws_target.join("config.json"),
        source_mcp_file: ws_source.join("mcp-servers.json"),
        target_mcp_file: ws_target.join("mcp-servers.json"),
        source_dir: ws_source,
        target_dir: ws_target,
    };

    let user_source = homedir.join(".agent");
    let user_target = homedir.join(".cowork");
    let user_paths = ScopePaths {
        scope: "user",
        source_config_file: user_source.join("config.json"),
        target_config_file: user_target.join("config").join("config.json"),
        source_mcp_file: user_source.join("mcp-servers.json"),
        target_mcp_file: user_target.join("config").join("mcp-servers.json"),
        source_dir: user_source,
        target_dir: user_target,
    };

    let ws_res = migrate_scope(workspace_paths)?;
    let user_res = migrate_scope(user_paths)?;

    Ok(AgentConfigMigrationResult {
        scopes: vec![ws_res, user_res],
    })
}

pub fn format_agent_config_migration_report(result: &AgentConfigMigrationResult) -> String {
    let mut lines = vec!["Cowork migration complete.".to_string()];
    let mut found_legacy = false;

    for scope in &result.scopes {
        let had_legacy = scope.archived_path.is_some()
            || scope.config_imported > 0
            || scope.mcp_imported > 0
            || scope.entries_imported > 0
            || scope.config_skipped_conflicts > 0
            || scope.mcp_skipped_conflicts > 0
            || scope.entries_skipped_conflicts > 0
            || !scope.warnings.is_empty();
        found_legacy |= had_legacy;
        lines.push(format!(
            "{}: imported config keys={}, MCP servers={}, entries={}; skipped conflicts config={}, MCP={}, entries={}.",
            scope.scope,
            scope.config_imported,
            scope.mcp_imported,
            scope.entries_imported,
            scope.config_skipped_conflicts,
            scope.mcp_skipped_conflicts,
            scope.entries_skipped_conflicts
        ));
        if let Some(archived) = &scope.archived_path {
            lines.push(format!(
                "{}: archived {} to {archived}.",
                scope.scope, scope.source_dir
            ));
        }
        for warning in &scope.warnings {
            lines.push(format!("{}: warning: {warning}", scope.scope));
        }
    }

    if !found_legacy {
        lines.push("No legacy .agent config found.".to_string());
    }

    lines.join("\n")
}
