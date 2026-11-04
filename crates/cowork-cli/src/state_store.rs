use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use cowork_config::{
    canonicalize_sync, ensure_private_dir_sync, get_ai_coworker_paths, harden_private_file_sync,
    write_text_file_atomic,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CliStateFile {
    version: u8,
    last_session_by_cwd: BTreeMap<String, String>,
}

impl Default for CliStateFile {
    fn default() -> Self {
        Self {
            version: 1,
            last_session_by_cwd: BTreeMap::new(),
        }
    }
}

pub fn cli_state_file_path(homedir: &Path, env: &HashMap<String, String>) -> PathBuf {
    let paths = get_ai_coworker_paths(Some(homedir), env);
    paths.root_dir.join("state").join("cli-state.json")
}

pub fn repl_history_file_path(homedir: &Path, env: &HashMap<String, String>) -> PathBuf {
    let paths = get_ai_coworker_paths(Some(homedir), env);
    paths.root_dir.join("state").join("repl_history.txt")
}

fn read_cli_state(homedir: &Path, env: &HashMap<String, String>) -> CliStateFile {
    let path = cli_state_file_path(homedir, env);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return CliStateFile::default();
    };
    let Ok(parsed) = serde_json::from_str::<CliStateFile>(&raw) else {
        return CliStateFile::default();
    };
    if parsed.version != 1 {
        return CliStateFile::default();
    }
    let mut normalized = BTreeMap::new();
    for (cwd, sid) in parsed.last_session_by_cwd {
        let trimmed_cwd = cwd.trim();
        let trimmed_sid = sid.trim();
        if !trimmed_cwd.is_empty() && !trimmed_sid.is_empty() {
            let key = canonicalize_sync(Path::new(trimmed_cwd))
                .to_string_lossy()
                .into_owned();
            normalized.insert(key, trimmed_sid.to_owned());
        }
    }
    CliStateFile {
        version: 1,
        last_session_by_cwd: normalized,
    }
}

/// Reads the last active thread ID persisted for `cwd` in `<coworkHome>/state/cli-state.json`.
pub fn get_stored_session_for_cwd(
    homedir: &Path,
    env: &HashMap<String, String>,
    cwd: &Path,
) -> Option<String> {
    let state = read_cli_state(homedir, env);
    let key = canonicalize_sync(cwd).to_string_lossy().into_owned();
    state
        .last_session_by_cwd
        .get(&key)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Atomically persists the active thread ID for `cwd` into `<coworkHome>/state/cli-state.json` (`0600`).
pub fn set_stored_session_for_cwd(
    homedir: &Path,
    env: &HashMap<String, String>,
    cwd: &Path,
    session_id: &str,
) -> anyhow::Result<()> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let mut state = read_cli_state(homedir, env);
    let key = canonicalize_sync(cwd).to_string_lossy().into_owned();
    state.last_session_by_cwd.insert(key, trimmed.to_owned());

    let path = cli_state_file_path(homedir, env);
    if let Some(parent) = path.parent() {
        ensure_private_dir_sync(parent)?;
    }
    let payload = format!("{}\n", serde_json::to_string_pretty(&state)?);
    write_text_file_atomic(&path, &payload, Some(0o600))?;
    harden_private_file_sync(&path);
    Ok(())
}
