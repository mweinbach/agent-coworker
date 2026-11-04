use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use cowork_config::{AgentConfig, ConfigError, ProviderName};
use cowork_inference::{ToolDefinition, ToolResultPart};
use cowork_mcp::WorkspaceMcpToolCache;
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxConfig, SandboxMode, SandboxPolicy, resolve_sandbox_policy,
    scratch_roots, tmp_scratch_roots,
};
use cowork_storage::{
    MemoryStore, SessionDb, SessionKind, TaskContextSnapshot, TaskCreationResult, TaskDirective,
    TaskDirectiveResult, TaskReviewMaterialReference, ValidatedTaskCreationInput,
};
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

#[async_trait]
pub trait TaskToolBridge: Send + Sync {
    fn get_task_context(&self, session_id: &str) -> Option<TaskContextSnapshot>;
    async fn get_task_review_material(
        &self,
        session_id: &str,
    ) -> Result<TaskReviewMaterialReference, String>;
    async fn apply_task_directive(
        &self,
        session_id: &str,
        directive: TaskDirective,
    ) -> Result<TaskDirectiveResult, String>;
    async fn create_task(
        &self,
        session_id: &str,
        input: ValidatedTaskCreationInput,
    ) -> Result<TaskCreationResult, String>;
}

pub type DnsOverrideFn =
    Arc<dyn Fn(&str, u16) -> Result<(Vec<IpAddr>, Option<SocketAddr>), String> + Send + Sync>;

pub type TodosUpdatedCallback = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

pub type WorkflowProgressCallback = Arc<dyn Fn(Value) + Send + Sync>;

pub type BeforeToolInvocationHook = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

pub trait CostTrackerBridge: Send + Sync {
    fn get_budget_status(&self) -> cowork_inference::BudgetStatus;
    fn record_unattributed_cost(&self, usd_cost: f64) -> Result<(), String>;
}

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
    pub built_in_dir: Option<PathBuf>,
    pub approval_handler: Option<Arc<dyn ApprovalHandler>>,
    pub thread_control: Option<Arc<dyn ThreadControlBridge>>,
    pub agent_control: Option<Arc<dyn AgentControlBridge>>,
    pub task_bridge: Option<Arc<dyn TaskToolBridge>>,
    pub in_task_context: bool,
    pub stop_after_step: Arc<AtomicBool>,
    pub before_tool_invocation: Option<BeforeToolInvocationHook>,
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
    pub on_workflow_progress: Option<WorkflowProgressCallback>,
    pub cost_tracker_bridge: Option<Arc<dyn CostTrackerBridge>>,
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
            built_in_dir: None,
            approval_handler: None,
            thread_control: None,
            agent_control: None,
            task_bridge: None,
            in_task_context: false,
            stop_after_step: Arc::new(AtomicBool::new(false)),
            before_tool_invocation: None,
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
            on_workflow_progress: None,
            cost_tracker_bridge: None,
            cancel_rx: None,
            dns_override_for_tests: None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_rx.as_ref().is_some_and(|rx| *rx.borrow())
    }

    pub fn request_stop_after_step(&self) {
        self.stop_after_step.store(true, Ordering::SeqCst);
    }

    pub fn should_stop_after_tool_step(&self) -> bool {
        self.stop_after_step.load(Ordering::SeqCst)
    }

    pub fn clear_stop_after_step(&self) {
        self.stop_after_step.store(false, Ordering::SeqCst);
    }

    pub fn check_before_tool_invocation(&self, tool_name: &str) -> ToolResult<()> {
        if let Some(ref hook) = self.before_tool_invocation {
            hook(tool_name).map_err(ToolError::Execution)?;
        }
        Ok(())
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

/// Joins a model-supplied path onto `working_directory` and normalizes `.`/`..` lexically,
/// WITHOUT resolving symlinks. Read checks take this form so the credential deny can match
/// the path as the model spelled it (e.g. `.cowork/auth/x` whose file is a symlink elsewhere)
/// as well as its canonical target; `assert_read_path_allowed` returns the canonical path.
pub fn lexical_tool_path(raw: &str, working_directory: &Path) -> ToolResult<PathBuf> {
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
    Ok(normalize_lexical_path(&joined))
}

/// Resolves a model-supplied path against `working_directory` purely lexically (TS
/// `path.resolve` parity). It deliberately does NOT touch the filesystem: canonicalizing an
/// unvetted path can itself leak (on Windows, `\\host\share\x` makes the OS open SMB/WebDAV
/// to `host` and send the user's NTLM response; on macOS `/net/<host>` triggers an automount).
/// `assert_write_path_allowed` / `assert_read_path_allowed` gate the path lexically against
/// the allowed roots first and only then resolve symlinks and re-check the canonical target.
pub fn resolve_tool_path(raw: &str, working_directory: &Path) -> ToolResult<PathBuf> {
    lexical_tool_path(raw, working_directory)
}

/// Path syntax the lexical containment gate parses. The gate never touches the filesystem, so
/// both flavors can be exercised on any host; production uses [`PathFlavor::host`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathFlavor {
    Posix,
    Windows,
}

