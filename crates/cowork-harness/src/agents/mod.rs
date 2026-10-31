pub mod model_router;
pub mod profiles;
pub mod report_parser;
pub mod roles;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::{AgentConfig, ProviderName, SandboxConfig, SandboxMode};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, TurnUsage,
};
use cowork_storage::{
    AgentExecutionState, PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb,
    SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use cowork_tools::{
    AgentControlBridge, resolve_context_mode_and_briefing, validate_and_resolve_target_paths,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub use model_router::{ResolvedChildModel, resolve_child_model_selection};
pub use profiles::{
    AgentProfileCatalogEntry, AgentProfileDefinition, AgentProfileDiagnostic, AgentProfileScope,
    AgentProfileSnapshot, AgentProfileUpsertInput, AgentProfilesCatalog, AgentProfilesStore,
};
pub use report_parser::{
    ChildAgentReport, ChildAgentVerificationItem, ChildReportInspection, inspect_child_agent_report,
};
pub use roles::{
    BUILTIN_AGENT_ROLES, BuiltinAgentRoleSpec, compute_effective_builtin_tools, load_role_prompt,
    lookup_builtin_role,
};

pub const MAX_SPAWN_DEPTH: u32 = 1;
pub const MAX_ACTIVE_CHILDREN_PER_PARENT: usize = 16;

/// Wire-exact `PersistentAgentSummary` matching `persistentAgentSummarySchema` (`.strict()`) in `src/shared/agents.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentAgentSummary {
    pub agent_id: String,
    pub parent_session_id: String,
    pub role: String,
    pub mode: String,
    pub depth: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<AgentProfileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    pub effective_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_reasoning_effort: Option<String>,
    pub title: String,
    pub provider: String,
    pub created_at: String,
    pub updated_at: String,
    pub lifecycle_state: String,
    pub execution_state: String,
    pub busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_turn_usage: Option<Value>,
}

/// Wire-exact `AgentInspectResult` matching `agentInspectResultSchema` (`.strict()`) in `src/shared/agents.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInspectionPayload {
    pub agent: PersistentAgentSummary,
    pub latest_assistant_text: Option<String>,
    pub parsed_report: Option<ChildAgentReport>,
    pub report_required: bool,
    pub report_found: bool,
    pub report_valid: bool,
    pub report_block_count: usize,
    pub report_diagnostic: Option<String>,
    pub session_usage: Option<Value>,
    pub last_turn_usage: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWaitInspection {
    pub agent_id: String,
    pub latest_assistant_text: Option<String>,
    pub parsed_report: Option<ChildAgentReport>,
    pub report_required: bool,
    pub report_found: bool,
    pub report_valid: bool,
    pub report_block_count: usize,
    pub report_diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWaitOutcome {
    pub session_id: String,
    pub agent_ids: Vec<String>,
    pub timed_out: bool,
    pub mode: String,
    pub agents: Vec<PersistentAgentSummary>,
    pub ready_agent_ids: Vec<String>,
    pub errored_agent_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspections: Option<Vec<AgentWaitInspection>>,
}

#[derive(Debug, Clone)]
pub struct AgentSpawnRequest {
    pub message: String,
    pub role: Option<String>,
    pub profile_ref: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub nickname: Option<String>,
    pub task_type: Option<String>,
    pub target_paths: Option<Vec<String>>,
    pub context_mode: Option<String>,
    pub briefing: Option<String>,
    pub include_parent_todos: bool,
    pub include_harness_context: bool,
    pub fork_context: bool,
}

#[derive(Debug, Clone)]
pub struct ChildTurnInput {
    pub agent_id: String,
    pub parent_session_id: String,
    pub prompt: String,
    pub role: String,
    pub role_prompt: String,
    pub read_only_role: bool,
    pub sandbox_mode: SandboxMode,
    pub target_paths: Option<Vec<PathBuf>>,
    pub allowed_builtin_tools: BTreeSet<String>,
    pub allowed_mcp_servers: Option<BTreeSet<String>>,
    pub allowed_skill_names: Option<BTreeSet<String>>,
    pub provider: ProviderName,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub initial_messages: Vec<CanonicalMessage>,
    pub todos: Vec<Value>,
    pub harness_context: Option<Value>,
    pub cancel_token: CancellationToken,
}

#[derive(Debug, Clone)]
pub struct ChildTurnResult {
    pub messages: Vec<CanonicalMessage>,
    pub latest_assistant_text: Option<String>,
    pub usage: TurnUsage,
}

#[async_trait]
pub trait ChildTurnExecutor: Send + Sync {
    async fn run_child_turn(&self, input: ChildTurnInput) -> Result<ChildTurnResult, String>;
}

pub type AgentEventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct AgentControlConfig {
    pub parent_session_id: String,
    pub parent_depth: u32,
    pub agent_config: Arc<AgentConfig>,
    pub session_db: Arc<SessionDb>,
    pub connected_providers: BTreeSet<ProviderName>,
}

struct ChildRuntimeEntry {
    summary: PersistentAgentSummary,
    role_prompt: String,
    read_only_role: bool,
    sandbox_mode: SandboxMode,
    resolved_target_paths: Option<Vec<PathBuf>>,
    allowed_builtin_tools: BTreeSet<String>,
    allowed_mcp_servers: Option<BTreeSet<String>>,
    allowed_skill_names: Option<BTreeSet<String>>,
    provider: ProviderName,
    model_id: String,
    effective_reasoning_effort: Option<String>,
    messages: Vec<CanonicalMessage>,
    todos: Vec<Value>,
    harness_context: Option<Value>,
    latest_assistant_text: Option<String>,
    pending_inputs: VecDeque<String>,
    cancel_token: Option<CancellationToken>,
    report_required: bool,
}

struct ParentSlotTracker {
    reserved_spawns: usize,
    children: BTreeMap<String, ChildRuntimeEntry>,
}

impl ParentSlotTracker {
    fn active_or_reserved_count(&self) -> usize {
        let running = self
            .children
            .values()
            .filter(|c| {
                c.summary.lifecycle_state == "active"
                    && matches!(
                        c.summary.execution_state.as_str(),
                        "pending_init" | "running"
                    )
            })
            .count();
        self.reserved_spawns + running
    }
}

pub type ParentSnapshotProvider =
    Arc<dyn Fn() -> (Vec<CanonicalMessage>, Vec<Value>, Option<Value>) + Send + Sync>;

pub struct AgentControl {
    cfg: AgentControlConfig,
    state: Arc<Mutex<ParentSlotTracker>>,
    status_bus: Arc<Notify>,
    executor: Arc<dyn ChildTurnExecutor>,
    event_sink: AgentEventSink,
    parent_snapshot_provider: Mutex<Option<ParentSnapshotProvider>>,
}

impl AgentControl {
    pub fn new(
        cfg: AgentControlConfig,
        executor: Arc<dyn ChildTurnExecutor>,
        event_sink: AgentEventSink,
    ) -> Self {
        let mut hydrated_children = BTreeMap::new();
        if let Ok(rows) = cfg.session_db.list_agent_sessions(&cfg.parent_session_id) {
            for row in rows {
                let exec_state = cowork_storage::resolve_restored_agent_execution_state(
                    row.execution_state,
                    row.status,
                    false,
                );
                let wire_exec = execution_state_to_wire(exec_state).to_owned();
                let lifecycle = match row.status {
                    SessionPersistenceStatus::Closed => "closed",
                    SessionPersistenceStatus::Active => "active",
                }
                .to_owned();
                let role_name = row.role.clone().unwrap_or_else(|| "default".to_owned());
                let role_spec = lookup_builtin_role(&role_name).unwrap_or(&BUILTIN_AGENT_ROLES[0]);
                let profile_snap = row
                    .profile
                    .as_ref()
                    .and_then(|v| serde_json::from_value::<AgentProfileSnapshot>(v.clone()).ok());
                let eff_model = row
                    .effective_model
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", row.provider.as_str(), row.model));
                let summary = PersistentAgentSummary {
                    agent_id: row.session_id.clone(),
                    parent_session_id: cfg.parent_session_id.clone(),
                    role: role_name.clone(),
                    mode: row
                        .mode
                        .clone()
                        .unwrap_or_else(|| role_spec.mode.to_owned()),
                    depth: row.depth.map(|d| d.max(0) as u32).unwrap_or(1),
                    nickname: row.nickname.clone(),
                    task_type: row.task_type.clone(),
                    target_paths: row.target_paths.clone(),
                    profile: profile_snap,
                    requested_model: row.requested_model.clone(),
                    effective_model: eff_model,
                    requested_reasoning_effort: row.requested_reasoning_effort.clone(),
                    effective_reasoning_effort: row.effective_reasoning_effort.clone(),
                    title: row.title.clone(),
                    provider: row.provider.as_str().to_owned(),
                    created_at: row.created_at.clone(),
                    updated_at: row.updated_at.clone(),
                    lifecycle_state: lifecycle,
                    execution_state: wire_exec,
                    busy: false,
                    last_message_preview: row.last_message_preview.clone(),
                    session_usage: None,
                    last_turn_usage: None,
                };
                hydrated_children.insert(
                    row.session_id.clone(),
                    ChildRuntimeEntry {
                        summary,
                        role_prompt: load_role_prompt(
                            &cfg.agent_config.built_in_dir,
                            &role_name,
                            None,
                        ),
                        read_only_role: role_spec.read_only,
                        sandbox_mode: if role_spec.read_only {
                            SandboxMode::ReadOnly
                        } else {
                            cfg.agent_config.sandbox.mode
                        },
                        resolved_target_paths: None,
                        allowed_builtin_tools: compute_effective_builtin_tools(role_spec, None),
                        allowed_mcp_servers: None,
                        allowed_skill_names: None,
                        provider: row.provider,
                        model_id: row.model,
                        effective_reasoning_effort: row.effective_reasoning_effort,
                        messages: Vec::new(),
                        todos: row.todos,
                        harness_context: row.harness_context,
                        latest_assistant_text: row.last_message_preview,
                        pending_inputs: VecDeque::new(),
                        cancel_token: None,
                        report_required: row.task_type.is_some() || role_spec.name != "default",
                    },
                );
            }
        }

        Self {
            cfg,
            state: Arc::new(Mutex::new(ParentSlotTracker {
                reserved_spawns: 0,
                children: hydrated_children,
            })),
            status_bus: Arc::new(Notify::new()),
            executor,
            event_sink,
            parent_snapshot_provider: Mutex::new(None),
        }
    }

    pub fn set_parent_snapshot_provider<F>(&self, provider: F)
    where
        F: Fn() -> (Vec<CanonicalMessage>, Vec<Value>, Option<Value>) + Send + Sync + 'static,
    {
        *self.parent_snapshot_provider.lock() = Some(Arc::new(provider));
    }

    /// Synchronously enforces `MAX_SPAWN_DEPTH = 1` AND reserves an active child slot (`<= 16`)
    /// BEFORE the first `.await` so concurrent spawns can never race past 16!
    pub async fn spawn(
        &self,
        req: AgentSpawnRequest,
        parent_messages: &[CanonicalMessage],
        parent_todos: &[Value],
        parent_harness_context: Option<&Value>,
    ) -> Result<PersistentAgentSummary, String> {
        let child_depth = self.cfg.parent_depth + 1;
        if child_depth > MAX_SPAWN_DEPTH {
            return Err(format!(
                "Child agent depth {child_depth} exceeds the maximum spawn depth of {MAX_SPAWN_DEPTH}; recursive sub-delegation is disabled."
            ));
        }
        if req.message.trim().is_empty() {
            return Err("Spawn message must not be empty.".to_owned());
        }

        // Atomic synchronous check-and-reserve BEFORE any `.await`!
        {
            let mut guard = self.state.lock();
            if guard.active_or_reserved_count() >= MAX_ACTIVE_CHILDREN_PER_PARENT {
                return Err(format!(
                    "Maximum active child agents per parent ({MAX_ACTIVE_CHILDREN_PER_PARENT}) reached. Wait for or close existing agents before spawning more."
                ));
            }
            guard.reserved_spawns += 1;
        }

        let state_for_cleanup = Arc::clone(&self.state);
        let release_reservation = || {
            let mut g = state_for_cleanup.lock();
            g.reserved_spawns = g.reserved_spawns.saturating_sub(1);
        };

        let prep = (|| -> Result<PreparedChildSpawn, String> {
            let profiles_store = AgentProfilesStore::new(
                &self.cfg.agent_config.user_cowork_dir,
                &self.cfg.agent_config.working_directory,
            );
            let resolved_profile = match req.profile_ref.as_deref() {
                Some(pref) if !pref.trim().is_empty() => {
                    Some(profiles_store.resolve_profile(pref)?)
                }
                _ => None,
            };

            let role_name = if let Some(ref prof) = resolved_profile {
                prof.base_role.clone()
            } else {
                req.role
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("default")
                    .to_owned()
            };
            let role_spec = lookup_builtin_role(&role_name)?;

            let effective_tools = compute_effective_builtin_tools(
                role_spec,
                resolved_profile
                    .as_ref()
                    .filter(|p| !p.allowed_built_in_tools.is_empty())
                    .map(|p| p.allowed_built_in_tools.as_slice()),
            );
            let allowed_mcp = resolved_profile.as_ref().and_then(|p| {
                (!p.allowed_mcp_servers.is_empty())
                    .then(|| p.allowed_mcp_servers.iter().cloned().collect())
            });
            let allowed_skills = resolved_profile.as_ref().and_then(|p| {
                (!p.skill_names.is_empty()).then(|| p.skill_names.iter().cloned().collect())
            });

            let resolved_targets = match req.target_paths.as_ref() {
                Some(raw) => Some(
                    validate_and_resolve_target_paths(
                        &self.cfg.agent_config.working_directory,
                        raw,
                    )
                    .map_err(|e| e.to_string())?,
                ),
                None => None,
            };
            let wire_targets = resolved_targets.as_ref().map(|paths| {
                paths
                    .iter()
                    .map(|p| {
                        p.strip_prefix(&self.cfg.agent_config.working_directory)
                            .unwrap_or(p)
                            .to_string_lossy()
                            .replace('\\', "/")
                    })
                    .collect::<Vec<_>>()
            });

            let effective_ctx_raw = req.context_mode.as_deref().or_else(|| {
                resolved_profile
                    .as_ref()
                    .and_then(|p| p.default_context_mode.as_deref())
            });
            let (ctx_mode, briefing) = resolve_context_mode_and_briefing(
                effective_ctx_raw,
                req.briefing.as_deref(),
                req.fork_context.then_some(true),
            )
            .map_err(|e| e.to_string())?;

            let mut initial_messages = Vec::new();
            let mut todos = Vec::new();
            let mut harness_ctx = None;
            match ctx_mode.as_str() {
                "full" => {
                    initial_messages = parent_messages.to_vec();
                    todos = parent_todos.to_vec();
                    harness_ctx = parent_harness_context.cloned();
                }
                "brief" => {
                    if let Some(b) = briefing {
                        initial_messages.push(make_canonical_user_message(&format!(
                            "Parent briefing:\n{b}"
                        )));
                    }
                    if req.include_parent_todos {
                        todos = parent_todos.to_vec();
                    }
                    if req.include_harness_context {
                        harness_ctx = parent_harness_context.cloned();
                    }
                }
                _ => {
                    if req.include_parent_todos {
                        todos = parent_todos.to_vec();
                    }
                    if req.include_harness_context {
                        harness_ctx = parent_harness_context.cloned();
                    }
                }
            }

            let requested_model = req
                .model
                .as_deref()
                .or_else(|| resolved_profile.as_ref().and_then(|p| p.model.as_deref()));
            let requested_effort = req.reasoning_effort.as_deref().or_else(|| {
                resolved_profile
                    .as_ref()
                    .and_then(|p| p.reasoning_effort.as_deref())
            });
            let model_sel = resolve_child_model_selection(
                &self.cfg.agent_config,
                self.cfg.agent_config.provider,
                &self.cfg.agent_config.model,
                requested_model,
                requested_effort,
                &self.cfg.connected_providers,
            )?;

            let sandbox_mode = if role_spec.read_only {
                SandboxMode::ReadOnly
            } else if resolved_targets.is_some() {
                SandboxMode::WorkspaceWrite
            } else {
                self.cfg.agent_config.sandbox.mode
            };

            let custom_prompt = resolved_profile
                .as_ref()
                .map(|p| p.prompt.as_str())
                .filter(|s| !s.trim().is_empty());
            let role_prompt = load_role_prompt(
                &self.cfg.agent_config.built_in_dir,
                role_spec.name,
                custom_prompt,
            );

            let effective_task_type = req.task_type.clone().or_else(|| {
                resolved_profile
                    .as_ref()
                    .and_then(|p| p.default_task_type.clone())
            });

            Ok(PreparedChildSpawn {
                role_spec,
                resolved_profile,
                effective_tools,
                allowed_mcp,
                allowed_skills,
                resolved_targets,
                wire_targets,
                initial_messages,
                todos,
                harness_ctx,
                model_sel,
                sandbox_mode,
                role_prompt,
                effective_task_type,
            })
        })();

        let prep = match prep {
            Ok(p) => p,
            Err(e) => {
                release_reservation();
                return Err(e);
            }
        };

        let agent_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let title = req
            .nickname
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("{} agent", prep.role_spec.display_name));

        let summary = PersistentAgentSummary {
            agent_id: agent_id.clone(),
            parent_session_id: self.cfg.parent_session_id.clone(),
            role: prep.role_spec.name.to_owned(),
            mode: prep.role_spec.mode.to_owned(),
            depth: child_depth,
            nickname: req.nickname.clone(),
            task_type: prep.effective_task_type.clone(),
            target_paths: prep.wire_targets.clone(),
            profile: prep.resolved_profile.clone(),
            requested_model: prep.model_sel.requested_model.clone(),
            effective_model: prep.model_sel.canonical_ref.clone(),
            requested_reasoning_effort: prep.model_sel.requested_reasoning_effort.clone(),
            effective_reasoning_effort: prep.model_sel.effective_reasoning_effort.clone(),
            title,
            provider: prep.model_sel.provider.as_str().to_owned(),
            created_at: now.clone(),
            updated_at: now.clone(),
            lifecycle_state: "active".to_owned(),
            execution_state: "running".to_owned(),
            busy: true,
            last_message_preview: None,
            session_usage: None,
            last_turn_usage: None,
        };

        let mutation = build_child_session_mutation(
            &self.cfg.agent_config,
            &summary,
            &prep.role_prompt,
            &[],
            &prep.todos,
            prep.harness_ctx.as_ref(),
            prep.sandbox_mode,
            "agent_spawned",
        );
        if let Err(e) = self.cfg.session_db.persist_session_mutation(mutation).await {
            release_reservation();
            return Err(format!("Failed saving child agent session: {e}"));
        }

        let cancel_token = CancellationToken::new();
        {
            let mut guard = self.state.lock();
            guard.reserved_spawns = guard.reserved_spawns.saturating_sub(1);
            guard.children.insert(
                agent_id.clone(),
                ChildRuntimeEntry {
                    summary: summary.clone(),
                    role_prompt: prep.role_prompt,
                    read_only_role: prep.role_spec.read_only,
                    sandbox_mode: prep.sandbox_mode,
                    resolved_target_paths: prep.resolved_targets,
                    allowed_builtin_tools: prep.effective_tools,
                    allowed_mcp_servers: prep.allowed_mcp,
                    allowed_skill_names: prep.allowed_skills,
                    provider: prep.model_sel.provider,
                    model_id: prep.model_sel.model_id,
                    effective_reasoning_effort: prep.model_sel.effective_reasoning_effort,
                    messages: prep.initial_messages,
                    todos: prep.todos,
                    harness_context: prep.harness_ctx,
                    latest_assistant_text: None,
                    pending_inputs: VecDeque::new(),
                    cancel_token: Some(cancel_token.clone()),
                    report_required: summary.task_type.is_some()
                        || prep.role_spec.name != "default",
                },
            );
        }

        self.emit_event(
            "cowork/session/agentSpawned",
            json!({
                "type": "agent_spawned",
                "sessionId": self.cfg.parent_session_id,
                "agent": summary,
            }),
        );
        self.emit_agent_list();

        self.launch_turn_loop(agent_id, req.message, cancel_token);
        Ok(summary)
    }

    fn launch_turn_loop(
        &self,
        agent_id: String,
        initial_prompt: String,
        initial_cancel: CancellationToken,
    ) {
        let state = Arc::clone(&self.state);
        let status_bus = Arc::clone(&self.status_bus);
        let executor = Arc::clone(&self.executor);
        let session_db = Arc::clone(&self.cfg.session_db);
        let agent_cfg = Arc::clone(&self.cfg.agent_config);
        let event_sink = Arc::clone(&self.event_sink);
        let parent_id = self.cfg.parent_session_id.clone();

        tokio::spawn(async move {
            let mut next_prompt = Some((initial_prompt, initial_cancel));
            while let Some((prompt, cancel_token)) = next_prompt.take() {
                let turn_input = {
                    let guard = state.lock();
                    let Some(entry) = guard.children.get(&agent_id) else {
                        break;
                    };
                    if entry.summary.lifecycle_state == "closed" {
                        break;
                    }
                    ChildTurnInput {
                        agent_id: agent_id.clone(),
                        parent_session_id: parent_id.clone(),
                        prompt,
                        role: entry.summary.role.clone(),
                        role_prompt: entry.role_prompt.clone(),
                        read_only_role: entry.read_only_role,
                        sandbox_mode: entry.sandbox_mode,
                        target_paths: entry.resolved_target_paths.clone(),
                        allowed_builtin_tools: entry.allowed_builtin_tools.clone(),
                        allowed_mcp_servers: entry.allowed_mcp_servers.clone(),
                        allowed_skill_names: entry.allowed_skill_names.clone(),
                        provider: entry.provider,
                        model_id: entry.model_id.clone(),
                        reasoning_effort: entry.effective_reasoning_effort.clone(),
                        initial_messages: entry.messages.clone(),
                        todos: entry.todos.clone(),
                        harness_context: entry.harness_context.clone(),
                        cancel_token: cancel_token.clone(),
                    }
                };

                let outcome = executor.run_child_turn(turn_input).await;
                let was_cancelled = cancel_token.is_cancelled();

                let (updated_summary, role_prompt, msgs, todos, hctx, sb_mode) = {
                    let mut guard = state.lock();
                    let Some(entry) = guard.children.get_mut(&agent_id) else {
                        break;
                    };
                    entry.summary.updated_at = Utc::now().to_rfc3339();
                    match outcome {
                        Ok(res) => {
                            entry.messages = res.messages;
                            entry.latest_assistant_text = res.latest_assistant_text.clone();
                            entry.summary.last_message_preview = res
                                .latest_assistant_text
                                .as_deref()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(|s| s.chars().take(240).collect());
                            if entry.summary.lifecycle_state != "closed" {
                                if let Some(queued) = entry.pending_inputs.pop_front() {
                                    let tok = CancellationToken::new();
                                    entry.cancel_token = Some(tok.clone());
                                    entry.summary.execution_state = "running".to_owned();
                                    entry.summary.busy = true;
                                    next_prompt = Some((queued, tok));
                                } else {
                                    entry.cancel_token = None;
                                    entry.summary.execution_state = "completed".to_owned();
                                    entry.summary.busy = false;
                                }
                            }
                        }
                        Err(err) => {
                            if entry.summary.lifecycle_state != "closed" {
                                if let Some(queued) = entry.pending_inputs.pop_front() {
                                    let tok = CancellationToken::new();
                                    entry.cancel_token = Some(tok.clone());
                                    entry.summary.execution_state = "running".to_owned();
                                    entry.summary.busy = true;
                                    next_prompt = Some((queued, tok));
                                } else {
                                    entry.cancel_token = None;
                                    let is_int = was_cancelled
                                        || err.to_ascii_lowercase().contains("interrupted");
                                    entry.summary.execution_state = if is_int {
                                        "completed".to_owned()
                                    } else {
                                        "errored".to_owned()
                                    };
                                    entry.summary.busy = false;
                                }
                            }
                        }
                    }
                    (
                        entry.summary.clone(),
                        entry.role_prompt.clone(),
                        entry.messages.clone(),
                        entry.todos.clone(),
                        entry.harness_context.clone(),
                        entry.sandbox_mode,
                    )
                };

                let serialized_msgs: Vec<Value> = msgs
                    .iter()
                    .filter_map(|m| serde_json::to_value(m).ok())
                    .collect();
                let mutation = build_child_session_mutation(
                    &agent_cfg,
                    &updated_summary,
                    &role_prompt,
                    &serialized_msgs,
                    &todos,
                    hctx.as_ref(),
                    sb_mode,
                    "agent_status",
                );
                let _ = session_db.persist_session_mutation(mutation).await;

                (event_sink)(
                    "cowork/session/agentStatus",
                    json!({
                        "type": "agent_status",
                        "sessionId": parent_id,
                        "agent": updated_summary,
                    }),
                );
                status_bus.notify_waiters();
            }
        });
    }

    pub fn list(&self, include_closed: bool) -> Vec<PersistentAgentSummary> {
        let guard = self.state.lock();
        guard
            .children
            .values()
            .filter(|c| include_closed || c.summary.lifecycle_state != "closed")
            .map(|c| c.summary.clone())
            .collect()
    }

    pub async fn send_input(
        &self,
        agent_id: &str,
        message: &str,
        interrupt: bool,
    ) -> Result<PersistentAgentSummary, String> {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err("Message must not be empty.".to_owned());
        }

        let mut launch_now: Option<(String, CancellationToken)> = None;
        let summary = {
            let mut guard = self.state.lock();
            let is_currently_running = guard
                .children
                .get(agent_id)
                .map(|c| {
                    matches!(
                        c.summary.execution_state.as_str(),
                        "pending_init" | "running"
                    )
                })
                .unwrap_or(false);
            if !is_currently_running
                && guard.active_or_reserved_count() >= MAX_ACTIVE_CHILDREN_PER_PARENT
            {
                return Err(format!(
                    "Maximum active child agents per parent ({MAX_ACTIVE_CHILDREN_PER_PARENT}) reached."
                ));
            }

            let entry = guard
                .children
                .get_mut(agent_id)
                .ok_or_else(|| format!("Child agent '{agent_id}' not found."))?;
            if entry.summary.lifecycle_state == "closed" {
                return Err(format!(
                    "Child agent '{agent_id}' is closed. Call resumeAgent first."
                ));
            }
            if is_currently_running {
                entry.pending_inputs.push_back(trimmed.to_owned());
                if interrupt && let Some(ref tok) = entry.cancel_token {
                    tok.cancel();
                }
            } else {
                let tok = CancellationToken::new();
                entry.cancel_token = Some(tok.clone());
                entry.summary.execution_state = "running".to_owned();
                entry.summary.busy = true;
                entry.summary.updated_at = Utc::now().to_rfc3339();
                launch_now = Some((trimmed.to_owned(), tok));
            }
            entry.summary.clone()
        };

        if let Some((prompt, tok)) = launch_now {
            self.emit_event(
                "cowork/session/agentStatus",
                json!({
                    "type": "agent_status",
                    "sessionId": self.cfg.parent_session_id,
                    "agent": summary,
                }),
            );
            self.launch_turn_loop(agent_id.to_owned(), prompt, tok);
        }
        Ok(summary)
    }

    pub async fn wait(
        &self,
        agent_ids: &[String],
        timeout_ms: Option<u64>,
        mode: Option<&str>,
        include_final_message: bool,
        include_report: bool,
    ) -> Result<AgentWaitOutcome, String> {
        let wait_mode = match mode.unwrap_or("any") {
            "all" => "all",
            "any" => "any",
            other => {
                return Err(format!(
                    "Invalid wait mode '{other}'; expected 'any' or 'all'."
                ));
            }
        };
        let target_ids: Vec<String> = if agent_ids.is_empty() {
            self.list(false).into_iter().map(|s| s.agent_id).collect()
        } else {
            agent_ids.to_vec()
        };

        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1, 300_000));
        let mut timed_out = false;

        loop {
            let notified = self.status_bus.notified();
            let satisfied = {
                let guard = self.state.lock();
                if target_ids.is_empty() {
                    true
                } else {
                    let settled_count = target_ids
                        .iter()
                        .filter(|id| {
                            guard.children.get(*id).is_some_and(|c| {
                                !matches!(
                                    c.summary.execution_state.as_str(),
                                    "pending_init" | "running"
                                )
                            })
                        })
                        .count();
                    if wait_mode == "all" {
                        settled_count == target_ids.len()
                    } else {
                        settled_count >= 1
                    }
                }
            };
            if satisfied {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                timed_out = true;
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                timed_out = true;
                break;
            }
        }

        let mut agents = Vec::new();
        let mut ready_ids = Vec::new();
        let mut errored_ids = Vec::new();
        let mut inspections = (include_final_message || include_report).then(Vec::new);

        {
            let guard = self.state.lock();
            for id in &target_ids {
                if let Some(entry) = guard.children.get(id) {
                    agents.push(entry.summary.clone());
                    match entry.summary.execution_state.as_str() {
                        "completed" => ready_ids.push(id.clone()),
                        "errored" => errored_ids.push(id.clone()),
                        _ => {}
                    }
                    if let Some(ref mut insp_vec) = inspections {
                        let report_insp = if include_report {
                            inspect_child_agent_report(
                                entry.latest_assistant_text.as_deref(),
                                entry.report_required,
                            )
                        } else {
                            ChildReportInspection::default()
                        };
                        insp_vec.push(AgentWaitInspection {
                            agent_id: entry.summary.agent_id.clone(),
                            latest_assistant_text: if include_final_message {
                                entry.latest_assistant_text.clone()
                            } else {
                                None
                            },
                            parsed_report: report_insp.parsed_report,
                            report_required: report_insp.report_required,
                            report_found: report_insp.report_found,
                            report_valid: report_insp.report_valid,
                            report_block_count: report_insp.report_block_count,
                            report_diagnostic: report_insp.report_diagnostic,
                        });
                    }
                }
            }
        }

        let outcome = AgentWaitOutcome {
            session_id: self.cfg.parent_session_id.clone(),
            agent_ids: target_ids,
            timed_out,
            mode: wait_mode.to_owned(),
            agents,
            ready_agent_ids: ready_ids,
            errored_agent_ids: errored_ids,
            inspections,
        };
        let mut wait_evt = json!({
            "type": "agent_wait_result",
            "sessionId": outcome.session_id,
            "agentIds": outcome.agent_ids,
            "timedOut": outcome.timed_out,
            "mode": outcome.mode,
            "agents": outcome.agents,
            "readyAgentIds": outcome.ready_agent_ids,
            "erroredAgentIds": outcome.errored_agent_ids,
        });
        if let Some(ref insps) = outcome.inspections
            && let Some(obj) = wait_evt.as_object_mut()
        {
            obj.insert("inspections".to_owned(), json!(insps));
        }
        self.emit_event("cowork/session/agentWaitResult", wait_evt);
        Ok(outcome)
    }

    pub fn inspect(&self, agent_id: &str) -> Result<AgentInspectionPayload, String> {
        let guard = self.state.lock();
        let entry = guard
            .children
            .get(agent_id)
            .ok_or_else(|| format!("Child agent '{agent_id}' not found."))?;
        let report_insp = inspect_child_agent_report(
            entry.latest_assistant_text.as_deref(),
            entry.report_required,
        );
        Ok(AgentInspectionPayload {
            agent: entry.summary.clone(),
            latest_assistant_text: entry.latest_assistant_text.clone(),
            parsed_report: report_insp.parsed_report,
            report_required: report_insp.report_required,
            report_found: report_insp.report_found,
            report_valid: report_insp.report_valid,
            report_block_count: report_insp.report_block_count,
            report_diagnostic: report_insp.report_diagnostic,
            session_usage: entry.summary.session_usage.clone(),
            last_turn_usage: entry.summary.last_turn_usage.clone(),
        })
    }

    pub async fn resume(&self, agent_id: &str) -> Result<PersistentAgentSummary, String> {
        let (summary, role_prompt, msgs, todos, hctx, sb_mode) = {
            let mut guard = self.state.lock();
            let entry = guard
                .children
                .get_mut(agent_id)
                .ok_or_else(|| format!("Child agent '{agent_id}' not found."))?;
            entry.summary.lifecycle_state = "active".to_owned();
            if entry.summary.execution_state == "closed" {
                entry.summary.execution_state = "completed".to_owned();
            }
            entry.summary.busy = false;
            entry.summary.updated_at = Utc::now().to_rfc3339();
            (
                entry.summary.clone(),
                entry.role_prompt.clone(),
                entry.messages.clone(),
                entry.todos.clone(),
                entry.harness_context.clone(),
                entry.sandbox_mode,
            )
        };
        let serialized: Vec<Value> = msgs
            .iter()
            .filter_map(|m| serde_json::to_value(m).ok())
            .collect();
        let mutation = build_child_session_mutation(
            &self.cfg.agent_config,
            &summary,
            &role_prompt,
            &serialized,
            &todos,
            hctx.as_ref(),
            sb_mode,
            "agent_resumed",
        );
        let _ = self.cfg.session_db.persist_session_mutation(mutation).await;

        self.emit_event(
            "cowork/session/agentStatus",
            json!({
                "type": "agent_status",
                "sessionId": self.cfg.parent_session_id,
                "agent": summary,
            }),
        );
        self.emit_agent_list();
        Ok(summary)
    }

    pub async fn close(&self, agent_id: &str) -> Result<PersistentAgentSummary, String> {
        let (summary, role_prompt, msgs, todos, hctx, sb_mode) = {
            let mut guard = self.state.lock();
            let entry = guard
                .children
                .get_mut(agent_id)
                .ok_or_else(|| format!("Child agent '{agent_id}' not found."))?;
            entry.pending_inputs.clear();
            if let Some(tok) = entry.cancel_token.take() {
                tok.cancel();
            }
            entry.summary.lifecycle_state = "closed".to_owned();
            entry.summary.execution_state = "closed".to_owned();
            entry.summary.busy = false;
            entry.summary.updated_at = Utc::now().to_rfc3339();
            (
                entry.summary.clone(),
                entry.role_prompt.clone(),
                entry.messages.clone(),
                entry.todos.clone(),
                entry.harness_context.clone(),
                entry.sandbox_mode,
            )
        };
        let serialized: Vec<Value> = msgs
            .iter()
            .filter_map(|m| serde_json::to_value(m).ok())
            .collect();
        let mutation = build_child_session_mutation(
            &self.cfg.agent_config,
            &summary,
            &role_prompt,
            &serialized,
            &todos,
            hctx.as_ref(),
            sb_mode,
            "agent_closed",
        );
        let _ = self.cfg.session_db.persist_session_mutation(mutation).await;

        self.status_bus.notify_waiters();
        self.emit_event(
            "cowork/session/agentStatus",
            json!({
                "type": "agent_status",
                "sessionId": self.cfg.parent_session_id,
                "agent": summary,
            }),
        );
        self.emit_agent_list();
        Ok(summary)
    }

    pub fn interrupt_running_children(&self) -> usize {
        let mut count = 0usize;
        let guard = self.state.lock();
        for entry in guard.children.values() {
            if let Some(ref tok) = entry.cancel_token
                && !tok.is_cancelled()
            {
                tok.cancel();
                count += 1;
            }
        }
        count
    }

    fn emit_event(&self, method: &str, payload: Value) {
        (self.event_sink)(method, payload);
    }

    pub fn emit_agent_list(&self) {
        let agents = self.list(true);
        self.emit_event(
            "cowork/session/agentList",
            json!({
                "type": "agent_list",
                "sessionId": self.cfg.parent_session_id,
                "agents": agents,
            }),
        );
    }
}

