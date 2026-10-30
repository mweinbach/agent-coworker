//! `cowork-mcp` — Tools, MCP & Harness Orchestration Layer.
//!
//! Module boundaries owned by this crate:
//! - **MCP client transports**: Native `stdio` (process-group managed), legacy `SSE`, and
//!   `StreamableHTTP` (`Mcp-Session-Id`) protocol transports.
//! - **4-layer config registry**: Merges `System < User < Plugin < Workspace` MCP server configs
//!   gated by workspace trust checks before executing project `stdio` commands.
//! - **RFC 9728 / RFC 8414 OAuth 2.1 PKCE**: Protected resource metadata discovery, dynamic client
//!   registration, dual-stack loopback PKCE callbacks, and `0600` token persistence.
//! - **Schema normalization & shared cache**: Tuple-array JSON Schema normalizer and generation-
//!   refcounted `WorkspaceMcpToolCache` backing `toolSearch` and `mcpCall`.

use serde::{Deserialize, Serialize};

/// Supported MCP transport protocols.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpTransportKind {
    Stdio,
    Sse,
    StreamableHttp,
}

/// 4-layer MCP configuration precedence from lowest to highest priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpConfigLayer {
    System,
    User,
    Plugin,
    Workspace,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_layers_and_transports_match_contract() {
        assert!(McpConfigLayer::System < McpConfigLayer::User);
        assert!(McpConfigLayer::User < McpConfigLayer::Plugin);
        assert!(McpConfigLayer::Plugin < McpConfigLayer::Workspace);
        assert_eq!(
            serde_json::to_string(&McpTransportKind::StreamableHttp).unwrap(),
            "\"streamable-http\""
        );
    }
}
