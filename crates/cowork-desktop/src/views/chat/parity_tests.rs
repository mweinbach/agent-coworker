use std::path::PathBuf;

use cowork_protocol::{CommandInfo, JsonRpcLiteId, TurnAttachmentInputPart};
use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer, write_png};
use rune::{Cx, El, Env, Runtime, TextEdit, el, row};
use serde_json::json;

use crate::actions::{Action, NavAction, StoreEvent};
use crate::state::{
    AgentViewerState, AppState, ChatInteraction, ChatViewReadOnlyNotice, CitationSource,
    ComposerDraft, FeedItem, FeedMessageRole, FilePreviewState, ONE_OFF_LANDING_SENTINEL,
    PluginSummary, ProviderModelSummary, ProviderSummary, ServerLifecycleState, SkillSummary,
    ThreadAgentSummary, ThreadRecord, ThreadRuntime, ThreadStatus, TodoItemView, ToolRunStatus,
    TranscriptDeliveryFailure, WorkspaceRecord, WorkspaceRuntime,
};
use crate::theme::{self, AccentPalette, ThemePreference};
use crate::views::chat;
use crate::views::chat::state::{CanvasFixtureState, CanvasLifecycleKind, CanvasTab};
use crate::ws::{WsCommand, WsConnectionState};

const SNAP_VIEWPORT: (f32, f32) = (1280.0, 820.0);

fn test_chat_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
    let dark = state.effective_dark(cx.system_dark());
    let (kit, tokens) = theme::build_kit_with_accent(
        dark,
        state.desktop_settings.reduced_transparency,
        state.desktop_settings.high_contrast,
        state.desktop_settings.accent_palette,
    );
    cx.foreground(tokens.text_base);
    cx.focus_ring(2.0, 2.5, tokens.focus_ring);
    cx.web_focus();
    let out = chat::view(state, cx, &kit);
    el().w_full()
        .h_full()
        .fill(tokens.panel_bg)
        .child(rune_kit::root(
            row().w_full().h_full().child(out.content),
            out.overlays,
        ))
}

fn render_offscreen_rgba(rt: &mut Runtime<AppState>, dark: bool) -> Vec<u8> {
    let gpu = Gpu::headless();
    let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
    let scale = rt.env.scale;
    let dw = (SNAP_VIEWPORT.0 * scale) as u32;
    let dh = (SNAP_VIEWPORT.1 * scale) as u32;
    let target = Offscreen::new(&gpu.device, dw, dh);

    renderer.upload_images(&gpu.device, &gpu.queue, &mut rt.images);
    renderer.prepare(
        &gpu.device,
        &gpu.queue,
        &mut rt.text.atlas,
        &rt.instances,
        (dw, dh),
    );
    let tokens = theme::resolve_tokens_with_accent(
        dark,
        rt.state.desktop_settings.reduced_transparency,
        rt.state.desktop_settings.high_contrast,
        rt.state.desktop_settings.accent_palette,
    );
    let clear = [
        tokens.panel_bg.r,
        tokens.panel_bg.g,
        tokens.panel_bg.b,
        tokens.panel_bg.a,
    ];
    let mut enc = gpu.device.create_command_encoder(&Default::default());
    renderer.draw(&mut enc, &target.view, clear);
    target.copy(&mut enc);
    renderer.submit(&gpu.queue, enc);
    target.read(&gpu.device)
}

fn maybe_save_snap(name: &str, rgba: &[u8], scale: f32) {
    let Ok(dir) = std::env::var("COWORK_CHAT_SNAP_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create snap dir");
    let dw = (SNAP_VIEWPORT.0 * scale) as u32;
    let dh = (SNAP_VIEWPORT.1 * scale) as u32;
    write_png(&dir.join(format!("{name}.png")), dw, dh, rgba).expect("write parity png");
}

fn build_populated_thread_state(dark: bool) -> AppState {
    let mut s = AppState {
        scene_mode: true,
        system_dark_override: Some(dark),
        ..Default::default()
    };
    s.desktop_settings.theme = if dark {
        ThemePreference::Dark
    } else {
        ThemePreference::Light
    };

    let ws_id = "ws-demo".to_string();
    let mut ws = WorkspaceRecord::new(
        &ws_id,
        "agent-coworker",
        "/tmp/agent-coworker",
        1_763_000_000_000,
    );
    ws.default_provider = Some("openai".into());
    ws.default_model = Some("gpt-5".into());
    s.workspaces.push(ws);
    s.active_workspace_id = Some(ws_id.clone());
    s.workspace_socket_by_id
        .insert(ws_id.clone(), WsConnectionState::Connected);
    s.workspace_runtime_by_id.insert(
        ws_id.clone(),
        WorkspaceRuntime {
            server_state: ServerLifecycleState::Running {
                ws_url: "ws://127.0.0.1:7337/ws".into(),
                port: 7337,
            },
            ..Default::default()
        },
    );

    s.provider_catalog.push(ProviderSummary {
        id: "openai".into(),
        name: "OpenAI".into(),
        configured: true,
        models: vec![ProviderModelSummary {
            id: "gpt-5".into(),
            name: "GPT-5".into(),
            enabled: true,
            custom: false,
            supports_reasoning: true,
            reasoning_efforts: vec!["low".into(), "medium".into(), "high".into()],
        }],
        ..Default::default()
    });
    s.skills.push(SkillSummary {
        name: "code-review".into(),
        description: "Review diffs for correctness and regressions".into(),
        scope: "workspace".into(),
        enabled: true,
        ..Default::default()
    });
    s.plugins.push(PluginSummary {
        id: "linear".into(),
        name: "linear".into(),
        description: "Inspect and update Linear issues".into(),
        enabled: true,
        ..Default::default()
    });
    s.commands_by_workspace.insert(
        ws_id.clone(),
        vec![CommandInfo {
            name: "review".into(),
            description: Some("Run repository review checks".into()),
            source: "workspace".into(),
            hints: vec![],
        }],
    );

    let tid = "th-demo".to_string();
    s.threads.push(ThreadRecord {
        id: tid.clone(),
        workspace_id: ws_id.clone(),
        title: "Refactor chat diff viewer".into(),
        status: ThreadStatus::Active,
        session_id: Some("sess-demo".into()),
        provider: Some("openai".into()),
        model: Some("gpt-5".into()),
        reasoning_effort: Some("medium".into()),
        updated_at: 1_763_100_050_000,
        created_at: 1_763_000_000_000,
        ..Default::default()
    });
    s.active_workspace_id = Some(ws_id);
    s.dispatch(Action::Navigate(NavAction::OpenThread(tid.clone())));

    let diff_patch = "--- a/crates/cowork-desktop/src/views/chat/composer.rs\n+++ b/crates/cowork-desktop/src/views/chat/composer.rs\n@@ -10,4 +10,5 @@\n fn composer_ready() -> bool {\n-    false\n+    true\n }\n";
    let mut rt = ThreadRuntime {
        hydrated: true,
        streaming: false,
        agents: vec![ThreadAgentSummary {
            agent_id: "agent-sub-1".into(),
            name: "verifier".into(),
            nickname: Some("Verifier".into()),
            title: Some("Verify diff and citations".into()),
            role: Some("verifier".into()),
            depth: 1,
            status: "completed".into(),
            model: Some("gpt-5".into()),
            usage_label: Some("1.2k tok".into()),
            started_at: Some(1_763_100_001_000),
            completed_at: Some(1_763_100_008_000),
            error: None,
        }],
        todos: vec![
            TodoItemView {
                id: "todo-1".into(),
                content: "Audit composer disabled states".into(),
                status: "completed".into(),
                priority: Some("high".into()),
            },
            TodoItemView {
                id: "todo-2".into(),
                content: "Verify Rune DiffView unified and split modes".into(),
                status: "in_progress".into(),
                priority: Some("medium".into()),
            },
        ],
        feed: vec![
            FeedItem::Message {
                id: "msg-u1".into(),
                role: FeedMessageRole::User,
                content: "Earlier check yesterday".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 1_762_900_000_000,
            },
            FeedItem::Message {
                id: "msg-u2".into(),
                role: FeedMessageRole::User,
                content: "Please run @code-review and inspect composer.rs diff".into(),
                client_message_id: None,
                attachments: vec![TurnAttachmentInputPart::UploadedFile {
                    path: "notes/review-checklist.md".into(),
                    filename: "review-checklist.md".into(),
                    mime_type: "text/markdown".into(),
                }],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 1_763_100_000_000,
            },
            FeedItem::Reasoning {
                id: "reason-1".into(),
                content: "## Inspection\nChecked `ChatComposer.tsx` model selector lock rules and `Rune` DiffView hunk layout.".into(),
                mode: "reasoning".into(),
                streaming: false,
                timestamp_ms: 1_763_100_002_000,
            },
            FeedItem::Tool {
                id: "tool-1".into(),
                tool_name: "read_file".into(),
                title: Some("Read composer.rs".into()),
                call_id: Some("call-1".into()),
                status: ToolRunStatus::Completed,
                input: json!({ "path": "crates/cowork-desktop/src/views/chat/composer.rs" }),
                output: Some(json!({ "lines": 120 })),
                error: None,
                diff: None,
                streaming: false,
                timestamp_ms: 1_763_100_004_000,
                completed_at_ms: Some(1_763_100_005_000),
                output_truncated: false,
            },
            FeedItem::Tool {
                id: "tool-2".into(),
                tool_name: "edit_file".into(),
                title: Some("Update composer_ready".into()),
                call_id: Some("call-2".into()),
                status: ToolRunStatus::Completed,
                input: json!({ "path": "crates/cowork-desktop/src/views/chat/composer.rs" }),
                output: Some(json!({ "applied": true })),
                error: None,
                diff: Some(diff_patch.into()),
                streaming: false,
                timestamp_ms: 1_763_100_006_000,
                completed_at_ms: Some(1_763_100_008_000),
                output_truncated: false,
            },
            FeedItem::Message {
                id: "msg-a1".into(),
                role: FeedMessageRole::Assistant,
                content: "## Summary\nUpdated `composer_ready()` and locked model pickers on active turns.\n\n```rust\nlet locked = thread.is_some_and(|t| !t.draft) && busy;\n```\n\nVerified against [Protocol Docs](https://example.com/protocol).".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![CitationSource {
                    label: Some("1".into()),
                    title: Some("Cowork Protocol Spec".into()),
                    url: "https://example.com/protocol".into(),
                    domain: Some("example.com".into()),
                    snippet: Some("Model selectors lock while a turn streams.".into()),
                    reference_id: None,
                }],
                streaming: false,
                timestamp_ms: 1_763_100_010_000,
            },
        ],
        pending_interactions: vec![ChatInteraction::CommandApproval {
            request_id: JsonRpcLiteId::String("req-1".into()),
            item_id: "item-1".into(),
            command: Some("cargo test -p cowork-desktop".into()),
            cwd: Some("/tmp/agent-coworker".into()),
            reason: Some("Run unit tests after editing composer.rs".into()),
            risk_code: Some("workspace_command".into()),
        }],
        ..Default::default()
    };

    rt.agent_run_feeds.insert(
        "agent-sub-1".into(),
        vec![
            FeedItem::Tool {
                id: "sub-tool-1".into(),
                tool_name: "grep_search".into(),
                title: Some("Search disabled checks".into()),
                call_id: None,
                status: ToolRunStatus::Completed,
                input: json!({ "query": "modelSelectorDisabled" }),
                output: Some(json!({ "matches": 2 })),
                error: None,
                diff: None,
                streaming: false,
                timestamp_ms: 1_763_100_003_000,
                completed_at_ms: Some(1_763_100_004_000),
                output_truncated: false,
            },
            FeedItem::Message {
                id: "sub-a1".into(),
                role: FeedMessageRole::Assistant,
                content: "Verified all disabled gates match `ChatView.tsx:823`.".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 1_763_100_007_000,
            },
        ],
    );

    s.thread_runtime_by_id.insert(tid.clone(), rt);
    s.composer_edit = TextEdit::new("Follow-up check ready");
    s.composer_drafts.insert(
        tid,
        ComposerDraft {
            text: "Follow-up check ready".into(),
            ..Default::default()
        },
    );
    s
}

