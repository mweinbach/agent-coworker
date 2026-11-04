//! `glob` / `grep` parity with the TS tools (`src/tools/glob.ts` = fast-glob with `dot: false`
//! and no ignore files; `src/tools/grep.ts` = ripgrep defaults with `--glob fileGlob`), plus the
//! grep open-time symlink guard.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    outside: PathBuf,
    ctx: ToolExecutionContext,
}

fn fixture(git_repo: bool) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("workspace");
    let outside = tmp.path().join("outside");
    for dir in [&home, &ws, &outside] {
        fs::create_dir_all(dir).unwrap();
    }
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let outside = fs::canonicalize(outside).unwrap();
    if git_repo {
        fs::create_dir_all(ws.join(".git")).unwrap();
    }
    let files: &[(&str, &str)] = &[
        (".gitignore", "ignored/\n*.log\n"),
        ("a.ts", "needle top\n"),
        (".env", "needle env\n"),
        (".venv/x.ts", "needle venv\n"),
        ("ignored/y.ts", "needle ignored\n"),
        ("z.log", "needle log\n"),
        ("node_modules/p/n.ts", "needle nm\n"),
        ("src/b.ts", "l1\nneedle b\nl3\n"),
        ("src/.hidden.ts", "needle hidden\n"),
    ];
    for (rel, content) in files {
        let path = ws.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    let mut ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    // Reads outside the workspace (and its output/uploads dirs) are denied.
    ctx.read_roots = vec![ws.clone()];
    Fixture {
        _tmp: tmp,
        ws,
        outside,
        ctx,
    }
}

async fn run(ctx: &ToolExecutionContext, tool: &str, args: Value) -> Result<String, String> {
    let tools = create_builtin_tools(ctx);
    tools[tool]
        .execute(serde_json::from_value(args).unwrap(), ctx)
        .await
        .map(|out| out.as_text().unwrap())
        .map_err(|e| e.to_string())
}

fn lines(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.lines().collect();
    v.sort_unstable();
    v
}

// ---------------------------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn glob_skips_dotfiles_and_ignores_gitignore_like_fast_glob() {
    let fx = fixture(true);
    let all = run(&fx.ctx, "glob", json!({ "pattern": "**/*" }))
        .await
        .unwrap();
    assert_eq!(
        lines(&all),
        vec![
            "a.ts",
            "ignored/y.ts",
            "node_modules/p/n.ts",
            "src/b.ts",
            "z.log"
        ],
        "{all}"
    );

    let ts = run(&fx.ctx, "glob", json!({ "pattern": "**/*.ts" }))
        .await
        .unwrap();
    assert_eq!(
        lines(&ts),
        vec!["a.ts", "ignored/y.ts", "node_modules/p/n.ts", "src/b.ts"],
        "{ts}"
    );

    // `*.ts` has no globstar: only the search root (fast-glob, not gitignore basename matching).
    let top = run(&fx.ctx, "glob", json!({ "pattern": "*.ts" }))
        .await
        .unwrap();
    assert_eq!(top, "a.ts");

    // A pattern segment that starts with `.` opts into dot names.
    let dot = run(&fx.ctx, "glob", json!({ "pattern": ".*" }))
        .await
        .unwrap();
    assert_eq!(lines(&dot), vec![".env", ".gitignore"], "{dot}");
    let venv = run(&fx.ctx, "glob", json!({ "pattern": ".venv/**" }))
        .await
        .unwrap();
    assert_eq!(venv, ".venv/x.ts");
    let hidden = run(&fx.ctx, "glob", json!({ "pattern": "**/.*.ts" }))
        .await
        .unwrap();
    assert_eq!(hidden, "src/.hidden.ts");
}

#[tokio::test]
async fn glob_paths_are_relative_to_cwd_and_absolute_patterns_split_like_ts() {
    let fx = fixture(true);
    let out = run(&fx.ctx, "glob", json!({ "pattern": "*.ts", "cwd": "src" }))
        .await
        .unwrap();
    assert_eq!(out, "b.ts");

    let abs = format!("{}/src/*.ts", fx.ws.display());
    let out = run(&fx.ctx, "glob", json!({ "pattern": abs }))
        .await
        .unwrap();
    assert_eq!(out, "b.ts");

    let err = run(&fx.ctx, "glob", json!({ "pattern": "../*" }))
        .await
        .unwrap_err();
    assert!(err.contains("cannot escape cwd"), "{err}");

    // TS input schema is `.strict()` with `cwd`, not `path`.
    let err = run(&fx.ctx, "glob", json!({ "pattern": "*.ts", "path": "src" }))
        .await
        .unwrap_err();
    assert!(err.contains("Invalid tool arguments"), "{err}");

    let none = run(&fx.ctx, "glob", json!({ "pattern": "**/*.nope" }))
        .await
        .unwrap();
    assert_eq!(none, "No files found.");
}

