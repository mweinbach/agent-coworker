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

/// Connection refs owned by a generation that is still being built.
///
/// The build awaits server connects, so the caller's future can be cancelled while it holds
/// refs it took on the previous generation's connections. Dropping this without
/// [`Self::into_inner`] gives those refs back (closing any connection that drops to zero), so
/// a later retirement of the previous generation can still close the shared transports.
struct ConnectionRefs(BTreeMap<String, Arc<SharedServerConnection>>);

impl ConnectionRefs {
    fn into_inner(mut self) -> BTreeMap<String, Arc<SharedServerConnection>> {
        std::mem::take(&mut self.0)
    }

    /// Gives every ref back, awaiting the close of connections that drop to zero.
    async fn release(self) {
        for conn in self.into_inner().into_values() {
            conn.release_ref().await;
        }
    }
}

impl Drop for ConnectionRefs {
    fn drop(&mut self) {
        for conn in std::mem::take(&mut self.0).into_values() {
            if conn.ref_count.fetch_sub(1, Ordering::AcqRel) == 1
                && let Ok(handle) = tokio::runtime::Handle::try_current()
            {
                handle.spawn(async move { conn.invoker.close().await });
            }
        }
    }
}

struct WorkspaceCacheState {
    current: Option<Arc<CacheGeneration>>,
    sessions: BTreeSet<String>,
    /// Bumped by every invalidation (explicit invalidate, last session closing, shutdown). A
    /// load that started under an older epoch must not install its result as `current`.
    epoch: u64,
    /// Single-flight gate for generation builds in this epoch. Only the load path awaits it;
    /// invalidation swaps in a fresh gate instead of waiting, so the next load does not queue
    /// behind a connect whose result is already stale.
    loader: Arc<tokio::sync::Mutex<()>>,
}

impl WorkspaceCacheState {
    fn new() -> Self {
        Self {
            current: None,
            sessions: BTreeSet::new(),
            epoch: 0,
            loader: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Leases the current generation when it matches `desired_fp` and no failed server is due
    /// for a retry. The lease is taken under the state lock, so the generation cannot be
    /// retired and released before the caller's call is counted.
    fn lease_reusable(&self, desired_fp: &str) -> Option<Arc<CacheGeneration>> {
        let now = now_epoch_ms();
        let cur = self.current.as_ref()?;
        let reusable = cur.fingerprint == desired_fp
            && cur
                .failed_servers_retry_after_ms
                .values()
                .all(|&retry_at| now < retry_at);
        if !reusable {
            return None;
        }
        cur.begin_call();
        Some(Arc::clone(cur))
    }

    /// Starts a new epoch: in-flight loads become stale and the current generation is handed
    /// back for retirement.
    fn invalidate(&mut self) -> Option<Arc<CacheGeneration>> {
        self.epoch = self.epoch.wrapping_add(1);
        self.loader = Arc::new(tokio::sync::Mutex::new(()));
        self.current.take()
    }
}

type SharedWorkspaceState = Arc<parking_lot::Mutex<WorkspaceCacheState>>;

/// Generation-refcounted workspace MCP connection & tool cache.
///
/// Guarantees:
/// 1. Generation builds (MCP server connects) are single-flight per workspace: concurrent callers
///    for the same workspace share one build, while other workspaces proceed in parallel. No lock
///    that invalidation, `close_session` or other workspaces need is held across a connect; the
///    workspace state lock is synchronous and only guards bookkeeping. Active `with_tools` calls
///    run outside every lock.
/// 2. Invalidation never waits on an in-flight build. It bumps the workspace epoch, so a build
///    that finishes afterwards serves only the callers that were waiting for it and is retired
///    instead of being cached; the next call reconnects.
/// 3. Hot-swapping config reuses live server connections whose hydrated config fingerprint did not change.
/// 4. Retiring a generation waits until all in-flight `with_tools` calls on that generation finish
///    before closing unreferenced server connections.
#[derive(Default)]
pub struct WorkspaceMcpToolCache {
    workspaces: DashMap<PathBuf, SharedWorkspaceState>,
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
        // Transport headers and stdio environment variables are HashMaps. Their iteration
        // order can change on each load even when the effective configuration is identical.
        let mut value = serde_json::json!([srv.config, srv.source, srv.auth_scope]);
        value.sort_all_objects();
        value.to_string()
    }

    fn desired_generation_fingerprint(servers: &[HydratedMcpServer]) -> String {
        let parts: Vec<String> = servers.iter().map(Self::server_fingerprint).collect();
        parts.join("\n---\n")
    }

    fn workspace_states(&self) -> Vec<SharedWorkspaceState> {
        self.workspaces
            .iter()
            .map(|e| Arc::clone(e.value()))
            .collect()
    }

    /// Leases the current (or freshly built) workspace generation, then invokes `f` outside every
    /// cache lock. A slow or hanging server connect only delays callers that need the same
    /// workspace's generation.
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

        let ws_state = self
            .workspaces
            .entry(ws_key)
            .or_insert_with(|| Arc::new(parking_lot::Mutex::new(WorkspaceCacheState::new())))
            .value()
            .clone();

        let (generation, to_retire) =
            Self::acquire_generation(&ws_state, config, base_env, session_id).await?;

        if let Some(old_gen) = to_retire {
            Self::mark_retired(&old_gen).await;
        }

        // Run caller outside every cache lock!
        let fut = f(&generation.tools, &generation.errors);
        let out = fut.await;

        Self::finish_call(&generation).await;
        Ok(out)
    }