#[test]
fn renders_populated_active_thread_light_and_dark_with_zero_overflows() {
    for dark in [false, true] {
        let mut s = build_populated_thread_state(dark);
        // Expand activity group & edit diff tool card so reasoning/tools/DiffView are visible.
        s.chat_ui
            .expanded_activity_groups
            .insert("activity-reason-1".into(), true);
        s.chat_ui
            .expanded_tool_details
            .insert("tool-2".into(), true);
        let mut rt = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 2.0));
        rt.frame(0.0);
        let rgba = render_offscreen_rgba(&mut rt, dark);
        assert!(
            rgba.chunks_exact(4).any(|px| px[..3] != rgba[..3]),
            "rendered chat frame must not be blank (dark={dark})"
        );
        let label = if dark {
            "chat-active-dark"
        } else {
            "chat-active-light"
        };
        maybe_save_snap(label, &rgba, 2.0);

        let els = rt.elements();
        for key in [
            "chat-view",
            "chat-feed-surface",
            "chat-composer-dock",
            "composer-input",
        ] {
            let found = els.iter().find(|e| e.key.as_deref() == Some(key));
            assert!(
                found.is_some(),
                "expected element key `{key}` in active thread"
            );
            let rect = found.unwrap().rect;
            assert!(
                rect[0] >= -1.0 && rect[0] + rect[2] <= SNAP_VIEWPORT.0 + 1.0,
                "`{key}` x-bounds {rect:?} exceed viewport width {}",
                SNAP_VIEWPORT.0
            );
        }
    }
}

#[test]
fn renders_agent_viewer_drawer_recovery_banner_and_cancel_dialog() {
    for dark in [false, true] {
        let mut s = build_populated_thread_state(dark);
        let tid = "th-demo".to_string();
        if let Some(tr) = s.thread_runtime_by_id.get_mut(&tid) {
            tr.streaming = true;
            tr.agents[0].status = "running".into();
            tr.agents[0].completed_at = None;
            tr.transcript_delivery_failure = Some(TranscriptDeliveryFailure {
                message: "Missed live delta sequence; click Reload to resync.".into(),
                recoverable: true,
            });
            tr.pending_interactions.push(ChatInteraction::UserInput {
                request_id: JsonRpcLiteId::String("req-ask-1".into()),
                item_id: "ask-1".into(),
                questions: json!({
                    "questions": [{
                        "id": "q1",
                        "question": "Which verification scope should run?",
                        "options": [
                            { "label": "Fast crate tests", "description": "Run cowork-desktop suite only" },
                            { "label": "Full workspace", "description": "Run cargo test --workspace" }
                        ]
                    }]
                }),
            });
        }
        s.agent_viewer = Some(AgentViewerState {
            thread_id: tid.clone(),
            agent_id: "agent-sub-1".into(),
            title: "Verifier".into(),
        });
        s.chat_ui.cancel_subagents_thread_id = Some(tid);
        s.chat_ui.cancel_subagents_open = true;

        let mut rt = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 2.0));
        rt.frame(0.0);
        let rgba = render_offscreen_rgba(&mut rt, dark);
        let label = if dark {
            "chat-overlays-dark"
        } else {
            "chat-overlays-light"
        };
        maybe_save_snap(label, &rgba, 2.0);

        let els = rt.elements();
        let drawer = els
            .iter()
            .find(|e| e.key.as_deref() == Some("agent-run-viewer"))
            .expect("agent-run-viewer must be rendered");
        assert!(drawer.rect[0] + drawer.rect[2] <= SNAP_VIEWPORT.0 + 1.0);
        assert!(drawer.rect[0] >= 800.0);

        let feed_surface = els
            .iter()
            .find(|e| e.key.as_deref() == Some("chat-feed-surface"))
            .expect("chat-feed-surface must exist");
        let recovery = els
            .iter()
            .find(|e| e.key.as_deref() == Some("transcript-delivery-recovery"))
            .expect("transcript-delivery-recovery must be rendered");
        let composer = els
            .iter()
            .find(|e| e.key.as_deref() == Some("chat-composer-dock"))
            .expect("chat-composer-dock must exist");
        assert!(
            recovery.rect[1] >= feed_surface.rect[1] + feed_surface.rect[3] - 1.0,
            "recovery banner top {} must not overlap feed surface bottom {}",
            recovery.rect[1],
            feed_surface.rect[1] + feed_surface.rect[3]
        );
        assert!(
            recovery.rect[1] + recovery.rect[3] <= composer.rect[1] + 1.0,
            "recovery banner bottom {} must sit above composer top {}",
            recovery.rect[1] + recovery.rect[3],
            composer.rect[1]
        );

        let dialog = els
            .iter()
            .find(|e| e.key.as_deref() == Some("cancel-subagents-dialog-dialog"))
            .expect("cancel-subagents-dialog-dialog must be rendered");
        let dialog_w = dialog.rect[2];
        assert!(
            dialog_w <= 461.0,
            "cancel dialog width {dialog_w} exceeded configured 460pt max"
        );
    }
}

