use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, LexicalPath, PathFlavor, ToolError, ToolExecutionContext, ToolExecutionPolicy,
    ToolOutput, ToolResult, canonicalize_with_missing_tail, check_lexical_containment,
    normalize_and_validate_args, normalize_lexical_path, resolve_lexically,
};

pub const VALID_AGENT_ROLES: &[&str] = &["default", "explorer", "research", "worker", "reviewer"];
pub const VALID_CONTEXT_MODES: &[&str] = &["none", "brief", "full"];

/// Validates and canonicalizes `targetPaths` for `spawnAgent`.
///
/// Rejects:
/// - Empty array `[]` (must omit `targetPaths` for whole-workspace scope)
/// - Empty/whitespace strings
/// - Paths escaping `working_directory` (including via symlinks)
/// - Paths inside `.git` or `.cowork`
///
/// TS `resolveUsableTargetPath` order: each entry is resolved against the workspace and
/// gated purely lexically first, so an out-of-workspace target (UNC `\\host\share`, device,
/// verbatim, another drive, `../` escape, foreign absolute path) is rejected without ever
/// reaching the filesystem (on Windows, resolving a UNC path makes the host authenticate to
/// that server over SMB, outside any child sandbox). Only then is the target canonicalized and
/// re-checked, which rejects in-workspace symlinks whose real target escapes.
pub fn validate_and_resolve_target_paths(
    working_directory: &Path,
    raw_paths: &[String],
) -> ToolResult<Vec<PathBuf>> {
    validate_and_resolve_target_paths_with(
        working_directory,
        raw_paths,
        PathFlavor::host(),
        &canonicalize_with_missing_tail,
    )
}

/// [`validate_and_resolve_target_paths`] with the path flavor and canonicalization injected,
/// so tests can parse Windows paths on any host and prove a rejected target never reaches the
/// filesystem.
fn validate_and_resolve_target_paths_with(
    working_directory: &Path,
    raw_paths: &[String],
    flavor: PathFlavor,
    canonicalize: &dyn Fn(&Path) -> PathBuf,
) -> ToolResult<Vec<PathBuf>> {
    if raw_paths.is_empty() {
        return Err(ToolError::InvalidArguments(
            "spawnAgent targetPaths must not be empty; omit it for whole-workspace scope."
                .to_owned(),
        ));
    }

    // The workspace is trusted configuration, so resolving it is safe.
    let ws_lexical = normalize_lexical_path(working_directory)
        .to_string_lossy()
        .into_owned();
    let ws_canon = canonicalize(working_directory)
        .to_string_lossy()
        .into_owned();
    let ws_spellings = [ws_lexical.as_str(), ws_canon.as_str()];
    let mut invalid = Vec::new();
    let mut resolved_out: Vec<PathBuf> = Vec::with_capacity(raw_paths.len());

    for raw in raw_paths {
        let trimmed = raw.trim();
        let usable = if trimmed.is_empty() {
            None
        } else {
            resolve_usable_target_path(&ws_lexical, &ws_spellings, trimmed, flavor, canonicalize)
        };
        match usable {
            Some(canon) if !resolved_out.contains(&canon) => resolved_out.push(canon),
            Some(_) => {}
            None => invalid.push(raw.clone()),
        }
    }

    if !invalid.is_empty() {
        return Err(ToolError::InvalidArguments(format!(
            "spawnAgent targetPaths must be inside the workspace and outside .git/.cowork; invalid: {}",
            invalid.join(", ")
        )));
    }

    Ok(resolved_out)
}

/// TS `resolveUsableTargetPath`: the canonical target when `raw` stays inside the workspace and
/// outside `.git`/`.cowork` both lexically and after resolving symlinks, else `None`.
fn resolve_usable_target_path(
    ws_lexical: &str,
    ws_spellings: &[&str],
    raw: &str,
    flavor: PathFlavor,
    canonicalize: &dyn Fn(&Path) -> PathBuf,
) -> Option<PathBuf> {
    // 1. Lexical: nothing here touches the filesystem for the target.
    let lexical = resolve_lexically(ws_lexical, raw, flavor);
    if !inside_and_unprotected(&lexical, ws_spellings, flavor) {
        return None;
    }
    // 2. Canonical: an in-workspace symlink whose real target escapes is rejected.
    let canon = canonicalize(Path::new(&lexical));
    inside_and_unprotected(&canon.to_string_lossy(), &ws_spellings[1..], flavor).then_some(canon)
}

