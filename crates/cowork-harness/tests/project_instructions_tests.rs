//! Regression tests for hierarchical project instruction loading (AGENTS files).

use std::fs;
use std::path::PathBuf;

use cowork_harness::collect_project_instructions;
use uuid::Uuid;

const BUDGET: usize = 32 * 1024;

struct TempRepo {
    root: PathBuf,
}

impl TempRepo {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("cowork-project-instructions-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".git")).unwrap();
        Self {
            root: fs::canonicalize(root).unwrap(),
        }
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn override_supersedes_agents_md_in_same_directory() {
    let repo = TempRepo::new();
    fs::write(repo.root.join("AGENTS.override.md"), "OVERRIDE wins").unwrap();
    fs::write(repo.root.join("AGENTS.md"), "SUPERSEDED agents").unwrap();
    fs::write(repo.root.join("CLAUDE.md"), "SUPERSEDED claude").unwrap();

    let out = collect_project_instructions(&repo.root).unwrap();
    assert!(out.contains("OVERRIDE wins"), "{out}");
    assert!(!out.contains("SUPERSEDED"), "{out}");
}

#[test]
fn each_directory_contributes_its_own_highest_precedence_file() {
    let repo = TempRepo::new();
    let sub = repo.root.join("pkg");
    fs::create_dir_all(&sub).unwrap();
    fs::write(repo.root.join("AGENTS.md"), "ROOT agents").unwrap();
    fs::write(repo.root.join("CLAUDE.md"), "ROOT claude superseded").unwrap();
    fs::write(sub.join("CLAUDE.md"), "PKG claude fallback").unwrap();

    let out = collect_project_instructions(&sub).unwrap();
    assert!(out.contains("ROOT agents"));
    assert!(!out.contains("ROOT claude superseded"));
    assert!(out.contains("PKG claude fallback"));
    assert!(out.find("ROOT agents").unwrap() < out.find("PKG claude fallback").unwrap());
}

#[test]
fn large_root_instructions_do_not_evict_working_directory_instructions() {
    let repo = TempRepo::new();
    let mid = repo.root.join("mid");
    let cwd = mid.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    fs::write(repo.root.join("AGENTS.md"), "R".repeat(BUDGET)).unwrap();
    fs::write(mid.join("AGENTS.md"), "MID instructions").unwrap();
    fs::write(cwd.join("AGENTS.md"), "CWD instructions").unwrap();

    let out = collect_project_instructions(&cwd).unwrap();
    assert!(out.len() <= BUDGET, "rendered {} bytes", out.len());
    assert!(out.starts_with("... (truncated: kept the most specific project instructions"));
    assert!(out.contains("CWD instructions"), "{out}");
    assert!(out.contains("MID instructions"), "{out}");
    assert!(
        !out.contains("RRRR"),
        "root file should be dropped, not partially injected"
    );
    assert!(out.find("MID instructions").unwrap() < out.find("CWD instructions").unwrap());
}

#[test]
fn oversized_working_directory_file_is_truncated_with_marker() {
    let repo = TempRepo::new();
    fs::write(repo.root.join("AGENTS.md"), "x".repeat(BUDGET * 2)).unwrap();

    let out = collect_project_instructions(&repo.root).unwrap();
    assert!(out.len() <= BUDGET, "rendered {} bytes", out.len());
    assert!(out.ends_with("… (truncated: project instructions exceeded byte limit)"));
}

#[test]
fn small_hierarchy_renders_untruncated_in_root_first_order() {
    let repo = TempRepo::new();
    let sub = repo.root.join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(repo.root.join("AGENTS.md"), "ROOT").unwrap();
    fs::write(sub.join("AGENTS.md"), "SUB").unwrap();

    let out = collect_project_instructions(&sub).unwrap();
    assert!(!out.contains("truncated"));
    assert!(out.find("ROOT").unwrap() < out.find("SUB").unwrap());
}
