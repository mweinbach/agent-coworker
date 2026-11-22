//! Policy and input validation for native tool approval callbacks from directly spawned
//! agent runtimes (`claude-sdk` `claude/can_use_tool` and `antigravity-acp`
//! `session/request_permission`).
//!
//! Unlike `codex-app-server`, Claude Code and Antigravity ACP run as user-privilege child
//! processes outside Cowork's OS sandbox. Every native tool request MUST therefore pass
//! Cowork's path confinement (`assert_read_path_allowed` / `assert_write_path_allowed`),
//! protected-credential deny, SSRF URL validation, command classification, sandbox hard-floor
//! checks, and task-mutation lock BEFORE YOLO acceptance or interactive prompting, and again
//! after an interactive approval wait to prevent TOCTOU symlink or lock races.

use std::path::{Path, PathBuf};

use cowork_sandbox::{
    CommandRiskLevel, SandboxPolicy, classify_command_detailed, host_platform,
    policy_allows_network,
};
use cowork_tools::{
    ApprovalDecisionRequest, ToolExecutionContext, assert_read_path_allowed,
    assert_write_path_allowed, canonicalize_with_missing_tail, cowork_home_read_roots,
    matches_ts_approval_patterns, normalize_lexical_path, protected_credential_roots,
    resolve_and_validate_url_target,
};
use serde_json::{Map, Value};
use url::Url;

const MAX_SHELL_RECURSION_DEPTH: usize = 4;
const MAX_PROMPT_SUMMARY_CHARS: usize = 240;

pub(crate) fn is_native_runtime_tool_approval(method: &str) -> bool {
    matches!(method, "claude/can_use_tool" | "session/request_permission")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRuntime {
    Claude,
    Acp,
}

impl NativeRuntime {
    fn lock_prefix(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Acp => "acp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeToolKind {
    ReadFile,
    ReadDirOrSearch,
    WriteFile,
    ShellCommand,
    ShellControl,
    WebFetch,
    WebSearch,
    McpCall,
    Subagent,
    Skill,
    AskUser,
    SessionMeta,
}

impl NativeToolKind {
    fn canonical_builtin_name(self, tool_name_lower: &str) -> Option<&'static str> {
        match self {
            Self::ReadFile => Some("read"),
            Self::ReadDirOrSearch => match tool_name_lower {
                "glob" | "find_by_name" | "list_files" => Some("glob"),
                "grep" | "grep_search" | "search_files" => Some("grep"),
                _ => Some("read"),
            },
            Self::WriteFile => match tool_name_lower {
                "write" | "write_file" | "write_to_file" | "create_file" => Some("write"),
                _ => Some("edit"),
            },
            Self::ShellCommand | Self::ShellControl => Some("bash"),
            Self::WebFetch => Some("webFetch"),
            Self::WebSearch => Some("webSearch"),
            Self::McpCall => Some("mcpCall"),
            Self::Subagent => Some("spawnAgent"),
            Self::Skill => Some("skill"),
            Self::AskUser => Some("AskUserQuestion"),
            Self::SessionMeta => match tool_name_lower {
                "todowrite" | "todoread" | "todo_write" => Some("todoWrite"),
                _ => None,
            },
        }
    }
}

struct ParsedNativeRequest<'a> {
    runtime: NativeRuntime,
    tool_name: String,
    kind: NativeToolKind,
    input: &'a Map<String, Value>,
    extra_paths: Vec<String>,
    top_level_command: Option<String>,
}

/// Validates a `claude/can_use_tool` or `session/request_permission` payload against Cowork's
/// security controls and returns the concrete prompt to show in interactive mode.
pub(crate) async fn validate_native_runtime_approval(
    method: &str,
    params: &Value,
    ctx: &ToolExecutionContext,
) -> Result<ApprovalDecisionRequest, String> {
    let empty_obj = Map::new();
    let parsed = parse_native_request(method, params, &empty_obj)?;

    // 1. Task-mutation lock (runs before both YOLO and interactive prompts).
    let lock_name = format!("{}:{}", parsed.runtime.lock_prefix(), parsed.tool_name);
    ctx.check_before_tool_invocation(&lock_name)
        .map_err(|e| e.to_string())?;

    // 2. Built-in tool allowlist defense in depth.
    let tool_lower = parsed.tool_name.to_ascii_lowercase();
    if let Some(allowed) = &ctx.allowed_builtin_tools
        && let Some(canon) = parsed.kind.canonical_builtin_name(&tool_lower)
    {
        let permitted = allowed.iter().any(|entry| {
            entry.eq_ignore_ascii_case(canon) || entry.eq_ignore_ascii_case(&parsed.tool_name)
        });
        if !permitted {
            return Err(format!(
                "Native tool '{}' (canonical '{}') is not permitted by this turn's allowed_builtin_tools.",
                parsed.tool_name, canon
            ));
        }
    }

    let read_only = ctx.read_only_role
        || matches!(
            ctx.sandbox_policy,
            SandboxPolicy::ReadOnly { .. } | SandboxPolicy::NoProjectWrite { .. }
        );
    let scoped = ctx.target_paths.as_ref().is_some_and(|t| !t.is_empty());
    let network_allowed = policy_allows_network(&ctx.sandbox_policy) && ctx.sandbox_config.network;

    match parsed.kind {
        NativeToolKind::ReadFile => validate_read_file(&parsed, ctx),
        NativeToolKind::ReadDirOrSearch => validate_read_dir_or_search(&parsed, ctx),
        NativeToolKind::WriteFile => validate_write_file(&parsed, ctx),
        NativeToolKind::ShellCommand => {
            validate_shell_command(&parsed, ctx, read_only, scoped, network_allowed)
        }
        NativeToolKind::ShellControl => {
            validate_shell_control(&parsed, ctx, read_only, scoped, network_allowed)
        }
        NativeToolKind::WebFetch => validate_web_fetch(&parsed, ctx, network_allowed).await,
        NativeToolKind::WebSearch => validate_web_search(&parsed, ctx, network_allowed),
        NativeToolKind::McpCall => {
            validate_mcp_call(&parsed, ctx, read_only, scoped, network_allowed)
        }
        NativeToolKind::Subagent => {
            validate_subagent(&parsed, ctx, read_only, scoped, network_allowed)
        }
        NativeToolKind::Skill => validate_skill(&parsed, ctx),
        NativeToolKind::AskUser => validate_ask_user(&parsed, ctx),
        NativeToolKind::SessionMeta => Ok(ApprovalDecisionRequest {
            command: parsed.tool_name.clone(),
            reason: "requires_manual_review".to_owned(),
            category: None,
            detail: Some(format!("Allow native tool '{}'", parsed.tool_name)),
            cwd: ctx.working_directory.clone(),
        }),
    }
}

fn parse_native_request<'a>(
    method: &str,
    params: &'a Value,
    empty_obj: &'a Map<String, Value>,
) -> Result<ParsedNativeRequest<'a>, String> {
    match method {
        "claude/can_use_tool" => parse_claude_request(params, empty_obj),
        "session/request_permission" => parse_acp_request(params, empty_obj),
        other => Err(format!(
            "Unsupported native runtime approval method: {other}"
        )),
    }
}

fn parse_claude_request<'a>(
    params: &'a Value,
    empty_obj: &'a Map<String, Value>,
) -> Result<ParsedNativeRequest<'a>, String> {
    let tool_name = params
        .get("tool_name")
        .or_else(|| params.get("toolName"))
        .or_else(|| params.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Claude native tool approval missing tool_name.".to_owned())?
        .to_owned();

    let input = match params.get("input") {
        None | Some(Value::Null) => empty_obj,
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(format!(
                "Claude native tool '{tool_name}' input must be a JSON object."
            ));
        }
    };

    let mut extra_paths = Vec::new();
    for key in ["blocked_path", "blockedPath"] {
        match params.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if !s.is_empty() => extra_paths.push(s.clone()),
            Some(_) => {
                return Err(format!(
                    "Claude native tool '{tool_name}' has invalid {key}."
                ));
            }
        }
    }

    let kind = classify_native_tool_kind(&tool_name, None, input)?;
    Ok(ParsedNativeRequest {
        runtime: NativeRuntime::Claude,
        tool_name,
        kind,
        input,
        extra_paths,
        top_level_command: None,
    })
}

fn extract_acp_location_path(raw: &str, is_uri: bool) -> Result<String, String> {
    if raw.is_empty() {
        return Err("ACP toolCall.locations entry missing path.".to_owned());
    }
    if is_uri && raw.starts_with("file://") {
        if let Ok(parsed) = Url::parse(raw)
            && let Ok(file_path) = parsed.to_file_path()
        {
            return Ok(file_path.to_string_lossy().into_owned());
        }
        return Ok(raw.strip_prefix("file://").unwrap_or(raw).to_owned());
    }
    Ok(raw.to_owned())
}

fn parse_acp_request<'a>(
    params: &'a Value,
    empty_obj: &'a Map<String, Value>,
) -> Result<ParsedNativeRequest<'a>, String> {
    let tool_call = match params.get("toolCall") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return Err("ACP permission request has invalid toolCall.".to_owned()),
    };

    let acp_kind = tool_call
        .and_then(|tc| tc.get("kind"))
        .or_else(|| params.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let tool_name = tool_call
        .and_then(|tc| {
            tc.get("toolName")
                .or_else(|| tc.get("name"))
                .or_else(|| tc.get("title"))
        })
        .or_else(|| {
            params
                .get("toolName")
                .or_else(|| params.get("tool_name"))
                .or_else(|| params.get("name"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(acp_kind)
        .ok_or_else(|| "ACP permission request missing tool name and kind.".to_owned())?
        .to_owned();

    let raw_input_val = tool_call
        .and_then(|tc| {
            tc.get("rawInput")
                .or_else(|| tc.get("input"))
                .or_else(|| tc.get("arguments"))
        })
        .or_else(|| {
            params
                .get("rawInput")
                .or_else(|| params.get("input"))
                .or_else(|| params.get("arguments"))
        });

    let input = match raw_input_val {
        None | Some(Value::Null) => empty_obj,
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(format!(
                "ACP native tool '{tool_name}' input must be a JSON object."
            ));
        }
    };

    let mut extra_paths = Vec::new();
    if let Some(tc) = tool_call
        && let Some(locs) = tc.get("locations")
        && !locs.is_null()
    {
        let arr = locs
            .as_array()
            .ok_or_else(|| "ACP toolCall.locations must be an array.".to_owned())?;
        for loc in arr {
            match loc {
                Value::String(s) if !s.is_empty() => {
                    extra_paths.push(extract_acp_location_path(s, s.starts_with("file://"))?);
                }
                Value::Object(obj) => {
                    if let Some(p) = obj
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        extra_paths.push(extract_acp_location_path(p, false)?);
                    } else if let Some(u) = obj
                        .get("uri")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        extra_paths.push(extract_acp_location_path(u, true)?);
                    } else {
                        return Err("ACP toolCall.locations entry missing path.".to_owned());
                    }
                }
                _ => return Err("ACP toolCall.locations contains invalid entry.".to_owned()),
            }
        }
    }

    let top_level_command = extract_command_value(params.get("command"))
        .or_else(|| tool_call.and_then(|tc| extract_command_value(tc.get("command"))));

    let kind = classify_native_tool_kind(&tool_name, acp_kind, input)?;
    Ok(ParsedNativeRequest {
        runtime: NativeRuntime::Acp,
        tool_name,
        kind,
        input,
        extra_paths,
        top_level_command,
    })
}

fn classify_native_tool_kind(
    tool_name: &str,
    acp_kind: Option<&str>,
    input: &Map<String, Value>,
) -> Result<NativeToolKind, String> {
    let lower = tool_name.trim().to_ascii_lowercase();
    let kind_lower = acp_kind.map(|k| k.trim().to_ascii_lowercase());

    // Never allow a misleading display title (e.g. "read_file") to downgrade a mutating or
    // executing ACP ToolKind.
    if let Some(k) = kind_lower.as_deref() {
        match k {
            "execute" => {
                if matches!(lower.as_str(), "command_status" | "send_command_input") {
                    return Ok(NativeToolKind::ShellControl);
                }
                return Ok(NativeToolKind::ShellCommand);
            }
            "edit" | "delete" | "move" => return Ok(NativeToolKind::WriteFile),
            _ => {}
        }
    }

    if lower.starts_with("mcp__") || lower.starts_with("mcp_") {
        return Ok(NativeToolKind::McpCall);
    }

    match lower.as_str() {
        "bash" | "shell" | "exec" | "execute" | "run_cmd" | "run_command" | "terminal" => {
            Ok(NativeToolKind::ShellCommand)
        }
        "bashoutput" | "killbash" | "killshell" | "taskoutput" | "taskstop" | "command_status"
        | "send_command_input" => Ok(NativeToolKind::ShellControl),
        "read" | "notebookread" | "read_file" | "view_file" | "view_file_outline"
        | "view_code_item" => Ok(NativeToolKind::ReadFile),
        "ls" | "glob" | "grep" | "list_dir" | "find_by_name" | "list_files" | "grep_search"
        | "search_files" => Ok(NativeToolKind::ReadDirOrSearch),
        "write"
        | "edit"
        | "multiedit"
        | "notebookedit"
        | "write_file"
        | "write_to_file"
        | "create_file"
        | "edit_file"
        | "replace_file_content"
        | "multi_replace_file_content"
        | "apply_patch" => Ok(NativeToolKind::WriteFile),
        "webfetch" | "web_fetch" | "read_url_content" | "fetch_url" => Ok(NativeToolKind::WebFetch),
        "websearch" | "web_search" | "search_web" => Ok(NativeToolKind::WebSearch),
        "askuserquestion" | "ask_user" => Ok(NativeToolKind::AskUser),
        "skill" => Ok(NativeToolKind::Skill),
        "task" | "agent" | "spawnagent" | "invoke_subagent" => Ok(NativeToolKind::Subagent),
        "todowrite"
        | "todoread"
        | "todo_write"
        | "enterplanmode"
        | "exitplanmode"
        | "taskcreate"
        | "taskget"
        | "tasklist"
        | "taskupdate"
        | "toolsearch"
        | "listmcpresourcestool"
        | "readmcpresourcetool" => Ok(NativeToolKind::SessionMeta),
        _ => match kind_lower.as_deref() {
            Some("read") => Ok(NativeToolKind::ReadFile),
            Some("search") => Ok(NativeToolKind::ReadDirOrSearch),
            Some("fetch") => {
                if input.contains_key("url")
                    || input.contains_key("Url")
                    || input.contains_key("uri")
                {
                    Ok(NativeToolKind::WebFetch)
                } else {
                    Ok(NativeToolKind::WebSearch)
                }
            }
            _ => Err(format!(
                "Unsupported native tool '{tool_name}' cannot be validated by Cowork policy."
            )),
        },
    }
}

/// Joins `raw` onto `base_dir` and normalizes `.`/`..` lexically WITHOUT trimming leading or
/// trailing whitespace so exact Unix filenames such as `"credential-link "` are preserved.
fn exact_lexical_path(raw: &str, base_dir: &Path) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Native tool path must not be empty.".to_owned());
    }
    if raw.contains('\0') {
        return Err("Native tool path contains a NUL byte.".to_owned());
    }
    let candidate = Path::new(raw);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_dir.join(candidate)
    };
    Ok(normalize_lexical_path(&joined))
}

