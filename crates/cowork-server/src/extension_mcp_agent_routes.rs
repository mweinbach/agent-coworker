use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::{
    AgentConfig, ProviderName, canonicalize_sync, get_ai_coworker_paths, read_connection_store,
};
use cowork_harness::agents::profiles::AgentProfileUpsertInput;
use cowork_harness::extensions::types::MarketplaceSourceInput;
use cowork_harness::{
    AgentControl, AgentControlConfig, AgentProfileScope, AgentProfilesStore, AgentSpawnRequest,
    ChildTurnExecutor, ChildTurnInput, ChildTurnResult, ExtensionManager, HarnessEventSink,
    InteractionManager, SkillMutationBus, SteerCoordinator, SystemPromptBuildOptions,
    TurnRunConfig, TurnStepRunner, build_layered_system_prompt,
};
use cowork_inference::{BudgetThresholds, ContentBlock, MessageRole, SessionCostTracker};
use cowork_mcp::{
    McpConfigSource, McpOAuthChallengeResult, McpServerConfig, complete_mcp_oauth_callback,
    delete_mcp_server, read_mcp_servers_snapshot, set_mcp_server_api_key, set_mcp_server_enabled,
    start_mcp_oauth_authorization, upsert_mcp_server, validate_mcp_server_with_env,
    wait_and_complete_auto_mcp_oauth,
};
use cowork_protocol::{
    JsonRpcLiteError, JsonRpcLiteNotification, JsonRpcLiteOutbound, error_codes,
};
use cowork_providers::bedrock::{extract_bedrock_region_override, resolve_bedrock_auth_config};
use cowork_providers::chat_completions::lmstudio::resolve_lmstudio_options;
use cowork_providers::resolve_provider_api_key;
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxPolicy, resolve_sandbox_policy, scratch_roots,
};
use cowork_storage::SessionKind;
use cowork_tools::{ApprovalHandler, ToolExecutionContext, discover_skills_for_config};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::registry::{LiveSession, ServerRuntimeState};
use crate::turn_runner::{
    ActiveTurnControl, build_memory_prompt_section, new_canonical_message, new_text_block,
    parse_stored_canonical_messages, select_provider_transport,
};

struct ChildActiveTurnGuard {
    runtime: Arc<ServerRuntimeState>,
    agent_id: String,
    turn_id: String,
}

impl Drop for ChildActiveTurnGuard {
    fn drop(&mut self) {
        self.runtime
            .active_turns
            .remove_if(&self.agent_id, |_, ctrl| ctrl.turn_id == self.turn_id);
        self.runtime.turn_settled_notify.notify_waiters();
    }
}

const CHILD_MAX_TURN_STEPS: usize = 60;
const CHILD_STEP_TIMEOUT_MS: u64 = 180_000;

struct NoopChildEventSink;

impl HarnessEventSink for NoopChildEventSink {
    fn send_notification(&self, _method: &str, _params: Value) {}
    fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
}

struct ServerChildTurnExecutor {
    runtime: Weak<ServerRuntimeState>,
}

