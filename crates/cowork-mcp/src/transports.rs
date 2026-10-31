use std::collections::{BTreeSet, HashMap};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::AgentConfig;
use dashmap::DashMap;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use parking_lot::Mutex;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use url::Url;

use crate::oauth::refresh_oauth_access_token;
use crate::registry::resolve_target_mcp_server;
use crate::schema::{build_mcp_tool_name, normalize_mcp_json_schema, truncate_mcp_description};
use crate::types::{
    HydratedMcpServer, LoadedMcpTool, McpAuthMode, McpAuthScope, McpConfigSource,
    McpOAuthRuntimeContext, McpServerAuthConfig, McpServerTransport, McpToolErrorEntry,
    McpToolInvoker, McpValidatedToolSummary, McpValidationResult,
};

const MAX_STDIO_LINE_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(10);
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

const SAFE_ENV_PASSTHROUGH_KEYS: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "COWORK_HOME_OVERRIDE",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
];

fn build_safe_child_env(
    base_env: &HashMap<String, String>,
    explicit_env: Option<&HashMap<String, String>>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for &key in SAFE_ENV_PASSTHROUGH_KEYS {
        if let Some(val) = base_env.get(key) {
            env.insert(key.to_owned(), val.clone());
        } else if key == "PATH"
            && let Ok(sys_path) = std::env::var("PATH")
        {
            env.insert("PATH".to_owned(), sys_path);
        }
    }
    if let Some(extra) = explicit_env {
        for (k, v) in extra {
            env.insert(k.clone(), v.clone());
        }
    }
    env.remove("COWORK_DESKTOP_PARENT_MANAGED");
    env
}

#[async_trait]
trait RpcTransport: Send + Sync {
    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String>;
    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String>;
    fn set_negotiated_protocol_version(&self, _version: String) {}
    async fn close(&self);
}

// ============================================================================
// 1. Stdio MCP Transport
// ============================================================================

struct StdioTransport {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    child: tokio::sync::Mutex<Option<Child>>,
    pid: Option<u32>,
    pending: Arc<DashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    reader_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl StdioTransport {
    async fn connect(
        command_bin: &str,
        args: &[String],
        cwd: Option<&str>,
        base_env: &HashMap<String, String>,
        explicit_env: Option<&HashMap<String, String>>,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(command_bin);
        cmd.args(args)
            .env_clear()
            .envs(build_safe_child_env(base_env, explicit_env))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(dir) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
            cmd.current_dir(dir);
        }

        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP stdio command \"{command_bin}\": {e}"))?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open stdin pipe for MCP stdio child".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open stdout pipe for MCP stdio child".to_owned())?;
        let stderr = child.stderr.take();

        let pending: Arc<DashMap<u64, oneshot::Sender<Result<Value, String>>>> =
            Arc::new(DashMap::new());
        let pending_reader = Arc::clone(&pending);

        let reader_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(4096);
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        if buf.len() > MAX_STDIO_LINE_BYTES {
                            for entry in pending_reader.iter() {
                                // Handled below after clearing
                                let _ = entry.key();
                            }
                            let keys: Vec<u64> = pending_reader.iter().map(|e| *e.key()).collect();
                            for k in keys {
                                if let Some((_, tx)) = pending_reader.remove(&k) {
                                    let _ = tx.send(Err(
                                        "MCP stdio message exceeded 10 MiB limit".to_owned()
                                    ));
                                }
                            }
                            break;
                        }
                        let Ok(line) = std::str::from_utf8(&buf) else {
                            continue;
                        };
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                            dispatch_jsonrpc_response(&pending_reader, msg);
                        }
                    }
                    Err(_) => break,
                }
            }
            let keys: Vec<u64> = pending_reader.iter().map(|e| *e.key()).collect();
            for k in keys {
                if let Some((_, tx)) = pending_reader.remove(&k) {
                    let _ = tx.send(Err("MCP stdio server closed stdout".to_owned()));
                }
            }
        });

        let stderr_task = stderr.map(|err_pipe| {
            tokio::spawn(async move {
                let mut rdr = BufReader::new(err_pipe);
                let mut sink = Vec::with_capacity(1024);
                while let Ok(n) = rdr.read_until(b'\n', &mut sink).await {
                    if n == 0 {
                        break;
                    }
                    sink.clear();
                }
            })
        });

        Ok(Arc::new(Self {
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            child: tokio::sync::Mutex::new(Some(child)),
            pid,
            pending,
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            reader_task: Mutex::new(Some(reader_task)),
            stderr_task: Mutex::new(stderr_task),
        }))
    }

    async fn write_frame(&self, frame: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "MCP stdio stdin is closed".to_owned())?;
        stdin
            .write_all(&line)
            .await
            .map_err(|e| format!("Failed writing to MCP stdio stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed flushing MCP stdio stdin: {e}"))
    }
}