/// Whether `target` is inside one of `roots` (see [`check_lexical_containment`]) without
/// crossing a `.git`/`.cowork` directory below that root.
fn inside_and_unprotected(target: &str, roots: &[&str], flavor: PathFlavor) -> bool {
    if check_lexical_containment(target, roots, flavor).is_err() {
        return false;
    }
    let target = LexicalPath::parse(target, flavor);
    !roots.iter().any(|root| {
        target
            .segments_below(&LexicalPath::parse(root, flavor))
            .is_some_and(|rel| {
                rel.iter().any(|seg| {
                    seg.eq_ignore_ascii_case(".git") || seg.eq_ignore_ascii_case(".cowork")
                })
            })
    })
}

pub fn resolve_context_mode_and_briefing(
    context_mode: Option<&str>,
    briefing: Option<&str>,
    fork_context: Option<bool>,
) -> ToolResult<(String, Option<String>)> {
    let mode = match context_mode {
        Some(m) => {
            let trimmed = m.trim();
            if !VALID_CONTEXT_MODES.contains(&trimmed) {
                return Err(ToolError::InvalidArguments(format!(
                    "Invalid contextMode '{trimmed}'; expected 'none', 'brief', or 'full'."
                )));
            }
            if fork_context == Some(true) && trimmed != "full" {
                return Err(ToolError::InvalidArguments(
                    "forkContext=true conflicts with contextMode!='full'.".to_owned(),
                ));
            }
            trimmed.to_owned()
        }
        None => {
            if fork_context == Some(true) {
                "full".to_owned()
            } else {
                "none".to_owned()
            }
        }
    };

    let clean_briefing = briefing
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if mode == "brief" && clean_briefing.is_none() {
        return Err(ToolError::InvalidArguments(
            "spawnAgent requires a non-empty 'briefing' when contextMode is 'brief'.".to_owned(),
        ));
    }

    Ok((mode, clean_briefing))
}

pub fn all_subagent_tools() -> Vec<Arc<dyn BuiltinTool>> {
    vec![
        Arc::new(SpawnAgentTool),
        Arc::new(ListAgentsTool),
        Arc::new(SendAgentInputTool),
        Arc::new(WaitForAgentTool),
        Arc::new(InspectAgentTool),
        Arc::new(ResumeAgentTool),
        Arc::new(CloseAgentTool),
    ]
}

// ============================================================================
// 1. spawnAgent
// ============================================================================

pub struct SpawnAgentTool;

#[async_trait]
impl BuiltinTool for SpawnAgentTool {
    fn name(&self) -> &str {
        "spawnAgent"
    }

    fn description(&self) -> &str {
        "Spawn a collaborative child agent for a well-scoped task. Supports contextMode ('none' | 'brief' | 'full'), targetPaths confinement (which withholds bash), built-in roles, custom profileRef, and model overrides."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "minLength": 1, "maxLength": 20000 },
                "role": {
                    "type": "string",
                    "enum": ["default", "explorer", "research", "worker", "reviewer"]
                },
                "profileRef": { "type": "string" },
                "model": { "type": "string" },
                "reasoningEffort": {
                    "type": "string",
                    "enum": ["none", "minimal", "light", "low", "medium", "high", "xhigh", "max"]
                },
                "nickname": { "type": "string" },
                "taskType": { "type": "string" },
                "targetPaths": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "contextMode": {
                    "type": "string",
                    "enum": ["none", "brief", "full"]
                },
                "briefing": { "type": "string", "maxLength": 20000 },
                "includeParentTodos": { "type": "boolean" },
                "includeHarnessContext": { "type": "boolean" },
                "forkContext": { "type": "boolean" }
            },
            "required": ["message"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "spawnAgent is blocked in read-only mode.".to_owned(),
            ));
        }
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let mut args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;

        let message = args
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidArguments("spawnAgent message must not be empty".to_owned())
            })?
            .to_owned();
        args.insert("message".to_owned(), Value::String(message));

        if let Some(nick_val) = args.get("nickname") {
            let nick = nick_val.as_str().unwrap_or("").trim().to_owned();
            if nick.is_empty() {
                return Err(ToolError::InvalidArguments(
                    "spawnAgent nickname must not be empty".to_owned(),
                ));
            }
            args.insert("nickname".to_owned(), Value::String(nick));
        }

        if let Some(tp_val) = args.get("targetPaths") {
            let raw_list: Vec<String> = tp_val
                .as_array()
                .ok_or_else(|| {
                    ToolError::InvalidArguments("targetPaths must be an array".to_owned())
                })?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_owned())
                .collect();
            let resolved = validate_and_resolve_target_paths(&ctx.working_directory, &raw_list)?;
            let as_strings: Vec<Value> = resolved
                .into_iter()
                .map(|p| Value::String(p.to_string_lossy().into_owned()))
                .collect();
            args.insert("targetPaths".to_owned(), Value::Array(as_strings));
        }

        let (mode, briefing) = resolve_context_mode_and_briefing(
            args.get("contextMode").and_then(Value::as_str),
            args.get("briefing").and_then(Value::as_str),
            args.get("forkContext").and_then(Value::as_bool),
        )?;
        args.insert("contextMode".to_owned(), Value::String(mode));
        if let Some(b) = briefing {
            args.insert("briefing".to_owned(), Value::String(b));
        }

        let res = bridge
            .spawn_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 2. listAgents
