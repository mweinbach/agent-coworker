//! Regression: workspace-scoped MCP credentials (`<workspace>/.cowork/auth/mcp-credentials.json`)
//! must never be readable by the model-facing read/grep/glob tools.

use std::fs;
use std::path::PathBuf;

use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, assert_read_path_allowed, create_builtin_tools};
use serde_json::json;
use uuid::Uuid;

const SECRET: &str = "sk-workspace-mcp-secret-token";

fn setup() -> (PathBuf, PathBuf, ToolExecutionContext) {
    let base = std::env::temp_dir().join(format!("cowork-tools-ws-auth-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(ws.join(".cowork").join("auth")).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    fs::write(
        ws.join(".cowork").join("auth").join("mcp-credentials.json"),
        format!(r#"{{"version":1,"servers":{{"s":{{"apiKey":"{SECRET}"}}}}}}"#),
    )
    .unwrap();
    fs::write(ws.join("notes.txt"), format!("public {SECRET}-lookalike\n")).unwrap();
    let ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    (home, ws, ctx)
}

#[tokio::test]
async fn read_grep_glob_never_expose_workspace_cowork_auth() {
    let (_home, ws, ctx) = setup();
    let tools = create_builtin_tools(&ctx);

    // Direct path check, including a case-variant spelling.
    let cred = ws.join(".cowork/auth/mcp-credentials.json");
    assert!(assert_read_path_allowed(&cred, &ctx).is_err());
    assert!(assert_read_path_allowed(&ws.join(".COWORK/Auth/mcp-credentials.json"), &ctx).is_err());
    assert!(assert_read_path_allowed(&ws.join(".cowork/auth"), &ctx).is_err());
    // Other workspace `.cowork` content stays readable.
    assert!(assert_read_path_allowed(&ws.join(".cowork/config.json"), &ctx).is_ok());

    // read tool (absolute and relative).
    for path in [
        cred.to_string_lossy().into_owned(),
        ".cowork/auth/mcp-credentials.json".to_owned(),
    ] {
        let err = tools["read"]
            .execute(
                serde_json::from_value(json!({ "filePath": path })).unwrap(),
                &ctx,
            )
            .await
            .expect_err("credential read must be denied");
        assert!(err.to_string().contains("protected credential"), "{err}");
    }

    // grep across the workspace skips the credential file instead of failing the search.
    let out = tools["grep"]
        .execute(
            serde_json::from_value(json!({ "pattern": SECRET })).unwrap(),
            &ctx,
        )
        .await
        .expect("workspace grep succeeds");
    let text = out.as_text().unwrap();
    assert!(text.contains("notes.txt"), "{text}");
    assert!(!text.contains("mcp-credentials"), "{text}");

    // grep rooted at `.cowork` also skips the auth subtree.
    let out = tools["grep"]
        .execute(
            serde_json::from_value(json!({ "pattern": SECRET, "path": ".cowork" })).unwrap(),
            &ctx,
        )
        .await
        .expect("grep under .cowork succeeds");
    assert!(!out.as_text().unwrap().contains(SECRET));

    // glob never lists the credential file.
    let out = tools["glob"]
        .execute(
            serde_json::from_value(json!({ "pattern": ".cowork/**/*.json" })).unwrap(),
            &ctx,
        )
        .await
        .expect("glob succeeds");
    assert!(!out.as_text().unwrap().contains("mcp-credentials"));
}
