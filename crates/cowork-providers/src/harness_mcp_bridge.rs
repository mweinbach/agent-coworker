//! Ephemeral per-turn loopback Streamable HTTP MCP bridge for Cowork-managed native runtimes
//! (`claude-sdk` and `antigravity-acp`).
//!
//! Exposes Cowork's harness-only tool catalog (such as `taskUpdate`, `reviewTask`, `createTask`,
//! `AskUserQuestion`, `todoWrite`, subagent/workflow/memory tools, and Cowork-managed `mcp__*`
//! tools) over a loopback `127.0.0.1:<port>/mcp` endpoint authenticated with a fresh 256-bit
//! per-turn Bearer token. Each `tools/call` invocation is strictly allowlisted to the turn's
//! registered bridged tools and executed in-process through [`DynamicToolHandler::call_tool`],
//! preserving Cowork's task-mutation lock, tool catalog isolation, sandbox controls, and
//! interactive approvals. The server and any temporary config files are torn down immediately
//! when the turn ends.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, Request, Response, StatusCode};
use axum::routing::any;
use rand::RngCore;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::codex_app_server::DynamicToolHandler;
use crate::credential_proxy::ct_eq;
use crate::transport::ToolDefinition;

/// Canonical MCP server name registered with managed runtimes for the Cowork harness bridge.
pub(crate) const HARNESS_MCP_SERVER_NAME: &str = "cowork";
const MAX_MCP_BRIDGE_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2025-03-26";

/// Returns `true` for local shell, filesystem, and web tools handled natively by the managed
/// CLI runtimes (and validated per-invocation by Cowork's native approval policy).
pub(crate) fn is_native_runtime_tool_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "bash"
            | "read"
            | "write"
            | "edit"
            | "glob"
            | "grep"
            | "webfetch"
            | "web_fetch"
            | "websearch"
            | "web_search"
    )
}

/// Filters `tools` to the Cowork harness tools that should be exposed to a managed runtime over
/// [`HarnessMcpBridge`]:
/// - Returns empty when `tools_disabled` or `authorized_tool_names == Some(&[])`.
/// - Excludes native local shell/file/web tools so those stay on the runtime's native path with
///   per-call native approval validation.
/// - Enforces `authorized_tool_names` when present and deduplicates by canonical tool name.
pub(crate) fn filter_bridged_harness_tools(
    tools: &[ToolDefinition],
    authorized_tool_names: Option<&[String]>,
    tools_disabled: bool,
) -> Vec<ToolDefinition> {
    if tools_disabled {
        return Vec::new();
    }
    if let Some(allowlist) = authorized_tool_names
        && allowlist.is_empty()
    {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for tool in tools {
        let name = tool.name.trim();
        if name.is_empty() || is_native_runtime_tool_name(name) {
            continue;
        }
        if let Some(allowlist) = authorized_tool_names
            && !allowlist
                .iter()
                .any(|allowed| allowed.trim().eq_ignore_ascii_case(name))
        {
            continue;
        }
        if seen.insert(name.to_owned()) {
            out.push(ToolDefinition {
                name: name.to_owned(),
                description: tool.description.clone(),
                parameters: tool.parameters.clone(),
            });
        }
    }
    out
}

/// Wire representation of bridged tools for continuation fingerprinting.
pub(crate) fn bridged_tools_fingerprint_values(tools: &[ToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.parameters,
            })
        })
        .collect()
}

/// Concise system-prompt addendum informing a managed runtime how to call Cowork harness tools
/// exposed through the `cowork` MCP bridge.
pub(crate) fn render_harness_mcp_bridge_instructions(tools: &[ToolDefinition]) -> Option<String> {
    if tools.is_empty() {
        return None;
    }
    let listed: Vec<String> = tools
        .iter()
        .map(|t| {
            format!(
                "`mcp__{HARNESS_MCP_SERVER_NAME}__{}` (`{}`)",
                t.name, t.name
            )
        })
        .collect();
    Some(format!(
        "## Cowork Harness MCP Tools\n\nCowork exposes its harness tools for this turn via the `{HARNESS_MCP_SERVER_NAME}` MCP server: {}.\nUse these `{HARNESS_MCP_SERVER_NAME}` MCP tools whenever instructions refer to Cowork harness tools (for example, call `mcp__{HARNESS_MCP_SERVER_NAME}__taskUpdate` for `taskUpdate` and `mcp__{HARNESS_MCP_SERVER_NAME}__reviewTask` for `reviewTask`).",
        listed.join(", ")
    ))
}

