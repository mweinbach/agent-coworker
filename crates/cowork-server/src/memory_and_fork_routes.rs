use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{
    AgentConfig, ProviderName, SupportedModel, canonicalize_sync, get_ai_coworker_paths,
    get_one_off_chats_root, normalize_child_routing_config, parse_child_model_ref,
    read_connection_store,
};
use cowork_harness::MemoryGenerator;
use cowork_protocol::{
    JsonRpcLiteError, JsonRpcLiteNotification, JsonRpcLiteOutbound, JsonRpcThread,
    MemoryAdvancedDeleteParams, MemoryAdvancedFolderDeleteParams,
    MemoryAdvancedFolderGenerateParams, MemoryAdvancedFolderListParams,
    MemoryAdvancedFolderUpsertParams, MemoryAdvancedGenerateParams, MemoryAdvancedListParams,
    MemoryAdvancedUpsertParams, MemoryDeleteParams, MemoryListParams, MemoryUpsertParams,
    ThreadEnvironment, ThreadForkParams, TurnInput, TurnStartParams, error_codes,
};
use cowork_providers::bedrock::{extract_bedrock_region_override, resolve_bedrock_auth_config};
use cowork_providers::chat_completions::lmstudio::resolve_lmstudio_options;
use cowork_providers::{ProviderTransport, resolve_provider_api_key};
use cowork_storage::{
    MemoryScope, MemoryStore, MemoryWriteMode, SessionKind, SessionTitleSource,
    ThreadJournalEventInput,
};
use cowork_tools::{AdvancedMemoryStore, ThreadControlBridge, WorktreeCreateOptions};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::http_desktop::build_workspace_summaries;
use crate::registry::{LiveSession, ServerRuntimeState};
use crate::turn_runner::{
    CurrentModelConnection, provider_base_url_override, select_provider_transport,
};

impl ServerRuntimeState {
    pub fn memory_store_for_workspace(&self, cwd: &Path) -> MemoryStore {
        let ai_paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let workspace_db = cwd.join(".cowork").join("memory.db");
        let user_db = ai_paths.root_dir.join("memory.db");
        MemoryStore::new(workspace_db, user_db)
    }

    pub fn advanced_memory_store_for_workspace(&self, cwd: &Path) -> AdvancedMemoryStore {
        let ai_paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let default_chats = canonicalize_sync(&get_one_off_chats_root(&self.homedir));
        AdvancedMemoryStore::new(ai_paths.root_dir, canonicalize_sync(cwd), default_chats)
    }

