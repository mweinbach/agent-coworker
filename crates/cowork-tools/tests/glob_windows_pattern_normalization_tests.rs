//! `glob` pattern preprocessing parity with TS `normalizeGlobPattern` / `splitAbsoluteGlob`
//! (`src/platform/paths.ts`, used by `src/tools/glob.ts`):
//!
//! * On Windows `\` is always a separator, so `src\**\*.ts` is `src/**/*.ts`. On POSIX a
//!   plain pattern keeps fast-glob escapes (`\*` is a literal `*`); only Windows-SHAPED
//!   patterns (drive-qualified `C:\`, UNC `\\server`) are rewritten there.
//! * Absolute patterns split into a search root plus a relative rest, with drive-qualified
//!   roots (`C:/`, never drive-relative `C:`) and UNC roots (`//server/share`) preserved.
//!
//! The pure functions take the path flavor as a parameter, so both flavors run on every host;
//! the Windows end-to-end checks through the tool are `cfg(windows)`.

use std::fs;
use std::path::PathBuf;

use cowork_config::ProviderName;
use cowork_tools::context::PathFlavor;
use cowork_tools::search_tools::{normalize_glob_pattern, split_absolute_glob};
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::{Value, json};

const WIN: PathFlavor = PathFlavor::Windows;
const POSIX: PathFlavor = PathFlavor::Posix;
const FLAVORS: [PathFlavor; 2] = [POSIX, WIN];

fn split(pattern: &str, flavor: PathFlavor) -> Option<(String, String)> {
    split_absolute_glob(pattern, flavor)
}

fn at(root: &str, rest: &str) -> Option<(String, String)> {
    Some((root.to_owned(), rest.to_owned()))
}

// ---------------------------------------------------------------------------------------------
// normalize_glob_pattern
// ---------------------------------------------------------------------------------------------

#[test]
fn windows_flavor_backslashes_are_separators() {
    assert_eq!(normalize_glob_pattern(r"src\**\*.ts", WIN), "src/**/*.ts");
    assert_eq!(normalize_glob_pattern(r"src\*.ts", WIN), "src/*.ts");
    assert_eq!(normalize_glob_pattern(r"C:\a\**", WIN), "C:/a/**");
    assert_eq!(normalize_glob_pattern("src/*.ts", WIN), "src/*.ts");
    // Never an escape on Windows.
    assert_eq!(normalize_glob_pattern(r"\*", WIN), "/*");
}

#[test]
fn posix_flavor_plain_patterns_keep_backslash_escapes() {
    for pattern in [
        r"\*.ts",
        r"src\*.ts",
        r"\*",
        r"a\{b,c\}",
        r"src/\*literal\?/*.ts",
        r"src\**\*.ts",
        "src/**/*.ts",
    ] {
        assert_eq!(normalize_glob_pattern(pattern, POSIX), pattern);
    }
}

#[test]
fn windows_shaped_patterns_are_rewritten_on_every_flavor() {
    for flavor in FLAVORS {
        assert_eq!(
            normalize_glob_pattern(r"C:\src\**\*.ts", flavor),
            "C:/src/**/*.ts"
        );
        assert_eq!(
            normalize_glob_pattern(r"c:/a\b\*.ts", flavor),
            "c:/a/b/*.ts"
        );
        assert_eq!(
            normalize_glob_pattern(r"\\srv\share\**", flavor),
            "//srv/share/**"
        );
        assert_eq!(normalize_glob_pattern(r"!C:\a\*", flavor), "!C:/a/*");
    }
    // `\\\` and `\\/` are not UNC-shaped, so POSIX keeps them as escapes.
    assert_eq!(normalize_glob_pattern(r"\\\x", POSIX), r"\\\x");
    // Drive-relative `C:foo\*` is not Windows-shaped either.
    assert_eq!(normalize_glob_pattern(r"C:foo\*", POSIX), r"C:foo\*");
}

// ---------------------------------------------------------------------------------------------
// split_absolute_glob
// ---------------------------------------------------------------------------------------------

#[test]
fn windows_flavor_drive_absolute_patterns_split_into_drive_qualified_roots() {
    assert_eq!(
        split(r"C:\workspace\src\**\*.ts", WIN),
        at("C:/workspace/src", "**/*.ts")
    );
    assert_eq!(split(r"C:\a\*.ts", WIN), at("C:/a", "*.ts"));
    // The drive root stays drive-QUALIFIED, never drive-relative `C:`.
    assert_eq!(split(r"C:\*.ts", WIN), at("C:/", "*.ts"));
    assert_eq!(split("c:/deep/dir/**", WIN), at("c:/deep/dir", "**"));
    // Mixed separators.
    assert_eq!(split(r"D:/ws\src/*.rs", WIN), at("D:/ws/src", "*.rs"));
}

#[test]
fn windows_flavor_unc_absolute_patterns_keep_the_unc_root() {
    assert_eq!(split(r"\\srv\share\**", WIN), at("//srv/share", "**"));
    assert_eq!(
        split(r"\\srv\share\logs\*.log", WIN),
        at("//srv/share/logs", "*.log")
    );
    assert_eq!(
        split("//srv/share/logs/*.log", WIN),
        at("//srv/share/logs", "*.log")
    );
}

#[test]
fn windows_flavor_relative_backslash_patterns_stay_relative() {
    assert_eq!(split(r"src\**\*.ts", WIN), None);
    assert_eq!(split(r"sub\*.ts", WIN), None);
    // A rooted-without-drive `\x\*.ts` is rooted at the current drive.
    assert_eq!(split(r"\x\*.ts", WIN), at("/x", "*.ts"));
}

