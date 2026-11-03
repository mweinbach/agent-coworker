use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{
    AgentConfig, ProviderName, SupportedModel, canonicalize_sync, get_ai_coworker_paths,
    get_one_off_chats_root, normalize_child_routing_config, parse_child_model_ref,
    project_memory_db_path, read_connection_store, same_workspace_path, user_memory_db_path,
};
use cowork_harness::{
    GeneratedNoteTarget, MemoryGenerator, RemoteMemoryModel, generated_note_target,
};
use cowork_protocol::{
    JsonRpcLiteError, JsonRpcLiteNotification, JsonRpcLiteOutbound, JsonRpcThread,
    JsonRpcWorkspaceSummary, MemoryAdvancedDeleteParams, MemoryAdvancedFolderDeleteParams,
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

use crate::http_desktop::{build_workspace_summaries, fnv1a32_hex};
use crate::registry::{LiveSession, ServerRuntimeState};
use crate::turn_runner::{
    CurrentModelConnection, provider_base_url_override, select_provider_transport,
};

/// Holds a thread's advanced-memory generation slot (TS `memoryGenerationQueue`). Generations
/// on one thread run one at a time in FIFO order (tokio's mutex is fair), so each reads the
/// transcript cursor only once the previous one has committed. Dropping the last guard (with no
/// waiter left) removes the thread's entry, so the map never outlives in-flight generations.
pub(crate) struct MemoryGenerationGuard<'a> {
    locks: &'a dashmap::DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    thread_id: String,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Drop for MemoryGenerationGuard<'_> {
    fn drop(&mut self) {
        drop(self.guard.take());
        // Only the map's own reference is left once no generation holds or awaits the lock;
        // `remove_if` checks that under the shard lock, so a concurrent `lock` either cloned
        // the entry first (and keeps it) or inserts a fresh one afterwards.
        self.locks
            .remove_if(&self.thread_id, |_, lock| Arc::strong_count(lock) == 1);
    }
}

/// Commits an advanced-memory cursor checkpoint. The cursor only moves forward (TS
/// `Math.max(lastMemoryGeneratedIndex, ...)`); returns whether it changed.
pub(crate) fn advance_memory_cursor(live: &Mutex<LiveSession>, next_index: usize) -> bool {
    let mut live = live.lock();
    if next_index <= live.last_memory_generated_index.unwrap_or(0) {
        return false;
    }
    live.last_memory_generated_index = Some(next_index);
    true
}

impl ServerRuntimeState {
    /// Waits for the thread's earlier advanced-memory generations to finish, then returns the
    /// guard serializing this one. Callers read the cursor after this returns.
    pub(crate) async fn lock_memory_generation(
        &self,
        thread_id: &str,
    ) -> MemoryGenerationGuard<'_> {
        let lock = Arc::clone(
            self.memory_generation_locks
                .entry(thread_id.to_owned())
                .or_default()
                .value(),
        );
        // Built before the wait: if the caller is cancelled while queued, the pending wait (and
        // its `Arc`) drops first, then this guard's `Drop` removes the entry when it was the
        // last reference.
        let mut guard = MemoryGenerationGuard {
            locks: &self.memory_generation_locks,
            thread_id: thread_id.to_owned(),
            guard: None,
        };
        guard.guard = Some(lock.lock_owned().await);
        guard
    }

    /// Threads with an advanced-memory generation running or queued.
    pub fn memory_generation_queue_count(&self) -> usize {
        self.memory_generation_locks.len()
    }

    /// The SQLite memory store every memory RPC, tool, and turn prompt reads. Paths match
    /// `AgentSession` / `AgentConfig::project_memory_db_path`: `<cwd>/.cowork/memory.sqlite`
    /// (the shared `<home>/.cowork/chats/.cowork/memory.sqlite` for one-off chats) and
    /// `~/.cowork/memory.sqlite`, so memories saved by earlier installs stay visible.
    pub fn memory_store_for_workspace(&self, cwd: &Path) -> MemoryStore {
        let ai_paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        MemoryStore::new(
            project_memory_db_path(cwd, &self.homedir),
            user_memory_db_path(&ai_paths.root_dir),
        )
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
        // `folder` / `folders` / `memories` is the TS `advanced_memory_list` event: `memories`
        // is the listed folder only, and the shared `(chats)` folder is reached (and edited) by
        // name through `folders` + the `folder/*` routes. `globalEntries` (Rust addition) holds
        // the session's cross-workspace memories the way `recallMemory` scope `global` reads
        // them: the shared `(chats)` folder, then `_global`, minus the folder already listed.
        let global_entries: Vec<_> = store
            .readable_scope_dirs()
            .into_iter()
            .filter(|(scope, other)| {
                *scope != cowork_tools::memory::WORKSPACE_SCOPE_LABEL && *other != dir
            })
            .flat_map(|(scope, other)| store.list_entries_in_dir(&other, scope).unwrap_or_default())
            .collect();
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
        // An omitted type keeps an edited entry's type and makes a new one a `note` (TS).
        let mem_type = params.r#type.as_deref().unwrap_or("");
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
        // An omitted type keeps an edited entry's type and makes a new one a `note` (TS).
        let mem_type = params.r#type.as_deref().unwrap_or("");
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
        let (thread_cwd, messages, provider, model, session_overrides, session_opts) = {
            let live = live_arc.lock();
            (
                canonicalize_sync(Path::new(&live.cwd)),
                live.messages.clone(),
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
        // TS `resolveAdvancedMemoryFolder`: the requested folder, else the thread's own folder.
        // Only the thread's own folder carries the automatic checkpoint
        // (`shouldCheckpointAutomaticGeneration`).
        let current_folder = adv_store.workspace_folder_key();
        let target_folder = explicit_folder
            .map(str::trim)
            .filter(|f| !f.is_empty() && *f != current_folder);
        if let Some(folder) = target_folder {
            adv_store
                .resolve_scope_dir("workspace", Some(folder))
                .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, e.to_string()))?;
        }
        // Explicit generation (TS `runMemoryBackfill`) analyzes the complete history, whatever
        // the automatic cursor says, with model-based extraction (`MemoryGenerator.run`). The
        // model is resolved only when there is history to analyze; an unresolvable model fails
        // the call before anything is written, leaving the cursor (and the history) unprocessed.
        let has_history = messages.len() >= 2;
        let remote_model = if has_history {
            let model_ref = memory_generation_model_ref(session_cfg.as_ref(), provider, &model);
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
        // TS `generateAdvancedMemoryForHistory` runs on the session's `memoryGenerationQueue`,
        // after any automatic generation already queued for this thread.
        let _generation = self.lock_memory_generation(tid).await;
        let generator = MemoryGenerator::new();
        let processed = match target_folder {
            None => generator
                .maybe_generate_from_transcript(
                    &messages,
                    0,
                    Some(&sqlite_store),
                    Some(&adv_store),
                    remote_model,
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?,
            Some(folder) => {
                self.generate_into_folder(
                    &generator,
                    &messages,
                    &sqlite_store,
                    &adv_store,
                    &cwd,
                    folder,
                    remote_model,
                )
                .await?
            }
        };

        // `generateAdvancedMemoryForHistory`: the automatic checkpoint only moves forward, and
        // only for the thread's own folder.
        if target_folder.is_none() && advance_memory_cursor(&live_arc, processed) {
            let _ = self
                .persist_live_session(&live_arc, "advanced_memory_generate")
                .await;
        }

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
            // `resolveForkModelSelection`: an explicit `provider:modelId` ref switches provider,
            // anything else is a model ID on the source thread's provider.
            Some(raw_model) => {
                let (parsed_provider, parsed_model) =
                    parse_thread_model_selection(raw_model, src_snapshot.provider)
                        .map_err(invalid)?;
                (
                    parsed_provider.unwrap_or(src_snapshot.provider),
                    parsed_model,
                )
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
                // TS `resolveForkTarget`: `ensureDesktopWorkspace(worktree.path,
                // `${titleHint} worktree`, "project")`.
                self.ensure_desktop_worktree_workspace(&wt.path, &format!("{fork_title} worktree"));
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
            let workspace_section =
                self.workspace_provider_section(Path::new(&target_cwd), fork_provider);
            apply_thread_thinking_override(
                &mut config_overrides,
                workspace_section,
                fork_provider,
                thinking,
            );
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
            active_cost_tracker: None,
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
            system_prompt: String::new(),
            subscribers: subscribers.clone(),
            idle_since: subscribers.is_empty().then(std::time::Instant::now),
            persistence_status: cowork_storage::SessionPersistenceStatus::Active,
            stored_seq: 0,
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

/// The memory model automatic and explicit generation run on (TS
/// `MemoryGenerator.resolveTargetConfig`):
/// `memoryGenerationModel`, else the preferred child model routed for the thread's
/// provider/model (`normalizeChildRoutingConfig`, which resets a preference the thread's
/// provider cannot use, or one left at the workspace default, to the thread's model), else the
/// thread's own model. A reference that does not parse falls back to the thread's model.
pub(crate) fn memory_generation_model_ref(
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

/// Writes a validated `thinking` into a thread's `providerOptions` override (TS
/// `applyThinking`: `setConfig({ providerOptions: buildThreadReasoningOptionsPatch(...) })`).
/// The thread's effective section is its own override layered key by key over the workspace's
/// options (as the turn runner merges them); the patch is computed against it so a workspace
/// `thinkingConfig` is overridden too. Only the patched reasoning key is stored, so
/// workspace-only keys (endpoints included) are never copied into the thread's override.
fn apply_thread_thinking_override(
    config_overrides: &mut Map<String, Value>,
    workspace_section: Map<String, Value>,
    provider: ProviderName,
    thinking: &str,
) {
    let provider_key = provider.as_str();
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
        let (key, value) = thread_reasoning_options_entry(provider, thinking, &current);
        section.insert(key.to_owned(), value);
        po_map.insert(provider_key.to_owned(), Value::Object(section));
    }
}

impl ServerRuntimeState {
    /// The workspace config's `providerOptions` section for `provider` at `cwd` (empty when
    /// the workspace config cannot be loaded or has none).
    fn workspace_provider_section(&self, cwd: &Path, provider: ProviderName) -> Map<String, Value> {
        self.load_workspace_config(cwd)
            .ok()
            .and_then(|cfg| cfg.provider_options)
            .and_then(|po| {
                po.get(provider.as_str())
                    .and_then(Value::as_object)
                    .cloned()
            })
            .unwrap_or_default()
    }

    /// TS `LocalThreadHost.applyThinking` for an existing thread: validates `thinking` against
    /// the thread's current provider/model (`buildThreadReasoningOptionsPatch`), then stores it
    /// as the thread's reasoning override exactly as `thread/fork { thinking }` does.
    async fn apply_thread_thinking(&self, thread_id: &str, thinking: &str) -> Result<(), String> {
        let live_arc = self
            .load_thread(thread_id)
            .ok_or_else(|| format!("Unknown thread: {thread_id}"))?;
        let (provider, model, cwd) = {
            let live = live_arc.lock();
            (live.provider, live.model.clone(), PathBuf::from(&live.cwd))
        };
        self.validate_thread_reasoning(provider, &model, thinking)?;
        let workspace_section = self.workspace_provider_section(&cwd, provider);
        {
            let mut live = live_arc.lock();
            apply_thread_thinking_override(
                &mut live.config_overrides,
                workspace_section,
                provider,
                thinking,
            );
            live.requested_reasoning_effort = Some(thinking.to_owned());
            live.effective_reasoning_effort = Some(thinking.to_owned());
            live.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        }
        self.persist_live_session(&live_arc, "session_config")
            .await
            .map_err(|e| e.to_string())
    }
}

impl ServerRuntimeState {
    /// Runs extraction for a folder other than the thread's own (TS passes the selected folder
    /// to `MemoryGenerator.run`). The generator writes into its store's workspace folder, so it
    /// runs against a scratch store and only the memories it extracted are written into
    /// `folder`, under identities resolved against that folder (see `generated_note_target`);
    /// nothing else in the workspace reaches the target folder. Returns the number of leading
    /// messages processed.
    #[allow(clippy::too_many_arguments)]
    async fn generate_into_folder(
        &self,
        generator: &MemoryGenerator,
        messages: &[Value],
        sqlite_store: &MemoryStore,
        adv_store: &AdvancedMemoryStore,
        cwd: &Path,
        folder: &str,
        remote_model: Option<RemoteMemoryModel>,
    ) -> Result<usize, JsonRpcLiteError> {
        let internal = |m: String| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m);
        let ai_paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let scratch_home = ai_paths
            .root_dir
            .join("tmp")
            .join(format!("memory-generate-{}", Uuid::new_v4().simple()));
        let scratch = AdvancedMemoryStore::new(
            scratch_home.clone(),
            canonicalize_sync(cwd),
            canonicalize_sync(&get_one_off_chats_root(&self.homedir)),
        );
        let generated = generator
            .maybe_generate_from_transcript(
                messages,
                0,
                Some(sqlite_store),
                Some(&scratch),
                remote_model,
            )
            .await;
        let copied = generated.and_then(|processed| {
            let dir = scratch
                .resolve_scope_dir("workspace", None)
                .map_err(|e| e.to_string())?;
            for entry in scratch
                .list_entries_in_dir(&dir, "workspace")
                .map_err(|e| e.to_string())?
            {
                // The scratch slug was chosen against an empty store; re-resolve the note's
                // identity against the target folder so an identical note already there is left
                // as is and a different note (e.g. one the user edited) is never overwritten.
                let slug = match generated_note_target(adv_store, Some(folder), &entry.body) {
                    GeneratedNoteTarget::Existing(_) => continue,
                    GeneratedNoteTarget::New(slug) => slug,
                };
                adv_store
                    .upsert_entry(
                        "workspace",
                        Some(folder),
                        &slug,
                        &entry.name,
                        &entry.description,
                        &entry.memory_type,
                        &entry.body,
                    )
                    .map_err(|e| e.to_string())?;
            }
            Ok(processed)
        });
        let _ = std::fs::remove_dir_all(&scratch_home);
        copied.map_err(internal)
    }

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
        let transport = select_provider_transport(
            provider,
            bedrock_auth,
            &self.homedir,
            &self.env,
            None,
            Some(&self.built_in_dir),
        )?;
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
const READ_THREAD_DEFAULT_TURN_LIMIT: usize = 10;
const READ_THREAD_MAX_TURN_LIMIT: usize = 50;
const READ_THREAD_DEFAULT_OUTPUT_CHARS: usize = 2_000;
const READ_THREAD_MAX_OUTPUT_CHARS: usize = 20_000;
const READ_THREAD_TEXT_ITEM_CHARS: usize = 20_000;

/// TS `clampPositiveInteger(value, fallback, max)`: non-numbers fall back; numbers are
/// floored and clamped to `1..=max`.
fn clamp_positive_integer(value: Option<&Value>, fallback: usize, max: usize) -> usize {
    match value.and_then(Value::as_f64).filter(|n| n.is_finite()) {
        None => fallback,
        // Saturating float-to-int cast; negatives become 0 and are then raised to 1.
        Some(n) => (n.floor().min(max as f64) as usize).clamp(1, max),
    }
}

/// TS `clampPositiveInteger(input.limit, 50, 200)`.
fn list_threads_limit(args: &Value) -> usize {
    clamp_positive_integer(
        args.get("limit"),
        LIST_THREADS_DEFAULT_LIMIT,
        LIST_THREADS_MAX_LIMIT,
    )
}

/// A `list_threads` entry: the thread plus the project workspace it belongs to (TS
/// `ThreadSummary.projectId` / `projectName`, set only for `project` workspaces).
struct ListedThread {
    thread: JsonRpcThread,
    project: Option<(String, String)>,
}

impl ListedThread {
    fn new(thread: JsonRpcThread, workspaces: &[JsonRpcWorkspaceSummary]) -> Self {
        // TS `findWorkspaceForPath` takes the first workspace at the path, then keeps it only
        // when it is a project.
        let project = workspaces
            .iter()
            .find(|w| same_workspace_path(&w.path, &thread.cwd))
            .filter(|w| w.workspace_kind == "project")
            .map(|w| (w.id.clone(), w.name.clone()));
        Self { thread, project }
    }

    fn into_json(self) -> Value {
        let mut value = serde_json::to_value(&self.thread).unwrap_or(Value::Null);
        if let (Some((id, name)), Some(obj)) = (self.project, value.as_object_mut()) {
            obj.insert("projectId".to_owned(), Value::String(id));
            obj.insert("projectName".to_owned(), Value::String(name));
        }
        value
    }
}

/// TS `LocalThreadHost.threadMatchesQuery`; `query` is already trimmed and lowercased.
fn list_thread_matches_query(listed: &ListedThread, query: &str) -> bool {
    let thread = &listed.thread;
    let (project_id, project_name) = listed
        .project
        .as_ref()
        .map_or(("", ""), |(id, name)| (id.as_str(), name.as_str()));
    [
        thread.id.as_str(),
        thread.title.as_str(),
        thread.preview.as_str(),
        thread.cwd.as_str(),
        project_id,
        project_name,
    ]
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

/// TS `truncateText`: keeps the first `max_chars` characters and appends an ellipsis.
fn truncate_compact_text(value: &str, max_chars: usize) -> (String, bool) {
    match value.char_indices().nth(max_chars) {
        None => (value.to_owned(), false),
        Some((cut, _)) => (format!("{}…", &value[..cut]), true),
    }
}

fn compact_text(value: Option<&Value>) -> Value {
    let text = value.and_then(Value::as_str).unwrap_or_default();
    Value::String(truncate_compact_text(text, READ_THREAD_TEXT_ITEM_CHARS).0)
}

/// TS `stringifyToolOutput`: strings as-is, anything else as 2-space-indented JSON.
fn stringify_tool_output(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

/// TS `projectedUserMessageText`.
fn projected_user_message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

#[derive(Clone, Copy)]
struct CompactReadOptions {
    include_outputs: bool,
    max_output_chars: usize,
}

/// TS `projectedItemToCompact`: one projected `thread/read` item as a compact
/// `CompactThreadItem`, or `None` for item types the compact transcript omits.
fn projected_item_to_compact(item: &Value, opts: CompactReadOptions) -> Option<Value> {
    let compact = match item.get("type").and_then(Value::as_str)? {
        "userMessage" => json!({
            "type": "user",
            "text": truncate_compact_text(
                &projected_user_message_text(item),
                READ_THREAD_TEXT_ITEM_CHARS,
            )
            .0,
        }),
        "agentMessage" => json!({ "type": "assistant", "text": compact_text(item.get("text")) }),
        "reasoning" => json!({
            "type": "reasoning",
            "mode": if item.get("mode").and_then(Value::as_str) == Some("summary") {
                "summary"
            } else {
                "reasoning"
            },
            "text": compact_text(item.get("text")),
        }),
        "toolCall" => {
            let mut tool = Map::new();
            tool.insert("type".to_owned(), json!("tool"));
            tool.insert(
                "toolName".to_owned(),
                json!(
                    item.get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                ),
            );
            tool.insert(
                "state".to_owned(),
                json!(
                    item.get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ),
            );
            if let Some(args) = item.get("args") {
                tool.insert("args".to_owned(), args.clone());
            }
            if opts.include_outputs
                && let Some(result) = item.get("result")
            {
                let (output, truncated) =
                    truncate_compact_text(&stringify_tool_output(result), opts.max_output_chars);
                tool.insert("output".to_owned(), Value::String(output));
                if truncated {
                    tool.insert("outputTruncated".to_owned(), Value::Bool(true));
                }
            }
            Value::Object(tool)
        }
        "error" => json!({ "type": "error", "message": compact_text(item.get("message")) }),
        "system" => json!({ "type": "system", "line": compact_text(item.get("line")) }),
        "log" => json!({ "type": "log", "line": compact_text(item.get("line")) }),
        "todos" => json!({
            "type": "todos",
            "todos": item
                .get("todos")
                .filter(|todos| todos.is_array())
                .cloned()
                .unwrap_or_else(|| json!([])),
        }),
        _ => return None,
    };
    Some(compact)
}

/// TS `compactProjectedTurns`.
fn compact_projected_turn(turn: &Value, opts: CompactReadOptions) -> Value {
    let items: Vec<Value> = turn
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| projected_item_to_compact(item, opts))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": turn.get("id").cloned().unwrap_or(Value::Null),
        "status": turn.get("status").cloned().unwrap_or(Value::Null),
        "items": items,
    })
}

/// TS `encodeCursor`: base64url JSON `{ beforeTurnIndex }`.
fn encode_read_thread_cursor(before_turn_index: usize) -> String {
    data_encoding::BASE64URL_NOPAD.encode(
        json!({ "beforeTurnIndex": before_turn_index })
            .to_string()
            .as_bytes(),
    )
}

/// TS `decodeCursor`: no cursor starts at the newest turn; a cursor's index is floored and
/// clamped to `0..=total_turns`.
fn decode_read_thread_cursor(raw: Option<&str>, total_turns: usize) -> Result<usize, String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(total_turns);
    };
    let invalid = || "Invalid thread cursor".to_owned();
    let bytes = data_encoding::BASE64URL_NOPAD
        .decode(raw.trim_end_matches('=').as_bytes())
        .map_err(|_| invalid())?;
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let index = parsed
        .get("beforeTurnIndex")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(invalid)?;
    Ok((index.floor().max(0.0).min(total_turns as f64)) as usize)
}

impl ServerRuntimeState {
    /// TS `LocalThreadHost.ensureDesktopWorkspace(path, name, "project")` for a managed git
    /// worktree a thread was just created in (`thread/fork` and `create_thread` with
    /// `environment: "worktree"`): registers the directory in the web desktop state so it shows
    /// up in `workspace/list`, is accepted by `workspace/switch`, and falls inside the
    /// `/cowork/fs/*` roots, then announces `workspace/listChanged`. Returns the workspace id
    /// (existing or new); `None` without a desktop service or when the state cannot be saved,
    /// which never fails the thread that already owns the worktree.
    pub(crate) fn ensure_desktop_worktree_workspace(
        &self,
        worktree_path: &Path,
        name: &str,
    ) -> Option<String> {
        let svc = self.desktop_service.as_deref()?;
        let canon = canonicalize_sync(worktree_path);
        let canon_str = canon.to_string_lossy().into_owned();
        // Work on the raw normalized state so other workspaces keep fields the typed entry
        // view does not model.
        let mut state = svc.load_state_json(&self.working_directory);
        let mut workspaces: Vec<Value> = state
            .get("workspaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let field = |w: &Value, key: &str| w.get(key).and_then(Value::as_str).map(str::to_owned);
        if let Some(existing) = workspaces
            .iter()
            .find(|w| field(w, "path").is_some_and(|path| same_workspace_path(&path, &canon_str)))
        {
            return field(existing, "id");
        }

        let mut id = format!("project-{}", fnv1a32_hex(&canon_str));
        if workspaces
            .iter()
            .any(|w| field(w, "id").as_deref() == Some(id.as_str()))
        {
            let suffix: String = Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(6)
                .collect();
            id = format!("{id}-{suffix}");
        }
        let name = Some(name.trim())
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                canon
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|n| !n.is_empty())
            })
            .unwrap_or_else(|| canon_str.clone());
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        workspaces.push(json!({
            "id": id,
            "name": name,
            "path": canon_str,
            "workspaceKind": "project",
            "createdAt": now,
            "lastOpenedAt": now,
            "wsProtocol": "jsonrpc",
            "defaultEnableMcp": true,
            "defaultBackupsEnabled": false,
            "yolo": false,
        }));
        state["workspaces"] = Value::Array(workspaces);
        if let Err(err) = svc.save_state_json(state, &self.working_directory) {
            tracing::warn!(
                path = %canon_str,
                error = %err,
                "failed to register worktree workspace in desktop state"
            );
            return None;
        }
        self.broadcast_workspace_list_changed();
        Some(id)
    }

    /// Listable root threads across every workspace (TS `LocalThreadHost.listThreads`
    /// enumeration). Same root/task/listability rules as [`Self::list_workspace_threads`],
    /// without its cwd filter.
    fn list_all_root_threads(&self) -> Vec<JsonRpcThread> {
        let mut by_id: HashMap<String, JsonRpcThread> = HashMap::new();
        for summary in self.session_db.list_sessions(None).unwrap_or_default() {
            if self.task_coordinator.is_task_thread(&summary.session_id) {
                continue;
            }
            let Some(record) = self
                .session_db
                .get_session_record(&summary.session_id)
                .ok()
                .flatten()
            else {
                continue;
            };
            if record.session_kind != SessionKind::Root
                || record.parent_session_id.is_some()
                || record.role.is_some()
            {
                continue;
            }
            let include = matches!(
                record.execution_state,
                Some(
                    cowork_storage::AgentExecutionState::Running
                        | cowork_storage::AgentExecutionState::PendingInit
                )
            ) || record.message_count > 0
                || record.title_source != SessionTitleSource::Default
                || record.has_pending_ask
                || record.has_pending_approval;
            if include {
                by_id.insert(
                    record.session_id.clone(),
                    self.build_thread_from_record(&record),
                );
            }
        }
        for entry in self.sessions.iter() {
            let live = entry.value().lock();
            if live.session_kind != SessionKind::Root
                || live.parent_session_id.is_some()
                || live.role.is_some()
                || self.task_coordinator.is_task_thread(&live.id)
            {
                continue;
            }
            let include = live.busy
                || live.message_count > 0
                || live.title_source != SessionTitleSource::Default
                || live.has_pending_ask
                || live.has_pending_approval;
            if include {
                by_id.insert(live.id.clone(), self.build_thread_from_live(&live));
            }
        }
        by_id.into_values().collect()
    }
}