impl PathFlavor {
    pub fn host() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Posix
        }
    }
}

/// Path forms that make the OS reach a remote host or a raw device as soon as the path is
/// opened or resolved. Such a path is rejected before any filesystem call unless it lies
/// lexically inside a configured root that is itself such a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecialPathKind {
    /// `\\server\share\...` (also `//server/share`, `\\?\UNC\server\share`): Windows contacts
    /// `server` over SMB/WebDAV and authenticates with the user's NTLM credentials.
    Unc,
    /// `\\.\name` Win32 device namespace (pipes, raw volumes, `\\.\UNC\...`).
    Device,
    /// `\\?\name` / `\??\name` verbatim paths other than a plain drive
    /// (`\\?\GLOBALROOT\...`, `\\?\Volume{...}`). `\\?\C:\x` is treated as `C:\x`.
    Verbatim,
    /// `/net/...` or `/Network/...` automount trees (macOS autofs, Linux `-hosts` maps).
    Automount,
}

/// A path parsed and normalized purely lexically (`.`/`..` collapsed, separators unified,
/// Windows verbatim-drive and verbatim-UNC spellings folded onto their plain forms, Windows
/// case folded). Never touches the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexicalPath {
    kind: Option<SpecialPathKind>,
    /// Root prefix: `/` (posix absolute), `c:\` (drive absolute), `c:` (drive-relative),
    /// `\` (current-drive rooted), `\\server\share`, `\\.\name`, `\\?\name`, or empty.
    prefix: String,
    segments: Vec<String>,
}

impl LexicalPath {
    pub fn parse(raw: &str, flavor: PathFlavor) -> Self {
        match flavor {
            PathFlavor::Posix => Self::parse_posix(raw),
            PathFlavor::Windows => Self::parse_windows(raw),
        }
    }

    pub fn kind(&self) -> Option<SpecialPathKind> {
        self.kind
    }

    /// Whether `self` is `root` or lies beneath it (component-wise, never a string prefix).
    pub fn is_inside(&self, root: &LexicalPath) -> bool {
        self.prefix == root.prefix
            && root.segments.len() <= self.segments.len()
            && root
                .segments
                .iter()
                .zip(&self.segments)
                .all(|(r, s)| r == s)
    }

    /// The segments of `self` below `root` when `self` is `root` or lies beneath it.
    pub fn segments_below(&self, root: &LexicalPath) -> Option<&[String]> {
        self.is_inside(root)
            .then(|| &self.segments[root.segments.len()..])
    }

    /// [`Self::is_inside`] with ASCII case folding, for deny-side checks (over-blocking on a
    /// case-sensitive filesystem is safe; under-blocking on a case-insensitive one is not).
    fn is_inside_ignore_ascii_case(&self, root: &LexicalPath) -> bool {
        self.prefix.eq_ignore_ascii_case(&root.prefix)
            && root.segments.len() <= self.segments.len()
            && root
                .segments
                .iter()
                .zip(&self.segments)
                .all(|(r, s)| r.eq_ignore_ascii_case(s))
    }

    fn push_segments(segments: &mut Vec<String>, rest: &str, seps: &[char], fold: bool) {
        for seg in rest.split(seps) {
            match seg {
                "" | "." => {}
                ".." => {
                    segments.pop();
                }
                other if fold => segments.push(other.to_lowercase()),
                other => segments.push(other.to_owned()),
            }
        }
    }

    fn parse_posix(raw: &str) -> Self {
        let (prefix, rest) = match raw.strip_prefix('/') {
            Some(rest) => ("/".to_owned(), rest),
            None => (String::new(), raw),
        };
        let mut segments = Vec::new();
        Self::push_segments(&mut segments, rest, &['/'], false);
        let kind = (prefix == "/"
            && segments.len() >= 2
            && (segments[0].eq_ignore_ascii_case("net")
                || segments[0].eq_ignore_ascii_case("network")))
        .then_some(SpecialPathKind::Automount);
        Self {
            kind,
            prefix,
            segments,
        }
    }