#[test]
fn windows_shaped_patterns_split_on_the_posix_flavor_too() {
    assert_eq!(split(r"C:\a\*.ts", POSIX), at("C:/a", "*.ts"));
    assert_eq!(split(r"C:\src\**\*.ts", POSIX), at("C:/src", "**/*.ts"));
    assert_eq!(split(r"\\srv\share\**", POSIX), at("//srv/share", "**"));
}

#[test]
fn posix_flavor_absolute_patterns_keep_backslash_escapes_in_the_rest() {
    for flavor in FLAVORS {
        assert_eq!(split("/a/b/**/*.ts", flavor), at("/a/b", "**/*.ts"));
        assert_eq!(split("/*.ts", flavor), at("/", "*.ts"));
        assert_eq!(split("/a/b/c", flavor), at("/a/b", "c"));
        assert_eq!(split("/*/x", flavor), at("/", "*/x"));
    }
    // POSIX: `\*` is an escape, so it stays in the rest pattern verbatim.
    assert_eq!(split(r"/ws/\*.ts", POSIX), at("/ws", r"\*.ts"));
    // Windows: the same backslash is a separator.
    assert_eq!(split(r"/ws/\*.ts", WIN), at("/ws/", "*.ts"));
}

#[test]
fn relative_negated_and_empty_patterns_do_not_split() {
    for flavor in FLAVORS {
        for pattern in [
            "src/**/*.ts",
            "*.ts",
            "!/a/*.ts",
            "!C:/src/*.ts",
            r"!C:\src\*.ts",
            "",
        ] {
            assert_eq!(split(pattern, flavor), None, "{pattern:?}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// End to end through the glob tool
// ---------------------------------------------------------------------------------------------

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    ctx: ToolExecutionContext,
}

fn fixture(files: &[&str]) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    for rel in files {
        let path = ws.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }
    let ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    Fixture { _tmp: tmp, ws, ctx }
}

async fn glob(ctx: &ToolExecutionContext, args: Value) -> Result<String, String> {
    let tools = create_builtin_tools(ctx);
    tools["glob"]
        .execute(serde_json::from_value(args).unwrap(), ctx)
        .await
        .map(|out| out.as_text().unwrap())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tokio::test]
async fn posix_relative_backslash_is_an_escape_not_a_separator() {
    let fx = fixture(&["sub/inner.ts", "*.ts", "plain.ts"]);
    // `\*` matches only the literal `*.ts`.
    assert_eq!(
        glob(&fx.ctx, json!({ "pattern": r"\*.ts" })).await.unwrap(),
        "*.ts"
    );
    // `sub\*.ts` is one segment (`sub*.ts` literally), so `sub/inner.ts` does not match.
    assert_eq!(
        glob(&fx.ctx, json!({ "pattern": r"sub\*.ts" }))
            .await
            .unwrap(),
        "No files found."
    );
    // Absolute POSIX patterns keep the escape in the rest pattern.
    let abs = format!(r"{}/\*.ts", fx.ws.display());
    assert_eq!(
        glob(&fx.ctx, json!({ "pattern": abs })).await.unwrap(),
        "*.ts"
    );
}

/// `fs::canonicalize` on Windows yields a verbatim `\\?\C:\...` path; a user types `C:\...`.
#[cfg(windows)]
fn plain_windows_path(path: &std::path::Path) -> String {
    let raw = path.display().to_string();
    raw.strip_prefix(r"\\?\")
        .filter(|rest| rest.as_bytes().get(1) == Some(&b':'))
        .map(str::to_owned)
        .unwrap_or(raw)
}

#[cfg(windows)]
#[tokio::test]
async fn windows_backslash_absolute_patterns_resolve_into_root_and_rest() {
    let fx = fixture(&["src/deep/match.ts", "src/deep/skip.rs"]);
    let ws = plain_windows_path(&fx.ws);
    let res = glob(&fx.ctx, json!({ "pattern": format!(r"{ws}\src\**\*.ts") }))
        .await
        .unwrap();
    assert_eq!(res, "deep/match.ts");
    let res = glob(
        &fx.ctx,
        json!({ "pattern": format!("{}/src/**/*.ts", ws.replace('\\', "/")) }),
    )
    .await
    .unwrap();
    assert_eq!(res, "deep/match.ts");
}

#[cfg(windows)]
#[tokio::test]
async fn windows_relative_backslash_patterns_are_separators() {
    let fx = fixture(&["sub/inner.ts", "sub/deep/nested.ts", "top.ts"]);
    assert_eq!(
        glob(&fx.ctx, json!({ "pattern": r"sub\*.ts" }))
            .await
            .unwrap(),
        "sub/inner.ts"
    );
    let mut matched: Vec<String> = glob(&fx.ctx, json!({ "pattern": r"sub\**\*.ts" }))
        .await
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    matched.sort();
    assert_eq!(matched, ["sub/deep/nested.ts", "sub/inner.ts"]);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_unc_patterns_are_split_then_denied_outside_the_roots() {
    let fx = fixture(&["a.ts"]);
    let err = glob(
        &fx.ctx,
        json!({ "pattern": r"\\attacker.example\share\**\*.ts" }),
    )
    .await
    .unwrap_err();
    assert!(!err.contains("pattern must be relative to cwd"), "{err}");
}