#[async_trait]
impl RpcTransport for StdioTransport {
    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("MCP stdio connection is closed".to_owned());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);

        let mut payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(p) = params {
            payload["params"] = p;
        }

        if let Err(e) = self.write_frame(&payload).await {
            self.pending.remove(&id);
            return Err(e);
        }

        match tokio::time::timeout(DEFAULT_REQUEST_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(format!("MCP stdio request \"{method}\" canceled")),
            Err(_) => {
                self.pending.remove(&id);
                Err(format!("MCP stdio request \"{method}\" timed out"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut payload = json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        if let Some(p) = params {
            payload["params"] = p;
        }
        self.write_frame(&payload).await
    }

    async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // 1. Close stdin first so well-behaved servers exit cleanly
        let _ = self.stdin.lock().await.take();

        // 2. Signal the entire process group (`-pgid`) and wait briefly, escalating to SIGKILL
        #[cfg(unix)]
        if let Some(raw_pid) = self.pid {
            let pgid = raw_pid as i32;
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGTERM);
                let _ = libc::kill(pgid, libc::SIGTERM);
            }
        }

        if let Some(mut child) = self.child.lock().await.take()
            && tokio::time::timeout(Duration::from_millis(600), child.wait())
                .await
                .is_err()
        {
            #[cfg(unix)]
            if let Some(raw_pid) = self.pid {
                let pgid = raw_pid as i32;
                unsafe {
                    let _ = libc::kill(-pgid, libc::SIGKILL);
                    let _ = libc::kill(pgid, libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
        }

        if let Some(handle) = self.reader_task.lock().take() {
            handle.abort();
        }
        if let Some(handle) = self.stderr_task.lock().take() {
            handle.abort();
        }
    }
}

// ============================================================================
// 2. Legacy SSE MCP Transport
// ============================================================================

struct SseTransport {
    client: reqwest::Client,
    endpoint_url: Url,
    headers: Mutex<HashMap<String, String>>,
    oauth_ctx: Option<McpOAuthRuntimeContext>,
    pending: Arc<DashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    stream_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl SseTransport {
    async fn connect(
        sse_url_str: &str,
        initial_headers: Option<&HashMap<String, String>>,
        oauth_ctx: Option<McpOAuthRuntimeContext>,
    ) -> Result<Arc<Self>, String> {
        let sse_url = Url::parse(sse_url_str).map_err(|e| format!("Invalid SSE URL: {e}"))?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        let mut headers = initial_headers.cloned().unwrap_or_default();

        let resp =
            Self::open_sse_stream(&client, &sse_url, &mut headers, oauth_ctx.as_ref()).await?;
        let mut event_stream = resp.bytes_stream().eventsource();

        let (ep_tx, ep_rx) = oneshot::channel::<Result<Url, String>>();
        let mut ep_tx_opt = Some(ep_tx);
        let pending: Arc<DashMap<u64, oneshot::Sender<Result<Value, String>>>> =
            Arc::new(DashMap::new());
        let pending_reader = Arc::clone(&pending);
        let base_sse_url = sse_url.clone();

        let stream_task = tokio::spawn(async move {
            while let Some(item) = event_stream.next().await {
                let Ok(ev) = item else {
                    break;
                };
                if ev.event == "endpoint" {
                    if let Some(tx) = ep_tx_opt.take() {
                        let candidate = ev.data.trim();
                        match base_sse_url.join(candidate) {
                            Ok(resolved) => {
                                if same_origin(&base_sse_url, &resolved) {
                                    let _ = tx.send(Ok(resolved));
                                } else {
                                    let _ = tx.send(Err(format!(
                                        "Cross-origin MCP SSE endpoint rejected: {resolved} does not match {base_sse_url}"
                                    )));
                                    break;
                                }
                            }
                            Err(e) => {
                                let _ = tx.send(Err(format!("Invalid SSE endpoint URL: {e}")));
                                break;
                            }
                        }
                    }
                } else if (ev.event.is_empty() || ev.event == "message")
                    && let Ok(msg) = serde_json::from_str::<Value>(ev.data.trim())
                {
                    dispatch_jsonrpc_response(&pending_reader, msg);
                }
            }
            if let Some(tx) = ep_tx_opt.take() {
                let _ = tx.send(Err(
                    "SSE stream closed before emitting endpoint event".to_owned()
                ));
            }
            let keys: Vec<u64> = pending_reader.iter().map(|e| *e.key()).collect();
            for k in keys {
                if let Some((_, tx)) = pending_reader.remove(&k) {
                    let _ = tx.send(Err("MCP SSE stream closed".to_owned()));
                }
            }
        });

        let endpoint_url = match tokio::time::timeout(Duration::from_secs(10), ep_rx).await {
            Ok(Ok(Ok(u))) => u,
            Ok(Ok(Err(e))) => {
                stream_task.abort();
                return Err(e);
            }
            _ => {
                stream_task.abort();
                return Err("Timed out waiting for MCP SSE endpoint event".to_owned());
            }
        };

        Ok(Arc::new(Self {
            client,
            endpoint_url,
            headers: Mutex::new(headers),
            oauth_ctx,
            pending,
            next_id: AtomicU64::new(1),
            stream_task: Mutex::new(Some(stream_task)),
        }))
    }

    async fn open_sse_stream(
        client: &reqwest::Client,
        url: &Url,
        headers: &mut HashMap<String, String>,
        oauth_ctx: Option<&McpOAuthRuntimeContext>,
    ) -> Result<reqwest::Response, String> {
        for attempt in 0..2 {
            let mut req = client
                .get(url.clone())
                .header("Accept", "text/event-stream");
            for (k, v) in headers.iter() {
                req = req.header(k, v);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("MCP SSE GET failed: {e}"))?;
            if (resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::FORBIDDEN)
                && attempt == 0
                && let Some(ctx) = oauth_ctx
            {
                let fresh = refresh_oauth_access_token(ctx).await?;
                set_bearer_header(headers, &fresh);
                continue;
            }
            if !resp.status().is_success() {
                return Err(format!("MCP SSE GET returned HTTP {}", resp.status()));
            }
            return Ok(resp);
        }
        Err("MCP SSE authentication failed".to_owned())
    }

    async fn post_json(&self, payload: &Value) -> Result<Option<Value>, String> {
        for attempt in 0..2 {
            let hdrs = self.headers.lock().clone();
            let mut req = self
                .client
                .post(self.endpoint_url.clone())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream");
            for (k, v) in &hdrs {
                req = req.header(k, v);
            }
            let resp = req
                .json(payload)
                .send()
                .await
                .map_err(|e| format!("MCP SSE POST failed: {e}"))?;
            if (resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::FORBIDDEN)
                && attempt == 0
                && let Some(ctx) = self.oauth_ctx.as_ref()
            {
                let fresh = refresh_oauth_access_token(ctx).await?;
                set_bearer_header(&mut self.headers.lock(), &fresh);
                continue;
            }
            if !resp.status().is_success() {
                return Err(format!("MCP SSE POST returned HTTP {}", resp.status()));
            }
            let ct = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ct.contains("application/json")
                && let Ok(txt) = resp.text().await
                && !txt.trim().is_empty()
                && let Ok(val) = serde_json::from_str::<Value>(&txt)
            {
                return Ok(Some(val));
            }
            return Ok(None);
        }
        Err("MCP SSE POST failed after OAuth refresh".to_owned())
    }
}

#[async_trait]
impl RpcTransport for SseTransport {
    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);

        let mut payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(p) = params {
            payload["params"] = p;
        }

        match self.post_json(&payload).await {
            Ok(Some(direct_msg)) => {
                dispatch_jsonrpc_response(&self.pending, direct_msg);
            }
            Ok(None) => {}
            Err(e) => {
                self.pending.remove(&id);
                return Err(e);
            }
        }

        match tokio::time::timeout(DEFAULT_REQUEST_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(format!("MCP SSE request \"{method}\" canceled")),
            Err(_) => {
                self.pending.remove(&id);
                Err(format!("MCP SSE request \"{method}\" timed out"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut payload = json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        if let Some(p) = params {
            payload["params"] = p;
        }
        let _ = self.post_json(&payload).await?;
        Ok(())
    }

    async fn close(&self) {
        if let Some(handle) = self.stream_task.lock().take() {
            handle.abort();
        }
    }
}

// ============================================================================
// 3. StreamableHTTP MCP Transport
// ============================================================================

struct StreamableHttpTransport {
    client: reqwest::Client,
    url: Url,
    headers: Mutex<HashMap<String, String>>,
    oauth_ctx: Option<McpOAuthRuntimeContext>,
    session_id: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl StreamableHttpTransport {
    fn new(
        url_str: &str,
        initial_headers: Option<&HashMap<String, String>>,
        oauth_ctx: Option<McpOAuthRuntimeContext>,
    ) -> Result<Arc<Self>, String> {
        let url = Url::parse(url_str).map_err(|e| format!("Invalid HTTP MCP URL: {e}"))?;
        let client = reqwest::Client::builder()
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            client,
            url,
            headers: Mutex::new(initial_headers.cloned().unwrap_or_default()),
            oauth_ctx,
            session_id: Mutex::new(None),
            protocol_version: Mutex::new(None),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        }))
    }

    async fn send_rpc(
        &self,
        payload: &Value,
        expected_id: Option<u64>,
    ) -> Result<Option<Value>, String> {
        for attempt in 0..2 {
            let hdrs = self.headers.lock().clone();
            let sid = self.session_id.lock().clone();
            let pv = self.protocol_version.lock().clone();

            let mut req = self
                .client
                .post(self.url.clone())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream");
            for (k, v) in &hdrs {
                req = req.header(k, v);
            }
            if let Some(session_id) = sid {
                req = req.header("mcp-session-id", session_id);
            }
            if let Some(proto_ver) = pv {
                req = req.header("mcp-protocol-version", proto_ver);
            }

            let resp = req
                .json(payload)
                .send()
                .await
                .map_err(|e| format!("MCP HTTP POST failed: {e}"))?;

            if (resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::FORBIDDEN)
                && attempt == 0
                && let Some(ctx) = self.oauth_ctx.as_ref()
            {
                let fresh = refresh_oauth_access_token(ctx).await?;
                set_bearer_header(&mut self.headers.lock(), &fresh);
                continue;
            }

            if !resp.status().is_success() {
                let status = resp.status();
                let txt = resp.text().await.unwrap_or_default();
                return Err(format!("MCP HTTP POST returned {status}: {txt}"));
            }

            if let Some(resp_sid) = resp
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                *self.session_id.lock() = Some(resp_sid.to_owned());
            }

            if resp.status() == StatusCode::ACCEPTED || expected_id.is_none() {
                return Ok(None);
            }

            let want_id = expected_id.unwrap();
            let ct = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();

            if ct.contains("text/event-stream") {
                let mut stream = resp.bytes_stream().eventsource();
                while let Some(item) = stream.next().await {
                    let ev = item.map_err(|e| format!("MCP StreamableHTTP SSE error: {e}"))?;
                    if ev.data.trim().is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Value>(ev.data.trim())
                        && let Some(res) = extract_matching_rpc_result(&msg, want_id)
                    {
                        return res.map(Some);
                    }
                }
                return Err(
                    "MCP StreamableHTTP event-stream ended without matching JSON-RPC response"
                        .to_owned(),
                );
            } else {
                let msg: Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("Invalid JSON from MCP StreamableHTTP server: {e}"))?;
                if let Some(res) = extract_matching_rpc_result(&msg, want_id) {
                    return res.map(Some);
                }
                return Err("MCP StreamableHTTP JSON response ID mismatch".to_owned());
            }
        }
        Err("MCP StreamableHTTP request failed after OAuth refresh".to_owned())
    }
}

#[async_trait]
impl RpcTransport for StreamableHttpTransport {
    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(p) = params {
            payload["params"] = p;
        }
        self.send_rpc(&payload, Some(id))
            .await?
            .ok_or_else(|| format!("MCP HTTP request \"{method}\" returned empty 202 response"))
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut payload = json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        if let Some(p) = params {
            payload["params"] = p;
        }
        let _ = self.send_rpc(&payload, None).await?;
        Ok(())
    }

    fn set_negotiated_protocol_version(&self, version: String) {
        *self.protocol_version.lock() = Some(version);
    }

    async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let sid = self.session_id.lock().take();
        if let Some(session_id) = sid {
            let hdrs = self.headers.lock().clone();
            let mut req = self
                .client
                .delete(self.url.clone())
                .header("mcp-session-id", session_id);
            for (k, v) in &hdrs {
                req = req.header(k, v);
            }
            let _ = tokio::time::timeout(Duration::from_secs(3), req.send()).await;
        }
    }
}

