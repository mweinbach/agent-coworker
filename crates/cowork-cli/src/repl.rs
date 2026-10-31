use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use cowork_config::{
    ProviderName, canonicalize_sync, ensure_private_dir_sync, fallback_default_model_id,
    resolve_home_dir,
};
use cowork_protocol::JsonRpcLiteRequest;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_tools::{ASK_SKIP_TOKEN, CANONICAL_BUILTIN_TOOL_IDS};
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::client::{InboundRpcEvent, ReplRpcClient};
use crate::parser::{ParsedReplCommand, parse_repl_input};
use crate::state_store::{
    get_stored_session_for_cwd, repl_history_file_path, set_stored_session_for_cwd,
};

const REASONING_EFFORTS: [&str; 5] = ["minimal", "low", "medium", "high", "xhigh"];
const TEXT_VERBOSITIES: [&str; 3] = ["low", "medium", "high"];
const REASONING_SUMMARIES: [&str; 4] = ["auto", "concise", "detailed", "none"];

/// Options for running an interactive or scripted `cowork` CLI REPL session.
#[derive(Debug, Clone)]
pub struct ReplOptions {
    pub working_directory: PathBuf,
    pub port: u16,
    pub yolo: bool,
    pub homedir: Option<PathBuf>,
    pub built_in_dir: Option<PathBuf>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PromptReply {
    Line(String),
    Interrupted,
    Eof,
}

enum PromptInputSource {
    Scripted(VecDeque<String>),
    Interactive(Option<Box<DefaultEditor>>),
}

impl PromptInputSource {
    async fn read_turn_prompt(
        &mut self,
        prompt: &str,
        out: &mut dyn Write,
    ) -> anyhow::Result<PromptReply> {
        match self {
            Self::Scripted(lines) => {
                write!(out, "{prompt}")?;
                out.flush()?;
                match lines.pop_front() {
                    Some(line) => {
                        writeln!(out, "{line}")?;
                        out.flush()?;
                        if line == "__INTERRUPT__" {
                            Ok(PromptReply::Interrupted)
                        } else {
                            Ok(PromptReply::Line(line))
                        }
                    }
                    None => Ok(PromptReply::Eof),
                }
            }
            Self::Interactive(rl_slot) => {
                out.flush()?;
                let prompt_owned = prompt.to_owned();
                let mut rl = rl_slot
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("Interactive editor unavailable"))?;
                let (returned_rl, res) = tokio::task::spawn_blocking(move || {
                    let r = rl.readline(&prompt_owned);
                    (rl, r)
                })
                .await?;
                *rl_slot = Some(returned_rl);
                match res {
                    Ok(line) => Ok(PromptReply::Line(line)),
                    Err(ReadlineError::Interrupted) => Ok(PromptReply::Interrupted),
                    Err(ReadlineError::Eof) => Ok(PromptReply::Eof),
                    Err(err) => Err(err.into()),
                }
            }
        }
    }
}

struct ActiveReplSession {
    cwd: PathBuf,
    homedir: PathBuf,
    env: HashMap<String, String>,
    yolo: bool,
    server: ServerHandle,
    rpc: ReplRpcClient,
    thread_id: String,
    provider: String,
    model: String,
    catalog: Value,
    listen_os_ctrl_c: bool,
    interrupt_notify: Option<Arc<Notify>>,
}

