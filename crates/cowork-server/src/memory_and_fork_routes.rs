use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{
    ProviderName, canonicalize_sync, get_ai_coworker_paths, get_one_off_chats_root,
};
use cowork_harness::MemoryGenerator;
use cowork_protocol::{
    JsonRpcLiteError, JsonRpcLiteNotification, JsonRpcLiteOutbound, MemoryAdvancedDeleteParams,
    MemoryAdvancedFolderDeleteParams, MemoryAdvancedFolderGenerateParams,
    MemoryAdvancedFolderListParams, MemoryAdvancedFolderUpsertParams, MemoryAdvancedGenerateParams,
    MemoryAdvancedListParams, MemoryAdvancedUpsertParams, MemoryDeleteParams, MemoryListParams,
    MemoryUpsertParams, ThreadEnvironment, ThreadForkParams, TurnInput, TurnStartParams,
    error_codes,
};
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
                "entries": entries,
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
        let entries = store
            .list(Some(scope))
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({
            "event": {
                "type": "memory_list",
                "scope": scope,
                "entry": entry,
                "entries": entries,
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
        let entries = store
            .list(Some(scope))
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({
            "event": {
                "type": "memory_list",
                "scope": scope,
                "deleted": deleted,
                "entries": entries,
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
                "entries": entries,
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
        let (thread_cwd, messages, cursor) = {
            let live = live_arc.lock();
            (
                canonicalize_sync(Path::new(&live.cwd)),
                live.messages.clone(),
                live.last_memory_generated_index.unwrap_or(0),
            )
        };
        if thread_cwd != cwd {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: thread does not belong to the requested workspace"),
            ));
        }

        let adv_store = self.advanced_memory_store_for_workspace(&cwd);
        let sqlite_store = self.memory_store_for_workspace(&cwd);
        let generator = MemoryGenerator::new();
        let next_cursor = generator
            .maybe_generate_from_transcript(
                &messages,
                cursor,
                Some(&sqlite_store),
                Some(&adv_store),
                None,
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
        let Some(src_arc) = self.load_thread(src_id) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Unknown thread: {src_id}"),
            ));
        };

        let src_snapshot = src_arc.lock().clone();
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

        let (fork_provider, fork_model) = match params
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(raw_model) => {
                if let Some((prov_str, mod_str)) = raw_model.split_once('/')
                    && let Some(parsed_prov) = ProviderName::parse(prov_str)
                {
                    (parsed_prov, mod_str.to_owned())
                } else {
                    (src_snapshot.provider, raw_model.to_owned())
                }
            }
            None => (src_snapshot.provider, src_snapshot.model.clone()),
        };

        let mut config_overrides = src_snapshot.config_overrides.clone();
        let mut requested_reasoning = src_snapshot.requested_reasoning_effort.clone();
        if let Some(thinking) = params
            .thinking
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            requested_reasoning = Some(thinking.to_owned());
            let po = config_overrides
                .entry("providerOptions".to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(po_map) = po.as_object_mut() {
                let prov_entry = po_map
                    .entry(fork_provider.as_str().to_owned())
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Some(prov_map) = prov_entry.as_object_mut() {
                    prov_map.insert(
                        "reasoningEffort".to_owned(),
                        Value::String(thinking.to_owned()),
                    );
                }
            }
        }

        let new_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut subscribers = HashSet::new();
        if let Some(cid) = connection_id {
            subscribers.insert(cid.to_owned());
        }

        let forked_live = LiveSession {
            id: new_id.clone(),
            session_kind: SessionKind::Root,
            cwd: target_cwd,
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
            last_memory_generated_index: src_snapshot.last_memory_generated_index,
            requested_reasoning_effort: requested_reasoning.clone(),
            effective_reasoning_effort: requested_reasoning,
            harness_context: src_snapshot.harness_context.clone(),
            config_overrides,
            messages: src_snapshot.messages,
            subscribers: subscribers.clone(),
            idle_since: subscribers.is_empty().then(std::time::Instant::now),
        };

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

        let mut queued = false;
        if let Some(prompt_text) = params
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let start_params = TurnStartParams {
                thread_id: new_id.clone(),
                input: TurnInput::Text(prompt_text.to_owned()),
                client_message_id: None,
                references: None,
                retry: None,
            };
            let _ = self
                .handle_turn_start(connection_id.unwrap_or("internal"), false, &start_params)
                .await?;
            queued = true;
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
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let include_archived = args
            .get("includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cwd = self
            .runtime
            .resolve_workspace_path(raw_cwd, "list_threads")?;
        let (mut threads, total) = self.runtime.list_workspace_threads(&cwd, None, limit);
        if !include_archived {
            threads.retain(|t| !t.archived);
        }
        Ok(json!({
            "threads": threads,
            "total": total,
        }))
    }

    async fn read_thread(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_owned())?;
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