// ============================================================================
// Handshake, Tool Discovery & Connection Invoker
// ============================================================================

struct ConnectedMcpServer {
    transport: Arc<dyn RpcTransport>,
}

#[async_trait]
impl McpToolInvoker for ConnectedMcpServer {
    async fn call_tool(&self, raw_tool_name: &str, arguments: Value) -> Result<Value, String> {
        let res = self
            .transport
            .request(
                "tools/call",
                Some(json!({
                    "name": raw_tool_name,
                    "arguments": arguments,
                })),
            )
            .await?;
        if res.get("isError").and_then(Value::as_bool) == Some(true) {
            let err_text = res
                .get("content")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("MCP tool returned isError: true");
            return Err(err_text.to_owned());
        }
        Ok(res)
    }

    async fn close(&self) {
        self.transport.close().await;
    }
}

pub(crate) struct ServerConnectionBundle {
    pub server_name: String,
    pub invoker: Arc<dyn McpToolInvoker>,
    pub raw_tools: Vec<(String, String, Value)>,
}

pub(crate) async fn connect_single_server_with_retries(
    server: &HydratedMcpServer,
    base_env: &HashMap<String, String>,
) -> Result<ServerConnectionBundle, String> {
    let retries = server.config.retries.unwrap_or(3).min(5);
    let mut last_err = String::new();
    for attempt in 0..=retries {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(u64::from(attempt.min(3)))).await;
        }
        match connect_and_list_once(server, base_env).await {
            Ok(bundle) => return Ok(bundle),
            Err(err) => {
                last_err = err;
            }
        }
    }
    Err(last_err)
}

