use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, FileLockOptions, canonicalize_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, is_inside, normalize_lexical_path, with_file_lock_sync,
    write_text_file_atomic,
};
use serde_json::{Value, json};
use url::Url;

use crate::credentials::{
    McpCredentialsFile, StoredApiKeyCredential, auth_scope_for_source, compute_auth_state,
    credential_key_for_server, credentials_path_for_scope, mask_secret,
    mutate_credentials_for_scope, now_epoch_ms, read_credentials_file,
};
use crate::plugin_overrides::{
    DiscoveredPluginRoot, PluginEnableOverride, PluginScope, discover_installed_plugin_roots,
    mutate_plugin_overrides, plugin_mcp_override_key, read_plugin_overrides,
};
use crate::types::{
    HydratedMcpServer, McpAuthMode, McpAuthMutationResult, McpAuthScope, McpConfigFileSummary,
    McpConfigSource, McpOAuthRuntimeContext, McpServerAuthConfig, McpServerCatalogEntry,
    McpServerConfig, McpServerTransport, McpServersSnapshot,
};

#[derive(Debug, Clone)]
struct RawLayerServer {
    config: McpServerConfig,
    source: McpConfigSource,
    plugin_id: Option<String>,
    plugin_name: Option<String>,
    plugin_scope: Option<String>,
}

pub fn layer_file_path(config: &AgentConfig, source: McpConfigSource) -> Option<PathBuf> {
    match source {
        McpConfigSource::System => Some(config.built_in_config_dir.join("mcp-servers.json")),
        McpConfigSource::User => Some(
            config
                .user_cowork_dir
                .join("config")
                .join("mcp-servers.json"),
        ),
        McpConfigSource::Workspace => Some(config.project_cowork_dir.join("mcp-servers.json")),
        McpConfigSource::Plugin => None,
    }
}

fn validate_server_config(server: &McpServerConfig) -> Result<(), String> {
    let name = server.name.trim();
    if name.is_empty() {
        return Err("MCP server name must not be empty.".to_owned());
    }
    match &server.transport {
        McpServerTransport::Stdio { command, .. } => {
            if command.trim().is_empty() {
                return Err(format!(
                    "MCP stdio server \"{name}\" requires a non-empty command."
                ));
            }
            if server.auth.is_some() {
                return Err(format!(
                    "MCP stdio server \"{name}\" cannot configure HTTP/OAuth auth."
                ));
            }
        }
        McpServerTransport::Http { url, .. } | McpServerTransport::Sse { url, .. } => {
            let parsed = Url::parse(url.trim())
                .map_err(|e| format!("Invalid URL for MCP server \"{name}\": {e}"))?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err(format!(
                    "MCP server \"{name}\" URL must use http:// or https://."
                ));
            }
        }
    }
    Ok(())
}

/// Trims the optional `api_key` auth strings the way the TS config parsers did
/// (`headerName`/`prefix`/`keyId` were `z.string().trim().min(1).optional()` in
/// `src/mcp/configRegistry/parser.ts` and `src/plugins/mcp.ts`): surrounding whitespace is
/// dropped, and a value that is empty after trimming makes the entry invalid.
fn normalize_server_auth(server: &mut McpServerConfig) -> Result<(), String> {
    let Some(McpServerAuthConfig::ApiKey {
        header_name,
        prefix,
        key_id,
    }) = server.auth.as_mut()
    else {
        return Ok(());
    };
    for (field, value) in [
        ("headerName", header_name),
        ("prefix", prefix),
        ("keyId", key_id),
    ] {
        let Some(raw) = value.as_mut() else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(format!(
                "MCP server \"{}\" auth.{field} must not be empty.",
                server.name.trim()
            ));
        }
        if trimmed.len() != raw.len() {
            *raw = trimmed.to_owned();
        }
    }
    Ok(())
}

/// Normalizes then validates a decoded server entry.
fn normalize_and_validate_server_config(server: &mut McpServerConfig) -> Result<(), String> {
    normalize_server_auth(server)?;
    validate_server_config(server)
}

/// Joins an auth-header prefix and value like TS `joinAuthHeader`: the prefix is trimmed and
/// separated from the value by one space; an empty or whitespace prefix yields the bare value.
fn join_auth_header(prefix: &str, value: &str) -> String {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        value.to_owned()
    } else {
        format!("{prefix} {value}")
    }
}

/// Builds the `(header name, header value)` pair for an `api_key` server, porting TS
/// `resolveApiKeyHeader`: the header name defaults to `Authorization`; with no configured
/// prefix, `Authorization` gets `Bearer` and any other header gets the bare key.
fn api_key_auth_header(
    header_name: Option<&str>,
    prefix: Option<&str>,
    api_key: &str,
) -> (String, String) {
    let name = header_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Authorization");
    let prefix = prefix.map(str::trim).unwrap_or_else(|| {
        if name.eq_ignore_ascii_case("authorization") {
            "Bearer"
        } else {
            ""
        }
    });
    (name.to_owned(), join_auth_header(prefix, api_key))
}

