use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use cowork_inference::ProviderTransportError;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::codex_app_server::installer::CodexRuntimeInstallOptions;
use crate::codex_app_server::isolation::{build_codex_spawn_env, resolve_codex_home};
use crate::codex_app_server::policy::from_codex_mcp_tool_name;

const DEFAULT_RPC_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone)]
pub struct DynamicToolCallOutput {
    pub text: String,
    pub is_error: bool,
}

/// What a dynamic tool bridge knows about the Cowork tool context that must also bound Codex's
/// native tools, which bypass Cowork's own tool checks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexNativeToolContext {
    /// A Cowork mutation guard (`before_tool_invocation`, TS `assertCanMutate`, e.g. the
    /// `createTask` source-chat lock) is installed. With dynamic tools on the turn, YOLO then keeps
    /// `approvalPolicy: "on-request"` so native effects still cross the guard via approvals.
    pub has_mutation_guard: bool,
    /// Writable roots of Cowork's resolved workspace-write sandbox (workspace, output and uploads
    /// directories, tool-runtime roots); see [`super::policy::codex_workspace_write_roots`].
    pub writable_roots: Vec<PathBuf>,
}

#[async_trait]
pub trait DynamicToolHandler: Send + Sync {
    /// Cowork tool-context facts for the native sandbox/approval policy. The default (no guard,
    /// no extra roots) only ever narrows Codex.
    fn native_tool_context(&self) -> CodexNativeToolContext {
        CodexNativeToolContext::default()
    }

    async fn call_tool(&self, name: &str, arguments: Map<String, Value>) -> DynamicToolCallOutput;

    /// Native approval requests fail closed: a handler that does not evaluate the request
    /// (or a missing handler) must never turn into an unsandboxed `accept`.
    async fn request_approval(&self, _method: &str, _params: &Value) -> bool {
        false
    }

    async fn request_user_input(&self, _method: &str, _params: &Value) -> Value {
        json!({ "answers": {} })
    }
}

