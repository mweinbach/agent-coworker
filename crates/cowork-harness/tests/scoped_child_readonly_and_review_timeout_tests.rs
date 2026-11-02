//! A scoped child (`targetPaths`) spawned under an explicitly read-only parent sandbox must stay
//! read-only at spawn and after restore (TS children inherit `parentConfig.sandbox`, and the
//! resolver's explicit read-only floor beats `targetPaths`). Children inherit the parent's whole
//! sandbox (network, backend requirement) and are never wider than it on any axis. `AgentControl::wait` must honor the
//! requested internal timeout (the independent task review asks for ten minutes) instead of
//! clamping it to the public `waitForAgent` cap.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_config::{LoadConfigOptions, ProviderName, SandboxConfig, SandboxMode, load_config};
use cowork_harness::agents::{
    AgentControl, AgentControlConfig, AgentSpawnRequest, ChildTurnError, ChildTurnExecutor,
    ChildTurnInput, ChildTurnResult, child_wait_timeout, restore_persisted_child_restrictions,
};
use cowork_inference::TurnUsage;
use cowork_sandbox::{ResolveSandboxPolicyInput, SandboxPolicy, resolve_sandbox_policy};
use cowork_storage::{SessionDb, SessionDbOptions};
use parking_lot::Mutex;
use tokio::sync::Notify;
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn setup_env(tag: &str) -> (PathBuf, cowork_config::AgentConfig, Arc<SessionDb>) {
    let base = test_temp_base().join(format!("cowork-scoped-ro-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join("src")).unwrap();
    fs::create_dir_all(&builtin).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());

    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home.clone()),
        built_in_dir: Some(builtin),
        env: Some(env),
    })
    .unwrap();
    let db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: home.join(".cowork"),
            sessions_dir: home.join(".cowork/sessions"),
            db_path: None,
            busy_timeout_ms: None,
        })
        .await
        .unwrap(),
    );
    (base, cfg, db)
}

/// Records each child turn input; turns containing `HOLD` block until `release` is notified.
struct RecordingExecutor {
    inputs: Mutex<Vec<ChildTurnInput>>,
    release: Notify,
}

#[async_trait]
impl ChildTurnExecutor for RecordingExecutor {
    async fn run_child_turn(
        &self,
        input: ChildTurnInput,
    ) -> Result<ChildTurnResult, ChildTurnError> {
        self.inputs.lock().push(input.clone());
        if input.prompt.contains("HOLD") {
            self.release.notified().await;
        }
        Ok(ChildTurnResult {
            messages: input.initial_messages,
            latest_assistant_text: Some("done".to_owned()),
            usage: TurnUsage::default(),
        })
    }
}

fn recording_executor() -> Arc<RecordingExecutor> {
    Arc::new(RecordingExecutor {
        inputs: Mutex::new(Vec::new()),
        release: Notify::new(),
    })
}

fn control(
    parent: &str,
    cfg: &cowork_config::AgentConfig,
    db: &Arc<SessionDb>,
    executor: &Arc<RecordingExecutor>,
) -> AgentControl {
    let connected: BTreeSet<ProviderName> = [cfg.provider].into_iter().collect();
    AgentControl::new(
        AgentControlConfig {
            parent_session_id: parent.to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(db),
            connected_providers: connected,
        },
        Arc::clone(executor) as Arc<dyn ChildTurnExecutor>,
        Arc::new(|_, _| {}),
    )
}

fn spawn_req(message: &str, target_paths: Option<Vec<String>>) -> AgentSpawnRequest {
    AgentSpawnRequest {
        message: message.to_owned(),
        role: Some("worker".to_owned()),
        profile_ref: None,
        model: None,
        reasoning_effort: None,
        nickname: None,
        task_type: None,
        target_paths,
        context_mode: Some("none".to_owned()),
        briefing: None,
        include_parent_todos: false,
        include_harness_context: false,
        fork_context: false,
        system_prompt_suffix: None,
    }
}

