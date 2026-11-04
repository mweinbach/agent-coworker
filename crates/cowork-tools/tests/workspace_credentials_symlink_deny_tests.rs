//! Regression: the workspace MCP credential deny must survive symlinks. If `.cowork/auth`
//! (or `.cowork` itself) is a symlink to another readable workspace directory, or the
//! credential file is a symlink elsewhere, read/grep/glob must still refuse to expose it.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, assert_read_path_allowed, create_builtin_tools};
use serde_json::json;

const SECRET: &str = "sk-symlinked-workspace-mcp-secret";

fn ctx_for(base: &Path) -> (PathBuf, ToolExecutionContext) {
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    (ws, ctx)
}

fn write_secret(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!(r#"{{"version":1,"servers":{{"s":{{"apiKey":"{SECRET}"}}}}}}"#),
    )
    .unwrap();
}

async fn assert_tools_hide_secret(ctx: &ToolExecutionContext, read_paths: &[&str]) {
    let tools = create_builtin_tools(ctx);
    for path in read_paths {
        let err = tools["read"]
            .execute(
                serde_json::from_value(json!({ "filePath": path })).unwrap(),
                ctx,
            )
            .await
            .expect_err("credential read must be denied");
        assert!(
            err.to_string().contains("protected credential"),
            "{path}: {err}"
        );
    }

    let out = tools["grep"]
        .execute(
            serde_json::from_value(json!({ "pattern": SECRET })).unwrap(),
            ctx,
        )
        .await
        .expect("workspace grep succeeds");
    let text = out.as_text().unwrap();
    assert!(!text.contains(SECRET), "{text}");
    assert!(!text.contains("mcp-credentials"), "{text}");

    let out = tools["glob"]
        .execute(
            serde_json::from_value(json!({ "pattern": "**/*.json" })).unwrap(),
            ctx,
        )
        .await
        .expect("glob succeeds");
    let text = out.as_text().unwrap();
    assert!(!text.contains("mcp-credentials"), "{text}");
}

#[tokio::test]
async fn auth_dir_symlinked_to_readable_workspace_dir_is_denied() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    write_secret(&ws.join("data").join("mcp-credentials.json"));
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    symlink(ws.join("data"), ws.join(".cowork").join("auth")).unwrap();

    assert!(assert_read_path_allowed(&ws.join("data/mcp-credentials.json"), &ctx).is_err());
    assert!(assert_read_path_allowed(&ws.join(".cowork/auth/mcp-credentials.json"), &ctx).is_err());
    assert!(assert_read_path_allowed(&ws.join("notes.txt"), &ctx).is_ok());

    assert_tools_hide_secret(
        &ctx,
        &[
            "data/mcp-credentials.json",
            ".cowork/auth/mcp-credentials.json",
        ],
    )
    .await;
}

#[tokio::test]
async fn cowork_dir_symlinked_to_readable_workspace_dir_is_denied() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    write_secret(&ws.join("cfg").join("auth").join("mcp-credentials.json"));
    fs::write(ws.join("cfg").join("config.json"), "{}").unwrap();
    symlink(ws.join("cfg"), ws.join(".cowork")).unwrap();

    assert!(assert_read_path_allowed(&ws.join("cfg/auth/mcp-credentials.json"), &ctx).is_err());
    // Non-credential content of the (symlinked) `.cowork` stays readable.
    assert!(assert_read_path_allowed(&ws.join("cfg/config.json"), &ctx).is_ok());

    assert_tools_hide_secret(
        &ctx,
        &[
            "cfg/auth/mcp-credentials.json",
            ".cowork/auth/mcp-credentials.json",
        ],
    )
    .await;
}

#[tokio::test]
async fn credential_file_symlinked_outside_auth_dir_is_denied_by_lexical_path() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    // The real file lives outside the workspace; only the `.cowork/auth` spelling is a
    // credential path, so the lexical check (not the canonical one) must catch it.
    let outside = tmp.path().join("elsewhere").join("creds.json");
    write_secret(&outside);
    fs::create_dir_all(ws.join(".cowork").join("auth")).unwrap();
    symlink(
        &outside,
        ws.join(".cowork").join("auth").join("mcp-credentials.json"),
    )
    .unwrap();

    assert!(assert_read_path_allowed(&ws.join(".cowork/auth/mcp-credentials.json"), &ctx).is_err());
    assert_tools_hide_secret(&ctx, &[".cowork/auth/mcp-credentials.json"]).await;
}