#[async_trait]
impl ChildTurnExecutor for ServerChildTurnExecutor {
    async fn run_child_turn(&self, input: ChildTurnInput) -> Result<ChildTurnResult, String> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| "Server runtime has shut down.".to_owned())?;

        let parent_cwd = runtime
            .get_live_thread(&input.parent_session_id)
            .map(|l| PathBuf::from(l.lock().cwd.clone()))
            .or_else(|| {
                runtime
                    .session_db
                    .get_session_record(&input.parent_session_id)
                    .ok()
                    .flatten()
                    .map(|r| PathBuf::from(r.working_directory))
            })
            .unwrap_or_else(|| runtime.working_directory.clone());
        let canonical_cwd = canonicalize_sync(&parent_cwd);
        let output_dir = canonical_cwd.join("output");
        let uploads_dir = canonical_cwd.join("uploads");

        let mut agent_cfg = runtime
            .load_workspace_config(&canonical_cwd)
            .map_err(|e| e.to_string())?;
        agent_cfg.provider = input.provider;
        agent_cfg.model = input.model_id.clone();
        agent_cfg.sandbox.mode = input.sandbox_mode;

        let mut merged_provider_opts = agent_cfg.provider_options.clone().unwrap_or_default();
        if let Some(ref effort) = input.reasoning_effort {
            let sub = merged_provider_opts
                .entry(input.provider.as_str().to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(sub_map) = sub.as_object_mut() {
                sub_map.insert("reasoningEffort".to_owned(), Value::String(effort.clone()));
            }
        }

        let paths = get_ai_coworker_paths(Some(&runtime.homedir), &runtime.env);
        merged_provider_opts.insert(
            "coworkHome".to_owned(),
            Value::String(paths.root_dir.to_string_lossy().into_owned()),
        );
        merged_provider_opts.insert(
            "cwd".to_owned(),
            Value::String(canonical_cwd.to_string_lossy().into_owned()),
        );
        agent_cfg.provider_options = Some(merged_provider_opts.clone());

        let conn_store = read_connection_store(&paths).await.ok();
        let api_key = resolve_provider_api_key(input.provider, conn_store.as_ref(), &runtime.env);
        let bedrock_auth = if input.provider == ProviderName::Bedrock {
            let mut auth =
                resolve_bedrock_auth_config(&runtime.homedir, &runtime.env, conn_store.as_ref());
            if let (Some(reg), Some(cfg)) = (
                extract_bedrock_region_override(&merged_provider_opts),
                auth.as_mut(),
            ) {
                cfg.region = reg;
                cfg.has_configured_region = true;
            }
            auth
        } else {
            None
        };

        let base_url = match input.provider {
            ProviderName::Lmstudio => {
                let lms = resolve_lmstudio_options(&runtime.env, Some(&merged_provider_opts), None);
                Some(lms.inference_base_url)
            }
            other => {
                let env_key = match other {
                    ProviderName::Google => "GEMINI_BASE_URL".to_owned(),
                    ProviderName::Bedrock => "AWS_BEDROCK_ENDPOINT_URL".to_owned(),
                    p => format!(
                        "{}_BASE_URL",
                        p.as_str().to_ascii_uppercase().replace('-', "_")
                    ),
                };
                merged_provider_opts
                    .get(other.as_str())
                    .and_then(Value::as_object)
                    .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
                    .or_else(|| {
                        merged_provider_opts
                            .get("baseUrl")
                            .or_else(|| merged_provider_opts.get("base_url"))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        runtime
                            .env
                            .get(&env_key)
                            .map(String::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    })
            }
        };

        let mut available_skills = discover_skills_for_config(&agent_cfg);
        if let Some(ref allow_skills) = input.allowed_skill_names {
            available_skills.retain(|name, _| allow_skills.contains(name));
        }

        let sqlite_mem = runtime.memory_store_for_workspace(&canonical_cwd);
        let adv_mem = runtime.advanced_memory_store_for_workspace(&canonical_cwd);
        let memory_section = agent_cfg
            .enable_memory
            .then(|| build_memory_prompt_section(&sqlite_mem, &adv_mem, agent_cfg.advanced_memory))
            .flatten();

        let target_path_strings = input.target_paths.as_ref().map(|paths| {
            paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        });
        let sandbox_policy = resolve_sandbox_policy(&ResolveSandboxPolicyInput {
            config: Some(agent_cfg.sandbox.clone()),
            working_directory: canonical_cwd.clone(),
            project_root: Some(canonical_cwd.clone()),
            output_directory: Some(output_dir.clone()),
            uploads_directory: Some(uploads_dir.clone()),
            tool_runtime_writable_roots: scratch_roots(None),
            target_paths: target_path_strings,
            read_only_role: input.read_only_role,
            yolo: runtime.yolo,
            platform: None,
        });
        let (sandbox_mode_label, network_enabled) = match &sandbox_policy {
            SandboxPolicy::DangerFullAccess { network } => {
                ("danger-full-access".to_owned(), network.unwrap_or(true))
            }
            SandboxPolicy::ReadOnly { network } => ("read-only".to_owned(), *network),
            SandboxPolicy::NoProjectWrite { network, .. } => {
                ("no-project-write".to_owned(), *network)
            }
            SandboxPolicy::WorkspaceWrite { network, .. } => {
                ("workspace-write".to_owned(), *network)
            }
        };

        let deferred_tool_search = merged_provider_opts
            .get("deferredToolSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let overflow_threshold = agent_cfg.tool_output_overflow_chars.map(|n| n as usize);

        let prompts_dir = runtime.built_in_dir.join("prompts");
        let system_prompt = build_layered_system_prompt(&SystemPromptBuildOptions {
            prompts_dir: prompts_dir.is_dir().then_some(prompts_dir),
            prompt_template: Some(input.role_prompt.clone()),
            working_directory: canonical_cwd.clone(),
            output_directory: output_dir.clone(),
            uploads_directory: uploads_dir.clone(),
            cowork_home: paths.root_dir.clone(),
            provider: input.provider,
            model: input.model_id.clone(),
            sandbox_mode_label,
            network_enabled,
            available_skills,
            memory_section,
            workspace_context: None,
            harness_context: input.harness_context.clone(),
            task_context_section: None,
            referenced_plugins: Vec::new(),
            deferred_tool_search_enabled: deferred_tool_search,
            code_mode_enabled: false,
        });

        let turn_id = Uuid::new_v4().to_string();
        let runner = TurnStepRunner::new(TurnRunConfig {
            thread_id: input.agent_id.clone(),
            turn_id: turn_id.clone(),
            provider: input.provider,
            model_id: input.model_id.clone(),
            base_url,
            api_key,
            extra_headers: HashMap::new(),
            system_prompt,
            provider_options: merged_provider_opts.clone(),
            deferred_tool_search,
            max_steps: CHILD_MAX_TURN_STEPS,
            step_timeout_ms: CHILD_STEP_TIMEOUT_MS,
            overflow_threshold_chars: overflow_threshold,
            tool_retry_lineage: false,
            initial_user_message: Some((input.prompt.clone(), None)),
        });

        let cancel_handle = runner.cancellation_handle();
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let cancel_tok = input.cancel_token.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel_tok.cancelled() => {
                    cancel_handle.interrupt("Child agent turn interrupted");
                }
                _ = done_rx => {}
            }
        });

        let noop_sink: Arc<dyn HarnessEventSink> = Arc::new(NoopChildEventSink);
        let child_im = Arc::new(InteractionManager::new(
            &input.agent_id,
            Arc::clone(&noop_sink),
        ));
        let child_steer = Arc::new(SteerCoordinator::new(
            &input.agent_id,
            &turn_id,
            Arc::clone(&noop_sink),
            None,
        ));
        runtime.active_turns.insert(
            input.agent_id.clone(),
            ActiveTurnControl {
                turn_id: turn_id.clone(),
                cancel: runner.cancellation_handle(),
                steer: Arc::clone(&child_steer),
                interactions: Arc::clone(&child_im),
            },
        );
        let _active_turn_guard = ChildActiveTurnGuard {
            runtime: Arc::clone(&runtime),
            agent_id: input.agent_id.clone(),
            turn_id: turn_id.clone(),
        };

        let parent_approval: Option<Arc<dyn ApprovalHandler>> = if runtime.yolo {
            None
        } else {
            runtime
                .interaction_managers
                .get(&input.parent_session_id)
                .map(|im| Arc::clone(im.value()) as Arc<dyn ApprovalHandler>)
        };

        let mut tool_env = runtime.effective_tool_env();
        tool_env.insert(
            "HOME".to_owned(),
            runtime.homedir.to_string_lossy().into_owned(),
        );
        tool_env.insert(
            "COWORK_HOME_OVERRIDE".to_owned(),
            paths.root_dir.to_string_lossy().into_owned(),
        );

        let rt_for_child_lock = Arc::clone(&runtime);
        let parent_sid_for_lock = input.parent_session_id.clone();
        let child_aid_for_lock = input.agent_id.clone();
        let child_before_tool: cowork_tools::BeforeToolInvocationHook =
            Arc::new(move |tool_name: &str| {
                if let Some(lock) = rt_for_child_lock
                    .get_session_task_lock(&child_aid_for_lock)
                    .or_else(|| rt_for_child_lock.get_session_task_lock(&parent_sid_for_lock))
                {
                    return Err(crate::task_routes::format_tool_task_lock_error(
                        tool_name, &lock,
                    ));
                }
                Ok(())
            });

        let bundled_skills_dir = runtime.built_in_dir.join("skills");
        let mut tool_ctx = ToolExecutionContext {
            session_id: input.agent_id.clone(),
            session_kind: SessionKind::Agent,
            homedir: runtime.homedir.clone(),
            cowork_home: paths.root_dir.clone(),
            working_directory: canonical_cwd,
            output_directory: output_dir,
            uploads_directory: uploads_dir,
            lock_root: paths.root_dir.join("locks").join("files"),
            env: tool_env,
            provider: input.provider,
            model: input.model_id.clone(),
            provider_options: merged_provider_opts,
            sandbox_config: agent_cfg.sandbox.clone(),
            sandbox_policy,
            read_roots: vec![runtime.built_in_dir.clone(), paths.root_dir.clone()],
            yolo: runtime.yolo,
            read_only_role: input.read_only_role,
            target_paths: input.target_paths,
            advanced_memory: agent_cfg.advanced_memory,
            bundled_skills_dir: bundled_skills_dir.is_dir().then_some(bundled_skills_dir),
            built_in_dir: Some(runtime.built_in_dir.clone()),
            approval_handler: parent_approval,
            thread_control: None,
            agent_control: None,
            task_bridge: None,
            cost_tracker_bridge: None,
            on_workflow_progress: None,
            in_task_context: false,
            stop_after_step: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            before_tool_invocation: Some(child_before_tool),
            agent_config: Some(Arc::new(agent_cfg)),
            mcp_tool_cache: Some(Arc::clone(&runtime.mcp_tool_cache)),
            can_ask_user: false,
            allowed_builtin_tools: Some(input.allowed_builtin_tools),
            allowed_mcp_servers: input.allowed_mcp_servers,
            allowed_skill_names: input.allowed_skill_names,
            session_db: Some(Arc::clone(&runtime.session_db)),
            memory_store: Some(Arc::new(sqlite_mem)),
            advanced_memory_store: Some(Arc::new(adv_mem)),
            on_todos_updated: None,
            cancel_rx: None,
            dns_override_for_tests: None,
        };

        let transport = select_provider_transport(
            input.provider,
            bedrock_auth,
            &runtime.homedir,
            &runtime.env,
            Some((&tool_ctx, &child_im, &child_steer, overflow_threshold)),
        )?;

        let mut history = input.initial_messages;
        history.push(new_canonical_message(
            MessageRole::User,
            vec![new_text_block(&input.prompt)],
        ));

        let mut cost_tracker = SessionCostTracker::new(
            &input.agent_id,
            Some(BudgetThresholds {
                warn_at_usd: None,
                stop_at_usd: None,
            }),
        );

        let outcome = runner
            .run_turn(
                transport,
                history,
                &mut tool_ctx,
                &child_im,
                &child_steer,
                &mut cost_tracker,
                None,
                noop_sink,
            )
            .await;
        let _ = done_tx.send(());

        if outcome.status == "interrupted" {
            return Err("Child agent turn interrupted.".to_owned());
        }
        if outcome.status == "failed" {
            return Err("Child agent turn failed.".to_owned());
        }

        let latest_assistant_text = outcome.last_assistant_text.or_else(|| {
            outcome
                .messages
                .iter()
                .rev()
                .find(|m| m.role == MessageRole::Assistant)
                .map(|m| {
                    m.content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text, .. } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|s| !s.trim().is_empty())
        });

        Ok(ChildTurnResult {
            messages: outcome.messages,
            latest_assistant_text,
            usage: outcome.usage,
        })
    }
}

