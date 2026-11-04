use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{ConfigError, Result};
use crate::paths::{
    env_map_from_process, host_platform, is_confined_below, resolve_home_dir,
    write_text_file_atomic,
};

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
    /// Root every source/target path must stay inside without traversing a link (the
    /// workspace for the workspace scope); `None` for the user's own home.
    confine_root: Option<PathBuf>,
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

fn validate_string_map(value: &Value, path: &str) -> std::result::Result<(), String> {
    let Some(map) = value.as_object() else {
        return Err(format!("{path}: expected object"));
    };
    for (key, entry) in map {
        if !entry.is_string() {
            return Err(format!("{path}.{key}: expected string"));
        }
    }
    Ok(())
}

fn validate_optional_trimmed_string(
    obj: &Map<String, Value>,
    key: &str,
    path: &str,
) -> std::result::Result<(), String> {
    match obj.get(key) {
        None => Ok(()),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(()),
        Some(Value::String(_)) => Err(format!("{path}.{key}: must not be empty")),
        Some(_) => Err(format!("{path}.{key}: expected string")),
    }
}

fn validate_optional_bool(
    obj: &Map<String, Value>,
    key: &str,
    path: &str,
) -> std::result::Result<(), String> {
    match obj.get(key) {
        None | Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(format!("{path}.{key}: expected boolean")),
    }
}

fn validate_mcp_transport(value: Option<&Value>, path: &str) -> std::result::Result<(), String> {
    let Some(value) = value else {
        return Err(format!("{path}: Required"));
    };
    let Some(obj) = value.as_object() else {
        return Err(format!("{path}: expected object"));
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("stdio") => {
            match obj.get("command") {
                Some(Value::String(s)) if !s.trim().is_empty() => {}
                Some(Value::String(_)) => return Err(format!("{path}.command: must not be empty")),
                Some(_) => return Err(format!("{path}.command: expected string")),
                None => return Err(format!("{path}.command: Required")),
            }
            if let Some(args) = obj.get("args") {
                let all_strings = args
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string));
                if !all_strings {
                    return Err(format!("{path}.args: expected array of strings"));
                }
            }
            if let Some(env) = obj.get("env") {
                validate_string_map(env, &format!("{path}.env"))?;
            }
            validate_optional_trimmed_string(obj, "cwd", path)
        }
        Some("http" | "sse") => {
            match obj.get("url") {
                Some(Value::String(s)) if !s.trim().is_empty() => {}
                Some(Value::String(_)) => return Err(format!("{path}.url: must not be empty")),
                Some(_) => return Err(format!("{path}.url: expected string")),
                None => return Err(format!("{path}.url: Required")),
            }
            match obj.get("headers") {
                Some(headers) => validate_string_map(headers, &format!("{path}.headers")),
                None => Ok(()),
            }
        }
        _ => Err(format!("{path}.type: expected 'stdio' | 'http' | 'sse'")),
    }
}

fn validate_mcp_auth(value: &Value, path: &str) -> std::result::Result<(), String> {
    let Some(obj) = value.as_object() else {
        return Err(format!("{path}: expected object"));
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("none") => Ok(()),
        Some("api_key") => {
            for key in ["headerName", "prefix", "keyId"] {
                validate_optional_trimmed_string(obj, key, path)?;
            }
            Ok(())
        }
        Some("oauth") => {
            for key in ["scope", "resource"] {
                validate_optional_trimmed_string(obj, key, path)?;
            }
            match obj.get("oauthMode") {
                None => Ok(()),
                Some(Value::String(mode)) if mode == "auto" || mode == "code" => Ok(()),
                Some(_) => Err(format!("{path}.oauthMode: expected 'auto' | 'code'")),
            }
        }
        _ => Err(format!(
            "{path}.type: expected 'none' | 'api_key' | 'oauth'"
        )),
    }
}