impl ActiveReplSession {
    async fn bootstrap(opts: ReplOptions, out: &mut dyn Write) -> anyhow::Result<Self> {
        let cwd = canonicalize_sync(&opts.working_directory);
        let homedir = opts
            .homedir
            .clone()
            .map(|h| canonicalize_sync(&h))
            .unwrap_or_else(|| {
                canonicalize_sync(&resolve_home_dir(&opts.env, cowork_config::host_platform()))
            });

        let server = start_server(ServerOptions {
            working_directory: cwd.clone(),
            host: "127.0.0.1".to_owned(),
            port: opts.port,
            yolo: opts.yolo,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".to_owned(),
            mobile_h3_port: 0,
            homedir: Some(homedir.clone()),
            built_in_dir: opts.built_in_dir,
            env: opts.env.clone(),
        })
        .await?;

        let mut rpc =
            ReplRpcClient::connect_and_handshake(server.ws_url(), env!("CARGO_PKG_VERSION"))
                .await?;

        let cwd_str = cwd.to_string_lossy().into_owned();
        let _ = rpc
            .request("cowork/session/state/read", Some(json!({ "cwd": cwd_str })))
            .await;

        let catalog_res = rpc
            .request(
                "cowork/provider/catalog/read",
                Some(json!({ "cwd": cwd_str })),
            )
            .await
            .unwrap_or_else(|_| json!({}));
        let catalog = catalog_res
            .get("event")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let stored_tid = get_stored_session_for_cwd(&homedir, &opts.env, &cwd);
        let (thread_val, was_resumed) = if let Some(tid) = stored_tid {
            match rpc
                .request("thread/resume", Some(json!({ "threadId": tid })))
                .await
            {
                Ok(res) => (res["thread"].clone(), true),
                Err(_) => {
                    let started = rpc
                        .request("thread/start", Some(json!({ "cwd": cwd_str })))
                        .await?;
                    (started["thread"].clone(), false)
                }
            }
        } else {
            let started = rpc
                .request("thread/start", Some(json!({ "cwd": cwd_str })))
                .await?;
            (started["thread"].clone(), false)
        };

        let thread_id = thread_val["id"].as_str().unwrap_or_default().to_owned();
        let provider = thread_val["modelProvider"]
            .as_str()
            .unwrap_or("openai")
            .to_owned();
        let model = thread_val["model"].as_str().unwrap_or("gpt-5.4").to_owned();

        let _ = set_stored_session_for_cwd(&homedir, &opts.env, &cwd, &thread_id);

        writeln!(
            out,
            "Cowork CLI v{} — connected ({provider} / {model})",
            env!("CARGO_PKG_VERSION")
        )?;
        writeln!(out, "Workspace: {}", cwd.display())?;
        writeln!(
            out,
            "Thread: {thread_id} (type /help for commands, /exit to quit)"
        )?;
        if was_resumed
            && let Ok(read_res) = rpc
                .request(
                    "thread/read",
                    Some(json!({
                        "threadId": thread_id,
                        "includeTurns": true,
                    })),
                )
                .await
        {
            render_thread_history_if_any(&read_res, out)?;
        }
        rpc.drain_brief_notifications(20).await;
        rpc.pending_notifications.clear();
        out.flush()?;

        Ok(Self {
            cwd,
            homedir,
            env: opts.env,
            yolo: opts.yolo,
            server,
            rpc,
            thread_id,
            provider,
            model,
            catalog,
            listen_os_ctrl_c: false,
            interrupt_notify: None,
        })
    }

