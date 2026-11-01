use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use uuid::Uuid;

use crate::context::{ToolError, ToolResult};
use crate::memory::slugify;

/// Per-invocation git timeout (TS `DEFAULT_TIMEOUT_MS`). A hanging hook or LFS smudge filter
/// must not block thread creation forever.
pub const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_millis(30_000);

#[cfg(unix)]
const PRIVATE_DIR_MODE: u32 = 0o700;

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
    git_timeout: Duration,
}

/// Rejects refs that git would parse as options (`--force`, `--lock`, ...) or that carry
/// control characters. Returns the trimmed ref (TS `assertSafeRef`).
pub fn assert_safe_ref(raw: &str) -> ToolResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidArguments(
            "Worktree ref must be non-empty".to_owned(),
        ));
    }
    if trimmed.starts_with('-') {
        return Err(ToolError::InvalidArguments(
            "Worktree ref must not start with '-'".to_owned(),
        ));
    }
    if trimmed.chars().any(|c| (c as u32) < 32 || c as u32 == 127) {
        return Err(ToolError::InvalidArguments(
            "Worktree ref contains control characters".to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

/// Lexical containment (TS `isPathInside`): `target` equal to or below `root`.
fn is_path_inside(root: &Path, target: &Path) -> bool {
    target.starts_with(root)
        && !target.strip_prefix(root).is_ok_and(|rel| {
            rel.components()
                .any(|c| c == std::path::Component::ParentDir)
        })
}

fn assert_managed_path(root: &Path, target: &Path) -> ToolResult<()> {
    if !is_path_inside(root, target) {
        return Err(ToolError::PathDenied(
            "Managed worktree path escaped ~/.cowork/worktrees".to_owned(),
        ));
    }
    Ok(())
}

/// TS `formatGitFailure`: prefer stderr, fall back to stdout, omit the detail when both are empty.
fn format_git_failure(args: &[&str], stderr: &str, stdout: &str) -> String {
    let detail = if stderr.is_empty() { stdout } else { stderr }.trim();
    if detail.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        format!("git {} failed: {detail}", args.join(" "))
    }
}

fn create_private_dir_all(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(PRIVATE_DIR_MODE);
    }
    builder.create(dir)
}

#[cfg(unix)]
fn harden_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    // Best-effort hardening only.
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(PRIVATE_DIR_MODE));
}

#[cfg(not(unix))]
fn harden_dir(_dir: &Path) {}