/// Resolves a path from a native tool against `base_dir`, expanding leading `~` against
/// `homedir` (because native runtimes such as Claude Code expand tilde) and rejecting NUL
/// bytes or `~otheruser` spellings while preserving exact filename bytes.
fn resolve_native_tool_path(raw: &str, base_dir: &Path, homedir: &Path) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Native tool path must not be empty.".to_owned());
    }
    if raw.contains('\0') {
        return Err("Native tool path contains a NUL byte.".to_owned());
    }
    if raw == "~" {
        return Ok(normalize_lexical_path(homedir));
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return Ok(normalize_lexical_path(&homedir.join(rest)));
    }
    if raw.starts_with('~') {
        return Err(format!("Ambiguous tilde user path is blocked: {raw}"));
    }
    exact_lexical_path(raw, base_dir)
}

fn resolve_optional_input_cwd(
    input: &Map<String, Value>,
    ctx: &ToolExecutionContext,
    require_writable: bool,
) -> Result<PathBuf, String> {
    for key in [
        "cwd",
        "workdir",
        "working_directory",
        "workingDirectory",
        "Cwd",
    ] {
        match input.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(raw)) => {
                let resolved = resolve_native_tool_path(raw, &ctx.working_directory, &ctx.homedir)?;
                if require_writable {
                    assert_write_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?;
                } else {
                    assert_read_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?;
                }
                return Ok(resolved);
            }
            Some(_) => return Err(format!("Native tool '{key}' must be a string path.")),
        }
    }
    Ok(ctx.working_directory.clone())
}

fn collect_scalar_and_array_paths(
    input: &Map<String, Value>,
    scalar_keys: &[&str],
    array_keys: &[&str],
    extra_paths: &[String],
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for &key in scalar_keys {
        match input.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if !s.is_empty() => out.push(s.clone()),
            Some(_) => return Err(format!("Invalid native tool path field '{key}'.")),
        }
    }
    for &key in array_keys {
        match input.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    let Some(s) = item.as_str().filter(|s| !s.is_empty()) else {
                        return Err(format!("Invalid native tool path entry in '{key}'."));
                    };
                    out.push(s.to_owned());
                }
            }
            Some(_) => {
                return Err(format!(
                    "Native tool field '{key}' must be an array of paths."
                ));
            }
        }
    }
    out.extend(extra_paths.iter().cloned());
    Ok(out)
}

fn format_display_path(path: &Path) -> String {
    let rendered = path.display().to_string();
    if rendered != rendered.trim() {
        format!("{rendered:?}")
    } else {
        rendered
    }
}

fn validate_read_file(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
) -> Result<ApprovalDecisionRequest, String> {
    let base_dir = resolve_optional_input_cwd(parsed.input, ctx, false)?;
    let raw_paths = collect_scalar_and_array_paths(
        parsed.input,
        &[
            "file_path",
            "filePath",
            "notebook_path",
            "notebookPath",
            "path",
            "TargetFile",
            "AbsolutePath",
            "target",
            "file",
            "filename",
        ],
        &["paths", "files"],
        &parsed.extra_paths,
    )?;
    if raw_paths.is_empty() {
        return Err(format!(
            "Native read tool '{}' requires an explicit file path.",
            parsed.tool_name
        ));
    }

    let mut validated = Vec::with_capacity(raw_paths.len());
    for raw in &raw_paths {
        let candidate = resolve_native_tool_path(raw, &base_dir, &ctx.homedir)?;
        let canonical = assert_read_path_allowed(&candidate, ctx).map_err(|e| e.to_string())?;
        validated.push(format_display_path(&canonical));
    }

    let summary = truncate_summary(&validated.join(", "));
    Ok(ApprovalDecisionRequest {
        command: format!("{} {}", parsed.tool_name, summary),
        reason: "requires_manual_review".to_owned(),
        category: Some("filesystem".to_owned()),
        detail: Some(format!("Read {summary}")),
        cwd: ctx.working_directory.clone(),
    })
}

fn validate_glob_or_search_pattern(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Ok(());
    }
    if raw.contains('\0') {
        return Err("Search pattern contains a NUL byte.".to_owned());
    }
    if raw.starts_with('/')
        || raw.starts_with('\\')
        || raw.starts_with('~')
        || has_windows_drive_prefix(raw)
    {
        return Err(format!(
            "Absolute or home-relative search pattern is blocked: {raw:?}"
        ));
    }
    let normalized = raw.replace('\\', "/");
    for seg in normalized.split('/') {
        if seg == ".." {
            return Err(format!(
                "Parent-traversal search pattern is blocked: {raw:?}"
            ));
        }
        if matches!(
            seg.to_ascii_lowercase().as_str(),
            ".ssh" | ".aws" | ".gnupg" | ".kube" | ".azure"
        ) {
            return Err(format!(
                "Protected credential search pattern is blocked: {raw:?}"
            ));
        }
    }
    let lower = normalized.to_ascii_lowercase();
    if lower.contains(".cowork/auth") || lower.contains(".cowork/mobile-pairing") {
        return Err(format!(
            "Protected Cowork credential search pattern is blocked: {raw:?}"
        ));
    }
    Ok(())
}

/// Rejects native recursive/directory search roots that can traverse into protected credential
/// directories or private Cowork state without Cowork's per-file `create_read_path_checker`.
fn assert_search_root_has_no_protected_descendant(
    canonical_root: &Path,
    ctx: &ToolExecutionContext,
) -> Result<(), String> {
    let is_ancestor_or_eq = |ancestor: &Path, descendant: &Path| -> bool {
        descendant == ancestor || descendant.starts_with(ancestor)
    };

    // Never allow native directory traversal rooted at Cowork home itself or an ancestor of it
    // (only `cowork_home_read_roots` such as `skills` / `plugins` may be searched).
    let cowork_home_canon = canonicalize_with_missing_tail(&ctx.cowork_home);
    let in_allowed_cowork_subroot =
        cowork_home_read_roots(&ctx.cowork_home)
            .into_iter()
            .any(|sub| {
                let sub_canon = canonicalize_with_missing_tail(&sub);
                canonical_root == sub_canon || canonical_root.starts_with(&sub_canon)
            });
    if !in_allowed_cowork_subroot
        && (is_ancestor_or_eq(canonical_root, &cowork_home_canon)
            || is_ancestor_or_eq(&cowork_home_canon, canonical_root))
    {
        return Err(format!(
            "Native search at '{}' is blocked because it can traverse protected Cowork state.",
            canonical_root.display()
        ));
    }

    // Never allow native directory traversal rooted directly at `<workspace>/.cowork` or
    // `<project>/.cowork` (parents of workspace/project MCP credential stores), even if
    // `.cowork/auth` has not been created yet.
    let mut cowork_meta_dirs = vec![ctx.working_directory.join(".cowork")];
    if let Some(project_root) = ctx
        .agent_config
        .as_ref()
        .and_then(|c| c.project_cowork_dir.parent())
    {
        cowork_meta_dirs.push(project_root.join(".cowork"));
    }
    for meta_dir in cowork_meta_dirs {
        let meta_canon = canonicalize_with_missing_tail(&meta_dir);
        if canonical_root == meta_canon {
            return Err(format!(
                "Native search at '{}' is blocked because it can traverse protected '.cowork/auth' credentials.",
                canonical_root.display()
            ));
        }
    }

    // Reject any search root that contains an existing protected credential directory so
    // unsandboxed recursive `Grep`/`Glob`/`LS` cannot traverse into `.cowork/auth`, `.ssh`, etc.
    for cred_root in protected_credential_roots(ctx) {
        let cred_lexical = normalize_lexical_path(&cred_root);
        let cred_canon = canonicalize_with_missing_tail(&cred_root);
        let exists = std::fs::symlink_metadata(&cred_lexical).is_ok()
            || std::fs::symlink_metadata(&cred_canon).is_ok();
        if exists
            && (is_ancestor_or_eq(canonical_root, &cred_canon)
                || is_ancestor_or_eq(canonical_root, &cred_lexical))
        {
            return Err(format!(
                "Native search at '{}' is blocked because it contains protected credential directory '{}'; narrow the search path to a non-credential subdirectory.",
                canonical_root.display(),
                cred_root.display()
            ));
        }
    }

    Ok(())
}

fn validate_read_dir_or_search(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
) -> Result<ApprovalDecisionRequest, String> {
    let base_dir = resolve_optional_input_cwd(parsed.input, ctx, false)?;
    let raw_paths = collect_scalar_and_array_paths(
        parsed.input,
        &[
            "path",
            "directory",
            "dir",
            "dir_path",
            "directory_path",
            "search_path",
            "SearchDirectory",
            "SearchPath",
            "file_path",
            "filePath",
            "target",
        ],
        &["paths", "files"],
        &parsed.extra_paths,
    )?;

    let mut validated = Vec::new();
    if raw_paths.is_empty() {
        let canonical = assert_read_path_allowed(&base_dir, ctx).map_err(|e| e.to_string())?;
        assert_search_root_has_no_protected_descendant(&canonical, ctx)?;
        validated.push(format_display_path(&canonical));
    } else {
        for raw in &raw_paths {
            let candidate = resolve_native_tool_path(raw, &base_dir, &ctx.homedir)?;
            let canonical = assert_read_path_allowed(&candidate, ctx).map_err(|e| e.to_string())?;
            assert_search_root_has_no_protected_descendant(&canonical, ctx)?;
            validated.push(format_display_path(&canonical));
        }
    }

    let mut pattern_preview: Option<String> = None;
    for key in ["pattern", "glob", "Pattern", "include", "file_pattern"] {
        match parsed.input.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(pat)) => {
                // `Grep.pattern` is a regex body (may start with `/`), whereas `Glob.pattern`,
                // `Grep.glob`, `include`, `file_pattern` are path globs.
                let is_grep_regex = matches!(
                    parsed.tool_name.to_ascii_lowercase().as_str(),
                    "grep" | "grep_search"
                ) && key.eq_ignore_ascii_case("pattern");
                if !is_grep_regex {
                    validate_glob_or_search_pattern(pat)?;
                }
                if pattern_preview.is_none() && !pat.trim().is_empty() {
                    pattern_preview = Some(pat.trim().to_owned());
                }
            }
            Some(_) => return Err(format!("Native search tool '{key}' must be a string.")),
        }
    }

    let path_summary = truncate_summary(&validated.join(", "));
    let cmd = match pattern_preview {
        Some(pat) => format!(
            "{} {} in {}",
            parsed.tool_name,
            truncate_summary(&pat),
            path_summary
        ),
        None => format!("{} {}", parsed.tool_name, path_summary),
    };
    Ok(ApprovalDecisionRequest {
        command: cmd,
        reason: "requires_manual_review".to_owned(),
        category: Some("filesystem".to_owned()),
        detail: Some(format!("Search {path_summary}")),
        cwd: ctx.working_directory.clone(),
    })
}

fn extract_patch_file_paths(patch_text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for raw_line in patch_text.lines() {
        // Strip only CRLF `\r` without trimming leading/trailing spaces that may belong to
        // an exact Unix filename (e.g. `*** Update File: config ` or `+++ b/config `).
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        for prefix in [
            "*** Update File:",
            "*** Add File:",
            "*** Delete File:",
            "*** Move to:",
        ] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let p = rest.strip_prefix(' ').unwrap_or(rest);
                if !p.is_empty() {
                    paths.push(p.to_owned());
                }
            }
        }
        for prefix in ["+++ ", "--- "] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let p = rest.split('\t').next().unwrap_or("");
                if !p.is_empty() && p != "/dev/null" {
                    let cleaned = p
                        .strip_prefix("a/")
                        .or_else(|| p.strip_prefix("b/"))
                        .unwrap_or(p);
                    if !cleaned.is_empty() {
                        paths.push(cleaned.to_owned());
                    }
                }
            }
        }
    }
    paths
}

fn validate_write_file(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
) -> Result<ApprovalDecisionRequest, String> {
    let base_dir = resolve_optional_input_cwd(parsed.input, ctx, true)?;
    let mut raw_paths = collect_scalar_and_array_paths(
        parsed.input,
        &[
            "file_path",
            "filePath",
            "notebook_path",
            "notebookPath",
            "path",
            "TargetFile",
            "AbsolutePath",
            "dest",
            "destination",
            "new_path",
            "old_path",
            "source",
            "target",
            "file",
            "filename",
        ],
        &["paths", "files"],
        &parsed.extra_paths,
    )?;

    if let Some(edits) = parsed.input.get("edits")
        && !edits.is_null()
    {
        let arr = edits
            .as_array()
            .ok_or_else(|| "Native edit tool 'edits' must be an array.".to_owned())?;
        for entry in arr {
            if let Some(obj) = entry.as_object() {
                for key in ["file_path", "filePath", "path"] {
                    match obj.get(key) {
                        None | Some(Value::Null) => {}
                        Some(Value::String(s)) if !s.is_empty() => {
                            raw_paths.push(s.clone());
                        }
                        Some(_) => {
                            return Err(format!("Invalid native edit entry path '{key}'."));
                        }
                    }
                }
            }
        }
    }

    if let Some(changes) = parsed.input.get("fileChanges")
        && !changes.is_null()
    {
        let map = changes
            .as_object()
            .ok_or_else(|| "Native edit tool 'fileChanges' must be an object.".to_owned())?;
        for key in map.keys() {
            if key.is_empty() {
                return Err("Native edit tool 'fileChanges' contains empty path.".to_owned());
            }
            raw_paths.push(key.clone());
        }
    }

    for key in ["patch", "diff"] {
        if let Some(Value::String(patch_text)) = parsed.input.get(key) {
            raw_paths.extend(extract_patch_file_paths(patch_text));
        }
    }

    if raw_paths.is_empty() {
        return Err(format!(
            "Native write tool '{}' requires an explicit target file path.",
            parsed.tool_name
        ));
    }

    let mut validated = Vec::with_capacity(raw_paths.len());
    for raw in &raw_paths {
        let candidate = resolve_native_tool_path(raw, &base_dir, &ctx.homedir)?;
        let canonical = assert_write_path_allowed(&candidate, ctx).map_err(|e| e.to_string())?;
        validated.push(format_display_path(&canonical));
    }

    let summary = truncate_summary(&validated.join(", "));
    Ok(ApprovalDecisionRequest {
        command: format!("{} {}", parsed.tool_name, summary),
        reason: "requires_manual_review".to_owned(),
        category: Some("filesystem".to_owned()),
        detail: Some(format!("Modify file {summary}")),
        cwd: ctx.working_directory.clone(),
    })
}

fn extract_command_value(val: Option<&Value>) -> Option<String> {
    let v = val?;
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    } else if let Some(arr) = v.as_array() {
        let parts: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
        if parts.len() != arr.len() || parts.is_empty() {
            return None;
        }
        let joined = parts.join(" ");
        let trimmed = joined.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    } else {
        None
    }
}

