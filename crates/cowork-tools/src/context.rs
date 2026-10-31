use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{AgentConfig, ConfigError, ProviderName};
use cowork_inference::{ToolDefinition, ToolResultPart};
use cowork_mcp::WorkspaceMcpToolCache;
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxConfig, SandboxMode, SandboxPolicy, resolve_sandbox_policy,
    scratch_roots, tmp_scratch_roots,
};
use cowork_storage::{MemoryStore, SessionDb, SessionKind};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tokio::sync::watch;

use crate::memory::AdvancedMemoryStore;

pub const ASK_SKIP_TOKEN: &str = "[skipped]";

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("{0}")]
    InvalidArguments(String),
    #[error("{0}")]
    PathDenied(String),
    #[error("{0}")]
    Execution(String),
}

impl From<ConfigError> for ToolError {
    fn from(err: ConfigError) -> Self {
        Self::Execution(err.to_string())
    }
}

pub type ToolResult<T> = Result<T, ToolError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolExecutionPolicy {
    #[default]
    Sequential,
    ParallelRead,
}

#[derive(Debug, Clone)]
pub enum ToolOutput {
    Text(String),
    Json(Value),
    Content(Vec<ToolResultPart>),
}

impl ToolOutput {
    pub fn as_text(&self) -> Option<String> {
        match self {
            Self::Text(s) => Some(s.clone()),
            Self::Json(v) => serde_json::to_string_pretty(v).ok(),
            Self::Content(parts) => {
                let mut texts = Vec::new();
                for p in parts {
                    if let ToolResultPart::Text { text } = p {
                        texts.push(text.as_str());
                    }
                }
                if texts.is_empty() {
                    None
                } else {
                    Some(texts.join("\n"))
                }
            }
        }
    }

    pub fn to_json_value(&self) -> Value {
        match self {
            Self::Text(s) => Value::String(s.clone()),
            Self::Json(v) => v.clone(),
            Self::Content(parts) => json!({
                "parts": parts,
            }),
        }
    }

    pub fn to_tool_result_parts(&self) -> Vec<ToolResultPart> {
        match self {
            Self::Text(s) => vec![ToolResultPart::Text { text: s.clone() }],
            Self::Json(v) => vec![ToolResultPart::Text {
                text: serde_json::to_string(v).unwrap_or_else(|_| v.to_string()),
            }],
            Self::Content(parts) => parts.clone(),
        }
    }