    pub fn handle_memory_list(&self, params: &MemoryListParams) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/list")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.memory_store_for_workspace(&cwd);
        let scope = match params.scope.as_deref() {
            Some("user") => Some(MemoryScope::User),
            Some("workspace") => Some(MemoryScope::Workspace),
            _ => None,
        };
        let entries = store
            .list(scope)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({
            "event": {
                "type": "memory_list",
                "scope": scope,
                "memories": entries,
            }
        }))
    }

    pub fn handle_memory_upsert(
        &self,
        params: &MemoryUpsertParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/upsert")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.memory_store_for_workspace(&cwd);
        let scope = if params.scope == "user" {
            MemoryScope::User
        } else {
            MemoryScope::Workspace
        };
        let mode = if params.mode.as_deref() == Some("create") {
            MemoryWriteMode::Create
        } else {
            MemoryWriteMode::Upsert
        };
        let id = params
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let entry = store
            .upsert(scope, id, &params.content, mode)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        // `AgentSession.upsertMemory` re-emits every scope (`emitMemories()` without a scope);
        // clients replace their whole memory list with this result.
        let entries = store
            .list(None)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({
            "event": {
                "type": "memory_list",
                "scope": scope,
                "entry": entry,
                "memories": entries,
            }
        }))
    }

    pub fn handle_memory_delete(
        &self,
        params: &MemoryDeleteParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/delete")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.memory_store_for_workspace(&cwd);
        let scope = if params.scope == "user" {
            MemoryScope::User
        } else {
            MemoryScope::Workspace
        };
        let id = params.id.trim();
        if id.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "cowork/memory/delete: id is required",
            ));
        }
        let deleted = store
            .remove(scope, id)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        // `AgentSession.deleteMemory` parity: the result lists every scope, not just `scope`.
        let entries = store
            .list(None)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({
            "event": {
                "type": "memory_list",
                "scope": scope,
                "deleted": deleted,
                "memories": entries,
            }
        }))
    }

    fn build_advanced_list_response(
        &self,
        cwd: &Path,
        explicit_folder: Option<&str>,
    ) -> Result<Value, JsonRpcLiteError> {
        let store = self.advanced_memory_store_for_workspace(cwd);
        let folder_label = explicit_folder
            .map(str::to_owned)
            .unwrap_or_else(|| store.workspace_folder_key());
        let dir = store
            .resolve_scope_dir("workspace", explicit_folder)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let entries = store
            .list_entries_in_dir(&dir, "workspace")
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let global_dir = store
            .resolve_scope_dir("global", None)
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        let global_entries = store
            .list_entries_in_dir(&global_dir, "global")
            .unwrap_or_default();
        let folders = store.list_folders().unwrap_or_default();
        Ok(json!({
            "event": {
                "type": "advanced_memory_list",
                "folder": folder_label,
                "memories": entries,
                "globalEntries": global_entries,
                "folders": folders,
            }
        }))
    }

    pub fn handle_memory_advanced_list(
        &self,
        params: &MemoryAdvancedListParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/advanced/list")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.build_advanced_list_response(&cwd, None)
    }

    pub fn handle_memory_advanced_folder_list(
        &self,
        params: &MemoryAdvancedFolderListParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let folder = params.folder.trim();
        if folder.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "cowork/memory/advanced/folder/list: folder is required",
            ));
        }
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/advanced/folder/list")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.build_advanced_list_response(&cwd, Some(folder))
    }

    pub fn handle_memory_advanced_upsert(
        &self,
        params: &MemoryAdvancedUpsertParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/advanced/upsert")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.advanced_memory_store_for_workspace(&cwd);
        let slug_or_name = params
            .slug
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&params.name);
        let mem_type = params.r#type.as_deref().unwrap_or("project");
        store
            .upsert_entry(
                "workspace",
                None,
                slug_or_name,
                &params.name,
                &params.description,
                mem_type,
                &params.body,
            )
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        self.build_advanced_list_response(&cwd, None)
    }

    pub fn handle_memory_advanced_folder_upsert(
        &self,
        params: &MemoryAdvancedFolderUpsertParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let folder = params.folder.trim();
        if folder.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "cowork/memory/advanced/folder/upsert: folder is required",
            ));
        }
        let cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/memory/advanced/folder/upsert",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.advanced_memory_store_for_workspace(&cwd);
        let slug_or_name = params
            .slug
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&params.name);
        let mem_type = params.r#type.as_deref().unwrap_or("project");
        store
            .upsert_entry(
                "workspace",
                Some(folder),
                slug_or_name,
                &params.name,
                &params.description,
                mem_type,
                &params.body,
            )
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        self.build_advanced_list_response(&cwd, Some(folder))
    }

    pub fn handle_memory_advanced_delete(
        &self,
        params: &MemoryAdvancedDeleteParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/memory/advanced/delete")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.advanced_memory_store_for_workspace(&cwd);
        store
            .delete_entry("workspace", None, params.slug.trim())
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        self.build_advanced_list_response(&cwd, None)
    }

    pub fn handle_memory_advanced_folder_delete(
        &self,
        params: &MemoryAdvancedFolderDeleteParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let folder = params.folder.trim();
        if folder.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "cowork/memory/advanced/folder/delete: folder is required",
            ));
        }
        let cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/memory/advanced/folder/delete",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let store = self.advanced_memory_store_for_workspace(&cwd);
        store
            .delete_entry("workspace", Some(folder), params.slug.trim())
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        self.build_advanced_list_response(&cwd, Some(folder))
    }

    async fn run_advanced_generate_for_thread(
        &self,
        method: &str,
        raw_cwd: Option<&str>,
        thread_id: &str,
        explicit_folder: Option<&str>,
    ) -> Result<Value, JsonRpcLiteError> {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: threadId is required"),
            ));
        }
        let cwd = self
            .resolve_workspace_path(raw_cwd, method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        self.journal.wait_for_idle(tid).await;
        let Some(live_arc) = self.load_thread(tid) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Unknown thread: {tid}"),
            ));
        };
        let (thread_cwd, messages, cursor, provider, model, session_overrides, session_opts) = {
            let live = live_arc.lock();
            (
                canonicalize_sync(Path::new(&live.cwd)),
                live.messages.clone(),
                live.last_memory_generated_index.unwrap_or(0),
                live.provider,
                live.model.clone(),
                live.config_overrides.clone(),
                live.provider_options_override(),
            )
        };
        if thread_cwd != cwd {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: thread does not belong to the requested workspace"),
            ));
        }

        // The thread's effective config: session overrides layered over the workspace config.
        let session_cfg = self.load_workspace_config(&cwd).ok().map(|mut cfg| {
            crate::turn_runner::apply_session_config_overrides(&mut cfg, &session_overrides);
            cfg
        });
        let advanced_memory = session_cfg.as_ref().map_or_else(
            || {
                session_overrides
                    .get("advancedMemory")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            },
            |cfg| cfg.advanced_memory,
        );
        // TS `runMemoryBackfill` is a no-op unless advanced memory is on, so the transcript
        // never reaches a memory model and the cursor stays put.
        if !advanced_memory {
            return self.build_advanced_list_response(&cwd, explicit_folder);
        }

        let adv_store = self.advanced_memory_store_for_workspace(&cwd);
        let sqlite_store = self.memory_store_for_workspace(&cwd);
        // Explicit generation runs model-based extraction (TS `MemoryGenerator.run`). The model
        // is resolved only when there is history to analyze; an unresolvable model fails the
        // call before anything is written, leaving the cursor (and the history) unprocessed.
        let has_delta = messages.len() >= cursor.saturating_add(2);
        let remote_model = if has_delta {
            let model_ref =
                explicit_memory_generation_model_ref(session_cfg.as_ref(), provider, &model);
            let provider_opts = merge_session_provider_options(
                session_cfg
                    .as_ref()
                    .and_then(|cfg| cfg.provider_options.clone()),
                session_opts,
            );
            let resolved = match self.thread_model_connection(provider, &provider_opts).await {
                Ok((transport, base_url, api_key)) => {
                    self.resolve_memory_generation_model(
                        &model_ref,
                        CurrentModelConnection {
                            provider,
                            transport: &transport,
                            base_url: &base_url,
                            api_key: &api_key,
                        },
                        &provider_opts,
                    )
                    .await
                }
                Err(err) => Err(err),
            };
            Some(resolved.map_err(|err| {
                JsonRpcLiteError::new(
                    error_codes::INTERNAL_ERROR,
                    format!(
                        "{method}: memory generation model '{model_ref}' is unavailable: {err}"
                    ),
                )
            })?)
        } else {
            None
        };
        let generator = MemoryGenerator::new();
        let next_cursor = generator
            .maybe_generate_from_transcript(
                &messages,
                cursor,
                Some(&sqlite_store),
                Some(&adv_store),
                remote_model,
            )
            .await
            .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;

        if let Some(folder) = explicit_folder {
            // Mirror newly generated entries into explicit folder when requested.
            let ws_dir = adv_store
                .resolve_scope_dir("workspace", None)
                .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
            if let Ok(entries) = adv_store.list_entries_in_dir(&ws_dir, "workspace") {
                for entry in entries {
                    let _ = adv_store.upsert_entry(
                        "workspace",
                        Some(folder),
                        &entry.slug,
                        &entry.name,
                        &entry.description,
                        &entry.memory_type,
                        &entry.body,
                    );
                }
            }
        }

        {
            let mut live = live_arc.lock();
            live.last_memory_generated_index = Some(next_cursor);
        }
        let _ = self
            .persist_live_session(&live_arc, "advanced_memory_generate")
            .await;

        self.build_advanced_list_response(&cwd, explicit_folder)
    }

    pub async fn handle_memory_advanced_generate(
        &self,
        params: &MemoryAdvancedGenerateParams,
    ) -> Result<Value, JsonRpcLiteError> {
        self.run_advanced_generate_for_thread(
            "cowork/memory/advanced/generate",
            params.cwd.as_deref(),
            &params.thread_id,
            None,
        )
        .await
    }

    pub async fn handle_memory_advanced_folder_generate(
        &self,
        params: &MemoryAdvancedFolderGenerateParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let folder = params.folder.trim();
        if folder.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "cowork/memory/advanced/folder/generate: folder is required",
            ));
        }
        self.run_advanced_generate_for_thread(
            "cowork/memory/advanced/folder/generate",
            params.cwd.as_deref(),
            &params.thread_id,
            Some(folder),
        )
        .await
    }

    /// Forks an existing thread into a local or isolated git worktree session (`thread/fork`).
    pub async fn handle_thread_fork(
        self: &Arc<Self>,
        connection_id: Option<&str>,
        params: &ThreadForkParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let src_id = params.thread_id.trim();
        if src_id.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "thread/fork: threadId is required",
            ));
        }
        // `LocalThreadHost.forkThread` parity: every guard below throws, and the `thread/fork`
        // route maps the thrown message to `invalidParams`.
        let invalid = |message: String| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, message);
        let prompt = params.prompt.as_deref().map(str::trim);
        if prompt.is_some_and(str::is_empty) {
            return Err(invalid(
                "fork_thread prompt must be non-empty when provided".to_owned(),
            ));
        }
        // `loadForkSource`: task ownership, task locks (including a parent's), existence,
        // busy state, then root-thread shape.
        if self.task_coordinator.is_task_thread(src_id) {
            return Err(invalid(
                "Task-owned threads are not managed by thread-management tools".to_owned(),
            ));
        }
        if let Some(lock) = self.get_session_task_lock(src_id) {
            return Err(invalid(lock.message));
        }
        let Some(src_arc) = self.load_thread(src_id) else {
            return Err(invalid(format!("Unknown thread: {src_id}")));
        };
        let src_snapshot = {
            let live = src_arc.lock();
            if live.busy || self.active_turns.contains_key(src_id) {
                return Err(invalid(
                    "Cannot fork a thread while it is running".to_owned(),
                ));
            }
            if live.session_kind != SessionKind::Root
                || live.parent_session_id.is_some()
                || live.role.is_some()
            {
                return Err(invalid("Only root threads can be forked".to_owned()));
            }
            live.clone()
        };
        let src_cwd = PathBuf::from(&src_snapshot.cwd);
        let fork_title = params
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Fork of {}", src_snapshot.title));
        let title_source = if params
            .title
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty())
        {
            SessionTitleSource::Manual
        } else {
            SessionTitleSource::Heuristic
        };

        let (fork_provider, fork_model) = match params
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            // `provider:modelId` refs (`parseThreadModelSelection` parity); model IDs may
            // themselves contain `/` (e.g. `nvidia/Nemotron-120B-A12B`).
            Some(raw_model) => {
                match parse_child_model_ref(raw_model, Some(src_snapshot.provider)) {
                    Some((parsed_provider, parsed_model, _, _)) => (parsed_provider, parsed_model),
                    None => (src_snapshot.provider, raw_model.to_owned()),
                }
            }
            None => (src_snapshot.provider, src_snapshot.model.clone()),
        };

        // `buildThreadReasoningOptionsPatch` validation runs before the fork target is created.
        let thinking = params
            .thinking
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(thinking) = thinking {
            self.validate_thread_reasoning(fork_provider, &fork_model, thinking)
                .map_err(invalid)?;
        }

        let (target_cwd, env_result_json) = match &params.environment {
            Some(ThreadEnvironment::Worktree {
                r#ref,
                branch_name,
                starting_state,
            }) => {
                let effective_ref = r#ref
                    .clone()
                    .or_else(|| starting_state.as_ref().and_then(|s| s.r#ref.clone()));
                let effective_branch = branch_name
                    .clone()
                    .or_else(|| starting_state.as_ref().and_then(|s| s.branch_name.clone()));
                let wt = self
                    .worktree_service
                    .create_worktree(WorktreeCreateOptions {
                        source_cwd: src_cwd,
                        base_ref: effective_ref,
                        branch_name: effective_branch,
                        title_hint: Some(fork_title.clone()),
                    })
                    .await
                    .map_err(|e| {
                        JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string())
                    })?;
                let wt_cwd = wt.path.to_string_lossy().into_owned();
                (
                    wt_cwd.clone(),
                    json!({
                        "type": "worktree",
                        "cwd": wt_cwd,
                        "branchName": wt.branch_name,
                        "baseRef": wt.base_ref,
                        "baseCommit": wt.base_commit,
                    }),
                )
            }
            _ => {
                let local_cwd = src_cwd.to_string_lossy().into_owned();
                (
                    local_cwd.clone(),
                    json!({
                        "type": "local",
                        "cwd": local_cwd,
                    }),
                )
            }
        };

        let src_snapshot_provider = src_snapshot.provider;
        let src_snapshot_model = src_snapshot.model.clone();
        let mut config_overrides = src_snapshot.config_overrides.clone();
        let mut requested_reasoning = src_snapshot.requested_reasoning_effort.clone();
        if let Some(thinking) = thinking {
            requested_reasoning = Some(thinking.to_owned());
            // The fork's effective section is its inherited override layered key by key over
            // the target workspace's options (as the turn runner merges them); the patch is
            // computed against it so a workspace `thinkingConfig` is overridden too.
            let provider_key = fork_provider.as_str();
            let workspace_section = self
                .load_workspace_config(Path::new(&target_cwd))
                .ok()
                .and_then(|cfg| cfg.provider_options)
                .and_then(|po| po.get(provider_key).and_then(Value::as_object).cloned())
                .unwrap_or_default();
            let po = config_overrides
                .entry("providerOptions".to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if !po.is_object() {
                *po = Value::Object(Map::new());
            }
            if let Some(po_map) = po.as_object_mut() {
                let mut section = po_map
                    .get(provider_key)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut current = workspace_section;
                current.extend(section.clone());
                // Only the patched reasoning key is stored, so workspace-only keys (endpoints
                // included) are never copied into the thread's override.
                let (key, value) =
                    thread_reasoning_options_entry(fork_provider, thinking, &current);
                section.insert(key.to_owned(), value);
                po_map.insert(provider_key.to_owned(), Value::Object(section));
            }
        }

        let new_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut subscribers = HashSet::new();
        if let Some(cid) = connection_id {
            subscribers.insert(cid.to_owned());
        }

        let (output_directory, uploads_directory) =
            self.new_session_io_dirs(std::path::Path::new(&target_cwd));
        let forked_live = LiveSession {
            id: new_id.clone(),
            session_kind: SessionKind::Root,
            parent_session_id: None,
            role: None,
            mode: None,
            depth: None,
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: None,
            effective_model: None,
            execution_state: None,
            sandbox: None,
            cwd: target_cwd,
            output_directory,
            uploads_directory,
            provider: fork_provider,
            model: fork_model,
            title: fork_title,
            title_source,
            title_model: None,
            last_message_preview: src_snapshot.last_message_preview.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
            message_count: src_snapshot.messages.len(),
            last_event_seq: 0,
            busy: false,
            has_pending_ask: false,
            has_pending_approval: false,
            enable_mcp: src_snapshot.enable_mcp,
            warn_at_usd: src_snapshot.warn_at_usd,
            stop_at_usd: src_snapshot.stop_at_usd,
            cost_tracker_snapshot: None,
            // Reset provider continuation state on fork so upstream thread IDs are never shared!
            provider_state: None,
            todos: src_snapshot.todos.clone(),
            workflow_runs: Vec::new(),
            last_memory_generated_index: src_snapshot.last_memory_generated_index,
            requested_reasoning_effort: requested_reasoning.clone(),
            effective_reasoning_effort: requested_reasoning,
            harness_context: src_snapshot.harness_context.clone(),
            config_overrides,
            messages: src_snapshot.messages,
            subscribers: subscribers.clone(),
            idle_since: subscribers.is_empty().then(std::time::Instant::now),
        };

        let mut forked_live = forked_live;
        if forked_live.provider != src_snapshot_provider || forked_live.model != src_snapshot_model
        {
            self.reconcile_live_reasoning_state(&mut forked_live);
        }
        let forked_arc = Arc::new(Mutex::new(forked_live));
        self.sessions.insert(new_id.clone(), forked_arc.clone());
        self.persist_live_session(&forked_arc, "thread/started")
            .await
            .map_err(|e| {
                JsonRpcLiteError::new(
                    error_codes::INTERNAL_ERROR,
                    format!("Failed to persist forked thread: {e}"),
                )
            })?;

        let thread = self.build_thread_from_live(&forked_arc.lock());
        let _ = self
            .journal
            .enqueue(ThreadJournalEventInput {
                thread_id: new_id.clone(),
                ts: now,
                event_type: "thread/started".to_owned(),
                turn_id: None,
                item_id: None,
                request_id: None,
                payload: json!({ "thread": thread }),
            })
            .await;

        if let Some(cid) = connection_id {
            self.send_to_connection(
                cid,
                &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: "thread/started".to_owned(),
                    params: Some(json!({ "thread": thread })),
                }),
            );
        }

        // TS fires the initial prompt and forgets it (`void sendUserMessage(...).catch(...)`):
        // the fork is already persisted and announced, so a failed kickoff must not fail the
        // call, and `queued` reflects only that a prompt was supplied.
        let queued = prompt.is_some();
        if let Some(prompt_text) = prompt {
            let start_params = TurnStartParams {
                thread_id: new_id.clone(),
                input: TurnInput::Text(prompt_text.to_owned()),
                client_message_id: None,
                references: None,
                retry: None,
            };
            if let Err(err) = self
                .handle_turn_start(connection_id.unwrap_or("internal"), false, &start_params)
                .await
            {
                tracing::warn!(
                    source_thread_id = %src_id,
                    thread_id = %new_id,
                    code = err.code,
                    error = %err.message,
                    "thread/fork: initial prompt kickoff failed"
                );
            }
        }

        let refreshed_thread = self.build_thread_from_live(&forked_arc.lock());
        Ok(json!({
            "sourceThreadId": src_id,
            "thread": refreshed_thread,
            "forked": true,
            "queued": queued,
            "environment": env_result_json,
        }))
    }
}

