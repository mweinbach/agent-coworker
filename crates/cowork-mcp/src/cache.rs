use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

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
    lifecycle: parking_lot::Mutex<GenerationLifecycle>,
}

/// Lease/retirement state of one cache generation.
///
/// `active_calls`, `retired` and `released` transition together under one lock so the
/// "retired and no active calls" condition is observed by exactly one caller. Splitting them
/// across independent atomics let a refresh racing with the last in-flight call on the
/// multithreaded runtime release the generation twice, dropping a connection that the
/// replacement generation reused below its true refcount and closing a live transport.
#[derive(Debug, Default)]
struct GenerationLifecycle {
    active_calls: usize,
    retired: bool,
    released: bool,
}

impl GenerationLifecycle {
    /// Returns true exactly once: the first time the generation is retired with no active calls.
    fn claim_release(&mut self) -> bool {
        if self.retired && self.active_calls == 0 && !self.released {
            self.released = true;
            return true;
        }
        false
    }
}

impl CacheGeneration {
    fn new(
        fingerprint: String,
        connections: BTreeMap<String, Arc<SharedServerConnection>>,
        tools: Vec<LoadedMcpTool>,
        errors: Vec<McpToolErrorEntry>,
        failed_servers_retry_after_ms: HashMap<String, u64>,
    ) -> Self {
        Self {
            fingerprint,
            connections,
            tools,
            errors,
            failed_servers_retry_after_ms,
            lifecycle: parking_lot::Mutex::new(GenerationLifecycle::default()),
        }
    }

    fn begin_call(&self) {
        self.lifecycle.lock().active_calls += 1;
    }

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
                cur.begin_call();
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
                next_gen.begin_call();
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

        Ok(Arc::new(CacheGeneration::new(
            desired_fp,
            new_connections,
            tools,
            errors,
            failed_retry_after,
        )))
    }

    async fn mark_retired(generation: &Arc<CacheGeneration>) {
        let should_release = {
            let mut lifecycle = generation.lifecycle.lock();
            lifecycle.retired = true;
            lifecycle.claim_release()
        };
        if should_release {
            generation.release_all_connections().await;
        }
    }

    async fn finish_call(generation: &Arc<CacheGeneration>) {
        let should_release = {
            let mut lifecycle = generation.lifecycle.lock();
            lifecycle.active_calls = lifecycle.active_calls.saturating_sub(1);
            lifecycle.claim_release()
        };
        if should_release {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct CountingInvoker {
        closes: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl McpToolInvoker for CountingInvoker {
        async fn call_tool(
            &self,
            _raw_tool_name: &str,
            _arguments: serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            Ok(serde_json::Value::Null)
        }

        async fn close(&self) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Builds a retiring generation that holds one in-flight call and a connection that the
    /// replacement generation also reused (refcount 2).
    fn retiring_generation_sharing_connection() -> (
        Arc<CacheGeneration>,
        Arc<SharedServerConnection>,
        Arc<CountingInvoker>,
    ) {
        let invoker = Arc::new(CountingInvoker::default());
        let shared = Arc::new(SharedServerConnection {
            config_fingerprint: "fp".to_owned(),
            server_name: "srv".to_owned(),
            invoker: Arc::clone(&invoker) as Arc<dyn McpToolInvoker>,
            raw_tools: Vec::new(),
            ref_count: AtomicUsize::new(2),
        });
        let mut connections = BTreeMap::new();
        connections.insert("srv".to_owned(), Arc::clone(&shared));
        let generation = Arc::new(CacheGeneration::new(
            "gen-fp".to_owned(),
            connections,
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        ));
        generation.begin_call();
        (generation, shared, invoker)
    }

    fn assert_released_once(shared: &SharedServerConnection, invoker: &CountingInvoker) {
        assert_eq!(
            shared.ref_count.load(Ordering::SeqCst),
            1,
            "retired generation must drop its connection ref exactly once"
        );
        assert_eq!(
            invoker.closes.load(Ordering::SeqCst),
            0,
            "connection still owned by the replacement generation must stay open"
        );
    }

    #[tokio::test]
    async fn retired_generation_releases_once_when_retired_before_last_call_finishes() {
        let (generation, shared, invoker) = retiring_generation_sharing_connection();
        WorkspaceMcpToolCache::mark_retired(&generation).await;
        assert_eq!(shared.ref_count.load(Ordering::SeqCst), 2);
        WorkspaceMcpToolCache::finish_call(&generation).await;
        assert_released_once(&shared, &invoker);
        // Redundant retire/finish signals must not release again.
        WorkspaceMcpToolCache::mark_retired(&generation).await;
        assert_released_once(&shared, &invoker);
    }

    #[tokio::test]
    async fn retired_generation_releases_once_when_last_call_finishes_before_retire() {
        let (generation, shared, invoker) = retiring_generation_sharing_connection();
        WorkspaceMcpToolCache::finish_call(&generation).await;
        assert_eq!(shared.ref_count.load(Ordering::SeqCst), 2);
        WorkspaceMcpToolCache::mark_retired(&generation).await;
        assert_released_once(&shared, &invoker);
        WorkspaceMcpToolCache::mark_retired(&generation).await;
        assert_released_once(&shared, &invoker);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn retire_racing_last_call_releases_exactly_once_under_stress() {
        for _ in 0..2_000 {
            let (generation, shared, invoker) = retiring_generation_sharing_connection();
            let barrier = Arc::new(tokio::sync::Barrier::new(2));
            let retire = {
                let generation = Arc::clone(&generation);
                let barrier = Arc::clone(&barrier);
                tokio::spawn(async move {
                    barrier.wait().await;
                    WorkspaceMcpToolCache::mark_retired(&generation).await;
                })
            };
            let finish = {
                let generation = Arc::clone(&generation);
                let barrier = Arc::clone(&barrier);
                tokio::spawn(async move {
                    barrier.wait().await;
                    WorkspaceMcpToolCache::finish_call(&generation).await;
                })
            };
            retire.await.expect("retire task");
            finish.await.expect("finish task");
            assert_released_once(&shared, &invoker);
        }
    }
}