async fn connect_and_list_once(
    server: &HydratedMcpServer,
    base_env: &HashMap<String, String>,
) -> Result<ServerConnectionBundle, String> {
    let transport: Arc<dyn RpcTransport> = match &server.config.transport {
        McpServerTransport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            StdioTransport::connect(
                command,
                args.as_deref().unwrap_or(&[]),
                cwd.as_deref(),
                base_env,
                env.as_ref(),
            )
            .await?
        }
        McpServerTransport::Sse { url, headers } => {
            SseTransport::connect(url, headers.as_ref(), server.oauth_context.clone()).await?
        }
        McpServerTransport::Http { url, headers } => {
            StreamableHttpTransport::new(url, headers.as_ref(), server.oauth_context.clone())?
        }
    };

    let init_res = match transport
        .request(
            "initialize",
            Some(json!({
                "protocolVersion": SUPPORTED_PROTOCOL_VERSIONS[0],
                "capabilities": {},
                "clientInfo": {
                    "name": "cowork",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            })),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            transport.close().await;
            return Err(e);
        }
    };

    let negotiated_version = init_res
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(SUPPORTED_PROTOCOL_VERSIONS[0]);
    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&negotiated_version) {
        transport.close().await;
        return Err(format!(
            "Unsupported MCP protocolVersion \"{negotiated_version}\" from \"{}\"",
            server.config.name
        ));
    }
    transport.set_negotiated_protocol_version(negotiated_version.to_owned());

    if let Err(e) = transport.notify("notifications/initialized", None).await {
        transport.close().await;
        return Err(e);
    }

    // Cursor-paginated `tools/list` with repeated-cursor loop guard
    let mut raw_tools = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = BTreeSet::new();
    loop {
        let params = cursor.as_ref().map(|c| json!({ "cursor": c }));
        let page = match transport.request("tools/list", params).await {
            Ok(p) => p,
            Err(e) => {
                transport.close().await;
                return Err(e);
            }
        };

        if let Some(arr) = page.get("tools").and_then(Value::as_array) {
            for item in arr {
                let Some(t_name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let desc = item
                    .get("description")
                    .and_then(Value::as_str)
                    .map(truncate_mcp_description)
                    .unwrap_or_default();
                let raw_schema = item
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                let norm_schema = normalize_mcp_json_schema(&raw_schema, true);
                raw_tools.push((t_name.to_owned(), desc, norm_schema));
            }
        }

        let next = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        match next {
            Some(c) if seen_cursors.insert(c.clone()) => {
                cursor = Some(c);
            }
            _ => break,
        }
    }

    let invoker: Arc<dyn McpToolInvoker> = Arc::new(ConnectedMcpServer { transport });
    Ok(ServerConnectionBundle {
        server_name: server.config.name.clone(),
        invoker,
        raw_tools,
    })
}