#[async_trait]
impl AgentControlBridge for AgentControl {
    async fn spawn_agent(&self, _parent_session_id: &str, params: Value) -> Result<Value, String> {
        let message = params
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let (parent_msgs, parent_todos, parent_hctx) = self
            .parent_snapshot_provider
            .lock()
            .as_ref()
            .map(|f| f())
            .unwrap_or_default();

        let req = AgentSpawnRequest {
            message,
            role: params
                .get("role")
                .and_then(Value::as_str)
                .map(str::to_owned),
            profile_ref: params
                .get("profile")
                .or_else(|| params.get("profileRef"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            model: params
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            reasoning_effort: params
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .map(str::to_owned),
            nickname: params
                .get("nickname")
                .and_then(Value::as_str)
                .map(str::to_owned),
            task_type: params
                .get("taskType")
                .and_then(Value::as_str)
                .map(str::to_owned),
            target_paths: params
                .get("targetPaths")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                }),
            context_mode: params
                .get("contextMode")
                .and_then(Value::as_str)
                .map(str::to_owned),
            briefing: params
                .get("briefing")
                .and_then(Value::as_str)
                .map(str::to_owned),
            include_parent_todos: params
                .get("includeParentTodos")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            include_harness_context: params
                .get("includeHarnessContext")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            fork_context: params
                .get("forkContext")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };

        let summary = self
            .spawn(req, &parent_msgs, &parent_todos, parent_hctx.as_ref())
            .await?;
        serde_json::to_value(summary).map_err(|e| e.to_string())
    }