    fn parse_windows(raw: &str) -> Self {
        let s = raw.replace('/', "\\");
        let (kind, prefix, rest): (Option<SpecialPathKind>, String, &str) =
            if let Some(after) = s.strip_prefix(r"\\?\").or_else(|| s.strip_prefix(r"\??\")) {
                if let Some((drive, rest)) = split_windows_drive(after) {
                    (None, drive, rest)
                } else if let Some(unc) = after
                    .get(..3)
                    .filter(|head| head.eq_ignore_ascii_case("UNC"))
                    .map(|_| &after[3..])
                    .filter(|tail| tail.is_empty() || tail.starts_with('\\'))
                {
                    let (prefix, rest) = split_unc_server_share(unc);
                    (Some(SpecialPathKind::Unc), prefix, rest)
                } else {
                    let (name, rest) = after.split_once('\\').unwrap_or((after, ""));
                    (
                        Some(SpecialPathKind::Verbatim),
                        format!(r"\\?\{}", name.to_lowercase()),
                        rest,
                    )
                }
            } else if let Some(after) = s.strip_prefix(r"\\.\") {
                let (name, rest) = after.split_once('\\').unwrap_or((after, ""));
                (
                    Some(SpecialPathKind::Device),
                    format!(r"\\.\{}", name.to_lowercase()),
                    rest,
                )
            } else if let Some(after) = s.strip_prefix(r"\\") {
                let (prefix, rest) = split_unc_server_share(after);
                (Some(SpecialPathKind::Unc), prefix, rest)
            } else if let Some((drive, rest)) = split_windows_drive(&s) {
                (None, drive, rest)
            } else if let Some(rest) = s.strip_prefix('\\') {
                (None, "\\".to_owned(), rest)
            } else {
                (None, String::new(), s.as_str())
            };
        let mut segments = Vec::new();
        Self::push_segments(&mut segments, rest, &['\\'], true);
        Self {
            kind,
            prefix,
            segments,
        }
    }
}

/// Splits `C:\rest` into (`c:\`, `rest`) and drive-relative `C:rest` into (`c:`, `rest`).
fn split_windows_drive(s: &str) -> Option<(String, &str)> {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }
    let letter = (bytes[0] as char).to_ascii_lowercase();
    match s[2..].strip_prefix('\\') {
        Some(rest) => Some((format!("{letter}:\\"), rest)),
        None => Some((format!("{letter}:"), &s[2..])),
    }
}

/// Splits `\server\share\rest` (leading separators optional) into (`\\server\share`, `rest`).
fn split_unc_server_share(s: &str) -> (String, &str) {
    let mut rest = s.trim_start_matches('\\');
    let mut parts = Vec::with_capacity(2);
    while parts.len() < 2 && !rest.is_empty() {
        let (part, tail) = rest.split_once('\\').unwrap_or((rest, ""));
        parts.push(part.to_lowercase());
        rest = tail.trim_start_matches('\\');
    }
    (format!(r"\\{}", parts.join("\\")), rest)
}

/// Why [`check_lexical_containment`] refused a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LexicalGateDenial {
    /// A UNC/device/verbatim/automount path outside every root of the same form.
    SpecialForm(SpecialPathKind),
    /// Lexically outside every allowed root.
    OutsideRoots,
}

/// The pre-filesystem gate shared by the read and write checks (TS `isPathInsideAnyRoot(
/// path.resolve(...))`, which runs before any realpath). Pure: it parses strings only, so it
/// can never open a network share, trigger an automount, or touch a device.
///
/// `target` must already be absolute (joined onto the working directory). `roots` are the
/// allowed roots; callers pass both their configured and canonical spellings (roots are
/// trusted configuration, so resolving them is safe).
pub fn check_lexical_containment<S: AsRef<str>>(
    target: &str,
    roots: &[S],
    flavor: PathFlavor,
) -> Result<(), LexicalGateDenial> {
    let target = LexicalPath::parse(target, flavor);
    let roots: Vec<LexicalPath> = roots
        .iter()
        .map(|r| LexicalPath::parse(r.as_ref(), flavor))
        .filter(|r| !r.prefix.is_empty())
        .collect();
    if let Some(kind) = target.kind()
        && !roots
            .iter()
            .any(|root| root.kind().is_some() && target.is_inside(root))
    {
        return Err(LexicalGateDenial::SpecialForm(kind));
    }
    if roots.iter().any(|root| target.is_inside(root)) {
        Ok(())
    } else {
        Err(LexicalGateDenial::OutsideRoots)
    }
}

/// Configured and canonical spellings of `roots` for [`check_lexical_containment`].
fn root_spellings(roots: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::with_capacity(roots.len() * 2);
    for root in roots {
        let lexical = normalize_lexical_path(root);
        if lexical.as_os_str().is_empty() {
            continue;
        }
        out.push(lexical.to_string_lossy().into_owned());
        out.push(
            canonicalize_with_missing_tail(&lexical)
                .to_string_lossy()
                .into_owned(),
        );
    }
    out
}