/// Kills the whole process group led by `pid` (git plus any hook / filter grandchildren).
#[cfg(unix)]
fn kill_process_group(pid: Option<u32>) {
    if let Some(pid) = pid.and_then(|p| libc::pid_t::try_from(p).ok())
        && pid > 0
    {
        // SAFETY: plain syscall; `pid` leads the group created via `process_group(0)`.
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: Option<u32>) {}

impl WorktreeService {
    pub fn new(homedir: PathBuf, env: HashMap<String, String>) -> Self {
        let cowork_home = env
            .get("COWORK_HOME_OVERRIDE")
            .map(PathBuf::from)
            .unwrap_or_else(|| homedir.join(".cowork"));
        Self {
            cowork_home,
            env,
            git_timeout: DEFAULT_GIT_TIMEOUT,
        }
    }

    pub fn with_cowork_home(cowork_home: PathBuf, env: HashMap<String, String>) -> Self {
        Self {
            cowork_home,
            env,
            git_timeout: DEFAULT_GIT_TIMEOUT,
        }
    }

    /// Overrides the per-invocation git timeout (default [`DEFAULT_GIT_TIMEOUT`]).
    pub fn with_git_timeout(mut self, timeout: Duration) -> Self {
        self.git_timeout = timeout;
        self
    }

    pub fn worktrees_root(&self) -> PathBuf {
        self.cowork_home.join("worktrees")
    }

    async fn run_git(&self, cwd: &Path, args: &[&str]) -> ToolResult<String> {
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Own process group so a timeout can take down hook / filter grandchildren too.
        #[cfg(unix)]
        cmd.process_group(0);
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        let child = cmd
            .spawn()
            .map_err(|e| ToolError::Execution(format!("Failed to execute git: {e}")))?;
        let pid = child.id();
        let out = match tokio::time::timeout(self.git_timeout, child.wait_with_output()).await {
            Ok(res) => {
                res.map_err(|e| ToolError::Execution(format!("Failed to execute git: {e}")))?
            }
            Err(_) => {
                // The timed-out future (and with it the child, via `kill_on_drop`) is dropped;
                // kill the rest of the group explicitly.
                kill_process_group(pid);
                return Err(ToolError::Execution(format!(
                    "git {} failed: timed out after {}ms",
                    args.join(" "),
                    self.git_timeout.as_millis()
                )));
            }
        };
        if !out.status.success() {
            return Err(ToolError::Execution(format_git_failure(
                args,
                &String::from_utf8_lossy(&out.stderr),
                &String::from_utf8_lossy(&out.stdout),
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    pub async fn detect_repo_root(&self, cwd: &Path) -> ToolResult<PathBuf> {
        let top = self.run_git(cwd, &["rev-parse", "--show-toplevel"]).await?;
        let p = PathBuf::from(top);
        Ok(fs::canonicalize(&p).unwrap_or(p))
    }

    /// TS `resolveCommit`: the ref must name an existing commit.
    async fn resolve_commit(&self, repo_root: &Path, safe_ref: &str) -> ToolResult<String> {
        let spec = format!("{safe_ref}^{{commit}}");
        self.run_git(repo_root, &["rev-parse", "--verify", &spec])
            .await
    }

    /// TS `validateBranchName`: [`assert_safe_ref`] plus `git check-ref-format --branch`.
    async fn validate_branch_name(&self, repo_root: &Path, raw: &str) -> ToolResult<String> {
        let branch_name = assert_safe_ref(raw)?;
        self.run_git(repo_root, &["check-ref-format", "--branch", &branch_name])
            .await?;
        Ok(branch_name)
    }

    pub async fn create_worktree(
        &self,
        opts: WorktreeCreateOptions,
    ) -> ToolResult<CreatedWorktree> {
        let repo_root = self.detect_repo_root(&opts.source_cwd).await?;
        let base_ref = assert_safe_ref(opts.base_ref.as_deref().unwrap_or("HEAD"))?;
        let base_commit = self.resolve_commit(&repo_root, &base_ref).await?;

        let short_id = &Uuid::new_v4().simple().to_string()[..8];
        let hint_slug = opts
            .title_hint
            .as_deref()
            .map(slugify)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "session".to_owned());

        let branch_name = match opts.branch_name.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(raw) => self.validate_branch_name(&repo_root, raw).await?,
            None => format!("cowork/{hint_slug}-{short_id}"),
        };

        let repo_slug = repo_root
            .file_name()
            .map(|n| slugify(&n.to_string_lossy()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "repo".to_owned());

        let wt_root = self.worktrees_root();
        create_private_dir_all(&wt_root).map_err(|e| {
            ToolError::Execution(format!(
                "Failed to create worktrees directory '{}': {e}",
                wt_root.display()
            ))
        })?;
        harden_dir(&wt_root);
        let canon_wt_root = fs::canonicalize(&wt_root).map_err(|e| {
            ToolError::Execution(format!(
                "Failed to resolve worktrees directory '{}': {e}",
                wt_root.display()
            ))
        })?;
        let worktree_dir = canon_wt_root.join(format!("{repo_slug}-{hint_slug}-{short_id}"));
        assert_managed_path(&canon_wt_root, &worktree_dir)?;
        let wt_str = worktree_dir.to_string_lossy().into_owned();

        self.run_git(
            &repo_root,
            &["worktree", "add", "-b", &branch_name, &wt_str, &base_commit],
        )
        .await?;
        let real_path = fs::canonicalize(&worktree_dir).map_err(|e| {
            ToolError::Execution(format!(
                "Failed to resolve worktree path '{}': {e}",
                worktree_dir.display()
            ))
        })?;
        assert_managed_path(&canon_wt_root, &real_path)?;

        Ok(CreatedWorktree {
            path: real_path,
            repo_root,
            branch_name,
            base_ref,
            base_commit,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ref_rules() {
        assert_eq!(assert_safe_ref("  main ").unwrap(), "main");
        assert!(assert_safe_ref("   ").is_err());
        assert!(assert_safe_ref("--force").is_err());
        assert!(assert_safe_ref("a\u{7f}b").is_err());
    }

    #[test]
    fn managed_path_containment() {
        let root = Path::new("/r/worktrees");
        assert!(is_path_inside(root, root));
        assert!(is_path_inside(root, Path::new("/r/worktrees/a")));
        assert!(!is_path_inside(root, Path::new("/r/worktrees2/a")));
        assert!(!is_path_inside(root, Path::new("/r/worktrees/../x")));
        assert!(!is_path_inside(root, Path::new("/r")));
        assert_eq!(
            assert_managed_path(root, Path::new("/elsewhere"))
                .unwrap_err()
                .to_string(),
            "Managed worktree path escaped ~/.cowork/worktrees"
        );
    }

    #[test]
    fn git_failure_formatting() {
        assert_eq!(format_git_failure(&["x"], "", "  "), "git x failed");
        assert_eq!(format_git_failure(&["x"], "", "out\n"), "git x failed: out");
        assert_eq!(
            format_git_failure(&["x"], " err ", "out"),
            "git x failed: err"
        );
    }
}