/// Immutable per-turn lookup table mapping server-namespaced MCP tool identifiers back to the
/// exact canonical Cowork harness tools registered on the active [`HarnessMcpBridge`].
#[derive(Debug)]
pub(crate) struct BridgedToolLookup {
    exposed_tools: HashSet<String>,
}

impl BridgedToolLookup {
    fn new(tools: &[ToolDefinition]) -> Self {
        Self {
            exposed_tools: tools.iter().map(|t| t.name.clone()).collect(),
        }
    }

    /// Resolves a Claude Code MCP tool name (`mcp__cowork__<tool>`) strictly to a canonical tool
    /// registered on this turn's bridge. Never matches native tools or tools from other servers.
    pub(crate) fn resolve_claude_tool(&self, raw_name: &str) -> Option<&str> {
        let trimmed = raw_name.trim();
        let rest = strip_ascii_prefix(trimmed, "mcp__cowork__")?;
        self.exposed_tools.get(rest).map(String::as_str)
    }

    /// Resolves an ACP server-namespaced MCP tool name (`mcp__cowork__<tool>`, `cowork/<tool>`,
    /// `cowork:<tool>`, or `cowork__<tool>`) strictly to a canonical tool registered on this
    /// turn's bridge. Never matches bare names so native ACP tools cannot spoof bridged tools.
    pub(crate) fn resolve_acp_tool(&self, raw_name: &str) -> Option<&str> {
        let trimmed = raw_name.trim();
        let rest = strip_ascii_prefix(trimmed, "mcp__cowork__")
            .or_else(|| strip_ascii_prefix(trimmed, "cowork/"))
            .or_else(|| strip_ascii_prefix(trimmed, "cowork:"))
            .or_else(|| strip_ascii_prefix(trimmed, "cowork__"))?;
        self.exposed_tools.get(rest).map(String::as_str)
    }

    /// Normalizes a server-namespaced bridged tool name back to its canonical Cowork tool name
    /// for UI/transcript stream events; leaves unrelated tool names untouched.
    pub(crate) fn normalize_stream_tool_name(&self, raw_name: &str) -> String {
        self.resolve_acp_tool(raw_name)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| raw_name.to_owned())
    }
}

fn strip_ascii_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

struct BridgeState {
    port: u16,
    bearer_token: String,
    session_id: String,
    wire_tools: Vec<Value>,
    allowed_tools: HashMap<String, String>,
    handler: Arc<dyn DynamicToolHandler>,
}

/// Active loopback Streamable HTTP MCP bridge bound strictly to `127.0.0.1:<port>/mcp`.
/// Shuts down immediately and deletes any temporary MCP config files when dropped.
pub(crate) struct HarnessMcpBridge {
    endpoint_url: String,
    bearer_token: String,
    lookup: Arc<BridgedToolLookup>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_task: JoinHandle<()>,
    temp_config_paths: Vec<PathBuf>,
}