#[test]
fn interactive_runtime_clicks_and_disabled_gates_work() {
    // 1) Landing starter prompt click + empty model combobox opens popup.
    let landing_state = AppState {
        scene_mode: true,
        ..Default::default()
    };
    let mut rt_landing = Runtime::new(
        landing_state,
        test_chat_root,
        SNAP_VIEWPORT,
        Env::new(true, 1.0),
    );
    rt_landing.frame(0.0);

    let (sx, sy) = rt_landing
        .find("starter:draft-plan")
        .expect("starter:draft-plan should exist on landing");
    rt_landing.pointer_move(sx, sy);
    rt_landing.pointer_down(sx, sy);
    rt_landing.pointer_up(sx, sy);
    rt_landing.frame(0.0);
    assert!(
        !rt_landing.state.composer_edit.text.trim().is_empty(),
        "clicking starter card must populate composer_edit"
    );

    // 2) CancelSubagentsDialog "Keep subagents" closes modal & queues cancel.
    let mut active = build_populated_thread_state(false);
    active.chat_ui.cancel_subagents_open = true;
    let mut rt_dialog = Runtime::new(active, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_dialog.frame(0.0);
    rt_dialog.frame(0.3);
    let (kx, ky) = rt_dialog
        .find("cancel-subagents-keep")
        .expect("cancel-subagents-keep button must be clickable");
    rt_dialog.pointer_move(kx, ky);
    rt_dialog.pointer_down(kx, ky);
    rt_dialog.pointer_up(kx, ky);
    rt_dialog.frame(0.0);
    assert!(
        !rt_dialog.state.chat_ui.cancel_subagents_open,
        "clicking Keep subagents must close dialog"
    );

    // 3) Read-only notice blocks submit_composer_message and marks controls disabled.
    let mut ro = build_populated_thread_state(false);
    ro.thread_runtime_by_id
        .get_mut("th-demo")
        .unwrap()
        .read_only_notice = Some(ChatViewReadOnlyNotice {
        id: None,
        title: "Archived".into(),
        detail: "Read-only transcript".into(),
    });
    let mut rt_ro = Runtime::new(ro, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_ro.frame(0.0);
    let els_ro = rt_ro.elements();
    let input_ro = els_ro
        .iter()
        .find(|e| e.key.as_deref() == Some("composer-input"))
        .expect("composer-input must exist");
    assert!(
        !input_ro.focusable,
        "composer-input must not be focusable/editable on read-only notice"
    );

    let draft_before = rt_ro.state.composer_drafts.clone();
    rt_ro.update(|s, _| chat::composer::submit_composer_message(s));
    assert_eq!(
        rt_ro.state.composer_drafts, draft_before,
        "submit_composer_message must be a no-op under read_only_notice"
    );
}

#[test]
fn non_draft_busy_thread_disables_model_and_reasoning_selectors() {
    let mut s = build_populated_thread_state(false);
    s.thread_runtime_by_id.get_mut("th-demo").unwrap().streaming = true;
    let mut rt = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt.frame(0.0);

    let els = rt.elements();
    let model_picker = els
        .iter()
        .find(|e| e.key.as_deref() == Some("composer-model-picker-button"))
        .expect("Model selector trigger must be present in elements");
    assert!(
        !model_picker.focusable,
        "non-draft busy thread must disable Model selector focusability"
    );
    let [mx, my] = [
        model_picker.rect[0] + model_picker.rect[2] * 0.5,
        model_picker.rect[1] + model_picker.rect[3] * 0.5,
    ];
    rt.pointer_move(mx, my);
    rt.pointer_down(mx, my);
    rt.pointer_up(mx, my);
    rt.frame(0.0);
    assert!(
        !rt.state.chat_ui.model_combobox.is_open(),
        "clicking disabled Model selector must not open popup"
    );

    let reasoning_picker = els
        .iter()
        .find(|e| e.key.as_deref() == Some("composer-reasoning-select-trigger"))
        .expect("Reasoning effort selector trigger must be present in elements");
    assert!(
        !reasoning_picker.focusable,
        "non-draft busy thread must disable Reasoning effort selector focusability"
    );
    let [rx, ry] = [
        reasoning_picker.rect[0] + reasoning_picker.rect[2] * 0.5,
        reasoning_picker.rect[1] + reasoning_picker.rect[3] * 0.5,
    ];
    rt.pointer_move(rx, ry);
    rt.pointer_down(rx, ry);
    rt.pointer_up(rx, ry);
    rt.frame(0.0);
    assert!(
        !rt.state.chat_ui.reasoning_open,
        "clicking disabled Reasoning effort selector must not open menu"
    );
}

#[test]
fn quick_chat_landing_and_review_55_fixes_hold_in_runtime() {
    // 1) Selecting "Quick chat" from landing target popup keeps workspace lazy via ONE_OFF_LANDING_SENTINEL.
    let mut s = AppState {
        scene_mode: true,
        active_workspace_id: Some("ws-work".into()),
        workspaces: vec![WorkspaceRecord::new("ws-work", "Work", "/tmp/work", 1)],
        ..Default::default()
    };
    s.workspaces[0].user_name = Some("Max".into());
    s.desktop_settings.theme = ThemePreference::Light;
    s.system_dark_override = Some(false);

    let mut rt_landing = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 2.0));
    rt_landing.frame(0.0);
    let landing_light_rgba = render_offscreen_rgba(&mut rt_landing, false);
    maybe_save_snap("chat-landing-light", &landing_light_rgba, 2.0);

    let (tx, ty) = rt_landing
        .find("landing-target-trigger")
        .expect("landing-target-trigger must exist");
    rt_landing.pointer_move(tx, ty);
    rt_landing.pointer_down(tx, ty);
    rt_landing.pointer_up(tx, ty);
    rt_landing.frame(0.0);
    rt_landing.frame(0.3);

    let (qx, qy) = rt_landing
        .find("landing-target-menu-option-quick")
        .expect("Quick chat option must exist in landing target menu");
    rt_landing.pointer_move(qx, qy);
    rt_landing.pointer_down(qx, qy);
    rt_landing.pointer_up(qx, qy);
    rt_landing.frame(0.0);

    assert_eq!(
        rt_landing.state.landing_workspace_id.as_deref(),
        Some(ONE_OFF_LANDING_SENTINEL)
    );
    assert_eq!(
        rt_landing.state.active_workspace_id.as_deref(),
        Some("ws-work")
    );
    assert!(
        chat::composer::resolve_composer_workspace(&rt_landing.state, None, true).is_none(),
        "landing sentinel must resolve to Quick chat instead of falling back to active workspace"
    );

    // Save dark landing snapshot with Quick chat selected.
    let mut dark_landing = AppState {
        scene_mode: true,
        active_workspace_id: Some("ws-work".into()),
        workspaces: vec![WorkspaceRecord::new("ws-work", "Work", "/tmp/work", 1)],
        landing_workspace_id: Some(ONE_OFF_LANDING_SENTINEL.into()),
        system_dark_override: Some(true),
        ..Default::default()
    };
    dark_landing.desktop_settings.theme = ThemePreference::Dark;
    let mut rt_landing_dark = Runtime::new(
        dark_landing,
        test_chat_root,
        SNAP_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt_landing_dark.frame(0.0);
    let landing_dark_rgba = render_offscreen_rgba(&mut rt_landing_dark, true);
    maybe_save_snap("chat-landing-dark", &landing_dark_rgba, 2.0);

    // 2) Single-question Ask: `isSecret` uses `.secure()`, and `multiSelect` combines checked + typed text.
    let mut s_ask = build_populated_thread_state(false);
    let tid = "th-demo".to_string();
    s_ask
        .thread_runtime_by_id
        .get_mut(&tid)
        .unwrap()
        .pending_interactions = vec![
        ChatInteraction::UserInput {
            request_id: JsonRpcLiteId::String("req-multi".into()),
            item_id: "ask-multi".into(),
            questions: json!({
                "id": "frameworks",
                "question": "Select stacks",
                "multiSelect": true,
                "options": [
                    { "label": "Rune" },
                    { "label": "Ratatui" }
                ]
            }),
        },
        ChatInteraction::UserInput {
            request_id: JsonRpcLiteId::String("req-secret".into()),
            item_id: "ask-secret".into(),
            questions: json!({
                "id": "token",
                "question": "Enter token",
                "isSecret": true
            }),
        },
    ];
    s_ask
        .chat_ui
        .ask_text_edits
        .insert("req-multi:frameworks".into(), TextEdit::new("Custom"));
    s_ask
        .chat_ui
        .ask_text_edits
        .insert("req-secret:token".into(), TextEdit::new("top-secret-token"));

    let mut rt_ask = Runtime::new(s_ask, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_ask.frame(0.0);

    // Click option 0 ("Rune") on the multiSelect card, then click Send -> must include both Rune and Custom.
    let (ox, oy) = rt_ask
        .find("ask-opt:req-multi:frameworks:0")
        .expect("multiSelect option button must exist");
    rt_ask.pointer_move(ox, oy);
    rt_ask.pointer_down(ox, oy);
    rt_ask.pointer_up(ox, oy);
    rt_ask.frame(0.0);

    let (send_x, send_y) = rt_ask
        .find("ask-send:req-multi")
        .expect("Send button for single-question multiSelect must exist");
    rt_ask.pointer_move(send_x, send_y);
    rt_ask.pointer_down(send_x, send_y);
    rt_ask.pointer_up(send_x, send_y);
    rt_ask.frame(0.0);

    let ask_cmd = rt_ask
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendServerResponse { id, result, .. }
                if *id == JsonRpcLiteId::String("req-multi".into()) =>
            {
                Some(result.clone())
            }
            _ => None,
        })
        .expect("SendServerResponse for req-multi must be dispatched");
    assert_eq!(
        ask_cmd.get("answer").and_then(|v| v.as_str()),
        Some("Rune, Custom"),
        "single-question multiSelect must preserve selected checkboxes alongside custom text"
    );

    // Now req-secret card is top pending interaction: verify its input masks text (`ElementInfo::text == None`).
    let secret_el = rt_ask
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("ask-input:req-secret:token"))
        .expect("secret ask input must render");
    assert!(
        secret_el.text.is_none() && rt_ask.element_is_secure(&secret_el.path),
        "isSecret Ask input must mask accessibility text via .secure(), got {:?}",
        secret_el.text
    );

    // 3) CancelSubagentsDialog captures originating thread_id even if active thread switches while open.
    let mut s_stop = build_populated_thread_state(false);
    let tr_demo = s_stop.thread_runtime_by_id.get_mut("th-demo").unwrap();
    tr_demo.streaming = true;
    tr_demo.agents[0].status = "running".into();
    tr_demo.agents[0].completed_at = None;
    s_stop.threads.push(ThreadRecord {
        id: "th-other".into(),
        workspace_id: "ws-demo".into(),
        title: "Other thread".into(),
        status: ThreadStatus::Active,
        ..Default::default()
    });
    s_stop
        .thread_runtime_by_id
        .insert("th-other".into(), ThreadRuntime::default());

    let mut rt_stop = Runtime::new(s_stop, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_stop.frame(0.0);
    let (stop_x, stop_y) = rt_stop
        .find("composer-stop-btn")
        .expect("composer-stop-btn must exist on streaming thread");
    rt_stop.pointer_move(stop_x, stop_y);
    rt_stop.pointer_down(stop_x, stop_y);
    rt_stop.pointer_up(stop_x, stop_y);
    rt_stop.frame(0.0);
    assert_eq!(
        rt_stop.state.chat_ui.cancel_subagents_thread_id.as_deref(),
        Some("th-demo")
    );

    // Switch active thread while modal remains open; dialog must still interrupt "th-demo".
    rt_stop.update(|st, _| st.dispatch(Action::Navigate(NavAction::OpenThread("th-other".into()))));
    rt_stop.frame(0.0);
    rt_stop.frame(0.3);
    let (keep_x, keep_y) = rt_stop
        .find("cancel-subagents-keep")
        .expect("cancel-subagents-keep must exist after switching thread");
    rt_stop.pointer_move(keep_x, keep_y);
    rt_stop.pointer_down(keep_x, keep_y);
    rt_stop.pointer_up(keep_x, keep_y);
    rt_stop.frame(0.0);

    assert!(rt_stop.state.chat_ui.cancel_subagents_thread_id.is_none());
    let interrupt_tid = rt_stop
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendRequest { method, params, .. } if method == "turn/interrupt" => params
                .get("threadId")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            _ => None,
        });
    assert_eq!(
        interrupt_tid.as_deref(),
        Some("th-demo"),
        "CancelSubagentsDialog must interrupt originating captured thread_id even after switching active thread"
    );
}