fn parse_standard_layer_file(
    source: McpConfigSource,
    path: &Path,
) -> (Vec<McpServerConfig>, McpConfigFileSummary, Vec<String>) {
    let editable = matches!(source, McpConfigSource::Workspace | McpConfigSource::User);
    let mut warnings = Vec::new();
    if !path.exists() {
        return (
            Vec::new(),
            McpConfigFileSummary {
                source,
                path: path.to_string_lossy().into_owned(),
                exists: false,
                editable,
                legacy: false,
                parse_error: None,
                server_count: 0,
                plugin_id: None,
                plugin_name: None,
                plugin_display_name: None,
                plugin_scope: None,
            },
            warnings,
        );
    }

    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Failed to read {}: {e}", path.display());
            warnings.push(format!(
                "[MCP] Ignoring unreadable {} config at {}: {e}",
                source.as_str(),
                path.display()
            ));
            return (
                Vec::new(),
                McpConfigFileSummary {
                    source,
                    path: path.to_string_lossy().into_owned(),
                    exists: true,
                    editable,
                    legacy: false,
                    parse_error: Some(msg),
                    server_count: 0,
                    plugin_id: None,
                    plugin_name: None,
                    plugin_display_name: None,
                    plugin_scope: None,
                },
                warnings,
            );
        }
    };

    let val: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("Invalid JSON in {}: {e}", path.display());
            warnings.push(format!(
                "[MCP] Ignoring malformed {} config at {}: {e}",
                source.as_str(),
                path.display()
            ));
            return (
                Vec::new(),
                McpConfigFileSummary {
                    source,
                    path: path.to_string_lossy().into_owned(),
                    exists: true,
                    editable,
                    legacy: false,
                    parse_error: Some(msg),
                    server_count: 0,
                    plugin_id: None,
                    plugin_name: None,
                    plugin_display_name: None,
                    plugin_scope: None,
                },
                warnings,
            );
        }
    };

    let servers_arr = val
        .as_object()
        .and_then(|o| o.get("servers"))
        .and_then(Value::as_array);
    let Some(arr) = servers_arr else {
        let msg = format!("Expected {{\"servers\": [...]}} in {}", path.display());
        warnings.push(format!(
            "[MCP] Ignoring malformed {} config at {}: {msg}",
            source.as_str(),
            path.display()
        ));
        return (
            Vec::new(),
            McpConfigFileSummary {
                source,
                path: path.to_string_lossy().into_owned(),
                exists: true,
                editable,
                legacy: false,
                parse_error: Some(msg),
                server_count: 0,
                plugin_id: None,
                plugin_name: None,
                plugin_display_name: None,
                plugin_scope: None,
            },
            warnings,
        );
    };

    let mut servers = Vec::new();
    for entry in arr {
        match serde_json::from_value::<McpServerConfig>(entry.clone()) {
            Ok(mut cfg) => match normalize_and_validate_server_config(&mut cfg) {
                Ok(()) => servers.push(cfg),
                Err(err) => warnings.push(err),
            },
            Err(e) => warnings.push(format!(
                "Invalid MCP server entry in {}: {e}",
                path.display()
            )),
        }
    }

    let summary = McpConfigFileSummary {
        source,
        path: path.to_string_lossy().into_owned(),
        exists: true,
        editable,
        legacy: false,
        parse_error: None,
        server_count: servers.len(),
        plugin_id: None,
        plugin_name: None,
        plugin_display_name: None,
        plugin_scope: None,
    };
    (servers, summary, warnings)
}

