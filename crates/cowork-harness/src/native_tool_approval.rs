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
    lexical_tool_path, matches_ts_approval_patterns, normalize_lexical_path,
    protected_credential_roots, resolve_and_validate_url_target,
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
            Some(Value::String(s)) if !s.trim().is_empty() => extra_paths.push(s.trim().to_owned()),
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
                Value::String(s) if !s.trim().is_empty() => extra_paths.push(s.trim().to_owned()),
                Value::Object(obj) => {
                    if let Some(p) = obj
                        .get("path")
                        .or_else(|| obj.get("uri"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        extra_paths.push(p.strip_prefix("file://").unwrap_or(p).to_owned());
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

/// Resolves a path from a native tool against `base_dir`, expanding leading `~` against
/// `homedir` (because native runtimes such as Claude Code expand tilde) and rejecting NUL
/// bytes or `~otheruser` spellings.
fn resolve_native_tool_path(raw: &str, base_dir: &Path, homedir: &Path) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Native tool path must not be empty.".to_owned());
    }
    if trimmed.contains('\0') {
        return Err("Native tool path contains a NUL byte.".to_owned());
    }
    if trimmed == "~" {
        return Ok(normalize_lexical_path(homedir));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return Ok(normalize_lexical_path(&homedir.join(rest)));
    }
    if trimmed.starts_with('~') {
        return Err(format!("Ambiguous tilde user path is blocked: {trimmed}"));
    }
    lexical_tool_path(trimmed, base_dir).map_err(|e| e.to_string())
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
            Some(Value::String(s)) if !s.trim().is_empty() => out.push(s.trim().to_owned()),
            Some(_) => return Err(format!("Invalid native tool path field '{key}'.")),
        }
    }
    for &key in array_keys {
        match input.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
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
        validated.push(canonical.display().to_string());
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
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.contains('\0') {
        return Err("Search pattern contains a NUL byte.".to_owned());
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.starts_with('~')
        || has_windows_drive_prefix(trimmed)
    {
        return Err(format!(
            "Absolute or home-relative search pattern is blocked: {trimmed}"
        ));
    }
    let normalized = trimmed.replace('\\', "/");
    for seg in normalized.split('/') {
        if seg == ".." {
            return Err(format!(
                "Parent-traversal search pattern is blocked: {trimmed}"
            ));
        }
        if matches!(
            seg.to_ascii_lowercase().as_str(),
            ".ssh" | ".aws" | ".gnupg" | ".kube" | ".azure"
        ) {
            return Err(format!(
                "Protected credential search pattern is blocked: {trimmed}"
            ));
        }
    }
    let lower = normalized.to_ascii_lowercase();
    if lower.contains(".cowork/auth") || lower.contains(".cowork/mobile-pairing") {
        return Err(format!(
            "Protected Cowork credential search pattern is blocked: {trimmed}"
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
        validated.push(canonical.display().to_string());
    } else {
        for raw in &raw_paths {
            let candidate = resolve_native_tool_path(raw, &base_dir, &ctx.homedir)?;
            let canonical = assert_read_path_allowed(&candidate, ctx).map_err(|e| e.to_string())?;
            assert_search_root_has_no_protected_descendant(&canonical, ctx)?;
            validated.push(canonical.display().to_string());
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
    for line in patch_text.lines() {
        let trimmed = line.trim();
        for prefix in [
            "*** Update File:",
            "*** Add File:",
            "*** Delete File:",
            "*** Move to:",
        ] {
            if let Some(rest) = trimmed.strip_prefix(prefix) {
                let p = rest.trim();
                if !p.is_empty() {
                    paths.push(p.to_owned());
                }
            }
        }
        for prefix in ["+++ ", "--- "] {
            if let Some(rest) = trimmed.strip_prefix(prefix) {
                let p = rest.split('\t').next().unwrap_or("").trim();
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
                        Some(Value::String(s)) if !s.trim().is_empty() => {
                            raw_paths.push(s.trim().to_owned());
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
            if key.trim().is_empty() {
                return Err("Native edit tool 'fileChanges' contains empty path.".to_owned());
            }
            raw_paths.push(key.trim().to_owned());
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
        validated.push(canonical.display().to_string());
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
        expandable: bool,
    },
}

fn tokenize_shell_command(command: &str) -> Vec<ShellToken> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            if ch == '\n' {
                tokens.push(ShellToken::Operator("\n".to_owned()));
            }
            i += 1;
            continue;
        }

        // Multi-char operators: `&&`, `||`, `>>`, `>|`, `<>`, `&>`, `1>`, `2>`, `1>>`, `2>>`.
        if (ch == '1' || ch == '2')
            && i + 1 < chars.len()
            && chars[i + 1] == '>'
            && (i == 0
                || chars[i - 1].is_whitespace()
                || matches!(chars[i - 1], ';' | '|' | '&' | '(' | '`'))
        {
            let mut op = String::new();
            op.push(ch);
            op.push('>');
            i += 2;
            if i < chars.len() && chars[i] == '>' {
                op.push('>');
                i += 1;
            }
            tokens.push(ShellToken::Operator(op));
            continue;
        }
        if matches!(ch, '|' | '&' | '>' | '<' | ';' | '(' | ')' | '`') {
            let mut op = String::new();
            op.push(ch);
            i += 1;
            if i < chars.len() {
                let next = chars[i];
                if (ch == '|' && next == '|')
                    || (ch == '&' && matches!(next, '&' | '>'))
                    || (ch == '>' && matches!(next, '>' | '|'))
                    || (ch == '<' && next == '>')
                {
                    op.push(next);
                    i += 1;
                }
            }
            tokens.push(ShellToken::Operator(op));
            continue;
        }

        let mut word = String::new();
        let mut quoted = false;
        let mut expandable = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' {
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    i += 1;
                }
            } else if c == '"' {
                quoted = true;
                expandable = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    i += 1;
                }
            } else if c == '\\' && i + 1 < chars.len() {
                expandable = true;
                i += 1;
                word.push(chars[i]);
                i += 1;
            } else if c.is_whitespace()
                || matches!(c, '|' | '&' | '>' | '<' | ';' | '(' | ')' | '`')
            {
                break;
            } else {
                expandable = true;
                word.push(c);
                i += 1;
            }
        }
        if !word.is_empty() {
            tokens.push(ShellToken::Word {
                text: word,
                quoted,
                expandable,
            });
        }
    }
    tokens
}

fn extract_embedded_command_substitutions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
            i += 2;
            let start = i;
            let mut depth = 1usize;
            while i < chars.len() && depth > 0 {
                match chars[i] {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                if depth > 0 {
                    i += 1;
                }
            }
            let inner: String = chars[start..i].iter().collect();
            if !inner.trim().is_empty() {
                out.push(inner);
            }
            if i < chars.len() && chars[i] == ')' {
                i += 1;
            }
        } else if chars[i] == '`' {
            i += 1;
            let start = i;
            while i < chars.len() && chars[i] != '`' {
                i += 1;
            }
            let inner: String = chars[start..i].iter().collect();
            if !inner.trim().is_empty() {
                out.push(inner);
            }
            if i < chars.len() && chars[i] == '`' {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
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
    let trimmed = raw.trim();
    if trimmed == "~"
        || trimmed == "$HOME"
        || trimmed == "${HOME}"
        || trimmed.eq_ignore_ascii_case("%USERPROFILE%")
        || trimmed.eq_ignore_ascii_case("$ENV:USERPROFILE")
    {
        return Some(normalize_lexical_path(homedir));
    }
    if trimmed == "$PWD" || trimmed == "${PWD}" {
        return Some(normalize_lexical_path(base_dir));
    }
    for prefix in ["~/", "~\\", "$HOME/", "$HOME\\", "${HOME}/", "${HOME}\\"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(normalize_lexical_path(&homedir.join(rest)));
        }
    }
    for prefix in ["$PWD/", "$PWD\\", "${PWD}/", "${PWD}\\"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(normalize_lexical_path(&base_dir.join(rest)));
        }
    }
    let lower = trimmed.to_ascii_lowercase();
    for prefix in [
        "%userprofile%\\",
        "%userprofile%/",
        "$env:userprofile\\",
        "$env:userprofile/",
    ] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let tail = &trimmed[trimmed.len() - rest.len()..];
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
    .any(|prefix| path.starts_with(prefix))
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
            | "install"
            | "sed"
            | "perl"
            | "shred"
    )
}