/// Resolves a model- or client-supplied `raw` path against the absolute `base` purely lexically
/// (TS `path.resolve(base, raw)` without the filesystem): a relative `raw` is joined onto
/// `base`, a Windows current-drive-rooted `\x` takes `base`'s drive, a same-drive-relative
/// `C:x` is joined onto a `C:\` base, and every other rooted form (POSIX `/x`, `D:\x`, `D:x`
/// on another drive, UNC, device, verbatim) is returned unchanged for
/// [`check_lexical_containment`] to judge. Feed the result to that gate before any filesystem
/// call on it.
pub fn resolve_lexically(base: &str, raw: &str, flavor: PathFlavor) -> String {
    let parsed = LexicalPath::parse(raw, flavor);
    match flavor {
        PathFlavor::Posix if parsed.prefix.is_empty() => format!("{base}/{raw}"),
        PathFlavor::Posix => raw.to_owned(),
        PathFlavor::Windows => {
            if parsed.prefix.is_empty() {
                return format!("{base}\\{raw}");
            }
            let base_drive = split_windows_drive(&base.replace('/', "\\"))
                .map(|(drive, _)| drive)
                .filter(|drive| drive.ends_with('\\'));
            match base_drive {
                Some(_) if parsed.prefix == "\\" => format!("{}{raw}", &base[..2]),
                Some(drive)
                    if parsed.prefix.len() == 2
                        && parsed.prefix.ends_with(':')
                        && drive.starts_with(&parsed.prefix) =>
                {
                    format!("{base}\\{}", &raw[2..])
                }
                _ => raw.to_owned(),
            }
        }
    }
}

/// Pre-canonicalization gate for an untrusted absolute `target` that must end up inside `root`:
/// whether it is safe to touch the filesystem for `target` at all. Never touches the filesystem
/// for `target`.
///
/// Rejects outright anything whose canonicalization could reach another host or volume: UNC,
/// device, non-drive verbatim and automount paths outside every root spelling of the same form
/// ([`LexicalGateDenial::SpecialForm`]), and paths on a different drive/root prefix than every
/// spelling of `root`. A path on the same volume that merely fails the lexical match is allowed
/// through, because two spellings of one local directory can differ lexically (Windows 8.3 short
/// names such as `RUNNER~1`, case, junctions): the caller's mandatory canonical re-check against
/// the canonical root makes the containment decision and catches symlink escapes.
pub fn passes_pre_canonical_gate(target: &Path, root: &Path) -> bool {
    passes_pre_canonical_gate_with(
        &target.to_string_lossy(),
        &root_spellings(&[root.to_path_buf()]),
        PathFlavor::host(),
    )
}

/// [`passes_pre_canonical_gate`] over explicit root spellings and path flavor (testable for
/// Windows paths on any host).
pub fn passes_pre_canonical_gate_with<S: AsRef<str>>(
    target_raw: &str,
    spellings: &[S],
    flavor: PathFlavor,
) -> bool {
    match check_lexical_containment(target_raw, spellings, flavor) {
        Ok(()) => true,
        Err(LexicalGateDenial::SpecialForm(_)) => false,
        Err(LexicalGateDenial::OutsideRoots) => {
            let target_lexical = LexicalPath::parse(target_raw, flavor);
            target_lexical.kind().is_none()
                && !target_lexical.prefix.is_empty()
                && spellings.iter().any(|root| {
                    let root_lexical = LexicalPath::parse(root.as_ref(), flavor);
                    root_lexical.kind().is_none()
                        && root_lexical
                            .prefix
                            .eq_ignore_ascii_case(&target_lexical.prefix)
                })
        }
    }
}

fn special_form_label(kind: SpecialPathKind) -> &'static str {
    match kind {
        SpecialPathKind::Unc => "UNC network path",
        SpecialPathKind::Device => "device namespace path",
        SpecialPathKind::Verbatim => "verbatim path",
        SpecialPathKind::Automount => "network automount path",
    }
}

fn is_within(path: &Path, root: &Path) -> bool {
    let canon_root = canonicalize_with_missing_tail(root);
    path == canon_root || path.starts_with(&canon_root)
}

/// Returns whether `path` lies at or under `root`, comparing components as given (no
/// filesystem access). Components are compared ASCII-case-insensitively (like
/// `has_git_or_cowork_segment`) so `.COWORK/Auth` on a case-insensitive filesystem cannot
/// slip past the deny.
fn starts_with_ignore_ascii_case(path: &Path, root: &Path) -> bool {
    let mut path_comps = path.components();
    root.components().all(|root_comp| {
        path_comps
            .next()
            .is_some_and(|p| p.as_os_str().eq_ignore_ascii_case(root_comp.as_os_str()))
    })
}

/// Credential directories that model-driven tools may never read or write: provider/MCP
/// credentials (`~/.cowork/auth`, `<workspace>/.cowork/auth`, `<project>/.cowork/auth`), the
/// mobile pairing TLS key / OpenTunnel identity (`~/.cowork/mobile-pairing`), and well-known
/// cloud/SSH credential stores under `$HOME`.
///
/// This single list backs both the file-tool deny (`assert_read_path_allowed` /
/// `assert_write_path_allowed`) and the OS-sandbox read-deny passed to `bash`
/// (`SandboxExecutionRequest::read_denied_roots`), so the two cannot drift.
pub fn protected_credential_roots(ctx: &ToolExecutionContext) -> Vec<PathBuf> {
    let mut roots = vec![
        ctx.cowork_home.join("auth"),
        ctx.cowork_home.join("mobile-pairing"),
        // Workspace-scoped MCP credentials (see `cowork_mcp::credentials_path_for_scope`), which
        // are otherwise inside the readable workspace.
        ctx.working_directory.join(".cowork").join("auth"),
    ];
    if let Some(project_root) = ctx
        .agent_config
        .as_ref()
        .and_then(|c| c.project_cowork_dir.parent())
    {
        roots.push(project_root.join(".cowork").join("auth"));
    }
    for dir_name in [".ssh", ".aws", ".gnupg", ".kube", ".azure"] {
        roots.push(ctx.homedir.join(dir_name));
    }
    roots
}

