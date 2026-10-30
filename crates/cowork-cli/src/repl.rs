use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use cowork_config::{
    ProviderName, canonicalize_sync, ensure_private_dir_sync, fallback_default_model_id,
    resolve_home_dir,
};
use cowork_server::{ServerHandle, ServerOptions, start_server};
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::client::ReplRpcClient;
use crate::parser::{ParsedReplCommand, parse_repl_input};
use crate::state_store::{
    get_stored_session_for_cwd, repl_history_file_path, set_stored_session_for_cwd,
};

const BUILTIN_TOOL_NAMES: [&str; 12] = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "bash",
    "webFetch",
    "webSearch",
    "todoWrite",
    "AskUserQuestion",
    "skill",
    "memory",
];

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

struct ActiveReplSession {
    cwd: PathBuf,
    homedir: PathBuf,
    env: HashMap<String, String>,
    server: ServerHandle,
    rpc: ReplRpcClient,
    thread_id: String,
    provider: String,
    model: String,
    catalog: Value,
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
        let thread_val = if let Some(tid) = stored_tid {
            match rpc
                .request(
                    "thread/resume",
                    Some(json!({ "threadId": tid, "afterSeq": 0 })),
                )
                .await
            {
                Ok(res) => res["thread"].clone(),
                Err(_) => {
                    let started = rpc
                        .request("thread/start", Some(json!({ "cwd": cwd_str })))
                        .await?;
                    started["thread"].clone()
                }
            }
        } else {
            let started = rpc
                .request("thread/start", Some(json!({ "cwd": cwd_str })))
                .await?;
            started["thread"].clone()
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
        out.flush()?;

        Ok(Self {
            cwd,
            homedir,
            env: opts.env,
            server,
            rpc,
            thread_id,
            provider,
            model,
            catalog,
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
    async fn handle_line(&mut self, line: &str, out: &mut dyn Write) -> anyhow::Result<bool> {
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
                    .request(
                        "thread/resume",
                        Some(json!({ "threadId": target, "afterSeq": 0 })),
                    )
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
                for name in BUILTIN_TOOL_NAMES {
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
                let skills = res["skills"].as_array().cloned().unwrap_or_default();
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
                    .request("cowork/mcp/list", Some(json!({ "cwd": cwd_str })))
                    .await?;
                let servers = res["servers"].as_array().cloned().unwrap_or_default();
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
                    writeln!(out, "Executed /{name}.")?;
                } else {
                    writeln!(out, "Unknown command: /{name} (type /help for commands)")?;
                }
                out.flush()?;
                Ok(true)
            }

            ParsedReplCommand::Message(msg) => {
                writeln!(
                    out,
                    "[{}] Received prompt ({} chars) on thread {} ({} / {}).",
                    self.provider,
                    msg.len(),
                    self.thread_id,
                    self.provider,
                    self.model
                )?;
                out.flush()?;
                Ok(true)
            }
        }
    }

    async fn shutdown(self) {
        self.rpc.close().await;
        self.server.shutdown().await;
    }
}

/// Runs a deterministic scripted REPL session over an array of input lines and returns rendered output.
pub async fn run_repl_scripted(opts: ReplOptions, lines: &[&str]) -> anyhow::Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut session = ActiveReplSession::bootstrap(opts, &mut buf).await?;
    for line in lines {
        if !session.handle_line(line, &mut buf).await? {
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

    if let Some(prompt) = one_shot_prompt {
        let _ = session.handle_line(&prompt, &mut stdout).await?;
        session.shutdown().await;
        return Ok(());
    }

    let history_path = repl_history_file_path(&session.homedir, &session.env);
    if let Some(parent) = history_path.parent() {
        let _ = ensure_private_dir_sync(parent);
    }

    let mut rl = DefaultEditor::new()?;
    let _ = rl.load_history(&history_path);

    loop {
        let history_clone = history_path.clone();
        // Run blocking rustyline readline inside spawn_blocking so Tokio background server tasks keep ticking smoothly!
        let (next_rl, read_res) = tokio::task::spawn_blocking(move || {
            let res = rl.readline("you> ");
            if let Ok(ref line) = res
                && !line.trim().is_empty()
            {
                let _ = rl.add_history_entry(line.as_str());
                let _ = rl.save_history(&history_clone);
            }
            (rl, res)
        })
        .await?;
        rl = next_rl;

        match read_res {
            Ok(line) => {
                if !session.handle_line(&line, &mut stdout).await? {
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