    async fn list_agents(&self, _parent_session_id: &str, params: Value) -> Result<Value, String> {
        let include_closed = params
            .get("includeClosed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(json!({ "agents": self.list(include_closed) }))
    }

    async fn send_agent_input(
        &self,
        _parent_session_id: &str,
        params: Value,
    ) -> Result<Value, String> {
        let agent_id = params
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing agentId".to_owned())?;
        let message = params
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing message".to_owned())?;
        let interrupt = params
            .get("interrupt")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let summary = self.send_input(agent_id, message, interrupt).await?;
        serde_json::to_value(summary).map_err(|e| e.to_string())
    }

    async fn wait_for_agent(
        &self,
        _parent_session_id: &str,
        params: Value,
    ) -> Result<Value, String> {
        let agent_ids: Vec<String> = params
            .get("agentIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64);
        let mode = params.get("mode").and_then(Value::as_str);
        let include_final = params
            .get("includeFinalMessage")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let include_report = params
            .get("includeReport")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let res = self
            .wait(&agent_ids, timeout_ms, mode, include_final, include_report)
            .await?;
        serde_json::to_value(res).map_err(|e| e.to_string())
    }

    async fn inspect_agent(
        &self,
        _parent_session_id: &str,
        params: Value,
    ) -> Result<Value, String> {
        let agent_id = params
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing agentId".to_owned())?;
        let insp = self.inspect(agent_id)?;
        serde_json::to_value(insp).map_err(|e| e.to_string())
    }

    async fn resume_agent(&self, _parent_session_id: &str, params: Value) -> Result<Value, String> {
        let agent_id = params
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing agentId".to_owned())?;
        let summary = self.resume(agent_id).await?;
        serde_json::to_value(summary).map_err(|e| e.to_string())
    }

    async fn close_agent(&self, _parent_session_id: &str, params: Value) -> Result<Value, String> {
        let agent_id = params
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing agentId".to_owned())?;
        let summary = self.close(agent_id).await?;
        serde_json::to_value(summary).map_err(|e| e.to_string())
    }
}

struct PreparedChildSpawn {
    role_spec: &'static BuiltinAgentRoleSpec,
    resolved_profile: Option<AgentProfileSnapshot>,
    effective_tools: BTreeSet<String>,
    allowed_mcp: Option<BTreeSet<String>>,
    allowed_skills: Option<BTreeSet<String>>,
    resolved_targets: Option<Vec<PathBuf>>,
    wire_targets: Option<Vec<String>>,
    initial_messages: Vec<CanonicalMessage>,
    todos: Vec<Value>,
    harness_ctx: Option<Value>,
    model_sel: ResolvedChildModel,
    sandbox_mode: SandboxMode,
    role_prompt: String,
    effective_task_type: Option<String>,
}

fn make_canonical_user_message(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
            phase: None,
            citations: Vec::new(),
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: Utc::now().to_rfc3339(),
    }
}

fn execution_state_to_wire(state: AgentExecutionState) -> &'static str {
    match state {
        AgentExecutionState::PendingInit => "pending_init",
        AgentExecutionState::Running => "running",
        AgentExecutionState::Completed | AgentExecutionState::Interrupted => "completed",
        AgentExecutionState::Errored => "errored",
        AgentExecutionState::Closed => "closed",
    }
}