/// The memory model explicit generation runs on (TS `MemoryGenerator.resolveTargetConfig`):
/// `memoryGenerationModel`, else the preferred child model routed for the thread's
/// provider/model (`normalizeChildRoutingConfig`, which resets a preference the thread's
/// provider cannot use, or one left at the workspace default, to the thread's model), else the
/// thread's own model. A reference that does not parse falls back to the thread's model.
fn explicit_memory_generation_model_ref(
    cfg: Option<&AgentConfig>,
    provider: ProviderName,
    model: &str,
) -> String {
    let own_ref = format!("{}:{model}", provider.as_str());
    let Some(cfg) = cfg else {
        return own_ref;
    };
    let requested = cfg
        .memory_generation_model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let preferred = cfg.preferred_child_model_ref.trim();
            let workspace_default = format!("{}:{}", cfg.provider.as_str(), cfg.model);
            (!preferred.is_empty() && preferred != workspace_default).then(|| {
                normalize_child_routing_config(
                    provider,
                    model,
                    cfg.child_model_routing_mode,
                    Some(preferred),
                    Some(&cfg.allowed_child_model_refs),
                )
                .preferred_child_model_ref
            })
        });
    match requested {
        Some(r) if parse_child_model_ref(&r, Some(provider)).is_some() => r,
        _ => own_ref,
    }
}