/// TS `parseThreadModelSelection`: splits a thread model reference into an optional provider
/// override and the model ID. `provider:modelId` with a known provider selects that provider
/// (the provider is returned only when the ref names it explicitly). Any other string,
/// including one whose prefix before `:` is not a provider (e.g. `nvidia/Nemotron:latest`),
/// is a model ID for `default_provider`. A known provider with an empty model ID is rejected.
pub(crate) fn parse_thread_model_selection(
    raw: &str,
    default_provider: ProviderName,
) -> Result<(Option<ProviderName>, String), String> {
    let trimmed = raw.trim();
    match parse_child_model_ref(trimmed, Some(default_provider)) {
        Some((provider, model, _, explicit_provider)) => {
            Ok((explicit_provider.then_some(provider), model))
        }
        None => Err(format!(
            "Unsupported thread model \"{trimmed}\". Expected provider:modelId."
        )),
    }
}

/// TS `LocalThreadHost.requireThreadId`: a trimmed, non-empty `threadId`, or
/// `"<operation> requires threadId"`.
fn require_thread_id<'a>(args: &'a Value, operation: &str) -> Result<&'a str, String> {
    args.get("threadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("{operation} requires threadId"))
}

/// TS `LocalThreadHost.listProjects` projection: `project` workspaces only (one-off chats are
/// filtered out), as `ProjectSummary` (`projectId`, `name`, `path`, `hostId`, `active`, plus
/// `defaultProvider` / `defaultModel` when set).
fn project_summaries(
    workspaces: Vec<JsonRpcWorkspaceSummary>,
    active_id: Option<&str>,
) -> Vec<Value> {
    workspaces
        .into_iter()
        .filter(|w| w.workspace_kind == "project")
        .map(|w| {
            let mut summary = Map::new();
            summary.insert("projectId".to_owned(), json!(w.id));
            summary.insert("name".to_owned(), json!(w.name));
            summary.insert("path".to_owned(), json!(w.path));
            summary.insert("hostId".to_owned(), json!(LOCAL_THREAD_HOST_ID));
            summary.insert("active".to_owned(), json!(active_id == Some(w.id.as_str())));
            if let Some(provider) = w.default_provider.filter(|p| !p.is_empty()) {
                summary.insert("defaultProvider".to_owned(), json!(provider));
            }
            if let Some(model) = w.default_model.filter(|m| !m.is_empty()) {
                summary.insert("defaultModel".to_owned(), json!(model));
            }
            Value::Object(summary)
        })
        .collect()
}

