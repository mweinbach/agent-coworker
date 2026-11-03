//! `cowork-mcp` — Native MCP Client Transports, 4-Layer Config Registry, RFC 9728/8414 OAuth 2.1 PKCE,
//! Tuple-Safe JSON Schema Normalizer & Generation-Refcounted `WorkspaceMcpToolCache`.

pub mod cache;
pub mod credentials;
pub mod oauth;
pub mod plugin_overrides;
pub mod registry;
pub mod schema;
pub mod transports;
pub mod types;

pub use cache::WorkspaceMcpToolCache;
pub use credentials::{
    McpCredentialsFile, auth_scope_for_source, compute_auth_state, credentials_path_for_scope,
    mask_secret, mutate_credentials_for_scope, read_credentials_file, read_credentials_for_scope,
    try_read_credentials_file, try_read_credentials_for_scope,
};
pub use oauth::{
    McpOAuthUrlOpener, SystemUrlOpener, complete_mcp_oauth_callback, refresh_oauth_access_token,
    start_mcp_oauth_authorization, start_mcp_oauth_authorization_with_opener,
    wait_and_complete_auto_mcp_oauth,
};
pub use plugin_overrides::{
    DiscoveredPluginRoot, PluginEnableOverride, PluginOverridesFile, PluginScope,
    discover_installed_plugin_roots, mutate_plugin_overrides, plugin_mcp_override_key,
    plugin_overrides_path, plugin_skill_override_key, read_plugin_overrides,
};
pub use registry::{
    delete_mcp_server, layer_file_path, load_mcp_servers, read_mcp_servers_snapshot,
    resolve_target_mcp_server, set_mcp_server_api_key, set_mcp_server_enabled, upsert_mcp_server,
};
pub use schema::{
    DESCRIPTION_TRUNCATION_SUFFIX, MAX_MCP_DESCRIPTION_CHARS, build_mcp_tool_name,
    normalize_mcp_json_schema, normalize_mcp_name, truncate_mcp_description,
};
pub use transports::{load_mcp_tools, validate_mcp_server, validate_mcp_server_with_env};
pub use types::{
    HydratedMcpServer, LoadedMcpTool, McpAuthMode, McpAuthMutationResult, McpAuthScope,
    McpAuthStatus, McpConfigFileSummary, McpConfigLayer, McpConfigSource, McpOAuthChallengePayload,
    McpOAuthChallengeResult, McpOAuthRuntimeContext, McpServerAuthConfig, McpServerAuthState,
    McpServerCatalogEntry, McpServerConfig, McpServerTransport, McpServersSnapshot,
    McpToolErrorEntry, McpToolInvoker, McpTransportKind, McpValidatedToolSummary,
    McpValidationResult,
};

/// Configuration discovery runs before workspace MCP trust is evaluated. Reject special files
/// without consuming a device stream or waiting for a writer on a repository-controlled FIFO.
fn read_config_file(path: &std::path::Path) -> std::io::Result<String> {
    use std::{fs, io};

    let not_regular = || io::Error::new(io::ErrorKind::InvalidData, "expected a regular file");
    if !fs::metadata(path)?.is_file() {
        return Err(not_regular());
    }
    let mut options = fs::File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(path)?;
    // Recheck the open handle in case the path changed after the initial metadata lookup.
    if !file.metadata()?.is_file() {
        return Err(not_regular());
    }
    io::read_to_string(file)
}

/// Whether `path` itself is a symbolic link (or, on Windows, any reparse point such as a
/// junction). Missing paths are not links.
fn is_link(path: &std::path::Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Ok(true);
                }
            }
            Ok(meta.file_type().is_symlink())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Refuses a workspace-scoped MCP file (`<workspace>/.cowork/mcp-servers.json`,
/// `.cowork/plugins.json`, `.cowork/auth/mcp-credentials.json`) whose path traverses a symbolic
/// link at or below the workspace `.cowork` directory.
///
/// A cloned repository controls everything under its `.cowork/`; a link there could make a
/// workspace read expose the user's global `~/.cowork` credentials (even with
/// `trustWorkspaceMcp` off), or make a workspace disable/delete rewrite global files.
/// Components above `.cowork` (the workspace path itself, e.g. macOS `/tmp`) are not checked.
pub(crate) fn ensure_unlinked_workspace_path(
    workspace_cowork_dir: &std::path::Path,
    path: &std::path::Path,
) -> std::io::Result<()> {
    use std::io;

    let refuse = |what: &std::path::Path| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "refusing to follow a symbolic link in workspace MCP path {} (at {})",
                path.display(),
                what.display()
            ),
        )
    };
    let relative = path.strip_prefix(workspace_cowork_dir).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "workspace MCP path {} is outside {}",
                path.display(),
                workspace_cowork_dir.display()
            ),
        )
    })?;
    let mut current = workspace_cowork_dir.to_path_buf();
    if is_link(&current)? {
        return Err(refuse(&current));
    }
    for component in relative.components() {
        match component {
            std::path::Component::Normal(_) => current.push(component),
            _ => return Err(refuse(path)),
        }
        if is_link(&current)? {
            return Err(refuse(&current));
        }
    }
    // Defense in depth: the resolved file must stay inside the workspace `.cowork` directory.
    if workspace_cowork_dir.exists() && !cowork_config::is_inside(workspace_cowork_dir, path) {
        return Err(refuse(path));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_layers_and_transports_match_contract() {
        assert!(McpConfigLayer::Plugin < McpConfigLayer::System);
        assert!(McpConfigLayer::System < McpConfigLayer::User);
        assert!(McpConfigLayer::User < McpConfigLayer::Workspace);
        assert_eq!(
            serde_json::to_string(&McpTransportKind::Http).unwrap(),
            "\"http\""
        );
    }
}
