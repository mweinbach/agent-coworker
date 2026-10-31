use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{LoadConfigOptions, ProviderName, load_config};
use cowork_storage::{
    TaskContextSnapshot, TaskCreationOrigin, TaskCreationResult, TaskDirective,
    TaskDirectiveContinuation, TaskDirectiveResult, TaskRecord, TaskRequirement,
    TaskRequirementKind, TaskReviewMaterialReference, TaskReviewRecord, TaskStatus, TaskThread,
    ValidatedTaskCreationInput, WorkItem, WorkItemStatus,
};
use cowork_tools::{
    AgentControlBridge, TaskToolBridge, ThreadControlBridge, ToolExecutionContext, ToolOutput,
    create_builtin_tools, omit_provider_null_optionals, parse_reviewer_verdict,
    parse_task_update_directive,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use uuid::Uuid;

struct DummyThreadControl;

#[async_trait]
impl ThreadControlBridge for DummyThreadControl {
    async fn list_projects(&self) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn list_threads(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn read_thread(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn create_thread(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn send_message_to_thread(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn fork_thread(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn set_thread_title(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn set_thread_pinned(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn set_thread_archived(&self, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
}

struct MockAgentControl {
    pub spawned_args: Mutex<Vec<Value>>,
    pub closed_ids: Mutex<Vec<String>>,
    pub assistant_reply: String,
}

#[async_trait]
impl AgentControlBridge for MockAgentControl {
    async fn spawn_agent(&self, _parent_session_id: &str, args: Value) -> Result<Value, String> {
        self.spawned_args.lock().push(args);
        Ok(json!({
            "agentId": "reviewer-agent-1",
            "provider": "openai",
            "effectiveModel": "gpt-5.4"
        }))
    }
    async fn list_agents(&self, _: &str, _: Value) -> Result<Value, String> {
        Ok(json!({ "agents": [] }))
    }
    async fn send_agent_input(&self, _: &str, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn wait_for_agent(&self, _: &str, _: Value) -> Result<Value, String> {
        Ok(json!({
            "timedOut": false,
            "erroredAgentIds": [],
            "agents": [{
                "agentId": "reviewer-agent-1",
                "executionState": "completed",
                "busy": false
            }],
            "inspections": [{
                "agentId": "reviewer-agent-1",
                "latestAssistantText": self.assistant_reply
            }]
        }))
    }
    async fn inspect_agent(&self, _: &str, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn resume_agent(&self, _: &str, _: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn close_agent(&self, _: &str, args: Value) -> Result<Value, String> {
        if let Some(id) = args.get("agentId").and_then(Value::as_str) {
            self.closed_ids.lock().push(id.to_owned());
        }
        Ok(json!({}))
    }
}

struct MockTaskBridge {
    pub recorded_directives: Mutex<Vec<TaskDirective>>,
}

fn sample_task_record(revision: i64) -> TaskRecord {
    let now = "2026-04-18T12:00:00.000Z".to_owned();
    TaskRecord {
        id: "task-mock-1".to_owned(),
        workspace_path: "/private/tmp/ws".to_owned(),
        title: "Sample Task".to_owned(),
        objective: "Ship report".to_owned(),
        context: "Context".to_owned(),
        source_session_id: Some("chat-1".to_owned()),
        creation_origin: TaskCreationOrigin::ChatTool,
        status: TaskStatus::Working,
        revision,
        review_required: true,
        review_rounds: 3,
        created_at: now.clone(),
        updated_at: now.clone(),
        thread_count: 1,
        completed_work_item_count: 1,
        total_work_item_count: 1,
        active_blocker_count: 0,
        pending_question_count: 0,
        blocking_question_count: 0,
        requirements: vec![TaskRequirement {
            id: "req-1".to_owned(),
            kind: TaskRequirementKind::AcceptanceCriterion,
            text: "Valid report".to_owned(),
            source: "user".to_owned(),
            permanence: "fixed".to_owned(),
            status: "active".to_owned(),
            created_at: now.clone(),
            supersedes: None,
        }],
        threads: vec![TaskThread {
            id: "tt-1".to_owned(),
            task_id: "task-mock-1".to_owned(),
            session_id: "task-sess-1".to_owned(),
            title: "Primary".to_owned(),
            created_by: "coordinator".to_owned(),
            created_at: now.clone(),
            updated_at: now.clone(),
        }],
        work_items: vec![WorkItem {
            id: "wi-1".to_owned(),
            task_id: "task-mock-1".to_owned(),
            title: "Write report".to_owned(),
            description: String::new(),
            status: WorkItemStatus::Done,
            depends_on: vec![],
            assigned_thread_id: Some("tt-1".to_owned()),
            claimed_by_thread_id: None,
            expected_outputs: vec!["report.md".to_owned()],
            completion_evidence: Some("Wrote report.md".to_owned()),
            position: 0,
            created_at: now.clone(),
            updated_at: now,
        }],
        decisions: vec![],
        questions: vec![],
        artifacts: vec![],
        blockers: vec![],
        activity: vec![],
        latest_checkpoint: None,
    }
}

#[async_trait]
impl TaskToolBridge for MockTaskBridge {
    fn get_task_context(&self, _session_id: &str) -> Option<TaskContextSnapshot> {
        let task = sample_task_record(4);
        Some(TaskContextSnapshot {
            id: task.id,
            title: task.title,
            objective: task.objective,
            context: task.context,
            source_session_id: task.source_session_id,
            status: task.status,
            revision: task.revision,
            requirements: task.requirements,
            work_items: task.work_items,
            decisions: task.decisions,
            questions: task.questions,
            blockers: task.blockers,
            artifacts: task.artifacts,
            active_thread_id: "tt-1".to_owned(),
            review_required: Some(true),
            review_rounds: Some(3),
            activity: Some(vec![]),
            reviews: Some(vec![]),
        })
    }

    async fn get_task_review_material(
        &self,
        _session_id: &str,
    ) -> Result<TaskReviewMaterialReference, String> {
        Ok(TaskReviewMaterialReference {
            fingerprint: "f".repeat(64),
        })
    }

    async fn apply_task_directive(
        &self,
        _session_id: &str,
        directive: TaskDirective,
    ) -> Result<TaskDirectiveResult, String> {
        self.recorded_directives.lock().push(directive.clone());
        match directive {
            TaskDirective::RequestInput { questions, .. } => {
                let blocking = questions.iter().any(|q| q.blocking);
                Ok(TaskDirectiveResult {
                    task: sample_task_record(5),
                    reviews: Some(vec![]),
                    continuation: if blocking {
                        TaskDirectiveContinuation::PauseForInput
                    } else {
                        TaskDirectiveContinuation::Continue
                    },
                })
            }
            TaskDirective::RecordReview {
                reviewer_agent_id,
                reviewer_provider,
                reviewer_model,
                verdict,
                feedback,
                ..
            } => Ok(TaskDirectiveResult {
                task: sample_task_record(5),
                reviews: Some(vec![TaskReviewRecord {
                    id: "rev-rec-1".to_owned(),
                    task_id: "task-mock-1".to_owned(),
                    round: 1,
                    verdict,
                    feedback,
                    reviewer_agent_id,
                    reviewer_provider,
                    reviewer_model,
                    task_revision: 4,
                    material_fingerprint: "f".repeat(64),
                    material_snapshot: Map::new(),
                    created_at: "2026-04-18T12:01:00.000Z".to_owned(),
                    addressed_at: None,
                    implementation_summary: None,
                }]),
                continuation: TaskDirectiveContinuation::Continue,
            }),
            _ => Ok(TaskDirectiveResult {
                task: sample_task_record(5),
                reviews: Some(vec![]),
                continuation: TaskDirectiveContinuation::Continue,
            }),
        }
    }

    async fn create_task(
        &self,
        _session_id: &str,
        _input: ValidatedTaskCreationInput,
    ) -> Result<TaskCreationResult, String> {
        Ok(TaskCreationResult {
            task: sample_task_record(0),
            workspace_disposition: "existing_project".to_owned(),
        })
    }
}

#[tokio::test]
async fn task_toolset_gating_create_task_pause_and_review_task_lifecycle() {
    let base = PathBuf::from(format!("/private/tmp/cowork-task-tools-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();

    let mut cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        ..Default::default()
    })
    .unwrap();
    cfg.tasks_enabled = true;

    let task_bridge = Arc::new(MockTaskBridge {
        recorded_directives: Mutex::new(Vec::new()),
    });
    let agent_ctrl = Arc::new(MockAgentControl {
        spawned_args: Mutex::new(Vec::new()),
        closed_ids: Mutex::new(Vec::new()),
        assistant_reply: "Checked report.md thoroughly.\n\nVERDICT: PASS".to_owned(),
    });

    // 1. Standard root chat with tasks_enabled=true
    let mut chat_ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    chat_ctx.agent_config = Some(Arc::new(cfg.clone()));
    chat_ctx.task_bridge = Some(task_bridge.clone());
    chat_ctx.thread_control = Some(Arc::new(DummyThreadControl));
    chat_ctx.agent_control = Some(agent_ctrl.clone());

    let chat_tools = create_builtin_tools(&chat_ctx);
    assert!(chat_tools.contains_key("createTask"));
    assert!(chat_tools.contains_key("AskUserQuestion"));
    assert!(chat_tools.contains_key("todoWrite"));
    assert!(chat_tools.contains_key("list_threads"));
    assert!(!chat_tools.contains_key("taskUpdate"));
    assert!(!chat_tools.contains_key("reviewTask"));

    // Execute createTask -> sets stop_after_step!
    let create_out = chat_tools["createTask"]
        .execute(
            json!({
                "idempotencyKey": "idem-chat-1",
                "title": "Sample Task",
                "objective": "Ship report",
                "context": "Context",
                "requirements": [{ "kind": "acceptance_criterion", "text": "Valid report", "permanence": null }],
                "workItems": [{ "key": "w1", "title": "Write report", "expectedOutputs": ["report.md"], "dependsOn": null }],
                "reviewRounds": null
            })
            .as_object()
            .unwrap()
            .clone(),
            &chat_ctx,
        )
        .await
        .unwrap();
    assert!(chat_ctx.should_stop_after_tool_step());
    if let ToolOutput::Text(s) = create_out {
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["modeChanged"], json!(true));
        assert_eq!(v["taskThreadId"], json!("task-sess-1"));
    } else {
        panic!("expected text output");
    }

    // 2. Task-mode root thread -> taskUpdate + reviewTask exposed; AskUserQuestion, todoWrite, createTask, threadManagement withheld!
    let mut task_ctx =
        ToolExecutionContext::new_for_tests(home, ws, ProviderName::Openai, "gpt-5.4");
    task_ctx.agent_config = Some(Arc::new(cfg));
    task_ctx.task_bridge = Some(task_bridge.clone());
    task_ctx.thread_control = Some(Arc::new(DummyThreadControl));
    task_ctx.agent_control = Some(agent_ctrl.clone());
    task_ctx.in_task_context = true;

    let task_tools = create_builtin_tools(&task_ctx);
    assert!(task_tools.contains_key("taskUpdate"));
    assert!(task_tools.contains_key("reviewTask"));
    assert!(!task_tools.contains_key("createTask"));
    assert!(!task_tools.contains_key("AskUserQuestion"));
    assert!(!task_tools.contains_key("todoWrite"));
    assert!(!task_tools.contains_key("list_threads"));

    // Verify omit_provider_null_optionals keeps provenance nulls & rejects record_review via taskUpdate
    let stripped = omit_provider_null_optionals(&json!({
        "type": "register_artifact",
        "changeSummary": null,
        "provenance": { "customNull": null, "source": "script" }
    }));
    assert!(stripped.get("changeSummary").is_none());
    assert_eq!(stripped["provenance"]["customNull"], Value::Null);
    assert!(
        parse_task_update_directive(
            json!({
                "idempotencyKey": "bad",
                "type": "record_review"
            })
            .as_object()
            .unwrap()
        )
        .is_err()
    );

    // Blocking request_input sets stop_after_step
    let _ = task_tools["taskUpdate"]
        .execute(
            json!({
                "idempotencyKey": "ask-1",
                "type": "request_input",
                "expectedRevision": 4,
                "questions": [{
                    "header": "Tone",
                    "question": "Pick tone?",
                    "blocking": true,
                    "urgency": "now",
                    "defaultAction": null
                }]
            })
            .as_object()
            .unwrap()
            .clone(),
            &task_ctx,
        )
        .await
        .unwrap();
    assert!(task_ctx.should_stop_after_tool_step());

    // Execute reviewTask -> spawns reviewer, parses VERDICT: PASS, records review with fingerprint, closes reviewer!
    let rev_out = task_tools["reviewTask"]
        .execute(
            json!({ "expectedRevision": 4, "focus": null })
                .as_object()
                .unwrap()
                .clone(),
            &task_ctx,
        )
        .await
        .unwrap();
    if let ToolOutput::Json(v) = rev_out {
        assert_eq!(v["verdict"], json!("pass"));
        assert_eq!(v["round"], json!(1));
        assert_eq!(v["requiresImplementation"], json!(false));
    } else {
        panic!("expected json output");
    }
    assert_eq!(
        agent_ctrl.closed_ids.lock().as_slice(),
        &["reviewer-agent-1".to_owned()]
    );
    assert_eq!(
        parse_reviewer_verdict("Initial note VERDICT: FAIL\nFinal check VERDICT: PARTIAL").unwrap(),
        cowork_storage::TaskReviewVerdict::Partial
    );

    let _ = fs::remove_dir_all(&base);
}
