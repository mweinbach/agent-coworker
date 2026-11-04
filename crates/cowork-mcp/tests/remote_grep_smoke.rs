//! Live remote MCP smoke test against the public grep.app Streamable HTTP server.
//!
//! Network access makes this opt-in: CI's "Remote MCP smoke" job sets
//! `RUN_REMOTE_MCP_TESTS=1`; local and offline runs return early.

use std::collections::HashMap;

use cowork_mcp::{
    HydratedMcpServer, McpAuthScope, McpConfigSource, McpServerConfig, McpServerTransport,
    load_mcp_tools,
};

fn remote_smoke_enabled() -> bool {
    matches!(
        std::env::var("RUN_REMOTE_MCP_TESTS").as_deref(),
        Ok("1" | "true" | "yes")
    )
}

#[tokio::test]
async fn connects_to_grep_app_over_streamable_http_and_discovers_search_tool() {
    if !remote_smoke_enabled() {
        eprintln!("RUN_REMOTE_MCP_TESTS is not set; live remote MCP smoke not requested");
        return;
    }

    let servers = [HydratedMcpServer {
        config: McpServerConfig {
            name: "grep".to_owned(),
            transport: McpServerTransport::Http {
                url: "https://mcp.grep.app".to_owned(),
                headers: None,
            },
            enabled: None,
            required: Some(true),
            retries: Some(2),
            auth: None,
            icon: None,
        },
        source: McpConfigSource::User,
        auth_scope: McpAuthScope::User,
        oauth_context: None,
    }];

    let mut logs = Vec::new();
    let (tools, errors) = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        load_mcp_tools(&servers, &HashMap::new(), |line| logs.push(line)),
    )
    .await
    .expect("remote MCP connect timed out")
    .unwrap_or_else(|err| panic!("remote MCP connect failed: {err}\nlogs: {logs:#?}"));

    assert!(errors.is_empty(), "unexpected MCP errors: {errors:?}");
    let search = tools
        .iter()
        .find(|tool| tool.server_name == "grep" && tool.raw_tool_name == "searchGitHub")
        .unwrap_or_else(|| {
            let names: Vec<_> = tools.iter().map(|tool| &tool.qualified_name).collect();
            panic!("grep.app did not advertise searchGitHub; got {names:?}")
        });
    assert!(
        search.input_schema.is_object(),
        "searchGitHub must expose an object input schema"
    );

    for tool in &tools {
        tool.invoker.close().await;
    }
}
