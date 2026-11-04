use std::io::{self, IsTerminal, Write};
use std::time::Duration;

use cowork_providers::ProviderAuthMethod;
use serde_json::{Map, Value, json};

use super::{ActiveReplSession, PromptInputSource, PromptReply, sanitize};

async fn read_auth_input(
    source: &mut PromptInputSource,
    prompt: &str,
    secret: bool,
    out: &mut dyn Write,
) -> anyhow::Result<Option<String>> {
    let reply = if !secret {
        source.read_turn_prompt(prompt, out).await?
    } else {
        write!(out, "{prompt}")?;
        out.flush()?;
        match source {
            PromptInputSource::Scripted(lines) => match lines.pop_front() {
                Some(line) if line == "__INTERRUPT__" => PromptReply::Interrupted,
                Some(line) => PromptReply::Line(line),
                None => PromptReply::Eof,
            },
            PromptInputSource::Interactive(_) => {
                let input = tokio::task::spawn_blocking(|| {
                    if io::stdin().is_terminal() {
                        // The password reader raises SIGINT on Ctrl-C. Keep the REPL alive so
                        // its reader can restore terminal echo and return Interrupted.
                        #[cfg(unix)]
                        let _interrupt = tokio::signal::unix::signal(
                            tokio::signal::unix::SignalKind::interrupt(),
                        )?;
                        #[cfg(windows)]
                        let _interrupt = tokio::signal::windows::ctrl_c()?;
                        rpassword::read_password().map(PromptReply::Line)
                    } else {
                        let mut line = String::new();
                        match io::stdin().read_line(&mut line)? {
                            0 => Ok(PromptReply::Eof),
                            _ => Ok(PromptReply::Line(line)),
                        }
                    }
                })
                .await?;
                match input {
                    Ok(reply) => reply,
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::Interrupted | io::ErrorKind::UnexpectedEof
                        ) =>
                    {
                        PromptReply::Interrupted
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }
    };
    match reply {
        PromptReply::Line(line) => Ok(Some(line.trim().to_owned())),
        PromptReply::Interrupted | PromptReply::Eof => {
            writeln!(out, "Connect cancelled.")?;
            Ok(None)
        }
    }
}

async fn choose_method<'a>(
    methods: &'a [ProviderAuthMethod],
    provider: &str,
    source: &mut PromptInputSource,
    out: &mut dyn Write,
) -> anyhow::Result<Option<&'a ProviderAuthMethod>> {
    if methods.len() <= 1 {
        return Ok(methods.first());
    }
    writeln!(out, "Auth methods for {}:", sanitize(provider))?;
    for (i, method) in methods.iter().enumerate() {
        writeln!(
            out,
            "  {}. {} [{}]",
            i + 1,
            sanitize(&method.label),
            sanitize(&method.id)
        )?;
    }
    loop {
        let Some(choice) =
            read_auth_input(source, "Select a method or cancel: ", false, out).await?
        else {
            return Ok(None);
        };
        if matches!(
            choice.to_ascii_lowercase().as_str(),
            "cancel" | "c" | "q" | "quit"
        ) {
            writeln!(out, "Connect cancelled.")?;
            return Ok(None);
        }
        if choice.is_empty() {
            return Ok(methods.first());
        }
        let index = choice.parse::<usize>().ok().and_then(|n| n.checked_sub(1));
        if let Some(method) = index.and_then(|i| methods.get(i)).or_else(|| {
            methods
                .iter()
                .find(|method| method.id.eq_ignore_ascii_case(&choice))
        }) {
            return Ok(Some(method));
        }
        writeln!(out, "Invalid selection. Enter a number or method ID.")?;
    }
}

impl ActiveReplSession {
    pub(super) async fn connect_provider(
        &mut self,
        provider: &str,
        source: &mut PromptInputSource,
        out: &mut dyn Write,
    ) -> anyhow::Result<()> {
        let cwd = self.cwd.to_string_lossy();
        let response = self
            .rpc
            .request(
                "cowork/provider/authMethods/read",
                Some(json!({ "cwd": cwd })),
            )
            .await?;
        let Some(methods) = response["event"]["methods"].get(provider) else {
            writeln!(out, "Error: Unknown provider {}.", sanitize(provider))?;
            return Ok(());
        };
        let methods: Vec<ProviderAuthMethod> = serde_json::from_value(methods.clone())?;
        let Some(method) = choose_method(&methods, provider, source, out).await? else {
            return Ok(());
        };
        let mut params = json!({ "cwd": cwd, "provider": provider, "methodId": method.id });
        let result = if method.method_type == "oauth" {
            let response = self
                .rpc
                .request("cowork/provider/auth/authorize", Some(params.clone()))
                .await?;
            let challenge = &response["event"]["challenge"];
            for key in ["instructions", "url", "command"] {
                if let Some(text) = challenge[key].as_str() {
                    writeln!(out, "{}", sanitize(text))?;
                }
            }
            out.flush()?;
            if method.oauth_mode.as_deref() != Some("auto") {
                return Ok(());
            }
            // Codex allows five minutes for the user to finish browser sign-in.
            self.rpc
                .request_with_timeout(
                    "cowork/provider/auth/callback",
                    Some(params),
                    Duration::from_secs(330),
                )
                .await?
        } else if let Some(fields) = method.fields.as_deref().filter(|f| !f.is_empty()) {
            let mut values = Map::new();
            for field in fields {
                let required = field.required == Some(true);
                let suffix = if required { " (required)" } else { "" };
                let label = sanitize(&field.label);
                let prompt = format!("{provider} {label}{suffix}: ");
                let secret = field.kind == "password" || field.secret == Some(true);
                let Some(value) = read_auth_input(source, &prompt, secret, out).await? else {
                    return Ok(());
                };
                if !value.is_empty() {
                    values.insert(field.id.clone(), Value::String(value));
                } else if required {
                    writeln!(out, "{label} is required.")?;
                    return Ok(());
                }
            }
            params["values"] = Value::Object(values);
            self.rpc
                .request("cowork/provider/auth/setConfig", Some(params))
                .await?
        } else {
            let Some(key) =
                read_auth_input(source, &format!("{provider} API key: "), true, out).await?
            else {
                return Ok(());
            };
            if key.is_empty() {
                writeln!(out, "API key is required for {provider}.")?;
                return Ok(());
            }
            params["apiKey"] = Value::String(key);
            self.rpc
                .request("cowork/provider/auth/setApiKey", Some(params))
                .await?
        };
        if let Some(message) = result["event"]["message"].as_str() {
            writeln!(out, "{}", sanitize(message))?;
        }
        Ok(())
    }
}
