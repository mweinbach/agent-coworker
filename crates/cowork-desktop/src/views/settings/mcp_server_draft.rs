//! MCP server draft form serialization and validation (`mcpServerDraft.ts`, `mcpServerEditorState.ts`).

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::state::McpServerSummary;

/// Editable fields backing the MCP server editor dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpDraftInput {
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    pub command: String,
    pub args: String,
    pub url: String,
    pub env_lines: String,
    pub header_lines: String,
}

impl Default for McpDraftInput {
    fn default() -> Self {
        Self {
            name: String::new(),
            transport: "stdio".to_string(),
            enabled: true,
            command: String::new(),
            args: String::new(),
            url: String::new(),
            env_lines: String::new(),
            header_lines: String::new(),
        }
    }
}

/// Validation failure mapped to a specific field in the MCP editor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpDraftValidationError {
    pub field: &'static str,
    pub message: String,
}

impl std::fmt::Display for McpDraftValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Splits a command arguments string with single/double quotes and backslash escapes.
pub fn parse_args_line(raw: &str) -> Result<Vec<String>, McpDraftValidationError> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    let mut has_token = false;

    for ch in raw.chars() {
        if escape {
            current.push(ch);
            escape = false;
            has_token = true;
            continue;
        }
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                current.push(ch);
            }
            has_token = true;
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
            } else if ch == '\\' {
                escape = true;
            } else {
                current.push(ch);
            }
            has_token = true;
            continue;
        }
        match ch {
            '\\' => {
                escape = true;
                has_token = true;
            }
            '\'' => {
                in_single = true;
                has_token = true;
            }
            '"' => {
                in_double = true;
                has_token = true;
            }
            c if c.is_whitespace() => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            other => {
                current.push(other);
                has_token = true;
            }
        }
    }

    if escape || in_single || in_double {
        return Err(McpDraftValidationError {
            field: "args",
            message: "Unclosed quote or trailing escape in arguments.".to_string(),
        });
    }
    if has_token {
        args.push(current);
    }
    Ok(args)
}

/// Parses `KEY=VALUE` lines into a sorted map. Ignores blank lines and `#` comments.
pub fn parse_env_lines(raw: &str) -> Result<BTreeMap<String, String>, McpDraftValidationError> {
    let mut env = BTreeMap::new();
    for (idx, raw_line) in raw.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, val)) = line.split_once('=') else {
            return Err(McpDraftValidationError {
                field: "env",
                message: format!("Line {} in Environment must use KEY=VALUE format.", idx + 1),
            });
        };
        let key_trimmed = key.trim();
        if key_trimmed.is_empty() {
            return Err(McpDraftValidationError {
                field: "env",
                message: format!("Line {} has an empty variable name.", idx + 1),
            });
        }
        env.insert(key_trimmed.to_string(), val.trim().to_string());
    }
    Ok(env)
}

/// Parses `Header-Name: value` lines into a sorted map. Ignores blank lines.
pub fn parse_header_lines(raw: &str) -> Result<BTreeMap<String, String>, McpDraftValidationError> {
    let mut headers = BTreeMap::new();
    for (idx, raw_line) in raw.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, val)) = line.split_once(':') else {
            return Err(McpDraftValidationError {
                field: "headers",
                message: format!("Line {} in Headers must use Name: value format.", idx + 1),
            });
        };
        let name_trimmed = name.trim();
        if name_trimmed.is_empty() || name_trimmed.contains(char::is_whitespace) {
            return Err(McpDraftValidationError {
                field: "headers",
                message: format!("Line {} has an invalid header name.", idx + 1),
            });
        }
        headers.insert(name_trimmed.to_string(), val.trim().to_string());
    }
    Ok(headers)
}

/// Formats a JSON key-value object back into sorted `KEY=VALUE` or `Name: value` text lines.
pub fn format_kv_object(val: Option<&Value>, sep: &str) -> String {
    let Some(obj) = val.and_then(Value::as_object) else {
        return String::new();
    };
    let mut pairs: Vec<(&str, &str)> = obj
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s)))
        .collect();
    pairs.sort_by_key(|(k, _)| *k);
    pairs
        .into_iter()
        .map(|(k, v)| format!("{k}{sep}{v}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Formats an argument vector cleanly back into an editor string.
pub fn format_args_line(args: &[String]) -> String {
    args.iter()
        .map(|arg| {
            if arg.is_empty()
                || arg
                    .chars()
                    .any(|c| c.is_whitespace() || c == '"' || c == '\'')
            {
                let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
                format!("\"{escaped}\"")
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Validates and builds a protocol-compliant `McpServerConfig` JSON value.
pub fn build_mcp_server_config(
    draft: &McpDraftInput,
) -> Result<(String, Value), McpDraftValidationError> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err(McpDraftValidationError {
            field: "name",
            message: "Server name is required.".to_string(),
        });
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(McpDraftValidationError {
            field: "name",
            message: "Server name may contain only letters, digits, '.', '_', or '-'.".to_string(),
        });
    }

    let kind = match draft.transport.trim().to_ascii_lowercase().as_str() {
        "http" | "streamable-http" | "streamable_http" => "http",
        "sse" => "sse",
        _ => "stdio",
    };

    let transport = if kind == "stdio" {
        let command = draft.command.trim().to_string();
        if command.is_empty() {
            return Err(McpDraftValidationError {
                field: "command",
                message: "Command is required for stdio MCP servers.".to_string(),
            });
        }
        let args = parse_args_line(&draft.args)?;
        let env = parse_env_lines(&draft.env_lines)?;
        let mut obj = Map::new();
        obj.insert("type".to_string(), json!("stdio"));
        obj.insert("command".to_string(), json!(command));
        if !args.is_empty() {
            obj.insert("args".to_string(), json!(args));
        }
        if !env.is_empty() {
            obj.insert("env".to_string(), json!(env));
        }
        Value::Object(obj)
    } else {
        let url_raw = draft.url.trim();
        let Ok(parsed) = url::Url::parse(url_raw) else {
            return Err(McpDraftValidationError {
                field: "url",
                message: "Enter a valid http:// or https:// URL.".to_string(),
            });
        };
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(McpDraftValidationError {
                field: "url",
                message: "Remote MCP URLs must use http:// or https:// with a host.".to_string(),
            });
        }
        let headers = parse_header_lines(&draft.header_lines)?;
        let mut obj = Map::new();
        obj.insert("type".to_string(), json!(kind));
        obj.insert("url".to_string(), json!(url_raw));
        if !headers.is_empty() {
            obj.insert("headers".to_string(), json!(headers));
        }
        Value::Object(obj)
    };

    let config = json!({
        "name": name,
        "transport": transport,
        "enabled": draft.enabled,
    });
    Ok((name, config))
}

/// Hydrates editable draft fields from an existing `McpServerSummary`.
pub fn draft_from_summary(summary: &McpServerSummary) -> McpDraftInput {
    let transport_obj = summary.config.get("transport").unwrap_or(&summary.config);
    let kind = transport_obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(summary.transport.as_str())
        .to_ascii_lowercase();
    let transport = match kind.as_str() {
        "http" | "streamable-http" => "http".to_string(),
        "sse" => "sse".to_string(),
        _ => "stdio".to_string(),
    };

    let command = transport_obj
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let args_vec: Vec<String> = transport_obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let url = transport_obj
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    McpDraftInput {
        name: summary.name.clone(),
        transport,
        enabled: summary.enabled,
        command,
        args: format_args_line(&args_vec),
        url,
        env_lines: format_kv_object(transport_obj.get("env"), "="),
        header_lines: format_kv_object(transport_obj.get("headers"), ": "),
    }
}