/// TS `LOCAL_HOST_ID` (`src/server/threads/localThreadHost.ts`): the `hostId` thread-tool
/// results carry for threads on this server.
const LOCAL_THREAD_HOST_ID: &str = "local";

pub struct ServerThreadControlBridge {
    pub runtime: Arc<ServerRuntimeState>,
    pub connection_id: String,
}

impl ServerThreadControlBridge {
    /// TS `SendMessageResult` for a busy target (`runtime.read.isBusy`): not queued, nothing
    /// applied, with the running turn's id (`null` when it is not known yet).
    fn busy_send_result(&self, thread_id: &str) -> Option<Value> {
        let live_arc = self.runtime.load_thread(thread_id)?;
        let busy = live_arc.lock().busy || self.runtime.active_turns.contains_key(thread_id);
        if !busy {
            return None;
        }
        let active_turn_id = self
            .runtime
            .active_turns
            .get(thread_id)
            .map(|ctrl| ctrl.turn_id.clone());
        Some(json!({
            "threadId": thread_id,
            "hostId": LOCAL_THREAD_HOST_ID,
            "queued": false,
            "busy": true,
            "activeTurnId": active_turn_id,
        }))
    }

    /// TS `LocalThreadHost.applyModelAndThinking` for `send_message_to_thread`: `model` is
    /// parsed against the thread's current provider (`parseThreadModelSelection`) and set on
    /// the thread, then `thinking` is applied against the resulting provider/model. Both are
    /// validated before either is applied, so a rejected `thinking` never leaves a half-applied
    /// model switch. A busy thread is left untouched (TS returns before applying anything); the
    /// caller reports it as `busy` instead of starting a turn.
    async fn apply_send_model_and_thinking(
        &self,
        thread_id: &str,
        model: Option<&str>,
        thinking: Option<&str>,
    ) -> Result<(), String> {
        let live_arc = self
            .runtime
            .load_thread(thread_id)
            .ok_or_else(|| format!("Unknown thread: {thread_id}"))?;
        let (current_provider, current_model, busy) = {
            let live = live_arc.lock();
            (
                live.provider,
                live.model.clone(),
                live.busy || self.runtime.active_turns.contains_key(thread_id),
            )
        };
        if busy {
            return Ok(());
        }
        let selection = model
            .map(|raw| parse_thread_model_selection(raw, current_provider))
            .transpose()?;
        if let Some(thinking) = thinking {
            let (provider, model_id) = match &selection {
                Some((provider, model_id)) => {
                    (provider.unwrap_or(current_provider), model_id.as_str())
                }
                None => (current_provider, current_model.as_str()),
            };
            self.runtime
                .validate_thread_reasoning(provider, model_id, thinking)?;
        }
        if let Some((provider, model_id)) = &selection {
            self.runtime
                .set_session_model(
                    thread_id,
                    provider.as_ref().map(ProviderName::as_str),
                    model_id,
                )
                .await?;
        }
        if let Some(thinking) = thinking {
            self.runtime
                .apply_thread_thinking(thread_id, thinking)
                .await?;
        }
        Ok(())
    }
}