    fn default_model_for_provider(&self, provider_id: &str) -> String {
        if let Some(m) = self
            .catalog
            .get("default")
            .and_then(|d| d.get(provider_id))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return m.to_owned();
        }
        ProviderName::parse(provider_id)
            .map(|p| fallback_default_model_id(p).to_owned())
            .unwrap_or_default()
    }

    /// Handles one line of user input. Returns `Ok(false)` when REPL should exit (`/exit`).
    async fn handle_line(
        &mut self,
        line: &str,
        prompt_source: &mut PromptInputSource,
        out: &mut dyn Write,
    ) -> anyhow::Result<bool> {
        match parse_repl_input(line) {
            ParsedReplCommand::Message(msg) if msg.is_empty() => Ok(true),

            ParsedReplCommand::Help => {
                writeln!(out, "Available commands:")?;
                writeln!(out, "  /help                      Show this help message")?;
                writeln!(out, "  /sessions                  List workspace threads")?;
                writeln!(out, "  /new                       Start a new thread")?;
                writeln!(
                    out,
                    "  /resume <threadId>         Resume an existing thread"
                )?;
                writeln!(
                    out,
                    "  /provider <name>           Switch active model provider"
                )?;
                writeln!(out, "  /model <id>                Switch active model")?;
                writeln!(
                    out,
                    "  /reasoning <effort>        Set reasoning effort (minimal|low|medium|high|xhigh)"
                )?;
                writeln!(
                    out,
                    "  /tools                     List available session tools"
                )?;
                writeln!(
                    out,
                    "  /skills                    List discovered workspace skills"
                )?;
                writeln!(
                    out,
                    "  /mcp                       List configured MCP servers"
                )?;
                writeln!(
                    out,
                    "  /connect [provider] [key]  View or configure provider credentials"
                )?;
                writeln!(
                    out,
                    "  /compact                   Compact current conversation context"
                )?;
                writeln!(out, "  /clear                     Clear terminal view")?;
                writeln!(out, "  /exit                      Exit Cowork CLI")?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Exit => {
                writeln!(out, "Goodbye.")?;
                out.flush()?;
                Ok(false)
            }

            ParsedReplCommand::New => {
                let cwd_str = self.cwd.to_string_lossy().into_owned();
                let res = self
                    .rpc
                    .request("thread/start", Some(json!({ "cwd": cwd_str })))
                    .await?;
                if let Some(tid) = res["thread"]["id"].as_str() {
                    self.thread_id = tid.to_owned();
                    let _ = set_stored_session_for_cwd(&self.homedir, &self.env, &self.cwd, tid);
                    writeln!(out, "Started new thread: {tid}")?;
                }
                self.rpc.drain_brief_notifications(15).await;
                self.rpc.pending_notifications.clear();
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Sessions => {
                let cwd_str = self.cwd.to_string_lossy().into_owned();
                let list_res = self
                    .rpc
                    .request("thread/list", Some(json!({ "cwd": cwd_str })))
                    .await?;
                writeln!(out, "Current thread: {}", self.thread_id)?;
                if let Some(threads) = list_res["threads"].as_array()
                    && !threads.is_empty()
                {
                    writeln!(out, "Saved workspace threads ({}):", threads.len())?;
                    for t in threads {
                        let id = t["id"].as_str().unwrap_or("");
                        let title = t["title"].as_str().unwrap_or("Untitled");
                        let marker = if id == self.thread_id { "*" } else { " " };
                        writeln!(out, " {marker} {id} — {title}")?;
                    }
                }
                writeln!(
                    out,
                    "Use /new to start a new thread, /resume <threadId> to resume one."
                )?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Resume(arg) => {
                let target = arg.trim();
                if target.is_empty() {
                    writeln!(out, "usage: /resume <threadId>")?;
                    out.flush()?;
                    return Ok(true);
                }
                match self
                    .rpc
                    .request("thread/resume", Some(json!({ "threadId": target })))
                    .await
                {
                    Ok(res) => {
                        let tid = res["thread"]["id"].as_str().unwrap_or(target).to_owned();
                        if let Some(p) = res["thread"]["modelProvider"].as_str() {
                            self.provider = p.to_owned();
                        }
                        if let Some(m) = res["thread"]["model"].as_str() {
                            self.model = m.to_owned();
                        }
                        self.thread_id = tid.clone();
                        let _ =
                            set_stored_session_for_cwd(&self.homedir, &self.env, &self.cwd, &tid);
                        writeln!(
                            out,
                            "Resumed thread: {tid} ({} / {})",
                            self.provider, self.model
                        )?;
                        if let Ok(read_res) = self
                            .rpc
                            .request(
                                "thread/read",
                                Some(json!({
                                    "threadId": tid,
                                    "includeTurns": true,
                                })),
                            )
                            .await
                        {
                            render_thread_history_if_any(&read_res, out)?;
                        }
                        self.rpc.drain_brief_notifications(15).await;
                        self.rpc.pending_notifications.clear();
                    }
                    Err(err) => {
                        writeln!(out, "Failed to resume {target}: {err}")?;
                    }
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Provider(arg) => {
                let name = arg.split_whitespace().next().unwrap_or("").trim();
                let valid_names: Vec<&str> = ProviderName::ALL.iter().map(|p| p.as_str()).collect();
                let Some(parsed) = ProviderName::parse(name) else {
                    writeln!(out, "usage: /provider <{}>", valid_names.join("|"))?;
                    out.flush()?;
                    return Ok(true);
                };
                let next_model = self.default_model_for_provider(parsed.as_str());
                if parsed == ProviderName::Lmstudio
                    && (next_model.is_empty() || next_model == "local-model")
                {
                    writeln!(
                        out,
                        "LM Studio has no default LLM right now. Set a model explicitly with /model <key>."
                    )?;
                    out.flush()?;
                    return Ok(true);
                }
                let res = self
                    .rpc
                    .request(
                        "cowork/session/model/set",
                        Some(json!({
                            "threadId": self.thread_id,
                            "provider": parsed.as_str(),
                            "model": next_model,
                        })),
                    )
                    .await?;
                self.provider = parsed.as_str().to_owned();
                self.model = res["event"]["config"]["model"]
                    .as_str()
                    .unwrap_or(&next_model)
                    .to_owned();
                writeln!(
                    out,
                    "Provider set to {} (model: {})",
                    self.provider, self.model
                )?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Model(arg) => {
                let model_id = arg.trim();
                if model_id.is_empty() {
                    writeln!(
                        out,
                        "Current model: {} ({}) — usage: /model <id>",
                        self.model, self.provider
                    )?;
                    out.flush()?;
                    return Ok(true);
                }
                let res = self
                    .rpc
                    .request(
                        "cowork/session/model/set",
                        Some(json!({
                            "threadId": self.thread_id,
                            "model": model_id,
                        })),
                    )
                    .await?;
                self.model = res["event"]["config"]["model"]
                    .as_str()
                    .unwrap_or(model_id)
                    .to_owned();
                writeln!(out, "Model set to {} ({})", self.model, self.provider)?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Reasoning(arg) => {
                let val = arg
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !REASONING_EFFORTS.contains(&val.as_str()) {
                    writeln!(out, "usage: /reasoning <{}>", REASONING_EFFORTS.join("|"))?;
                    out.flush()?;
                    return Ok(true);
                }
                self.rpc
                    .request(
                        "cowork/session/config/set",
                        Some(json!({
                            "threadId": self.thread_id,
                            "config": {
                                "providerOptions": {
                                    (&self.provider): { "reasoningEffort": val }
                                }
                            }
                        })),
                    )
                    .await?;
                writeln!(out, "{} reasoning effort set to {val}", self.provider)?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Verbosity(arg) => {
                let val = arg
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !TEXT_VERBOSITIES.contains(&val.as_str()) {
                    writeln!(out, "usage: /verbosity <{}>", TEXT_VERBOSITIES.join("|"))?;
                    out.flush()?;
                    return Ok(true);
                }
                self.rpc
                    .request(
                        "cowork/session/config/set",
                        Some(json!({
                            "threadId": self.thread_id,
                            "config": {
                                "providerOptions": {
                                    (&self.provider): { "textVerbosity": val }
                                }
                            }
                        })),
                    )
                    .await?;
                writeln!(out, "{} verbosity set to {val}", self.provider)?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::ReasoningSummary(arg) => {
                let val = arg
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !REASONING_SUMMARIES.contains(&val.as_str()) {
                    writeln!(
                        out,
                        "usage: /reasoning-summary <{}>",
                        REASONING_SUMMARIES.join("|")
                    )?;
                    out.flush()?;
                    return Ok(true);
                }
                self.rpc
                    .request(
                        "cowork/session/config/set",
                        Some(json!({
                            "threadId": self.thread_id,
                            "config": {
                                "providerOptions": {
                                    (&self.provider): { "reasoningSummary": val }
                                }
                            }
                        })),
                    )
                    .await?;
                writeln!(out, "{} reasoning summary set to {val}", self.provider)?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Tools => {
                let cwd_str = self.cwd.to_string_lossy().into_owned();
                let _ = self
                    .rpc
                    .request("cowork/session/state/read", Some(json!({ "cwd": cwd_str })))
                    .await?;
                writeln!(out, "Tools:")?;
                for name in CANONICAL_BUILTIN_TOOL_IDS {
                    writeln!(out, "  - {name}")?;
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Skills => {
                let cwd_str = self.cwd.to_string_lossy().into_owned();
                let res = self
                    .rpc
                    .request("cowork/skills/list", Some(json!({ "cwd": cwd_str })))
                    .await?;
                let skills = res["event"]["skills"]
                    .as_array()
                    .or_else(|| res["skills"].as_array())
                    .cloned()
                    .unwrap_or_default();
                if skills.is_empty() {
                    writeln!(out, "No custom skills discovered in workspace.")?;
                } else {
                    writeln!(out, "Skills:")?;
                    for s in skills {
                        writeln!(out, "  - {}", s["name"].as_str().unwrap_or(""))?;
                    }
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Mcp => {
                let cwd_str = self.cwd.to_string_lossy().into_owned();
                let res = self
                    .rpc
                    .request("cowork/mcp/servers/read", Some(json!({ "cwd": cwd_str })))
                    .await?;
                let servers = res["event"]["servers"]
                    .as_array()
                    .or_else(|| res["servers"].as_array())
                    .cloned()
                    .unwrap_or_default();
                if servers.is_empty() {
                    writeln!(out, "No MCP servers configured.")?;
                } else {
                    writeln!(out, "MCP servers:")?;
                    for s in servers {
                        writeln!(out, "  - {}", s["name"].as_str().unwrap_or(""))?;
                    }
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Connect(arg) => {
                let cwd_str = self.cwd.to_string_lossy().into_owned();
                let mut parts = arg.splitn(2, char::is_whitespace);
                let first = parts.next().unwrap_or("").trim();
                let rest = parts.next().unwrap_or("").trim();
                if first.is_empty() || first == "list" || first == "help" {
                    let cat = self
                        .rpc
                        .request(
                            "cowork/provider/catalog/read",
                            Some(json!({ "cwd": cwd_str })),
                        )
                        .await?;
                    self.catalog = cat["event"].clone();
                    let connected: Vec<&str> = self.catalog["connected"]
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if connected.is_empty() {
                        writeln!(out, "Connected providers: (none)")?;
                    } else {
                        writeln!(out, "Connected providers: {}", connected.join(", "))?;
                    }
                    writeln!(out, "Usage: /connect <provider> <api_key>")?;
                } else if !rest.is_empty() {
                    let res = self
                        .rpc
                        .request(
                            "cowork/provider/auth/setApiKey",
                            Some(json!({
                                "cwd": cwd_str,
                                "provider": first,
                                "apiKey": rest,
                            })),
                        )
                        .await?;
                    writeln!(
                        out,
                        "{}",
                        res["event"]["message"]
                            .as_str()
                            .unwrap_or("Saved credentials.")
                    )?;
                } else {
                    writeln!(out, "usage: /connect {first} <api_key>")?;
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::ClearHardCap => {
                self.rpc
                    .request(
                        "cowork/session/usageBudget/set",
                        Some(json!({
                            "threadId": self.thread_id,
                            "stopAtUsd": Value::Null,
                        })),
                    )
                    .await?;
                writeln!(out, "session hard-stop threshold cleared")?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Compact => {
                let _ = self
                    .rpc
                    .request(
                        "thread/compact/start",
                        Some(json!({ "threadId": self.thread_id })),
                    )
                    .await;
                self.rpc.drain_brief_notifications(25).await;
                self.rpc.pending_notifications.clear();
                writeln!(
                    out,
                    "Conversation context compacted for thread {}.",
                    self.thread_id
                )?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Clear => {
                writeln!(out, "Cleared screen.")?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Restart | ParsedReplCommand::Cwd(_) => {
                writeln!(out, "Active workspace: {}", self.cwd.display())?;
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Unknown { name, arg } => {
                let cmds = self
                    .rpc
                    .request("command/list", Some(json!({ "threadId": self.thread_id })))
                    .await
                    .ok()
                    .and_then(|v| v["commands"].as_array().cloned())
                    .unwrap_or_default();
                if cmds
                    .iter()
                    .any(|c| c["name"].as_str() == Some(name.as_str()))
                {
                    let _ = self
                        .rpc
                        .request(
                            "command/execute",
                            Some(json!({
                                "threadId": self.thread_id,
                                "name": name,
                                "arguments": arg,
                                "clientMessageId": Uuid::new_v4().to_string(),
                            })),
                        )
                        .await?;
                    self.rpc.drain_brief_notifications(50).await;
                    self.rpc.pending_notifications.clear();
                    writeln!(out, "Executed /{name}.")?;
                } else {
                    writeln!(out, "Unknown command: /{name} (type /help for commands)")?;
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Message(msg) => {
                self.execute_turn(&msg, prompt_source, out).await?;
                Ok(true)
            }
        }
    }

    async fn execute_turn(
        &mut self,
        msg: &str,
        prompt_source: &mut PromptInputSource,
        out: &mut dyn Write,
    ) -> anyhow::Result<()> {
        self.rpc.pending_notifications.clear();

        let client_message_id = Uuid::new_v4().to_string();
        let start_res = match self
            .rpc
            .request(
                "turn/start",
                Some(json!({
                    "threadId": self.thread_id,
                    "clientMessageId": client_message_id,
                    "input": msg,
                })),
            )
            .await
        {
            Ok(res) => res,
            Err(err) => {
                writeln!(out, "[error] Failed to start turn: {err}")?;
                out.flush()?;
                return Ok(());
            }
        };

        let turn_id = start_res
            .get("turn")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        let mut in_reasoning = false;
        let mut in_agent_text = false;
        let mut interrupt_sent = false;

        loop {
            let listen_ctrl_c = self.listen_os_ctrl_c && !interrupt_sent;
            let custom_notify = if !interrupt_sent {
                self.interrupt_notify.clone()
            } else {
                None
            };

            enum StepWake {
                Inbound(anyhow::Result<InboundRpcEvent>),
                Interrupted,
            }

            let wake = tokio::select! {
                ev = self.rpc.next_inbound_event() => StepWake::Inbound(ev),
                _ = async {
                    if listen_ctrl_c {
                        let _ = tokio::signal::ctrl_c().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => StepWake::Interrupted,
                _ = async {
                    if let Some(n) = custom_notify {
                        n.notified().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => StepWake::Interrupted,
            };

            match wake {
                StepWake::Interrupted => {
                    interrupt_sent = true;
                    if in_reasoning || in_agent_text {
                        writeln!(out)?;
                        in_reasoning = false;
                        in_agent_text = false;
                    }
                    writeln!(out, "^C Interrupting turn...")?;
                    out.flush()?;
                    let _ = self
                        .rpc
                        .request(
                            "turn/interrupt",
                            Some(json!({ "threadId": self.thread_id })),
                        )
                        .await;
                }
                StepWake::Inbound(Err(err)) => {
                    if in_reasoning || in_agent_text {
                        writeln!(out)?;
                    }
                    return Err(err);
                }
                StepWake::Inbound(Ok(InboundRpcEvent::ServerRequest(req))) => {
                    if in_reasoning || in_agent_text {
                        writeln!(out)?;
                        in_reasoning = false;
                        in_agent_text = false;
                    }
                    let should_interrupt = self
                        .handle_server_request(req, prompt_source, out, interrupt_sent)
                        .await?;
                    if should_interrupt && !interrupt_sent {
                        interrupt_sent = true;
                        writeln!(out, "^C Interrupting turn...")?;
                        out.flush()?;
                        let _ = self
                            .rpc
                            .request(
                                "turn/interrupt",
                                Some(json!({ "threadId": self.thread_id })),
                            )
                            .await;
                    }
                }
                StepWake::Inbound(Ok(InboundRpcEvent::Notification(notif))) => {
                    let params = notif.params.unwrap_or(Value::Null);
                    if let Some(ev_tid) = params.get("threadId").and_then(Value::as_str)
                        && ev_tid != self.thread_id
                    {
                        continue;
                    }

                    match notif.method.as_str() {
                        "item/reasoning/delta" => {
                            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                            if !delta.is_empty() {
                                if in_agent_text {
                                    writeln!(out)?;
                                    in_agent_text = false;
                                }
                                if !in_reasoning {
                                    write!(out, "[thinking] ")?;
                                    in_reasoning = true;
                                }
                                write!(out, "{delta}")?;
                                out.flush()?;
                            }
                        }
                        "item/agentMessage/delta" => {
                            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                            if !delta.is_empty() {
                                if in_reasoning {
                                    writeln!(out)?;
                                    in_reasoning = false;
                                }
                                in_agent_text = true;
                                write!(out, "{delta}")?;
                                out.flush()?;
                            }
                        }
                        "item/started" => {
                            if let Some(item) = params.get("item")
                                && item.get("type").and_then(Value::as_str) == Some("toolCall")
                            {
                                if in_reasoning || in_agent_text {
                                    writeln!(out)?;
                                    in_reasoning = false;
                                    in_agent_text = false;
                                }
                                let name = item
                                    .get("toolName")
                                    .or_else(|| item.get("name"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool");
                                writeln!(out, "[tool] {name} (running)")?;
                                out.flush()?;
                            }
                        }
                        "item/completed" => {
                            if let Some(item) = params.get("item") {
                                match item.get("type").and_then(Value::as_str) {
                                    Some("toolCall") => {
                                        let state = item
                                            .get("state")
                                            .and_then(Value::as_str)
                                            .unwrap_or("completed");
                                        if !matches!(
                                            state,
                                            "output-available" | "output-error" | "output-denied"
                                        ) {
                                            continue;
                                        }
                                        if in_reasoning || in_agent_text {
                                            writeln!(out)?;
                                            in_reasoning = false;
                                            in_agent_text = false;
                                        }
                                        let name = item
                                            .get("toolName")
                                            .or_else(|| item.get("name"))
                                            .and_then(Value::as_str)
                                            .unwrap_or("tool");
                                        if state == "output-error" {
                                            let err_text = item
                                                .get("errorText")
                                                .and_then(Value::as_str)
                                                .or_else(|| {
                                                    item.get("result")
                                                        .and_then(|r| r.get("error"))
                                                        .and_then(Value::as_str)
                                                })
                                                .unwrap_or("");
                                            writeln!(out, "[tool] {name} -> {state}: {err_text}")?;
                                        } else {
                                            writeln!(out, "[tool] {name} -> {state}")?;
                                        }
                                        out.flush()?;
                                    }
                                    Some("error") => {
                                        if in_reasoning || in_agent_text {
                                            writeln!(out)?;
                                            in_reasoning = false;
                                            in_agent_text = false;
                                        }
                                        let msg = item
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Turn error");
                                        writeln!(out, "[error] {msg}")?;
                                        out.flush()?;
                                    }
                                    Some("agentMessage") => {
                                        if !in_agent_text {
                                            let text = item
                                                .get("text")
                                                .and_then(Value::as_str)
                                                .unwrap_or("");
                                            if !text.is_empty() {
                                                if in_reasoning {
                                                    writeln!(out)?;
                                                    in_reasoning = false;
                                                }
                                                writeln!(out, "{text}")?;
                                                out.flush()?;
                                            }
                                        } else {
                                            writeln!(out)?;
                                            in_agent_text = false;
                                            out.flush()?;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "error" => {
                            if in_reasoning || in_agent_text {
                                writeln!(out)?;
                                in_reasoning = false;
                                in_agent_text = false;
                            }
                            let message = params
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("Turn error");
                            writeln!(out, "[error] {message}")?;
                            out.flush()?;
                        }
                        "turn/completed" => {
                            let completed_tid = params
                                .get("turn")
                                .and_then(|t| t.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if !turn_id.is_empty()
                                && !completed_tid.is_empty()
                                && completed_tid != turn_id
                            {
                                continue;
                            }
                            if in_reasoning || in_agent_text {
                                writeln!(out)?;
                            }
                            let status = params
                                .get("turn")
                                .and_then(|t| t.get("status"))
                                .and_then(Value::as_str)
                                .unwrap_or("completed");
                            if status == "interrupted" {
                                writeln!(out, "[Turn interrupted]")?;
                            } else if status == "failed"
                                && let Some(em) = params
                                    .get("turn")
                                    .and_then(|t| t.get("error"))
                                    .and_then(|e| e.get("message"))
                                    .and_then(Value::as_str)
                            {
                                writeln!(out, "[Turn failed: {em}]")?;
                            }
                            out.flush()?;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }

    async fn handle_server_request(
        &mut self,
        req: JsonRpcLiteRequest,
        prompt_source: &mut PromptInputSource,
        out: &mut dyn Write,
        already_interrupted: bool,
    ) -> anyhow::Result<bool> {
        let params = req.params.unwrap_or(Value::Null);
        match req.method.as_str() {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                if already_interrupted || self.yolo {
                    let decision = if self.yolo && !already_interrupted {
                        "accept"
                    } else {
                        "decline"
                    };
                    self.rpc
                        .respond_to_server_request(req.id, json!({ "decision": decision }))
                        .await?;
                    return Ok(false);
                }

                let command = params.get("command").and_then(Value::as_str).unwrap_or("");
                let reason = params.get("reason").and_then(Value::as_str).unwrap_or("");
                if !command.is_empty() {
                    writeln!(out, "[approval] Command requires approval: {command}")?;
                } else {
                    writeln!(out, "[approval] File modification requires approval")?;
                }
                if !reason.is_empty() {
                    writeln!(out, "  Reason: {reason}")?;
                }
                out.flush()?;

                match prompt_source
                    .read_turn_prompt("Approve? [y/N]: ", out)
                    .await?
                {
                    PromptReply::Line(ans) => {
                        let trimmed = ans.trim();
                        let decision = if matches!(
                            trimmed.to_ascii_lowercase().as_str(),
                            "y" | "yes" | "accept" | "approve"
                        ) {
                            "accept"
                        } else {
                            "decline"
                        };
                        self.rpc
                            .respond_to_server_request(req.id, json!({ "decision": decision }))
                            .await?;
                        Ok(false)
                    }
                    PromptReply::Interrupted => {
                        self.rpc
                            .respond_to_server_request(req.id, json!({ "decision": "decline" }))
                            .await?;
                        Ok(true)
                    }
                    PromptReply::Eof => {
                        self.rpc
                            .respond_to_server_request(req.id, json!({ "decision": "decline" }))
                            .await?;
                        Ok(false)
                    }
                }
            }
            "item/tool/requestUserInput" => {
                let questions = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut answers = Map::new();
                let mut interrupted = already_interrupted;

                for q in &questions {
                    let qid = q.get("id").and_then(Value::as_str).unwrap_or("q");
                    if interrupted {
                        answers.insert(qid.to_owned(), json!({ "answers": [ASK_SKIP_TOKEN] }));
                        continue;
                    }

                    let header = q
                        .get("header")
                        .and_then(Value::as_str)
                        .unwrap_or("Question");
                    let question_text = q.get("question").and_then(Value::as_str).unwrap_or("");
                    let options = q
                        .get("options")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();

                    writeln!(out, "[question] {header}: {question_text}")?;
                    for (idx, opt) in options.iter().enumerate() {
                        let label = opt.get("label").and_then(Value::as_str).unwrap_or("");
                        let desc = opt.get("description").and_then(Value::as_str).unwrap_or("");
                        if desc.is_empty() {
                            writeln!(out, "  {}. {label}", idx + 1)?;
                        } else {
                            writeln!(out, "  {}. {label} - {desc}", idx + 1)?;
                        }
                    }
                    out.flush()?;

                    let chosen = loop {
                        match prompt_source
                            .read_turn_prompt("Answer (or 'skip'): ", out)
                            .await?
                        {
                            PromptReply::Line(raw) => {
                                let trimmed = raw.trim();
                                if trimmed.is_empty() {
                                    writeln!(
                                        out,
                                        "Please enter a non-empty answer or type 'skip'."
                                    )?;
                                    out.flush()?;
                                    continue;
                                }
                                if matches!(
                                    trimmed.to_ascii_lowercase().as_str(),
                                    "skip" | "/skip" | "[skipped]"
                                ) {
                                    break ASK_SKIP_TOKEN.to_owned();
                                }
                                if !options.is_empty()
                                    && let Ok(num) = trimmed.parse::<usize>()
                                    && (1..=options.len()).contains(&num)
                                    && let Some(lbl) =
                                        options[num - 1].get("label").and_then(Value::as_str)
                                {
                                    break lbl.to_owned();
                                }
                                break trimmed.to_owned();
                            }
                            PromptReply::Interrupted => {
                                interrupted = true;
                                break ASK_SKIP_TOKEN.to_owned();
                            }
                            PromptReply::Eof => {
                                break ASK_SKIP_TOKEN.to_owned();
                            }
                        }
                    };

                    answers.insert(qid.to_owned(), json!({ "answers": [chosen] }));
                }

                self.rpc
                    .respond_to_server_request(req.id, json!({ "answers": answers }))
                    .await?;
                Ok(interrupted && !already_interrupted)
            }
            _ => {
                self.rpc
                    .respond_to_server_request(req.id, json!({}))
                    .await?;
                Ok(false)
            }
        }
    }

    async fn shutdown(self) {
        self.rpc.close().await;
        self.server.shutdown().await;
    }
}

fn render_thread_history_if_any(read_res: &Value, out: &mut dyn Write) -> anyhow::Result<()> {
    let Some(turns) = read_res
        .get("thread")
        .and_then(|t| t.get("turns"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    if turns.is_empty() {
        return Ok(());
    }

    writeln!(
        out,
        "--- Conversation History ({} turn(s)) ---",
        turns.len()
    )?;
    for turn in turns {
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("userMessage") => {
                    let mut parts = Vec::new();
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for c in content {
                            if let Some(txt) = c.get("text").and_then(Value::as_str)
                                && !txt.is_empty()
                            {
                                parts.push(txt);
                            }
                        }
                    }
                    if !parts.is_empty() {
                        writeln!(out, "you> {}", parts.join("\n"))?;
                    }
                }
                Some("reasoning") => {
                    let txt = item.get("text").and_then(Value::as_str).unwrap_or("");
                    if !txt.is_empty() {
                        writeln!(out, "[thinking] {txt}")?;
                    }
                }
                Some("toolCall") => {
                    let name = item
                        .get("toolName")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let state = item
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    writeln!(out, "[tool] {name} -> {state}")?;
                }
                Some("agentMessage") => {
                    let txt = item.get("text").and_then(Value::as_str).unwrap_or("");
                    if !txt.is_empty() {
                        writeln!(out, "{txt}")?;
                    }
                }
                _ => {}
            }
        }
    }
    writeln!(out, "--- End History ---")?;
    out.flush()?;
    Ok(())
}

/// Runs a deterministic scripted REPL session over an array of input lines and returns rendered output.
pub async fn run_repl_scripted(opts: ReplOptions, lines: &[&str]) -> anyhow::Result<String> {
    run_repl_scripted_with_interrupt(opts, lines, None).await
}

/// Runs a deterministic scripted REPL session with an optional mid-turn interrupt notifier.
pub async fn run_repl_scripted_with_interrupt(
    opts: ReplOptions,
    lines: &[&str],
    interrupt_notify: Option<Arc<Notify>>,
) -> anyhow::Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut session = ActiveReplSession::bootstrap(opts, &mut buf).await?;
    session.interrupt_notify = interrupt_notify;

    let mut prompt_source =
        PromptInputSource::Scripted(lines.iter().map(|s| (*s).to_owned()).collect());
    loop {
        let next_line = match &mut prompt_source {
            PromptInputSource::Scripted(q) => q.pop_front(),
            PromptInputSource::Interactive(_) => None,
        };
        let Some(line) = next_line else {
            break;
        };
        if !session
            .handle_line(&line, &mut prompt_source, &mut buf)
            .await?
        {
            break;
        }
    }
    session.shutdown().await;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Runs the interactive `rustyline` terminal REPL (`you> ` prompt) until `/exit` or EOF.
pub async fn run_repl_interactive(
    opts: ReplOptions,
    one_shot_prompt: Option<String>,
) -> anyhow::Result<()> {
    let mut stdout = std::io::stdout();
    let mut session = ActiveReplSession::bootstrap(opts, &mut stdout).await?;
    session.listen_os_ctrl_c = true;

    let history_path = repl_history_file_path(&session.homedir, &session.env);
    if let Some(parent) = history_path.parent() {
        let _ = ensure_private_dir_sync(parent);
    }

    let mut rl = DefaultEditor::new()?;
    let _ = rl.load_history(&history_path);
    let mut prompt_source = PromptInputSource::Interactive(Some(Box::new(rl)));

    if let Some(prompt) = one_shot_prompt {
        let _ = session
            .handle_line(&prompt, &mut prompt_source, &mut stdout)
            .await?;
        session.shutdown().await;
        return Ok(());
    }

    loop {
        let history_clone = history_path.clone();
        let mut editor = match &mut prompt_source {
            PromptInputSource::Interactive(slot) => slot
                .take()
                .ok_or_else(|| anyhow::anyhow!("Interactive editor unavailable"))?,
            PromptInputSource::Scripted(_) => unreachable!(),
        };

        // Run blocking rustyline readline inside spawn_blocking so Tokio background server tasks keep ticking smoothly!
        let (next_rl, read_res) = tokio::task::spawn_blocking(move || {
            let res = editor.readline("you> ");
            if let Ok(ref line) = res
                && !line.trim().is_empty()
            {
                let _ = editor.add_history_entry(line.as_str());
                let _ = editor.save_history(&history_clone);
            }
            (editor, res)
        })
        .await?;

        if let PromptInputSource::Interactive(slot) = &mut prompt_source {
            *slot = Some(next_rl);
        }

        match read_res {
            Ok(line) => {
                if !session
                    .handle_line(&line, &mut prompt_source, &mut stdout)
                    .await?
                {
                    break;
                }
            }
            Err(ReadlineError::Interrupted) => {
                writeln!(stdout, "(Use /exit or Ctrl+D to quit)")?;
                stdout.flush()?;
            }
            Err(ReadlineError::Eof) => {
                writeln!(stdout, "Goodbye.")?;
                stdout.flush()?;
                break;
            }
            Err(err) => {
                return Err(err.into());
            }
        }
    }

    session.shutdown().await;
    Ok(())
}
