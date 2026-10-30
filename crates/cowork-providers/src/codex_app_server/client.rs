use std::collections::HashMap;
use std::path::Path;
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

use crate::codex_app_server::isolation::build_codex_spawn_env;
use crate::codex_app_server::policy::from_codex_mcp_tool_name;

const DEFAULT_RPC_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone)]
pub struct DynamicToolCallOutput {
    pub text: String,
    pub is_error: bool,
}

#[async_trait]
pub trait DynamicToolHandler: Send + Sync {
    async fn call_tool(&self, name: &str, arguments: Map<String, Value>) -> DynamicToolCallOutput;
}

#[derive(Debug, Clone)]
pub struct CodexTurnSteerParams {
    pub thread_id: String,
    pub expected_turn_id: String,
    pub input_text: String,
}

#[derive(Debug, Clone)]
pub struct CodexNotification {
    pub method: String,
    pub params: Value,
}

type PendingRpcMap = HashMap<String, oneshot::Sender<Result<Value, ProviderTransportError>>>;

pub struct CodexAppServerClient {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<PendingRpcMap>>,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<CodexNotification>>>>,
    child: AsyncMutex<Option<Child>>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
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

        let client = Arc::new(Self {
            stdin_tx: stdin_tx.clone(),
            pending: pending.clone(),
            subscribers: subscribers.clone(),
            child: AsyncMutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            closed: closed.clone(),
        });

        // Reader loop for newline-delimited JSON-RPC-lite messages from codex app-server
        let pending_reader = pending.clone();
        let subs_reader = subscribers.clone();
        let tx_for_server_reqs = stdin_tx;
        let closed_reader = closed;

        tokio::spawn(async move {
            let mut lines = BufReader::new(child_stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
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
                        tokio::spawn(async move {
                            let response =
                                handle_server_initiated_request(&method, &params, handler).await;
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
            let mut remaining = pending_reader.lock();
            for (_, tx) in remaining.drain() {
                let _ = tx.send(Err(ProviderTransportError::protocol(
                    "Codex app-server closed stdio stream unexpectedly.",
                )));
            }
        });

        // Perform JSON-RPC-lite `initialize` -> `initialized` handshake
        client
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
            .await?;
        client.notify("initialized", Some(json!({})));

        Ok(client)
    }

    pub fn subscribe_notifications(&self) -> mpsc::UnboundedReceiver<CodexNotification> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers.lock().push(tx);
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
        if self.closed.load(Ordering::SeqCst) {
            return Err(ProviderTransportError::protocol(
                "Codex app-server client is closed.",
            ));
        }

        let numeric_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id_key = numeric_id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id_key.clone(), tx);

        let frame = match params {
            Some(p) => json!({ "id": numeric_id, "method": method, "params": p }),
            None => json!({ "id": numeric_id, "method": method }),
        };

        if self.stdin_tx.send(frame.to_string()).is_err() {
            self.pending.lock().remove(&id_key);
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
        self.request(
            "turn/steer",
            Some(json!({
                "threadId": params.thread_id,
                "expectedTurnId": params.expected_turn_id,
                "input": [
                    {
                        "type": "text",
                        "text": params.input_text
                    }
                ]
            })),
        )
        .await
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

    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
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
        | "applyPatchApproval" => Ok(json!({ "decision": "accept" })),
        "item/tool/requestUserInput" | "mcpServer/elicitation/request" => {
            Ok(json!({ "answers": {} }))
        }
        other => Err(format!("Unsupported server request method: {other}")),
    }
}