/// Layers a thread's stored `providerOptions` override over the workspace options, one provider
/// section key at a time (the turn runner's merge).
fn merge_session_provider_options(
    workspace: Option<Map<String, Value>>,
    session: Option<Map<String, Value>>,
) -> Map<String, Value> {
    let mut merged = workspace.unwrap_or_default();
    for (key, value) in session.unwrap_or_default() {
        match (merged.get_mut(&key), value) {
            (Some(Value::Object(existing)), Value::Object(over)) => existing.extend(over),
            (_, other) => {
                merged.insert(key, other);
            }
        }
    }
    merged
}

/// `OPENAI_REASONING_EFFORT_VALUES` (`src/shared/openaiCompatibleOptions.ts`), in catalog order.
const OPENAI_REASONING_EFFORT_VALUES: [&str; 8] = [
    "none", "minimal", "light", "low", "medium", "high", "xhigh", "max",
];

/// `DEFAULT_OPENAI_REASONING_EFFORT_VALUES`: assumed for a model that declares no efforts
/// ("light" and "max" are opt-in).
const DEFAULT_OPENAI_REASONING_EFFORT_VALUES: [&str; 6] =
    ["none", "minimal", "low", "medium", "high", "xhigh"];

/// `GOOGLE_THINKING_LEVEL_VALUES` (`src/shared/googleThinking.ts`).
const GOOGLE_THINKING_LEVEL_VALUES: [&str; 4] = ["minimal", "low", "medium", "high"];