async fn wait_idle(control: &AgentControl, agent_id: &str) {
    control
        .wait(
            &[agent_id.to_owned()],
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();
    for _ in 0..200 {
        if !control.inspect(agent_id).unwrap().agent.busy {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("child {agent_id} never settled");
}

/// Resolves the policy the server child executor would apply for this turn input.
fn resolve_child_policy(cfg: &cowork_config::AgentConfig, input: &ChildTurnInput) -> SandboxPolicy {
    resolve_sandbox_policy(&ResolveSandboxPolicyInput {
        config: Some(input.sandbox.clone()),
        working_directory: cfg.working_directory.clone(),
        project_root: Some(cfg.working_directory.clone()),
        output_directory: None,
        uploads_directory: None,
        tool_runtime_writable_roots: Vec::new(),
        target_paths: input.target_paths.as_ref().map(|paths| {
            paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        }),
        read_only_role: input.read_only_role,
        yolo: false,
        platform: None,
    })
}

#[tokio::test]
async fn scoped_child_of_read_only_parent_stays_read_only_at_spawn_and_restore() {
    let (base, mut cfg, db) = setup_env("spawn").await;
    cfg.sandbox.mode = SandboxMode::ReadOnly;
    let executor = recording_executor();
    let ctrl = control("root-ro", &cfg, &db, &executor);

    let child = ctrl
        .spawn(
            spawn_req("edit src", Some(vec!["src".to_owned()])),
            &[],
            &[],
            None,
        )
        .await
        .unwrap();
    wait_idle(&ctrl, &child.agent_id).await;

    let spawn_input = executor.inputs.lock()[0].clone();
    assert!(spawn_input.target_paths.is_some(), "child must be scoped");
    assert_eq!(spawn_input.sandbox.mode, SandboxMode::ReadOnly);
    assert!(
        matches!(
            resolve_child_policy(&cfg, &spawn_input),
            SandboxPolicy::ReadOnly { .. }
        ),
        "a scoped child of a read-only parent must resolve to a read-only policy"
    );

    // The persisted child keeps the read-only sandbox it was spawned with.
    let row = db.get_session_record(&child.agent_id).unwrap().unwrap();
    assert_eq!(
        row.sandbox.as_ref().map(|s| s.mode),
        Some(SandboxMode::ReadOnly)
    );
    let restored = restore_persisted_child_restrictions(&cfg, &row).unwrap();
    assert_eq!(restored.sandbox.mode, SandboxMode::ReadOnly);

    // A restart under the same read-only parent rebuilds the child read-only.
    let executor2 = recording_executor();
    let ctrl2 = control("root-ro", &cfg, &db, &executor2);
    ctrl2
        .send_input(&child.agent_id, "follow up", false)
        .await
        .unwrap();
    wait_idle(&ctrl2, &child.agent_id).await;
    let restored_input = executor2.inputs.lock()[0].clone();
    assert!(restored_input.target_paths.is_some());
    assert_eq!(restored_input.sandbox.mode, SandboxMode::ReadOnly);

    // Even if the parent's config is later widened, the child's saved read-only is not.
    let mut widened = cfg.clone();
    widened.sandbox.mode = SandboxMode::WorkspaceWrite;
    let restored = restore_persisted_child_restrictions(&widened, &row).unwrap();
    assert_eq!(restored.sandbox.mode, SandboxMode::ReadOnly);
    let executor3 = recording_executor();
    let ctrl3 = control("root-ro", &widened, &db, &executor3);
    ctrl3
        .send_input(&child.agent_id, "follow up again", false)
        .await
        .unwrap();
    wait_idle(&ctrl3, &child.agent_id).await;
    assert_eq!(
        executor3.inputs.lock()[0].sandbox.mode,
        SandboxMode::ReadOnly
    );

    let _ = fs::remove_dir_all(base);
}

#[tokio::test]
async fn scoped_child_of_writable_parent_is_still_workspace_write() {
    for parent_mode in [
        SandboxMode::Auto,
        SandboxMode::WorkspaceWrite,
        SandboxMode::DangerFullAccess,
    ] {
        let (base, mut cfg, db) = setup_env("writable").await;
        cfg.sandbox.mode = parent_mode;
        let executor = recording_executor();
        let ctrl = control("root-rw", &cfg, &db, &executor);

        let scoped = ctrl
            .spawn(
                spawn_req("edit src", Some(vec!["src".to_owned()])),
                &[],
                &[],
                None,
            )
            .await
            .unwrap();
        wait_idle(&ctrl, &scoped.agent_id).await;
        let input = executor.inputs.lock()[0].clone();
        assert_eq!(input.sandbox.mode, SandboxMode::WorkspaceWrite);
        match resolve_child_policy(&cfg, &input) {
            SandboxPolicy::WorkspaceWrite { writable_roots, .. } => {
                assert_eq!(writable_roots.len(), 1);
                assert!(writable_roots[0].ends_with("src"));
            }
            other => panic!("scoped child under {parent_mode:?} resolved to {other:?}"),
        }
        let row = db.get_session_record(&scoped.agent_id).unwrap().unwrap();
        let restored = restore_persisted_child_restrictions(&cfg, &row).unwrap();
        assert_eq!(restored.sandbox.mode, SandboxMode::WorkspaceWrite);

        // Unscoped children keep inheriting the parent's mode.
        let unscoped = ctrl
            .spawn(spawn_req("look around", None), &[], &[], None)
            .await
            .unwrap();
        wait_idle(&ctrl, &unscoped.agent_id).await;
        assert_eq!(executor.inputs.lock()[1].sandbox.mode, parent_mode);

        let _ = fs::remove_dir_all(base);
    }
}

#[tokio::test]
async fn children_inherit_the_parents_complete_sandbox_and_are_never_wider() {
    let (base, mut cfg, db) = setup_env("full-sandbox").await;
    cfg.sandbox = SandboxConfig {
        mode: SandboxMode::WorkspaceWrite,
        network: false,
        require_backend: true,
    };
    let executor = recording_executor();
    let ctrl = control("root-full", &cfg, &db, &executor);

    // Default worker: the parent's whole sandbox, not just its mode.
    let worker = ctrl
        .spawn(spawn_req("look around", None), &[], &[], None)
        .await
        .unwrap();
    wait_idle(&ctrl, &worker.agent_id).await;
    let input = executor.inputs.lock()[0].clone();
    assert_eq!(input.sandbox, cfg.sandbox);
    assert!(matches!(
        resolve_child_policy(&cfg, &input),
        SandboxPolicy::WorkspaceWrite { network: false, .. }
    ));
    // The child's full effective sandbox is persisted so a resumed child keeps it.
    let row = db.get_session_record(&worker.agent_id).unwrap().unwrap();
    assert_eq!(row.sandbox.as_ref(), Some(&cfg.sandbox));

    // A read-only role narrows the mode but keeps the parent's other restrictions.
    let mut explorer_req = spawn_req("explore", None);
    explorer_req.role = Some("explorer".to_owned());
    let explorer = ctrl.spawn(explorer_req, &[], &[], None).await.unwrap();
    wait_idle(&ctrl, &explorer.agent_id).await;
    let input = executor.inputs.lock()[1].clone();
    assert_eq!(
        input.sandbox,
        SandboxConfig {
            mode: SandboxMode::ReadOnly,
            network: false,
            require_backend: true,
        }
    );

    // A child saved wider than its (now narrower) parent is clamped on every axis on restore.
    let mut saved_wide = row.clone();
    saved_wide.sandbox = Some(SandboxConfig {
        mode: SandboxMode::DangerFullAccess,
        network: true,
        require_backend: false,
    });
    let mut read_only_parent = cfg.clone();
    read_only_parent.sandbox.mode = SandboxMode::ReadOnly;
    let restored = restore_persisted_child_restrictions(&read_only_parent, &saved_wide).unwrap();
    assert_eq!(
        restored.sandbox,
        SandboxConfig {
            mode: SandboxMode::ReadOnly,
            network: false,
            require_backend: true,
        }
    );
    // ...and a parent widened after the spawn never widens the saved child.
    let mut widened = cfg.clone();
    widened.sandbox = SandboxConfig {
        mode: SandboxMode::DangerFullAccess,
        network: true,
        require_backend: false,
    };
    let restored = restore_persisted_child_restrictions(&widened, &row).unwrap();
    assert_eq!(restored.sandbox, cfg.sandbox);
    let executor2 = recording_executor();
    let ctrl2 = control("root-full", &widened, &db, &executor2);
    ctrl2
        .send_input(&worker.agent_id, "follow up", false)
        .await
        .unwrap();
    wait_idle(&ctrl2, &worker.agent_id).await;
    assert_eq!(executor2.inputs.lock()[0].sandbox, cfg.sandbox);

    let _ = fs::remove_dir_all(base);
}

#[test]
fn internal_wait_timeout_is_not_clamped_to_the_public_cap() {
    // `ReviewTaskTool` waits up to ten minutes for the independent reviewer.
    assert_eq!(
        child_wait_timeout(Some(600_000)),
        Duration::from_millis(600_000)
    );
    assert_eq!(
        child_wait_timeout(Some(300_000)),
        Duration::from_millis(300_000)
    );
    assert_eq!(child_wait_timeout(None), Duration::from_millis(30_000));
    assert_eq!(child_wait_timeout(Some(0)), Duration::ZERO);
}

#[tokio::test]
async fn wait_honors_requested_timeout_and_zero_times_out_immediately() {
    let (base, cfg, db) = setup_env("wait").await;
    let executor = recording_executor();
    let ctrl = control("root-wait", &cfg, &db, &executor);
    let child = ctrl
        .spawn(spawn_req("HOLD until released", None), &[], &[], None)
        .await
        .unwrap();
    let ids = [child.agent_id.clone()];

    // `0` reports a timeout without waiting (TS `StatusBus.wait`).
    let started = Instant::now();
    let zero = ctrl
        .wait(&ids, Some(0), Some("all"), false, false)
        .await
        .unwrap();
    assert!(zero.timed_out);
    assert!(started.elapsed() < Duration::from_secs(2));

    // A short timeout elapses as requested while the child is still running.
    let started = Instant::now();
    let short = ctrl
        .wait(&ids, Some(150), Some("all"), false, false)
        .await
        .unwrap();
    assert!(short.timed_out);
    assert!(started.elapsed() >= Duration::from_millis(150));

    // A ten-minute internal wait returns as soon as the child settles, not timed out.
    let waiter = ctrl.wait(&ids, Some(600_000), Some("all"), false, false);
    let release = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        executor.release.notify_one();
    };
    let (long, ()) = tokio::join!(waiter, release);
    assert!(!long.unwrap().timed_out);

    let _ = fs::remove_dir_all(base);
}
