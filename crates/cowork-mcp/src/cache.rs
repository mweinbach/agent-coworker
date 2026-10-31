use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use cowork_config::{AgentConfig, canonicalize_sync};
use dashmap::DashMap;

use crate::credentials::now_epoch_ms;
use crate::registry::load_mcp_servers;
use crate::transports::{
    ServerConnectionBundle, assign_collision_safe_tool_names, connect_single_server_with_retries,
};
use crate::types::{HydratedMcpServer, LoadedMcpTool, McpToolErrorEntry, McpToolInvoker};

const FAILURE_RETRY_BACKOFF_MS: u64 = 30_000;

struct SharedServerConnection {
    config_fingerprint: String,
    server_name: String,
    invoker: Arc<dyn McpToolInvoker>,
    raw_tools: Vec<(String, String, serde_json::Value)>,
    ref_count: AtomicUsize,
}

impl SharedServerConnection {
    async fn release_ref(self: &Arc<Self>) {
        if self.ref_count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.invoker.close().await;
        }
    }
}

struct CacheGeneration {
    fingerprint: String,
    connections: BTreeMap<String, Arc<SharedServerConnection>>,
    tools: Vec<LoadedMcpTool>,
    errors: Vec<McpToolErrorEntry>,
    failed_servers_retry_after_ms: HashMap<String, u64>,
    active_calls: AtomicUsize,
    retired: AtomicBool,
}

impl CacheGeneration {
    async fn release_all_connections(&self) {
        for conn in self.connections.values() {
            conn.release_ref().await;
        }
    }
}

struct WorkspaceCacheState {
    current: Option<Arc<CacheGeneration>>,
    sessions: BTreeSet<String>,
}

/// Generation-refcounted workspace MCP connection & tool cache.
///
/// Guarantees:
/// 1. Refreshes are serialized per workspace while active `with_tools` calls run outside the mutex.
/// 2. Hot-swapping config reuses live server connections whose hydrated config fingerprint did not change.
/// 3. Retiring a generation waits until all in-flight `with_tools` calls on that generation finish
///    before closing unreferenced server connections.
#[derive(Default)]
pub struct WorkspaceMcpToolCache {
    workspaces: DashMap<PathBuf, Arc<tokio::sync::Mutex<WorkspaceCacheState>>>,
    session_to_workspace: DashMap<String, PathBuf>,
}