impl ServerRuntimeState {
    pub fn extension_manager(&self) -> ExtensionManager {
        let mut env = self.effective_tool_env();
        env.insert(
            "HOME".to_owned(),
            self.homedir.to_string_lossy().into_owned(),
        );
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        env.insert(
            "COWORK_HOME_OVERRIDE".to_owned(),
            paths.root_dir.to_string_lossy().into_owned(),
        );
        ExtensionManager::new(env)
    }

    pub fn ensure_skill_mutation_bus(self: &Arc<Self>) -> Option<Arc<SkillMutationBus>> {
        {
            let guard = self.skill_mutation_bus.lock();
            if let Some(ref existing) = *guard {
                return Some(Arc::clone(existing));
            }
        }
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let weak_rt = Arc::downgrade(self);
        let tokio_handle = tokio::runtime::Handle::try_current().ok();

        let bus = SkillMutationBus::start(&paths.root_dir, &[], move |_rev| {
            let Some(rt) = weak_rt.upgrade() else {
                return;
            };
            let Some(ref handle) = tokio_handle else {
                return;
            };
            let ticket = rt.skill_watcher_seq.fetch_add(1, Ordering::SeqCst) + 1;
            handle.spawn(async move {
                tokio::time::sleep(Duration::from_millis(35)).await;
                if rt.skill_watcher_seq.load(Ordering::SeqCst) != ticket {
                    return;
                }
                rt.broadcast_all_workspace_control_refreshes().await;
            });
        })
        .ok()?;

        bus.watch_workspace(&self.working_directory);
        let mut guard = self.skill_mutation_bus.lock();
        if let Some(ref existing) = *guard {
            bus.stop();
            return Some(Arc::clone(existing));
        }
        *guard = Some(Arc::clone(&bus));
        Some(bus)
    }

    pub(crate) fn subscribe_workspace_control(self: &Arc<Self>, connection_id: &str, cwd: &Path) {
        let key = cwd.to_string_lossy().into_owned();
        self.workspace_subscribers
            .entry(key)
            .or_default()
            .insert(connection_id.to_owned());
        if let Some(bus) = self.ensure_skill_mutation_bus() {
            bus.watch_workspace(cwd);
        }
    }

    pub(crate) fn subscribe_workspace_control_bg(
        self: &Arc<Self>,
        connection_id: &str,
        cwd: &Path,
    ) {
        let key = cwd.to_string_lossy().into_owned();
        self.workspace_subscribers
            .entry(key)
            .or_default()
            .insert(connection_id.to_owned());
        if let Some(ref existing) = *self.skill_mutation_bus.lock() {
            let bus = Arc::clone(existing);
            let cwd_owned = cwd.to_path_buf();
            tokio::task::spawn_blocking(move || {
                bus.watch_workspace(&cwd_owned);
            });
            return;
        }
        let rt = Arc::clone(self);
        let cwd_owned = cwd.to_path_buf();
        let tokio_handle = tokio::runtime::Handle::try_current().ok();
        tokio::task::spawn_blocking(move || {
            let _guard = tokio_handle.as_ref().map(|h| h.enter());
            if let Some(bus) = rt.ensure_skill_mutation_bus() {
                bus.watch_workspace(&cwd_owned);
            }
        });
    }

    pub(crate) fn workspace_mutation_block_reason(&self, cwd: &Path) -> Option<String> {
        let cwd_str = cwd.to_string_lossy();
        for entry in self.sessions.iter() {
            let id = entry.key().clone();
            let (is_cwd, busy) = {
                let live = entry.value().lock();
                (live.cwd == cwd_str, live.busy)
            };
            if !is_cwd {
                continue;
            }
            if busy || self.active_turns.contains_key(&id) {
                return Some(
                    "Skills and plugins cannot be modified while a turn is active in this workspace."
                        .to_owned(),
                );
            }
            if let Some(ctrl) = self.agent_controls.get(&id)
                && ctrl.list(false).iter().any(|a| a.busy)
            {
                return Some(
                    "Skills and plugins cannot be modified while a child agent is running in this workspace."
                        .to_owned(),
                );
            }
        }
        None
    }