impl HarnessMcpBridge {
    pub(crate) async fn start(
        tools: Vec<ToolDefinition>,
        handler: Arc<dyn DynamicToolHandler>,
    ) -> Result<Self, String> {
        let mut raw = [0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        let bearer_token = hex::encode(raw);
        let session_id = Uuid::new_v4().to_string();

        let lookup = Arc::new(BridgedToolLookup::new(&tools));
        let mut allowed_tools = HashMap::with_capacity(tools.len());
        let mut wire_tools = Vec::with_capacity(tools.len());
        for tool in &tools {
            allowed_tools.insert(tool.name.clone(), tool.name.clone());
            wire_tools.push(json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": normalize_mcp_input_schema(&tool.parameters),
            }));
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| format!("Failed to bind loopback Cowork MCP bridge: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("Failed to inspect loopback Cowork MCP bridge address: {err}"))?
            .port();

        let state = Arc::new(BridgeState {
            port,
            bearer_token: bearer_token.clone(),
            session_id,
            wire_tools,
            allowed_tools,
            handler,
        });

        let app = Router::new()
            .route("/mcp", any(handle_mcp_request))
            .with_state(state);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server_task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            endpoint_url: format!("http://127.0.0.1:{port}/mcp"),
            bearer_token,
            lookup,
            shutdown_tx: Some(shutdown_tx),
            server_task,
            temp_config_paths: Vec::new(),
        })
    }

    pub(crate) fn lookup(&self) -> Arc<BridgedToolLookup> {
        Arc::clone(&self.lookup)
    }

    pub(crate) fn claude_mcp_config_json(&self) -> Value {
        json!({
            "mcpServers": {
                HARNESS_MCP_SERVER_NAME: {
                    "type": "http",
                    "url": self.endpoint_url,
                    "headers": {
                        "Authorization": format!("Bearer {}", self.bearer_token),
                    }
                }
            }
        })
    }

    /// Writes a `0600` (on Unix) ephemeral `--mcp-config` file under `dir` (expected to live inside
    /// Cowork's protected `0700` runtime auth directory so the Bearer token never appears in
    /// process argv and cannot be read by native tools). Removed automatically when the bridge drops.
    pub(crate) fn write_claude_mcp_config_file(&mut self, dir: &Path) -> Result<PathBuf, String> {
        std::fs::create_dir_all(dir).map_err(|e| {
            format!(
                "Failed to create MCP bridge config dir {}: {e}",
                dir.display()
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }

        let path = dir.join(format!("mcp-bridge-{}.json", Uuid::new_v4()));
        let bytes = serde_json::to_vec(&self.claude_mcp_config_json())
            .map_err(|e| format!("Failed to serialize Claude MCP bridge config: {e}"))?;

        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&path).map_err(|e| {
            format!(
                "Failed to create Claude MCP bridge config file {}: {e}",
                path.display()
            )
        })?;
        file.write_all(&bytes).map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!(
                "Failed to write Claude MCP bridge config file {}: {e}",
                path.display()
            )
        })?;
        file.flush().map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!(
                "Failed to flush Claude MCP bridge config file {}: {e}",
                path.display()
            )
        })?;

        self.temp_config_paths.push(path.clone());
        Ok(path)
    }

    /// ACP `session/new` / `session/resume` `mcpServers` array entry for Streamable HTTP.
    pub(crate) fn acp_mcp_servers_json(&self) -> Value {
        json!([
            {
                "type": "http",
                "name": HARNESS_MCP_SERVER_NAME,
                "url": self.endpoint_url,
                "headers": [
                    {
                        "name": "Authorization",
                        "value": format!("Bearer {}", self.bearer_token),
                    }
                ]
            }
        ])
    }
}

impl Drop for HarnessMcpBridge {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.server_task.abort();
        for path in self.temp_config_paths.drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn normalize_mcp_input_schema(schema: &Value) -> Value {
    if let Some(obj) = schema.as_object() {
        let mut cloned = obj.clone();
        cloned
            .entry("type".to_owned())
            .or_insert_with(|| Value::String("object".to_owned()));
        Value::Object(cloned)
    } else {
        json!({ "type": "object", "properties": {} })
    }
}

fn host_is_loopback_port(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
    else {
        return false;
    };
    host.eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
        || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
}

fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    let Some(raw) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
    else {
        return false;
    };
    let Some((scheme, token)) = raw.split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("bearer") && ct_eq(token.trim(), expected)
}