fn validate_shell_hard_floors(
    ctx: &ToolExecutionContext,
    read_only: bool,
    scoped: bool,
    network_allowed: bool,
) -> Result<(), String> {
    if read_only || scoped || !network_allowed {
        return Err(
            "Native shell execution cannot preserve this turn's sandbox hard floors.".into(),
        );
    }
    if ctx.sandbox_config.require_backend
        && !matches!(ctx.sandbox_policy, SandboxPolicy::DangerFullAccess { .. })
    {
        return Err(
            "Native shell execution is blocked because an enforcing OS sandbox backend is required."
                .into(),
        );
    }
    if ctx.yolo && !matches!(ctx.sandbox_policy, SandboxPolicy::DangerFullAccess { .. }) {
        return Err(
            "Native shell execution cannot auto-approve outside danger-full-access sandbox policy."
                .into(),
        );
    }
    Ok(())
}

fn validate_shell_command(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
    read_only: bool,
    scoped: bool,
    network_allowed: bool,
) -> Result<ApprovalDecisionRequest, String> {
    validate_shell_hard_floors(ctx, read_only, scoped, network_allowed)?;

    let base_dir = resolve_optional_input_cwd(parsed.input, ctx, true)?;
    for extra in &parsed.extra_paths {
        let candidate = resolve_native_tool_path(extra, &base_dir, &ctx.homedir)?;
        assert_write_path_allowed(&candidate, ctx).map_err(|e| e.to_string())?;
    }

    let command = ["command", "cmd", "CommandLine", "script"]
        .iter()
        .find_map(|key| extract_command_value(parsed.input.get(*key)))
        .or_else(|| parsed.top_level_command.clone())
        .ok_or_else(|| {
            format!(
                "Native shell tool '{}' requires a non-empty command string.",
                parsed.tool_name
            )
        })?;

    validate_native_shell_command_text(&command, &base_dir, ctx, 0)?;

    let pre_exec = classify_command_detailed(&command, None, None);
    let matches_explicit_review = matches_ts_approval_patterns(&command, host_platform());
    let reason = if pre_exec.risk_level == CommandRiskLevel::Dangerous {
        "matches_dangerous_pattern"
    } else if matches_explicit_review {
        "requires_manual_review"
    } else {
        "sandbox_denied"
    };
    let detail = match pre_exec.matched_pattern {
        Some(pat) => format!(
            "Matched dangerous pattern '{pat}'. Native provider shell command executes outside Cowork's OS sandbox."
        ),
        None => "Native provider shell command executes outside Cowork's OS sandbox.".to_owned(),
    };

    Ok(ApprovalDecisionRequest {
        command,
        reason: reason.to_owned(),
        category: None,
        detail: Some(detail),
        cwd: base_dir,
    })
}

fn validate_shell_control(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
    read_only: bool,
    scoped: bool,
    network_allowed: bool,
) -> Result<ApprovalDecisionRequest, String> {
    validate_shell_hard_floors(ctx, read_only, scoped, network_allowed)?;

    // `send_command_input` can feed arbitrary shell commands to a running terminal.
    for key in ["input", "text", "command"] {
        if let Some(raw) = parsed.input.get(key).and_then(Value::as_str)
            && !raw.trim().is_empty()
        {
            validate_native_shell_command_text(raw, &ctx.working_directory, ctx, 0)?;
        }
    }

    let id = ["bash_id", "shell_id", "task_id", "command_id", "CommandId"]
        .iter()
        .find_map(|k| parsed.input.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let cmd = match id {
        Some(id) => format!("{} {}", parsed.tool_name, id),
        None => parsed.tool_name.clone(),
    };
    Ok(ApprovalDecisionRequest {
        command: cmd,
        reason: "requires_manual_review".to_owned(),
        category: None,
        detail: Some(format!(
            "Native shell control '{}' executes outside Cowork's OS sandbox.",
            parsed.tool_name
        )),
        cwd: ctx.working_directory.clone(),
    })
}

async fn validate_web_fetch(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
    network_allowed: bool,
) -> Result<ApprovalDecisionRequest, String> {
    if !network_allowed {
        return Err("Native WebFetch is blocked because network access is disabled.".into());
    }
    let raw_url = ["url", "Url", "uri"]
        .iter()
        .find_map(|k| parsed.input.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "Native tool '{}' requires a non-empty URL.",
                parsed.tool_name
            )
        })?;
    let parsed_url = Url::parse(raw_url)
        .map_err(|e| format!("Invalid URL for native tool '{}': {e}", parsed.tool_name))?;
    resolve_and_validate_url_target(&parsed_url, ctx.dns_override_for_tests.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let summary = truncate_summary(raw_url);
    Ok(ApprovalDecisionRequest {
        command: format!("{} {}", parsed.tool_name, summary),
        reason: "requires_manual_review".to_owned(),
        category: Some("network".to_owned()),
        detail: Some(format!("Fetch URL {summary}")),
        cwd: ctx.working_directory.clone(),
    })
}

fn validate_web_search(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
    network_allowed: bool,
) -> Result<ApprovalDecisionRequest, String> {
    if !network_allowed {
        return Err("Native WebSearch is blocked because network access is disabled.".into());
    }
    let query = ["query", "Query", "q"]
        .iter()
        .find_map(|k| parsed.input.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let cmd = if query.is_empty() {
        parsed.tool_name.clone()
    } else {
        format!("{} {}", parsed.tool_name, truncate_summary(query))
    };
    Ok(ApprovalDecisionRequest {
        command: cmd,
        reason: "requires_manual_review".to_owned(),
        category: Some("network".to_owned()),
        detail: Some("Allow native web search".to_owned()),
        cwd: ctx.working_directory.clone(),
    })
}

fn extract_mcp_server_name(tool_name: &str) -> Option<&str> {
    if let Some(rest) = tool_name.strip_prefix("mcp__") {
        rest.split("__").next().filter(|s| !s.is_empty())
    } else if let Some(rest) = tool_name.strip_prefix("mcp_") {
        rest.split('_').next().filter(|s| !s.is_empty())
    } else {
        None
    }
}

fn validate_mcp_call(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
    read_only: bool,
    scoped: bool,
    network_allowed: bool,
) -> Result<ApprovalDecisionRequest, String> {
    if read_only || scoped || !network_allowed {
        return Err("Native MCP tool call cannot preserve this turn's sandbox hard floors.".into());
    }
    if let Some(allowed_servers) = &ctx.allowed_mcp_servers {
        let server = extract_mcp_server_name(&parsed.tool_name).ok_or_else(|| {
            format!(
                "Native MCP tool '{}' does not identify an MCP server.",
                parsed.tool_name
            )
        })?;
        let permitted = allowed_servers
            .iter()
            .any(|s| s.eq_ignore_ascii_case(server));
        if !permitted {
            return Err(format!(
                "Native MCP server '{server}' is not permitted by allowed_mcp_servers."
            ));
        }
    }
    Ok(ApprovalDecisionRequest {
        command: parsed.tool_name.clone(),
        reason: "requires_manual_review".to_owned(),
        category: Some("network".to_owned()),
        detail: Some(format!("Invoke native MCP tool '{}'", parsed.tool_name)),
        cwd: ctx.working_directory.clone(),
    })
}

fn validate_subagent(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
    read_only: bool,
    scoped: bool,
    network_allowed: bool,
) -> Result<ApprovalDecisionRequest, String> {
    if read_only || scoped || !network_allowed {
        return Err(
            "Native subagent spawn cannot preserve this turn's sandbox hard floors.".into(),
        );
    }
    let desc = ["description", "prompt", "task"]
        .iter()
        .find_map(|k| parsed.input.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let cmd = match desc {
        Some(d) => format!("{}: {}", parsed.tool_name, truncate_summary(d)),
        None => parsed.tool_name.clone(),
    };
    Ok(ApprovalDecisionRequest {
        command: cmd,
        reason: "requires_manual_review".to_owned(),
        category: None,
        detail: Some("Spawn native provider subagent".to_owned()),
        cwd: ctx.working_directory.clone(),
    })
}

fn validate_skill(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
) -> Result<ApprovalDecisionRequest, String> {
    let skill_name = ["skill", "name"]
        .iter()
        .find_map(|k| parsed.input.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(allowed) = &ctx.allowed_skill_names {
        let Some(name) = skill_name else {
            return Err("Native Skill tool call missing skill name.".to_owned());
        };
        if !allowed.iter().any(|s| s.eq_ignore_ascii_case(name)) {
            return Err(format!(
                "Native skill '{name}' is not permitted by allowed_skill_names."
            ));
        }
    }
    let cmd = match skill_name {
        Some(name) => format!("{} {}", parsed.tool_name, name),
        None => parsed.tool_name.clone(),
    };
    Ok(ApprovalDecisionRequest {
        command: cmd,
        reason: "requires_manual_review".to_owned(),
        category: None,
        detail: Some("Load native skill".to_owned()),
        cwd: ctx.working_directory.clone(),
    })
}

fn validate_ask_user(
    parsed: &ParsedNativeRequest<'_>,
    ctx: &ToolExecutionContext,
) -> Result<ApprovalDecisionRequest, String> {
    if !ctx.can_ask_user {
        return Err("AskUserQuestion is not allowed in this turn context.".to_owned());
    }
    Ok(ApprovalDecisionRequest {
        command: parsed.tool_name.clone(),
        reason: "requires_manual_review".to_owned(),
        category: None,
        detail: Some("Ask the user a clarifying question".to_owned()),
        cwd: ctx.working_directory.clone(),
    })
}

// ---------------------------------------------------------------------------
// Native shell command inspection (path confinement & credential-root defense)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum ShellToken {
    Operator(String),
    Word {
        text: String,
        quoted: bool,
        has_unquoted_glob: bool,
        has_unquoted_brace: bool,
        has_unquoted_dollar: bool,
        has_unquoted_backtick: bool,
    },
}

fn tokenize_shell_command(command: &str) -> Result<Vec<ShellToken>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        // POSIX shell line-continuation removal (`\<LF>`) outside single quotes.
        if ch == '\\' && i + 1 < chars.len() && chars[i + 1] == '\n' {
            i += 2;
            continue;
        }
        if ch.is_whitespace() {
            if ch == '\n' {
                tokens.push(ShellToken::Operator("\n".to_owned()));
            }
            i += 1;
            continue;
        }
        // POSIX shell comment: an unquoted `#` at the start of a word ignores through `<LF>`.
        if ch == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // FD-prefixed redirections at word start (`0<`, `1>`, `2>>`, `2>&`, `1>|`, `0<&`, etc.).
        if ch.is_ascii_digit()
            && (i == 0
                || chars[i - 1].is_whitespace()
                || matches!(chars[i - 1], ';' | '|' | '&' | '(' | ')' | '`'))
        {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j < chars.len() && matches!(chars[j], '>' | '<') {
                let mut op: String = chars[i..=j].iter().collect();
                let redir = chars[j];
                i = j + 1;
                if i < chars.len() {
                    let next = chars[i];
                    if (redir == '>' && matches!(next, '>' | '|' | '&'))
                        || (redir == '<' && matches!(next, '>' | '<' | '&'))
                    {
                        op.push(next);
                        i += 1;
                        if op.ends_with("<<") && i < chars.len() && chars[i] == '<' {
                            op.push('<');
                            i += 1;
                        }
                    }
                }
                tokens.push(ShellToken::Operator(op));
                continue;
            }
        }

        // Multi-char operators: `&&`, `||`, `|&`, `>>`, `>|`, `>&`, `<>`, `<<`, `<<<`, `<&`, `<(`, `>(`, `&>`, `&>>`.
        if matches!(ch, '|' | '&' | '>' | '<' | ';' | '(' | ')' | '`') {
            let mut op = String::new();
            op.push(ch);
            i += 1;
            if i < chars.len() {
                let next = chars[i];
                if (ch == '|' && matches!(next, '|' | '&'))
                    || (ch == '&' && matches!(next, '&' | '>'))
                    || (ch == '>' && matches!(next, '>' | '|' | '(' | '&'))
                    || (ch == '<' && matches!(next, '>' | '<' | '(' | '&'))
                {
                    op.push(next);
                    i += 1;
                    if (op == "<<" && i < chars.len() && chars[i] == '<')
                        || (op == "&>" && i < chars.len() && chars[i] == '>')
                    {
                        op.push(chars[i]);
                        i += 1;
                    }
                }
            }
            tokens.push(ShellToken::Operator(op));
            continue;
        }

        let mut word = String::new();
        let mut quoted = false;
        let mut has_unquoted_glob = false;
        let mut has_unquoted_brace = false;
        let mut has_unquoted_dollar = false;
        let mut has_unquoted_backtick = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' {
                quoted = true;
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        i += 1;
                        closed = true;
                        break;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                if !closed {
                    return Err("Unclosed single quote in native shell command.".to_owned());
                }
            } else if c == '"' {
                quoted = true;
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    if chars[i] == '"' {
                        i += 1;
                        closed = true;
                        break;
                    }
                    if chars[i] == '\\' {
                        if i + 1 >= chars.len() {
                            return Err("Unclosed double quote in native shell command.".to_owned());
                        }
                        let next = chars[i + 1];
                        if next == '\n' {
                            // POSIX double-quoted line continuation removes `\<LF>`.
                            i += 2;
                            continue;
                        }
                        if matches!(next, '$' | '`' | '"' | '\\') {
                            word.push(next);
                        } else {
                            // In POSIX shells, `\` inside `"..."` stays literal before other chars.
                            word.push('\\');
                            word.push(next);
                        }
                        i += 2;
                        continue;
                    }
                    if chars[i] == '$' {
                        has_unquoted_dollar = true;
                    } else if chars[i] == '`' {
                        has_unquoted_backtick = true;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                if !closed {
                    return Err("Unclosed double quote in native shell command.".to_owned());
                }
            } else if c == '\\' {
                if i + 1 >= chars.len() {
                    return Err("Trailing unescaped backslash in native shell command.".to_owned());
                }
                let next = chars[i + 1];
                if next == '\n' {
                    // POSIX unquoted line continuation removes `\<LF>` and keeps assembling word.
                    i += 2;
                    continue;
                }
                word.push(next);
                i += 2;
            } else if c.is_whitespace()
                || matches!(c, '|' | '&' | '>' | '<' | ';' | '(' | ')' | '`')
            {
                break;
            } else {
                if matches!(c, '*' | '?' | '[') {
                    has_unquoted_glob = true;
                }
                if matches!(c, '{' | '}') {
                    has_unquoted_brace = true;
                }
                if c == '$' {
                    has_unquoted_dollar = true;
                }
                word.push(c);
                i += 1;
            }
        }
        if !word.is_empty() || quoted {
            tokens.push(ShellToken::Word {
                text: word,
                quoted,
                has_unquoted_glob,
                has_unquoted_brace,
                has_unquoted_dollar,
                has_unquoted_backtick,
            });
        }
    }
    Ok(tokens)
}