    pub(crate) fn broadcast_control_event(&self, cwd: &Path, event: &Value) {
        let key = cwd.to_string_lossy().into_owned();
        let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
            method: "cowork/control/event".to_owned(),
            params: Some(event.clone()),
        });
        if let Some(subs) = self.workspace_subscribers.get(&key) {
            for cid in subs.value().iter() {
                self.send_to_connection(cid, &outbound);
            }
        }
    }

    pub async fn broadcast_workspace_control_refresh(self: &Arc<Self>, cwd: &Path) {
        let Ok(cfg) = self.load_workspace_config(cwd) else {
            return;
        };
        let session_id = self.get_or_create_workspace_state_id(cwd);
        let ext = self.extension_manager();

        let skills = ext.list_effective_skills(&cfg);
        self.broadcast_control_event(
            cwd,
            &json!({
                "type": "skills_list",
                "sessionId": session_id,
                "skills": skills,
            }),
        );

        if let Ok((catalog, partial)) = ext.read_skills_catalog_with_meta(&cfg).await {
            let reason = self.workspace_mutation_block_reason(cwd);
            let mut evt = json!({
                "type": "skills_catalog",
                "sessionId": session_id,
                "catalog": catalog,
                "mutationBlocked": reason.is_some(),
            });
            if partial {
                evt["availableSkillsPartial"] = Value::Bool(true);
            }
            if let Some(r) = reason {
                evt["mutationBlockedReason"] = Value::String(r);
            }
            self.broadcast_control_event(cwd, &evt);
        }

        if let Ok((pcat, partial)) = ext.read_plugins_catalog_with_meta(&cfg).await {
            let mut evt = json!({
                "type": "plugins_catalog",
                "sessionId": session_id,
                "catalog": pcat,
            });
            if partial {
                evt["availablePluginsPartial"] = Value::Bool(true);
            }
            self.broadcast_control_event(cwd, &evt);
        }

        if let Ok(mcp_snap) = read_mcp_servers_snapshot(&cfg) {
            self.broadcast_control_event(
                cwd,
                &build_mcp_servers_event(&session_id, mcp_snap, cfg.trust_workspace_mcp),
            );
        }

        let store = AgentProfilesStore::new(&cfg.user_cowork_dir, &cfg.working_directory);
        let ap_cat = store.read_catalog();
        self.broadcast_control_event(
            cwd,
            &json!({
                "type": "agent_profiles_catalog",
                "sessionId": session_id,
                "catalog": ap_cat,
                "cwd": cwd.to_string_lossy(),
            }),
        );
    }

    pub async fn broadcast_all_workspace_control_refreshes(self: &Arc<Self>) {
        let cwds: Vec<PathBuf> = self
            .workspace_subscribers
            .iter()
            .filter(|e| !e.value().is_empty())
            .map(|e| PathBuf::from(e.key().clone()))
            .collect();
        for cwd in cwds {
            self.broadcast_workspace_control_refresh(&cwd).await;
        }
    }

    pub(crate) async fn connected_providers_set(
        &self,
        primary: ProviderName,
    ) -> BTreeSet<ProviderName> {
        let mut set = BTreeSet::new();
        set.insert(primary);
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let conn_store = read_connection_store(&paths).await.ok();
        for &p in &ProviderName::ALL {
            let connected = match p {
                ProviderName::Bedrock => {
                    resolve_bedrock_auth_config(&self.homedir, &self.env, conn_store.as_ref())
                        .is_some()
                }
                ProviderName::Lmstudio | ProviderName::CodexCli => conn_store
                    .as_ref()
                    .and_then(|s| s.services.get(&p))
                    .is_some(),
                other => resolve_provider_api_key(other, conn_store.as_ref(), &self.env).is_some(),
            };
            if connected {
                set.insert(p);
            }
        }
        set
    }

    pub(crate) async fn get_or_create_agent_control(
        self: &Arc<Self>,
        thread_id: &str,
        cwd: &Path,
        live_opt: Option<&Arc<Mutex<LiveSession>>>,
        fallback_conn_id: Option<&str>,
    ) -> Result<Arc<AgentControl>, String> {
        if let Some(existing) = self.agent_controls.get(thread_id) {
            return Ok(Arc::clone(existing.value()));
        }

        let live_arc = match live_opt {
            Some(arc) => Arc::clone(arc),
            None => self
                .load_thread(thread_id)
                .ok_or_else(|| format!("Unknown thread: {thread_id}"))?,
        };

        let (parent_depth, parent_provider, parent_model, session_enable_mcp) = {
            let live = live_arc.lock();
            let depth = if live.session_kind != SessionKind::Root
                || live.parent_session_id.is_some()
                || live.role.is_some()
            {
                live.depth.unwrap_or(1).max(1) as u32
            } else {
                0
            };
            (depth, live.provider, live.model.clone(), live.enable_mcp)
        };

        let mut agent_cfg = self.load_workspace_config(cwd).map_err(|e| e.to_string())?;
        agent_cfg.provider = parent_provider;
        agent_cfg.model = parent_model;
        agent_cfg.enable_mcp = session_enable_mcp;

        let connected_providers = self.connected_providers_set(parent_provider).await;

        let weak_for_sink = Arc::downgrade(self);
        let tid_for_sink = thread_id.to_owned();
        let fallback_owned = fallback_conn_id.map(str::to_owned);
        let event_sink: cowork_harness::AgentEventSink = Arc::new(move |method, payload| {
            if let Some(rt) = weak_for_sink.upgrade() {
                let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: method.to_owned(),
                    params: Some(payload),
                });
                rt.broadcast_to_thread(&tid_for_sink, fallback_owned.as_deref(), &outbound);
            }
        });

        let executor: Arc<dyn ChildTurnExecutor> = Arc::new(ServerChildTurnExecutor {
            runtime: Arc::downgrade(self),
        });

        let ctrl = Arc::new(AgentControl::new(
            AgentControlConfig {
                parent_session_id: thread_id.to_owned(),
                parent_depth,
                agent_config: Arc::new(agent_cfg),
                session_db: Arc::clone(&self.session_db),
                connected_providers,
            },
            executor,
            event_sink,
        ));

        let live_weak = Arc::downgrade(&live_arc);
        ctrl.set_parent_snapshot_provider(move || {
            if let Some(live_ref) = live_weak.upgrade() {
                let g = live_ref.lock();
                (
                    parse_stored_canonical_messages(&g.messages),
                    g.todos.clone(),
                    g.harness_context.clone(),
                )
            } else {
                (Vec::new(), Vec::new(), None)
            }
        });

        let weak_for_lock = Arc::downgrade(self);
        ctrl.set_task_lock_checker(move |parent_sid| {
            weak_for_lock
                .upgrade()
                .and_then(|rt| rt.get_session_task_lock(parent_sid))
                .map(|l| l.message)
        });

        if let Some(existing) = self.agent_controls.get(thread_id) {
            return Ok(Arc::clone(existing.value()));
        }
        self.agent_controls
            .insert(thread_id.to_owned(), Arc::clone(&ctrl));
        Ok(ctrl)
    }

    // =========================================================================
    // 1. cowork/skills/* (15 routes)
    // =========================================================================

    pub async fn handle_skills_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let params_obj = parse_optional_obj(method, raw_params)?;
        let cwd_raw = opt_str(&params_obj, "cwd");
        let cwd = self
            .resolve_workspace_path(cwd_raw.as_deref(), method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.subscribe_workspace_control(connection_id, &cwd);

        let cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let ext = self.extension_manager();

        let is_mutation = matches!(
            method,
            "cowork/skills/enable"
                | "cowork/skills/disable"
                | "cowork/skills/delete"
                | "cowork/skills/install"
                | "cowork/skills/installation/enable"
                | "cowork/skills/installation/disable"
                | "cowork/skills/installation/delete"
                | "cowork/skills/installation/update"
                | "cowork/skills/installation/copy"
        );
        if is_mutation && let Some(reason) = self.workspace_mutation_block_reason(&cwd) {
            return Err(JsonRpcLiteError::new(error_codes::INVALID_REQUEST, reason));
        }

        match method {
            "cowork/skills/catalog/read" => {
                let evt = self
                    .build_skills_catalog_event(&ext, &cfg, &cwd, &session_id)
                    .await?;
                Ok(json!({ "event": evt }))
            }
            "cowork/skills/list" => {
                let skills = ext.list_effective_skills(&cfg);
                Ok(json!({
                    "event": {
                        "type": "skills_list",
                        "sessionId": session_id,
                        "skills": skills,
                    }
                }))
            }
            "cowork/skills/read" => {
                let skill_name = req_str(method, &params_obj, "skillName")?;
                let (skill, content) = ext
                    .read_skill_content(&cfg, &skill_name)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                Ok(json!({
                    "event": {
                        "type": "skill_content",
                        "sessionId": session_id,
                        "skill": skill,
                        "content": content,
                    }
                }))
            }
            "cowork/skills/enable" | "cowork/skills/disable" | "cowork/skills/delete" => {
                let skill_name = req_str(method, &params_obj, "skillName")?;
                let res = match method {
                    "cowork/skills/enable" => ext.enable_skill_by_name(&cfg, &skill_name),
                    "cowork/skills/disable" => ext.disable_skill_by_name(&cfg, &skill_name),
                    _ => ext.delete_skill_by_name(&cfg, &skill_name),
                };
                res.map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.publish_skill_mutation_and_broadcast(&cwd).await;
                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                let skills = ext.list_effective_skills(&cfg_after);
                Ok(json!({
                    "event": {
                        "type": "skills_list",
                        "sessionId": session_id,
                        "skills": skills,
                    }
                }))
            }
            "cowork/skills/installation/read" => {
                let installation_id = req_str(method, &params_obj, "installationId")?;
                let (installation, content) = ext.read_skill_installation(&cfg, &installation_id);
                Ok(json!({
                    "event": {
                        "type": "skill_installation",
                        "sessionId": session_id,
                        "installation": installation,
                        "content": content,
                    }
                }))
            }
            "cowork/skills/install/preview" => {
                let source_input = req_str_untrimmed(method, &params_obj, "sourceInput")?;
                let target_scope = req_str(method, &params_obj, "targetScope")?;
                let preview = ext
                    .preview_skill_install(&cfg, &source_input, &target_scope)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "skill_install_preview",
                        "sessionId": session_id,
                        "preview": preview,
                        "fromUserPreviewRequest": true,
                    }
                }))
            }
            "cowork/skills/install" => {
                let source_input = req_str_untrimmed(method, &params_obj, "sourceInput")?;
                let target_scope = req_str(method, &params_obj, "targetScope")?;
                let selected: Option<Vec<String>> = params_obj
                    .get("selectedSkillNames")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(|s| s.trim().to_owned())
                            .filter(|s| !s.is_empty())
                            .collect()
                    });
                let overwrite = params_obj
                    .get("overwrite")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                ext.install_skill_with_selection(
                    &cfg,
                    &source_input,
                    &target_scope,
                    selected.as_deref(),
                    overwrite,
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.publish_skill_mutation_and_broadcast(&cwd).await;
                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                let evt = self
                    .build_skills_catalog_event(&ext, &cfg_after, &cwd, &session_id)
                    .await?;
                Ok(json!({ "event": evt }))
            }
            "cowork/skills/installation/enable"
            | "cowork/skills/installation/disable"
            | "cowork/skills/installation/delete"
            | "cowork/skills/installation/update" => {
                let installation_id = req_str(method, &params_obj, "installationId")?;
                match method {
                    "cowork/skills/installation/enable" => ext
                        .set_skill_installation_enabled(&cfg, &installation_id, true)
                        .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?,
                    "cowork/skills/installation/disable" => ext
                        .set_skill_installation_enabled(&cfg, &installation_id, false)
                        .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?,
                    "cowork/skills/installation/delete" => ext
                        .delete_skill_installation(&cfg, &installation_id)
                        .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?,
                    _ => {
                        ext.update_skill_installation(&cfg, &installation_id)
                            .await
                            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                    }
                }
                self.publish_skill_mutation_and_broadcast(&cwd).await;
                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                let evt = self
                    .build_skills_catalog_event(&ext, &cfg_after, &cwd, &session_id)
                    .await?;
                Ok(json!({ "event": evt }))
            }
            "cowork/skills/installation/copy" => {
                let installation_id = req_str(method, &params_obj, "installationId")?;
                let target_scope = req_str(method, &params_obj, "targetScope")?;
                ext.copy_skill_installation(&cfg, &installation_id, &target_scope, true)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.publish_skill_mutation_and_broadcast(&cwd).await;
                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                let evt = self
                    .build_skills_catalog_event(&ext, &cfg_after, &cwd, &session_id)
                    .await?;
                Ok(json!({ "event": evt }))
            }
            "cowork/skills/installation/checkUpdate" => {
                let installation_id = req_str(method, &params_obj, "installationId")?;
                let result = ext
                    .check_skill_installation_update(&cfg, &installation_id)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "skill_installation_update_check",
                        "sessionId": session_id,
                        "result": result,
                    }
                }))
            }
            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    async fn build_skills_catalog_event(
        &self,
        ext: &ExtensionManager,
        cfg: &AgentConfig,
        cwd: &Path,
        session_id: &str,
    ) -> Result<Value, JsonRpcLiteError> {
        let (catalog, partial) = ext
            .read_skills_catalog_with_meta(cfg)
            .await
            .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;
        let reason = self.workspace_mutation_block_reason(cwd);
        let mut evt = json!({
            "type": "skills_catalog",
            "sessionId": session_id,
            "catalog": catalog,
            "mutationBlocked": reason.is_some(),
        });
        if partial {
            evt["availableSkillsPartial"] = Value::Bool(true);
        }
        if let Some(r) = reason {
            evt["mutationBlockedReason"] = Value::String(r);
        }
        Ok(evt)
    }

    async fn publish_skill_mutation_and_broadcast(self: &Arc<Self>, cwd: &Path) {
        if let Some(bus) = self.ensure_skill_mutation_bus() {
            let _ = bus.publish_mutation();
        }
        self.broadcast_workspace_control_refresh(cwd).await;
    }

    // =========================================================================
    // 2. cowork/plugins/* (9 routes)
    // =========================================================================

    pub async fn handle_plugins_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let params_obj = parse_optional_obj(method, raw_params)?;
        let cwd_raw = opt_str(&params_obj, "cwd");
        let cwd = self
            .resolve_workspace_path(cwd_raw.as_deref(), method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.subscribe_workspace_control(connection_id, &cwd);

        let cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let ext = self.extension_manager();

        let is_mutation = matches!(
            method,
            "cowork/plugins/install"
                | "cowork/plugins/update"
                | "cowork/plugins/enable"
                | "cowork/plugins/disable"
                | "cowork/plugins/delete"
        );
        if is_mutation && let Some(reason) = self.workspace_mutation_block_reason(&cwd) {
            return Err(JsonRpcLiteError::new(error_codes::INVALID_REQUEST, reason));
        }

        match method {
            "cowork/plugins/catalog/read" => {
                let (catalog, partial) = ext
                    .read_plugins_catalog_with_meta(&cfg)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;
                let mut evt = json!({
                    "type": "plugins_catalog",
                    "sessionId": session_id,
                    "catalog": catalog,
                });
                if partial {
                    evt["availablePluginsPartial"] = Value::Bool(true);
                }
                Ok(json!({ "event": evt }))
            }
            "cowork/plugins/read" => {
                let plugin_id = req_str(method, &params_obj, "pluginId")?;
                let scope = opt_plugin_scope(method, &params_obj)?;
                let plugin = ext
                    .read_plugin_detail(&cfg, &plugin_id, scope.as_deref())
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "plugin_detail",
                        "sessionId": session_id,
                        "plugin": plugin,
                    }
                }))
            }
            "cowork/plugins/install/preview" => {
                let source_input = req_str_untrimmed(method, &params_obj, "sourceInput")?;
                let target_scope = req_str(method, &params_obj, "targetScope")?;
                let preview = ext
                    .preview_plugin_install(&cfg, &source_input, &target_scope)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "plugin_install_preview",
                        "sessionId": session_id,
                        "preview": preview,
                        "fromUserPreviewRequest": true,
                    }
                }))
            }
            "cowork/plugins/checkUpdate" => {
                let plugin_id = req_str(method, &params_obj, "pluginId")?;
                let scope = opt_plugin_scope(method, &params_obj)?;
                let result = ext
                    .check_plugin_update(&cfg, &plugin_id, scope.as_deref())
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "plugin_update_check",
                        "sessionId": session_id,
                        "result": result,
                    }
                }))
            }
            "cowork/plugins/install"
            | "cowork/plugins/update"
            | "cowork/plugins/enable"
            | "cowork/plugins/disable"
            | "cowork/plugins/delete" => {
                let invalidate_all_mcp;
                match method {
                    "cowork/plugins/install" => {
                        let source_input = req_str_untrimmed(method, &params_obj, "sourceInput")?;
                        let target_scope = req_str(method, &params_obj, "targetScope")?;
                        invalidate_all_mcp = target_scope == "user";
                        ext.install_plugin(&cfg, &source_input, &target_scope)
                            .await
                            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                    }
                    "cowork/plugins/update" => {
                        let plugin_id = req_str(method, &params_obj, "pluginId")?;
                        let scope = opt_plugin_scope(method, &params_obj)?;
                        invalidate_all_mcp = scope.as_deref() == Some("user");
                        ext.update_plugin(&cfg, &plugin_id, scope.as_deref())
                            .await
                            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                    }
                    "cowork/plugins/enable" => {
                        let plugin_id = req_str(method, &params_obj, "pluginId")?;
                        let scope = opt_plugin_scope(method, &params_obj)?;
                        invalidate_all_mcp = scope.as_deref() == Some("user");
                        ext.set_plugin_enabled(&cfg, &plugin_id, scope.as_deref(), true)
                            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                    }
                    "cowork/plugins/disable" => {
                        let plugin_id = req_str(method, &params_obj, "pluginId")?;
                        let scope = opt_plugin_scope(method, &params_obj)?;
                        invalidate_all_mcp = scope.as_deref() == Some("user");
                        ext.set_plugin_enabled(&cfg, &plugin_id, scope.as_deref(), false)
                            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                    }
                    _ => {
                        let plugin_id = req_str(method, &params_obj, "pluginId")?;
                        let scope = opt_plugin_scope(method, &params_obj)?;
                        invalidate_all_mcp = scope.as_deref() == Some("user");
                        ext.delete_plugin(&cfg, &plugin_id, scope.as_deref())
                            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                    }
                }

                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                if invalidate_all_mcp {
                    self.mcp_tool_cache.invalidate_all().await;
                } else {
                    self.mcp_tool_cache
                        .invalidate_workspace(&cfg_after.working_directory)
                        .await;
                }
                if let Some(bus) = self.ensure_skill_mutation_bus() {
                    let _ = bus.publish_mutation();
                }

                let (pcat, p_partial) = ext
                    .read_plugins_catalog_with_meta(&cfg_after)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;
                let mut plugins_evt = json!({
                    "type": "plugins_catalog",
                    "sessionId": session_id,
                    "catalog": pcat,
                });
                if p_partial {
                    plugins_evt["availablePluginsPartial"] = Value::Bool(true);
                }

                let skills_cat_evt = self
                    .build_skills_catalog_event(&ext, &cfg_after, &cwd, &session_id)
                    .await?;
                let skills_list_evt = json!({
                    "type": "skills_list",
                    "sessionId": session_id,
                    "skills": ext.list_effective_skills(&cfg_after),
                });
                let mcp_snap = read_mcp_servers_snapshot(&cfg_after)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;
                let mcp_evt =
                    build_mcp_servers_event(&session_id, mcp_snap, cfg_after.trust_workspace_mcp);

                let events = vec![plugins_evt, skills_cat_evt, skills_list_evt, mcp_evt];
                for evt in &events {
                    self.broadcast_control_event(&cwd, evt);
                }
                Ok(json!({ "events": events }))
            }
            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // =========================================================================
    // 3. cowork/marketplaces/* (4 routes)
    // =========================================================================

    pub async fn handle_marketplaces_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let params_obj = parse_optional_obj(method, raw_params)?;
        let cwd_raw = opt_str(&params_obj, "cwd");
        let cwd = self
            .resolve_workspace_path(cwd_raw.as_deref(), method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.subscribe_workspace_control(connection_id, &cwd);

        let cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let ext = self.extension_manager();

        match method {
            "cowork/marketplaces/read" => {
                let marketplaces = ext
                    .read_marketplaces(&cfg)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "marketplaces_list",
                        "sessionId": session_id,
                        "marketplaces": marketplaces,
                    }
                }))
            }
            "cowork/marketplaces/detail" => {
                let id = req_str(method, &params_obj, "id")?;
                let detail = ext
                    .read_marketplace_detail(&cfg, &id)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": {
                        "type": "marketplace_detail",
                        "sessionId": session_id,
                        "detail": detail,
                    }
                }))
            }
            "cowork/marketplaces/add" => {
                let source_input = req_str(method, &params_obj, "sourceInput")?;
                let marketplaces = ext
                    .add_marketplace(
                        &cfg,
                        MarketplaceSourceInput {
                            source: source_input,
                            git_ref: opt_str(&params_obj, "ref"),
                            marketplace_path: opt_str(&params_obj, "marketplacePath"),
                        },
                    )
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.publish_skill_mutation_and_broadcast(&cwd).await;
                Ok(json!({
                    "event": {
                        "type": "marketplaces_list",
                        "sessionId": session_id,
                        "marketplaces": marketplaces,
                    }
                }))
            }
            "cowork/marketplaces/remove" => {
                let id = req_str(method, &params_obj, "id")?;
                let marketplaces = ext
                    .remove_marketplace(&cfg, &id)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.publish_skill_mutation_and_broadcast(&cwd).await;
                Ok(json!({
                    "event": {
                        "type": "marketplaces_list",
                        "sessionId": session_id,
                        "marketplaces": marketplaces,
                    }
                }))
            }
            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // =========================================================================
    // 4. cowork/mcp/* (8 routes + cowork/mcp/list legacy alias)
    // =========================================================================

    pub async fn handle_mcp_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let params_obj = parse_optional_obj(method, raw_params)?;
        let cwd_raw = opt_str(&params_obj, "cwd");
        let cwd = self
            .resolve_workspace_path(cwd_raw.as_deref(), method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.subscribe_workspace_control(connection_id, &cwd);

        let cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let session_id = self.get_or_create_workspace_state_id(&cwd);

        match method {
            "cowork/mcp/list" => {
                let snap = read_mcp_servers_snapshot(&cfg)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                let evt =
                    build_mcp_servers_event(&session_id, snap.clone(), cfg.trust_workspace_mcp);
                Ok(json!({
                    "servers": snap.servers,
                    "event": evt,
                }))
            }
            "cowork/mcp/servers/read" => {
                let snap = read_mcp_servers_snapshot(&cfg)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({
                    "event": build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp)
                }))
            }
            "cowork/mcp/server/upsert" => {
                let srv_val = params_obj.get("server").ok_or_else(|| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: server is required"),
                    )
                })?;
                let srv: McpServerConfig =
                    serde_json::from_value(srv_val.clone()).map_err(|e| {
                        JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {e}"))
                    })?;
                let source = match opt_str(&params_obj, "source").as_deref() {
                    Some("user") => McpConfigSource::User,
                    _ => McpConfigSource::Workspace,
                };
                let previous_name = opt_str(&params_obj, "previousName");
                let snap = upsert_mcp_server(&cfg, source, srv, previous_name.as_deref())
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                if source == McpConfigSource::User {
                    self.mcp_tool_cache.invalidate_all().await;
                } else {
                    self.mcp_tool_cache
                        .invalidate_workspace(&cfg.working_directory)
                        .await;
                }
                let evt = build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp);
                self.broadcast_control_event(&cwd, &evt);
                Ok(json!({ "event": evt }))
            }
            "cowork/mcp/server/delete" => {
                let name = req_str(method, &params_obj, "name")?;
                let source = match opt_str(&params_obj, "source").as_deref() {
                    Some("user") => McpConfigSource::User,
                    _ => McpConfigSource::Workspace,
                };
                let snap = delete_mcp_server(&cfg, source, &name)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                if source == McpConfigSource::User {
                    self.mcp_tool_cache.invalidate_all().await;
                } else {
                    self.mcp_tool_cache
                        .invalidate_workspace(&cfg.working_directory)
                        .await;
                }
                let evt = build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp);
                self.broadcast_control_event(&cwd, &evt);
                Ok(json!({ "event": evt }))
            }
            "cowork/mcp/server/setEnabled" => {
                let name = req_str(method, &params_obj, "name")?;
                let source_raw = req_str(method, &params_obj, "source")?;
                let source = parse_mcp_source(method, &source_raw)?;
                let enabled = params_obj
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            format!("{method}: enabled boolean is required"),
                        )
                    })?;
                let plugin_id = opt_str(&params_obj, "pluginId");
                let plugin_scope = opt_plugin_scope_field(method, &params_obj, "pluginScope")?;
                let snap = set_mcp_server_enabled(
                    &cfg,
                    source,
                    &name,
                    enabled,
                    plugin_id.as_deref(),
                    plugin_scope.as_deref(),
                )
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                if source == McpConfigSource::User || plugin_scope.as_deref() == Some("user") {
                    self.mcp_tool_cache.invalidate_all().await;
                } else {
                    self.mcp_tool_cache
                        .invalidate_workspace(&cfg.working_directory)
                        .await;
                }
                let evt = build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp);
                self.broadcast_control_event(&cwd, &evt);
                Ok(json!({ "event": evt }))
            }
            "cowork/mcp/server/validate" => {
                let name = req_str(method, &params_obj, "name")?;
                let (source, plugin_id, plugin_scope) = parse_mcp_lookup(method, &params_obj)?;
                let mut tool_env = self.effective_tool_env();
                tool_env.insert(
                    "HOME".to_owned(),
                    self.homedir.to_string_lossy().into_owned(),
                );
                let val_res = validate_mcp_server_with_env(
                    &cfg,
                    &tool_env,
                    &name,
                    source,
                    plugin_id.as_deref(),
                    plugin_scope.as_deref(),
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                let mut evt = json!({
                    "type": "mcp_server_validation",
                    "sessionId": session_id,
                    "name": val_res.name,
                    "ok": val_res.ok,
                    "mode": val_res.mode,
                    "message": val_res.message,
                });
                if let Some(tc) = val_res.tool_count {
                    evt["toolCount"] = json!(tc);
                }
                if let Some(tools) = val_res.tools {
                    evt["tools"] = json!(tools);
                }
                if let Some(lat) = val_res.latency_ms {
                    evt["latencyMs"] = json!(lat);
                }
                Ok(json!({ "event": evt }))
            }
            "cowork/mcp/server/auth/authorize" => {
                let name = req_str(method, &params_obj, "name")?;
                let (source, plugin_id, plugin_scope) = parse_mcp_lookup(method, &params_obj)?;
                let challenge: McpOAuthChallengeResult = start_mcp_oauth_authorization(
                    &cfg,
                    &name,
                    source,
                    plugin_id.as_deref(),
                    plugin_scope.as_deref(),
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                if let Ok(snap) = read_mcp_servers_snapshot(&cfg) {
                    self.broadcast_control_event(
                        &cwd,
                        &build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp),
                    );
                }
                if challenge.challenge.method == "auto" {
                    let rt_bg = Arc::clone(self);
                    let cfg_bg = cfg.clone();
                    let cwd_bg = cwd.clone();
                    let sid_bg = session_id.clone();
                    let name_bg = name.clone();
                    let plugin_id_bg = plugin_id.clone();
                    let plugin_scope_bg = plugin_scope.clone();
                    tokio::spawn(async move {
                        if let Ok(Some(_res)) = wait_and_complete_auto_mcp_oauth(
                            &cfg_bg,
                            &name_bg,
                            source,
                            plugin_id_bg.as_deref(),
                            plugin_scope_bg.as_deref(),
                        )
                        .await
                        {
                            rt_bg.mcp_tool_cache.invalidate_all().await;
                            if let Ok(snap) = read_mcp_servers_snapshot(&cfg_bg) {
                                rt_bg.broadcast_control_event(
                                    &cwd_bg,
                                    &build_mcp_servers_event(
                                        &sid_bg,
                                        snap,
                                        cfg_bg.trust_workspace_mcp,
                                    ),
                                );
                            }
                        }
                    });
                }
                Ok(json!({
                    "event": {
                        "type": "mcp_server_auth_challenge",
                        "sessionId": session_id,
                        "name": challenge.name,
                        "challenge": challenge.challenge,
                    }
                }))
            }
            "cowork/mcp/server/auth/callback" => {
                let name = req_str(method, &params_obj, "name")?;
                let (source, plugin_id, plugin_scope) = parse_mcp_lookup(method, &params_obj)?;
                let code = opt_str(&params_obj, "code");
                let res = complete_mcp_oauth_callback(
                    &cfg,
                    &name,
                    source,
                    plugin_id.as_deref(),
                    plugin_scope.as_deref(),
                    code.as_deref(),
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.mcp_tool_cache.invalidate_all().await;
                if let Ok(snap) = read_mcp_servers_snapshot(&cfg) {
                    self.broadcast_control_event(
                        &cwd,
                        &build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp),
                    );
                }
                Ok(json!({
                    "event": {
                        "type": "mcp_server_auth_result",
                        "sessionId": session_id,
                        "name": res.name,
                        "ok": res.ok,
                        "mode": res.mode,
                        "message": res.message,
                    }
                }))
            }
            "cowork/mcp/server/auth/setApiKey" => {
                let name = req_str(method, &params_obj, "name")?;
                let (source, plugin_id, plugin_scope) = parse_mcp_lookup(method, &params_obj)?;
                let api_key = req_str(method, &params_obj, "apiKey")?;
                let res = set_mcp_server_api_key(
                    &cfg,
                    &name,
                    source,
                    plugin_id.as_deref(),
                    plugin_scope.as_deref(),
                    &api_key,
                )
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.mcp_tool_cache.invalidate_all().await;
                if let Ok(snap) = read_mcp_servers_snapshot(&cfg) {
                    self.broadcast_control_event(
                        &cwd,
                        &build_mcp_servers_event(&session_id, snap, cfg.trust_workspace_mcp),
                    );
                }
                Ok(json!({
                    "event": {
                        "type": "mcp_server_auth_result",
                        "sessionId": session_id,
                        "name": res.name,
                        "ok": res.ok,
                        "mode": res.mode,
                        "message": res.message,
                    }
                }))
            }
            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // =========================================================================
    // 5. cowork/session/agent/* (7 routes)
    // =========================================================================

    pub async fn handle_session_agent_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let params_obj = parse_required_obj(method, raw_params)?;
        let thread_id = req_str(method, &params_obj, "threadId")?;
        let Some(live_arc) = self.subscribe(connection_id, &thread_id) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Unknown thread: {thread_id}"),
            ));
        };
        if matches!(
            method,
            "cowork/session/agent/spawn"
                | "cowork/session/agent/input/send"
                | "cowork/session/agent/resume"
        ) && let Some(lock) = self.get_session_task_lock(&thread_id)
        {
            return Err(JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                lock.message,
                lock.data.to_json_value(),
            ));
        }
        let cwd = PathBuf::from(live_arc.lock().cwd.clone());
        let ctrl = self
            .get_or_create_agent_control(&thread_id, &cwd, Some(&live_arc), Some(connection_id))
            .await
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        let map_agent_mut_err = |msg: String| -> JsonRpcLiteError {
            if let Some(lock) = self.get_session_task_lock(&thread_id) {
                return JsonRpcLiteError::with_data(
                    error_codes::INVALID_REQUEST,
                    lock.message,
                    lock.data.to_json_value(),
                );
            }
            JsonRpcLiteError::new(error_codes::INVALID_REQUEST, msg)
        };

        match method {
            "cowork/session/agent/spawn" => {
                let message = req_str(method, &params_obj, "message")?;
                let role = opt_str(&params_obj, "role");
                if let Some(ref r) = role
                    && !matches!(
                        r.as_str(),
                        "default" | "explorer" | "research" | "worker" | "reviewer"
                    )
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: invalid role '{r}'"),
                    ));
                }
                let reasoning_effort = opt_str(&params_obj, "reasoningEffort");
                if let Some(ref eff) = reasoning_effort
                    && !matches!(
                        eff.as_str(),
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
                    )
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: invalid reasoningEffort '{eff}'"),
                    ));
                }
                let context_mode = opt_str(&params_obj, "contextMode");
                let briefing = opt_str(&params_obj, "briefing");
                let fork_context = params_obj
                    .get("forkContext")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                // Validate contextMode / briefing / forkContext upfront so malformed combinations return INVALID_PARAMS!
                cowork_tools::resolve_context_mode_and_briefing(
                    context_mode.as_deref(),
                    briefing.as_deref(),
                    fork_context.then_some(true),
                )
                .map_err(|m| {
                    JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {m}"))
                })?;

                let target_paths =
                    params_obj
                        .get("targetPaths")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect::<Vec<_>>()
                        });

                let (parent_msgs, parent_todos, parent_hctx) = {
                    let g = live_arc.lock();
                    (
                        parse_stored_canonical_messages(&g.messages),
                        g.todos.clone(),
                        g.harness_context.clone(),
                    )
                };

                ctrl.spawn(
                    AgentSpawnRequest {
                        message,
                        role,
                        profile_ref: opt_str(&params_obj, "profileRef"),
                        model: opt_str(&params_obj, "model"),
                        reasoning_effort,
                        nickname: opt_str(&params_obj, "nickname"),
                        task_type: opt_str(&params_obj, "taskType"),
                        target_paths,
                        context_mode,
                        briefing,
                        include_parent_todos: params_obj
                            .get("includeParentTodos")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        include_harness_context: params_obj
                            .get("includeHarnessContext")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        fork_context,
                        system_prompt_suffix: opt_str(&params_obj, "systemPromptSuffix"),
                    },
                    &parent_msgs,
                    &parent_todos,
                    parent_hctx.as_ref(),
                )
                .await
                .map_err(&map_agent_mut_err)?;
                Ok(json!({}))
            }
            "cowork/session/agent/list" => {
                ctrl.emit_agent_list();
                Ok(json!({}))
            }
            "cowork/session/agent/input/send" => {
                let agent_id = req_str(method, &params_obj, "agentId")?;
                let message = req_str(method, &params_obj, "message")?;
                let interrupt = params_obj
                    .get("interrupt")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                ctrl.send_input(&agent_id, &message, interrupt)
                    .await
                    .map_err(&map_agent_mut_err)?;
                Ok(json!({}))
            }
            "cowork/session/agent/wait" => {
                let ids_val = params_obj
                    .get("agentIds")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            format!("{method}: agentIds non-empty array is required"),
                        )
                    })?;
                let agent_ids: Vec<String> = ids_val
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                if agent_ids.is_empty() {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: agentIds must contain at least one id"),
                    ));
                }
                let timeout_ms = params_obj.get("timeoutMs").and_then(Value::as_u64);
                let mode = opt_str(&params_obj, "mode");
                if let Some(ref m) = mode
                    && !matches!(m.as_str(), "any" | "all")
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: invalid mode '{m}'"),
                    ));
                }
                let include_final_message = params_obj
                    .get("includeFinalMessage")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let include_report = params_obj
                    .get("includeReport")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                ctrl.wait(
                    &agent_ids,
                    timeout_ms,
                    mode.as_deref(),
                    include_final_message,
                    include_report,
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({}))
            }
            "cowork/session/agent/inspect" => {
                let agent_id = req_str(method, &params_obj, "agentId")?;
                let inspection = ctrl
                    .inspect(&agent_id)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({ "event": inspection }))
            }
            "cowork/session/agent/resume" => {
                let agent_id = req_str(method, &params_obj, "agentId")?;
                ctrl.resume(&agent_id).await.map_err(&map_agent_mut_err)?;
                Ok(json!({}))
            }
            "cowork/session/agent/close" => {
                let agent_id = req_str(method, &params_obj, "agentId")?;
                ctrl.close(&agent_id)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                self.mcp_tool_cache.close_session(&agent_id).await;
                Ok(json!({}))
            }
            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // =========================================================================
    // 6. cowork/agentProfiles/* (5 routes)
    // =========================================================================

    pub fn handle_agent_profiles_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let params_obj = parse_optional_obj(method, raw_params)?;
        let cwd_raw = opt_str(&params_obj, "cwd");
        let cwd = self
            .resolve_workspace_path(cwd_raw.as_deref(), method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.subscribe_workspace_control(connection_id, &cwd);

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let store = AgentProfilesStore::new(&paths.root_dir, &cwd);

        let emit_profile_mutation = |cat: &cowork_harness::AgentProfilesCatalog| {
            let strict_evt = json!({
                "type": "agent_profiles_catalog",
                "sessionId": session_id,
                "catalog": cat,
            });
            let notif = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                method: "cowork/agentProfiles/catalog".to_owned(),
                params: Some(strict_evt),
            });
            let key = cwd.to_string_lossy().into_owned();
            if let Some(subs) = self.workspace_subscribers.get(&key) {
                for cid in subs.value().iter() {
                    self.send_to_connection(cid, &notif);
                }
            }
            self.broadcast_control_event(
                &cwd,
                &json!({
                    "type": "agent_profiles_catalog",
                    "sessionId": session_id,
                    "catalog": cat,
                    "cwd": cwd.to_string_lossy(),
                }),
            );
        };

        match method {
            "cowork/agentProfiles/catalog/read" => {
                ensure_allowed_keys(method, &params_obj, &["cwd"])?;
                let cat = store.read_catalog();
                Ok(json!({
                    "event": {
                        "type": "agent_profiles_catalog",
                        "sessionId": session_id,
                        "catalog": cat,
                    }
                }))
            }
            "cowork/agentProfiles/upsert" => {
                let prof_val = params_obj.get("profile").ok_or_else(|| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: profile is required"),
                    )
                })?;
                let input: AgentProfileUpsertInput = serde_json::from_value(prof_val.clone())
                    .map_err(|e| {
                        JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {e}"))
                    })?;
                let cat = store
                    .upsert(input)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                emit_profile_mutation(&cat);
                Ok(json!({
                    "event": {
                        "type": "agent_profiles_catalog",
                        "sessionId": session_id,
                        "catalog": cat,
                    }
                }))
            }
            "cowork/agentProfiles/delete" => {
                let scope_raw = req_str(method, &params_obj, "scope")?;
                let scope = AgentProfileScope::parse(&scope_raw).map_err(|m| {
                    JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {m}"))
                })?;
                let id = req_str(method, &params_obj, "id")?;
                let cat = store
                    .delete(scope, &id)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                emit_profile_mutation(&cat);
                Ok(json!({
                    "event": {
                        "type": "agent_profiles_catalog",
                        "sessionId": session_id,
                        "catalog": cat,
                    }
                }))
            }
            "cowork/agentProfiles/copy" => {
                let copy_obj = params_obj
                    .get("copy")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            format!("{method}: copy object is required"),
                        )
                    })?;
                let source_ref = req_str(method, copy_obj, "sourceRef")?;
                let target_scope_raw = req_str(method, copy_obj, "targetScope")?;
                let target_scope = AgentProfileScope::parse(&target_scope_raw).map_err(|m| {
                    JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {m}"))
                })?;
                let target_id = opt_str(copy_obj, "targetId");
                let target_dn = opt_str(copy_obj, "targetDisplayName");
                let cat = store
                    .copy_profile(
                        &source_ref,
                        target_scope,
                        target_id.as_deref(),
                        target_dn.as_deref(),
                    )
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                emit_profile_mutation(&cat);
                Ok(json!({
                    "event": {
                        "type": "agent_profiles_catalog",
                        "sessionId": session_id,
                        "catalog": cat,
                    }
                }))
            }
            "cowork/agentProfiles/workspaceAvailability/set" => {
                let id = req_str(method, &params_obj, "id")?;
                let disabled = params_obj
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            format!("{method}: disabled boolean is required"),
                        )
                    })?;
                let cat = store
                    .set_workspace_availability(&id, !disabled)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                emit_profile_mutation(&cat);
                Ok(json!({
                    "event": {
                        "type": "agent_profiles_catalog",
                        "sessionId": session_id,
                        "catalog": cat,
                    }
                }))
            }
            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }
}