fn validate_shell_path_token(
    raw: &str,
    base_dir: &Path,
    ctx: &ToolExecutionContext,
    require_write: bool,
    at_command_pos: bool,
) -> Result<(), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || is_url_token(trimmed) {
        return Ok(());
    }
    if is_safe_stdio_device(trimmed) {
        return Ok(());
    }
    if at_command_pos && !require_write && is_safe_system_executable_path(trimmed) {
        return Ok(());
    }
    let resolved =
        if let Some(expanded) = expand_shell_known_prefix(trimmed, base_dir, &ctx.homedir) {
            expanded
        } else if trimmed.starts_with('~') {
            return Err(format!(
                "Native shell command uses blocked tilde user path '{trimmed}'."
            ));
        } else if trimmed.starts_with('$')
            && (require_write
                || trimmed.contains("/../")
                || trimmed.contains("\\..\\")
                || trimmed.ends_with("/..")
                || trimmed.ends_with("\\.."))
        {
            return Err(format!(
                "Native shell command uses ambiguous variable path '{trimmed}'."
            ));
        } else {
            lexical_tool_path(trimmed, base_dir).map_err(|e| e.to_string())?
        };

    if require_write {
        assert_write_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?;
    } else {
        assert_read_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_inline_script_paths(
    script: &str,
    base_dir: &Path,
    ctx: &ToolExecutionContext,
) -> Result<(), String> {
    // Scan single- and double-quoted string literals inside `-c` / `-e` interpreter payloads
    // for sensitive OS or home-relative filesystem paths.
    let chars: Vec<char> = script.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let q = chars[i];
        if q == '\'' || q == '"' {
            i += 1;
            let mut literal = String::new();
            while i < chars.len() && chars[i] != q {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                literal.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                i += 1;
            }
            let trimmed = literal.trim();
            let looks_sensitive_os_path = trimmed == "/"
                || trimmed.starts_with("~/")
                || trimmed.starts_with("~\\")
                || trimmed.starts_with("$HOME/")
                || trimmed.starts_with("${HOME}/")
                || trimmed.starts_with("../")
                || trimmed.starts_with("..\\")
                || has_windows_drive_prefix(trimmed)
                || trimmed.starts_with("\\\\")
                || [
                    "/etc/",
                    "/var/",
                    "/root/",
                    "/home/",
                    "/users/",
                    "/private/",
                    "/proc/",
                    "/sys/",
                    "/tmp/",
                ]
                .iter()
                .any(|p| trimmed.to_ascii_lowercase().starts_with(p));
            if looks_sensitive_os_path {
                validate_shell_path_token(trimmed, base_dir, ctx, false, false)?;
            }
        } else {
            i += 1;
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
    if let Some(reason) = command_mentions_protected_credential_path(command, ctx) {
        return Err(reason);
    }

    let tokens = tokenize_shell_command(command);
    let mut at_command_pos = true;
    let mut current_cmd = String::new();
    let mut expect_write_target = false;
    let mut expect_read_target = false;
    let mut expect_subshell_script = false;
    let mut expect_interpreter_script = false;
    let mut saw_cd_arg = false;

    for token in &tokens {
        match token {
            ShellToken::Operator(op) => {
                if matches!(
                    op.as_str(),
                    ">" | ">>" | "1>" | "2>" | "1>>" | "2>>" | "&>" | ">|" | "<>"
                ) {
                    expect_write_target = true;
                    expect_read_target = false;
                } else if op == "<" {
                    expect_read_target = true;
                    expect_write_target = false;
                } else {
                    if current_cmd == "cd" && !saw_cd_arg {
                        // Bare `cd` jumps to `$HOME`.
                        assert_read_path_allowed(&ctx.homedir, ctx).map_err(|e| e.to_string())?;
                    }
                    at_command_pos = true;
                    current_cmd.clear();
                    expect_write_target = false;
                    expect_read_target = false;
                    expect_subshell_script = false;
                    expect_interpreter_script = false;
                    saw_cd_arg = false;
                }
            }
            ShellToken::Word {
                text,
                quoted,
                expandable,
            } => {
                if *expandable {
                    for nested in extract_embedded_command_substitutions(text) {
                        validate_native_shell_command_text(&nested, base_dir, ctx, depth + 1)?;
                    }
                }
                if expect_write_target {
                    expect_write_target = false;
                    if !text.starts_with('&') {
                        validate_shell_path_token(text, base_dir, ctx, true, false)?;
                    }
                    continue;
                }
                if expect_read_target {
                    expect_read_target = false;
                    validate_shell_path_token(text, base_dir, ctx, false, false)?;
                    continue;
                }
                if expect_subshell_script {
                    expect_subshell_script = false;
                    validate_native_shell_command_text(text, base_dir, ctx, depth + 1)?;
                    continue;
                }
                if expect_interpreter_script {
                    expect_interpreter_script = false;
                    validate_inline_script_paths(text, base_dir, ctx)?;
                    continue;
                }

                if at_command_pos {
                    // Skip leading `ENV=VAL` assignments while validating path-like values.
                    if !quoted
                        && let Some((lhs, rhs)) = text.split_once('=')
                        && !lhs.is_empty()
                        && lhs.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    {
                        if looks_like_filesystem_path(rhs) {
                            validate_shell_path_token(rhs, base_dir, ctx, false, false)?;
                        }
                        continue;
                    }
                    if looks_like_filesystem_path(text) {
                        validate_shell_path_token(text, base_dir, ctx, false, true)?;
                    }
                    let base = Path::new(text)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(text)
                        .to_ascii_lowercase();
                    current_cmd = base;
                    at_command_pos = false;
                    saw_cd_arg = false;
                    continue;
                }

                if current_cmd == "cd" {
                    saw_cd_arg = true;
                    if text == "-" {
                        assert_read_path_allowed(&ctx.homedir, ctx).map_err(|e| e.to_string())?;
                        continue;
                    }
                    validate_shell_path_token(text, base_dir, ctx, false, false)?;
                    continue;
                }

                if matches!(
                    current_cmd.as_str(),
                    "sh" | "bash"
                        | "zsh"
                        | "dash"
                        | "ksh"
                        | "fish"
                        | "pwsh"
                        | "powershell"
                        | "powershell.exe"
                ) && matches!(
                    text.to_ascii_lowercase().as_str(),
                    "-c" | "-lc" | "-ic" | "-command"
                ) {
                    expect_subshell_script = true;
                    continue;
                }

                if matches!(
                    current_cmd.as_str(),
                    "python" | "python3" | "node" | "bun" | "deno" | "ruby" | "perl" | "php"
                ) && matches!(text.as_str(), "-c" | "-e" | "--eval")
                {
                    expect_interpreter_script = true;
                    continue;
                }

                let is_mut = is_mutating_shell_command(&current_cmd);

                // Inspect `key=value` arguments (e.g. `of=/dev/sda`, `--file=/etc/passwd`, `file=@/etc/passwd`).
                if let Some((lhs, rhs)) = text.split_once('=') {
                    let rhs_clean = rhs.strip_prefix('@').unwrap_or(rhs);
                    if lhs.eq_ignore_ascii_case("of") {
                        validate_shell_path_token(rhs_clean, base_dir, ctx, true, false)?;
                        continue;
                    }
                    if looks_like_filesystem_path(rhs_clean) {
                        let req_write = is_mut
                            || matches!(
                                lhs.to_ascii_lowercase().as_str(),
                                "--output" | "--out" | "-o" | "--dest"
                            );
                        validate_shell_path_token(rhs_clean, base_dir, ctx, req_write, false)?;
                    }
                    continue;
                }

                // Inspect curl/wget `@path` file-upload arguments.
                let candidate = text.strip_prefix('@').unwrap_or(text);
                if looks_like_filesystem_path(candidate) {
                    let normalized = candidate.replace('\\', "/").to_ascii_lowercase();
                    let touches_protected_meta = normalized == ".git"
                        || normalized.starts_with(".git/")
                        || normalized.contains("/.git/")
                        || normalized.ends_with("/.git")
                        || normalized == ".cowork"
                        || normalized.starts_with(".cowork/")
                        || normalized.contains("/.cowork/")
                        || normalized.ends_with("/.cowork");
                    let require_write = is_mut && touches_protected_meta;
                    validate_shell_path_token(candidate, base_dir, ctx, require_write, false)?;
                }
            }
        }
    }

    if current_cmd == "cd" && !saw_cd_arg {
        assert_read_path_allowed(&ctx.homedir, ctx).map_err(|e| e.to_string())?;
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