fn command_mentions_protected_credential_path(
    command: &str,
    ctx: &ToolExecutionContext,
) -> Option<String> {
    let normalized = command.replace('\\', "/").to_ascii_lowercase();

    for marker in [
        "/.ssh",
        "~/.ssh",
        "$home/.ssh",
        "${home}/.ssh",
        ".ssh/",
        "'.ssh'",
        "\".ssh\"",
        "/.aws",
        "~/.aws",
        "$home/.aws",
        "${home}/.aws",
        ".aws/",
        "'.aws'",
        "\".aws\"",
        "/.gnupg",
        "~/.gnupg",
        "$home/.gnupg",
        "${home}/.gnupg",
        ".gnupg/",
        "'.gnupg'",
        "\".gnupg\"",
        "/.kube",
        "~/.kube",
        "$home/.kube",
        "${home}/.kube",
        ".kube/",
        "'.kube'",
        "\".kube\"",
        "/.azure",
        "~/.azure",
        "$home/.azure",
        "${home}/.azure",
        ".azure/",
        "'.azure'",
        "\".azure\"",
        ".cowork/auth",
        ".cowork/mobile-pairing",
        ".cowork/config",
        ".cowork/sessions",
        ".cowork/backups",
        ".cowork/logs",
        "/etc/shadow",
    ] {
        if normalized.contains(marker) {
            return Some(format!(
                "Native shell command references protected credential/state path '{marker}'."
            ));
        }
    }

    for root in protected_credential_roots(ctx) {
        for form in [
            normalize_lexical_path(&root),
            canonicalize_with_missing_tail(&root),
        ] {
            let needle = form
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            if needle.len() > 2 && normalized.contains(&needle) {
                return Some(format!(
                    "Native shell command references protected credential root '{}'.",
                    form.display()
                ));
            }
        }
    }

    // Check non-skill subdirectories of Cowork home by full path.
    let allowed_cowork_subroots: Vec<String> = cowork_home_read_roots(&ctx.cowork_home)
        .into_iter()
        .flat_map(|r| {
            [
                normalize_lexical_path(&r),
                canonicalize_with_missing_tail(&r),
            ]
        })
        .map(|p| p.to_string_lossy().replace('\\', "/").to_ascii_lowercase())
        .collect();
    for ch in [
        normalize_lexical_path(&ctx.cowork_home),
        canonicalize_with_missing_tail(&ctx.cowork_home),
    ] {
        let needle = ch.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
        if needle.len() > 2
            && let Some(idx) = normalized.find(&needle)
        {
            let tail = &normalized[idx..];
            let allowed = allowed_cowork_subroots
                .iter()
                .any(|sub| tail.starts_with(sub));
            if !allowed {
                return Some(format!(
                    "Native shell command references protected Cowork home '{}'.",
                    ch.display()
                ));
            }
        }
    }

    None
}

fn expand_shell_known_prefix(raw: &str, base_dir: &Path, homedir: &Path) -> Option<PathBuf> {
    if raw == "~"
        || raw == "$HOME"
        || raw == "${HOME}"
        || raw.eq_ignore_ascii_case("%USERPROFILE%")
        || raw.eq_ignore_ascii_case("$ENV:USERPROFILE")
    {
        return Some(normalize_lexical_path(homedir));
    }
    if raw == "$PWD" || raw == "${PWD}" {
        return Some(normalize_lexical_path(base_dir));
    }
    for prefix in ["~/", "~\\", "$HOME/", "$HOME\\", "${HOME}/", "${HOME}\\"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return Some(normalize_lexical_path(&homedir.join(rest)));
        }
    }
    for prefix in ["$PWD/", "$PWD\\", "${PWD}/", "${PWD}\\"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return Some(normalize_lexical_path(&base_dir.join(rest)));
        }
    }
    let lower = raw.to_ascii_lowercase();
    for prefix in [
        "%userprofile%\\",
        "%userprofile%/",
        "$env:userprofile\\",
        "$env:userprofile/",
    ] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let tail = &raw[raw.len() - rest.len()..];
            return Some(normalize_lexical_path(&homedir.join(tail)));
        }
    }
    None
}

fn is_url_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ws://")
        || lower.starts_with("wss://")
        || lower.starts_with("ftp://")
        || lower.starts_with("ssh://")
        || lower.starts_with("git://")
}

fn is_safe_stdio_device(path: &str) -> bool {
    matches!(
        path,
        "/dev/null" | "/dev/stdin" | "/dev/stdout" | "/dev/stderr" | "/dev/tty"
    ) || path.starts_with("/dev/fd/")
}

fn is_safe_system_executable_path(path: &str) -> bool {
    [
        "/bin/",
        "/usr/bin/",
        "/usr/local/bin/",
        "/opt/homebrew/bin/",
        "/opt/homebrew/sbin/",
        "/sbin/",
        "/usr/sbin/",
    ]
    .iter()
    .any(|prefix| {
        path.strip_prefix(prefix).is_some_and(|rest| {
            !rest.is_empty()
                && !rest.contains('/')
                && !rest.contains('\\')
                && rest != "."
                && rest != ".."
        })
    })
}

fn has_windows_drive_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn looks_like_filesystem_path(token: &str) -> bool {
    if token.is_empty() || is_url_token(token) {
        return false;
    }
    if token.starts_with('~')
        || token.starts_with("$HOME")
        || token.starts_with("${HOME}")
        || token.to_ascii_lowercase().starts_with("%userprofile%")
        || token.to_ascii_lowercase().starts_with("$env:userprofile")
        || token == ".."
        || token.starts_with("../")
        || token.starts_with("..\\")
        || token.contains("/../")
        || token.contains("\\..\\")
        || token.ends_with("/..")
        || token.ends_with("\\..")
        || token.starts_with('/')
        || token.starts_with("\\\\")
        || has_windows_drive_prefix(token)
    {
        return true;
    }
    let normalized = token.replace('\\', "/").to_ascii_lowercase();
    normalized == ".git"
        || normalized.starts_with(".git/")
        || normalized.contains("/.git/")
        || normalized.ends_with("/.git")
        || normalized == ".cowork"
        || normalized.starts_with(".cowork/")
        || normalized.contains("/.cowork/")
        || normalized.ends_with("/.cowork")
}

fn is_mutating_shell_command(cmd_basename: &str) -> bool {
    matches!(
        cmd_basename,
        "rm" | "rmdir"
            | "mv"
            | "cp"
            | "chmod"
            | "chown"
            | "touch"
            | "mkdir"
            | "ln"
            | "dd"
            | "truncate"
            | "tee"
            | "uniq"
            | "install"
            | "sed"
            | "perl"
            | "shred"
    )
}

fn is_directory_reading_shell_command(cmd_basename: &str) -> bool {
    matches!(
        cmd_basename,
        "grep"
            | "egrep"
            | "fgrep"
            | "rg"
            | "ag"
            | "ack"
            | "find"
            | "fd"
            | "ls"
            | "dir"
            | "tree"
            | "tar"
            | "zip"
            | "cp"
            | "rsync"
            | "du"
            | "cat"
            | "head"
            | "tail"
            | "diff"
            | "less"
            | "more"
            | "awk"
            | "sed"
            | "xargs"
            | "strings"
            | "file"
    )
}

fn validate_shell_path_token(
    raw: &str,
    base_dir: &Path,
    ctx: &ToolExecutionContext,
    require_write: bool,
    at_command_pos: bool,
) -> Result<Option<PathBuf>, String> {
    if raw.is_empty() || is_url_token(raw) {
        return Ok(None);
    }
    if is_safe_stdio_device(raw) {
        return Ok(None);
    }
    if at_command_pos && !require_write && is_safe_system_executable_path(raw) {
        return Ok(None);
    }
    let resolved = if let Some(expanded) = expand_shell_known_prefix(raw, base_dir, &ctx.homedir) {
        expanded
    } else if raw.starts_with('~') {
        return Err(format!(
            "Native shell command uses blocked tilde user path '{raw}'."
        ));
    } else if raw.starts_with('$')
        && (require_write
            || raw.contains("/../")
            || raw.contains("\\..\\")
            || raw.ends_with("/..")
            || raw.ends_with("\\.."))
    {
        return Err(format!(
            "Native shell command uses ambiguous variable path '{raw}'."
        ));
    } else {
        exact_lexical_path(raw, base_dir)?
    };

    let canonical = if require_write {
        assert_write_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?
    } else {
        assert_read_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?
    };
    Ok(Some(canonical))
}

fn glob_name_matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = name.chars().collect();
    let (mut pi, mut si) = (0usize, 0usize);
    let (mut star_p, mut star_s) = (None, 0usize);
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '[' {
            // Treat character classes `[...]` conservatively as matching any single char so
            // glob checks never under-block symlink matches.
            if let Some(close) = p[pi + 1..].iter().position(|&c| c == ']') {
                pi += close + 2;
                si += 1;
            } else {
                pi += 1;
                si += 1;
            }
        } else if pi < p.len() && p[pi] == '*' {
            star_p = Some(pi);
            pi += 1;
            star_s = si;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_s += 1;
            si = star_s;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

const MAX_GLOB_EXPANSIONS: usize = 4096;
const MAX_BRACE_EXPANSIONS: usize = 64;

fn segment_has_glob_meta(seg: &str) -> bool {
    seg.contains('*') || seg.contains('?') || seg.contains('[')
}

fn expand_shell_braces_inner(raw: &str, out: &mut Vec<String>) -> Result<(), String> {
    if out.len() >= MAX_BRACE_EXPANSIONS {
        return Err("Native shell brace expansion exceeded safety limit.".to_owned());
    }
    let bytes = raw.as_bytes();
    let mut open_idx = None;
    let mut close_idx = None;
    let mut depth = 0usize;
    let mut comma_positions = Vec::new();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'{' => {
                if depth == 0 {
                    open_idx = Some(i);
                    comma_positions.clear();
                }
                depth += 1;
            }
            b',' if depth == 1 => {
                comma_positions.push(i);
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = open_idx {
                        let inner = &raw[start + 1..i];
                        if !comma_positions.is_empty() || inner.contains("..") {
                            close_idx = Some(i);
                            break;
                        }
                    }
                    open_idx = None;
                    comma_positions.clear();
                }
            }
            _ => {}
        }
    }

    let (Some(start), Some(end)) = (open_idx, close_idx) else {
        out.push(raw.to_owned());
        return Ok(());
    };

    let prefix = &raw[..start];
    let suffix = &raw[end + 1..];
    if comma_positions.is_empty() {
        // Range brace expansion like `{a..z}` or `{1..10}` — conservatively treat the
        // brace expression as a wildcard `*` so every on-disk entry in that position is checked.
        let wildcarded = format!("{prefix}*{suffix}");
        return expand_shell_braces_inner(&wildcarded, out);
    }

    let mut parts = Vec::with_capacity(comma_positions.len() + 1);
    let mut seg_start = start + 1;
    for pos in comma_positions {
        parts.push(&raw[seg_start..pos]);
        seg_start = pos + 1;
    }
    parts.push(&raw[seg_start..end]);

    for part in parts {
        let candidate = format!("{prefix}{part}{suffix}");
        expand_shell_braces_inner(&candidate, out)?;
        if out.len() > MAX_BRACE_EXPANSIONS {
            return Err("Native shell brace expansion exceeded safety limit.".to_owned());
        }
    }
    Ok(())
}

fn authorize_glob_target(
    path: &Path,
    ctx: &ToolExecutionContext,
    current_cmd: &str,
    require_write: bool,
) -> Result<PathBuf, String> {
    let canonical = if require_write {
        assert_write_path_allowed(path, ctx).map_err(|e| e.to_string())?
    } else {
        assert_read_path_allowed(path, ctx).map_err(|e| e.to_string())?
    };
    if is_directory_reading_shell_command(current_cmd)
        && std::fs::metadata(&canonical).is_ok_and(|m| m.is_dir())
    {
        assert_search_root_has_no_protected_descendant(&canonical, ctx)?;
    }
    Ok(canonical)
}

fn collect_globstar_dirs(
    root: &Path,
    ctx: &ToolExecutionContext,
    current_cmd: &str,
    require_write: bool,
    is_last: bool,
    visited: &mut usize,
    out_dirs: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut seen_dirs = std::collections::HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let canonical = authorize_glob_target(&dir, ctx, current_cmd, false)?;
        if !seen_dirs.insert(canonical.clone()) {
            continue;
        }
        out_dirs.push(canonical.clone());
        let entries = std::fs::read_dir(&canonical).map_err(|err| {
            format!(
                "Native shell recursive glob could not inspect directory '{}': {err}",
                canonical.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|err| {
                format!(
                    "Native shell recursive glob failed reading '{}': {err}",
                    canonical.display()
                )
            })?;
            *visited += 1;
            if *visited > MAX_GLOB_EXPANSIONS {
                return Err(
                    "Native shell glob expansion exceeded safety limit; narrow the pattern."
                        .to_owned(),
                );
            }
            let entry_path = entry.path();
            let canonical_entry = if is_last {
                authorize_glob_target(&entry_path, ctx, current_cmd, require_write)?
            } else {
                // Authorize every directory/symlink encountered before descending.
                assert_read_path_allowed(&entry_path, ctx).map_err(|e| e.to_string())?
            };
            if std::fs::metadata(&canonical_entry).is_ok_and(|m| m.is_dir()) {
                stack.push(canonical_entry);
            }
        }
    }
    Ok(())
}