#[tokio::test]
async fn glob_max_results_defaults_to_2000_and_keeps_the_newest() {
    let fx = fixture(true);
    let dir = fx.ws.join("many");
    fs::create_dir_all(&dir).unwrap();
    let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    for i in 0..5u64 {
        let path = dir.join(format!("f{i}.txt"));
        fs::write(&path, "x").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(base + Duration::from_secs(i)).unwrap();
    }
    let out = run(
        &fx.ctx,
        "glob",
        json!({ "pattern": "many/*.txt", "maxResults": 2 }),
    )
    .await
    .unwrap();
    assert_eq!(
        out, "many/f4.txt\nmany/f3.txt\n... truncated to 2 matches",
        "newest first, TS truncation suffix"
    );

    for bad in [0, 10_001] {
        let err = run(
            &fx.ctx,
            "glob",
            json!({ "pattern": "**/*", "maxResults": bad }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("Invalid tool arguments"), "{bad}: {err}");
    }
    let ok = run(
        &fx.ctx,
        "glob",
        json!({ "pattern": "many/*.txt", "maxResults": 10_000 }),
    )
    .await
    .unwrap();
    assert_eq!(ok.lines().count(), 5);

    // Default cap: 2000 (the old Rust tool stopped at 100).
    let bulk = fx.ws.join("bulk");
    fs::create_dir_all(&bulk).unwrap();
    for i in 0..2001 {
        fs::write(bulk.join(format!("{i}.md")), "").unwrap();
    }
    let out = run(&fx.ctx, "glob", json!({ "pattern": "bulk/*.md" }))
        .await
        .unwrap();
    assert_eq!(out.lines().count(), 2001, "2000 paths + truncation line");
    assert!(out.ends_with("\n... truncated to 2000 matches"), "{out}");
}

// ---------------------------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn grep_skips_hidden_and_gitignored_by_default_with_absolute_paths() {
    let fx = fixture(true);
    let ws = fx.ws.display().to_string();
    let out = run(&fx.ctx, "grep", json!({ "pattern": "needle" }))
        .await
        .unwrap();
    assert_eq!(
        lines(&out),
        vec![
            format!("{ws}/a.ts:1:needle top").as_str(),
            format!("{ws}/node_modules/p/n.ts:1:needle nm").as_str(),
            format!("{ws}/src/b.ts:2:needle b").as_str(),
        ],
        "{out}"
    );
    assert!(out.ends_with('\n'), "rg stdout is newline-terminated");
}

#[tokio::test]
async fn grep_file_glob_is_an_rg_override() {
    let fx = fixture(true);
    let ws = fx.ws.display().to_string();

    // `*.ts` matches files by basename: a hidden `.ts` file in a searched directory is included
    // (overrides beat the hidden rule), but hidden / ignored directories are not entered.
    let ts = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "needle", "fileGlob": "*.ts" }),
    )
    .await
    .unwrap();
    assert_eq!(
        lines(&ts),
        vec![
            format!("{ws}/a.ts:1:needle top").as_str(),
            format!("{ws}/node_modules/p/n.ts:1:needle nm").as_str(),
            format!("{ws}/src/.hidden.ts:1:needle hidden").as_str(),
            format!("{ws}/src/b.ts:2:needle b").as_str(),
        ],
        "{ts}"
    );

    // A gitignored file the glob names is searched.
    let log = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "needle", "fileGlob": "*.log" }),
    )
    .await
    .unwrap();
    assert_eq!(log, format!("{ws}/z.log:1:needle log\n"));

    // `**/*` whitelists everything (as `rg --glob '**/*'` does), except `.git` and credential
    // directories, which grep never enters.
    let all = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "needle", "fileGlob": "**/*" }),
    )
    .await
    .unwrap();
    for rel in [
        ".env",
        ".venv/x.ts",
        "ignored/y.ts",
        "z.log",
        "src/.hidden.ts",
        "a.ts",
    ] {
        assert!(all.contains(&format!("{ws}/{rel}:1:")), "{rel}: {all}");
    }
}