/// Validates one `servers[]` entry against `mcpServerSchema` (`src/mcp/configRegistry/parser.ts`)
/// so an entry the runtime would drop is never counted as migrated.
fn validate_mcp_server_entry(value: &Value, index: usize) -> std::result::Result<(), String> {
    let path = format!("servers.{index}");
    let Some(obj) = value.as_object() else {
        return Err(format!("{path}: expected object"));
    };
    match obj.get("name") {
        Some(Value::String(s)) if !s.trim().is_empty() => {}
        Some(Value::String(_)) => return Err(format!("{path}.name: must not be empty")),
        Some(_) => return Err(format!("{path}.name: expected string")),
        None => return Err(format!("{path}.name: Required")),
    }
    validate_mcp_transport(obj.get("transport"), &format!("{path}.transport"))?;
    validate_optional_bool(obj, "enabled", &path)?;
    validate_optional_bool(obj, "required", &path)?;
    match obj.get("retries") {
        None | Some(Value::Number(_)) => {}
        Some(_) => return Err(format!("{path}.retries: expected number")),
    }
    if let Some(auth) = obj.get("auth") {
        validate_mcp_auth(auth, &format!("{path}.auth"))?;
    }
    validate_optional_trimmed_string(obj, "icon", &path)
}

/// Reads and validates a whole `mcp-servers.json` like `parseMCPServersDocument`: one invalid
/// entry fails the document, so the MCP migration is skipped with a warning (and `.agent` is
/// left in place) instead of silently importing a server the runtime would ignore.
fn read_mcp_servers_if_exists(path: &Path) -> Result<Option<Vec<Value>>> {
    let Some(obj) = read_json_object_if_exists(path)? else {
        return Ok(None);
    };
    let servers = match obj.get("servers") {
        // `servers` defaults to `[]` in `mcpServersDocumentSchema`.
        None => Vec::new(),
        Some(Value::Array(arr)) => arr.clone(),
        Some(_) => {
            return Err(ConfigError::Validation(format!(
                "{}: expected servers array",
                path.display()
            )));
        }
    };
    for (index, server) in servers.iter().enumerate() {
        validate_mcp_server_entry(server, index)
            .map_err(|message| ConfigError::Validation(format!("{}: {message}", path.display())))?;
    }
    Ok(Some(servers))
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

/// Recreates the symlink at `src` as `dst`, pointing at the same (unresolved) target. The link
/// itself is copied, never what it points to, so nothing outside the migrated tree is read.
fn copy_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    let link_target = fs::read_link(src)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link_target, dst)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if fs::symlink_metadata(src)?.file_type().is_symlink_dir() {
            std::os::windows::fs::symlink_dir(&link_target, dst)
        } else {
            std::os::windows::fs::symlink_file(&link_target, dst)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (link_target, dst);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "symlinks are not supported on this platform",
        ))
    }
}

/// Removes the symlink at `path` (not its target).
fn remove_symlink(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if fs::symlink_metadata(path)?.file_type().is_symlink_dir() {
            return fs::remove_dir(path);
        }
    }
    fs::remove_file(path)
}

/// Cross-device fallback for `move_path`. Symlinks are recreated as links with the same target,
/// never followed: copying a link's target would materialize files from outside the migrated
/// tree (e.g. a workspace link into the trusted user tier). Any failure, including one to
/// recreate a link, fails the copy so the caller keeps the source.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            copy_symlink(&src_path, &dst_path)?;
        } else if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn move_path(source: &Path, target: &Path) -> Result<()> {
    move_path_with(source, target, |from, to| fs::rename(from, to))
}