fn validate_shell_glob_operand(
    raw: &str,
    base_dir: &Path,
    ctx: &ToolExecutionContext,
    current_cmd: &str,
    require_write: bool,
) -> Result<(), String> {
    let normalized = raw.replace('\\', "/");
    let (prefix_dir, rest_segments): (PathBuf, Vec<&str>) =
        if let Some(rest) = normalized.strip_prefix("~/") {
            (
                normalize_lexical_path(&ctx.homedir),
                rest.split('/').collect(),
            )
        } else if normalized.starts_with('~') {
            return Err(format!(
                "Native shell glob uses blocked tilde user path '{raw}'."
            ));
        } else if let Some(rest) = normalized
            .strip_prefix("$HOME/")
            .or_else(|| normalized.strip_prefix("${HOME}/"))
        {
            (
                normalize_lexical_path(&ctx.homedir),
                rest.split('/').collect(),
            )
        } else if let Some(rest) = normalized
            .strip_prefix("$PWD/")
            .or_else(|| normalized.strip_prefix("${PWD}/"))
        {
            (normalize_lexical_path(base_dir), rest.split('/').collect())
        } else if let Some(rest) = normalized.strip_prefix('/') {
            (PathBuf::from("/"), rest.split('/').collect())
        } else if has_windows_drive_prefix(&normalized) {
            let drive = format!("{}/", &normalized[..2]);
            let rest = normalized[2..].trim_start_matches('/');
            (PathBuf::from(drive), rest.split('/').collect())
        } else {
            (base_dir.to_path_buf(), normalized.split('/').collect())
        };

    let segments: Vec<&str> = rest_segments
        .into_iter()
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .collect();
    if segments.is_empty() {
        authorize_glob_target(&prefix_dir, ctx, current_cmd, require_write)?;
        return Ok(());
    }

    // Fold all leading literal path components onto `prefix_dir` before checking directory
    // authorization so absolute workspace globs like `/ws/src/*.rs` authorize `/ws/src`
    // directly while out-of-workspace globs like `/etc/pass*` fail closed on `/etc`.
    let first_glob_idx = segments
        .iter()
        .position(|seg| segment_has_glob_meta(seg))
        .unwrap_or(segments.len());
    let mut start_dir = prefix_dir;
    for literal in &segments[..first_glob_idx] {
        start_dir = normalize_lexical_path(&start_dir.join(literal));
    }
    let remaining = &segments[first_glob_idx..];
    if remaining.is_empty() {
        authorize_glob_target(&start_dir, ctx, current_cmd, require_write)?;
        return Ok(());
    }

    let Ok(canonical_start) = assert_read_path_allowed(&start_dir, ctx) else {
        return Err(format!(
            "Native shell glob '{raw}' targets disallowed directory '{}'.",
            start_dir.display()
        ));
    };

    let mut current_dirs = vec![canonical_start];
    let mut visited = 0usize;

    for (idx, &seg) in remaining.iter().enumerate() {
        let is_last = idx + 1 == remaining.len();
        let mut next_dirs = Vec::new();

        if seg == "**" {
            for dir in &current_dirs {
                collect_globstar_dirs(
                    dir,
                    ctx,
                    current_cmd,
                    require_write,
                    is_last,
                    &mut visited,
                    &mut next_dirs,
                )?;
            }
            current_dirs = next_dirs;
            continue;
        }

        if segment_has_glob_meta(seg) {
            for dir in &current_dirs {
                let canonical_dir =
                    assert_read_path_allowed(dir, ctx).map_err(|e| e.to_string())?;
                let Ok(entries) = std::fs::read_dir(&canonical_dir) else {
                    if std::fs::symlink_metadata(&canonical_dir).is_ok() {
                        return Err(format!(
                            "Native shell glob '{raw}' could not enumerate directory '{}'.",
                            canonical_dir.display()
                        ));
                    }
                    continue;
                };
                for entry in entries {
                    let entry = entry.map_err(|err| {
                        format!(
                            "Native shell glob '{raw}' failed reading '{}': {err}",
                            canonical_dir.display()
                        )
                    })?;
                    let file_name = entry.file_name();
                    let name_str = file_name.to_string_lossy();
                    if !glob_name_matches(seg, &name_str) {
                        continue;
                    }
                    visited += 1;
                    if visited > MAX_GLOB_EXPANSIONS {
                        return Err(format!(
                            "Native shell glob '{raw}' exceeded expansion safety limit; narrow the pattern."
                        ));
                    }
                    let entry_path = entry.path();
                    if is_last {
                        authorize_glob_target(&entry_path, ctx, current_cmd, require_write)?;
                    } else {
                        let canonical_entry = assert_read_path_allowed(&entry_path, ctx)
                            .map_err(|e| e.to_string())?;
                        if std::fs::metadata(&canonical_entry).is_ok_and(|m| m.is_dir()) {
                            next_dirs.push(canonical_entry);
                        }
                    }
                }
            }
            current_dirs = next_dirs;
            continue;
        }

        // Literal path component following an earlier wildcard segment (e.g. `d*/credential-link`).
        for dir in &current_dirs {
            let child = if seg == ".." {
                normalize_lexical_path(&dir.join(".."))
            } else {
                dir.join(seg)
            };
            visited += 1;
            if visited > MAX_GLOB_EXPANSIONS {
                return Err(format!(
                    "Native shell glob '{raw}' exceeded expansion safety limit; narrow the pattern."
                ));
            }
            if seg == ".." {
                let canonical_parent = if is_last {
                    authorize_glob_target(&child, ctx, current_cmd, require_write)?
                } else {
                    assert_read_path_allowed(&child, ctx).map_err(|e| e.to_string())?
                };
                if !is_last {
                    next_dirs.push(canonical_parent);
                }
                continue;
            }
            let exists = std::fs::symlink_metadata(&child).is_ok();
            if is_last {
                if exists || require_write || looks_like_filesystem_path(seg) {
                    authorize_glob_target(&child, ctx, current_cmd, require_write)?;
                }
            } else if exists {
                let canonical_child =
                    assert_read_path_allowed(&child, ctx).map_err(|e| e.to_string())?;
                if std::fs::metadata(&canonical_child).is_ok_and(|m| m.is_dir()) {
                    next_dirs.push(canonical_child);
                }
            }
        }
        current_dirs = next_dirs;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_shell_operand_candidate(
    candidate: &str,
    has_unquoted_glob: bool,
    has_unquoted_brace: bool,
    base_dir: &Path,
    ctx: &ToolExecutionContext,
    current_cmd: &str,
    is_mut: bool,
    force_write: bool,
) -> Result<(), String> {
    if candidate.is_empty() || is_url_token(candidate) {
        return Ok(());
    }

    if has_unquoted_brace && candidate.contains('{') && candidate.contains('}') {
        let mut expanded = Vec::new();
        expand_shell_braces_inner(candidate, &mut expanded)?;
        if expanded.len() > 1 || expanded.first().map(String::as_str) != Some(candidate) {
            for variant in expanded {
                let variant_has_glob = has_unquoted_glob || segment_has_glob_meta(&variant);
                validate_shell_operand_candidate(
                    &variant,
                    variant_has_glob,
                    false,
                    base_dir,
                    ctx,
                    current_cmd,
                    is_mut,
                    force_write,
                )?;
            }
            return Ok(());
        }
    }

    if has_unquoted_glob && segment_has_glob_meta(candidate) {
        validate_shell_glob_operand(candidate, base_dir, ctx, current_cmd, force_write || is_mut)?;
    }

    let explicit_path = looks_like_filesystem_path(candidate);
    let lexical_candidate = if explicit_path {
        None
    } else {
        exact_lexical_path(candidate, base_dir).ok()
    };
    let exists_on_disk = lexical_candidate
        .as_ref()
        .is_some_and(|p| std::fs::symlink_metadata(p).is_ok());

    if !explicit_path && !exists_on_disk && !(is_mut && !candidate.starts_with('-')) {
        return Ok(());
    }

    let normalized = candidate.replace('\\', "/").to_ascii_lowercase();
    let touches_protected_meta = normalized == ".git"
        || normalized.starts_with(".git/")
        || normalized.contains("/.git/")
        || normalized.ends_with("/.git")
        || normalized == ".cowork"
        || normalized.starts_with(".cowork/")
        || normalized.contains("/.cowork/")
        || normalized.ends_with("/.cowork");
    let require_write = force_write
        || (is_mut && (exists_on_disk || touches_protected_meta || !candidate.starts_with('-')));

    if let Some(canonical) =
        validate_shell_path_token(candidate, base_dir, ctx, require_write, false)?
        && is_directory_reading_shell_command(current_cmd)
        && std::fs::metadata(&canonical).is_ok_and(|m| m.is_dir())
    {
        assert_search_root_has_no_protected_descendant(&canonical, ctx)?;
    }
    Ok(())
}

fn contains_identifier_token(haystack_upper: &str, needle_upper: &str) -> bool {
    let bytes = haystack_upper.as_bytes();
    let mut start = 0usize;
    while let Some(offset) = haystack_upper[start..].find(needle_upper) {
        let idx = start + offset;
        let end = idx + needle_upper.len();
        let before_ok =
            idx == 0 || !(bytes[idx - 1].is_ascii_alphanumeric() || bytes[idx - 1] == b'_');
        let after_ok =
            end == bytes.len() || !(bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_');
        if before_ok && after_ok {
            return true;
        }
        start = idx + 1;
    }
    false
}

/// Defense-in-depth check blocking native shell commands that reference sensitive provider
/// credentials, loopback credential-broker endpoints, runtime auth directories, or process
/// `/proc/.../environ` tables — even when YOLO/DangerFullAccess is active.
fn command_references_sensitive_provider_env(command: &str) -> Option<String> {
    let normalized = command.replace('\\', "/").to_ascii_lowercase();
    if normalized.contains("/proc/") && normalized.contains("/environ") {
        return Some(
            "Native shell command references process environment table under '/proc/*/environ'."
                .to_owned(),
        );
    }

    let upper = command.to_ascii_uppercase();
    for var_name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GEMINI_BASE_URL",
        "ANTIGRAVITY_HOME",
        "ANTIGRAVITY_CONFIG_DIR",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENROUTER_API_KEY",
        "TOGETHER_API_KEY",
        "FIREWORKS_API_KEY",
        "BASETEN_API_KEY",
        "NVIDIA_API_KEY",
        "MINIMAX_API_KEY",
        "OPENCODE_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "LANGFUSE_SECRET_KEY",
    ] {
        if contains_identifier_token(&upper, var_name) {
            return Some(format!(
                "Native shell command references protected provider environment variable '{var_name}'."
            ));
        }
    }
    None
}

fn normalize_command_stem(cmd_basename: &str) -> &str {
    let stripped = cmd_basename
        .strip_suffix(".exe")
        .or_else(|| cmd_basename.strip_suffix(".cmd"))
        .or_else(|| cmd_basename.strip_suffix(".bat"))
        .or_else(|| cmd_basename.strip_suffix(".com"))
        .or_else(|| cmd_basename.strip_suffix(".ps1"))
        .or_else(|| cmd_basename.strip_suffix(".sh"))
        .unwrap_or(cmd_basename);
    stripped.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.')
}

fn is_nested_posix_shell(cmd_basename: &str) -> bool {
    matches!(
        normalize_command_stem(cmd_basename),
        "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh"
    )
}

/// Strict command allowlist for unsandboxed native shell execution (Claude SDK `Bash` and
/// Antigravity ACP `run_cmd` / `execute`), where Cowork's OS sandbox does not wrap the subprocess.
///
/// Only audited POSIX core utilities whose file/directory operands can be statically verified
/// against Cowork's read/write boundaries — plus `cd`, recursively validated POSIX `sh -c`, and
/// allowlisted local `git` subcommands — are permitted. Network tools (`curl`, `wget`, `ssh`),
/// interpreters, archive extractors, patchers, build runners, config-file loaders, and arbitrary
/// `$PATH` binaries are denied by default (they remain available in Cowork's OS-sandboxed `bash`
/// tool).
fn is_unsandboxed_allowed_command(cmd_basename: &str) -> bool {
    if is_nested_posix_shell(cmd_basename) {
        return true;
    }
    let exact = cmd_basename
        .strip_suffix(".exe")
        .or_else(|| cmd_basename.strip_suffix(".cmd"))
        .or_else(|| cmd_basename.strip_suffix(".bat"))
        .or_else(|| cmd_basename.strip_suffix(".com"))
        .unwrap_or(cmd_basename);

    matches!(
        exact,
        // Navigation
        "cd"
            // Pure stdout / simple text filters
            | "echo"
            | "printf"
            | "true"
            | "false"
            | "pwd"
            | "basename"
            | "dirname"
            | "seq"
            | "uname"
            | "date"
            | "whoami"
            | "id"
            | "wc"
            | "uniq"
            | "cut"
            | "tr"
            | "paste"
            | "rev"
            | "nl"
            | "fold"
            | "fmt"
            | "column"
            | "expand"
            | "unexpand"
            | "comm"
            | "join"
            | "test"
            | "["
            | "sleep"
            | "sort"
            | "tee"
            // Explicit-operand file readers & comparison/checksum tools
            | "cat"
            | "head"
            | "tail"
            | "stat"
            | "readlink"
            | "realpath"
            | "diff"
            | "cmp"
            | "md5"
            | "md5sum"
            | "shasum"
            | "sha1sum"
            | "sha256sum"
            | "sha512sum"
            | "cksum"
            // Bounded search & directory listing (implicit cwd roots + dir args checked)
            | "ls"
            | "dir"
            | "tree"
            | "du"
            | "find"
            | "fd"
            | "grep"
            | "egrep"
            | "fgrep"
            | "rg"
            // Explicit-operand workspace mutations (all operands write-validated; symlinks/hardlinks blocked)
            | "mkdir"
            | "touch"
            | "cp"
            | "mv"
            | "rm"
            | "rmdir"
            | "chmod"
            | "truncate"
            // Allowlisted local VCS operations (subcommands + flags validated separately)
            | "git"
    )
}

const MAX_SHELL_POSSIBLE_DIRS: usize = 16;

fn is_safe_git_global_flag(arg: &str) -> bool {
    matches!(
        arg,
        "--no-pager"
            | "-P"
            | "--no-optional-locks"
            | "--literal-pathspecs"
            | "--glob-pathspecs"
            | "--noglob-pathspecs"
            | "--icase-pathspecs"
            | "--version"
            | "-v"
            | "-h"
    )
}

fn is_allowed_unsandboxed_git_subcommand(sub: &str) -> bool {
    matches!(
        sub,
        // Read-only inspection (no `help` which can invoke `man`/browser)
        "status"
            | "diff"
            | "log"
            | "show"
            | "rev-parse"
            | "rev-list"
            | "ls-files"
            | "ls-tree"
            | "blame"
            | "shortlog"
            | "describe"
            | "merge-base"
            | "grep"
            | "reflog"
            | "cat-file"
            | "symbolic-ref"
            | "check-ignore"
            | "name-rev"
            | "for-each-ref"
            | "count-objects"
            | "show-ref"
            | "version"
            // Local workspace VCS operations (strict per-subcommand flag allowlist below;
            // no remote helpers, pagers, editors, GPG helpers, or implicit patch writers;
            // dangerous forms like `git reset --hard` still require interactive approval)
            | "add"
            | "commit"
            | "reset"
            | "restore"
            | "switch"
            | "checkout"
            | "branch"
            | "tag"
            | "stash"
            | "rm"
            | "mv"
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GitFlagDisposition {
    Rejected,
    AllowedNoValue,
    AllowedTakesValue,
}

fn is_numeric_short_flag(arg: &str) -> bool {
    arg.strip_prefix('-')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

fn is_prefixed_digits(arg: &str, prefix: &str) -> bool {
    arg.strip_prefix(prefix)
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

fn is_safe_git_color_flag(lower_arg: &str) -> bool {
    matches!(
        lower_arg,
        "--color" | "--no-color" | "--color=never" | "--color=always" | "--color=auto"
    )
}

/// Strict per-subcommand flag allowlist for unsandboxed `git`.
/// Denies all executable pager, editor, GPG, external diff, textconv, filter, and indirect-file
/// options by default (e.g. `git grep --open-files-in-pager`, `git grep -O`, `git diff --ext-diff`,
/// `git diff --no-index`, `git add -p`/`-e`/`--pathspec-from-file`, `git commit -S`/`-e`,
/// `git branch --edit-description`, `git log --show-signature`).
fn classify_safe_git_subcommand_flag(sub: &str, arg: &str, lower_arg: &str) -> GitFlagDisposition {
    if is_safe_git_color_flag(lower_arg) {
        return GitFlagDisposition::AllowedNoValue;
    }
    match sub {
        "status" => {
            if matches!(
                arg,
                "-s" | "--short"
                    | "-b"
                    | "--branch"
                    | "--porcelain"
                    | "--long"
                    | "-v"
                    | "--verbose"
                    | "-u"
                    | "--untracked-files"
                    | "--ignored"
                    | "-z"
                    | "--no-ahead-behind"
                    | "--ahead-behind"
                    | "--no-renames"
                    | "--show-stash"
            ) || lower_arg.starts_with("--porcelain=")
                || lower_arg.starts_with("--untracked-files=")
                || lower_arg.starts_with("--ignored=")
            {
                GitFlagDisposition::AllowedNoValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "diff" | "show" => {
            if matches!(
                arg,
                "--cached"
                    | "--staged"
                    | "--stat"
                    | "--shortstat"
                    | "--numstat"
                    | "--dirstat"
                    | "--summary"
                    | "--patch"
                    | "-p"
                    | "--no-patch"
                    | "-s"
                    | "--name-only"
                    | "--name-status"
                    | "--check"
                    | "--raw"
                    | "--compact-summary"
                    | "--word-diff"
                    | "--no-ext-diff"
                    | "--no-textconv"
                    | "--no-renames"
                    | "--no-prefix"
                    | "--full-index"
                    | "--binary"
                    | "--minimal"
                    | "--patience"
                    | "--histogram"
                    | "-w"
                    | "--ignore-all-space"
                    | "-b"
                    | "--ignore-space-change"
                    | "--ignore-space-at-eol"
                    | "--ignore-blank-lines"
                    | "-M"
                    | "-C"
                    | "-R"
                    | "-z"
                    | "--quiet"
                    | "-q"
                    | "--exit-code"
                    | "--oneline"
                    | "--abbrev-commit"
                    | "--no-notes"
            ) || is_prefixed_digits(arg, "-U")
                || lower_arg.starts_with("--unified=")
                || lower_arg.starts_with("--diff-filter=")
                || lower_arg.starts_with("--word-diff=")
                || lower_arg.starts_with("--format=")
                || lower_arg.starts_with("--pretty=")
                || lower_arg.starts_with("--abbrev=")
                || lower_arg.starts_with("--stat=")
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(
                arg,
                "-U" | "--diff-filter" | "--format" | "--pretty" | "-S" | "-G"
            ) {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "log" | "reflog" | "shortlog" => {
            if matches!(
                arg,
                "--oneline"
                    | "--graph"
                    | "--decorate"
                    | "--no-decorate"
                    | "--all"
                    | "--branches"
                    | "--tags"
                    | "--remotes"
                    | "--stat"
                    | "--shortstat"
                    | "--numstat"
                    | "--name-only"
                    | "--name-status"
                    | "--summary"
                    | "-p"
                    | "--patch"
                    | "--no-patch"
                    | "-s"
                    | "--no-ext-diff"
                    | "--no-textconv"
                    | "--no-merges"
                    | "--merges"
                    | "--first-parent"
                    | "--reverse"
                    | "--follow"
                    | "--abbrev-commit"
                    | "--no-abbrev-commit"
                    | "--full-history"
                    | "--topo-order"
                    | "--date-order"
                    | "--author-date-order"
                    | "--parents"
                    | "--left-right"
                    | "--cherry-pick"
                    | "--cherry-mark"
                    | "-z"
                    | "--numbered"
                    | "--numbered-summary"
                    | "-e"
                    | "--email"
            ) || is_numeric_short_flag(arg)
                || is_prefixed_digits(arg, "-n")
                || is_prefixed_digits(arg, "-U")
                || lower_arg.starts_with("--max-count=")
                || lower_arg.starts_with("--skip=")
                || lower_arg.starts_with("--since=")
                || lower_arg.starts_with("--after=")
                || lower_arg.starts_with("--until=")
                || lower_arg.starts_with("--before=")
                || lower_arg.starts_with("--author=")
                || lower_arg.starts_with("--committer=")
                || lower_arg.starts_with("--grep=")
                || lower_arg.starts_with("--format=")
                || lower_arg.starts_with("--pretty=")
                || lower_arg.starts_with("--date=")
                || lower_arg.starts_with("--diff-filter=")
                || lower_arg.starts_with("--abbrev=")
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(
                arg,
                "-n" | "--max-count"
                    | "--skip"
                    | "--since"
                    | "--after"
                    | "--until"
                    | "--before"
                    | "--author"
                    | "--committer"
                    | "--grep"
                    | "--format"
                    | "--pretty"
                    | "--date"
                    | "--diff-filter"
                    | "-S"
                    | "-G"
                    | "-L"
            ) {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "grep" => {
            if matches!(
                arg,
                "-n" | "--line-number"
                    | "--column"
                    | "-i"
                    | "--ignore-case"
                    | "-I"
                    | "-w"
                    | "--word-regexp"
                    | "-v"
                    | "--invert-match"
                    | "-h"
                    | "-H"
                    | "--full-name"
                    | "-E"
                    | "--extended-regexp"
                    | "-G"
                    | "--basic-regexp"
                    | "-P"
                    | "--perl-regexp"
                    | "-F"
                    | "--fixed-strings"
                    | "-l"
                    | "--files-with-matches"
                    | "--name-only"
                    | "-L"
                    | "--files-without-match"
                    | "-c"
                    | "--count"
                    | "-o"
                    | "--only-matching"
                    | "-q"
                    | "--quiet"
                    | "-z"
                    | "--null"
                    | "--cached"
                    | "--untracked"
                    | "--no-exclude-standard"
                    | "--heading"
                    | "--break"
                    | "--all-match"
                    | "--and"
                    | "--or"
                    | "--not"
                    | "--no-textconv"
                    | "--no-ext-diff"
                    | "-p"
                    | "--show-function"
                    | "-W"
                    | "--function-context"
            ) || is_prefixed_digits(arg, "-A")
                || is_prefixed_digits(arg, "-B")
                || is_prefixed_digits(arg, "-C")
                || is_prefixed_digits(arg, "-m")
                || lower_arg.starts_with("--max-count=")
                || lower_arg.starts_with("--max-depth=")
                || lower_arg.starts_with("--after-context=")
                || lower_arg.starts_with("--before-context=")
                || lower_arg.starts_with("--context=")
                || arg.starts_with("-e") && arg.len() > 2
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(
                arg,
                "-e" | "-A"
                    | "--after-context"
                    | "-B"
                    | "--before-context"
                    | "-C"
                    | "--context"
                    | "-m"
                    | "--max-count"
                    | "--max-depth"
            ) {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "rev-parse" | "rev-list" | "merge-base" | "describe" | "name-rev" | "symbolic-ref"
        | "show-ref" | "for-each-ref" | "count-objects" => {
            if matches!(
                arg,
                "--short"
                    | "--abbrev-ref"
                    | "--show-toplevel"
                    | "--show-prefix"
                    | "--show-cdup"
                    | "--is-inside-work-tree"
                    | "--is-inside-git-dir"
                    | "--is-bare-repository"
                    | "--verify"
                    | "-q"
                    | "--quiet"
                    | "--count"
                    | "--left-right"
                    | "--left-only"
                    | "--right-only"
                    | "--all"
                    | "--branches"
                    | "--tags"
                    | "--heads"
                    | "--remotes"
                    | "--always"
                    | "--long"
                    | "--exact-match"
                    | "--dirty"
                    | "--is-ancestor"
                    | "--fork-point"
                    | "--octopus"
                    | "--first-parent"
                    | "--merges"
                    | "--no-merges"
                    | "--reverse"
                    | "-v"
                    | "--verbose"
                    | "-H"
                    | "--human-readable"
                    | "--hash"
                    | "-s"
            ) || is_numeric_short_flag(arg)
                || is_prefixed_digits(arg, "-n")
                || lower_arg.starts_with("--short=")
                || lower_arg.starts_with("--abbrev=")
                || lower_arg.starts_with("--max-count=")
                || lower_arg.starts_with("--format=")
                || lower_arg.starts_with("--sort=")
                || lower_arg.starts_with("--match=")
                || lower_arg.starts_with("--exclude=")
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(
                arg,
                "-n" | "--max-count" | "--format" | "--sort" | "--match" | "--exclude"
            ) {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "ls-files" | "ls-tree" | "check-ignore" | "cat-file" | "blame" => {
            if matches!(
                arg,
                "-c" | "--cached"
                    | "-d"
                    | "--deleted"
                    | "-m"
                    | "--modified"
                    | "-o"
                    | "--others"
                    | "-i"
                    | "--ignored"
                    | "-s"
                    | "--stage"
                    | "-u"
                    | "--unmerged"
                    | "--exclude-standard"
                    | "-z"
                    | "-r"
                    | "-t"
                    | "-l"
                    | "--long"
                    | "--name-only"
                    | "--name-status"
                    | "--full-name"
                    | "--full-tree"
                    | "-v"
                    | "--verbose"
                    | "-n"
                    | "--non-matching"
                    | "-p"
                    | "-e"
                    | "--porcelain"
                    | "--line-porcelain"
                    | "-w"
                    | "-b"
                    | "-M"
                    | "-C"
                    | "--show-email"
                    | "--show-name"
                    | "--show-number"
            ) || lower_arg.starts_with("--abbrev=")
                || lower_arg.starts_with("-L")
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(arg, "-L" | "--format") {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "add" => {
            if matches!(
                arg,
                "-A" | "--all"
                    | "-u"
                    | "--update"
                    | "-n"
                    | "--dry-run"
                    | "-v"
                    | "--verbose"
                    | "-f"
                    | "--force"
                    | "-N"
                    | "--intent-to-add"
                    | "--renormalize"
                    | "--ignore-errors"
            ) {
                GitFlagDisposition::AllowedNoValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "commit" => {
            if matches!(
                arg,
                "-a" | "--all"
                    | "--amend"
                    | "--no-edit"
                    | "--allow-empty"
                    | "--allow-empty-message"
                    | "--no-gpg-sign"
                    | "-q"
                    | "--quiet"
                    | "-v"
                    | "--verbose"
                    | "--dry-run"
                    | "--short"
                    | "--porcelain"
            ) || lower_arg.starts_with("--message=")
                || (arg.starts_with("-m") && arg.len() > 2)
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(arg, "-m" | "--message") {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "reset" => {
            if matches!(
                arg,
                "--soft" | "--mixed" | "--hard" | "--merge" | "--keep" | "-q" | "--quiet"
            ) {
                GitFlagDisposition::AllowedNoValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "restore" => {
            if matches!(
                arg,
                "--staged" | "-S" | "--worktree" | "-W" | "--ours" | "--theirs" | "-q" | "--quiet"
            ) || lower_arg.starts_with("--source=")
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(arg, "-s" | "--source") {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "switch" | "checkout" => {
            if matches!(
                arg,
                "-b" | "-B"
                    | "-c"
                    | "-C"
                    | "-d"
                    | "--detach"
                    | "-q"
                    | "--quiet"
                    | "-f"
                    | "--force"
                    | "--track"
                    | "--no-track"
                    | "--ours"
                    | "--theirs"
                    | "--orphan"
            ) {
                GitFlagDisposition::AllowedNoValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "branch" => {
            if matches!(
                arg,
                "-a" | "--all"
                    | "-r"
                    | "--remotes"
                    | "-l"
                    | "--list"
                    | "-v"
                    | "-vv"
                    | "--verbose"
                    | "--show-current"
                    | "--merged"
                    | "--no-merged"
                    | "--contains"
                    | "--no-contains"
                    | "-d"
                    | "-D"
                    | "--delete"
                    | "-m"
                    | "-M"
                    | "--move"
                    | "-c"
                    | "-C"
                    | "--copy"
                    | "-f"
                    | "--force"
                    | "-q"
                    | "--quiet"
            ) || lower_arg.starts_with("--sort=")
                || lower_arg.starts_with("--format=")
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(arg, "--sort" | "--format") {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "tag" => {
            if matches!(
                arg,
                "-l" | "--list"
                    | "-n"
                    | "-d"
                    | "--delete"
                    | "-a"
                    | "--annotate"
                    | "-f"
                    | "--force"
                    | "--contains"
                    | "--no-contains"
                    | "--merged"
                    | "--no-merged"
            ) || is_prefixed_digits(arg, "-n")
                || lower_arg.starts_with("--message=")
                || lower_arg.starts_with("--sort=")
                || (arg.starts_with("-m") && arg.len() > 2)
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(arg, "-m" | "--message" | "--sort") {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "stash" => {
            if matches!(
                arg,
                "-u" | "--include-untracked"
                    | "-a"
                    | "--all"
                    | "-k"
                    | "--keep-index"
                    | "--no-keep-index"
                    | "-q"
                    | "--quiet"
                    | "--staged"
                    | "--stat"
                    | "--index"
            ) || lower_arg.starts_with("--message=")
                || (arg.starts_with("-m") && arg.len() > 2)
            {
                GitFlagDisposition::AllowedNoValue
            } else if matches!(arg, "-m" | "--message") {
                GitFlagDisposition::AllowedTakesValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "rm" | "mv" => {
            if matches!(
                arg,
                "-f" | "--force"
                    | "-n"
                    | "--dry-run"
                    | "-r"
                    | "--cached"
                    | "-q"
                    | "--quiet"
                    | "-v"
                    | "--verbose"
                    | "-k"
            ) {
                GitFlagDisposition::AllowedNoValue
            } else {
                GitFlagDisposition::Rejected
            }
        }
        "version" => GitFlagDisposition::Rejected,
        _ => GitFlagDisposition::Rejected,
    }
}

fn short_flag_bundle_contains(arg: &str, needle: char) -> bool {
    arg.strip_prefix('-')
        .is_some_and(|short| !short.starts_with('-') && short.contains(needle))
}

fn reject_unsafe_unsandboxed_command_arg(
    cmd: &str,
    text: &str,
    lower_arg: &str,
) -> Result<(), String> {
    let blocked = match cmd {
        "printf" => text == "-v" || text.starts_with("-v") || short_flag_bundle_contains(text, 'v'),
        "tree" => text == "-o" || text.starts_with("-o") || short_flag_bundle_contains(text, 'o'),
        "find" => {
            matches!(
                lower_arg,
                "-exec"
                    | "-execdir"
                    | "-ok"
                    | "-okdir"
                    | "-fprint"
                    | "-fprint0"
                    | "-fprintf"
                    | "-fls"
                    | "-files0-from"
                    | "--files0-from"
                    | "-delete"
            ) || lower_arg.starts_with("-files0-from=")
                || lower_arg.starts_with("--files0-from=")
        }
        "fd" => {
            matches!(
                lower_arg,
                "-x" | "--exec"
                    | "-X"
                    | "--exec-batch"
                    | "--ignore-file"
                    | "--list-details"
                    | "--base-directory"
                    | "--config"
            ) || lower_arg.starts_with("--exec=")
                || lower_arg.starts_with("--exec-batch=")
                || lower_arg.starts_with("--ignore-file=")
                || lower_arg.starts_with("--base-directory=")
                || lower_arg.starts_with("--config=")
                || short_flag_bundle_contains(text, 'x')
                || short_flag_bundle_contains(text, 'X')
        }
        "rg" => {
            matches!(
                lower_arg,
                "--pre"
                    | "--pre-glob"
                    | "-z"
                    | "--search-zip"
                    | "--ignore-file"
                    | "--files-from"
                    | "--hostname-bin"
                    | "--hyperlink-format"
            ) || lower_arg.starts_with("--pre=")
                || lower_arg.starts_with("--pre-glob=")
                || lower_arg.starts_with("--ignore-file=")
                || lower_arg.starts_with("--files-from=")
                || lower_arg.starts_with("--hostname-bin=")
                || lower_arg.starts_with("--hyperlink-format=")
                || short_flag_bundle_contains(text, 'z')
        }
        "sort" => {
            matches!(
                lower_arg,
                "-o" | "--output"
                    | "--files0-from"
                    | "--compress-program"
                    | "--random-source"
                    | "-T"
                    | "--temporary-directory"
            ) || lower_arg.starts_with("--output=")
                || lower_arg.starts_with("--files0-from=")
                || lower_arg.starts_with("--compress-program=")
                || lower_arg.starts_with("--random-source=")
                || lower_arg.starts_with("--temporary-directory=")
                || short_flag_bundle_contains(text, 'o')
                || short_flag_bundle_contains(text, 'T')
        }
        "wc" | "du" => {
            matches!(lower_arg, "--files0-from" | "--exclude-from" | "-X")
                || lower_arg.starts_with("--files0-from=")
                || lower_arg.starts_with("--exclude-from=")
                || short_flag_bundle_contains(text, 'X')
        }
        "diff" => {
            matches!(
                lower_arg,
                "--from-file" | "--to-file" | "--exclude-from" | "-X"
            ) || lower_arg.starts_with("--from-file=")
                || lower_arg.starts_with("--to-file=")
                || lower_arg.starts_with("--exclude-from=")
                || short_flag_bundle_contains(text, 'X')
        }
        "date" => {
            matches!(lower_arg, "-f" | "--file" | "-s" | "--set")
                || lower_arg.starts_with("--file=")
                || lower_arg.starts_with("--set=")
                || short_flag_bundle_contains(text, 'f')
                || short_flag_bundle_contains(text, 's')
        }
        "cp" => {
            matches!(lower_arg, "-s" | "--symbolic-link" | "-l" | "--link")
                || short_flag_bundle_contains(text, 's')
                || short_flag_bundle_contains(text, 'l')
        }
        "md5sum" | "shasum" | "sha1sum" | "sha256sum" | "sha512sum" => {
            matches!(lower_arg, "-c" | "--check") || short_flag_bundle_contains(text, 'c')
        }
        _ => false,
    };
    if blocked {
        return Err(format!(
            "'{cmd} {text}' is blocked in unsandboxed native shell execution."
        ));
    }
    Ok(())
}

#[derive(Default)]
struct SimpleCommandSearchState {
    git_subcommand: Option<String>,
    git_saw_end_of_options: bool,
    git_expect_flag_value: bool,
    git_commit_non_interactive: bool,
    git_tag_annotated: bool,
    git_tag_has_message: bool,
    saw_end_of_options: bool,
    expect_flag_value: bool,
    saw_pattern_flag: bool,
    is_recursive_grep: bool,
    positional_args: usize,
    find_saw_expr: bool,
    find_saw_root: bool,
}

impl SimpleCommandSearchState {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn observe_arg(&mut self, cmd: &str, arg: &str, lower_arg: &str) {
        if cmd == "find" {
            if !self.find_saw_expr {
                if arg.starts_with('-') || matches!(arg, "!" | "(" | ")" | ",") {
                    self.find_saw_expr = true;
                } else {
                    self.find_saw_root = true;
                }
            }
            return;
        }

        let is_grep_like = matches!(cmd, "grep" | "egrep" | "fgrep" | "rg")
            || (cmd == "git" && self.git_subcommand.as_deref() == Some("grep"));
        if is_grep_like {
            if self.expect_flag_value {
                if matches!(cmd, "grep" | "egrep" | "fgrep") && lower_arg == "recurse" {
                    self.is_recursive_grep = true;
                }
                self.expect_flag_value = false;
                return;
            }
            if !self.saw_end_of_options {
                if arg == "--" {
                    self.saw_end_of_options = true;
                    return;
                }
                if arg.starts_with("--") {
                    if matches!(
                        lower_arg,
                        "--recursive" | "--dereference-recursive" | "--directories=recurse"
                    ) {
                        self.is_recursive_grep = true;
                    }
                    if matches!(lower_arg, "--regexp" | "--file") {
                        self.saw_pattern_flag = true;
                        self.expect_flag_value = true;
                    } else if lower_arg.starts_with("--regexp=") || lower_arg.starts_with("--file=")
                    {
                        self.saw_pattern_flag = true;
                    } else if matches!(
                        lower_arg,
                        "--max-count"
                            | "--after-context"
                            | "--before-context"
                            | "--context"
                            | "--directories"
                            | "--include"
                            | "--exclude"
                            | "--exclude-dir"
                            | "--exclude-from"
                            | "--label"
                            | "--glob"
                            | "--iglob"
                            | "--type"
                            | "--type-not"
                            | "--max-depth"
                            | "--threads"
                    ) {
                        self.expect_flag_value = true;
                    }
                    return;
                }
                if let Some(short) = arg.strip_prefix('-')
                    && !short.is_empty()
                {
                    if matches!(cmd, "grep" | "egrep" | "fgrep")
                        && (short.contains('r') || short.contains('R') || short == "drecurse")
                    {
                        self.is_recursive_grep = true;
                    }
                    if short == "e" || short == "f" {
                        self.saw_pattern_flag = true;
                        self.expect_flag_value = true;
                    } else if short.starts_with('e') || short.starts_with('f') {
                        self.saw_pattern_flag = true;
                    } else if matches!(
                        short,
                        "m" | "A" | "B" | "C" | "g" | "t" | "T" | "d" | "j" | "M"
                    ) {
                        self.expect_flag_value = true;
                    }
                    return;
                }
            }
            self.positional_args += 1;
            return;
        }

        if matches!(cmd, "fd" | "ls" | "dir" | "tree" | "du") {
            if self.expect_flag_value {
                self.expect_flag_value = false;
                return;
            }
            if !self.saw_end_of_options {
                if arg == "--" {
                    self.saw_end_of_options = true;
                    return;
                }
                if arg.starts_with('-') && arg != "-" {
                    if matches!(
                        lower_arg,
                        "-d" | "--max-depth"
                            | "-t"
                            | "--type"
                            | "-e"
                            | "--extension"
                            | "-E"
                            | "--exclude"
                            | "-L"
                            | "-P"
                            | "-I"
                            | "--maxdepth"
                    ) {
                        self.expect_flag_value = true;
                    }
                    return;
                }
            }
            self.positional_args += 1;
        }
    }

    fn uses_implicit_cwd_root(&self, cmd: &str) -> bool {
        match cmd {
            "grep" | "egrep" | "fgrep" => {
                self.is_recursive_grep
                    && ((self.saw_pattern_flag && self.positional_args == 0)
                        || (!self.saw_pattern_flag && self.positional_args < 2))
            }
            "rg" | "ag" | "ack" => {
                (self.saw_pattern_flag && self.positional_args == 0)
                    || (!self.saw_pattern_flag && self.positional_args < 2)
            }
            "git" if self.git_subcommand.as_deref() == Some("grep") => {
                (self.saw_pattern_flag && self.positional_args == 0)
                    || (!self.saw_pattern_flag && self.positional_args < 2)
            }
            "fd" => self.positional_args < 2,
            "find" => !self.find_saw_root,
            "ls" | "dir" | "tree" | "du" => self.positional_args == 0,
            _ => false,
        }
    }
}

fn merge_possible_dirs(dst: &mut Vec<PathBuf>, src: &[PathBuf]) -> Result<(), String> {
    for dir in src {
        if !dst.iter().any(|existing| existing == dir) {
            dst.push(dir.clone());
            if dst.len() > MAX_SHELL_POSSIBLE_DIRS {
                return Err(
                    "Native shell command exceeded directory-tracking complexity limit.".to_owned(),
                );
            }
        }
    }
    Ok(())
}

fn validate_native_shell_command_text(
    command: &str,
    base_dir: &Path,
    ctx: &ToolExecutionContext,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SHELL_RECURSION_DEPTH {
        return Err("Native shell command exceeded maximum nesting depth.".to_owned());
    }
    if command.trim().is_empty() {
        return Err("Native shell command must not be empty.".to_owned());
    }
    if command.contains('\0') {
        return Err("Native shell command contains a NUL byte.".to_owned());
    }
    if command.contains('\r') || command.contains("\\\n") {
        return Err(
            "Escaped line continuations and carriage returns are blocked in unsandboxed native shell execution."
                .to_owned(),
        );
    }
    if let Some(reason) = command_mentions_protected_credential_path(command, ctx) {
        return Err(reason);
    }
    if let Some(reason) = command_references_sensitive_provider_env(command) {
        return Err(reason);
    }

    let tokens = tokenize_shell_command(command)?;
    // Track the set of all working directories that could be active at this point in the command
    // (restored on `)` subshell exit, preserved across pipelines/background jobs, and unioned
    // across conditional or potentially failing `cd` branches).
    let mut possible_dirs: Vec<PathBuf> = vec![base_dir.to_path_buf()];
    let mut segment_start_dirs: Vec<PathBuf> = possible_dirs.clone();
    let mut pipeline_entry_dirs: Option<Vec<PathBuf>> = None;
    let mut subshell_stack: Vec<(Vec<PathBuf>, Option<Vec<PathBuf>>, bool)> = Vec::new();
    let mut in_conditional_chain = false;

    let mut at_command_pos = true;
    let mut current_cmd = String::new();
    let mut expect_write_target = false;
    let mut expect_read_target = false;
    let mut expect_fd_dup_or_write = false;
    let mut expect_fd_dup_only = false;
    let mut expect_subshell_script = false;
    let mut nested_shell_got_script = false;
    let mut saw_cd_arg = false;
    let mut cd_updated_this_cmd = false;
    let mut search_state = SimpleCommandSearchState::default();

    let is_fd_dup_spec = |s: &str| -> bool {
        s == "-"
            || (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            || (s.len() > 1
                && s.ends_with('-')
                && s[..s.len() - 1].chars().all(|c| c.is_ascii_digit()))
    };

    let finish_simple_command = |current_cmd: &str,
                                 saw_cd_arg: bool,
                                 nested_shell_got_script: bool,
                                 pending_redirect: bool,
                                 in_conditional_chain: bool,
                                 search_state: &SimpleCommandSearchState,
                                 possible_dirs: &mut Vec<PathBuf>,
                                 cd_updated_this_cmd: &mut bool|
     -> Result<(), String> {
        if pending_redirect {
            return Err("Incomplete shell redirection in native shell command.".to_owned());
        }
        if current_cmd == "cd" && !saw_cd_arg {
            // Bare `cd` jumps to `$HOME`.
            let home_canon =
                assert_read_path_allowed(&ctx.homedir, ctx).map_err(|e| e.to_string())?;
            *cd_updated_this_cmd = true;
            if in_conditional_chain || !std::fs::metadata(&home_canon).is_ok_and(|m| m.is_dir()) {
                merge_possible_dirs(possible_dirs, &[home_canon])?;
            } else {
                *possible_dirs = vec![home_canon];
            }
        }
        if is_nested_posix_shell(current_cmd) && !nested_shell_got_script {
            return Err(format!(
                "Nested shell '{current_cmd}' without an inline -c command is blocked in unsandboxed native shell execution."
            ));
        }
        if current_cmd == "git" {
            if search_state.git_subcommand.as_deref() == Some("commit")
                && !search_state.git_commit_non_interactive
            {
                return Err(
                    "'git commit' without '-m'/'--message', '--no-edit', or '--dry-run' is blocked in unsandboxed native shell execution because it can spawn an editor."
                        .to_owned(),
                );
            }
            if search_state.git_subcommand.as_deref() == Some("tag")
                && search_state.git_tag_annotated
                && !search_state.git_tag_has_message
            {
                return Err(
                    "'git tag -a' without '-m'/'--message' is blocked in unsandboxed native shell execution because it can spawn an editor."
                        .to_owned(),
                );
            }
        }
        if search_state.uses_implicit_cwd_root(current_cmd) {
            for dir in possible_dirs.iter() {
                let canonical = assert_read_path_allowed(dir, ctx).map_err(|e| e.to_string())?;
                assert_search_root_has_no_protected_descendant(&canonical, ctx)?;
            }
        }
        Ok(())
    };

    for token in &tokens {
        match token {
            ShellToken::Operator(op) => {
                let op_body = op.trim_start_matches(|c: char| c.is_ascii_digit());
                if matches!(op_body, "`" | "<<" | "<<<" | "<(" | ">(") {
                    return Err(format!(
                        "Dynamic shell operator '{op}' is blocked in unsandboxed native shell execution."
                    ));
                }
                if matches!(op_body, ">" | ">>" | "&>" | "&>>" | ">|" | "<>") {
                    expect_write_target = true;
                    expect_read_target = false;
                    expect_fd_dup_or_write = false;
                    expect_fd_dup_only = false;
                } else if op_body == ">&" {
                    expect_fd_dup_or_write = true;
                    expect_write_target = false;
                    expect_read_target = false;
                    expect_fd_dup_only = false;
                } else if op_body == "<&" {
                    expect_fd_dup_only = true;
                    expect_write_target = false;
                    expect_read_target = false;
                    expect_fd_dup_or_write = false;
                } else if op_body == "<" {
                    if is_nested_posix_shell(&current_cmd) {
                        return Err(format!(
                            "Feeding stdin into shell '{current_cmd}' is blocked in unsandboxed native shell execution."
                        ));
                    }
                    expect_read_target = true;
                    expect_write_target = false;
                    expect_fd_dup_or_write = false;
                    expect_fd_dup_only = false;
                } else if op == "(" {
                    if !at_command_pos {
                        return Err(
                            "Unexpected '(' subshell or function definition syntax is blocked in unsandboxed native shell execution."
                                .to_owned(),
                        );
                    }
                    subshell_stack.push((
                        possible_dirs.clone(),
                        pipeline_entry_dirs.clone(),
                        in_conditional_chain,
                    ));
                    pipeline_entry_dirs = None;
                    in_conditional_chain = false;
                    segment_start_dirs = possible_dirs.clone();
                    at_command_pos = true;
                    current_cmd.clear();
                    expect_write_target = false;
                    expect_read_target = false;
                    expect_fd_dup_or_write = false;
                    expect_fd_dup_only = false;
                    expect_subshell_script = false;
                    nested_shell_got_script = false;
                    saw_cd_arg = false;
                    cd_updated_this_cmd = false;
                    search_state.reset();
                } else if op == ")" {
                    finish_simple_command(
                        &current_cmd,
                        saw_cd_arg,
                        nested_shell_got_script,
                        expect_write_target
                            || expect_read_target
                            || expect_fd_dup_or_write
                            || expect_fd_dup_only,
                        in_conditional_chain,
                        &search_state,
                        &mut possible_dirs,
                        &mut cd_updated_this_cmd,
                    )?;
                    let Some((saved_dirs, saved_pipeline_entry, saved_in_cond)) =
                        subshell_stack.pop()
                    else {
                        return Err("Unmatched ')' in native shell command.".to_owned());
                    };
                    // Exiting a subshell restores the parent shell's working directory set.
                    possible_dirs = saved_dirs;
                    pipeline_entry_dirs = saved_pipeline_entry;
                    in_conditional_chain = saved_in_cond;
                    segment_start_dirs = possible_dirs.clone();
                    at_command_pos = true;
                    current_cmd.clear();
                    expect_write_target = false;
                    expect_read_target = false;
                    expect_fd_dup_or_write = false;
                    expect_fd_dup_only = false;
                    expect_subshell_script = false;
                    nested_shell_got_script = false;
                    saw_cd_arg = false;
                    cd_updated_this_cmd = false;
                    search_state.reset();
                } else {
                    finish_simple_command(
                        &current_cmd,
                        saw_cd_arg,
                        nested_shell_got_script,
                        expect_write_target
                            || expect_read_target
                            || expect_fd_dup_or_write
                            || expect_fd_dup_only,
                        in_conditional_chain,
                        &search_state,
                        &mut possible_dirs,
                        &mut cd_updated_this_cmd,
                    )?;
                    match op.as_str() {
                        "|" | "|&" => {
                            let entry = pipeline_entry_dirs
                                .get_or_insert_with(|| segment_start_dirs.clone())
                                .clone();
                            // Pipeline stages execute in subshells in POSIX/Bash, so a `cd` in an
                            // upstream stage does not move downstream stages' working directory.
                            merge_possible_dirs(&mut possible_dirs, &entry)?;
                        }
                        "&&" => {
                            if let Some(entry) = pipeline_entry_dirs.take() {
                                merge_possible_dirs(&mut possible_dirs, &entry)?;
                            }
                            in_conditional_chain = true;
                        }
                        "||" => {
                            if cd_updated_this_cmd {
                                // If `cd` failed, the RHS of `||` executes in the pre-`cd` directory.
                                merge_possible_dirs(&mut possible_dirs, &segment_start_dirs)?;
                            }
                            if let Some(entry) = pipeline_entry_dirs.take() {
                                merge_possible_dirs(&mut possible_dirs, &entry)?;
                            }
                            in_conditional_chain = true;
                        }
                        "&" => {
                            // Background lists run in a subshell and do not alter the parent's cwd.
                            if let Some(entry) = pipeline_entry_dirs.take() {
                                possible_dirs = entry;
                            } else {
                                possible_dirs = segment_start_dirs.clone();
                            }
                            in_conditional_chain = false;
                        }
                        _ => {
                            if let Some(entry) = pipeline_entry_dirs.take() {
                                merge_possible_dirs(&mut possible_dirs, &entry)?;
                            }
                            in_conditional_chain = false;
                        }
                    }
                    segment_start_dirs = possible_dirs.clone();
                    at_command_pos = true;
                    current_cmd.clear();
                    expect_write_target = false;
                    expect_read_target = false;
                    expect_fd_dup_or_write = false;
                    expect_fd_dup_only = false;
                    expect_subshell_script = false;
                    nested_shell_got_script = false;
                    saw_cd_arg = false;
                    cd_updated_this_cmd = false;
                    search_state.reset();
                }
            }
            ShellToken::Word {
                text,
                quoted,
                has_unquoted_glob,
                has_unquoted_brace,
                has_unquoted_dollar,
                has_unquoted_backtick,
            } => {
                if *has_unquoted_dollar || *has_unquoted_backtick {
                    return Err(
                        "Dynamic shell variable, command, or ANSI-C expansion is blocked in unsandboxed native shell execution."
                            .to_owned(),
                    );
                }
                // Defense-in-depth on unquoted/unescaped token text so quote/backslash splitting
                // (e.g. `/pr\oc/se''lf/environ` or `~/.co""work/auth/...`) cannot evade raw checks.
                if let Some(reason) = command_mentions_protected_credential_path(text, ctx) {
                    return Err(reason);
                }
                if let Some(reason) = command_references_sensitive_provider_env(text) {
                    return Err(reason);
                }
                if expect_fd_dup_or_write {
                    expect_fd_dup_or_write = false;
                    if !is_fd_dup_spec(text) {
                        for dir in &possible_dirs {
                            if *has_unquoted_glob && segment_has_glob_meta(text) {
                                validate_shell_glob_operand(text, dir, ctx, "", true)?;
                            } else {
                                validate_shell_path_token(text, dir, ctx, true, false)?;
                            }
                        }
                    }
                    continue;
                }
                if expect_fd_dup_only {
                    expect_fd_dup_only = false;
                    if !is_fd_dup_spec(text) {
                        return Err(format!(
                            "Invalid file-descriptor redirection target '{text}' in native shell command."
                        ));
                    }
                    continue;
                }
                if expect_write_target {
                    expect_write_target = false;
                    if !text.starts_with('&') {
                        for dir in &possible_dirs {
                            if *has_unquoted_glob && segment_has_glob_meta(text) {
                                validate_shell_glob_operand(text, dir, ctx, "", true)?;
                            } else {
                                validate_shell_path_token(text, dir, ctx, true, false)?;
                            }
                        }
                    }
                    continue;
                }
                if expect_read_target {
                    expect_read_target = false;
                    for dir in &possible_dirs {
                        if *has_unquoted_glob && segment_has_glob_meta(text) {
                            validate_shell_glob_operand(text, dir, ctx, "", false)?;
                        } else {
                            validate_shell_path_token(text, dir, ctx, false, false)?;
                        }
                    }
                    continue;
                }
                if expect_subshell_script {
                    expect_subshell_script = false;
                    nested_shell_got_script = true;
                    for dir in &possible_dirs {
                        validate_native_shell_command_text(text, dir, ctx, depth + 1)?;
                    }
                    continue;
                }

                if at_command_pos {
                    // Deny inline `ENV=VAL` assignments (`LD_PRELOAD=...`, `BASH_ENV=...`,
                    // `PATH=...`, or shell variables assembled to compute paths dynamically).
                    if !quoted
                        && let Some((lhs, _)) = text.split_once('=')
                        && !lhs.is_empty()
                        && lhs.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    {
                        return Err(format!(
                            "Shell environment/variable assignment '{lhs}=...' is blocked in unsandboxed native shell execution."
                        ));
                    }
                    if *has_unquoted_glob && segment_has_glob_meta(text) {
                        return Err(format!(
                            "Globbed executable path '{text}' is blocked in unsandboxed native shell execution."
                        ));
                    }
                    if (text.contains('/') || text.contains('\\'))
                        && !is_safe_system_executable_path(text)
                    {
                        return Err(format!(
                            "Executing opaque local or custom executable '{text}' is blocked in unsandboxed native shell execution."
                        ));
                    }
                    let base = Path::new(text)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(text)
                        .to_ascii_lowercase();
                    if !is_unsandboxed_allowed_command(&base) {
                        return Err(format!(
                            "Command '{base}' is not allowed in unsandboxed native shell execution; use Cowork's OS-sandboxed bash tool or an audited file/git command instead."
                        ));
                    }
                    current_cmd = base;
                    at_command_pos = false;
                    nested_shell_got_script = false;
                    saw_cd_arg = false;
                    cd_updated_this_cmd = false;
                    search_state.reset();
                    continue;
                }

                if is_nested_posix_shell(&current_cmd) {
                    if !nested_shell_got_script && text == "-c" {
                        expect_subshell_script = true;
                        continue;
                    }
                    return Err(format!(
                        "Shell '{current_cmd}' only permits a single validated '-c' inline command in unsandboxed native shell execution."
                    ));
                }

                if current_cmd == "cd" {
                    if !saw_cd_arg && matches!(text.as_str(), "--" | "-L" | "-P") {
                        continue;
                    }
                    saw_cd_arg = true;
                    if text == "-" {
                        return Err(
                            "Dynamic 'cd -' is blocked in unsandboxed native shell execution."
                                .to_owned(),
                        );
                    }
                    if (*has_unquoted_glob && segment_has_glob_meta(text))
                        || (*has_unquoted_brace && text.contains('{') && text.contains('}'))
                    {
                        return Err(format!(
                            "Dynamic glob/brace 'cd' target '{text}' is blocked in unsandboxed native shell execution."
                        ));
                    }
                    let mut next_dirs = Vec::new();
                    if in_conditional_chain {
                        merge_possible_dirs(&mut next_dirs, &possible_dirs)?;
                    }
                    for dir in &possible_dirs {
                        if let Some(resolved) =
                            validate_shell_path_token(text, dir, ctx, false, false)?
                        {
                            merge_possible_dirs(&mut next_dirs, std::slice::from_ref(&resolved))?;
                            // If the target directory does not exist (or isn't a searchable dir),
                            // `cd` fails at runtime and leaves the shell in `dir`.
                            if !std::fs::metadata(&resolved).is_ok_and(|m| m.is_dir()) {
                                merge_possible_dirs(&mut next_dirs, std::slice::from_ref(dir))?;
                            }
                        } else {
                            merge_possible_dirs(&mut next_dirs, std::slice::from_ref(dir))?;
                        }
                    }
                    possible_dirs = next_dirs;
                    cd_updated_this_cmd = true;
                    continue;
                }

                // Block command-specific code-execution, config-indirection, link-creation,
                // and implicit-target flags on allowlisted utilities.
                let lower_arg = text.to_ascii_lowercase();
                reject_unsafe_unsandboxed_command_arg(&current_cmd, text, &lower_arg)?;
                if current_cmd == "git" {
                    if search_state.git_subcommand.is_none() {
                        if text.starts_with('-') {
                            if !is_safe_git_global_flag(text) {
                                return Err(format!(
                                    "Git global option '{text}' is blocked in unsandboxed native shell execution."
                                ));
                            }
                        } else {
                            if !is_allowed_unsandboxed_git_subcommand(&lower_arg) {
                                return Err(format!(
                                    "Git subcommand '{text}' is blocked in unsandboxed native shell execution because it can write implicit protected paths or run arbitrary repository/config hooks."
                                ));
                            }
                            search_state.git_subcommand = Some(lower_arg.clone());
                            continue;
                        }
                    } else if let Some(sub) = search_state.git_subcommand.as_deref() {
                        if search_state.git_expect_flag_value {
                            search_state.git_expect_flag_value = false;
                        } else if !search_state.git_saw_end_of_options {
                            if text == "--" {
                                search_state.git_saw_end_of_options = true;
                            } else if text.starts_with('-') && text != "-" {
                                match classify_safe_git_subcommand_flag(sub, text, &lower_arg) {
                                    GitFlagDisposition::Rejected => {
                                        return Err(format!(
                                            "'git {sub} {text}' is blocked in unsandboxed native shell execution."
                                        ));
                                    }
                                    GitFlagDisposition::AllowedTakesValue => {
                                        search_state.git_expect_flag_value = true;
                                    }
                                    GitFlagDisposition::AllowedNoValue => {}
                                }
                                if sub == "commit"
                                    && (matches!(
                                        text.as_str(),
                                        "-m" | "--message"
                                            | "--no-edit"
                                            | "--dry-run"
                                            | "--short"
                                            | "--porcelain"
                                    ) || lower_arg.starts_with("--message=")
                                        || text.starts_with("-m"))
                                {
                                    search_state.git_commit_non_interactive = true;
                                }
                                if sub == "tag" {
                                    if matches!(text.as_str(), "-a" | "--annotate") {
                                        search_state.git_tag_annotated = true;
                                    }
                                    if matches!(text.as_str(), "-m" | "--message")
                                        || lower_arg.starts_with("--message=")
                                        || text.starts_with("-m")
                                    {
                                        search_state.git_tag_has_message = true;
                                    }
                                }
                            }
                        }
                    }
                }
                search_state.observe_arg(&current_cmd, text, &lower_arg);

                let is_mut = is_mutating_shell_command(&current_cmd);

                // Inspect `key=value` arguments (e.g. `of=/dev/sda`, `--file=credential-link`, `file=@/etc/passwd`).
                if let Some((lhs, rhs)) = text.split_once('=') {
                    let rhs_clean = rhs.strip_prefix('@').unwrap_or(rhs);
                    if lhs.eq_ignore_ascii_case("of") {
                        for dir in &possible_dirs {
                            validate_shell_path_token(rhs_clean, dir, ctx, true, false)?;
                        }
                        continue;
                    }
                    let force_write = matches!(
                        lhs.to_ascii_lowercase().as_str(),
                        "--output" | "--out" | "-o" | "--dest" | "--target-directory"
                    );
                    for dir in &possible_dirs {
                        validate_shell_operand_candidate(
                            rhs_clean,
                            *has_unquoted_glob,
                            *has_unquoted_brace,
                            dir,
                            ctx,
                            &current_cmd,
                            is_mut,
                            force_write,
                        )?;
                    }
                    continue;
                }

                // Inspect concatenated short-flag path operands (e.g. `grep -fcredential-link`,
                // `grep -f/etc/passwd`, `cp -t.git/hooks evil`).
                if let Some(short) = text.strip_prefix('-')
                    && !short.starts_with('-')
                    && short.len() > 1
                {
                    let mut chars = short.chars();
                    let flag_char = chars.next().unwrap_or_default();
                    let tail = chars.as_str();
                    let tail_clean = tail.strip_prefix('@').unwrap_or(tail);
                    let flag_takes_file = match flag_char {
                        'f' => matches!(
                            current_cmd.as_str(),
                            "grep" | "egrep" | "fgrep" | "rg" | "date"
                        ),
                        'F' => current_cmd == "git",
                        't' | 'T' => matches!(current_cmd.as_str(), "cp" | "mv"),
                        'o' => current_cmd == "sort",
                        _ => false,
                    };
                    if flag_takes_file
                        || looks_like_filesystem_path(tail_clean)
                        || tail_clean.contains('/')
                        || tail_clean.contains('\\')
                    {
                        let force_write = matches!(flag_char, 'o' | 't' | 'T');
                        for dir in &possible_dirs {
                            validate_shell_operand_candidate(
                                tail_clean,
                                *has_unquoted_glob,
                                *has_unquoted_brace,
                                dir,
                                ctx,
                                &current_cmd,
                                is_mut,
                                force_write,
                            )?;
                        }
                    }
                }

                // Inspect both explicit path tokens and relative file/symlink/glob operands.
                let candidate = text.strip_prefix('@').unwrap_or(text);
                for dir in &possible_dirs {
                    validate_shell_operand_candidate(
                        candidate,
                        *has_unquoted_glob,
                        *has_unquoted_brace,
                        dir,
                        ctx,
                        &current_cmd,
                        is_mut,
                        false,
                    )?;
                }
            }
        }
    }

    finish_simple_command(
        &current_cmd,
        saw_cd_arg,
        nested_shell_got_script,
        expect_write_target || expect_read_target || expect_fd_dup_or_write || expect_fd_dup_only,
        in_conditional_chain,
        &search_state,
        &mut possible_dirs,
        &mut cd_updated_this_cmd,
    )?;
    if !subshell_stack.is_empty() {
        return Err("Unclosed '(' subshell in native shell command.".to_owned());
    }

    Ok(())
}

fn truncate_summary(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_PROMPT_SUMMARY_CHARS {
        return trimmed.to_owned();
    }
    let mut out: String = trimmed
        .chars()
        .take(MAX_PROMPT_SUMMARY_CHARS.saturating_sub(1))
        .collect();
    out.push('…');
    out
}
