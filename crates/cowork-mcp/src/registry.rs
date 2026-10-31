use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, FileLockOptions, canonicalize_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, is_inside, with_file_lock_sync, write_text_file_atomic,
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
            Ok(cfg) => match validate_server_config(&cfg) {
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
    let cfg = if obj.contains_key("transport") {
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

    validate_server_config(&cfg)?;
    rebase_plugin_stdio_paths(cfg, plugin_root_canon)
}

fn rebase_plugin_stdio_paths(
    mut cfg: McpServerConfig,
    plugin_root_canon: &Path,
) -> Result<McpServerConfig, String> {
    if let McpServerTransport::Stdio {
        ref mut command,
        ref mut args,
        ref mut cwd,
        ..
    } = cfg.transport
    {
        // Rebase `${CLAUDE_PLUGIN_ROOT}` / `${COWORK_PLUGIN_ROOT}` placeholders and `./` relative paths safely
        let root_str = plugin_root_canon.to_string_lossy().into_owned();
        *command = command
            .replace("${CLAUDE_PLUGIN_ROOT}", &root_str)
            .replace("${COWORK_PLUGIN_ROOT}", &root_str);

        if command.starts_with("./") || command.starts_with("../") {
            let resolved = canonicalize_sync(&plugin_root_canon.join(&*command));
            if !is_inside(plugin_root_canon, &resolved) {
                return Err(format!(
                    "Plugin stdio command \"{command}\" escapes plugin root"
                ));
            }
            *command = resolved.to_string_lossy().into_owned();
        }

        if let Some(arg_list) = args.as_mut() {
            for arg in arg_list.iter_mut() {
                *arg = arg
                    .replace("${CLAUDE_PLUGIN_ROOT}", &root_str)
                    .replace("${COWORK_PLUGIN_ROOT}", &root_str);
                if arg.starts_with("./") || arg.starts_with("../") {
                    let resolved = canonicalize_sync(&plugin_root_canon.join(&*arg));
                    if !is_inside(plugin_root_canon, &resolved) {
                        return Err(format!("Plugin stdio arg \"{arg}\" escapes plugin root"));
                    }
                    *arg = resolved.to_string_lossy().into_owned();
                }
            }
        }

        match cwd {
            Some(existing_cwd) => {
                let replaced = existing_cwd
                    .replace("${CLAUDE_PLUGIN_ROOT}", &root_str)
                    .replace("${COWORK_PLUGIN_ROOT}", &root_str);
                let candidate = if Path::new(&replaced).is_absolute() {
                    PathBuf::from(&replaced)
                } else {
                    plugin_root_canon.join(&replaced)
                };
                let resolved = canonicalize_sync(&candidate);
                if !is_inside(plugin_root_canon, &resolved) {
                    return Err(format!(
                        "Plugin stdio cwd \"{existing_cwd}\" escapes plugin root"
                    ));
                }
                *existing_cwd = resolved.to_string_lossy().into_owned();
            }
            None => {
                *cwd = Some(root_str);
            }
        }
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
                    let h_name = header_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Authorization")
                        .to_owned();
                    let h_val = match prefix {
                        Some(p) => format!("{p}{}", api_cred.api_key),
                        None if h_name.eq_ignore_ascii_case("authorization") => {
                            format!("Bearer {}", api_cred.api_key)
                        }
                        None => api_cred.api_key.clone(),
                    };
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
    validate_server_config(&server)?;

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