#[test]
fn review_72_and_79_ask_preservation_composer_locks_and_overlay_viewer() {
    // 1) Failed WS send keeps pending Ask card open and preserves selected options & typed text.
    let mut s_ask = build_populated_thread_state(false);
    s_ask
        .thread_runtime_by_id
        .get_mut("th-demo")
        .unwrap()
        .pending_interactions = vec![
        ChatInteraction::UserInput {
            request_id: JsonRpcLiteId::String("req-keep".into()),
            item_id: "ask-keep".into(),
            questions: json!({
                "id": "frameworks",
                "question": "Select frameworks",
                "multiSelect": true,
                "options": ["Rune", "Taffy"]
            }),
        },
        ChatInteraction::UserInput {
            request_id: JsonRpcLiteId::String("req-stale".into()),
            item_id: "ask-stale".into(),
            questions: json!({
                "id": "stale_q",
                "question": "Stale"
            }),
        },
    ];
    s_ask
        .chat_ui
        .ask_text_edits
        .insert("req-keep:frameworks".into(), TextEdit::new("Custom keep"));
    s_ask
        .chat_ui
        .ask_text_edits
        .insert("req-stale:stale_q".into(), TextEdit::new("Old answer"));

    let mut rt_ask = Runtime::new(s_ask, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_ask.frame(0.0);

    // Select option 0, mark stale as confirmed before click, then click Send and fail req-keep via WS error.
    let (ox, oy) = rt_ask
        .find("ask-opt:req-keep:frameworks:0")
        .expect("ask option must exist");
    rt_ask.pointer_move(ox, oy);
    rt_ask.pointer_down(ox, oy);
    rt_ask.pointer_up(ox, oy);
    rt_ask.frame(0.0);

    rt_ask.update(|st, _| {
        st.apply_store_event(StoreEvent::WsServerResponseResult {
            workspace_id: "ws-demo".into(),
            request_id: JsonRpcLiteId::String("req-stale".into()),
            ok: true,
            error: None,
        });
    });

    let (sx, sy) = rt_ask
        .find("ask-send:req-keep")
        .expect("ask-send must exist");
    rt_ask.pointer_move(sx, sy);
    rt_ask.pointer_down(sx, sy);
    rt_ask.pointer_up(sx, sy);
    rt_ask.frame(0.0);

    // Simulate WS write failure for req-keep: pending card stays open AND user answers remain intact.
    rt_ask.update(|st, _| {
        st.apply_store_event(StoreEvent::WsServerResponseResult {
            workspace_id: "ws-demo".into(),
            request_id: JsonRpcLiteId::String("req-keep".into()),
            ok: false,
            error: Some("Socket disconnected".into()),
        });
    });
    assert!(
        rt_ask
            .state
            .chat_ui
            .ask_selected_options
            .get("req-keep:frameworks")
            .is_some_and(|v| v == &vec!["Rune".to_string()]),
        "selected options must survive failed Ask WS send"
    );
    assert_eq!(
        rt_ask
            .state
            .chat_ui
            .ask_text_edits
            .get("req-keep:frameworks")
            .map(|e| e.text.as_str()),
        Some("Custom keep"),
        "typed answer must survive failed Ask WS send"
    );
    assert!(
        !rt_ask
            .state
            .chat_ui
            .ask_text_edits
            .contains_key("req-stale:stale_q"),
        "confirmed ask state must be pruned once removed from pending_interactions"
    );

    // 2) Opening AgentRunViewer does NOT lock parent thread model selector; narrow chat_view switches viewer to overlay.
    let mut s_lock = build_populated_thread_state(false);
    s_lock.agent_viewer = Some(AgentViewerState {
        thread_id: "th-demo".into(),
        agent_id: "agent-sub-1".into(),
        title: "Verifier".into(),
    });
    let mut rt_lock = Runtime::new(s_lock, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_lock.frame(0.0);
    let model_el = rt_lock
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("composer-model-picker-button"))
        .expect("model picker must exist");
    assert!(
        model_el.focusable,
        "opening AgentRunViewer inspector must not lock parent thread's model selector"
    );

    // Narrow viewport (< 820pt) renders AgentRunViewer inside overlay backdrop without shrinking chat-main.
    let mut rt_narrow = Runtime::new(
        build_populated_thread_state(false),
        test_chat_root,
        (700.0, 820.0),
        Env::new(true, 1.0),
    );
    rt_narrow.update(|st, _| {
        st.agent_viewer = Some(AgentViewerState {
            thread_id: "th-demo".into(),
            agent_id: "agent-sub-1".into(),
            title: "Verifier".into(),
        });
    });
    rt_narrow.frame(0.0);
    rt_narrow.frame(0.0);
    let els_narrow = rt_narrow.elements();
    assert!(
        els_narrow
            .iter()
            .any(|e| e.key.as_deref() == Some("agent-run-viewer-backdrop")),
        "AgentRunViewer must render as right overlay when chat-view width < 820pt"
    );
    let main_narrow = els_narrow
        .iter()
        .find(|e| e.key.as_deref() == Some("chat-main"))
        .expect("chat-main must exist");
    assert!(
        main_narrow.rect[2] >= 690.0,
        "overlay AgentRunViewer must preserve full chat-main width {}, avoiding 4-pane squeeze",
        main_narrow.rect[2]
    );

    // 3) Streaming with missing session blocks submit_composer_message; transcript_only blocks file drop & model selector.
    let mut s_stream = build_populated_thread_state(false);
    s_stream.threads[0].session_id = None;
    s_stream
        .thread_runtime_by_id
        .get_mut("th-demo")
        .unwrap()
        .streaming = true;
    s_stream.composer_edit = TextEdit::new("Should not steer without session");
    let cmds_before = s_stream.services.emitted_ws_commands.len();
    chat::composer::submit_composer_message(&mut s_stream);
    assert_eq!(
        s_stream.services.emitted_ws_commands.len(),
        cmds_before,
        "submit_composer_message must block steer when streaming lacks active session_id"
    );
    assert_eq!(
        s_stream.composer_edit.text, "Should not steer without session",
        "blocked steer must keep composer draft untouched"
    );

    let mut s_to = build_populated_thread_state(false);
    s_to.thread_runtime_by_id
        .get_mut("th-demo")
        .unwrap()
        .transcript_only = true;
    let mut rt_to = Runtime::new(s_to, test_chat_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt_to.frame(0.0);
    let to_els = rt_to.elements();
    let card_to = to_els
        .iter()
        .find(|e| e.key.as_deref() == Some("chat-composer-card"))
        .expect("composer card must exist");
    let model_to = to_els
        .iter()
        .find(|e| e.key.as_deref() == Some("composer-model-picker-button"))
        .expect("model picker must exist");
    assert!(
        !model_to.focusable,
        "transcript_only thread must disable model selector"
    );

    let tmp_drop = std::env::temp_dir().join("cowork_chat_transcript_only_drop_test.txt");
    std::fs::write(&tmp_drop, b"drop payload").unwrap();
    let drop_pt = (
        card_to.rect[0] + card_to.rect[2] * 0.5,
        card_to.rect[1] + card_to.rect[3] * 0.5,
    );
    rt_to.drop_files(vec![tmp_drop.clone()], Some(drop_pt));
    rt_to.frame(0.0);
    assert!(
        rt_to
            .state
            .composer_drafts
            .get("th-demo")
            .is_none_or(|d| d.attachments.is_empty()),
        "chat-composer-card must disable file drop on transcript_only threads"
    );

    // Control: dropping the same file onto an active thread ingests it cleanly.
    rt_to.update(|st, _| {
        st.thread_runtime_by_id
            .get_mut("th-demo")
            .unwrap()
            .transcript_only = false;
    });
    rt_to.frame(0.0);
    rt_to.drop_files(vec![tmp_drop.clone()], Some(drop_pt));
    rt_to.frame(0.0);
    let _ = std::fs::remove_file(&tmp_drop);
    assert!(
        rt_to
            .state
            .composer_drafts
            .get("th-demo")
            .is_some_and(|d| !d.attachments.is_empty()),
        "normal active thread must still accept dropped files on composer card"
    );
}

fn test_canvas_docked_root(state: &AppState, cx: &mut Cx<AppState>, right_width: f32) -> El {
    let dark = state.effective_dark(cx.system_dark());
    let (kit, tokens) = theme::build_kit_with_accent(
        dark,
        state.desktop_settings.reduced_transparency,
        state.desktop_settings.high_contrast,
        state.desktop_settings.accent_palette,
    );
    cx.foreground(tokens.text_base);
    cx.focus_ring(2.0, 2.5, tokens.focus_ring);
    cx.web_focus();

    let chat_out = chat::view(state, cx, &kit);
    let mut overlays = chat_out.overlays;
    let mut split = row()
        .w_full()
        .h_full()
        .min_w(0.0)
        .min_h(0.0)
        .child(el().grow(1.0).min_w(0.0).h_full().child(chat_out.content));

    if let Some(canvas_out) = chat::canvas_pane(state, cx, &kit) {
        overlays.extend(canvas_out.overlays);
        split = split.child(
            el().w(right_width)
                .h_full()
                .min_h(0.0)
                .border_sides([0.0, 0.0, 0.0, 1.0], tokens.border)
                .child(canvas_out.content),
        );
    }

    el().w_full()
        .h_full()
        .fill(tokens.panel_bg)
        .child(rune_kit::root(split, overlays))
}

fn test_canvas_500_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
    test_canvas_docked_root(state, cx, 500.0)
}

fn test_canvas_320_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
    test_canvas_docked_root(state, cx, 320.0)
}

fn click_key(rt: &mut Runtime<AppState>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("expected clickable element key `{key}`"));
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);
}

fn click_canvas_key(rt: &mut Runtime<AppState>, key: &str) {
    let el_rect = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(key) && e.rect[0] >= 779.0)
        .map(|e| e.rect)
        .unwrap_or_else(|| panic!("expected clickable Canvas element key `{key}`"));
    let x = el_rect[0] + el_rect[2] * 0.5;
    let y = el_rect[1] + el_rect[3] * 0.5;
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);
}