#[async_trait]
impl ThreadControlBridge for ServerThreadControlBridge {
    /// TS `LocalThreadHost.listProjects`: only `project` workspaces (managed one-off chat
    /// directories stay hidden), projected to `ProjectSummary`.
    async fn list_projects(&self) -> Result<Value, String> {
        let (workspaces, active_id) = build_workspace_summaries(
            &self.runtime.working_directory,
            &self.runtime.homedir,
            self.runtime.desktop_service.as_deref(),
        );
        Ok(json!({ "projects": project_summaries(workspaces, active_id.as_deref()) }))
    }

    async fn list_threads(&self, args: Value) -> Result<Value, String> {
        let raw_cwd = args
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
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
        // TS `LocalThreadHost.listThreads` enumerates root threads across every workspace
        // (projects and managed one-off chats); `cwd` narrows to one workspace only when
        // passed explicitly. The full (unpaginated) set feeds the archive/query filters
        // before `total` and the limit.
        let threads = match raw_cwd {
            Some(raw) => {
                let cwd = self
                    .runtime
                    .resolve_workspace_path(Some(raw), "list_threads")?;
                self.runtime.list_workspace_threads(&cwd, None, None).0
            }
            None => self.runtime.list_all_root_threads(),
        };
        let (workspaces, _) = build_workspace_summaries(
            &self.runtime.working_directory,
            &self.runtime.homedir,
            self.runtime.desktop_service.as_deref(),
        );
        let mut filtered: Vec<ListedThread> = threads
            .into_iter()
            .map(|thread| ListedThread::new(thread, &workspaces))
            .filter(|listed| {
                if query.is_empty() {
                    include_archived || !listed.thread.archived
                } else {
                    list_thread_matches_query(listed, &query)
                }
            })
            .collect();
        filtered.sort_by(|left, right| compare_listed_threads(&left.thread, &right.thread, &query));
        let total = filtered.len();
        filtered.truncate(limit);
        let threads: Vec<Value> = filtered.into_iter().map(ListedThread::into_json).collect();
        Ok(json!({
            "threads": threads,
            "total": total,
        }))
    }