pub(crate) fn assign_collision_safe_tool_names(
    bundles: &[ServerConnectionBundle],
) -> Vec<LoadedMcpTool> {
    let mut used = BTreeSet::new();
    let mut out = Vec::new();
    for bundle in bundles {
        for (raw_name, description, schema) in &bundle.raw_tools {
            let base = build_mcp_tool_name(&bundle.server_name, raw_name);
            let mut candidate = base.clone();
            let mut suffix = 2usize;
            while !used.insert(candidate.clone()) {
                candidate = format!("{base}_{suffix}");
                suffix += 1;
            }
            out.push(LoadedMcpTool {
                qualified_name: candidate,
                server_name: bundle.server_name.clone(),
                raw_tool_name: raw_name.clone(),
                description: description.clone(),
                input_schema: schema.clone(),
                invoker: Arc::clone(&bundle.invoker),
            });
        }
    }
    out
}

/// Connects to a list of hydrated MCP servers, closing already-connected servers if any `required: true` server fails.
pub async fn load_mcp_tools<F>(
    servers: &[HydratedMcpServer],
    base_env: &HashMap<String, String>,
    mut on_log: F,
) -> Result<(Vec<LoadedMcpTool>, Vec<McpToolErrorEntry>), String>
where
    F: FnMut(String),
{
    let mut bundles: Vec<ServerConnectionBundle> = Vec::new();
    let mut errors: Vec<McpToolErrorEntry> = Vec::new();

    for srv in servers {
        match connect_single_server_with_retries(srv, base_env).await {
            Ok(bundle) => {
                bundles.push(bundle);
            }
            Err(err) => {
                on_log(format!(
                    "[MCP] Failed to connect server \"{}\": {err}",
                    srv.config.name
                ));
                if srv.config.required == Some(true) {
                    for b in &bundles {
                        b.invoker.close().await;
                    }
                    return Err(format!(
                        "Required MCP server \"{}\" failed to initialize: {err}",
                        srv.config.name
                    ));
                }
                errors.push(McpToolErrorEntry {
                    server: srv.config.name.clone(),
                    error: err,
                });
            }
        }
    }

    let tools = assign_collision_safe_tool_names(&bundles);
    Ok((tools, errors))
}