fn parse_plugin_mcp_file(
    config: &AgentConfig,
    plugin: &DiscoveredPluginRoot,
) -> Option<(Vec<RawLayerServer>, McpConfigFileSummary, Vec<String>)> {
    let mcp_candidate = plugin.root_dir.join(&plugin.mcp_rel_path);
    if !mcp_candidate.exists() {
        return None;
    }
    let mut warnings = Vec::new();
    let root_canon = canonicalize_sync(&plugin.root_dir);
    let mcp_canon = canonicalize_sync(&mcp_candidate);
    if !is_inside(&root_canon, &mcp_canon) {
        let msg = format!(
            "Plugin \"{}\" .mcp.json escapes plugin root: {}",
            plugin.name,
            mcp_candidate.display()
        );
        warnings.push(msg.clone());
        return Some((
            Vec::new(),
            McpConfigFileSummary {
                source: McpConfigSource::Plugin,
                path: mcp_candidate.to_string_lossy().into_owned(),
                exists: true,
                editable: false,
                legacy: false,
                parse_error: Some(msg),
                server_count: 0,
                plugin_id: Some(plugin.id.clone()),
                plugin_name: Some(plugin.name.clone()),
                plugin_display_name: None,
                plugin_scope: Some(plugin.scope.as_str().to_owned()),
            },
            warnings,
        ));
    }

    let raw = match fs::read_to_string(&mcp_canon) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Failed to read {}: {e}", mcp_canon.display());
            warnings.push(msg.clone());
            return Some((
                Vec::new(),
                McpConfigFileSummary {
                    source: McpConfigSource::Plugin,
                    path: mcp_canon.to_string_lossy().into_owned(),
                    exists: true,
                    editable: false,
                    legacy: false,
                    parse_error: Some(msg),
                    server_count: 0,
                    plugin_id: Some(plugin.id.clone()),
                    plugin_name: Some(plugin.name.clone()),
                    plugin_display_name: None,
                    plugin_scope: Some(plugin.scope.as_str().to_owned()),
                },
                warnings,
            ));
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("Invalid JSON in {}: {e}", mcp_canon.display());
            warnings.push(msg.clone());
            return Some((
                Vec::new(),
                McpConfigFileSummary {
                    source: McpConfigSource::Plugin,
                    path: mcp_canon.to_string_lossy().into_owned(),
                    exists: true,
                    editable: false,
                    legacy: false,
                    parse_error: Some(msg),
                    server_count: 0,
                    plugin_id: Some(plugin.id.clone()),
                    plugin_name: Some(plugin.name.clone()),
                    plugin_display_name: None,
                    plugin_scope: Some(plugin.scope.as_str().to_owned()),
                },
                warnings,
            ));
        }
    };

    let overrides = read_plugin_overrides(config, plugin.scope);
    let mut parsed_servers: Vec<McpServerConfig> = Vec::new();

    if let Some(mcp_map) = parsed
        .as_object()
        .and_then(|o| o.get("mcpServers"))
        .and_then(Value::as_object)
    {
        for (srv_name, srv_val) in mcp_map {
            match convert_plugin_mcp_entry(srv_name, srv_val, &root_canon) {
                Ok(cfg) => parsed_servers.push(cfg),
                Err(err) => warnings.push(format!(
                    "Invalid MCP server \"{srv_name}\" in plugin \"{}\": {err}",
                    plugin.name
                )),
            }
        }
    } else if let Some(arr) = parsed
        .as_object()
        .and_then(|o| o.get("servers"))
        .and_then(Value::as_array)
    {
        for entry in arr {
            match serde_json::from_value::<McpServerConfig>(entry.clone())
                .map_err(|e| e.to_string())
                .and_then(|mut cfg| normalize_server_auth(&mut cfg).map(|()| cfg))
                .and_then(|cfg| rebase_plugin_stdio_paths(cfg, &root_canon))
            {
                Ok(cfg) => parsed_servers.push(cfg),
                Err(err) => warnings.push(format!(
                    "Invalid MCP server entry in plugin \"{}\": {err}",
                    plugin.name
                )),
            }
        }
    }

    let mut layer_entries = Vec::new();
    for mut srv in parsed_servers {
        let ov_key = plugin_mcp_override_key(&plugin.id, &srv.name);
        let server_override_enabled = overrides
            .mcp_servers
            .get(&ov_key)
            .map(|o| o.enabled)
            .unwrap_or_else(|| srv.enabled.unwrap_or(true));
        let effective_enabled = plugin.enabled && server_override_enabled;
        srv.enabled = Some(effective_enabled);
        layer_entries.push(RawLayerServer {
            config: srv,
            source: McpConfigSource::Plugin,
            plugin_id: Some(plugin.id.clone()),
            plugin_name: Some(plugin.name.clone()),
            plugin_scope: Some(plugin.scope.as_str().to_owned()),
        });
    }

    let summary = McpConfigFileSummary {
        source: McpConfigSource::Plugin,
        path: mcp_canon.to_string_lossy().into_owned(),
        exists: true,
        editable: false,
        legacy: false,
        parse_error: None,
        server_count: layer_entries.len(),
        plugin_id: Some(plugin.id.clone()),
        plugin_name: Some(plugin.name.clone()),
        plugin_display_name: None,
        plugin_scope: Some(plugin.scope.as_str().to_owned()),
    };

    Some((layer_entries, summary, warnings))
}

fn convert_plugin_mcp_entry(
    name: &str,
    val: &Value,
    plugin_root_canon: &Path,
) -> Result<McpServerConfig, String> {
    let Some(obj) = val.as_object() else {
        return Err("server definition must be a JSON object".to_owned());
    };
    // Plugin `.mcp.json` supports either `{ "transport": { ... } }` or shorthand `{ "command": "...", "args": [...] }` / `{ "type": "http", "url": "..." }`
    let mut cfg = if obj.contains_key("transport") {
        let mut copy = obj.clone();
        copy.insert("name".to_owned(), Value::String(name.to_owned()));
        serde_json::from_value::<McpServerConfig>(Value::Object(copy)).map_err(|e| e.to_string())?
    } else {
        let transport_type = obj.get("type").and_then(Value::as_str).unwrap_or_else(|| {
            if obj.contains_key("url") {
                "http"
            } else {
                "stdio"
            }
        });
        let mut transport_obj = serde_json::Map::new();
        transport_obj.insert("type".to_owned(), Value::String(transport_type.to_owned()));
        for key in ["command", "args", "env", "cwd", "url", "headers"] {
            if let Some(v) = obj.get(key) {
                transport_obj.insert(key.to_owned(), v.clone());
            }
        }
        let mut full = serde_json::Map::new();
        full.insert("name".to_owned(), Value::String(name.to_owned()));
        full.insert("transport".to_owned(), Value::Object(transport_obj));
        for key in ["enabled", "required", "retries", "auth", "icon"] {
            if let Some(v) = obj.get(key) {
                full.insert(key.to_owned(), v.clone());
            }
        }
        serde_json::from_value::<McpServerConfig>(Value::Object(full)).map_err(|e| e.to_string())?
    };

    normalize_and_validate_server_config(&mut cfg)?;
    rebase_plugin_stdio_paths(cfg, plugin_root_canon)
}