    /// TS `LocalThreadHost.readThread`: a compact, paginated transcript (newest `turnLimit`
    /// turns before `cursor`) without the UI hydration snapshot. Tool outputs are omitted
    /// unless `includeOutputs` is true.
    async fn read_thread(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "threadId is required".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        let opts = CompactReadOptions {
            include_outputs: args.get("includeOutputs").and_then(Value::as_bool) == Some(true),
            max_output_chars: clamp_positive_integer(
                args.get("maxOutputCharsPerItem"),
                READ_THREAD_DEFAULT_OUTPUT_CHARS,
                READ_THREAD_MAX_OUTPUT_CHARS,
            ),
        };
        // Same projection as `thread/read` (journal turns led by the unjournaled seed
        // conversation, TS `mergeSnapshotAndProjectedTurns`); only the compact page is returned.
        let mut read = self
            .runtime
            .read_or_hydrate_thread(thread_id, 0, true)
            .await?;
        let mut thread = read.get_mut("thread").map(Value::take).unwrap_or_default();
        let projected = thread
            .as_object_mut()
            .and_then(|obj| obj.remove("turns"))
            .unwrap_or_default();
        let compact: Vec<Value> = projected
            .as_array()
            .map(|turns| {
                turns
                    .iter()
                    .map(|turn| compact_projected_turn(turn, opts))
                    .collect()
            })
            .unwrap_or_default();
        let turn_limit = clamp_positive_integer(
            args.get("turnLimit"),
            READ_THREAD_DEFAULT_TURN_LIMIT,
            READ_THREAD_MAX_TURN_LIMIT,
        );
        let end =
            decode_read_thread_cursor(args.get("cursor").and_then(Value::as_str), compact.len())?;
        let start = end.saturating_sub(turn_limit);
        let mut result = Map::new();
        result.insert("thread".to_owned(), thread);
        result.insert(
            "turns".to_owned(),
            Value::Array(compact[start..end].to_vec()),
        );
        if start > 0 {
            result.insert(
                "nextCursor".to_owned(),
                Value::String(encode_read_thread_cursor(start)),
            );
        }
        Ok(Value::Object(result))
    }