/// `GOOGLE_FLASH_MODEL_IDS`: the models that also accept the `minimal` thinking level.
const GOOGLE_FLASH_MODEL_IDS: [&str; 4] = [
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.5-flash",
];

/// `listGoogleReasoningEffortValuesForModel`.
fn google_reasoning_efforts_for_model(model_id: &str) -> Vec<String> {
    let levels: &[&str] = if GOOGLE_FLASH_MODEL_IDS.contains(&model_id) {
        &GOOGLE_THINKING_LEVEL_VALUES
    } else {
        &["low", "medium", "high"]
    };
    std::iter::once("dynamic")
        .chain(levels.iter().copied())
        .map(str::to_owned)
        .collect()
}

/// `openAiReasoningConfigForSupportedModel(...).availableEfforts`: `None` when the model has no
/// valid default effort.
fn openai_reasoning_efforts_for_model(model: &SupportedModel) -> Option<Vec<String>> {
    let default = model
        .provider_options_defaults
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .filter(|e| OPENAI_REASONING_EFFORT_VALUES.contains(e))?;
    let declared: Vec<&str> = match &model.supported_reasoning_efforts {
        Some(efforts) => efforts.iter().map(String::as_str).collect(),
        None => DEFAULT_OPENAI_REASONING_EFFORT_VALUES.to_vec(),
    };
    Some(
        OPENAI_REASONING_EFFORT_VALUES
            .iter()
            .filter(|e| **e == default || declared.contains(e))
            .map(|e| (*e).to_owned())
            .collect(),
    )
}