fn build_mcp_servers_event(
    session_id: &str,
    snap: cowork_mcp::McpServersSnapshot,
    workspace_trusted: bool,
) -> Value {
    let mut evt = json!({
        "type": "mcp_servers",
        "sessionId": session_id,
        "servers": snap.servers,
        "files": snap.files,
        "workspaceTrusted": workspace_trusted,
    });
    if !snap.warnings.is_empty() {
        evt["warnings"] = json!(snap.warnings);
    }
    evt
}

fn parse_optional_obj(
    method: &str,
    raw: Option<&Value>,
) -> Result<Map<String, Value>, JsonRpcLiteError> {
    match raw {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid params"),
        )),
    }
}

fn parse_required_obj(
    method: &str,
    raw: Option<&Value>,
) -> Result<Map<String, Value>, JsonRpcLiteError> {
    match raw {
        Some(Value::Object(m)) => Ok(m.clone()),
        _ => Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid params"),
        )),
    }
}

fn ensure_allowed_keys(
    method: &str,
    map: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), JsonRpcLiteError> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: unknown field '{key}'"),
            ));
        }
    }
    Ok(())
}

fn opt_str(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn req_str(method: &str, map: &Map<String, Value>, key: &str) -> Result<String, JsonRpcLiteError> {
    opt_str(map, key).ok_or_else(|| {
        JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: {key} is required"),
        )
    })
}