    /// TS `LocalThreadHost.createThread`: creates the thread, starts `prompt` as its first
    /// turn through the normal `turn/start` path, and returns `queued: true`.
    async fn create_thread(&self, args: Value) -> Result<Value, String> {
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "create_thread requires a non-empty prompt".to_owned())?
            .to_owned();
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
        let thinking = args
            .get("thinking")
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

        // TS `resolveCreateTarget` only targets a known project or a managed one-off chat; the
        // resolver canonicalizes `cwd` and rejects anything else before a worktree or thread
        // is created, so a model cannot open a thread (and its file tools) on an arbitrary
        // directory. The worktree base is that authorized workspace.
        let base_cwd = self
            .runtime
            .resolve_workspace_path(raw_cwd, "create_thread")?;
        let is_worktree = env_kind == "worktree";
        // TS names the registered worktree workspace `${workspace.name} worktree` after the
        // project it was branched from.
        let worktree_workspace_name = is_worktree.then(|| {
            let (workspaces, _) = build_workspace_summaries(
                &self.runtime.working_directory,
                &self.runtime.homedir,
                self.runtime.desktop_service.as_deref(),
            );
            let base_name = workspaces
                .into_iter()
                .find(|w| same_workspace_path(&w.path, &base_cwd.to_string_lossy()))
                .map(|w| w.name)
                .filter(|n| !n.trim().is_empty())
                .or_else(|| {
                    base_cwd
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| base_cwd.to_string_lossy().into_owned());
            format!("{base_name} worktree")
        });
        let target_cwd = if is_worktree {
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
        // Re-check the canonical target right before the thread starts on it: the managed
        // worktree path, or the workspace whose links may have changed since validation.
        let target_cwd = canonicalize_sync(&target_cwd);
        if !target_cwd.is_dir() || !self.runtime.is_create_thread_workspace(&target_cwd) {
            return Err(
                "create_thread cwd must match a registered project workspace or a managed one-off chat"
                    .to_owned(),
            );
        }
        // TS `resolveCreateTarget`: `ensureDesktopWorkspace(worktree.path, ..., "project")`.
        if let Some(name) = worktree_workspace_name.as_deref() {
            self.runtime
                .ensure_desktop_worktree_workspace(&target_cwd, name);
        }

        // TS `createThread` parses the model against the target workspace's provider
        // (`parseThreadModelSelection`): an explicit `provider:modelId` ref overrides the
        // provider, anything else is a model ID on the workspace provider.
        let workspace_cfg = if model.is_some() || thinking.is_some() {
            Some(
                self.runtime
                    .load_workspace_config(&target_cwd)
                    .map_err(|e| format!("Failed to load workspace config: {e}"))?,
            )
        } else {
            None
        };
        let (provider_override, model_override) = match (model, workspace_cfg.as_ref()) {
            (Some(raw_model), Some(cfg)) => {
                let (provider, model_id) = parse_thread_model_selection(raw_model, cfg.provider)?;
                (provider, Some(model_id))
            }
            _ => (None, None),
        };
        // TS applies `thinking` to the new thread (`applyThinking`) before its first turn;
        // `buildThreadReasoningOptionsPatch` validation runs here, against the provider/model
        // the thread will be created with, so a rejected level never leaves a thread behind.
        if let (Some(thinking), Some(cfg)) = (thinking, workspace_cfg.as_ref()) {
            let provider = provider_override.unwrap_or(cfg.provider);
            let model_id = model_override.clone().unwrap_or_else(|| cfg.model.clone());
            self.runtime
                .validate_thread_reasoning(provider, &model_id, thinking)?;
        }
        let (mut thread, _) = self
            .runtime
            .start_or_get_thread(
                &target_cwd,
                None,
                provider_override.as_ref().map(ProviderName::as_str),
                model_override.as_deref(),
                &self.connection_id,
            )
            .await?;
        if let Some(thinking) = thinking {
            self.runtime
                .apply_thread_thinking(&thread.id, thinking)
                .await?;
        }
        if let Some(t) = title {
            let _ = self.runtime.set_session_title(&thread.id, t).await?;
        }
        self.runtime
            .handle_turn_start(
                &self.connection_id,
                false,
                &TurnStartParams {
                    thread_id: thread.id.clone(),
                    input: TurnInput::Text(prompt),
                    client_message_id: None,
                    references: None,
                    retry: None,
                },
            )
            .await
            .map_err(|e| e.message)?;
        if let Some(live) = self.runtime.get_live_thread(&thread.id) {
            thread = self.runtime.build_thread_from_live(&live.lock());
        }
        Ok(json!({ "thread": thread, "queued": true }))
    }

    /// TS `LocalThreadHost.sendMessage`: the trimmed `prompt` (`message` is a deprecated alias)
    /// starts a turn on an idle thread and returns `{ threadId, hostId, queued: true }` (plus the
    /// started `turn`). A busy thread is not steered and nothing is applied to it: the call
    /// succeeds with `{ threadId, hostId, queued: false, busy: true, activeTurnId }`.
    async fn send_message_to_thread(&self, args: Value) -> Result<Value, String> {
        let mut args = match args {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        cowork_tools::thread_tools::resolve_send_message_prompt_alias(&mut args)?;
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "send_message_to_thread requires a non-empty prompt".to_owned())?
            .to_owned();
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "threadId is required".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        if let Some(lock) = self.runtime.get_session_task_lock(thread_id) {
            return Err(lock.message);
        }
        if self.runtime.load_thread(thread_id).is_none() {
            return Err(format!("Unknown thread: {thread_id}"));
        }
        if let Some(busy) = self.busy_send_result(thread_id) {
            return Ok(busy);
        }
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let thinking = args
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if model.is_some() || thinking.is_some() {
            self.apply_send_model_and_thinking(thread_id, model, thinking)
                .await?;
        }
        let started = self
            .runtime
            .handle_turn_start(
                &self.connection_id,
                false,
                &TurnStartParams {
                    thread_id: thread_id.to_owned(),
                    input: TurnInput::Text(prompt),
                    client_message_id: None,
                    references: None,
                    retry: None,
                },
            )
            .await;
        match started {
            Ok(started) => {
                let mut result = Map::new();
                result.insert("threadId".to_owned(), json!(thread_id));
                result.insert("hostId".to_owned(), json!(LOCAL_THREAD_HOST_ID));
                result.insert("queued".to_owned(), json!(true));
                if let Value::Object(extra) = started {
                    for (key, value) in extra {
                        result.entry(key).or_insert(value);
                    }
                }
                Ok(Value::Object(result))
            }
            // Another turn claimed the thread after the busy check above (while model/thinking
            // were being applied): report it as busy, like the check itself.
            Err(err) => self.busy_send_result(thread_id).ok_or(err.message),
        }
    }

    /// TS `LocalThreadHost.forkThread`. The agent-facing tool fills an omitted `threadId` with
    /// the calling thread (TS `ThreadManagementService.createControl`) before reaching here.
    async fn fork_thread(&self, args: Value) -> Result<Value, String> {
        let thread_id = args
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "fork_thread requires threadId".to_owned())?;
        if self.runtime.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        // TS `fork_thread` has no turn cutoff (its schema is strict): a fork always copies the
        // whole source history, so a requested cutoff must not silently fork everything.
        if args.get("fromTurnIndex").is_some_and(|v| !v.is_null()) {
            return Err(cowork_tools::thread_tools::FORK_FROM_TURN_INDEX_UNSUPPORTED.to_owned());
        }
        let title = args.get("title").and_then(Value::as_str).map(str::to_owned);
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let model = args.get("model").and_then(Value::as_str).map(str::to_owned);
        // Validated (`buildThreadReasoningOptionsPatch`) and applied to the fork by
        // `handle_thread_fork`, against the fork's own provider/model.
        let thinking = args
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_owned);
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
                    thinking,
                },
            )
            .await
            .map_err(|e| e.message)
    }

    async fn set_thread_title(&self, args: Value) -> Result<Value, String> {
        let thread_id = require_thread_id(&args, "set_thread_title")?;
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
        let thread_id = require_thread_id(&args, "set_thread_pinned")?;
        let pinned = args
            .get("pinned")
            .and_then(Value::as_bool)
            .ok_or_else(|| "pinned is required".to_owned())?;
        let thread = self.runtime.set_thread_pinned(thread_id, pinned).await?;
        Ok(json!({ "thread": thread }))
    }

    async fn set_thread_archived(&self, args: Value) -> Result<Value, String> {
        let thread_id = require_thread_id(&args, "set_thread_archived")?;
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