/// `move_path` with an injectable `rename`, so tests can force the cross-volume copy fallback.
fn move_path_with(
    source: &Path,
    target: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|s| ConfigError::Io {
            path: parent.to_path_buf(),
            source: s,
        })?;
    }
    // `rename` moves a symlink itself, never its target.
    if rename(source, target).is_ok() {
        return Ok(());
    }
    let source_meta = fs::symlink_metadata(source).map_err(|s| ConfigError::Io {
        path: source.to_path_buf(),
        source: s,
    })?;
    if source_meta.file_type().is_symlink() {
        // Recreate the link itself; following it would copy its target instead.
        copy_symlink(source, target).map_err(|s| ConfigError::Io {
            path: target.to_path_buf(),
            source: s,
        })?;
        return remove_symlink(source).map_err(|s| ConfigError::Io {
            path: source.to_path_buf(),
            source: s,
        });
    }
    if source_meta.is_dir() {
        if let Err(copy_err) = copy_dir_recursive(source, target) {
            // Drop the partial copy (the caller checked `target` did not exist) so a rerun
            // does not mistake it for an already-migrated entry; the source is kept.
            let _ = fs::remove_dir_all(target);
            return Err(ConfigError::Io {
                path: target.to_path_buf(),
                source: copy_err,
            });
        }
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

    // SECURITY BOUNDARY: an untrusted repository must not redirect the workspace `.agent` /
    // `.cowork` (or the config files in them) through links, e.g. `.cowork -> ~/.cowork/config`
    // would merge workspace keys into the trusted user config.
    if let Some(root) = &paths.confine_root {
        let unconfined: Vec<&PathBuf> = [
            &paths.source_dir,
            &paths.target_dir,
            &paths.source_config_file,
            &paths.target_config_file,
            &paths.source_mcp_file,
            &paths.target_mcp_file,
        ]
        .into_iter()
        .filter(|path| !is_confined_below(root, path))
        .collect();
        if !unconfined.is_empty() {
            for path in unconfined {
                res.warnings.push(format!(
                    "Skipped migration: {} is a link or resolves outside {}",
                    path.display(),
                    root.display()
                ));
            }
            return Ok(res);
        }
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

    for file_name in ["AGENT.md", crate::paths::MEMORY_DB_FILE_NAME] {
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
        confine_root: Some(cwd.clone()),
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
        confine_root: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cross_device(_: &Path, _: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::CrossesDevices,
            "simulated EXDEV",
        ))
    }

    #[cfg(unix)]
    #[test]
    fn copy_dir_recursive_recreates_symlinks_instead_of_copying_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "SECRET").unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested/keep.md"), "keep").unwrap();
        std::os::unix::fs::symlink(&secret, src.join("link.md")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), src.join("nested/dir-link")).unwrap();
        std::os::unix::fs::symlink("../relative-target", src.join("nested/rel-link")).unwrap();

        let dst = tmp.path().join("dst");
        copy_dir_recursive(&src, &dst).unwrap();
        assert_eq!(
            fs::read_to_string(dst.join("nested/keep.md")).unwrap(),
            "keep"
        );
        for (name, target) in [
            ("link.md", secret.clone()),
            ("nested/dir-link", tmp.path().to_path_buf()),
            ("nested/rel-link", PathBuf::from("../relative-target")),
        ] {
            let meta = fs::symlink_metadata(dst.join(name)).unwrap();
            assert!(meta.file_type().is_symlink(), "{name} must stay a link");
            assert_eq!(fs::read_link(dst.join(name)).unwrap(), target, "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn cross_volume_move_preserves_nested_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let skill = tmp.path().join(".agent/skills/my-skill");
        fs::create_dir_all(skill.join("refs")).unwrap();
        fs::write(skill.join("SKILL.md"), "# skill").unwrap();
        fs::write(tmp.path().join("shared.md"), "shared").unwrap();
        std::os::unix::fs::symlink("../../../../shared.md", skill.join("refs/shared.md")).unwrap();

        let target = tmp.path().join(".cowork/skills/my-skill");
        move_path_with(&skill, &target, cross_device).unwrap();

        assert!(!skill.exists());
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "# skill"
        );
        let link = target.join("refs/shared.md");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_link(&link).unwrap(),
            PathBuf::from("../../../../shared.md")
        );
    }

    #[cfg(unix)]
    #[test]
    fn cross_volume_move_of_a_top_level_symlink_moves_the_link() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real-skill");
        fs::create_dir_all(&real).unwrap();
        let source = tmp.path().join(".agent/skills/linked");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &source).unwrap();

        let target = tmp.path().join(".cowork/skills/linked");
        move_path_with(&source, &target, cross_device).unwrap();
        assert!(fs::symlink_metadata(&source).is_err());
        assert_eq!(fs::read_link(&target).unwrap(), real);
        assert!(real.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn failed_symlink_copy_keeps_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let skill = tmp.path().join("src-skill");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "# skill").unwrap();
        std::os::unix::fs::symlink("elsewhere", skill.join("link")).unwrap();

        // A pre-existing entry at the link's destination makes recreating the link fail.
        let target = tmp.path().join("dst-skill");
        fs::create_dir_all(target.join("link")).unwrap();
        assert!(move_path_with(&skill, &target, cross_device).is_err());

        assert_eq!(
            fs::read_link(skill.join("link")).unwrap(),
            PathBuf::from("elsewhere")
        );
        assert_eq!(
            fs::read_to_string(skill.join("SKILL.md")).unwrap(),
            "# skill"
        );
    }

    fn write_json(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    fn workspace_scope(cwd: &Path) -> ScopePaths {
        let source = cwd.join(".agent");
        let target = cwd.join(".cowork");
        ScopePaths {
            scope: "workspace",
            confine_root: Some(cwd.to_path_buf()),
            source_config_file: source.join("config.json"),
            target_config_file: target.join("config.json"),
            source_mcp_file: source.join("mcp-servers.json"),
            target_mcp_file: target.join("mcp-servers.json"),
            source_dir: source,
            target_dir: target,
        }
    }

    #[test]
    fn mcp_server_without_transport_is_not_migrated_and_keeps_agent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        write_json(
            &cwd.join(".agent/mcp-servers.json"),
            &json!({
                "servers": [
                    { "name": "good", "transport": { "type": "stdio", "command": "node" } },
                    { "name": "broken" }
                ]
            }),
        );

        let res = migrate_scope(workspace_scope(&cwd)).unwrap();
        assert_eq!(res.mcp_imported, 0);
        assert_eq!(res.warnings.len(), 1, "{:?}", res.warnings);
        assert!(
            res.warnings[0].contains("Skipped MCP migration")
                && res.warnings[0].contains("servers.1.transport"),
            "{:?}",
            res.warnings
        );
        assert!(res.archived_path.is_none());
        assert!(cwd.join(".agent/mcp-servers.json").exists());
        assert!(!cwd.join(".cowork/mcp-servers.json").exists());
    }

    #[test]
    fn mcp_entry_validation_matches_ts_schema() {
        let valid = [
            json!({ "name": "a", "transport": { "type": "stdio", "command": "x", "args": ["1"], "env": { "K": "V" }, "cwd": "/w" } }),
            json!({ "name": "b", "transport": { "type": "http", "url": "https://x", "headers": { "H": "v" } }, "enabled": true, "required": false, "retries": 2, "icon": "i" }),
            json!({ "name": "c", "transport": { "type": "sse", "url": "https://x" }, "auth": { "type": "oauth", "oauthMode": "code" } }),
            json!({ "name": "d", "transport": { "type": "stdio", "command": "x" }, "auth": { "type": "api_key", "headerName": "X-Key" } }),
        ];
        for (i, entry) in valid.iter().enumerate() {
            assert!(validate_mcp_server_entry(entry, i).is_ok(), "{entry}");
        }
        let invalid = [
            json!({ "name": "a" }),
            json!({ "name": " ", "transport": { "type": "stdio", "command": "x" } }),
            json!({ "name": "a", "transport": { "type": "ws", "url": "x" } }),
            json!({ "name": "a", "transport": { "type": "stdio", "command": "  " } }),
            json!({ "name": "a", "transport": { "type": "http" } }),
            json!({ "name": "a", "transport": { "type": "stdio", "command": "x", "args": [1] } }),
            json!({ "name": "a", "transport": { "type": "stdio", "command": "x", "env": { "K": 1 } } }),
            json!({ "name": "a", "transport": { "type": "http", "url": "x" }, "enabled": "yes" }),
            json!({ "name": "a", "transport": { "type": "http", "url": "x" }, "auth": { "type": "magic" } }),
            json!({ "name": "a", "transport": { "type": "http", "url": "x" }, "auth": { "type": "api_key", "prefix": "" } }),
            json!("not-an-object"),
        ];
        for (i, entry) in invalid.iter().enumerate() {
            assert!(validate_mcp_server_entry(entry, i).is_err(), "{entry}");
        }
    }

    #[test]
    fn valid_mcp_servers_migrate_and_archive_agent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        write_json(
            &cwd.join(".agent/mcp-servers.json"),
            &json!({
                "servers": [
                    { "name": "good", "transport": { "type": "stdio", "command": "node" } }
                ]
            }),
        );

        let res = migrate_scope(workspace_scope(&cwd)).unwrap();
        assert!(res.warnings.is_empty(), "{:?}", res.warnings);
        assert_eq!(res.mcp_imported, 1);
        assert!(res.archived_path.is_some());
        let written: Value = serde_json::from_str(
            &fs::read_to_string(cwd.join(".cowork/mcp-servers.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(written["servers"][0]["name"], "good");
    }
}