    pub fn contains_media(&self) -> bool {
        matches!(self, Self::Content(parts) if parts.iter().any(|p| matches!(p, ToolResultPart::Media { .. })))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecisionRequest {
    pub command: String,
    pub reason: String,
    pub category: Option<String>,
    pub detail: Option<String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredUserQuestion {
    pub id: String,
    pub header: Option<String>,
    pub question: String,
    pub options: Option<Vec<StructuredQuestionOption>>,
    pub is_other: bool,
    pub is_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredQuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[async_trait]
pub trait ApprovalHandler: Send + Sync {
    async fn approve_command(&self, req: ApprovalDecisionRequest) -> Result<bool, String>;

    async fn approve_file_change(&self, path: &Path, reason: Option<&str>) -> Result<bool, String> {
        let _ = (path, reason);
        Ok(true)
    }

    async fn ask_user(
        &self,
        question: &str,
        options: Option<Vec<String>>,
    ) -> Result<String, String>;

    async fn ask_user_structured(
        &self,
        questions: Vec<StructuredUserQuestion>,
    ) -> Result<BTreeMap<String, String>, String> {
        let mut answers = BTreeMap::new();
        for q in questions {
            let opt_labels = q
                .options
                .as_ref()
                .map(|opts| opts.iter().map(|o| o.label.clone()).collect());
            let ans = self.ask_user(&q.question, opt_labels).await?;
            answers.insert(q.id, ans);
        }
        Ok(answers)
    }
}

#[async_trait]
pub trait ThreadControlBridge: Send + Sync {
    async fn list_projects(&self) -> Result<Value, String>;
    async fn list_threads(&self, args: Value) -> Result<Value, String>;
    async fn read_thread(&self, args: Value) -> Result<Value, String>;
    async fn create_thread(&self, args: Value) -> Result<Value, String>;
    async fn send_message_to_thread(&self, args: Value) -> Result<Value, String>;
    async fn fork_thread(&self, args: Value) -> Result<Value, String>;
    async fn set_thread_title(&self, args: Value) -> Result<Value, String>;
    async fn set_thread_pinned(&self, args: Value) -> Result<Value, String>;
    async fn set_thread_archived(&self, args: Value) -> Result<Value, String>;
}

#[async_trait]
pub trait AgentControlBridge: Send + Sync {
    async fn spawn_agent(&self, parent_session_id: &str, args: Value) -> Result<Value, String>;
    async fn list_agents(&self, parent_session_id: &str, args: Value) -> Result<Value, String>;
    async fn send_agent_input(&self, parent_session_id: &str, args: Value)
    -> Result<Value, String>;
    async fn wait_for_agent(&self, parent_session_id: &str, args: Value) -> Result<Value, String>;
    async fn inspect_agent(&self, parent_session_id: &str, args: Value) -> Result<Value, String>;
    async fn resume_agent(&self, parent_session_id: &str, args: Value) -> Result<Value, String>;
    async fn close_agent(&self, parent_session_id: &str, args: Value) -> Result<Value, String>;
}

pub type DnsOverrideFn =
    Arc<dyn Fn(&str, u16) -> Result<(Vec<IpAddr>, Option<SocketAddr>), String> + Send + Sync>;

pub type TodosUpdatedCallback = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

#[derive(Clone)]
pub struct ToolExecutionContext {
    pub session_id: String,
    pub session_kind: SessionKind,
    pub homedir: PathBuf,
    pub cowork_home: PathBuf,
    pub working_directory: PathBuf,
    pub output_directory: PathBuf,
    pub uploads_directory: PathBuf,
    pub lock_root: PathBuf,
    pub env: HashMap<String, String>,
    pub provider: ProviderName,
    pub model: String,
    pub provider_options: Map<String, Value>,
    pub sandbox_config: SandboxConfig,
    pub sandbox_policy: SandboxPolicy,
    pub read_roots: Vec<PathBuf>,
    pub yolo: bool,
    pub read_only_role: bool,
    pub target_paths: Option<Vec<PathBuf>>,
    pub advanced_memory: bool,
    pub bundled_skills_dir: Option<PathBuf>,
    pub approval_handler: Option<Arc<dyn ApprovalHandler>>,
    pub thread_control: Option<Arc<dyn ThreadControlBridge>>,
    pub agent_control: Option<Arc<dyn AgentControlBridge>>,
    pub agent_config: Option<Arc<AgentConfig>>,
    pub mcp_tool_cache: Option<Arc<WorkspaceMcpToolCache>>,
    pub can_ask_user: bool,
    pub allowed_builtin_tools: Option<BTreeSet<String>>,
    pub allowed_mcp_servers: Option<BTreeSet<String>>,
    pub allowed_skill_names: Option<BTreeSet<String>>,
    pub session_db: Option<Arc<SessionDb>>,
    pub memory_store: Option<Arc<MemoryStore>>,
    pub advanced_memory_store: Option<Arc<AdvancedMemoryStore>>,
    pub on_todos_updated: Option<TodosUpdatedCallback>,
    pub cancel_rx: Option<watch::Receiver<bool>>,
    pub dns_override_for_tests: Option<DnsOverrideFn>,
}

impl ToolExecutionContext {
    pub fn new_for_tests(
        homedir: PathBuf,
        working_directory: PathBuf,
        provider: ProviderName,
        model: impl Into<String>,
    ) -> Self {
        let cowork_home = homedir.join(".cowork");
        let output_directory = working_directory.join("output");
        let uploads_directory = working_directory.join("uploads");
        let lock_root = cowork_home.join("locks").join("files");
        let sandbox_config = SandboxConfig::default();
        let sandbox_policy = resolve_sandbox_policy(&ResolveSandboxPolicyInput {
            config: Some(sandbox_config.clone()),
            working_directory: working_directory.clone(),
            project_root: Some(working_directory.clone()),
            output_directory: Some(output_directory.clone()),
            uploads_directory: Some(uploads_directory.clone()),
            tool_runtime_writable_roots: Vec::new(),
            target_paths: None,
            read_only_role: false,
            yolo: false,
            platform: None,
        });
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), homedir.to_string_lossy().into_owned());
        env.insert(
            "PATH".to_owned(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
        );

        Self {
            session_id: "test-session".to_owned(),
            session_kind: SessionKind::Root,
            homedir,
            cowork_home,
            working_directory,
            output_directory,
            uploads_directory,
            lock_root,
            env,
            provider,
            model: model.into(),
            provider_options: Map::new(),
            sandbox_config,
            sandbox_policy,
            read_roots: Vec::new(),
            yolo: false,
            read_only_role: false,
            target_paths: None,
            advanced_memory: false,
            bundled_skills_dir: None,
            approval_handler: None,
            thread_control: None,
            agent_control: None,
            agent_config: None,
            mcp_tool_cache: None,
            can_ask_user: true,
            allowed_builtin_tools: None,
            allowed_mcp_servers: None,
            allowed_skill_names: None,
            session_db: None,
            memory_store: None,
            advanced_memory_store: None,
            on_todos_updated: None,
            cancel_rx: None,
            dns_override_for_tests: None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_rx.as_ref().is_some_and(|rx| *rx.borrow())
    }
}

#[async_trait]
pub trait BuiltinTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> Value;
    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::Sequential
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_owned(),
            description: self.description().to_owned(),
            parameters: self.input_schema(),
        }
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput>;
}

/// Strip `null` values on optional object properties so models emitting `null`
/// for optional parameters fall back to defaults instead of failing schema validation.
pub fn normalize_and_validate_args(
    schema: &Value,
    raw_args: &Map<String, Value>,
) -> ToolResult<Map<String, Value>> {
    let mut value = Value::Object(raw_args.clone());
    strip_null_optional_properties(schema, &mut value);
    let validator = jsonschema::validator_for(schema)
        .map_err(|e| ToolError::InvalidArguments(format!("invalid tool schema: {e}")))?;
    if let Err(err) = validator.validate(&value) {
        return Err(ToolError::InvalidArguments(format!(
            "Invalid tool arguments: {err}"
        )));
    }
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(ToolError::InvalidArguments(
            "Tool arguments must be a JSON object".to_owned(),
        )),
    }
}

fn strip_null_optional_properties(schema: &Value, value: &mut Value) {
    let (Some(props), Some(obj)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object_mut(),
    ) else {
        return;
    };

    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys {
        let is_required = required.contains(&key.as_str());
        if let Some(prop_schema) = props.get(&key) {
            let allows_null = prop_schema.get("type").is_some_and(|t| {
                t == "null" || t.as_array().is_some_and(|a| a.iter().any(|x| x == "null"))
            });
            if obj.get(&key).is_some_and(Value::is_null) && !is_required && !allows_null {
                obj.remove(&key);
                continue;
            }
            if let Some(child) = obj.get_mut(&key) {
                strip_null_optional_properties(prop_schema, child);
            }
        }
    }
}

pub fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalize existing ancestor + join remaining leaf components so symlinks
/// (like `/tmp` -> `/private/tmp` on macOS) cannot bypass boundary checks.
pub fn canonicalize_with_missing_tail(path: &Path) -> PathBuf {
    let normalized = normalize_lexical_path(path);
    let mut cursor = normalized.as_path();
    let mut tail = Vec::new();
    loop {
        if let Ok(canon) = fs::canonicalize(cursor) {
            let mut result = canon;
            for part in tail.into_iter().rev() {
                result.push(part);
            }
            return result;
        }
        if let Some(name) = cursor.file_name() {
            tail.push(name.to_os_string());
        }
        match cursor.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => cursor = parent,
            _ => return normalized,
        }
    }
}