/// The provider-specific option `buildThreadReasoningOptionsPatch` writes for a validated
/// `thinking`, merged over `current` (the provider's effective options section): Google's
/// `thinkingConfig.thinkingLevel` (which the Google request builder prefers over
/// `reasoningEffort`), otherwise the OpenAI-style `reasoningEffort`.
fn thread_reasoning_options_entry(
    provider: ProviderName,
    thinking: &str,
    current: &Map<String, Value>,
) -> (&'static str, Value) {
    if provider == ProviderName::Google {
        let mut thinking_config = current
            .get("thinkingConfig")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        thinking_config.insert(
            "thinkingLevel".to_owned(),
            Value::String(thinking.to_owned()),
        );
        ("thinkingConfig", Value::Object(thinking_config))
    } else {
        ("reasoningEffort", Value::String(thinking.to_owned()))
    }
}

impl ServerRuntimeState {
    /// The thread's own model connection (transport, endpoint override, API key), built as the
    /// turn runner builds it for the chat.
    async fn thread_model_connection(
        &self,
        provider: ProviderName,
        provider_opts: &Map<String, Value>,
    ) -> Result<(Arc<dyn ProviderTransport>, Option<String>, Option<String>), String> {
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let conn_store = read_connection_store(&paths).await.ok();
        let api_key = resolve_provider_api_key(provider, conn_store.as_ref(), &self.env);
        let bedrock_auth = if provider == ProviderName::Bedrock {
            let mut auth =
                resolve_bedrock_auth_config(&self.homedir, &self.env, conn_store.as_ref());
            if let (Some(region), Some(cfg)) = (
                extract_bedrock_region_override(provider_opts),
                auth.as_mut(),
            ) {
                cfg.region = region;
                cfg.has_configured_region = true;
            }
            auth
        } else {
            None
        };
        let base_url = match provider {
            ProviderName::Lmstudio => Some(
                resolve_lmstudio_options(&self.env, Some(provider_opts), None).inference_base_url,
            ),
            other => provider_base_url_override(other, provider_opts, &self.env, true),
        };
        let transport =
            select_provider_transport(provider, bedrock_auth, &self.homedir, &self.env, None)?;
        Ok((transport, base_url, api_key))
    }