const PLUGIN_ROOT_PLACEHOLDERS: [&str; 2] = ["${CLAUDE_PLUGIN_ROOT}", "${COWORK_PLUGIN_ROOT}"];

/// Expands `${CLAUDE_PLUGIN_ROOT}` / `${COWORK_PLUGIN_ROOT}` (a Rust-side extension for
/// Claude-format plugins; TS has no placeholders). Returns `None` when no placeholder occurs.
fn expand_plugin_root_placeholders(value: &str, root_str: &str) -> Option<String> {
    PLUGIN_ROOT_PLACEHOLDERS
        .iter()
        .any(|placeholder| value.contains(placeholder))
        .then(|| {
            PLUGIN_ROOT_PLACEHOLDERS
                .iter()
                .fold(value.to_owned(), |acc, placeholder| {
                    acc.replace(placeholder, root_str)
                })
        })
}

/// `path.isAbsolute(value) || path.win32.isAbsolute(value)` from
/// `src/mcp/configRegistry/layers.ts`.
fn is_absolute_filesystem_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes.first(), Some(b'/' | b'\\'))
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

/// TS `uriSchemePattern` (`/^[A-Za-z][A-Za-z\d+.-]*:/`).
fn has_uri_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

fn has_path_separator(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
}

/// TS `isExplicitRelativeFilesystemPath`: `.`/`..` (optionally followed by a separator), or any
/// separator-containing value with a `..` segment.
fn is_explicit_relative_filesystem_path(value: &str) -> bool {
    let explicit_prefix = value
        .strip_prefix("..")
        .or_else(|| value.strip_prefix('.'))
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '\\']));
    explicit_prefix || (has_path_separator(value) && value.split(['/', '\\']).any(|s| s == ".."))
}

/// TS `isPathInside` (lexical, no filesystem access).
fn is_lexically_inside(parent: &Path, child: &Path) -> bool {
    normalize_lexical_path(child).starts_with(normalize_lexical_path(parent))
}

/// TS `isPluginRelativeFilesystemPath`: explicit relative paths always count; a bare relative
/// value with a separator (not an `@scope/pkg` name) counts only when it exists inside the root.
fn is_plugin_relative_filesystem_path(plugin_root: &Path, value: &str) -> bool {
    if is_absolute_filesystem_path(value) || has_uri_scheme(value) {
        return false;
    }
    if is_explicit_relative_filesystem_path(value) {
        return true;
    }
    if !has_path_separator(value) || value.starts_with('@') {
        return false;
    }
    let resolved = plugin_root.join(value);
    is_lexically_inside(plugin_root, &resolved) && resolved.exists()
}