#[test]
fn canvas_pane_gating_tabs_formatting_narrow_bounds_and_prompt_submission() {
    let md_content = "# Launch Spec\n\nInitial overview paragraph.\n\n- Check telemetry\n- Verify Canvas pane\n\n```rust\nfn ready() -> bool { true }\n```\n";

    // 1) Feature flag default (`canvas = false`) keeps canvas_pane inactive,
    //    and spreadsheets (.csv / .xlsx) stay out of Canvas even when enabled.
    let mut gated = build_populated_thread_state(false);
    gated.active_file_preview = Some(FilePreviewState {
        workspace_id: "ws-1".into(),
        path: "docs/spec.md".into(),
        title: "spec.md".into(),
        content: Some(md_content.into()),
        is_binary: false,
        is_markdown: true,
        truncated: false,
        error: None,
        ..Default::default()
    });
    let mut rt_off = Runtime::new(
        gated,
        test_canvas_500_root,
        SNAP_VIEWPORT,
        Env::new(true, 1.0),
    );
    rt_off.frame(0.0);
    assert!(
        rt_off.find("canvas-pane").is_none(),
        "canvas-pane must stay hidden when feature_flags[\"canvas\"] is false"
    );

    rt_off.update(|s, _| {
        s.feature_flags.insert("canvas".to_string(), true);
        s.active_file_preview = Some(FilePreviewState {
            workspace_id: "ws-1".into(),
            path: "data/budget.csv".into(),
            title: "budget.csv".into(),
            content: Some("colA,colB\n1,2\n".into()),
            is_binary: false,
            is_markdown: false,
            truncated: false,
            error: None,
            ..Default::default()
        });
    });
    rt_off.frame(0.0);
    assert!(
        rt_off.find("canvas-pane").is_none(),
        "spreadsheets must stay on views/preview/ even when canvas flag is true"
    );

    // 2) Document view (light + dark) + 320px minimum right-rail width bounds check.
    for dark in [false, true] {
        let mut s = build_populated_thread_state(dark);
        s.feature_flags.insert("canvas".to_string(), true);
        s.active_file_preview = Some(FilePreviewState {
            workspace_id: "ws-1".into(),
            path: "docs/spec.md".into(),
            title: "spec.md".into(),
            content: Some(md_content.into()),
            is_binary: false,
            is_markdown: true,
            truncated: false,
            error: None,
            ..Default::default()
        });
        let mut rt = Runtime::new(s, test_canvas_500_root, SNAP_VIEWPORT, Env::new(true, 2.0));
        rt.frame(0.0);
        let rgba = render_offscreen_rgba(&mut rt, dark);
        maybe_save_snap(
            if dark {
                "canvas-document-dark"
            } else {
                "canvas-document-light"
            },
            &rgba,
            2.0,
        );
        assert!(
            rt.find("canvas-styling-toggle").is_none()
                && rt.find("canvas-formatting-bar").is_none(),
            "Styling toggle and formatting bar must stay hidden in Document tab (dark={dark})"
        );
        let els = rt.elements();
        for key in [
            "canvas-pane",
            "canvas-header",
            "canvas-toolbar",
            "canvas-document-tab",
            "canvas-prompt-footer",
        ] {
            let found = els
                .iter()
                .find(|e| e.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("missing `{key}` (dark={dark})"));
            assert!(
                found.rect[0] >= 779.0 && found.rect[0] + found.rect[2] <= SNAP_VIEWPORT.0 + 1.0,
                "`{key}` x-bounds {:?} overflow right rail",
                found.rect
            );
        }
    }

    // 320px narrow right-rail bounds check (Document starts without Styling bar; Source tab shows Styling + formatting bar cleanly inside 320px).
    let mut s_narrow = build_populated_thread_state(false);
    s_narrow.feature_flags.insert("canvas".to_string(), true);
    s_narrow.active_file_preview = Some(FilePreviewState {
        workspace_id: "ws-1".into(),
        path: "docs/very-long-canvas-document-title.md".into(),
        title: "very-long-canvas-document-title.md".into(),
        content: Some(md_content.into()),
        is_binary: false,
        is_markdown: true,
        truncated: false,
        error: None,
        ..Default::default()
    });
    let mut rt_narrow = Runtime::new(
        s_narrow,
        test_canvas_320_root,
        SNAP_VIEWPORT,
        Env::new(true, 1.0),
    );
    rt_narrow.frame(0.0);
    assert!(
        rt_narrow.find("canvas-styling-toggle").is_none()
            && rt_narrow.find("canvas-formatting-bar").is_none(),
        "narrow Document tab must hide Styling toggle and formatting bar"
    );
    click_canvas_key(&mut rt_narrow, "segment1");
    assert_eq!(rt_narrow.state.chat_ui.canvas.active_tab, CanvasTab::Source);
    for key in [
        "canvas-pane",
        "canvas-header",
        "canvas-toolbar",
        "canvas-styling-toggle",
        "canvas-formatting-bar",
        "canvas-save-btn",
        "canvas-save-as-btn",
        "canvas-prompt-send",
    ] {
        let found = rt_narrow
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("missing `{key}` at 320px"));
        assert!(
            found.rect[0] >= SNAP_VIEWPORT.0 - 321.0
                && found.rect[0] + found.rect[2] <= SNAP_VIEWPORT.0 + 1.0,
            "`{key}` x-bounds {:?} clipped at 320px rail",
            found.rect
        );
    }

    // 3) Switch to Source tab, apply Bold formatting, render Source PNGs, submit <canvas_request>.
    let mut s_edit = build_populated_thread_state(false);
    s_edit.feature_flags.insert("canvas".to_string(), true);
    s_edit.active_file_preview = Some(FilePreviewState {
        workspace_id: "ws-1".into(),
        path: "docs/spec.md".into(),
        title: "spec.md".into(),
        content: Some("Hello world\nSecond line".into()),
        is_binary: false,
        is_markdown: true,
        truncated: false,
        error: None,
        ..Default::default()
    });
    let mut rt_edit = Runtime::new(
        s_edit,
        test_canvas_500_root,
        SNAP_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt_edit.frame(0.0);
    click_canvas_key(&mut rt_edit, "segment1");
    assert_eq!(rt_edit.state.chat_ui.canvas.active_tab, CanvasTab::Source);
    assert_eq!(
        rt_edit.state.chat_ui.canvas.source_edit.text,
        "Hello world\nSecond line"
    );
    assert!(!rt_edit.state.chat_ui.canvas.is_dirty());

    // Select "world" and click Bold formatting button.
    rt_edit.update(|s, _| {
        s.chat_ui.canvas.source_edit.set_selection(6, 11);
    });
    rt_edit.frame(0.0);
    click_key(&mut rt_edit, "canvas-fmt-bold");
    assert_eq!(
        rt_edit.state.chat_ui.canvas.source_edit.text,
        "Hello **world**\nSecond line"
    );
    assert!(rt_edit.state.chat_ui.canvas.is_dirty());
    assert!(
        rt_edit.find("canvas-selection-chip").is_some(),
        "selection excerpt chip should show when text is selected in Source mode"
    );

    let rgba_src_light = render_offscreen_rgba(&mut rt_edit, false);
    maybe_save_snap("canvas-source-light", &rgba_src_light, 2.0);

    // Fresh Runtime for dark snapshot so headless Renderer starts with an empty GPU glyph atlas.
    let mut s_edit_dark = build_populated_thread_state(true);
    s_edit_dark.feature_flags.insert("canvas".to_string(), true);
    s_edit_dark.active_file_preview = Some(FilePreviewState {
        workspace_id: "ws-1".into(),
        path: "docs/spec.md".into(),
        title: "spec.md".into(),
        content: Some("Hello world\nSecond line".into()),
        is_binary: false,
        is_markdown: true,
        truncated: false,
        error: None,
        ..Default::default()
    });
    let mut rt_edit_dark = Runtime::new(
        s_edit_dark,
        test_canvas_500_root,
        SNAP_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt_edit_dark.frame(0.0);
    click_canvas_key(&mut rt_edit_dark, "segment1");
    rt_edit_dark.update(|s, _| {
        s.chat_ui.canvas.source_edit.set_selection(6, 11);
    });
    rt_edit_dark.frame(0.0);
    click_key(&mut rt_edit_dark, "canvas-fmt-bold");
    let rgba_src_dark = render_offscreen_rgba(&mut rt_edit_dark, true);
    maybe_save_snap("canvas-source-dark", &rgba_src_dark, 2.0);

    // Submit collaborative prompt referencing the selected word.
    rt_edit.update(|s, _| {
        s.chat_ui.canvas.prompt_edit = TextEdit::new("Make this sharper");
    });
    rt_edit.frame(0.0);
    rt_edit.settle_all();
    rt_edit.frame(0.0);
    click_key(&mut rt_edit, "canvas-prompt-send");
    assert!(
        rt_edit.state.chat_ui.canvas.prompt_edit.text.is_empty(),
        "prompt box must clear on submit"
    );
    let cmds = &rt_edit.state.services.emitted_ws_commands;
    let has_canvas_xml = cmds.iter().any(|c| match c {
        WsCommand::SendRequest { method, params, .. } if method == "turn/start" => {
            let s = params.to_string();
            s.contains("<canvas_request")
                && s.contains("Make this sharper")
                && s.contains("spec.md")
        }
        _ => false,
    });
    assert!(
        has_canvas_xml,
        "canvas prompt must dispatch turn/start containing <canvas_request> XML, got {cmds:?}"
    );

    // Maximize toggle & Close.
    assert!(!chat::is_canvas_maximized(&rt_edit.state));
    click_key(&mut rt_edit, "canvas-maximize-btn");
    assert!(chat::is_canvas_maximized(&rt_edit.state));
    click_key(&mut rt_edit, "canvas-close-btn");
    assert!(rt_edit.find("canvas-pane").is_none());
    assert!(rt_edit.state.active_file_preview.is_none());
}

#[test]
fn canvas_pane_conflict_reload_modal_load_error_and_truncation_guards() {
    // 1) Truncation enforces read-only banners and hides styling toolbar + disables send.
    let mut s_trunc = build_populated_thread_state(false);
    s_trunc.chat_ui.canvas.fixture = Some(CanvasFixtureState {
        workspace_id: "ws-1".into(),
        path: "docs/huge.md".into(),
        title: "huge.md".into(),
        content: "# Huge file\nTruncated preview...".into(),
        is_markdown: true,
        truncated: true,
        lifecycle: CanvasLifecycleKind::Ready,
        message: None,
    });
    s_trunc.chat_ui.canvas.prompt_edit = TextEdit::new("Attempt edit");
    let mut rt_trunc = Runtime::new(
        s_trunc,
        test_canvas_500_root,
        SNAP_VIEWPORT,
        Env::new(true, 1.0),
    );
    rt_trunc.frame(0.0);
    assert!(rt_trunc.find("canvas-truncated-banner").is_some());
    assert!(rt_trunc.find("canvas-formatting-bar").is_none());
    let send_el = rt_trunc
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("canvas-prompt-send"))
        .expect("canvas-prompt-send should render");
    assert!(
        !send_el.focusable,
        "truncated documents must disable prompt submit"
    );

    // 2) Conflict banner + Reload confirmation modal protects unsaved edits until confirmed.
    let mut s_conf = build_populated_thread_state(false);
    s_conf.chat_ui.canvas.fixture = Some(CanvasFixtureState {
        workspace_id: "ws-1".into(),
        path: "docs/spec.md".into(),
        title: "spec.md".into(),
        content: "# Updated on disk\n\nFresh content from server.".into(),
        is_markdown: true,
        truncated: false,
        lifecycle: CanvasLifecycleKind::Conflict,
        message: Some("File changed on disk while you had local edits.".into()),
    });
    let mut rt_conf = Runtime::new(
        s_conf,
        test_canvas_500_root,
        SNAP_VIEWPORT,
        Env::new(true, 2.0),
    );
    rt_conf.frame(0.0);
    click_canvas_key(&mut rt_conf, "segment1");
    rt_conf.update(|s, _| {
        s.chat_ui
            .canvas
            .source_edit
            .replace_text("# My unsaved local draft");
    });
    rt_conf.frame(0.0);
    rt_conf.settle_all();
    rt_conf.frame(0.0);
    assert!(rt_conf.find("canvas-conflict-banner").is_some());
    click_key(&mut rt_conf, "canvas-conflict-reload-btn");
    rt_conf.frame(0.3);
    assert!(rt_conf.state.chat_ui.canvas.reload_confirm_open);
    let rgba_conf = render_offscreen_rgba(&mut rt_conf, false);
    maybe_save_snap("canvas-conflict-modal-light", &rgba_conf, 2.0);
    assert_eq!(
        rt_conf.state.chat_ui.canvas.source_edit.text,
        "# My unsaved local draft"
    );

    click_key(&mut rt_conf, "canvas-reload-confirm-btn");
    assert!(!rt_conf.state.chat_ui.canvas.reload_confirm_open);
    assert!(!rt_conf.state.chat_ui.canvas.is_dirty());
    assert_eq!(
        rt_conf.state.chat_ui.canvas.source_edit.text,
        "# Updated on disk\n\nFresh content from server."
    );

    // 3) LoadError Retry recovers cleanly.
    let mut s_err = build_populated_thread_state(false);
    s_err.chat_ui.canvas.fixture = Some(CanvasFixtureState {
        workspace_id: "ws-1".into(),
        path: "docs/missing.md".into(),
        title: "missing.md".into(),
        content: "# Recovered\nLoaded cleanly.".into(),
        is_markdown: true,
        truncated: false,
        lifecycle: CanvasLifecycleKind::LoadError,
        message: Some("File was temporarily unreadable.".into()),
    });
    let mut rt_err = Runtime::new(
        s_err,
        test_canvas_500_root,
        SNAP_VIEWPORT,
        Env::new(true, 1.0),
    );
    rt_err.frame(0.0);
    assert!(rt_err.find("canvas-load-error").is_some());
    click_key(&mut rt_err, "canvas-load-retry-btn");
    assert!(rt_err.find("canvas-load-error").is_none());
    assert!(rt_err.find("canvas-document-tab").is_some());
}