pub fn resolve_tool_path(raw: &str, working_directory: &Path) -> ToolResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidArguments(
            "filePath must not be empty".to_owned(),
        ));
    }
    let candidate = Path::new(trimmed);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        working_directory.join(candidate)
    };
    Ok(canonicalize_with_missing_tail(&joined))
}

fn is_within(path: &Path, root: &Path) -> bool {
    let canon_root = canonicalize_with_missing_tail(root);
    path == canon_root || path.starts_with(&canon_root)
}

fn is_protected_credential_path(path: &Path, ctx: &ToolExecutionContext) -> bool {
    let auth_dir = canonicalize_with_missing_tail(&ctx.cowork_home.join("auth"));
    if is_within(path, &auth_dir) {
        return true;
    }
    for dir_name in [".ssh", ".aws", ".gnupg", ".kube", ".azure"] {
        let cred = canonicalize_with_missing_tail(&ctx.homedir.join(dir_name));
        if is_within(path, &cred) {
            return true;
        }
    }
    false
}

fn has_git_or_cowork_segment(path: &Path, working_directory: &Path) -> Option<&'static str> {
    let ws = canonicalize_with_missing_tail(working_directory);
    let rel = path.strip_prefix(&ws).unwrap_or(path);
    for comp in rel.components() {
        if let Component::Normal(os) = comp {
            let s = os.to_string_lossy();
            if s.eq_ignore_ascii_case(".git") {
                return Some(".git");
            }
            if s.eq_ignore_ascii_case(".cowork") {
                return Some(".cowork");
            }
        }
    }
    None
}