    /// Returns a leased generation plus a generation the caller must retire: the replaced
    /// previous generation, or the leased one itself when it was built in an epoch that was
    /// invalidated mid-connect (served to this caller once, never cached).
    async fn acquire_generation(
        ws_state: &SharedWorkspaceState,
        config: &AgentConfig,
        base_env: &HashMap<String, String>,
        session_id: &str,
    ) -> Result<(Arc<CacheGeneration>, Option<Arc<CacheGeneration>>), String> {
        loop {
            let desired_servers = load_mcp_servers(config, false, |_| {})?;
            let desired_fp = Self::desired_generation_fingerprint(&desired_servers);

            let (epoch, loader) = {
                let mut state = ws_state.lock();
                state.sessions.insert(session_id.to_owned());
                if let Some(cur) = state.lease_reusable(&desired_fp) {
                    return Ok((cur, None));
                }
                (state.epoch, Arc::clone(&state.loader))
            };

            // Single-flight per workspace epoch: a concurrent caller that is already building
            // this workspace's generation finishes first, and its result is reused below.
            let _building = loader.lock().await;

            let refs = {
                let mut state = ws_state.lock();
                if state.epoch != epoch {
                    // Invalidated while waiting: the config may have changed, so start over
                    // under the new epoch (and its fresh gate).
                    continue;
                }
                state.sessions.insert(session_id.to_owned());
                if let Some(cur) = state.lease_reusable(&desired_fp) {
                    return Ok((cur, None));
                }
                // Take refs on reusable connections while the previous generation is still
                // current: it cannot be retired (and its connections closed) under this lock.
                Self::reuse_unchanged_connections(&desired_servers, state.current.as_deref())
            };

            let next_gen =
                Self::build_next_generation(&desired_servers, desired_fp, refs, base_env).await?;
            next_gen.begin_call();

            let mut state = ws_state.lock();
            if state.epoch == epoch {
                let prev = state.current.replace(Arc::clone(&next_gen));
                return Ok((next_gen, prev));
            }
            // Invalidated mid-connect: serve this call from the stale build, but never cache it.
            return Ok((Arc::clone(&next_gen), Some(next_gen)));
        }
    }

    /// Takes a ref on each connection of `prev` whose server config is unchanged.
    fn reuse_unchanged_connections(
        desired_servers: &[HydratedMcpServer],
        prev: Option<&CacheGeneration>,
    ) -> ConnectionRefs {
        let mut reused = BTreeMap::new();
        let Some(prev) = prev else {
            return ConnectionRefs(reused);
        };
        for srv in desired_servers {
            let srv_fp = Self::server_fingerprint(srv);
            if let Some(existing) = prev
                .connections
                .get(&srv.config.name)
                .filter(|c| c.config_fingerprint == srv_fp)
            {
                existing.ref_count.fetch_add(1, Ordering::AcqRel);
                reused.insert(srv.config.name.clone(), Arc::clone(existing));
            }
        }
        ConnectionRefs(reused)
    }