/// TS `resolvePluginLocalPath`: resolves `value` against the plugin root (absolute values are
/// kept) and rejects anything whose canonical (symlink-resolved) form leaves the root.
fn resolve_plugin_local_path(
    server_name: &str,
    plugin_root: &Path,
    value: &str,
    label: &str,
) -> Result<String, String> {
    let resolved = normalize_lexical_path(&plugin_root.join(value));
    // `is_inside` canonicalizes both sides (TS `canonicalizePathForBoundaryCheckSync`).
    if !is_inside(plugin_root, &resolved) {
        return Err(format!(
            "Plugin MCP server \"{server_name}\" resolves {label} outside the plugin root."
        ));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

/// Port of TS `rebasePluginLocalTransport` (`src/mcp/configRegistry/layers.ts`): plugin-relative
/// filesystem paths in `command`/`args` are rebased onto the plugin root, `cwd` (when set) is
/// always resolved against it, and an absent `cwd` stays absent.
fn rebase_plugin_stdio_paths(
    mut cfg: McpServerConfig,
    plugin_root_canon: &Path,
) -> Result<McpServerConfig, String> {
    let server_name = cfg.name.clone();
    let McpServerTransport::Stdio {
        ref mut command,
        ref mut args,
        ref mut cwd,
        ..
    } = cfg.transport
    else {
        return Ok(cfg);
    };
    let root_str = plugin_root_canon.to_string_lossy().into_owned();

    // A placeholder-expanded value names a plugin-local path, so it is always boundary-checked.
    let rebase = |value: &str, label: &str| -> Result<Option<String>, String> {
        if let Some(expanded) = expand_plugin_root_placeholders(value, &root_str) {
            return resolve_plugin_local_path(&server_name, plugin_root_canon, &expanded, label)
                .map(Some);
        }
        if is_plugin_relative_filesystem_path(plugin_root_canon, value) {
            return resolve_plugin_local_path(&server_name, plugin_root_canon, value, label)
                .map(Some);
        }
        Ok(None)
    };

    if let Some(resolved) = rebase(command, "command")? {
        *command = resolved;
    }
    if let Some(arg_list) = args.as_mut() {
        for arg in arg_list.iter_mut() {
            if let Some(resolved) = rebase(arg, &format!("argument \"{arg}\""))? {
                *arg = resolved;
            }
        }
    }
    if let Some(existing_cwd) = cwd.as_mut() {
        let value = expand_plugin_root_placeholders(existing_cwd, &root_str)
            .unwrap_or_else(|| existing_cwd.clone());
        *existing_cwd = resolve_plugin_local_path(&server_name, plugin_root_canon, &value, "cwd")?;
    }
    Ok(cfg)
}

fn collect_all_layers(
    config: &AgentConfig,
) -> (
    BTreeMap<String, RawLayerServer>,
    Vec<RawLayerServer>,
    Vec<McpConfigFileSummary>,
    Vec<String>,
) {
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut merged: BTreeMap<String, RawLayerServer> = BTreeMap::new();
    let mut shadowed: Vec<RawLayerServer> = Vec::new();

    // Merge standard layers in increasing precedence: System -> User -> Workspace
    for source in [
        McpConfigSource::System,
        McpConfigSource::User,
        McpConfigSource::Workspace,
    ] {
        let Some(path) = layer_file_path(config, source) else {
            continue;
        };
        let (servers, summary, layer_warnings) = parse_standard_layer_file(source, &path);
        files.push(summary);
        warnings.extend(layer_warnings);

        for srv in servers {
            let entry = RawLayerServer {
                config: srv,
                source,
                plugin_id: None,
                plugin_name: None,
                plugin_scope: None,
            };
            if let Some(prev) = merged.insert(entry.config.name.clone(), entry) {
                shadowed.push(prev);
            }
        }
    }

    // Discover plugins (`workspace` plugins first, then `user` plugins).
    // Any server name already in `merged` (including `System`) wins over plugin servers!
    let (plugins, plugin_warnings) = discover_installed_plugin_roots(config);
    warnings.extend(plugin_warnings);

    for plugin in plugins {
        let Some((plugin_servers, summary, p_warns)) = parse_plugin_mcp_file(config, &plugin)
        else {
            continue;
        };
        files.push(summary);
        warnings.extend(p_warns);

        for entry in plugin_servers {
            if let Some(winner) = merged.get(&entry.config.name) {
                warnings.push(format!(
                    "Ignoring plugin server \"{}\" from plugin \"{}\" because a server with that name already exists in {} config.",
                    entry.config.name,
                    plugin.name,
                    winner.source.as_str()
                ));
                shadowed.push(entry);
            } else {
                merged.insert(entry.config.name.clone(), entry);
            }
        }
    }

    (merged, shadowed, files, warnings)
}

/// Reads the full 4-layer MCP server catalog snapshot for `cowork/mcp/servers/read`.
pub fn read_mcp_servers_snapshot(config: &AgentConfig) -> Result<McpServersSnapshot, String> {
    let (merged, _shadowed, mut files, warnings) = collect_all_layers(config);

    // Order standard files `[workspace, user, system, ...pluginFiles]` matching TS `loadMCPConfigRegistry`
    files.sort_by_key(|f| match f.source {
        McpConfigSource::Workspace => 0u8,
        McpConfigSource::User => 1u8,
        McpConfigSource::System => 2u8,
        McpConfigSource::Plugin => 3u8,
    });

    let ws_creds =
        read_credentials_file(&credentials_path_for_scope(config, McpAuthScope::Workspace));
    let user_creds = read_credentials_file(&credentials_path_for_scope(config, McpAuthScope::User));

    let mut entries = Vec::with_capacity(merged.len());

    for (_name, mut winner) in merged {
        let scope = auth_scope_for_source(winner.source, winner.plugin_scope.as_deref());
        let creds = match scope {
            McpAuthScope::Workspace => &ws_creds,
            McpAuthScope::User => &user_creds,
        };
        let auth_state =
            compute_auth_state(&winner.config.name, winner.config.auth.as_ref(), creds);
        let inherited = winner.source != McpConfigSource::Workspace
            && winner.plugin_scope.as_deref() != Some("workspace");
        if winner.config.enabled.is_none() {
            winner.config.enabled = Some(true);
        }
        entries.push(McpServerCatalogEntry {
            config: winner.config,
            source: winner.source,
            inherited,
            auth_mode: auth_state.mode,
            auth_scope: scope,
            auth_message: auth_state.message.clone(),
            plugin_id: winner.plugin_id,
            plugin_name: winner.plugin_name,
            plugin_display_name: None,
            plugin_scope: winner.plugin_scope,
            auth_state,
        });
    }

    entries.sort_by(|a, b| a.config.name.cmp(&b.config.name));

    Ok(McpServersSnapshot {
        servers: entries,
        files,
        warnings,
    })
}

/// Loads enabled, trust-verified MCP servers hydrated with auth headers for turn execution.
pub fn load_mcp_servers<F>(
    config: &AgentConfig,
    include_untrusted_workspace: bool,
    mut on_log: F,
) -> Result<Vec<HydratedMcpServer>, String>
where
    F: FnMut(String),
{
    let (merged, _shadowed, _files, _warnings) = collect_all_layers(config);
    let mut candidates: Vec<RawLayerServer> = Vec::new();

    for (_name, srv) in merged {
        if srv.config.enabled == Some(false) {
            continue;
        }
        let is_workspace_origin = srv.source == McpConfigSource::Workspace
            || (srv.source == McpConfigSource::Plugin
                && srv.plugin_scope.as_deref() == Some("workspace"));

        if is_workspace_origin && !config.trust_workspace_mcp && !include_untrusted_workspace {
            let kind = srv.config.transport.kind().as_str();
            on_log(format!(
                "[MCP] Not auto-starting workspace {kind} server \"{}\" because trustWorkspaceMcp is false.",
                srv.config.name
            ));
            continue;
        }
        candidates.push(srv);
    }

    // Only read workspace credentials on disk if at least one workspace-scoped server survived trust filtering!
    let needs_ws_creds = candidates.iter().any(|c| {
        auth_scope_for_source(c.source, c.plugin_scope.as_deref()) == McpAuthScope::Workspace
    });
    let ws_creds = if needs_ws_creds {
        Some(read_credentials_file(&credentials_path_for_scope(
            config,
            McpAuthScope::Workspace,
        )))
    } else {
        None
    };
    let user_creds = read_credentials_file(&credentials_path_for_scope(config, McpAuthScope::User));

    let mut hydrated = Vec::with_capacity(candidates.len());
    for cand in candidates {
        let scope = auth_scope_for_source(cand.source, cand.plugin_scope.as_deref());
        let creds = match scope {
            McpAuthScope::Workspace => ws_creds.as_ref().unwrap(),
            McpAuthScope::User => &user_creds,
        };
        hydrated.push(hydrate_server_with_credentials(config, cand, scope, creds));
    }

    Ok(hydrated)
}

/// Resolves a single target MCP server (allowing explicit validation of untrusted workspace servers).
pub fn resolve_target_mcp_server(
    config: &AgentConfig,
    name: &str,
    source: Option<McpConfigSource>,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
) -> Result<HydratedMcpServer, String> {
    let (merged, shadowed, _files, _warnings) = collect_all_layers(config);
    let target_name = name.trim();

    let found = if let Some(req_source) = source {
        merged
            .values()
            .chain(shadowed.iter())
            .find(|entry| {
                entry.config.name == target_name
                    && entry.source == req_source
                    && plugin_id.is_none_or(|pid| entry.plugin_id.as_deref() == Some(pid))
                    && plugin_scope.is_none_or(|ps| entry.plugin_scope.as_deref() == Some(ps))
            })
            .cloned()
    } else {
        merged.get(target_name).cloned()
    };

    let Some(raw) = found else {
        return Err(format!("MCP server \"{target_name}\" was not found."));
    };

    let scope = auth_scope_for_source(raw.source, raw.plugin_scope.as_deref());
    let creds = read_credentials_file(&credentials_path_for_scope(config, scope));
    Ok(hydrate_server_with_credentials(config, raw, scope, &creds))
}

fn hydrate_server_with_credentials(
    config: &AgentConfig,
    mut raw: RawLayerServer,
    scope: McpAuthScope,
    creds: &McpCredentialsFile,
) -> HydratedMcpServer {
    let mut injected_headers = HashMap::new();
    let mut oauth_context = None;

    if let Some(auth_cfg) = raw.config.auth.as_ref() {
        let key = credential_key_for_server(&raw.config.name, Some(auth_cfg));
        let stored = creds.servers.get(&key);

        match auth_cfg {
            McpServerAuthConfig::None => {}
            McpServerAuthConfig::ApiKey {
                header_name,
                prefix,
                ..
            } => {
                if let Some(api_cred) = stored.and_then(|s| s.api_key.as_ref())
                    && !api_cred.api_key.is_empty()
                {
                    let (h_name, h_val) = api_key_auth_header(
                        header_name.as_deref(),
                        prefix.as_deref(),
                        &api_cred.api_key,
                    );
                    injected_headers.insert(h_name, h_val);
                }
            }
            McpServerAuthConfig::OAuth {
                scope: oauth_scope,
                resource,
                ..
            } => {
                if let Some(tokens) = stored
                    .and_then(|s| s.oauth.as_ref())
                    .and_then(|o| o.tokens.as_ref())
                    && !tokens.access_token.is_empty()
                {
                    injected_headers.insert(
                        "Authorization".to_owned(),
                        format!("Bearer {}", tokens.access_token),
                    );
                }
                if let Some(remote_url) = raw.config.transport.remote_url() {
                    oauth_context = Some(McpOAuthRuntimeContext {
                        server_name: raw.config.name.clone(),
                        remote_url: remote_url.to_owned(),
                        auth_scope: scope,
                        credentials_path: credentials_path_for_scope(config, scope),
                        lock_root: file_lock_root_for_cowork_home(&config.user_cowork_dir),
                        configured_scope: oauth_scope.clone(),
                        configured_resource: resource.clone(),
                    });
                }
            }
        }
    }

    raw.config.transport = raw.config.transport.with_merged_headers(injected_headers);
    HydratedMcpServer {
        config: raw.config,
        source: raw.source,
        auth_scope: scope,
        oauth_context,
    }
}

fn mutate_editable_layer_file<F>(
    config: &AgentConfig,
    source: McpConfigSource,
    f: F,
) -> Result<(), String>
where
    F: FnOnce(&mut Vec<McpServerConfig>) -> Result<(), String>,
{
    if !matches!(source, McpConfigSource::Workspace | McpConfigSource::User) {
        return Err(format!(
            "MCP layer \"{}\" is read-only; only workspace and user configs can be modified.",
            source.as_str()
        ));
    }
    let path = layer_file_path(config, source).ok_or_else(|| "Invalid MCP layer".to_owned())?;
    let lock_root = file_lock_root_for_cowork_home(&config.user_cowork_dir);

    with_file_lock_sync::<(), anyhow::Error, _>(
        &path,
        || {
            let mut servers: Vec<McpServerConfig> = if path.exists() {
                let raw = fs::read_to_string(&path)?;
                let val: Value = serde_json::from_str(&raw)?;
                let arr = val
                    .as_object()
                    .and_then(|o| o.get("servers"))
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        anyhow::anyhow!("Expected {{\"servers\": [...]}} in {}", path.display())
                    })?;
                arr.iter()
                    .map(|v| serde_json::from_value::<McpServerConfig>(v.clone()))
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                Vec::new()
            };

            f(&mut servers).map_err(|msg| anyhow::anyhow!("{msg}"))?;

            servers.sort_by(|a, b| a.name.cmp(&b.name));
            let payload = format!(
                "{}\n",
                serde_json::to_string_pretty(&json!({ "servers": servers }))?
            );
            write_text_file_atomic(&path, &payload, Some(0o600))?;
            harden_private_file_sync(&path);
            Ok(())
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

/// Inserts or updates a server in `workspace` or `user` `mcp-servers.json`, migrating stored credentials on rename.
pub fn upsert_mcp_server(
    config: &AgentConfig,
    source: McpConfigSource,
    mut server: McpServerConfig,
    previous_name: Option<&str>,
) -> Result<McpServersSnapshot, String> {
    server.name = server.name.trim().to_owned();
    if server.enabled == Some(true) {
        server.enabled = None;
    }
    normalize_and_validate_server_config(&mut server)?;

    let prev_trimmed = previous_name.map(str::trim).filter(|s| !s.is_empty());
    let new_name = server.name.clone();

    mutate_editable_layer_file(config, source, |servers| {
        if let Some(prev) = prev_trimmed
            && prev != new_name
        {
            if servers.iter().any(|s| s.name == new_name) {
                return Err(format!(
                    "Cannot rename \"{prev}\" to \"{new_name}\": server already exists in {} config.",
                    source.as_str()
                ));
            }
            servers.retain(|s| s.name != prev);
        }
        if let Some(existing) = servers.iter_mut().find(|s| s.name == new_name) {
            *existing = server;
        } else {
            servers.push(server);
        }
        Ok(())
    })?;

    if let Some(prev) = prev_trimmed
        && prev != new_name
    {
        let scope = auth_scope_for_source(source, None);
        let cred_path = credentials_path_for_scope(config, scope);
        if cred_path.exists() {
            let _ = mutate_credentials_for_scope(config, scope, |store| {
                if let Some(cred) = store.servers.remove(prev) {
                    store.servers.entry(new_name.clone()).or_insert(cred);
                }
            });
        }
    }

    read_mcp_servers_snapshot(config)
}

/// Deletes a server from `workspace` or `user` `mcp-servers.json` and cleans up its scoped credentials.
pub fn delete_mcp_server(
    config: &AgentConfig,
    source: McpConfigSource,
    name: &str,
) -> Result<McpServersSnapshot, String> {
    let target = name.trim();
    mutate_editable_layer_file(config, source, |servers| {
        let before = servers.len();
        servers.retain(|s| s.name != target);
        if servers.len() == before {
            return Err(format!(
                "MCP server \"{target}\" was not found in {} config.",
                source.as_str()
            ));
        }
        Ok(())
    })?;

    let scope = auth_scope_for_source(source, None);
    let cred_path = credentials_path_for_scope(config, scope);
    if cred_path.exists() {
        let _ = mutate_credentials_for_scope(config, scope, |store| {
            store.servers.remove(target);
        });
    }

    read_mcp_servers_snapshot(config)
}

/// Enables or disables a server in `workspace`, `user`, or `plugin` (`plugins.json` v2).
pub fn set_mcp_server_enabled(
    config: &AgentConfig,
    source: McpConfigSource,
    name: &str,
    enabled: bool,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
) -> Result<McpServersSnapshot, String> {
    let target = name.trim();
    if source == McpConfigSource::Plugin {
        let pid = plugin_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "pluginId is required when toggling a plugin MCP server.".to_owned())?;
        let pscope = plugin_scope.and_then(PluginScope::parse).ok_or_else(|| {
            "pluginScope ('workspace' or 'user') is required when toggling a plugin MCP server."
                .to_owned()
        })?;
        let key = plugin_mcp_override_key(pid, target);
        mutate_plugin_overrides(config, pscope, |overrides| {
            overrides
                .mcp_servers
                .insert(key, PluginEnableOverride { enabled });
        })?;
        return read_mcp_servers_snapshot(config);
    }

    mutate_editable_layer_file(config, source, |servers| {
        let Some(entry) = servers.iter_mut().find(|s| s.name == target) else {
            return Err(format!(
                "MCP server \"{target}\" was not found in {} config.",
                source.as_str()
            ));
        };
        entry.enabled = if enabled { None } else { Some(false) };
        Ok(())
    })?;

    read_mcp_servers_snapshot(config)
}

/// Stores an API key in the strictly scoped `mcp-credentials.json` (`0600`).
pub fn set_mcp_server_api_key(
    config: &AgentConfig,
    name: &str,
    source: Option<McpConfigSource>,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
    api_key: &str,
) -> Result<McpAuthMutationResult, String> {
    let trimmed_key = api_key.trim();
    if trimmed_key.is_empty() {
        return Err("API key must not be empty.".to_owned());
    }
    let resolved = resolve_target_mcp_server(config, name, source, plugin_id, plugin_scope)?;
    let cred_key = credential_key_for_server(&resolved.config.name, resolved.config.auth.as_ref());

    mutate_credentials_for_scope(config, resolved.auth_scope, |store| {
        let entry = store.servers.entry(cred_key).or_default();
        entry.api_key = Some(StoredApiKeyCredential {
            api_key: trimmed_key.to_owned(),
            updated_at: now_epoch_ms(),
        });
    })?;

    let masked = mask_secret(trimmed_key);
    Ok(McpAuthMutationResult {
        name: resolved.config.name,
        source: resolved.source,
        mode: McpAuthMode::ApiKey,
        ok: true,
        message: format!(
            "Stored API key ({masked}) in {} credentials.",
            resolved.auth_scope.as_str()
        ),
    })
}

#[cfg(test)]
mod api_key_auth_header_tests {
    use super::*;

    fn api_key_server(header_name: Option<&str>, prefix: Option<&str>) -> McpServerConfig {
        McpServerConfig {
            name: "remote".to_owned(),
            transport: McpServerTransport::Http {
                url: "https://example.test/mcp".to_owned(),
                headers: None,
            },
            enabled: None,
            required: None,
            retries: None,
            auth: Some(McpServerAuthConfig::ApiKey {
                header_name: header_name.map(str::to_owned),
                prefix: prefix.map(str::to_owned),
                key_id: None,
            }),
            icon: None,
        }
    }

    #[test]
    fn configured_prefix_is_separated_from_the_key_by_one_space() {
        assert_eq!(
            api_key_auth_header(None, Some("Bearer"), "key"),
            ("Authorization".to_owned(), "Bearer key".to_owned())
        );
        assert_eq!(
            api_key_auth_header(None, Some("Bearer "), "key").1,
            "Bearer key"
        );
        assert_eq!(
            api_key_auth_header(None, Some("  Token\t"), "key").1,
            "Token key"
        );
    }

    #[test]
    fn empty_or_whitespace_prefix_sends_the_bare_key() {
        // TS: `auth.prefix?.trim() ?? default` keeps "" (not nullish), so no Bearer fallback.
        assert_eq!(api_key_auth_header(None, Some(""), "key").1, "key");
        assert_eq!(api_key_auth_header(None, Some("   "), "key").1, "key");
    }

    #[test]
    fn missing_prefix_defaults_to_bearer_only_for_authorization() {
        assert_eq!(
            api_key_auth_header(None, None, "key"),
            ("Authorization".to_owned(), "Bearer key".to_owned())
        );
        assert_eq!(
            api_key_auth_header(Some("authorization"), None, "key"),
            ("authorization".to_owned(), "Bearer key".to_owned())
        );
        assert_eq!(
            api_key_auth_header(Some(" X-API-Key "), None, "key"),
            ("X-API-Key".to_owned(), "key".to_owned())
        );
        assert_eq!(
            api_key_auth_header(Some("X-API-Key"), Some("Token"), "key"),
            ("X-API-Key".to_owned(), "Token key".to_owned())
        );
        assert_eq!(
            api_key_auth_header(Some("  "), None, "key"),
            ("Authorization".to_owned(), "Bearer key".to_owned())
        );
    }

    #[test]
    fn parser_trims_api_key_auth_fields_like_ts_zod_schema() {
        let mut server = api_key_server(Some(" X-API-Key "), Some("Bearer "));
        if let Some(McpServerAuthConfig::ApiKey { key_id, .. }) = server.auth.as_mut() {
            *key_id = Some("  shared-key ".to_owned());
        }
        normalize_and_validate_server_config(&mut server).unwrap();
        assert_eq!(
            server.auth,
            Some(McpServerAuthConfig::ApiKey {
                header_name: Some("X-API-Key".to_owned()),
                prefix: Some("Bearer".to_owned()),
                key_id: Some("shared-key".to_owned()),
            })
        );
    }

    #[test]
    fn parser_rejects_empty_or_whitespace_api_key_auth_fields_like_ts_zod_schema() {
        for (header_name, prefix, field) in [
            (None, Some(""), "prefix"),
            (None, Some("   "), "prefix"),
            (Some(" "), None, "headerName"),
        ] {
            let mut server = api_key_server(header_name, prefix);
            let err = normalize_and_validate_server_config(&mut server).unwrap_err();
            assert!(err.contains(&format!("auth.{field}")), "{err}");
        }
    }
}