    /// Efforts the model declares (`assertModelReasoningEffort`): the discovery cache's
    /// advertised list first, then the bundled catalog; `None` keeps syntax-only validation.
    fn model_reasoning_efforts(&self, provider: ProviderName, model: &str) -> Option<Vec<String>> {
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        if let Some(efforts) =
            cowork_config::models::find_discovered_model_sync(&paths, provider, model)
                .and_then(|cached| cached.reasoning)
                .and_then(|reasoning| reasoning.available_efforts)
        {
            return Some(efforts);
        }
        let supported = self.model_registry().get(provider, model.trim())?;
        if supported.provider == ProviderName::Google {
            return Some(google_reasoning_efforts_for_model(&supported.id));
        }
        openai_reasoning_efforts_for_model(supported)
    }

    /// `buildThreadReasoningOptionsPatch` validation: OpenAI/Codex take an OpenAI reasoning
    /// effort, Google a thinking level, both limited to what the model declares; every other
    /// provider rejects reasoning overrides.
    fn validate_thread_reasoning(
        &self,
        provider: ProviderName,
        model: &str,
        thinking: &str,
    ) -> Result<(), String> {
        match provider {
            ProviderName::Openai | ProviderName::CodexCli => {
                if !OPENAI_REASONING_EFFORT_VALUES.contains(&thinking) {
                    return Err(format!(
                        "Unsupported reasoning effort for {}: {thinking}",
                        provider.as_str()
                    ));
                }
            }
            ProviderName::Google => {
                if !GOOGLE_THINKING_LEVEL_VALUES.contains(&thinking) {
                    return Err(format!("Unsupported Google thinking level: {thinking}"));
                }
            }
            other => {
                return Err(format!(
                    "Reasoning/thinking overrides are not supported for provider {}",
                    other.as_str()
                ));
            }
        }
        if let Some(available) = self.model_reasoning_efforts(provider, model)
            && !available.iter().any(|e| e == thinking)
        {
            return Err(format!(
                "Unsupported reasoning effort for {}:{model}: {thinking}. Supported efforts: {}",
                provider.as_str(),
                available.join(", ")
            ));
        }
        Ok(())
    }
}

const LIST_THREADS_DEFAULT_LIMIT: usize = 50;
const LIST_THREADS_MAX_LIMIT: usize = 200;

/// TS `clampPositiveInteger(input.limit, 50, 200)`.
fn list_threads_limit(args: &Value) -> usize {
    match args.get("limit").and_then(Value::as_u64) {
        None => LIST_THREADS_DEFAULT_LIMIT,
        Some(n) => usize::try_from(n)
            .unwrap_or(usize::MAX)
            .clamp(1, LIST_THREADS_MAX_LIMIT),
    }
}

/// TS `LocalThreadHost.threadMatchesQuery`; `query` is already trimmed and lowercased.
fn list_thread_matches_query(thread: &JsonRpcThread, query: &str) -> bool {
    [&thread.id, &thread.title, &thread.preview, &thread.cwd]
        .iter()
        .any(|value| value.to_lowercase().contains(query))
}

/// TS `LocalThreadHost.compareThreads`: exact id match (when querying), then pinned, then
/// most recently updated first.
fn compare_listed_threads(
    left: &JsonRpcThread,
    right: &JsonRpcThread,
    query: &str,
) -> std::cmp::Ordering {
    let exact = |thread: &JsonRpcThread| !query.is_empty() && thread.id.to_lowercase() == query;
    exact(right)
        .cmp(&exact(left))
        .then_with(|| right.pinned.cmp(&left.pinned))
        .then_with(|| right.updated_at.cmp(&left.updated_at))
}

pub struct ServerThreadControlBridge {
    pub runtime: Arc<ServerRuntimeState>,
    pub connection_id: String,
}

#[async_trait]
impl ThreadControlBridge for ServerThreadControlBridge {
    async fn list_projects(&self) -> Result<Value, String> {
        let (workspaces, active_id) = build_workspace_summaries(
            &self.runtime.working_directory,
            &self.runtime.homedir,
            self.runtime.desktop_service.as_deref(),
        );
        Ok(json!({
            "projects": workspaces,
            "activeWorkspaceId": active_id,
        }))
    }

