use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use uuid::Uuid;

use crate::context::{ToolError, ToolResult};
use crate::memory::slugify;

#[derive(Debug, Clone)]
pub struct WorktreeCreateOptions {
    pub source_cwd: PathBuf,
    pub base_ref: Option<String>,
    pub branch_name: Option<String>,
    pub title_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub path: PathBuf,
    pub repo_root: PathBuf,
    pub branch_name: String,
    pub base_ref: String,
    pub base_commit: String,
}

#[derive(Debug, Clone)]
pub struct WorktreeService {
    cowork_home: PathBuf,
    env: HashMap<String, String>,
}

impl WorktreeService {
    pub fn new(homedir: PathBuf, env: HashMap<String, String>) -> Self {
        let cowork_home = env
            .get("COWORK_HOME_OVERRIDE")
            .map(PathBuf::from)
            .unwrap_or_else(|| homedir.join(".cowork"));
        Self { cowork_home, env }
    }

    pub fn with_cowork_home(cowork_home: PathBuf, env: HashMap<String, String>) -> Self {
        Self { cowork_home, env }
    }

    pub fn worktrees_root(&self) -> PathBuf {
        self.cowork_home.join("worktrees")
    }

    async fn run_git(&self, cwd: &Path, args: &[&str]) -> ToolResult<String> {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(cwd).kill_on_drop(true);
        if !self.env.is_empty() {
            for (k, v) in &self.env {
                cmd.env(k, v);
            }
        }
        let out = cmd
            .output()
            .await
            .map_err(|e| ToolError::Execution(format!("Failed to execute git: {e}")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
            return Err(ToolError::Execution(format!(
                "git {} failed: {}",
                args.join(" "),
                stderr
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    pub async fn detect_repo_root(&self, cwd: &Path) -> ToolResult<PathBuf> {
        let top = self.run_git(cwd, &["rev-parse", "--show-toplevel"]).await?;
        let p = PathBuf::from(top);
        Ok(fs::canonicalize(&p).unwrap_or(p))
    }

    pub async fn create_worktree(
        &self,
        opts: WorktreeCreateOptions,
    ) -> ToolResult<CreatedWorktree> {
        let repo_root = self.detect_repo_root(&opts.source_cwd).await?;
        let base_ref = opts
            .base_ref
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("HEAD")
            .to_owned();

        let short_id = &Uuid::new_v4().simple().to_string()[..8];
        let hint_slug = opts
            .title_hint
            .as_deref()
            .map(slugify)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "session".to_owned());

        let branch_name = opts
            .branch_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("cowork/{hint_slug}-{short_id}"));

        let repo_slug = repo_root
            .file_name()
            .map(|n| slugify(&n.to_string_lossy()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "repo".to_owned());

        let wt_root = self.worktrees_root();
        fs::create_dir_all(&wt_root).map_err(|e| {
            ToolError::Execution(format!(
                "Failed to create worktrees directory '{}': {e}",
                wt_root.display()
            ))
        })?;
        let canon_wt_root = fs::canonicalize(&wt_root).unwrap_or(wt_root);
        let worktree_dir = canon_wt_root.join(format!("{repo_slug}-{hint_slug}-{short_id}"));
        let wt_str = worktree_dir.to_string_lossy().into_owned();

        self.run_git(
            &repo_root,
            &["worktree", "add", "-b", &branch_name, &wt_str, &base_ref],
        )
        .await?;
        let base_commit = self
            .run_git(&worktree_dir, &["rev-parse", "HEAD"])
            .await
            .unwrap_or_else(|_| base_ref.clone());

        Ok(CreatedWorktree {
            path: worktree_dir,
            repo_root,
            branch_name,
            base_ref,
            base_commit,
        })
    }
}