#[derive(Debug, Clone)]
pub struct CodexTurnSteerParams {
    pub thread_id: String,
    pub expected_turn_id: String,
    pub input_text: String,
    /// Structured Codex `UserInput` items (text, `image`, `localImage`), e.g. from
    /// [`super::codex_steer_input`]. When empty, `input_text` is sent as a single text item.
    pub input: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct CodexNotification {
    pub method: String,
    pub params: Value,
}

type PendingRpcMap = HashMap<String, oneshot::Sender<Result<Value, ProviderTransportError>>>;

/// A `turn/steer` input the app-server accepted for a live turn.
#[derive(Debug, Clone)]
struct AcceptedNativeSteer {
    seq: u64,
    thread_id: String,
    turn_id: String,
    input: Vec<Value>,
}

pub struct CodexAppServerClient {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<PendingRpcMap>>,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<CodexNotification>>>>,
    child: AsyncMutex<Option<Child>>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    /// Cancels the stdout reader and every in-flight server-initiated request handler (dynamic
    /// tool calls, approvals, user-input prompts) when the client closes or is dropped.
    shutdown: CancellationToken,
    /// `turn/steer` requests awaiting their response, keyed by request id. The reader loop moves
    /// each one to `accepted_steers` when its success response arrives, i.e. in stdout order and
    /// therefore before the `turn/completed` that ends the steered turn is dispatched.
    pending_steers: Arc<Mutex<HashMap<String, AcceptedNativeSteer>>>,
    accepted_steers: Arc<Mutex<Vec<AcceptedNativeSteer>>>,
}

impl CodexAppServerClient {
    pub async fn spawn_stdio(
        command: &str,
        args: &[String],
        cwd: &Path,
        cowork_home: &Path,
        env: &HashMap<String, String>,
        tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    ) -> Result<Arc<Self>, ProviderTransportError> {
        let spawn_env = build_codex_spawn_env(cowork_home, env);

        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(spawn_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Own process group so closing the client can kill the whole app-server tree (its
        // sandboxed shells, code-mode host, MCP servers) instead of orphaning grandchildren.
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|err| {
            ProviderTransportError::protocol(format!(
                "Failed to spawn codex app-server ({command}): {err}"
            ))
        })?;

        let mut child_stdin = child.stdin.take().ok_or_else(|| {
            ProviderTransportError::protocol("Failed to capture codex app-server stdin")
        })?;
        let child_stdout = child.stdout.take().ok_or_else(|| {
            ProviderTransportError::protocol("Failed to capture codex app-server stdout")
        })?;
        let child_stderr = child.stderr.take();

        // Drain stderr asynchronously so child never blocks on pipe backpressure
        if let Some(stderr) = child_stderr {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(_)) = reader.next_line().await {}
            });
        }

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(mut line) = stdin_rx.recv().await {
                if !line.ends_with('\n') {
                    line.push('\n');
                }
                if child_stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = child_stdin.flush().await;
            }
        });

        let pending: Arc<Mutex<PendingRpcMap>> = Arc::new(Mutex::new(HashMap::new()));
        let subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<CodexNotification>>>> =
            Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let shutdown = CancellationToken::new();

        let client = Arc::new(Self {
            stdin_tx: stdin_tx.clone(),
            pending: pending.clone(),
            subscribers: subscribers.clone(),
            child: AsyncMutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            closed: closed.clone(),
            shutdown: shutdown.clone(),
            pending_steers: Arc::new(Mutex::new(HashMap::new())),
            accepted_steers: Arc::new(Mutex::new(Vec::new())),
        });

        // Reader loop for newline-delimited JSON-RPC-lite messages from codex app-server
        let pending_reader = pending.clone();
        let subs_reader = subscribers.clone();
        let tx_for_server_reqs = stdin_tx;
        let closed_reader = closed;
        let shutdown_reader = shutdown;
        let pending_steers_reader = Arc::clone(&client.pending_steers);
        let accepted_steers_reader = Arc::clone(&client.accepted_steers);

        tokio::spawn(async move {
            let mut lines = BufReader::new(child_stdout).lines();
            loop {
                let line = tokio::select! {
                    biased;
                    () = shutdown_reader.cancelled() => break,
                    next = lines.next_line() => match next {
                        Ok(Some(line)) => line,
                        _ => break,
                    },
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                let Some(obj) = msg.as_object() else {
                    continue;
                };

                let id_opt = obj.get("id").cloned();
                let method_opt = obj
                    .get("method")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);

                match (id_opt, method_opt) {
                    // Server-initiated JSON-RPC request (e.g. dynamic tool call or approval)
                    (Some(req_id), Some(method)) => {
                        let params = obj.get("params").cloned().unwrap_or(Value::Null);
                        let tx_reply = tx_for_server_reqs.clone();
                        let handler = tool_handler.clone();
                        let shutdown_req = shutdown_reader.clone();
                        tokio::spawn(async move {
                            // Closing the client aborts the handler (e.g. a dynamic tool call or
                            // a pending approval prompt) instead of leaving it detached.
                            let response = tokio::select! {
                                biased;
                                () = shutdown_req.cancelled() => return,
                                res = handle_server_initiated_request(&method, &params, handler) => res,
                            };
                            let reply = match response {
                                Ok(res) => json!({ "id": req_id, "result": res }),
                                Err(err_msg) => json!({
                                    "id": req_id,
                                    "error": { "code": -32603, "message": err_msg }
                                }),
                            };
                            let _ = tx_reply.send(reply.to_string());
                        });
                    }
                    // Response to our outbound request
                    (Some(resp_id), None) => {
                        let id_key = id_value_to_key(&resp_id);
                        let steer = pending_steers_reader.lock().remove(&id_key);
                        if let Some(steer) = steer
                            && obj.get("error").is_none()
                        {
                            accepted_steers_reader.lock().push(steer);
                        }
                        let sender = pending_reader.lock().remove(&id_key);
                        if let Some(tx) = sender {
                            if let Some(err_obj) = obj.get("error") {
                                let err_msg = err_obj
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex JSON-RPC error")
                                    .to_string();
                                let _ = tx.send(Err(ProviderTransportError::protocol(err_msg)));
                            } else {
                                let result = obj.get("result").cloned().unwrap_or(Value::Null);
                                let _ = tx.send(Ok(result));
                            }
                        }
                    }
                    // Server notification
                    (None, Some(method)) => {
                        let params = obj.get("params").cloned().unwrap_or(Value::Null);
                        let notif = CodexNotification { method, params };
                        let mut subs = subs_reader.lock();
                        subs.retain(|s| s.send(notif.clone()).is_ok());
                    }
                    _ => {}
                }
            }

            closed_reader.store(true, Ordering::SeqCst);
            pending_steers_reader.lock().clear();
            // Drop every notification sender so subscribers observe the closed stream instead of
            // waiting for a `turn/completed` that a dead app-server can never send.
            subs_reader.lock().clear();
            let mut remaining = pending_reader.lock();
            for (_, tx) in remaining.drain() {
                let _ = tx.send(Err(ProviderTransportError::protocol(
                    "Codex app-server closed stdio stream unexpectedly.",
                )));
            }
        });

        // Perform JSON-RPC-lite `initialize` -> `initialized` handshake
        if let Err(err) = client
            .request(
                "initialize",
                Some(json!({
                    "clientInfo": {
                        "name": "agent-coworker",
                        "title": "Agent Coworker",
                        "version": "0.1.0"
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                })),
            )
            .await
        {
            client.close().await;
            return Err(err);
        }
        client.notify("initialized", Some(json!({})));

        Ok(client)
    }

    pub fn subscribe_notifications(&self) -> mpsc::UnboundedReceiver<CodexNotification> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut subs = self.subscribers.lock();
        // Once the reader loop has exited, hand back an already-closed receiver.
        if !self.closed.load(Ordering::SeqCst) {
            subs.push(tx);
        }
        rx
    }

    pub fn notify(&self, method: &str, params: Option<Value>) {
        // Omit `"jsonrpc": "2.0"` per Cowork JSON-RPC-lite wire rule
        let frame = match params {
            Some(p) => json!({ "method": method, "params": p }),
            None => json!({ "method": method }),
        };
        let _ = self.stdin_tx.send(frame.to_string());
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, ProviderTransportError> {
        self.request_with_timeout(
            method,
            params,
            Duration::from_millis(DEFAULT_RPC_TIMEOUT_MS),
        )
        .await
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, ProviderTransportError> {
        self.request_tracking_steer(method, params, timeout, None)
            .await
    }

    async fn request_tracking_steer(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
        steer: Option<AcceptedNativeSteer>,
    ) -> Result<Value, ProviderTransportError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ProviderTransportError::protocol(
                "Codex app-server client is closed.",
            ));
        }

        let numeric_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id_key = numeric_id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id_key.clone(), tx);
        if let Some(mut steer) = steer {
            // Registered before the frame is written so the reader can never miss the response.
            steer.seq = numeric_id;
            self.pending_steers.lock().insert(id_key.clone(), steer);
        }

        let frame = match params {
            Some(p) => json!({ "id": numeric_id, "method": method, "params": p }),
            None => json!({ "id": numeric_id, "method": method }),
        };

        if self.stdin_tx.send(frame.to_string()).is_err() {
            self.pending.lock().remove(&id_key);
            self.pending_steers.lock().remove(&id_key);
            return Err(ProviderTransportError::protocol(
                "Failed to write request to codex app-server stdin.",
            ));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(ProviderTransportError::protocol(format!(
                "Codex app-server dropped response channel for {method}"
            ))),
            Err(_) => {
                self.pending.lock().remove(&id_key);
                self.pending_steers.lock().remove(&id_key);
                Err(ProviderTransportError::timeout(format!(
                    "Codex app-server request {method} timed out"
                )))
            }
        }
    }

    pub async fn steer_turn(
        &self,
        params: CodexTurnSteerParams,
    ) -> Result<Value, ProviderTransportError> {
        let input = if params.input.is_empty() {
            vec![json!({
                "type": "text",
                "text": params.input_text,
                "text_elements": [],
            })]
        } else {
            params.input
        };
        let payload = json!({
            "threadId": params.thread_id,
            "expectedTurnId": params.expected_turn_id,
            "input": input,
        });
        self.request_tracking_steer(
            "turn/steer",
            Some(payload),
            Duration::from_millis(DEFAULT_RPC_TIMEOUT_MS),
            Some(AcceptedNativeSteer {
                seq: 0,
                thread_id: params.thread_id,
                turn_id: params.expected_turn_id,
                input,
            }),
        )
        .await
    }

    /// Removes and returns (in send order) the `turn/steer` inputs the app-server accepted for
    /// `turn_id` of `thread_id`. They were consumed by that turn, so the continuation recorded
    /// for it must cover them.
    pub fn take_accepted_steer_inputs(&self, thread_id: &str, turn_id: &str) -> Vec<Vec<Value>> {
        let mut accepted = self.accepted_steers.lock();
        let (mut mine, rest): (Vec<_>, Vec<_>) = accepted
            .drain(..)
            .partition(|s| s.thread_id == thread_id && s.turn_id == turn_id);
        *accepted = rest;
        mine.sort_by_key(|s| s.seq);
        mine.into_iter().map(|s| s.input).collect()
    }

    pub async fn interrupt_turn(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), ProviderTransportError> {
        let mut p = Map::new();
        p.insert("threadId".into(), Value::String(thread_id.to_string()));
        if let Some(tid) = turn_id {
            p.insert("turnId".into(), Value::String(tid.to_string()));
        }
        let _ = self
            .request("turn/interrupt", Some(Value::Object(p)))
            .await?;
        Ok(())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Hard-closes the app-server: aborts in-flight server-initiated request handlers and kills
    /// the whole process tree (its process group on Unix, `taskkill /T /F` on Windows).
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.shutdown.cancel();
        if let Some(mut child) = self.child.lock().await.take() {
            // Kill the tree while the root is still unreaped, so its pid/pgid cannot be reused.
            if let Some(pid) = child.id() {
                kill_process_tree(pid).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        self.shutdown.cancel();
        // `kill_on_drop` only reaches the root process; take the rest of the tree with it.
        if let Some(child) = self.child.get_mut().as_mut()
            && let Some(pid) = child.id()
        {
            kill_process_tree_blocking(pid);
            let _ = child.start_kill();
        }
    }
}

#[cfg(unix)]
fn process_tree_kill_command(pid: u32) -> std::process::Command {
    // The app-server leads its own process group (`process_group(0)`): signal the group.
    let mut cmd = std::process::Command::new("kill");
    cmd.args(["-s", "KILL", "--", &format!("-{pid}")]);
    cmd
}

#[cfg(windows)]
fn process_tree_kill_command(pid: u32) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

async fn kill_process_tree(pid: u32) {
    #[cfg(any(unix, windows))]
    {
        let mut cmd = Command::from(process_tree_kill_command(pid));
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = tokio::time::timeout(Duration::from_secs(5), cmd.status()).await;
    }
    #[cfg(not(any(unix, windows)))]
    let _ = pid;
}

fn kill_process_tree_blocking(pid: u32) {
    #[cfg(any(unix, windows))]
    {
        let _ = process_tree_kill_command(pid)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = pid;
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PoolKey {
    cwd: PathBuf,
    codex_home: PathBuf,
}

#[derive(Default)]
pub struct CodexAppServerPool {
    entries: AsyncMutex<HashMap<PoolKey, Arc<CodexAppServerClient>>>,
}

impl CodexAppServerPool {
    pub fn new() -> Self {
        Self {
            entries: AsyncMutex::new(HashMap::new()),
        }
    }

    /// Returns the live pooled client for `(cwd, codex_home)`, spawning one when needed. Like TS
    /// `resolveCodexAppServerCommand`, a missing (or stale) Cowork-managed runtime is installed
    /// from the pinned, checksum-verified release first, so ChatGPT sign-in works on a clean
    /// machine.
    pub async fn get_or_spawn(
        &self,
        cwd: &Path,
        cowork_home: &Path,
        env: &HashMap<String, String>,
    ) -> Result<Arc<CodexAppServerClient>, ProviderTransportError> {
        let codex_home = resolve_codex_home(cowork_home);
        let key = PoolKey {
            cwd: cwd.to_path_buf(),
            codex_home,
        };

        {
            let mut map = self.entries.lock().await;
            if let Some(existing) = map.get(&key) {
                if !existing.is_closed() {
                    return Ok(Arc::clone(existing));
                }
                map.remove(&key);
            }
        }

        // Resolve (and, if needed, download) the runtime without holding the pool lock, so a
        // slow install never blocks `close_for_home` / other workspaces.
        let (command, args) = super::ensure_codex_runtime_command(
            cowork_home,
            env,
            &CodexRuntimeInstallOptions::from_env(env),
        )
        .await?;
        let client =
            CodexAppServerClient::spawn_stdio(&command, &args, cwd, cowork_home, env, None).await?;

        let mut map = self.entries.lock().await;
        if let Some(existing) = map.get(&key)
            && !existing.is_closed()
        {
            // A concurrent caller won the race; keep its client and discard ours.
            let existing = Arc::clone(existing);
            drop(map);
            client.close().await;
            return Ok(existing);
        }
        map.insert(key, Arc::clone(&client));
        Ok(client)
    }

    pub async fn first_active_for_home(
        &self,
        codex_home: &Path,
    ) -> Option<Arc<CodexAppServerClient>> {
        let mut map = self.entries.lock().await;
        map.retain(|_, c| !c.is_closed());
        map.iter()
            .find(|(k, _)| k.codex_home == codex_home)
            .map(|(_, c)| Arc::clone(c))
    }

    pub async fn close_for_home(&self, codex_home: &Path) {
        let to_close: Vec<Arc<CodexAppServerClient>> = {
            let mut map = self.entries.lock().await;
            let keys: Vec<PoolKey> = map
                .keys()
                .filter(|k| k.codex_home == codex_home)
                .cloned()
                .collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for client in to_close {
            client.close().await;
        }
    }

    pub async fn close_all(&self) {
        let to_close: Vec<Arc<CodexAppServerClient>> = {
            let mut map = self.entries.lock().await;
            map.drain().map(|(_, c)| c).collect()
        };
        for client in to_close {
            client.close().await;
        }
    }
}

fn id_value_to_key(val: &Value) -> String {
    match val {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

async fn handle_server_initiated_request(
    method: &str,
    params: &Value,
    tool_handler: Option<Arc<dyn DynamicToolHandler>>,
) -> Result<Value, String> {
    match method {
        "item/tool/call" => {
            let Some(handler) = tool_handler else {
                return Ok(json!({
                    "contentItems": [{ "type": "inputText", "text": "Dynamic tool handler unavailable." }],
                    "success": false
                }));
            };
            let raw_tool_name = params
                .get("tool")
                .or_else(|| params.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let canonical_name = from_codex_mcp_tool_name(raw_tool_name);
            let args = params
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();

            let out = handler.call_tool(&canonical_name, args).await;
            Ok(json!({
                "contentItems": [
                    {
                        "type": "inputText",
                        "text": out.text
                    }
                ],
                "success": !out.is_error
            }))
        }
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "execCommandApproval"
        | "applyPatchApproval" => {
            let approved = match tool_handler {
                Some(h) => h.request_approval(method, params).await,
                None => false,
            };
            Ok(json!({ "decision": if approved { "accept" } else { "decline" } }))
        }
        // TS `handleServerRequest`: MCP elicitations are unsupported and always declined; they
        // carry no `questions`, so they must never reach the user-input bridge.
        "mcpServer/elicitation/request" => {
            let server = params
                .get("serverName")
                .and_then(Value::as_str)
                .unwrap_or("unknown MCP server");
            tracing::info!(
                "[codex-app-server] Declined unsupported MCP elicitation from {server}."
            );
            Ok(json!({ "action": "decline", "content": null, "_meta": null }))
        }
        "item/tool/requestUserInput" => match tool_handler {
            Some(h) => Ok(h.request_user_input(method, params).await),
            None => Ok(json!({ "answers": {} })),
        },
        other => Err(format!("Unsupported server request method: {other}")),
    }
}