#[test]
fn canvas_pane_live_persistence_edit_save_conflict_reload_and_close_roundtrip() {
    use crate::actions::{ChatAction, NativeAction};
    use crate::state::CanvasDocumentStatus;
    use crate::ws::WsRpcError;

    let collect_canvas_badge_texts = |rt: &Runtime<AppState>| -> Vec<String> {
        let mut texts = Vec::new();
        for el in rt.elements() {
            if el.rect[0] >= 779.0
                && let Some(t) = el.text
            {
                texts.push(t);
            }
        }
        texts
    };

    let mut s = build_populated_thread_state(false);
    s.feature_flags.insert("canvas".to_string(), true);
    let ws_id = s.workspaces[0].id.clone();
    s.workspaces[0].path = "/tmp/ws-canvas".to_string();

    let mut rt = Runtime::new(s, test_canvas_500_root, SNAP_VIEWPORT, Env::new(true, 1.0));
    rt.frame(0.0);
    assert!(rt.find("canvas-pane").is_none());

    // 1) LoadFilePreview routes markdown docs into live CanvasDocumentSession (`Loading`).
    let ws_id_open = ws_id.clone();
    rt.update(move |st, _| {
        st.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: ws_id_open,
            path: "docs/spec.md".to_string(),
        }));
    });
    rt.settle_all();
    rt.frame(0.0);

    assert!(rt.find("canvas-loading").is_some());
    assert!(
        collect_canvas_badge_texts(&rt)
            .iter()
            .any(|t| t == "Loading")
    );
    let (open_req_id, doc_id, doc_gen) = {
        let session = rt
            .state
            .canvas_document
            .as_ref()
            .expect("canvas_document session created");
        assert_eq!(session.status, CanvasDocumentStatus::Loading);
        assert_eq!(session.path, "/tmp/ws-canvas/docs/spec.md");
        let req_id = rt
            .state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|cmd| match cmd {
                WsCommand::SendRequest {
                    request_id, method, ..
                } if method == "cowork/workspace/document/open" => Some(*request_id),
                _ => None,
            })
            .expect("expected cowork/workspace/document/open request");
        (req_id, session.document_id.clone(), session.generation)
    };

    // 2) Open RPC response transitions Loading -> Ready, renders Document tab cleanly.
    let ws_id_ev = ws_id.clone();
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id_ev,
            request_id: open_req_id,
            method: "cowork/workspace/document/open".to_string(),
            result: Ok(json!({
                "ok": true,
                "document": {
                    "path": "/tmp/ws-canvas/docs/spec.md",
                    "content": "# Spec\nInitial paragraph.",
                    "truncated": false,
                    "revision": {
                        "modifiedAtMs": 1000.0,
                        "changeTimeMs": 1000.0,
                        "size": 25,
                        "fingerprint": "fp-1"
                    }
                }
            })),
        });
    });
    rt.settle_all();
    rt.frame(0.0);

    assert!(rt.find("canvas-loading").is_none());
    assert!(rt.find("canvas-document-tab").is_some());
    assert!(collect_canvas_badge_texts(&rt).iter().any(|t| t == "Saved"));
    let save_el = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("canvas-save-btn"))
        .expect("canvas-save-btn present");
    assert!(!save_el.focusable, "clean doc should disable Save");

    // 3) Switch to Source, type/paste + Markdown Bold -> dispatches UpdateCanvasDraft immediately.
    let tabs_rect = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("canvas-view-tabs") && e.rect[0] >= 779.0)
        .map(|e| e.rect)
        .expect("canvas-view-tabs rect");
    let src_x = tabs_rect[0] + tabs_rect[2] * 0.78;
    let src_y = tabs_rect[1] + tabs_rect[3] * 0.5;
    rt.pointer_move(src_x, src_y);
    rt.pointer_down(src_x, src_y);
    rt.pointer_up(src_x, src_y);
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);

    assert!(rt.find("canvas-source-input").is_some());
    click_key(&mut rt, "canvas-source-input");
    rt.paste("\nAdded ");
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);
    click_key(&mut rt, "canvas-fmt-bold");

    let expected_edited = rt.state.chat_ui.canvas.source_edit.text.clone();
    assert!(expected_edited.contains("Added **"));
    assert_eq!(
        rt.state
            .canvas_document
            .as_ref()
            .expect("live session")
            .draft_content,
        expected_edited
    );
    assert!(
        collect_canvas_badge_texts(&rt)
            .iter()
            .any(|t| t == "Unsaved")
    );
    let save_el_dirty = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("canvas-save-btn"))
        .expect("canvas-save-btn present");
    assert!(save_el_dirty.focusable, "dirty doc should enable Save");

    // 4) Clicking Save dispatches cowork/workspace/document/save; Ok clears dirty while keeping Source tab.
    click_key(&mut rt, "canvas-save-btn");
    assert_eq!(
        rt.state.canvas_document.as_ref().unwrap().status,
        CanvasDocumentStatus::Saving
    );
    let (save_req_id, save_content) = rt
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendRequest {
                request_id,
                method,
                params,
                ..
            } if method == "cowork/workspace/document/save" => Some((
                *request_id,
                params
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            )),
            _ => None,
        })
        .expect("expected cowork/workspace/document/save request");
    assert_eq!(save_content, expected_edited);

    let save_edit_rev = rt.state.canvas_document.as_ref().unwrap().edit_revision;
    let saved_body = expected_edited.clone();
    let ws_id_save = ws_id.clone();
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id_save,
            request_id: save_req_id,
            method: "cowork/workspace/document/save".to_string(),
            result: Ok(json!({
                "ok": true,
                "editRevision": save_edit_rev,
                "document": {
                    "path": "/tmp/ws-canvas/docs/spec.md",
                    "content": saved_body,
                    "revision": {
                        "modifiedAtMs": 2000.0,
                        "changeTimeMs": 2000.0,
                        "size": expected_edited.len(),
                        "fingerprint": "fp-2"
                    }
                }
            })),
        });
    });
    rt.settle_all();
    rt.frame(0.0);

    assert_eq!(
        rt.state.canvas_document.as_ref().unwrap().status,
        CanvasDocumentStatus::Ready
    );
    assert!(!rt.state.canvas_document.as_ref().unwrap().dirty());
    assert!(collect_canvas_badge_texts(&rt).iter().any(|t| t == "Saved"));
    assert!(
        rt.find("canvas-source-input").is_some(),
        "saving must preserve Source tab"
    );
    let save_el_clean = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("canvas-save-btn"))
        .expect("canvas-save-btn present");
    assert!(!save_el_clean.focusable, "saved doc should re-disable Save");

    // 5) SaveError banner + Retry Save recovers cleanly.
    click_key(&mut rt, "canvas-source-input");
    rt.paste(" retry");
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);
    click_key(&mut rt, "canvas-save-btn");
    let fail_save_id = rt
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendRequest {
                request_id, method, ..
            } if method == "cowork/workspace/document/save" => Some(*request_id),
            _ => None,
        })
        .expect("save req before failure");
    let ws_id_err = ws_id.clone();
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id_err,
            request_id: fail_save_id,
            method: "cowork/workspace/document/save".to_string(),
            result: Err(WsRpcError {
                code: -32000,
                message: "disk write failed".to_string(),
                data: None,
            }),
        });
    });
    rt.settle_all();
    rt.frame(0.0);
    assert!(rt.find("canvas-save-error-banner").is_some());

    click_key(&mut rt, "canvas-retry-save-btn");
    let retry_save_id = rt
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendRequest {
                request_id, method, ..
            } if method == "cowork/workspace/document/save" => Some(*request_id),
            _ => None,
        })
        .expect("retry save request");
    assert_ne!(retry_save_id, fail_save_id);
    let retry_edit_rev = rt.state.canvas_document.as_ref().unwrap().edit_revision;
    let retry_body = rt.state.chat_ui.canvas.source_edit.text.clone();
    let ws_id_retry = ws_id.clone();
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id_retry,
            request_id: retry_save_id,
            method: "cowork/workspace/document/save".to_string(),
            result: Ok(json!({
                "ok": true,
                "editRevision": retry_edit_rev,
                "document": {
                    "path": "/tmp/ws-canvas/docs/spec.md",
                    "content": retry_body,
                    "revision": {
                        "modifiedAtMs": 3000.0,
                        "changeTimeMs": 3000.0,
                        "size": 64,
                        "fingerprint": "fp-3"
                    }
                }
            })),
        });
    });
    rt.settle_all();
    rt.frame(0.0);
    assert!(rt.find("canvas-save-error-banner").is_none());
    assert!(collect_canvas_badge_texts(&rt).iter().any(|t| t == "Saved"));

    // 6) Conflict via revision poll while dirty -> Reload confirmation modal -> Discard & Reload
    // bumps generation, preserves Source tab, and hydrates fresh disk content.
    click_key(&mut rt, "canvas-source-input");
    rt.paste(" unsaved");
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);

    rt.update(|st, _| {
        st.now_secs += 5.0;
        if let Some(doc) = st.canvas_document.as_mut() {
            doc.dirty_since_secs = Some(st.now_secs + 10.0);
            doc.last_poll_secs = st.now_secs - 5.0;
        }
        st.drain_events();
    });
    let rev_req_id = rt
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendRequest {
                request_id, method, ..
            } if method == "cowork/workspace/document/revision" => Some(*request_id),
            _ => None,
        })
        .expect("expected cowork/workspace/document/revision poll");
    let ws_id_rev = ws_id.clone();
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id_rev,
            request_id: rev_req_id,
            method: "cowork/workspace/document/revision".to_string(),
            result: Ok(json!({
                "ok": true,
                "revision": {
                    "modifiedAtMs": 9999.0,
                    "changeTimeMs": 9999.0,
                    "size": 120,
                    "fingerprint": "fp-external"
                }
            })),
        });
    });
    rt.settle_all();
    rt.frame(0.0);

    assert!(rt.find("canvas-conflict-banner").is_some());
    click_key(&mut rt, "canvas-conflict-reload-btn");
    assert!(rt.state.chat_ui.canvas.reload_confirm_open);
    assert!(rt.find("canvas-reload-confirm-btn").is_some());
    click_key(&mut rt, "canvas-reload-confirm-btn");

    assert!(rt.find("canvas-loading").is_some());
    let (reload_open_id, new_gen) = {
        let session = rt.state.canvas_document.as_ref().expect("reloaded session");
        assert_eq!(session.document_id, doc_id);
        assert!(session.generation > doc_gen);
        let req_id = rt
            .state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|cmd| match cmd {
                WsCommand::SendRequest {
                    request_id, method, ..
                } if method == "cowork/workspace/document/open" => Some(*request_id),
                _ => None,
            })
            .expect("expected document/open for reload");
        (req_id, session.generation)
    };
    assert_ne!(reload_open_id, open_req_id);

    let ws_id_reload = ws_id.clone();
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id_reload,
            request_id: reload_open_id,
            method: "cowork/workspace/document/open".to_string(),
            result: Ok(json!({
                "ok": true,
                "document": {
                    "path": "/tmp/ws-canvas/docs/spec.md",
                    "content": "# Reloaded\nFresh disk copy.",
                    "truncated": false,
                    "revision": {
                        "modifiedAtMs": 9999.0,
                        "changeTimeMs": 9999.0,
                        "size": 27,
                        "fingerprint": "fp-external"
                    }
                }
            })),
        });
    });
    rt.settle_all();
    rt.frame(0.0);

    assert!(rt.find("canvas-conflict-banner").is_none());
    assert!(
        rt.find("canvas-source-input").is_some(),
        "reload should preserve Source tab"
    );
    assert_eq!(
        rt.state.chat_ui.canvas.active_tab,
        CanvasTab::Source,
        "reload must keep user's active tab"
    );
    assert!(collect_canvas_badge_texts(&rt).iter().any(|t| t == "Saved"));

    // Verify Save As action routes properly as well, then close.
    rt.update(|st, _| {
        st.dispatch(Action::Chat(ChatAction::SaveCanvasDocumentAs {
            path: "/tmp/ws-canvas/docs/spec-copy.md".to_string(),
        }));
    });
    rt.settle_all();
    rt.frame(0.0);
    let save_as_id = rt
        .state
        .services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            WsCommand::SendRequest {
                request_id, method, ..
            } if method == "cowork/workspace/document/saveAs" => Some(*request_id),
            _ => None,
        })
        .expect("expected cowork/workspace/document/saveAs request");
    let save_as_rev = rt.state.canvas_document.as_ref().unwrap().edit_revision;
    rt.update(move |st, _| {
        st.apply_store_event(StoreEvent::WsResponse {
            workspace_id: ws_id,
            request_id: save_as_id,
            method: "cowork/workspace/document/saveAs".to_string(),
            result: Ok(json!({
                "ok": true,
                "editRevision": save_as_rev,
                "document": {
                    "path": "/tmp/ws-canvas/docs/spec-copy.md",
                    "content": "# Reloaded\nFresh disk copy.",
                    "revision": {
                        "modifiedAtMs": 10000.0,
                        "changeTimeMs": 10000.0,
                        "size": 27,
                        "fingerprint": "fp-copy"
                    }
                }
            })),
        });
    });
    rt.settle_all();
    rt.frame(0.0);
    assert!(
        collect_canvas_badge_texts(&rt)
            .iter()
            .any(|t| t == "spec-copy.md")
    );

    // 7) Close button dispatches CloseCanvasDocument and clears pane/UI state.
    click_key(&mut rt, "canvas-close-btn");
    assert!(rt.find("canvas-pane").is_none());
    assert!(rt.state.canvas_document.is_none());
    assert!(!rt.state.chat_ui.canvas.is_dirty());
    assert!(
        rt.state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .any(|cmd| matches!(
                cmd,
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/workspace/document/close"
                        && params.get("generation").and_then(|v| v.as_u64()) == Some(new_gen)
            )),
        "closing Canvas must emit document/close for active generation"
    );
}