    async fn list_threads(&self, args: Value) -> Result<Value, String> {
        let raw_cwd = args.get("cwd").and_then(Value::as_str);
        let limit = list_threads_limit(&args);
        let include_archived = args
            .get("includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(|q| q.trim().to_lowercase())
            .unwrap_or_default();
        let cwd = self
            .runtime
            .resolve_workspace_path(raw_cwd, "list_threads")?;
        // Fetch the full (unpaginated) workspace list so the archive/query filters run
        // before `total` and the limit, matching TS `LocalThreadHost.listThreads`.
        let (threads, _) = self.runtime.list_workspace_threads(&cwd, None, None);
        let mut filtered: Vec<_> = threads
            .into_iter()
            .filter(|thread| {
                if query.is_empty() {
                    include_archived || !thread.archived
                } else {
                    list_thread_matches_query(thread, &query)
                }
            })
            .collect();
        filtered.sort_by(|left, right| compare_listed_threads(left, right, &query));
        let total = filtered.len();
        filtered.truncate(limit);
        Ok(json!({
            "threads": filtered,
            "total": total,
        }))
    }

    async fn read_thread(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        let include_turns = args
            .get("includeTurns")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        self.runtime
            .read_or_hydrate_thread(thread_id, 0, include_turns)
            .await
    }

    async fn create_thread(&self, args: Value) -> Result<Value, String> {
        let raw_cwd = args.get("cwd").and_then(Value::as_str);
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let env_kind = args
            .get("environment")
            .and_then(Value::as_str)
            .unwrap_or("local");
        let branch_name = args
            .get("branchName")
            .and_then(Value::as_str)
            .map(str::to_owned);

        let base_cwd = self
            .runtime
            .resolve_workspace_path(raw_cwd, "create_thread")?;
        let target_cwd = if env_kind == "worktree" {
            let wt = self
                .runtime
                .worktree_service
                .create_worktree(WorktreeCreateOptions {
                    source_cwd: base_cwd,
                    base_ref: None,
                    branch_name,
                    title_hint: title.map(str::to_owned),
                })
                .await
                .map_err(|e| e.to_string())?;
            wt.path
        } else {
            base_cwd
        };

        let (mut thread, _) = self
            .runtime
            .start_or_get_thread(&target_cwd, None, None, model, &self.connection_id)
            .await?;
        if let Some(t) = title {
            let _ = self.runtime.set_session_title(&thread.id, t).await?;
            if let Some(live) = self.runtime.get_live_thread(&thread.id) {
                thread = self.runtime.build_thread_from_live(&live.lock());
            }
        }
        Ok(json!({ "thread": thread }))
    }

    async fn send_message_to_thread(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        if let Some(lock) = self.runtime.get_session_task_lock(thread_id) {
            return Err(lock.message);
        }
        let message = args
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| "message is required".to_owned())?;
        self.runtime
            .handle_turn_start(
                &self.connection_id,
                false,
                &TurnStartParams {
                    thread_id: thread_id.to_owned(),
                    input: TurnInput::Text(message.to_owned()),
                    client_message_id: None,
                    references: None,
                    retry: None,
                },
            )
            .await
            .map_err(|e| e.message)
    }

    async fn fork_thread(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        let title = args.get("title").and_then(Value::as_str).map(str::to_owned);
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let model = args.get("model").and_then(Value::as_str).map(str::to_owned);
        let branch_name = args
            .get("branchName")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let environment = match args.get("environment") {
            Some(Value::String(s)) if s == "worktree" => Some(ThreadEnvironment::Worktree {
                r#ref: None,
                branch_name,
                starting_state: None,
            }),
            Some(Value::String(_)) => Some(ThreadEnvironment::Local {}),
            Some(other) => serde_json::from_value::<ThreadEnvironment>(other.clone()).ok(),
            None => None,
        };
        self.runtime
            .handle_thread_fork(
                Some(&self.connection_id),
                &ThreadForkParams {
                    thread_id: thread_id.to_owned(),
                    environment,
                    title,
                    prompt,
                    model,
                    thinking: None,
                },
            )
            .await
            .map_err(|e| e.message)
    }

    async fn set_thread_title(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| "title is required".to_owned())?;
        self.runtime.set_session_title(thread_id, title).await
    }

    async fn set_thread_pinned(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
        let pinned = args
            .get("pinned")
            .and_then(Value::as_bool)
            .ok_or_else(|| "pinned is required".to_owned())?;
        let thread = self.runtime.set_thread_pinned(thread_id, pinned).await?;
        Ok(json!({ "thread": thread }))
    }

    async fn set_thread_archived(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
        let archived = args
            .get("archived")
            .and_then(Value::as_bool)
            .ok_or_else(|| "archived is required".to_owned())?;
        let thread = self
            .runtime
            .set_thread_archived(thread_id, archived)
            .await?;
        Ok(json!({ "thread": thread }))
    }
}