fn req_str_untrimmed(
    method: &str,
    map: &Map<String, Value>,
    key: &str,
) -> Result<String, JsonRpcLiteError> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: {key} is required"),
            )
        })
}

fn opt_plugin_scope(
    method: &str,
    map: &Map<String, Value>,
) -> Result<Option<String>, JsonRpcLiteError> {
    opt_plugin_scope_field(method, map, "scope")
}

fn opt_plugin_scope_field(
    method: &str,
    map: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, JsonRpcLiteError> {
    match map.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if matches!(s.as_str(), "workspace" | "user") => Ok(Some(s.clone())),
        Some(_) => Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: {field} must be 'workspace' or 'user'"),
        )),
    }
}

fn parse_mcp_source(method: &str, raw: &str) -> Result<McpConfigSource, JsonRpcLiteError> {
    match raw {
        "workspace" => Ok(McpConfigSource::Workspace),
        "user" => Ok(McpConfigSource::User),
        "plugin" => Ok(McpConfigSource::Plugin),
        "system" => Ok(McpConfigSource::System),
        _ => Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid MCP source '{raw}'"),
        )),
    }
}

type McpLookupFields = (Option<McpConfigSource>, Option<String>, Option<String>);

fn parse_mcp_lookup(
    method: &str,
    map: &Map<String, Value>,
) -> Result<McpLookupFields, JsonRpcLiteError> {
    let source = match map.get("source") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(parse_mcp_source(method, s)?),
        Some(_) => {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: source must be a string"),
            ));
        }
    };
    let plugin_id = opt_str(map, "pluginId");
    let plugin_scope = opt_plugin_scope_field(method, map, "pluginScope")?;
    Ok((source, plugin_id, plugin_scope))
}