#[test]
fn renders_latex_math_fixture_light_and_dark_cleanly() {
    let math_doc = "\
# Solution Summary $$\\Delta = b^2 - 4ac$$

Inline quadratic $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$ and **mass-energy $$E = mc^2$$** [Derivation](https://example.com/quadratic) with [external notes](https://example.com/notes), literal prices $5 and $10, escaped \\$\\$not_math\\$\\$, and code `$$also_not$$`.

- Subscripts $$a_{ij} + b_{jk}$$ inside a list item.

> Quoted relation: $$\\alpha + \\beta = \\gamma$$

```latex
$$
\\text{code block stays verbatim}
$$
```

$$
A = \\begin{pmatrix} \\alpha_{11} & \\alpha_{12} \\\\ \\alpha_{21} & \\alpha_{22} \\end{pmatrix}, \\quad \\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

$$
\\sum_{k=0}^{10} \\binom{10}{k} x^{10-k} y^k = x^{10} + 10x^9y + 45x^8y^2 + 120x^7y^3 + 210x^6y^4 + 252x^5y^5 + 210x^4y^6 + 120x^3y^7 + 45x^2y^8 + 10xy^9 + y^{10}
$$

Malformed fallback: $$\\frac{1}{$$ and streaming tail: $$x + ";

    for dark in [false, true] {
        let mut s = build_populated_thread_state(dark);
        let rt_thread = s.thread_runtime_by_id.get_mut("th-demo").unwrap();
        rt_thread.streaming = true;
        rt_thread.feed = vec![
            FeedItem::Message {
                id: "msg-math-u".into(),
                role: FeedMessageRole::User,
                content: "Show inline $$E = mc^2$$, matrix display math, $5 prices, code, malformed, and streaming fallback.".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 1_763_100_000_000,
            },
            FeedItem::Message {
                id: "msg-math-a".into(),
                role: FeedMessageRole::Assistant,
                content: math_doc.into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![CitationSource {
                    label: Some("1".into()),
                    title: Some("Quadratic Formula Proof".into()),
                    url: "https://example.com/quadratic".into(),
                    domain: Some("example.com".into()),
                    snippet: Some("Standard derivation via completing the square.".into()),
                    reference_id: None,
                }],
                streaming: true,
                timestamp_ms: 1_763_100_010_000,
            },
        ];
        rt_thread.pending_interactions.clear();

        let mut rt = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 2.0));
        rt.frame(0.0);
        let rgba = render_offscreen_rgba(&mut rt, dark);
        assert!(
            rgba.chunks_exact(4).any(|px| px[..3] != rgba[..3]),
            "rendered math chat frame must not be blank (dark={dark})"
        );
        let label = if dark {
            "chat-math-dark"
        } else {
            "chat-math-light"
        };
        maybe_save_snap(label, &rgba, 2.0);

        let els = rt.elements();
        assert!(
            els.iter().any(|e| {
                e.key
                    .as_deref()
                    .is_some_and(|k| k.starts_with("msg:msg-math-a:math:") && k.ends_with(":img"))
            }),
            "expected rendered display math pixel element for msg-math-a"
        );
        assert!(
            els.iter().any(|e| {
                e.key
                    .as_deref()
                    .is_some_and(|k| k.starts_with("msg:msg-math-a:imp:") && k.contains(":m:"))
            }),
            "expected inline math element inside paragraph for msg-math-a"
        );
        for e in &els {
            if let Some(k) = e.key.as_deref()
                && k.starts_with("msg:msg-math-a")
            {
                assert!(
                    e.rect[0] >= -1.0 && e.rect[0] + e.rect[2] <= SNAP_VIEWPORT.0 + 1.0,
                    "math element `{k}` rect {:?} overflows viewport width {}",
                    e.rect,
                    SNAP_VIEWPORT.0
                );
            }
        }
    }
}

#[test]
fn mixed_plain_and_inline_math_list_items_align_horizontally() {
    let list_doc = "\
- First plain bullet item
- Second bullet with inline $$\\alpha + \\beta.$$ math
- Third plain bullet item
  - Nested plain bullet
  - Nested inline math bullet $$x_i + y_i$$
  - Nested trailing bullet
";

    for dark in [false, true] {
        let mut s = build_populated_thread_state(dark);
        let rt_thread = s.thread_runtime_by_id.get_mut("th-demo").unwrap();
        rt_thread.streaming = false;
        rt_thread.feed = vec![
            FeedItem::Message {
                id: "msg-list-u".into(),
                role: FeedMessageRole::User,
                content: "Check mixed bullet alignment.".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 1_763_100_000_000,
            },
            FeedItem::Message {
                id: "msg-list-a".into(),
                role: FeedMessageRole::Assistant,
                content: list_doc.into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 1_763_100_010_000,
            },
        ];
        rt_thread.pending_interactions.clear();

        let mut rt = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 2.0));
        rt.frame(0.0);
        let rgba = render_offscreen_rgba(&mut rt, dark);
        let label = if dark {
            "chat-math-list-dark"
        } else {
            "chat-math-list-light"
        };
        maybe_save_snap(label, &rgba, 2.0);

        let els = rt.elements();
        let top_plain_body = els
            .iter()
            .find(|e| e.text.as_deref() == Some("First plain bullet item"))
            .expect("bullet 1 text");
        let top_math_body = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Second "))
            .expect("bullet 2 text");
        let top_math_marker = els
            .iter()
            .find(|e| {
                e.key
                    .as_deref()
                    .is_some_and(|k| k.starts_with("msg:msg-list-a:imp:") && k.ends_with(":marker"))
            })
            .expect("bullet 2 marker");
        let top_plain3_body = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Third plain bullet item"))
            .expect("bullet 3 text");

        assert!(
            (top_math_body.rect[0] - top_plain_body.rect[0]).abs() <= 0.5,
            "inline-math bullet body x={} must align with plain bullet 1 x={}",
            top_math_body.rect[0],
            top_plain_body.rect[0]
        );
        assert!(
            (top_math_body.rect[0] - top_plain3_body.rect[0]).abs() <= 0.5,
            "inline-math bullet body x={} must align with plain bullet 3 x={}",
            top_math_body.rect[0],
            top_plain3_body.rect[0]
        );
        assert!(
            (top_math_body.rect[0] - top_math_marker.rect[0] - 32.0).abs() <= 0.5
                && (top_math_marker.rect[2] - 32.0).abs() <= 0.5,
            "marker box {:?} must span 32px left of body x={}",
            top_math_marker.rect,
            top_math_body.rect[0]
        );

        let nested_plain_body = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Nested plain bullet"))
            .expect("nested plain bullet");
        let nested_math_body = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Nested "))
            .expect("nested math bullet");
        assert!(
            (nested_math_body.rect[0] - nested_plain_body.rect[0]).abs() <= 0.5,
            "nested inline-math bullet body x={} must align with nested plain bullet x={}",
            nested_math_body.rect[0],
            nested_plain_body.rect[0]
        );
        assert!(
            ((nested_math_body.rect[0] - top_math_body.rect[0]) - 32.0).abs() <= 0.5,
            "nested bullet x={} should be 32px right of top-level x={}",
            nested_math_body.rect[0],
            top_math_body.rect[0]
        );
        let nested_trailing_body = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Nested trailing bullet"))
            .expect("nested trailing bullet");
        assert!(
            (nested_trailing_body.rect[0] - nested_plain_body.rect[0]).abs() <= 0.5,
            "nested trailing bullet after inline-math item x={} must stay aligned with nested plain bullet x={}",
            nested_trailing_body.rect[0],
            nested_plain_body.rect[0]
        );
    }
}