impl WorkspaceMcpToolCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn workspace_key(config: &AgentConfig) -> PathBuf {
        canonicalize_sync(&config.working_directory)
    }

    fn server_fingerprint(srv: &HydratedMcpServer) -> String {
        serde_json::to_string(&(&srv.config, srv.source, srv.auth_scope)).unwrap_or_default()
    }

    fn desired_generation_fingerprint(servers: &[HydratedMcpServer]) -> String {
        let parts: Vec<String> = servers.iter().map(Self::server_fingerprint).collect();
        parts.join("\n---\n")
    }

    /// Acquires the current (or freshly reconciled) workspace generation, increments `active_calls`
    /// while holding the workspace mutex, then drops the workspace mutex before invoking `f`!
    pub async fn with_tools<F, R>(
        &self,
        config: &AgentConfig,
        base_env: &HashMap<String, String>,
        session_id: &str,
        f: F,
    ) -> Result<R, String>
    where
        F: FnOnce(
            &[LoadedMcpTool],
            &[McpToolErrorEntry],
        ) -> Pin<Box<dyn Future<Output = R> + Send>>,
    {
        if !config.enable_mcp {
            return Ok(f(&[], &[]).await);
        }

        let ws_key = Self::workspace_key(config);
        self.session_to_workspace
            .insert(session_id.to_owned(), ws_key.clone());

        let ws_lock = self
            .workspaces
            .entry(ws_key)
            .or_insert_with(|| {
                Arc::new(tokio::sync::Mutex::new(WorkspaceCacheState {
                    current: None,
                    sessions: BTreeSet::new(),
                }))
            })
            .value()
            .clone();

        let (generation, to_retire) = {
            let mut state = ws_lock.lock().await;
            state.sessions.insert(session_id.to_owned());

            let desired_servers = load_mcp_servers(config, false, |_| {})?;
            let desired_fp = Self::desired_generation_fingerprint(&desired_servers);
            let now = now_epoch_ms();

            let can_reuse_current = state.current.as_ref().is_some_and(|cur| {
                cur.fingerprint == desired_fp
                    && cur
                        .failed_servers_retry_after_ms
                        .values()
                        .all(|&retry_at| now < retry_at)
            });

            if can_reuse_current {
                let cur = Arc::clone(state.current.as_ref().unwrap());
                cur.active_calls.fetch_add(1, Ordering::AcqRel);
                (cur, None)
            } else {
                let prev = state.current.clone();
                let next_gen = Self::build_next_generation(
                    &desired_servers,
                    desired_fp,
                    prev.as_deref(),
                    base_env,
                )
                .await?;
                next_gen.active_calls.fetch_add(1, Ordering::AcqRel);
                let prev_replaced = state.current.replace(Arc::clone(&next_gen));
                (next_gen, prev_replaced)
            }
        };

        if let Some(old_gen) = to_retire {
            Self::mark_retired(&old_gen).await;
        }

        // Run caller outside workspace lock!
        let fut = f(&generation.tools, &generation.errors);
        let out = fut.await;

        Self::finish_call(&generation).await;
        Ok(out)
    }

    async fn build_next_generation(
        desired_servers: &[HydratedMcpServer],
        desired_fp: String,
        prev: Option<&CacheGeneration>,
        base_env: &HashMap<String, String>,
    ) -> Result<Arc<CacheGeneration>, String> {
        let mut new_connections: BTreeMap<String, Arc<SharedServerConnection>> = BTreeMap::new();
        let mut freshly_opened: Vec<Arc<SharedServerConnection>> = Vec::new();
        let mut errors = Vec::new();
        let mut failed_retry_after = HashMap::new();

        for srv in desired_servers {
            let srv_fp = Self::server_fingerprint(srv);
            if let Some(existing) = prev
                .and_then(|p| p.connections.get(&srv.config.name))
                .filter(|c| c.config_fingerprint == srv_fp)
            {
                existing.ref_count.fetch_add(1, Ordering::AcqRel);
                new_connections.insert(srv.config.name.clone(), Arc::clone(existing));
                continue;
            }

            match connect_single_server_with_retries(srv, base_env).await {
                Ok(bundle) => {
                    let shared = Arc::new(SharedServerConnection {
                        config_fingerprint: srv_fp,
                        server_name: bundle.server_name,
                        invoker: bundle.invoker,
                        raw_tools: bundle.raw_tools,
                        ref_count: AtomicUsize::new(1),
                    });
                    freshly_opened.push(Arc::clone(&shared));
                    new_connections.insert(srv.config.name.clone(), shared);
                }
                Err(err) => {
                    if srv.config.required == Some(true) {
                        // Roll back refs acquired for this failed generation
                        for conn in new_connections.values() {
                            conn.release_ref().await;
                        }
                        return Err(format!(
                            "Required MCP server \"{}\" failed to initialize: {err}",
                            srv.config.name
                        ));
                    }
                    failed_retry_after.insert(
                        srv.config.name.clone(),
                        now_epoch_ms().saturating_add(FAILURE_RETRY_BACKOFF_MS),
                    );
                    errors.push(McpToolErrorEntry {
                        server: srv.config.name.clone(),
                        error: err,
                    });
                }
            }
        }

        let bundles: Vec<ServerConnectionBundle> = new_connections
            .values()
            .map(|c| ServerConnectionBundle {
                server_name: c.server_name.clone(),
                invoker: Arc::clone(&c.invoker),
                raw_tools: c.raw_tools.clone(),
            })
            .collect();
        let tools = assign_collision_safe_tool_names(&bundles);

        Ok(Arc::new(CacheGeneration {
            fingerprint: desired_fp,
            connections: new_connections,
            tools,
            errors,
            failed_servers_retry_after_ms: failed_retry_after,
            active_calls: AtomicUsize::new(0),
            retired: AtomicBool::new(false),
        }))
    }

    async fn mark_retired(generation: &Arc<CacheGeneration>) {
        if generation.retired.swap(true, Ordering::AcqRel) {
            return;
        }
        if generation.active_calls.load(Ordering::Acquire) == 0 {
            generation.release_all_connections().await;
        }
    }

    async fn finish_call(generation: &Arc<CacheGeneration>) {
        if generation.active_calls.fetch_sub(1, Ordering::AcqRel) == 1
            && generation.retired.load(Ordering::Acquire)
        {
            generation.release_all_connections().await;
        }
    }

    /// Force-invalidates cached MCP connections for a workspace (e.g. after credential or plugin mutation).
    pub async fn invalidate_workspace(&self, working_dir: &Path) {
        let key = canonicalize_sync(working_dir);
        let Some(ws_lock) = self.workspaces.get(&key).map(|e| Arc::clone(e.value())) else {
            return;
        };
        let prev = {
            let mut state = ws_lock.lock().await;
            state.current.take()
        };
        if let Some(old_gen) = prev {
            Self::mark_retired(&old_gen).await;
        }
    }

    /// Force-invalidates cached MCP connections across every workspace (e.g. after user-scope config/credential mutation).
    pub async fn invalidate_all(&self) {
        let locks: Vec<Arc<tokio::sync::Mutex<WorkspaceCacheState>>> = self
            .workspaces
            .iter()
            .map(|e| Arc::clone(e.value()))
            .collect();
        for lock in locks {
            let prev = {
                let mut state = lock.lock().await;
                state.current.take()
            };
            if let Some(old_gen) = prev {
                Self::mark_retired(&old_gen).await;
            }
        }
    }

    /// Releases a session's interest in its workspace cache; when the last session closes,
    /// retires the workspace's active MCP generation.
    pub async fn close_session(&self, session_id: &str) {
        let Some((_, ws_key)) = self.session_to_workspace.remove(session_id) else {
            return;
        };
        let Some(ws_lock) = self.workspaces.get(&ws_key).map(|e| Arc::clone(e.value())) else {
            return;
        };
        let prev = {
            let mut state = ws_lock.lock().await;
            state.sessions.remove(session_id);
            if state.sessions.is_empty() {
                state.current.take()
            } else {
                None
            }
        };
        if let Some(old_gen) = prev {
            Self::mark_retired(&old_gen).await;
        }
    }

    /// Retires and closes all cached MCP generations across every workspace on server shutdown.
    pub async fn close_all(&self) {
        self.session_to_workspace.clear();
        let locks: Vec<Arc<tokio::sync::Mutex<WorkspaceCacheState>>> = self
            .workspaces
            .iter()
            .map(|e| Arc::clone(e.value()))
            .collect();
        self.workspaces.clear();
        for lock in locks {
            let prev = {
                let mut state = lock.lock().await;
                state.sessions.clear();
                state.current.take()
            };
            if let Some(old_gen) = prev {
                Self::mark_retired(&old_gen).await;
            }
        }
    }
}