// ============================================================================

pub struct ListAgentsTool;

#[async_trait]
impl BuiltinTool for ListAgentsTool {
    fn name(&self) -> &str {
        "listAgents"
    }

    fn description(&self) -> &str {
        "List collaborative child agents for the current parent session."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let _ = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .list_agents(&ctx.session_id, json!({}))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 3. sendAgentInput
// ============================================================================

pub struct SendAgentInputTool;

#[async_trait]
impl BuiltinTool for SendAgentInputTool {
    fn name(&self) -> &str {
        "sendAgentInput"
    }

    fn description(&self) -> &str {
        "Send a follow-up message to an existing child agent. Set interrupt=true to steer/interrupt an in-flight turn immediately."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 },
                "message": { "type": "string", "minLength": 1, "maxLength": 20000 },
                "interrupt": { "type": "boolean" }
            },
            "required": ["agentId", "message"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "sendAgentInput is blocked in read-only mode.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .send_agent_input(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 4. waitForAgent
// ============================================================================

pub struct WaitForAgentTool;

#[async_trait]
impl BuiltinTool for WaitForAgentTool {
    fn name(&self) -> &str {
        "waitForAgent"
    }

    fn description(&self) -> &str {
        "Wait for one or more child agents to reach terminal states ('any' or 'all'). Set includeFinalMessage=true and/or includeReport=true to retrieve full output and parsed <agent_report>."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentIds": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": "string", "minLength": 1 }
                },
                "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 300000 },
                "mode": { "type": "string", "enum": ["any", "all"] },
                "includeFinalMessage": { "type": "boolean" },
                "includeReport": { "type": "boolean" }
            },
            "required": ["agentIds"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .wait_for_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 5. inspectAgent
// ============================================================================

pub struct InspectAgentTool;

#[async_trait]
impl BuiltinTool for InspectAgentTool {
    fn name(&self) -> &str {
        "inspectAgent"
    }

    fn description(&self) -> &str {
        "Read the latest detailed result for a child agent, including full assistant text and parsed <agent_report>."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 }
            },
            "required": ["agentId"]
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .inspect_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 6. resumeAgent
// ============================================================================

pub struct ResumeAgentTool;

#[async_trait]
impl BuiltinTool for ResumeAgentTool {
    fn name(&self) -> &str {
        "resumeAgent"
    }

    fn description(&self) -> &str {
        "Resume a previously closed child agent by id so it can receive new input and waits."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 }
            },
            "required": ["agentId"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "resumeAgent is blocked in read-only mode.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .resume_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 7. closeAgent
// ============================================================================

pub struct CloseAgentTool;

#[async_trait]
impl BuiltinTool for CloseAgentTool {
    fn name(&self) -> &str {
        "closeAgent"
    }

    fn description(&self) -> &str {
        "Close a child agent when it is no longer needed and return its last known status."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 }
            },
            "required": ["agentId"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "closeAgent is blocked in read-only mode.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .close_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

#[cfg(test)]
mod target_path_tests {
    use std::fs;
    use std::sync::{Arc, Mutex};

    use super::*;

    type Calls = Arc<Mutex<Vec<PathBuf>>>;

    /// Records every path handed to canonicalization, then delegates to `inner`.
    fn recording(inner: impl Fn(&Path) -> PathBuf) -> (Calls, impl Fn(&Path) -> PathBuf) {
        let calls = Calls::default();
        let sink = Arc::clone(&calls);
        let canon = move |p: &Path| {
            sink.lock().unwrap().push(p.to_path_buf());
            inner(p)
        };
        (calls, canon)
    }

    fn validate(
        ws: &Path,
        raw: &[&str],
        flavor: PathFlavor,
        canonicalize: &dyn Fn(&Path) -> PathBuf,
    ) -> ToolResult<Vec<PathBuf>> {
        let raw: Vec<String> = raw.iter().map(|s| (*s).to_owned()).collect();
        validate_and_resolve_target_paths_with(ws, &raw, flavor, canonicalize)
    }

    fn assert_rejected_before_canonicalize(
        ws: &Path,
        raw: &str,
        flavor: PathFlavor,
        inner: impl Fn(&Path) -> PathBuf,
    ) {
        let (calls, canon) = recording(inner);
        let err = validate(ws, &[raw], flavor, &canon)
            .expect_err(raw)
            .to_string();
        assert!(
            err.contains(
                "spawnAgent targetPaths must be inside the workspace and outside .git/.cowork; invalid: "
            ) && err.ends_with(raw),
            "{raw}: {err}"
        );
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            [ws.to_path_buf()],
            "{raw} reached canonicalize (only the workspace may)"
        );
    }

    #[test]
    fn windows_out_of_workspace_targets_never_reach_canonicalize() {
        let ws = Path::new(r"C:\ws");
        for raw in [
            r"\\attacker.example\share\x",
            "//attacker.example/share/x",
            r"\\?\UNC\attacker.example\share\x",
            r"\??\UNC\attacker.example\share\x",
            r"\\.\pipe\attacker",
            r"\\.\UNC\attacker.example\share\x",
            r"\\?\GLOBALROOT\Device\Mup\attacker.example\share\x",
            r"\\?\D:\other",
            r"D:\other",
            r"D:other",
            r"C:\other\x",
            r"\other",
            r"..\escape",
            r"src\..\..\escape",
            r"C:\ws-sibling",
            r".git\hooks",
            r"src\.COWORK\auth",
        ] {
            assert_rejected_before_canonicalize(ws, raw, PathFlavor::Windows, |p: &Path| {
                p.to_path_buf()
            });
        }
    }

    #[test]
    fn windows_in_workspace_targets_are_accepted() {
        let ws = Path::new(r"C:\ws");
        let (calls, canon) = recording(|p: &Path| p.to_path_buf());
        let resolved = validate(
            ws,
            &[
                r"src\a",
                r"C:\ws\lib",
                "c:/WS/docs",
                r"\ws\tests",
                r"C:bin",
                r"\\?\C:\ws\pkg",
                r"src\..\README.md",
            ],
            PathFlavor::Windows,
            &canon,
        )
        .unwrap();
        let expected: Vec<PathBuf> = [
            r"C:\ws\src\a",
            r"C:\ws\lib",
            "c:/WS/docs",
            r"C:\ws\tests",
            r"C:\ws\bin",
            r"\\?\C:\ws\pkg",
            r"C:\ws\src\..\README.md",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(resolved, expected);
        assert_eq!(calls.lock().unwrap().len(), 1 + expected.len());
    }

    #[test]
    fn posix_out_of_workspace_targets_never_reach_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ws = root.join("ws");
        fs::create_dir_all(ws.join("src")).unwrap();
        let outside = root.join("outside").join("x");
        let sibling = root.join("ws-sibling");
        for raw in [
            "../escape",
            "src/../../escape",
            outside.to_str().unwrap(),
            sibling.to_str().unwrap(),
            "/net/attacker.example/share/x",
            "/Network/Servers/attacker.example/x",
            ".git/hooks",
            "src/.cowork/auth",
        ] {
            assert_rejected_before_canonicalize(
                &ws,
                raw,
                PathFlavor::Posix,
                canonicalize_with_missing_tail,
            );
        }
    }

    #[test]
    fn posix_in_workspace_targets_are_canonicalized() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(ws.join("src")).unwrap();
        let abs = ws.join("src");
        let resolved = validate_and_resolve_target_paths(
            &ws,
            &[
                "src".to_owned(),
                abs.to_string_lossy().into_owned(),
                "./src/new/file.rs".to_owned(),
            ],
        )
        .unwrap();
        assert_eq!(resolved, vec![abs.clone(), abs.join("new").join("file.rs")]);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escapes_are_rejected_after_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ws = root.join("ws");
        let outside = root.join("outside");
        fs::create_dir_all(ws.join(".git").join("hooks")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("escape")).unwrap();
        std::os::unix::fs::symlink(ws.join(".git"), ws.join("gitlink")).unwrap();
        for raw in ["escape", "escape/new.rs", "gitlink/hooks"] {
            let err = validate_and_resolve_target_paths(&ws, &[raw.to_owned()])
                .expect_err(raw)
                .to_string();
            assert!(err.ends_with(&format!("invalid: {raw}")), "{raw}: {err}");
        }
    }
}