#[test]
fn quick_chat_landing_does_not_clip_heading_or_lose_desktop_centering() {
    fn landing_with_header(s: &AppState, cx: &mut Cx<AppState>) -> El {
        let dark = s.effective_dark(cx.system_dark());
        let (kit, tokens) = theme::build_kit_with_accent(
            dark,
            s.desktop_settings.reduced_transparency,
            s.desktop_settings.high_contrast,
            s.desktop_settings.accent_palette,
        );
        cx.foreground(tokens.text_base);
        let out = chat::view(s, cx, &kit);
        rune::col()
            .w_full()
            .h_full()
            .fill(tokens.panel_bg)
            .child(el().key("quick-chat-header").w_full().h(43.0))
            .child(out.content)
    }

    fn landing_state() -> AppState {
        let mut s = build_populated_thread_state(false);
        s.dispatch(Action::Navigate(NavAction::OpenNewChat {
            workspace_id: Some("ws-demo".into()),
        }));
        s
    }

    let mut qc = Runtime::new(
        landing_state(),
        landing_with_header,
        (440.0, 560.0),
        Env::new(true, 1.0),
    );
    qc.frame(0.0);
    let qc_els = qc.elements();
    let qc_scroll = qc_els
        .iter()
        .find(|e| e.key.as_deref() == Some("landing-scroll"))
        .expect("quick chat landing-scroll");
    let qc_landing = qc_els
        .iter()
        .find(|e| e.key.as_deref() == Some("new-chat-landing"))
        .expect("quick chat new-chat-landing");
    assert!(
        qc_landing.rect[1] >= qc_scroll.rect[1],
        "Quick Chat landing {:?} must not overflow upward past landing-scroll {:?}",
        qc_landing.rect,
        qc_scroll.rect
    );

    let mut desk = Runtime::new(
        landing_state(),
        test_chat_root,
        SNAP_VIEWPORT,
        Env::new(true, 1.0),
    );
    desk.frame(0.0);
    let desk_els = desk.elements();
    let desk_scroll = desk_els
        .iter()
        .find(|e| e.key.as_deref() == Some("landing-scroll"))
        .expect("desktop landing-scroll");
    let desk_landing = desk_els
        .iter()
        .find(|e| e.key.as_deref() == Some("new-chat-landing"))
        .expect("desktop new-chat-landing");
    let top_space = desk_landing.rect[1] - desk_scroll.rect[1];
    let bottom_space =
        (desk_scroll.rect[1] + desk_scroll.rect[3]) - (desk_landing.rect[1] + desk_landing.rect[3]);
    assert!(
        top_space > 50.0 && (top_space - bottom_space).abs() <= 2.0,
        "Desktop landing should stay vertically centered inside landing-scroll (top_space={top_space}, bottom_space={bottom_space})"
    );
}

#[test]
fn approval_and_escalation_code_blocks_wrap_inside_padded_rounded_frame() {
    let long_unbroken_arg = format!("touch /home/cua/{}", "x".repeat(140));
    let long_no_slash = "x".repeat(140);
    let tall_multiline = (1..=16)
        .map(|i| format!("echo step_{i} && test -d /tmp/sandbox_{i}"))
        .collect::<Vec<_>>()
        .join("\n");

    for (name, risk_code, cmd, vp) in [
        (
            "approval-long-unbroken-arg",
            "workspace_command",
            long_unbroken_arg.as_str(),
            SNAP_VIEWPORT,
        ),
        (
            "escalation-long-no-slash",
            "sandbox_denied_escalation",
            long_no_slash.as_str(),
            SNAP_VIEWPORT,
        ),
        (
            "escalation-tall-multiline",
            "sandbox_denied_escalation",
            tall_multiline.as_str(),
            SNAP_VIEWPORT,
        ),
        (
            "escalation-narrow-480",
            "sandbox_denied_escalation",
            "touch /home/cua/outside-sandbox-probe && rm -f /home/cua/outside-sandbox-probe && echo cua-bash-approved && ls -1",
            (480.0, 760.0),
        ),
    ] {
        let mut s = build_populated_thread_state(false);
        let tid = "th-demo".to_string();
        let rt_state = s.thread_runtime_by_id.get_mut(&tid).unwrap();
        rt_state.feed.clear();
        rt_state.pending_interactions = vec![
            ChatInteraction::CommandApproval {
                request_id: JsonRpcLiteId::String(format!("req-{name}")),
                item_id: format!("item-{name}"),
                command: Some(cmd.to_string()),
                cwd: Some("/home/cua/agent-coworker".to_string()),
                reason: Some(
                    "The OS sandbox blocked this command from writing outside the workspace."
                        .to_string(),
                ),
                risk_code: Some(risk_code.to_string()),
            },
            ChatInteraction::FileChangeApproval {
                request_id: JsonRpcLiteId::String(format!("req-file-{name}")),
                item_id: format!("item-file-{name}"),
                path: Some(format!("/home/cua/{}/file.txt", "deepdir".repeat(18))),
                reason: Some("file_read_outside_workspace".to_string()),
            },
        ];

        let mut rt = Runtime::new(s, test_chat_root, vp, Env::new(true, 2.0));
        rt.frame(0.0);
        let els = rt.elements();

        for (card_key, preview_key) in [
            (
                format!("interaction:req-{name}:item-{name}"),
                format!("cmd-preview:req-{name}:item-{name}"),
            ),
            (
                format!("interaction:req-file-{name}:item-file-{name}"),
                format!("file-preview:req-file-{name}:item-file-{name}"),
            ),
        ] {
            let card = els
                .iter()
                .find(|e| e.key.as_deref() == Some(card_key.as_str()))
                .unwrap_or_else(|| panic!("expected card {card_key}"));
            let box_el = els
                .iter()
                .find(|e| e.key.as_deref() == Some(preview_key.as_str()))
                .unwrap_or_else(|| panic!("expected preview box {preview_key}"));
            let scroll_key = format!("{preview_key}:scroll");
            let scroll_el = els
                .iter()
                .find(|e| e.key.as_deref() == Some(scroll_key.as_str()))
                .unwrap_or_else(|| panic!("expected scroll container {scroll_key}"));
            let txt_key = format!("{preview_key}:text");
            let txt_el = els
                .iter()
                .find(|e| e.key.as_deref() == Some(txt_key.as_str()))
                .unwrap_or_else(|| panic!("expected text element {txt_key}"));

            assert!(
                card.rect[0] >= 20.0 && card.rect[0] + card.rect[2] <= vp.0 - 20.0,
                "{name}: card {card_key} rect {:?} overflows viewport width {}",
                card.rect,
                vp.0
            );
            assert!(
                box_el.rect[0] >= card.rect[0] + 15.0
                    && box_el.rect[0] + box_el.rect[2] <= card.rect[0] + card.rect[2] - 15.0,
                "{name}: preview box {:?} exceeds card {:?}",
                box_el.rect,
                card.rect
            );
            assert!(
                txt_el.rect[0] >= box_el.rect[0] + 14.0
                    && txt_el.rect[0] + txt_el.rect[2] <= box_el.rect[0] + box_el.rect[2] - 14.0,
                "{name}: text {:?} lacks >=14pt horizontal inset inside box {:?}",
                txt_el.rect,
                box_el.rect
            );
            assert!(
                txt_el.rect[3] >= 30.0,
                "{name}: long content {txt_key} must wrap onto multiple lines (got height {})",
                txt_el.rect[3]
            );
            assert!(
                scroll_el.rect[3] <= 160.5,
                "{name}: scroll box height {} exceeded 160pt cap",
                scroll_el.rect[3]
            );
        }

        if vp == SNAP_VIEWPORT {
            let rgba = render_offscreen_rgba(&mut rt, false);
            maybe_save_snap(name, &rgba, 2.0);
        }
    }
}

#[test]
fn chat_and_canvas_views_respect_selected_accent_palette() {
    fn canvas_only_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
        let dark = state.effective_dark(cx.system_dark());
        let (kit, tokens) = theme::build_kit_with_accent(
            dark,
            state.desktop_settings.reduced_transparency,
            state.desktop_settings.high_contrast,
            state.desktop_settings.accent_palette,
        );
        cx.foreground(tokens.text_base);
        cx.focus_ring(2.0, 2.5, tokens.focus_ring);
        cx.web_focus();
        let canvas_out = chat::canvas_pane(state, cx, &kit).expect("canvas pane expected");
        el().w_full()
            .h_full()
            .fill(tokens.panel_bg)
            .child(rune_kit::root(canvas_out.content, canvas_out.overlays))
    }

    for dark in [false, true] {
        let mut chat_renders: Vec<(AccentPalette, Vec<u8>)> = Vec::new();
        let mut canvas_renders: Vec<(AccentPalette, Vec<u8>)> = Vec::new();

        for palette in AccentPalette::ALL {
            let mut s = build_populated_thread_state(dark);
            s.desktop_settings.accent_palette = palette;
            s.composer_edit = TextEdit::new("Check accent palette contrast");

            let mut rt_chat = Runtime::new(s, test_chat_root, SNAP_VIEWPORT, Env::new(true, 2.0));
            rt_chat.frame(0.0);
            let chat_rgba = render_offscreen_rgba(&mut rt_chat, dark);
            chat_renders.push((palette, chat_rgba));

            let mut s_canvas = build_populated_thread_state(dark);
            s_canvas.desktop_settings.accent_palette = palette;
            s_canvas.feature_flags.insert("canvas".to_string(), true);
            s_canvas.chat_ui.canvas.prompt_edit = TextEdit::new("Tighten intro");
            s_canvas.active_file_preview = Some(FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "docs/accent.md".into(),
                title: "accent.md".into(),
                content: Some("# Accent Spec\n\nSee [tokens](https://example.com).".into()),
                is_binary: false,
                is_markdown: true,
                truncated: false,
                error: None,
                ..Default::default()
            });
            let mut rt_canvas = Runtime::new(
                s_canvas,
                canvas_only_root,
                SNAP_VIEWPORT,
                Env::new(true, 2.0),
            );
            rt_canvas.frame(0.0);
            let canvas_rgba = render_offscreen_rgba(&mut rt_canvas, dark);
            canvas_renders.push((palette, canvas_rgba));
        }

        for i in 0..chat_renders.len() {
            for j in (i + 1)..chat_renders.len() {
                assert_ne!(
                    chat_renders[i].1, chat_renders[j].1,
                    "dark={dark}: chat::view pixels did not change between {:?} and {:?}",
                    chat_renders[i].0, chat_renders[j].0
                );
                assert_ne!(
                    canvas_renders[i].1, canvas_renders[j].1,
                    "dark={dark}: chat::canvas_pane pixels did not change between {:?} and {:?}",
                    canvas_renders[i].0, canvas_renders[j].0
                );
            }
        }
    }
}