    async fn build_next_generation(
        desired_servers: &[HydratedMcpServer],
        desired_fp: String,
        mut refs: ConnectionRefs,
        base_env: &HashMap<String, String>,
    ) -> Result<Arc<CacheGeneration>, String> {
        let mut errors = Vec::new();
        let mut failed_retry_after = HashMap::new();
        let mut required_failure = None;

        // Connect changed servers independently, as TS `refresh` does with `Promise.allSettled`:
        // one slow server bounds the build by its own deadline instead of the sum of all.
        let to_connect: Vec<&HydratedMcpServer> = desired_servers
            .iter()
            .filter(|srv| !refs.0.contains_key(&srv.config.name))
            .collect();
        let results = futures::future::join_all(
            to_connect
                .iter()
                .map(|srv| connect_single_server_with_retries(srv, base_env)),
        )
        .await;

        for (srv, result) in to_connect.into_iter().zip(results) {
            match result {
                Ok(bundle) => {
                    let shared = Arc::new(SharedServerConnection {
                        config_fingerprint: Self::server_fingerprint(srv),
                        server_name: bundle.server_name,
                        invoker: bundle.invoker,
                        raw_tools: bundle.raw_tools,
                        ref_count: AtomicUsize::new(1),
                    });
                    refs.0.insert(srv.config.name.clone(), shared);
                }
                Err(err) => {
                    if srv.config.required == Some(true) {
                        required_failure.get_or_insert_with(|| {
                            format!(
                                "Required MCP server \"{}\" failed to initialize: {err}",
                                srv.config.name
                            )
                        });
                        continue;
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

        if let Some(err) = required_failure {
            // Roll back refs acquired for this failed generation (closing fresh connections).
            refs.release().await;
            return Err(err);
        }

        let new_connections = refs.into_inner();
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
    ///
    /// Does not wait for an in-flight build: that build's result is served to its waiting callers
    /// once and then retired, and the next call reconnects.
    pub async fn invalidate_workspace(&self, working_dir: &Path) {
        let key = canonicalize_sync(working_dir);
        let Some(ws_state) = self.workspaces.get(&key).map(|e| Arc::clone(e.value())) else {
            return;
        };
        let prev = ws_state.lock().invalidate();
        if let Some(old_gen) = prev {
            Self::mark_retired(&old_gen).await;
        }
    }

    /// Force-invalidates cached MCP connections across every workspace (e.g. after user-scope config/credential mutation).
    pub async fn invalidate_all(&self) {
        let retired: Vec<Arc<CacheGeneration>> = self
            .workspace_states()
            .iter()
            .filter_map(|ws_state| ws_state.lock().invalidate())
            .collect();
        for old_gen in retired {
            Self::mark_retired(&old_gen).await;
        }
    }

    /// Releases a session's interest in its workspace cache; when the last session closes,
    /// retires the workspace's active MCP generation. A build still in flight for that workspace
    /// is not waited for: its eventual result is retired after serving its waiting callers.
    pub async fn close_session(&self, session_id: &str) {
        let Some((_, ws_key)) = self.session_to_workspace.remove(session_id) else {
            return;
        };
        let Some(ws_state) = self.workspaces.get(&ws_key).map(|e| Arc::clone(e.value())) else {
            return;
        };
        let prev = {
            let mut state = ws_state.lock();
            state.sessions.remove(session_id);
            if state.sessions.is_empty() {
                state.invalidate()
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
        let states = self.workspace_states();
        self.workspaces.clear();
        let retired: Vec<Arc<CacheGeneration>> = states
            .iter()
            .filter_map(|ws_state| {
                let mut state = ws_state.lock();
                state.sessions.clear();
                state.invalidate()
            })
            .collect();
        for old_gen in retired {
            Self::mark_retired(&old_gen).await;
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