/// The only Cowork-home subdirectories model-driven file tools may read: user skills
/// (`~/.cowork/skills`) and user plugins (`~/.cowork/plugins`, which hold plugin skills and their
/// reference files). Everything else under Cowork home stays unreadable to `read`/`glob`/`grep`:
/// user MCP/provider config (`config/`, whose transport env/headers may hold plaintext secrets),
/// logs, sessions, memories, auth, backups and other server state. TS parity: `readRoots`
/// (`src/utils/permissions.ts`) adds skills and plugin directories, never the whole Cowork home.
pub fn cowork_home_read_roots(cowork_home: &Path) -> Vec<PathBuf> {
    vec![cowork_home.join("skills"), cowork_home.join("plugins")]
}

/// Whether `resolved` (canonical) is inside one of the external `read_roots`, with Cowork home
/// limited to `cowork_home_read_roots`: a read root that covers more of Cowork home (or all of
/// it) never makes its config/logs/sessions readable.
fn in_external_read_root(resolved: &Path, ctx: &ToolExecutionContext) -> bool {
    if is_within(resolved, &ctx.cowork_home)
        && !cowork_home_read_roots(&ctx.cowork_home)
            .iter()
            .any(|r| is_within(resolved, r))
    {
        return false;
    }
    ctx.read_roots.iter().any(|r| is_within(resolved, r))
}

/// Lexical and canonical forms of every protected credential directory, re-resolved on every
/// call (the deny roots are trusted configuration, so resolving them is safe).
fn credential_root_forms(ctx: &ToolExecutionContext) -> Vec<PathBuf> {
    let mut forms = Vec::new();
    for root in protected_credential_roots(ctx) {
        forms.push(normalize_lexical_path(&root));
        forms.push(canonicalize_with_missing_tail(&root));
    }
    forms
}