fn json_response(status: StatusCode, session_id: &str, payload: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("mcp-session-id", session_id)
        .body(Body::from(payload.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
        }
    })
}

async fn handle_mcp_request(
    State(state): State<Arc<BridgeState>>,
    req: Request<Body>,
) -> Response<Body> {
    let (parts, body) = req.into_parts();

    // Reject browser cross-origin requests and non-loopback Host headers (DNS-rebinding defense).
    if parts.headers.contains_key("origin") || !host_is_loopback_port(&parts.headers, state.port) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("Forbidden MCP bridge request"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    if !bearer_matches(&parts.headers, &state.bearer_token) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from("Unauthorized MCP bridge request"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    match parts.method {
        Method::DELETE => {
            return Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header("mcp-session-id", &state.session_id)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
        Method::GET => {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header("allow", "POST, DELETE")
                .body(Body::from(
                    "GET SSE stream not supported on loopback bridge",
                ))
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
        Method::POST => {}
        _ => {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header("allow", "POST, DELETE")
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    }

    let raw_bytes = match to_bytes(body, MAX_MCP_BRIDGE_REQUEST_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .body(Body::from("MCP bridge request body too large"))
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };

    let msg: Value = match serde_json::from_slice(&raw_bytes) {
        Ok(v) => v,
        Err(err) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &state.session_id,
                jsonrpc_error(Value::Null, -32700, format!("Parse error: {err}")),
            );
        }
    };

    let Some(obj) = msg.as_object() else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &state.session_id,
            jsonrpc_error(Value::Null, -32600, "Invalid JSON-RPC request object"),
        );
    };

    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &state.session_id,
            jsonrpc_error(
                obj.get("id").cloned().unwrap_or(Value::Null),
                -32600,
                "Missing JSON-RPC method",
            ),
        );
    };

    // JSON-RPC notifications (no `id`) receive 202 Accepted per MCP Streamable HTTP spec.
    let Some(id) = obj.get("id").cloned() else {
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .header("mcp-session-id", &state.session_id)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    };

    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
    let response_payload = match method {
        "initialize" => {
            let negotiated = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_MCP_PROTOCOL_VERSION);
            jsonrpc_result(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {
                        "tools": {
                            "listChanged": false
                        }
                    },
                    "serverInfo": {
                        "name": HARNESS_MCP_SERVER_NAME,
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            )
        }
        "ping" => jsonrpc_result(id, json!({})),
        "tools/list" => jsonrpc_result(
            id,
            json!({
                "tools": state.wire_tools,
            }),
        ),
        "resources/list" => jsonrpc_result(id, json!({ "resources": [] })),
        "prompts/list" => jsonrpc_result(id, json!({ "prompts": [] })),
        "tools/call" => {
            let Some(requested_name) = params
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return json_response(
                    StatusCode::OK,
                    &state.session_id,
                    jsonrpc_error(id, -32602, "tools/call requires a non-empty tool name."),
                );
            };
            let Some(canonical_name) = state.allowed_tools.get(requested_name) else {
                return json_response(
                    StatusCode::OK,
                    &state.session_id,
                    jsonrpc_error(
                        id,
                        -32602,
                        format!(
                            "Tool '{requested_name}' is not available in this turn's Cowork harness bridge."
                        ),
                    ),
                );
            };
            let args: Map<String, Value> = match params.get("arguments") {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(map)) => map.clone(),
                Some(_) => {
                    return json_response(
                        StatusCode::OK,
                        &state.session_id,
                        jsonrpc_error(id, -32602, "tools/call arguments must be a JSON object."),
                    );
                }
            };
            let outcome = state.handler.call_tool(canonical_name, args).await;
            jsonrpc_result(
                id,
                json!({
                    "content": [
                        {
                            "type": "text",
                            "text": outcome.text,
                        }
                    ],
                    "isError": outcome.is_error,
                }),
            )
        }
        other => jsonrpc_error(id, -32601, format!("Method not found: {other}")),
    };

    json_response(StatusCode::OK, &state.session_id, response_payload)
}