/// Validates a single target MCP server with a 10-second timeout (`cowork/mcp/server/validate`).
pub async fn validate_mcp_server(
    config: &AgentConfig,
    name: &str,
    source: Option<McpConfigSource>,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
) -> Result<McpValidationResult, String> {
    validate_mcp_server_with_env(
        config,
        &HashMap::new(),
        name,
        source,
        plugin_id,
        plugin_scope,
    )
    .await
}

/// Validates a single target MCP server with a 10-second timeout and explicit base environment.
pub async fn validate_mcp_server_with_env(
    config: &AgentConfig,
    base_env: &HashMap<String, String>,
    name: &str,
    source: Option<McpConfigSource>,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
) -> Result<McpValidationResult, String> {
    let mut target = resolve_target_mcp_server(config, name, source, plugin_id, plugin_scope)?;
    if target.auth_scope == McpAuthScope::Workspace && !config.trust_workspace_mcp {
        return Ok(McpValidationResult {
            name: target.config.name,
            ok: false,
            mode: McpAuthMode::Error,
            message: "Workspace MCP servers are untrusted (set trustWorkspaceMcp: true to enable)."
                .to_owned(),
            tool_count: None,
            tools: None,
            latency_ms: Some(0),
        });
    }
    // Validation should not spend 6s retrying inside a 10s check
    target.config.retries = Some(0);
    let mode = match target.config.auth.as_ref() {
        Some(McpServerAuthConfig::ApiKey { .. }) => McpAuthMode::ApiKey,
        Some(McpServerAuthConfig::OAuth { .. }) => McpAuthMode::OAuth,
        _ => McpAuthMode::None,
    };
    let started = std::time::Instant::now();

    match tokio::time::timeout(
        VALIDATION_TIMEOUT,
        connect_single_server_with_retries(&target, base_env),
    )
    .await
    {
        Ok(Ok(bundle)) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let tools: Vec<McpValidatedToolSummary> = bundle
                .raw_tools
                .iter()
                .map(|(n, desc, _)| McpValidatedToolSummary {
                    name: n.clone(),
                    description: if desc.is_empty() {
                        None
                    } else {
                        Some(desc.clone())
                    },
                })
                .collect();
            let count = tools.len();
            bundle.invoker.close().await;
            Ok(McpValidationResult {
                name: target.config.name,
                ok: true,
                mode,
                message: format!("Connected ({count} tool(s) discovered)."),
                tool_count: Some(count),
                tools: Some(tools),
                latency_ms: Some(latency_ms),
            })
        }
        Ok(Err(err)) => Ok(McpValidationResult {
            name: target.config.name,
            ok: false,
            mode: McpAuthMode::Error,
            message: err,
            tool_count: None,
            tools: None,
            latency_ms: Some(started.elapsed().as_millis() as u64),
        }),
        Err(_) => Ok(McpValidationResult {
            name: target.config.name,
            ok: false,
            mode: McpAuthMode::Error,
            message: "Timed out after 10s while validating MCP server.".to_owned(),
            tool_count: None,
            tools: None,
            latency_ms: Some(started.elapsed().as_millis() as u64),
        }),
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn set_bearer_header(headers: &mut HashMap<String, String>, token: &str) {
    headers.retain(|k, _| !k.eq_ignore_ascii_case("authorization"));
    headers.insert("Authorization".to_owned(), format!("Bearer {token}"));
}

fn dispatch_jsonrpc_response(
    pending: &DashMap<u64, oneshot::Sender<Result<Value, String>>>,
    msg: Value,
) {
    if let Some(arr) = msg.as_array() {
        for item in arr {
            dispatch_single_response(pending, item);
        }
    } else {
        dispatch_single_response(pending, &msg);
    }
}

fn dispatch_single_response(
    pending: &DashMap<u64, oneshot::Sender<Result<Value, String>>>,
    msg: &Value,
) {
    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some((_, tx)) = pending.remove(&id) else {
        return;
    };
    if let Some(err) = msg.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP JSON-RPC error");
        let _ = tx.send(Err(message.to_owned()));
    } else {
        let result = msg.get("result").cloned().unwrap_or(Value::Null);
        let _ = tx.send(Ok(result));
    }
}

fn extract_matching_rpc_result(msg: &Value, want_id: u64) -> Option<Result<Value, String>> {
    if let Some(arr) = msg.as_array() {
        for item in arr {
            if let Some(r) = extract_single_rpc_result(item, want_id) {
                return Some(r);
            }
        }
        None
    } else {
        extract_single_rpc_result(msg, want_id)
    }
}

fn extract_single_rpc_result(msg: &Value, want_id: u64) -> Option<Result<Value, String>> {
    let id = msg.get("id").and_then(Value::as_u64)?;
    if id != want_id {
        return None;
    }
    if let Some(err) = msg.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP JSON-RPC error");
        Some(Err(message.to_owned()))
    } else {
        Some(Ok(msg.get("result").cloned().unwrap_or(Value::Null)))
    }
}