#[tokio::test]
async fn grep_ignores_gitignore_outside_a_git_repository_like_rg() {
    let fx = fixture(false);
    let out = run(&fx.ctx, "grep", json!({ "pattern": "needle" }))
        .await
        .unwrap();
    assert!(out.contains("/ignored/y.ts:1:"), "{out}");
    assert!(out.contains("/z.log:1:"), "{out}");
    // Hidden files stay skipped regardless.
    assert!(!out.contains("/.env:"), "{out}");
    assert!(!out.contains("/.venv/"), "{out}");
}

#[tokio::test]
async fn grep_single_file_context_up_to_50_and_no_match_cap() {
    let fx = fixture(true);
    let body: String = (1..=120)
        .map(|i| {
            if i == 1 || i == 120 {
                format!("hit {i}\n")
            } else {
                format!("line {i}\n")
            }
        })
        .collect();
    fs::write(fx.ws.join("ctx.txt"), body).unwrap();

    let out = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "hit", "path": "ctx.txt", "contextLines": 50 }),
    )
    .await
    .unwrap();
    let mut expected = String::from("1:hit 1\n");
    for i in 2..=51 {
        expected.push_str(&format!("{i}-line {i}\n"));
    }
    expected.push_str("--\n");
    for i in 70..=119 {
        expected.push_str(&format!("{i}-line {i}\n"));
    }
    expected.push_str("120:hit 120\n");
    assert_eq!(
        out, expected,
        "single explicit file: no filename, rg separators"
    );

    let err = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "hit", "path": "ctx.txt", "contextLines": 51 }),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Invalid tool arguments"), "{err}");

    // Context across files: rg separates the groups of different files with `--`.
    let ws = fx.ws.display().to_string();
    let out = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "needle (top|b)", "contextLines": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        format!(
            "{ws}/a.ts:1:needle top\n--\n{ws}/src/b.ts-1-l1\n{ws}/src/b.ts:2:needle b\n{ws}/src/b.ts-3-l3\n"
        )
    );

    // No 500-match cap.
    let many: String = (0..800).map(|i| format!("match {i}\n")).collect();
    fs::write(fx.ws.join("many.txt"), many).unwrap();
    let out = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "^match", "path": "many.txt" }),
    )
    .await
    .unwrap();
    assert_eq!(out.lines().count(), 800);

    let none = run(&fx.ctx, "grep", json!({ "pattern": "absent-zzz" }))
        .await
        .unwrap();
    assert_eq!(none, "No matches found.");
}

#[tokio::test]
async fn grep_timeout_bounds_match_ts() {
    let fx = fixture(true);
    let ok = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "needle", "path": "a.ts", "timeoutSeconds": 600 }),
    )
    .await
    .unwrap();
    assert_eq!(ok, "1:needle top\n");
    let err = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": "needle", "timeoutSeconds": 601 }),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Invalid tool arguments"), "{err}");
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_in_the_tree_pointing_outside_roots_are_not_followed() {
    use std::os::unix::fs::symlink;

    const SECRET: &str = "needle-outside-secret";
    let fx = fixture(true);
    fs::write(fx.outside.join("secret.txt"), format!("{SECRET}\n")).unwrap();
    fs::create_dir_all(fx.outside.join("dir")).unwrap();
    fs::write(fx.outside.join("dir/inner.ts"), format!("{SECRET}\n")).unwrap();
    symlink(fx.outside.join("secret.txt"), fx.ws.join("link.txt")).unwrap();
    symlink(fx.outside.join("secret.txt"), fx.ws.join("link.ts")).unwrap();
    symlink(fx.outside.join("dir"), fx.ws.join("linkdir")).unwrap();

    for args in [
        json!({ "pattern": SECRET }),
        json!({ "pattern": SECRET, "fileGlob": "**/*" }),
        json!({ "pattern": SECRET, "fileGlob": "*.ts" }),
    ] {
        let out = run(&fx.ctx, "grep", args.clone()).await.unwrap();
        assert_eq!(out, "No matches found.", "{args}");
    }

    let out = run(&fx.ctx, "glob", json!({ "pattern": "**/*" }))
        .await
        .unwrap();
    assert!(!out.contains("link"), "{out}");
    assert!(!out.contains("inner.ts"), "{out}");

    // An explicit path through the symlink resolves outside readRoots and is denied.
    let err = run(
        &fx.ctx,
        "grep",
        json!({ "pattern": SECRET, "path": "link.txt" }),
    )
    .await
    .unwrap_err();
    assert!(err.contains("outside configured readRoots"), "{err}");
}