fn wire_to_execution_state(raw: &str) -> AgentExecutionState {
    match raw {
        "pending_init" => AgentExecutionState::PendingInit,
        "running" => AgentExecutionState::Running,
        "completed" => AgentExecutionState::Completed,
        "closed" => AgentExecutionState::Closed,
        _ => AgentExecutionState::Errored,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_child_session_mutation(
    cfg: &AgentConfig,
    summary: &PersistentAgentSummary,
    system_prompt: &str,
    serialized_messages: &[Value],
    todos: &[Value],
    harness_context: Option<&Value>,
    sandbox_mode: SandboxMode,
    event_type: &str,
) -> PersistedSessionMutation {
    let provider = ProviderName::parse(&summary.provider).unwrap_or(cfg.provider);
    let model_id = summary
        .effective_model
        .split_once(':')
        .map(|(_, m)| m.to_owned())
        .unwrap_or_else(|| summary.effective_model.clone());
    PersistedSessionMutation {
        session_id: summary.agent_id.clone(),
        event_type: event_type.to_owned(),
        event_ts: Some(summary.updated_at.clone()),
        direction: Some("internal".to_owned()),
        payload: None,
        snapshot: PersistedSessionSnapshotData {
            session_kind: SessionKind::Agent,
            parent_session_id: Some(summary.parent_session_id.clone()),
            role: Some(summary.role.clone()),
            mode: Some(summary.mode.clone()),
            depth: Some(i64::from(summary.depth)),
            nickname: summary.nickname.clone(),
            task_type: summary.task_type.clone(),
            target_paths: summary.target_paths.clone(),
            profile: summary
                .profile
                .as_ref()
                .and_then(|p| serde_json::to_value(p).ok()),
            requested_model: summary.requested_model.clone(),
            effective_model: Some(summary.effective_model.clone()),
            requested_reasoning_effort: summary.requested_reasoning_effort.clone(),
            effective_reasoning_effort: summary.effective_reasoning_effort.clone(),
            execution_state: Some(wire_to_execution_state(&summary.execution_state)),
            last_message_preview: summary.last_message_preview.clone(),
            title: summary.title.clone(),
            title_source: SessionTitleSource::Default,
            title_model: None,
            provider,
            model: model_id,
            working_directory: cfg.working_directory.to_string_lossy().into_owned(),
            output_directory: cfg
                .output_directory
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            uploads_directory: cfg
                .uploads_directory
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            provider_options: None,
            sandbox: Some(SandboxConfig {
                mode: sandbox_mode,
                network: cfg.sandbox.network,
                require_backend: cfg.sandbox.require_backend,
            }),
            enable_mcp: cfg.enable_mcp,
            backups_enabled_override: None,
            created_at: summary.created_at.clone(),
            updated_at: summary.updated_at.clone(),
            status: if summary.lifecycle_state == "closed" {
                SessionPersistenceStatus::Closed
            } else {
                SessionPersistenceStatus::Active
            },
            has_pending_ask: false,
            has_pending_approval: false,
            system_prompt: system_prompt.to_owned(),
            messages: serialized_messages.to_vec(),
            last_memory_generated_index: None,
            provider_state: None,
            todos: todos.to_vec(),
            harness_context: harness_context.cloned(),
            cost_tracker: None,
        },
    }
}