pub fn assert_read_path_allowed(path: &Path, ctx: &ToolExecutionContext) -> ToolResult<PathBuf> {
    let resolved = canonicalize_with_missing_tail(path);
    if is_protected_credential_path(&resolved, ctx) {
        return Err(ToolError::PathDenied(format!(
            "Access to protected credential path is blocked: {}",
            resolved.display()
        )));
    }

    if let Some(targets) = &ctx.target_paths
        && !targets.is_empty()
    {
        let scratchpad = canonicalize_with_missing_tail(
            &ctx.working_directory
                .join(".cowork")
                .join(".cowork-scratchpad"),
        );
        let in_project_roots = is_within(&resolved, &ctx.working_directory)
            || is_within(&resolved, &ctx.output_directory)
            || is_within(&resolved, &ctx.uploads_directory);
        let in_external_read_root = ctx.read_roots.iter().any(|r| is_within(&resolved, r));
        // `projectPathsOnly: true`: `targetPaths` confines reads within workspace/project roots,
        // while external `read_roots` (such as bundled/user skills) remain readable.
        if (in_project_roots || !in_external_read_root)
            && !is_within(&resolved, &scratchpad)
            && !targets.iter().any(|t| is_within(&resolved, t))
        {
            return Err(ToolError::PathDenied(format!(
                "Path '{}' is outside assigned targetPaths scope.",
                resolved.display()
            )));
        }
    }

    if !ctx.read_roots.is_empty() && !ctx.yolo {
        let scratchpad = canonicalize_with_missing_tail(
            &ctx.working_directory
                .join(".cowork")
                .join(".cowork-scratchpad"),
        );
        let in_default = is_within(&resolved, &ctx.working_directory)
            || is_within(&resolved, &ctx.output_directory)
            || is_within(&resolved, &ctx.uploads_directory)
            || is_within(&resolved, &scratchpad);
        let in_extra = ctx.read_roots.iter().any(|r| is_within(&resolved, r));
        if !in_default && !in_extra {
            return Err(ToolError::PathDenied(format!(
                "Read access outside configured readRoots is blocked: {}",
                resolved.display()
            )));
        }
    }

    Ok(resolved)
}

pub fn assert_write_path_allowed(path: &Path, ctx: &ToolExecutionContext) -> ToolResult<PathBuf> {
    let resolved = canonicalize_with_missing_tail(path);
    if is_protected_credential_path(&resolved, ctx) {
        return Err(ToolError::PathDenied(format!(
            "Write access to protected credential path is blocked: {}",
            resolved.display()
        )));
    }
    if let Some(protected) = has_git_or_cowork_segment(&resolved, &ctx.working_directory) {
        return Err(ToolError::PathDenied(format!(
            "Write access to protected '{protected}' directory is blocked: {}",
            resolved.display()
        )));
    }
    if is_within(&resolved, &ctx.cowork_home) {
        return Err(ToolError::PathDenied(format!(
            "Write access to protected Cowork state directory is blocked: {}",
            resolved.display()
        )));
    }

    if ctx.read_only_role || matches!(ctx.sandbox_policy, SandboxPolicy::ReadOnly { .. }) {
        return Err(ToolError::PathDenied(
            "File writes are blocked because this session is running in read-only mode.".to_owned(),
        ));
    }

    if let Some(targets) = &ctx.target_paths
        && !targets.is_empty()
    {
        let allowed = targets.iter().any(|t| is_within(&resolved, t));
        if !allowed {
            return Err(ToolError::PathDenied(format!(
                "Write to '{}' is blocked: outside assigned targetPaths scope.",
                resolved.display()
            )));
        }
    }

    match &ctx.sandbox_policy {
        SandboxPolicy::DangerFullAccess { .. } => Ok(resolved),
        SandboxPolicy::ReadOnly { .. } => Err(ToolError::PathDenied(
            "File writes are blocked in read-only sandbox policy.".to_owned(),
        )),
        SandboxPolicy::NoProjectWrite { project_roots, .. } => {
            let blocked_in_proj = project_roots.iter().any(|r| is_within(&resolved, r));
            let base_scratch = scratch_roots(None);
            let in_tmp = tmp_scratch_roots(project_roots, &base_scratch)
                .iter()
                .any(|r| is_within(&resolved, r));
            if !blocked_in_proj && in_tmp {
                Ok(resolved)
            } else {
                Err(ToolError::PathDenied(format!(
                    "Write to '{}' is blocked by no-project-write policy.",
                    resolved.display()
                )))
            }
        }
        SandboxPolicy::WorkspaceWrite { writable_roots, .. } => {
            let allowed = writable_roots.iter().any(|r| is_within(&resolved, r))
                || is_within(&resolved, &ctx.working_directory)
                || is_within(&resolved, &ctx.output_directory)
                || is_within(&resolved, &ctx.uploads_directory);
            if allowed {
                Ok(resolved)
            } else {
                Err(ToolError::PathDenied(format!(
                    "Write to '{}' is blocked: outside writable workspace roots.",
                    resolved.display()
                )))
            }
        }
    }
}

pub fn create_read_path_checker(
    ctx: &ToolExecutionContext,
) -> impl Fn(&Path) -> bool + Send + Sync + use<> {
    let ctx_clone = ctx.clone();
    move |path: &Path| assert_read_path_allowed(path, &ctx_clone).is_ok()
}

pub fn effective_sandbox_mode(ctx: &ToolExecutionContext) -> SandboxMode {
    ctx.sandbox_policy.mode()
}