/// Whether `target` is inside one of `root_forms` (see [`credential_root_forms`]). Mirrors the
/// TS `createReadPathChecker`: callers test the lexical target before any filesystem access and
/// the canonical target afterwards, each against both the lexical and the canonical form of
/// every deny directory. So a symlinked `.cowork` / `.cowork/auth` (canonical dir elsewhere in
/// the workspace), a symlinked credential file (`.cowork/auth/x -> /elsewhere`), and a link
/// that points into an auth dir are all denied. Comparison is ASCII-case-insensitive and, on
/// Windows, also folds verbatim (`\\?\C:\`) spellings onto plain ones.
fn in_credential_root(target: &Path, root_forms: &[PathBuf]) -> bool {
    let flavor = PathFlavor::host();
    let target_key = LexicalPath::parse(&target.to_string_lossy(), flavor);
    root_forms.iter().any(|root| {
        starts_with_ignore_ascii_case(target, root)
            || target_key
                .is_inside_ignore_ascii_case(&LexicalPath::parse(&root.to_string_lossy(), flavor))
    })
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

/// Rejects `lexical` before any filesystem access unless it is lexically inside one of `roots`
/// (see [`check_lexical_containment`]). `outside` builds the error for an ordinary
/// out-of-root path.
fn lexical_gate(
    lexical: &Path,
    roots: &[PathBuf],
    outside: impl FnOnce() -> ToolError,
) -> ToolResult<()> {
    match check_lexical_containment(
        &lexical.to_string_lossy(),
        &root_spellings(roots),
        PathFlavor::host(),
    ) {
        Ok(()) => Ok(()),
        Err(LexicalGateDenial::SpecialForm(kind)) => Err(ToolError::PathDenied(format!(
            "Access to {} outside the allowed roots is blocked: {}",
            special_form_label(kind),
            lexical.display()
        ))),
        Err(LexicalGateDenial::OutsideRoots) => Err(outside()),
    }
}

fn scratchpad_dir(ctx: &ToolExecutionContext) -> PathBuf {
    ctx.working_directory
        .join(".cowork")
        .join(".cowork-scratchpad")
}

/// Every root a model-driven read may reach: the workspace, output, uploads and scratchpad,
/// the external `read_roots`, and the non-secret Cowork-home allowlist. TS `readRoots` parity:
/// enforced regardless of yolo / sandbox mode.
fn read_roots_for_gate(ctx: &ToolExecutionContext) -> Vec<PathBuf> {
    let mut roots = vec![
        ctx.working_directory.clone(),
        ctx.output_directory.clone(),
        ctx.uploads_directory.clone(),
        scratchpad_dir(ctx),
    ];
    roots.extend(ctx.read_roots.iter().cloned());
    roots.extend(cowork_home_read_roots(&ctx.cowork_home));
    roots
}

/// Writable roots under `danger-full-access`: TS `writeRoots` (working directory, project root,
/// output, uploads). TS `assertWritePathAllowed` confines built-in writes to these regardless of
/// sandbox mode or yolo; danger-full-access only lifts the OS sandbox for `bash`.
fn danger_full_access_write_roots(ctx: &ToolExecutionContext) -> Vec<PathBuf> {
    let mut roots = vec![
        ctx.working_directory.clone(),
        ctx.output_directory.clone(),
        ctx.uploads_directory.clone(),
    ];
    if let Some(project_root) = ctx
        .agent_config
        .as_ref()
        .and_then(|c| c.project_cowork_dir.parent())
        .filter(|p| !p.as_os_str().is_empty())
    {
        roots.push(project_root.to_path_buf());
    }
    roots
}

fn workspace_write_roots(ctx: &ToolExecutionContext, writable_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = writable_roots.to_vec();
    roots.push(ctx.working_directory.clone());
    roots.push(ctx.output_directory.clone());
    roots.push(ctx.uploads_directory.clone());
    roots
}

fn no_project_write_roots(project_roots: &[PathBuf]) -> Vec<PathBuf> {
    tmp_scratch_roots(project_roots, &scratch_roots(None))
}

pub fn assert_read_path_allowed(path: &Path, ctx: &ToolExecutionContext) -> ToolResult<PathBuf> {
    assert_read_path_allowed_with(path, ctx, &canonicalize_with_missing_tail)
}

/// `assert_read_path_allowed` with the target's canonicalization injected, so tests can prove
/// an out-of-root (or UNC/device) target never reaches the filesystem.
fn assert_read_path_allowed_with(
    path: &Path,
    ctx: &ToolExecutionContext,
    canonicalize: &dyn Fn(&Path) -> PathBuf,
) -> ToolResult<PathBuf> {
    // 1. Purely lexical checks: nothing below touches the filesystem for the target until it
    //    is known to be lexically inside an allowed read root.
    let lexical = normalize_lexical_path(path);
    let credential_forms = credential_root_forms(ctx);
    if in_credential_root(&lexical, &credential_forms) {
        return Err(ToolError::PathDenied(format!(
            "Access to protected credential path is blocked: {}",
            lexical.display()
        )));
    }
    let gate_roots = read_roots_for_gate(ctx);
    lexical_gate(&lexical, &gate_roots, || {
        ToolError::PathDenied(format!(
            "Read access outside configured readRoots is blocked: {}",
            lexical.display()
        ))
    })?;

    // 2. Canonical re-checks (symlink escapes, symlinked credential dirs).
    let resolved = canonicalize(&lexical);
    if in_credential_root(&resolved, &credential_forms) {
        return Err(ToolError::PathDenied(format!(
            "Access to protected credential path is blocked: {}",
            resolved.display()
        )));
    }

    let scratchpad = canonicalize_with_missing_tail(&scratchpad_dir(ctx));
    if let Some(targets) = &ctx.target_paths
        && !targets.is_empty()
    {
        let in_project_roots = is_within(&resolved, &ctx.working_directory)
            || is_within(&resolved, &ctx.output_directory)
            || is_within(&resolved, &ctx.uploads_directory);
        let in_external_read_root = in_external_read_root(&resolved, ctx);
        // `projectPathsOnly: true`: `targetPaths` confines reads within workspace/project roots,
        // while external `read_roots` (such as bundled/user skills) remain readable. Cowork home
        // is limited to `cowork_home_read_roots`, so a scoped child never reads MCP config,
        // logs or sessions.
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

    // Read roots are enforced in every sandbox mode, yolo included (TS `createReadPathChecker`
    // has no bypass).
    let in_default = is_within(&resolved, &ctx.working_directory)
        || is_within(&resolved, &ctx.output_directory)
        || is_within(&resolved, &ctx.uploads_directory)
        || is_within(&resolved, &scratchpad);
    let in_extra = in_external_read_root(&resolved, ctx)
        || cowork_home_read_roots(&ctx.cowork_home)
            .iter()
            .any(|r| is_within(&resolved, r));
    if !in_default && !in_extra {
        return Err(ToolError::PathDenied(format!(
            "Read access outside configured readRoots is blocked: {}",
            resolved.display()
        )));
    }

    Ok(resolved)
}

pub fn assert_write_path_allowed(path: &Path, ctx: &ToolExecutionContext) -> ToolResult<PathBuf> {
    assert_write_path_allowed_with(path, ctx, &canonicalize_with_missing_tail)
}

/// TS `assertCanSpill` (`src/runtime/pi/tools.ts`): authorizes a harness tool-output overflow
/// spill to `path`. Read-only / no-project-write turns are refused outright; otherwise the
/// concrete path must pass the same write gate as the `write`/`edit` tools (writable roots and
/// `targetPaths` scope) and the read gate, so a scoped child never spills outside its targets.
/// The only difference from [`assert_write_path_allowed`] is that the harness-owned
/// `<workspace>/.cowork/.cowork-scratchpad` is exempt from the protected-`.cowork` rule, since
/// that is where spills live.
pub fn assert_spill_path_allowed(path: &Path, ctx: &ToolExecutionContext) -> ToolResult<PathBuf> {
    if ctx.read_only_role
        || matches!(
            ctx.sandbox_policy,
            SandboxPolicy::ReadOnly { .. } | SandboxPolicy::NoProjectWrite { .. }
        )
    {
        let kind = if ctx.read_only_role {
            "no-project-write"
        } else {
            ctx.sandbox_policy.kind_str()
        };
        return Err(ToolError::PathDenied(format!(
            "Tool output spill blocked: sandbox mode is {kind}."
        )));
    }
    let resolved =
        assert_write_path_allowed_impl(path, ctx, &canonicalize_with_missing_tail, true)?;
    assert_read_path_allowed(path, ctx)?;
    Ok(resolved)
}

/// `assert_write_path_allowed` with the target's canonicalization injected (see
/// [`assert_read_path_allowed_with`]).
fn assert_write_path_allowed_with(
    path: &Path,
    ctx: &ToolExecutionContext,
    canonicalize: &dyn Fn(&Path) -> PathBuf,
) -> ToolResult<PathBuf> {
    assert_write_path_allowed_impl(path, ctx, canonicalize, false)
}

fn assert_write_path_allowed_impl(
    path: &Path,
    ctx: &ToolExecutionContext,
    canonicalize: &dyn Fn(&Path) -> PathBuf,
    allow_harness_scratchpad: bool,
) -> ToolResult<PathBuf> {
    // 1. Purely lexical checks (no filesystem access for the target).
    let lexical = normalize_lexical_path(path);
    let credential_forms = credential_root_forms(ctx);
    if in_credential_root(&lexical, &credential_forms) {
        return Err(ToolError::PathDenied(format!(
            "Write access to protected credential path is blocked: {}",
            lexical.display()
        )));
    }
    if ctx.read_only_role || matches!(ctx.sandbox_policy, SandboxPolicy::ReadOnly { .. }) {
        return Err(ToolError::PathDenied(
            "File writes are blocked because this session is running in read-only mode.".to_owned(),
        ));
    }
    match &ctx.sandbox_policy {
        SandboxPolicy::ReadOnly { .. } => {
            return Err(ToolError::PathDenied(
                "File writes are blocked in read-only sandbox policy.".to_owned(),
            ));
        }
        SandboxPolicy::NoProjectWrite { project_roots, .. } => {
            lexical_gate(&lexical, &no_project_write_roots(project_roots), || {
                ToolError::PathDenied(format!(
                    "Write to '{}' is blocked by no-project-write policy.",
                    lexical.display()
                ))
            })?;
        }
        SandboxPolicy::WorkspaceWrite { writable_roots, .. } => {
            lexical_gate(
                &lexical,
                &workspace_write_roots(ctx, writable_roots),
                || {
                    ToolError::PathDenied(format!(
                        "Write to '{}' is blocked: outside writable workspace roots.",
                        lexical.display()
                    ))
                },
            )?;
        }
        SandboxPolicy::DangerFullAccess { .. } => {
            lexical_gate(&lexical, &danger_full_access_write_roots(ctx), || {
                ToolError::PathDenied(format!(
                    "Write to '{}' is blocked: outside writable workspace roots.",
                    lexical.display()
                ))
            })?;
        }
    }

    // 2. Canonical re-checks (symlink escapes, protected metadata, credential dirs).
    let resolved = canonicalize(&lexical);
    if in_credential_root(&resolved, &credential_forms) {
        return Err(ToolError::PathDenied(format!(
            "Write access to protected credential path is blocked: {}",
            resolved.display()
        )));
    }
    let in_harness_scratchpad =
        allow_harness_scratchpad && is_within(&resolved, &scratchpad_dir(ctx));
    if !in_harness_scratchpad
        && let Some(protected) = has_git_or_cowork_segment(&resolved, &ctx.working_directory)
    {
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
    let wf_inputs = canonicalize_with_missing_tail(
        &ctx.working_directory
            .join(".ModelScratchpad")
            .join("workflows")
            .join("inputs"),
    );
    if is_within(&resolved, &wf_inputs) {
        return Err(ToolError::PathDenied(format!(
            "Write access to read-only workflow input directory is blocked: {}",
            resolved.display()
        )));
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
        SandboxPolicy::DangerFullAccess { .. } => {
            // TS `assertWritePathAllowed`: the canonical target must stay inside the write
            // roots even when the OS sandbox is off.
            if danger_full_access_write_roots(ctx)
                .iter()
                .any(|r| is_within(&resolved, r))
            {
                Ok(resolved)
            } else {
                Err(ToolError::PathDenied(format!(
                    "Write to '{}' is blocked: canonical target resolves outside writable workspace roots.",
                    resolved.display()
                )))
            }
        }
        SandboxPolicy::ReadOnly { .. } => Err(ToolError::PathDenied(
            "File writes are blocked in read-only sandbox policy.".to_owned(),
        )),
        SandboxPolicy::NoProjectWrite { project_roots, .. } => {
            let blocked_in_proj = project_roots.iter().any(|r| is_within(&resolved, r));
            let in_tmp = no_project_write_roots(project_roots)
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
            if workspace_write_roots(ctx, writable_roots)
                .iter()
                .any(|r| is_within(&resolved, r))
            {
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

#[cfg(test)]
mod lexical_gate_tests {
    use std::sync::Mutex;

    use cowork_config::ProviderName;

    use super::*;

    /// A canonicalizer that records every target it is asked to resolve, so a test can prove an
    /// out-of-root or UNC/device target never reached the filesystem.
    fn recording() -> (
        Arc<Mutex<Vec<PathBuf>>>,
        impl Fn(&Path) -> PathBuf + 'static,
    ) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&calls);
        let canon = move |p: &Path| {
            sink.lock().unwrap().push(p.to_path_buf());
            canonicalize_with_missing_tail(p)
        };
        (calls, canon)
    }

    fn ctx_in(base: &Path) -> ToolExecutionContext {
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&ws).unwrap();
        ToolExecutionContext::new_for_tests(
            fs::canonicalize(home).unwrap(),
            fs::canonicalize(ws).unwrap(),
            ProviderName::Openai,
            "gpt-5.4",
        )
    }

    fn danger(mut ctx: ToolExecutionContext) -> ToolExecutionContext {
        ctx.yolo = true;
        ctx.sandbox_policy = SandboxPolicy::DangerFullAccess {
            network: Some(true),
        };
        ctx
    }

    #[test]
    fn out_of_root_targets_never_reach_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        for ctx in [ctx_in(tmp.path()), danger(ctx_in(tmp.path()))] {
            let outside = [
                ctx.homedir.join(".zshrc"),
                tmp.path().join("elsewhere").join("x"),
                ctx.working_directory.join("..").join("..").join("escape"),
                PathBuf::from("/net/attacker.example/share/x"),
                PathBuf::from("/Network/Servers/attacker.example/x"),
            ];
            for target in &outside {
                let (calls, canon) = recording();
                assert!(
                    assert_read_path_allowed_with(target, &ctx, &canon).is_err(),
                    "read {target:?} (yolo={})",
                    ctx.yolo
                );
                assert!(
                    assert_write_path_allowed_with(target, &ctx, &canon).is_err(),
                    "write {target:?} (yolo={})",
                    ctx.yolo
                );
                assert!(
                    calls.lock().unwrap().is_empty(),
                    "{target:?} reached canonicalize: {:?}",
                    calls.lock().unwrap()
                );
            }
        }
    }

    #[test]
    fn in_root_targets_are_canonicalized_and_rechecked() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_in(tmp.path());
        let target = ctx.working_directory.join("src").join("a.rs");
        let (calls, canon) = recording();
        assert_eq!(
            assert_read_path_allowed_with(&target, &ctx, &canon).unwrap(),
            target
        );
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            std::slice::from_ref(&target)
        );
    }

    #[test]
    fn automount_paths_are_denied_as_special_forms() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = danger(ctx_in(tmp.path()));
        let (calls, canon) = recording();
        let err = assert_read_path_allowed_with(Path::new("/net/attacker/s/x"), &ctx, &canon)
            .unwrap_err()
            .to_string();
        assert!(err.contains("network automount path"), "{err}");
        assert!(calls.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn unc_device_and_verbatim_targets_never_reach_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        for ctx in [ctx_in(tmp.path()), danger(ctx_in(tmp.path()))] {
            for raw in [
                r"\\attacker.example\s\x",
                "//attacker.example/s/x",
                r"\\?\UNC\attacker.example\s\x",
                r"\\.\pipe\attacker",
                r"\\?\GLOBALROOT\Device\Mup\attacker.example\s\x",
            ] {
                let target = lexical_tool_path(raw, &ctx.working_directory).unwrap();
                let (calls, canon) = recording();
                let read_err = assert_read_path_allowed_with(&target, &ctx, &canon).unwrap_err();
                let write_err = assert_write_path_allowed_with(&target, &ctx, &canon).unwrap_err();
                assert!(
                    read_err.to_string().contains("outside the allowed roots"),
                    "{raw}: {read_err}"
                );
                assert!(
                    write_err.to_string().contains("outside the allowed roots"),
                    "{raw}: {write_err}"
                );
                assert!(
                    calls.lock().unwrap().is_empty(),
                    "{raw} reached canonicalize"
                );
            }
        }
    }
}
