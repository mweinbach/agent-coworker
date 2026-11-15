//! Unit tests for Settings navigation, gating, target resolution, and primitives.

use super::chats::build_import_source_params;
use super::desktop::{
    DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR, format_quick_chat_shortcut_label,
    parse_quick_chat_accelerator, shortcut_to_accelerator,
};
use super::developer::{parse_libreoffice_status, resolve_workspace_overflow_config};
use super::experiments::{KNOWN_FEATURE_FLAGS, is_flag_enabled, resolve_flag_enabled};
use super::manage_models_dialog::{can_add_custom_model, filter_provider_models};
use super::mcp_server_draft::{
    McpDraftInput, build_mcp_server_config, draft_from_summary, parse_args_line, parse_env_lines,
    parse_header_lines,
};
use super::primitives::{
    StatusTone, entity_palette_index, format_byte_size, management_targets, name_initials,
};
use super::privacy_telemetry::apply_privacy_patch;
use super::providers::{fallback_providers, is_provider_connected, provider_model_preview};
use super::providers_utils::{
    extract_rate_limit_hint, provider_status_badge, sort_and_filter_providers,
};
use super::remote_access::{parse_phone_permissions, update_phone_permission_string};
use super::shell::{page_key, resolve_active_page, settings_groups};
use super::updates::is_allowed_release_link;
use super::usage::{aggregate_usage, format_estimated_cost, format_token_count};
use crate::actions::{Action, NavAction, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::{
    AppState, McpServerSummary, PrivacyTelemetrySettings, ProviderModelSummary,
    ProviderStatusSummary, ProviderSummary, ThreadRecord, ThreadRuntime, UsageSummary,
    WorkspaceRecord,
};

#[test]
fn settings_groups_gate_remote_access_and_experiments() {
    let minimal = settings_groups(false, false);
    let ids: Vec<SettingsPageId> = minimal
        .iter()
        .flat_map(|g| g.pages.iter().map(|p| p.id))
        .collect();
    assert!(!ids.contains(&SettingsPageId::RemoteAccess));
    assert!(!ids.contains(&SettingsPageId::Experiments));
    assert_eq!(ids.len(), 12);

    let full = settings_groups(true, true);
    let full_ids: Vec<SettingsPageId> = full
        .iter()
        .flat_map(|g| g.pages.iter().map(|p| p.id))
        .collect();
    assert!(full_ids.contains(&SettingsPageId::RemoteAccess));
    assert!(full_ids.contains(&SettingsPageId::Experiments));
    assert_eq!(full_ids.len(), 14);
}

#[test]
fn resolve_active_page_normalizes_legacy_and_gated_routes() {
    let mut state = AppState::default();
    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Providers,
    ))));
    assert_eq!(resolve_active_page(&state), SettingsPageId::Models);

    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::RemoteAccess,
    ))));
    assert_eq!(resolve_active_page(&state), SettingsPageId::Models);

    state.dispatch(Action::Settings(SettingsAction::SetFeatureFlag {
        flag_id: "remoteAccess".to_string(),
        enabled: true,
    }));
    assert_eq!(resolve_active_page(&state), SettingsPageId::RemoteAccess);
}

#[test]
fn management_targets_collapse_one_off_chats() {
    let state = AppState {
        workspaces: vec![
            WorkspaceRecord {
                id: "chat-1".to_string(),
                name: "Ad-hoc 1".to_string(),
                path: "/tmp/c1".to_string(),
                one_off_chat: true,
                archived: false,
                created_at: 1,
                last_opened_at: 1,
                ..Default::default()
            },
            WorkspaceRecord {
                id: "ws-1".to_string(),
                name: "Project Alpha".to_string(),
                path: "/tmp/alpha".to_string(),
                one_off_chat: false,
                archived: false,
                created_at: 2,
                last_opened_at: 2,
                ..Default::default()
            },
            WorkspaceRecord {
                id: "chat-2".to_string(),
                name: "Ad-hoc 2".to_string(),
                path: "/tmp/c2".to_string(),
                one_off_chat: true,
                archived: false,
                created_at: 3,
                last_opened_at: 3,
                ..Default::default()
            },
            WorkspaceRecord {
                id: "ws-arch".to_string(),
                name: "Archived".to_string(),
                path: "/tmp/arch".to_string(),
                one_off_chat: false,
                archived: true,
                created_at: 4,
                last_opened_at: 4,
                ..Default::default()
            },
        ],
        ..Default::default()
    };

    let targets = management_targets(&state);
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].id, "ws-1");
    assert!(!targets[0].is_chats);
    assert_eq!(targets[1].id, "chat-1");
    assert_eq!(targets[1].label, "Chats");
    assert!(targets[1].is_chats);
}

#[test]
fn entity_icon_helpers_produce_stable_initials_and_buckets() {
    assert_eq!(name_initials("OpenAI"), "O");
    assert_eq!(name_initials("openai-codex"), "OC");
    assert_eq!(name_initials("LM Studio Local"), "LS");
    assert_eq!(name_initials("---"), "?");

    let idx = entity_palette_index("anthropic");
    assert!(idx < 5);
    assert_eq!(idx, entity_palette_index("anthropic"));
}

#[test]
fn known_feature_flags_match_expected_defaults_and_keys() {
    let mut state = AppState::default();
    let remote = KNOWN_FEATURE_FLAGS
        .iter()
        .find(|f| f.id == "remoteAccess")
        .expect("remoteAccess flag must exist");
    assert!(!resolve_flag_enabled(&state, remote));

    state.dispatch(Action::Settings(SettingsAction::SetFeatureFlag {
        flag_id: "remoteAccess".to_string(),
        enabled: true,
    }));
    assert!(resolve_flag_enabled(&state, remote));

    assert_eq!(page_key(SettingsPageId::Providers), "models");
    assert_eq!(page_key(SettingsPageId::Developer), "diagnostics");
    assert!(is_flag_enabled(&state, "menuBar"));
    assert!(is_flag_enabled(&state, "remoteAccess"));
}

#[test]
fn desktop_shortcut_formatter_handles_modifiers_and_defaults() {
    let formatted = format_quick_chat_shortcut_label(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
    if cfg!(target_os = "macos") {
        assert_eq!(formatted, "⌘ ⇧ Space");
    } else {
        assert_eq!(formatted, "Ctrl+Shift+Space");
    }
    assert_eq!(format_quick_chat_shortcut_label(""), "Unset");
}

#[test]
fn usage_formatting_and_aggregation_sum_threads_and_fallback_summary() {
    assert_eq!(format_token_count(850), "850");
    assert_eq!(format_token_count(1_500), "1.50K");
    assert_eq!(format_token_count(24_500), "24.5K");
    assert_eq!(format_token_count(2_500_000), "2.5M");
    assert_eq!(format_estimated_cost(None), "—");
    assert_eq!(format_estimated_cost(Some(0.0042)), "$0.0042");
    assert_eq!(format_estimated_cost(Some(1.5)), "$1.50");

    let mut state = AppState {
        usage_summary: Some(UsageSummary {
            input_tokens: 1_000,
            output_tokens: 500,
            cached_tokens: 200,
            estimated_cost_usd: 0.12,
            ..Default::default()
        }),
        ..Default::default()
    };
    let fallback = aggregate_usage(&state);
    assert!(fallback.has_usage);
    assert_eq!(fallback.total_tokens(), 1_500);
    assert_eq!(fallback.total_sessions, 1);

    state.threads.push(ThreadRecord {
        id: "t1".to_string(),
        workspace_id: "ws1".to_string(),
        title: "Build UI".to_string(),
        provider: Some("anthropic".to_string()),
        model: Some("claude-sonnet-4-5".to_string()),
        ..Default::default()
    });
    state.threads.push(ThreadRecord {
        id: "t2".to_string(),
        workspace_id: "ws1".to_string(),
        title: "Write tests".to_string(),
        provider: Some("openai".to_string()),
        model: Some("gpt-5".to_string()),
        ..Default::default()
    });
    state.thread_runtime_by_id.insert(
        "t1".to_string(),
        ThreadRuntime {
            usage: Some(UsageSummary {
                input_tokens: 2_000,
                output_tokens: 1_000,
                cached_tokens: 300,
                estimated_cost_usd: 0.25,
                ..Default::default()
            }),
            ..Default::default()
        },
    );
    state.thread_runtime_by_id.insert(
        "t2".to_string(),
        ThreadRuntime {
            usage: Some(UsageSummary {
                input_tokens: 4_000,
                output_tokens: 2_000,
                cached_tokens: 0,
                estimated_cost_usd: 0.50,
                ..Default::default()
            }),
            ..Default::default()
        },
    );

    let agg = aggregate_usage(&state);
    assert_eq!(agg.total_sessions, 2);
    assert_eq!(agg.total_tokens(), 9_000);
    assert_eq!(agg.providers.len(), 2);
    assert_eq!(agg.providers[0].provider, "openai");
    assert_eq!(agg.providers[1].provider, "anthropic");
    assert_eq!(agg.total_models(), 2);
}

#[test]
fn packaged_builds_force_remote_access_off_and_ignore_flag_overrides() {
    let mut state = AppState {
        is_packaged: true,
        ..Default::default()
    };
    state.feature_flags.insert("remoteAccess".to_string(), true);
    state
        .feature_flags
        .insert("workspacePicker".to_string(), false);

    assert!(!is_flag_enabled(&state, "remoteAccess"));
    assert!(is_flag_enabled(&state, "workspacePicker"));

    let remote = KNOWN_FEATURE_FLAGS
        .iter()
        .find(|flag| flag.id == "remoteAccess")
        .expect("remoteAccess metadata");
    assert!(!resolve_flag_enabled(&state, remote));

    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::RemoteAccess,
    ))));
    assert_eq!(resolve_active_page(&state), SettingsPageId::Models);
    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Experiments,
    ))));
    assert_eq!(resolve_active_page(&state), SettingsPageId::Models);
}

#[test]
fn release_link_policy_restricts_to_safe_schemes() {
    assert!(is_allowed_release_link("https://example.com/releases/v1.0"));
    assert!(is_allowed_release_link("http://example.com/changelog"));
    assert!(is_allowed_release_link("mailto:support@example.com"));

    assert!(!is_allowed_release_link("javascript:alert(1)"));
    assert!(!is_allowed_release_link("file:///etc/passwd"));
    assert!(!is_allowed_release_link(
        "data:text/html,<script>alert(1)</script>"
    ));
    assert!(!is_allowed_release_link("not a url"));
}

#[test]
fn privacy_patch_clears_payloads_when_trace_telemetry_disables() {
    let active = PrivacyTelemetrySettings {
        crash_reports_enabled: true,
        product_analytics_enabled: false,
        ai_trace_telemetry_enabled: true,
        ai_trace_payloads_enabled: true,
        diagnostics_upload_enabled: false,
        cloud_sync_enabled: false,
    };
    let cleared = apply_privacy_patch(&active, |next| {
        next.ai_trace_telemetry_enabled = false;
    });
    assert!(!cleared.ai_trace_telemetry_enabled);
    assert!(!cleared.ai_trace_payloads_enabled);
}

#[test]
fn shortcut_roundtrip_and_byte_formatting() {
    let default_parsed = parse_quick_chat_accelerator(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR)
        .expect("default shortcut parses");
    assert_eq!(
        shortcut_to_accelerator(&default_parsed),
        DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR
    );
    assert!(parse_quick_chat_accelerator("Option+Space").is_some());
    assert!(parse_quick_chat_accelerator("").is_none());

    assert_eq!(format_byte_size(512), "512 B");
    assert_eq!(format_byte_size(2048), "2.0 KB");
    assert_eq!(format_byte_size(3 * 1024 * 1024), "3.0 MB");
}

#[test]
fn mcp_draft_parsing_validation_and_roundtrip() {
    let args = parse_args_line(r#"-y "@modelcontextprotocol/server-fs" '/tmp/my dir' --flag=1"#)
        .expect("quoted args parse cleanly");
    assert_eq!(
        args,
        vec![
            "-y",
            "@modelcontextprotocol/server-fs",
            "/tmp/my dir",
            "--flag=1"
        ]
    );

    let unclosed = parse_args_line("--path \"unterminated").expect_err("unclosed quote rejected");
    assert_eq!(unclosed.field, "args");

    let env = parse_env_lines("# comment\nAPI_KEY = abc123\nEMPTY=\n").expect("env lines valid");
    assert_eq!(env.get("API_KEY").map(String::as_str), Some("abc123"));
    assert_eq!(env.get("EMPTY").map(String::as_str), Some(""));

    assert!(parse_env_lines("INVALID_LINE").is_err());

    let headers = parse_header_lines("Authorization: Bearer tok\nX-Custom: val:1")
        .expect("header lines valid");
    assert_eq!(
        headers.get("Authorization").map(String::as_str),
        Some("Bearer tok")
    );
    assert_eq!(headers.get("X-Custom").map(String::as_str), Some("val:1"));
    assert!(parse_header_lines("Bad Header: foo").is_err());

    let stdio_draft = McpDraftInput {
        name: "fs_local".to_string(),
        transport: "stdio".to_string(),
        enabled: true,
        command: "npx".to_string(),
        args: r#"-y "@scope/pkg" "/tmp/with space""#.to_string(),
        url: String::new(),
        env_lines: "TOKEN=secret".to_string(),
        header_lines: String::new(),
    };
    let (name, config) = build_mcp_server_config(&stdio_draft).expect("stdio config validates");
    assert_eq!(name, "fs_local");
    assert_eq!(config["transport"]["type"], "stdio");
    assert_eq!(config["transport"]["command"], "npx");
    assert_eq!(config["transport"]["args"][2], "/tmp/with space");
    assert_eq!(config["transport"]["env"]["TOKEN"], "secret");

    let summary = McpServerSummary {
        name: name.clone(),
        enabled: true,
        transport: "stdio".to_string(),
        config,
        ..Default::default()
    };
    let roundtrip = draft_from_summary(&summary);
    assert_eq!(roundtrip.command, "npx");
    assert_eq!(roundtrip.env_lines, "TOKEN=secret");
    assert_eq!(
        parse_args_line(&roundtrip.args).expect("roundtripped args re-parse"),
        vec!["-y", "@scope/pkg", "/tmp/with space"]
    );

    let bad_http = McpDraftInput {
        name: "remote".to_string(),
        transport: "http".to_string(),
        url: "ftp://example.com/mcp".to_string(),
        ..Default::default()
    };
    let err = build_mcp_server_config(&bad_http).expect_err("non-http scheme rejected");
    assert_eq!(err.field, "url");

    let good_http = McpDraftInput {
        name: "remote_api".to_string(),
        transport: "http".to_string(),
        enabled: false,
        url: "https://mcp.example.com/sse".to_string(),
        header_lines: "Authorization: Bearer tok".to_string(),
        ..Default::default()
    };
    let (_, http_cfg) = build_mcp_server_config(&good_http).expect("https config validates");
    assert_eq!(http_cfg["transport"]["type"], "http");
    assert_eq!(http_cfg["transport"]["url"], "https://mcp.example.com/sse");
    assert_eq!(
        http_cfg["transport"]["headers"]["Authorization"],
        "Bearer tok"
    );
    assert_eq!(http_cfg["enabled"], false);
}

#[test]
fn providers_utils_sorting_filtering_and_status_badges() {
    let custom = ProviderSummary {
        id: "custom-llm".to_string(),
        name: "Custom Proxy".to_string(),
        configured: true,
        models: vec![ProviderModelSummary {
            id: "my-fast-model".to_string(),
            name: "Fast Model".to_string(),
            enabled: true,
            ..Default::default()
        }],
        ..Default::default()
    };
    let openai = ProviderSummary {
        id: "openai".to_string(),
        name: "OpenAI".to_string(),
        configured: false,
        ..Default::default()
    };
    let anthropic = ProviderSummary {
        id: "anthropic".to_string(),
        name: "Anthropic".to_string(),
        configured: true,
        ..Default::default()
    };
    let list = vec![custom.clone(), openai.clone(), anthropic.clone()];
    let statuses = vec![ProviderStatusSummary {
        provider: "openai".to_string(),
        healthy: true,
        connected: true,
        ..Default::default()
    }];

    // Connected ranks first (openai), then configured built-in before custom (anthropic before custom-llm).
    let sorted = sort_and_filter_providers(&list, &statuses, "");
    let ids: Vec<&str> = sorted.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["openai", "anthropic", "custom-llm"]);

    // Query filters by nested model id/name too.
    let filtered = sort_and_filter_providers(&list, &statuses, "fast-model");
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, "custom-llm");

    assert_eq!(
        provider_status_badge(&openai, statuses.first()),
        ("Connected", StatusTone::Success)
    );
    let warn_status = ProviderStatusSummary {
        provider: "anthropic".to_string(),
        healthy: false,
        connected: false,
        detail: Some("API key expired".to_string()),
        ..Default::default()
    };
    assert_eq!(
        provider_status_badge(&anthropic, Some(&warn_status)),
        ("Needs attention", StatusTone::Warning)
    );
    assert_eq!(
        provider_status_badge(&openai, None),
        ("Not configured", StatusTone::Neutral)
    );

    let hint = extract_rate_limit_hint(Some(&serde_json::json!({
        "remainingRequests": 18,
        "limitRequests": 60
    })));
    assert_eq!(hint.as_deref(), Some("18 / 60 requests remaining"));
}

#[test]
fn remote_access_permissions_parse_and_update_json_and_csv() {
    let parsed_json =
        parse_phone_permissions(r#"{"conversations":true,"turns":false,"backups":true}"#);
    assert!(parsed_json.contains("conversations"));
    assert!(parsed_json.contains("backups"));
    assert!(!parsed_json.contains("turns"));

    let updated_json =
        update_phone_permission_string(r#"{"conversations":true,"turns":false}"#, "turns", true);
    let reparsed = parse_phone_permissions(&updated_json);
    assert!(reparsed.contains("conversations"));
    assert!(reparsed.contains("turns"));

    let parsed_csv = parse_phone_permissions("conversations, serverRequests; backups");
    assert!(parsed_csv.contains("conversations"));
    assert!(parsed_csv.contains("serverRequests"));
    assert!(parsed_csv.contains("backups"));
    let updated_csv = update_phone_permission_string("conversations,turns", "turns", false);
    assert_eq!(updated_csv, "conversations");

    // Empty non-JSON disable falls back to `"none"` so `native::remote_access` accepts the patch.
    assert_eq!(
        update_phone_permission_string("conversations", "conversations", false),
        "none"
    );
    assert!(parse_phone_permissions("none").is_empty());
    assert!(parse_phone_permissions("read-only").is_empty());
    assert_eq!(parse_phone_permissions("all").len(), 7);
    assert_eq!(
        update_phone_permission_string("none", "turns", true),
        "turns"
    );

    let from_empty = update_phone_permission_string("", "backups", true);
    let reparsed_empty = parse_phone_permissions(&from_empty);
    assert!(reparsed_empty.contains("backups"));
    assert!(!reparsed_empty.contains("turns"));
}

#[test]
fn providers_and_manage_models_helpers_filter_and_detect_connection() {
    let defaults = fallback_providers();
    assert!(defaults.iter().any(|p| p.id == "anthropic"));
    assert!(defaults.iter().any(|p| p.id == "lmstudio"));

    let lm = ProviderSummary {
        id: "lmstudio".to_string(),
        name: "LM Studio".to_string(),
        configured: true,
        ..Default::default()
    };
    let healthy = ProviderStatusSummary {
        provider: "lmstudio".to_string(),
        healthy: true,
        connected: true,
        ..Default::default()
    };
    let ws_disabled = WorkspaceRecord {
        id: "ws-1".to_string(),
        defaults: serde_json::json!({ "lmStudioEnabled": false }),
        ..Default::default()
    };
    let ws_enabled = WorkspaceRecord {
        id: "ws-1".to_string(),
        defaults: serde_json::json!({ "lmStudioEnabled": true }),
        ..Default::default()
    };
    assert!(!is_provider_connected(
        &lm,
        Some(&healthy),
        Some(&ws_disabled)
    ));
    assert!(is_provider_connected(
        &lm,
        Some(&healthy),
        Some(&ws_enabled)
    ));

    let mut models = Vec::new();
    for i in 0..10 {
        models.push(ProviderModelSummary {
            id: format!("model-{i}"),
            name: if i == 2 {
                "Claude Sonnet".to_string()
            } else {
                String::new()
            },
            enabled: i != 0,
            ..Default::default()
        });
    }
    let filtered = filter_provider_models(&models, "sonnet");
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, "model-2");

    let (preview, overflow) = provider_model_preview(&models);
    assert_eq!(preview.len(), 8);
    assert_eq!(overflow, 1);

    assert!(can_add_custom_model("openrouter"));
    assert!(!can_add_custom_model("codex-cli"));
}

#[test]
fn chats_import_source_params_match_server_schema() {
    let mut state = AppState::default();
    state.settings_ui.import_selected_sources.clear();
    state
        .settings_ui
        .import_selected_sources
        .insert("codex".to_string());
    state
        .settings_ui
        .import_selected_sources
        .insert("chatgpt".to_string());

    let default_params = build_import_source_params(&state);
    assert_eq!(default_params["includeCodex"], serde_json::json!(true));
    assert_eq!(
        default_params["includeClaudeCode"],
        serde_json::json!(false)
    );
    assert_eq!(default_params["includeCowork"], serde_json::json!(false));
    assert!(default_params.get("coworkPath").is_none());
    assert!(default_params.get("sources").is_none());

    state
        .settings_ui
        .import_selected_sources
        .insert("cowork".to_string());
    state.settings_ui.import_path_edit = rune::TextEdit::new("/tmp/alt-cowork");
    let path_params = build_import_source_params(&state);
    let sources = path_params["sources"]
        .as_array()
        .expect("sources array emitted when alternate cowork path provided");
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0], serde_json::json!({ "source": "codex" }));
    assert_eq!(
        sources[1],
        serde_json::json!({ "source": "cowork", "path": "/tmp/alt-cowork" })
    );
    assert!(path_params.get("coworkPath").is_none());
}

#[test]
fn developer_libreoffice_and_overflow_config_parse_runtime_shapes() {
    let nested = serde_json::json!({
        "status": {
            "status": "available",
            "version": "24.8.3",
            "resolvedPath": "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            "message": "Ready"
        }
    });
    let (avail, detail) = parse_libreoffice_status(&nested);
    assert_eq!(avail, Some(true));
    let detail_str = detail.expect("formatted LibreOffice detail");
    assert!(detail_str.contains("24.8.3"));
    assert!(detail_str.contains("soffice"));

    let missing = serde_json::json!({ "status": "missing", "message": "soffice not found" });
    assert_eq!(
        parse_libreoffice_status(&missing),
        (Some(false), Some("soffice not found".to_string()))
    );

    let ws_explicit = WorkspaceRecord {
        id: "ws-1".to_string(),
        defaults: serde_json::json!({ "defaultToolOutputOverflowChars": 12000 }),
        ..Default::default()
    };
    let rt_inherited = crate::state::WorkspaceRuntime {
        control_session_config: Some(serde_json::json!({ "toolOutputOverflowChars": 48000 })),
        ..Default::default()
    };
    assert_eq!(
        resolve_workspace_overflow_config(Some(&ws_explicit), Some(&rt_inherited)),
        (true, false, false, 12000)
    );
    assert_eq!(
        resolve_workspace_overflow_config(None, Some(&rt_inherited)),
        (true, true, false, 48000)
    );

    let ws_disabled = WorkspaceRecord {
        id: "ws-2".to_string(),
        defaults: serde_json::json!({ "defaultToolOutputOverflowChars": null }),
        ..Default::default()
    };
    assert_eq!(
        resolve_workspace_overflow_config(Some(&ws_disabled), Some(&rt_inherited)),
        (false, false, false, 48000)
    );
}

#[test]
fn slice5_workspace_subagent_and_memory_helpers_match_server_contracts() {
    use crate::views::settings::memory::{
        HOT_MEMORY_ID, build_advanced_memory_payload, resolve_draft_memory_id, resolve_user_profile,
    };
    use crate::views::settings::subagents::{
        clamp_workflow_concurrency, model_supports_reasoning, profile_id_from_name,
    };
    use crate::views::settings::workspaces::resolve_workspace_tool_calling;

    let ws = WorkspaceRecord {
        id: "ws-1".to_string(),
        user_name: Some("Maya".to_string()),
        user_profile: Some(serde_json::json!({
            "work": "Staff Engineer",
            "instructions": "Be concise",
            "details": "Prefers Rust"
        })),
        defaults: serde_json::json!({
            "defaultToolCalling": {
                "deferredToolSearch": true,
                "codeMode": false,
                "strategy": "native"
            }
        }),
        ..Default::default()
    };
    let tc = resolve_workspace_tool_calling(&ws, None);
    assert!(tc.deferred_tool_search);
    assert!(!tc.code_mode);
    assert_eq!(tc.strategy, "native");

    assert_eq!(
        resolve_user_profile(&ws),
        (
            "Maya".to_string(),
            "Staff Engineer".to_string(),
            "Be concise".to_string(),
            "Prefers Rust".to_string(),
        )
    );

    assert_eq!(clamp_workflow_concurrency("0", 12), 1);
    assert_eq!(clamp_workflow_concurrency("99", 12), 16);
    assert_eq!(clamp_workflow_concurrency("bad", 8), 8);
    assert_eq!(
        profile_id_from_name("  Code Reviewer!! 2  "),
        "code-reviewer-2"
    );
    assert!(model_supports_reasoning("openai:gpt-5"));
    assert!(model_supports_reasoning("codex-cli:gpt-5-codex"));
    assert!(!model_supports_reasoning("anthropic:claude-sonnet-4-5"));

    assert_eq!(resolve_draft_memory_id("   "), HOT_MEMORY_ID);
    assert_eq!(resolve_draft_memory_id("build-notes"), "build-notes");
    assert_eq!(
        build_advanced_memory_payload(None, " Build Notes ", " Short ", "project", " Use bun "),
        serde_json::json!({
            "name": "Build Notes",
            "description": "Short",
            "type": "project",
            "body": "Use bun"
        })
    );
}

#[test]
fn slice6_tool_access_mcp_connectors_and_search_helpers() {
    use crate::state::McpServerSummary;
    use crate::views::settings::connectors::{
        filter_connectors, parse_connectors, safe_external_url,
    };
    use crate::views::settings::mcp_servers::{
        auth_mode_label, compare_mcp_servers, editable_source, format_connection_line,
        server_needs_oauth, source_label,
    };
    use crate::views::settings::state::ToolAccessTab;
    use crate::views::settings::tool_access::{
        parse_marketplaces, patch_codex_search_mode, patch_local_search_fallback,
        patch_search_provider, plugin_install_params, skill_install_params,
        workspace_codex_search_mode, workspace_local_search_fallback, workspace_search_provider,
    };

    assert_eq!(
        ToolAccessTab::from_id("mcp", false),
        ToolAccessTab::McpServers
    );
    assert_eq!(
        ToolAccessTab::from_id("connectors", false),
        ToolAccessTab::Plugins
    );
    assert_eq!(
        ToolAccessTab::from_id("connectors", true),
        ToolAccessTab::Connectors
    );
    assert_eq!(
        ToolAccessTab::from_id("search", false),
        ToolAccessTab::Search
    );

    assert_eq!(
        safe_external_url(Some("https://chatgpt.com/apps")),
        Some("https://chatgpt.com/apps".to_string())
    );
    assert_eq!(safe_external_url(Some("javascript:alert(1)")), None);
    assert_eq!(safe_external_url(Some("file:///etc/passwd")), None);

    let items = parse_connectors(&[
        serde_json::json!({
            "id": "conn-1",
            "name": "GitHub",
            "description": "Repos",
            "isAccessible": true,
            "isEnabled": true,
            "installUrl": "https://chatgpt.com/g/github"
        }),
        serde_json::json!({
            "id": "conn-2",
            "name": "Slack",
            "isAccessible": false,
            "isEnabled": false,
            "installUrl": "javascript:void(0)"
        }),
    ]);
    assert_eq!(items.len(), 2);
    assert!(items[0].install_url.is_some());
    assert!(items[1].install_url.is_none());
    assert_eq!(filter_connectors(&items, "git", false).len(), 1);
    assert_eq!(filter_connectors(&items, "", true).len(), 1);

    let srv_user = McpServerSummary {
        name: "zeta".to_string(),
        enabled: true,
        transport: "http".to_string(),
        source: Some("user".to_string()),
        auth_status: Some("oauth_pending".to_string()),
        config: serde_json::json!({
            "transport": { "type": "http", "url": "https://mcp.example.com" },
            "auth": { "type": "oauth" }
        }),
        ..Default::default()
    };
    let srv_plugin = McpServerSummary {
        name: "alpha".to_string(),
        enabled: true,
        transport: "stdio".to_string(),
        source: Some("plugin".to_string()),
        config: serde_json::json!({
            "transport": { "type": "stdio", "command": "npx", "args": ["-y", "demo"] }
        }),
        ..Default::default()
    };
    assert_eq!(
        compare_mcp_servers(&srv_user, &srv_plugin),
        std::cmp::Ordering::Less
    );
    assert_eq!(source_label(srv_user.source.as_deref()), "All projects");
    assert_eq!(editable_source(srv_user.source.as_deref()), Some("user"));
    assert_eq!(editable_source(srv_plugin.source.as_deref()), None);
    assert_eq!(format_connection_line(&srv_user), "https://mcp.example.com");
    assert_eq!(format_connection_line(&srv_plugin), "npx -y demo");
    assert_eq!(auth_mode_label(&srv_user), "OAuth sign-in pending");
    assert!(server_needs_oauth(&srv_user));

    let opts = serde_json::json!({
        "openai": { "reasoningEffort": "high" },
        "codex-cli": { "webSearchBackend": "native" },
        "google": { "nativeWebSearch": false }
    });
    assert_eq!(workspace_search_provider(Some(&opts)), "exa");
    let patched = patch_search_provider(Some(&opts), "parallel");
    assert_eq!(workspace_search_provider(Some(&patched)), "parallel");
    assert_eq!(
        patched.pointer("/openai/reasoningEffort"),
        Some(&serde_json::json!("high"))
    );
    assert_eq!(
        patched.pointer("/google/nativeWebSearch"),
        Some(&serde_json::json!(false))
    );
    let fb_patched = patch_local_search_fallback(Some(&patched), "parallel");
    assert_eq!(
        workspace_local_search_fallback(Some(&fb_patched)),
        "parallel"
    );
    let mode_patched = patch_codex_search_mode(Some(&fb_patched), "live");
    assert_eq!(workspace_codex_search_mode(Some(&mode_patched)), "live");

    assert_eq!(
        plugin_install_params(" owner/repo ", "workspace"),
        serde_json::json!({ "sourceInput": "owner/repo", "targetScope": "workspace" })
    );
    assert_eq!(
        skill_install_params(" owner/skill ", "project"),
        serde_json::json!({ "sourceInput": "owner/skill", "targetScope": "project" })
    );
    let mkts = parse_marketplaces(&[serde_json::json!({
        "id": "m1",
        "repo": "acme/tools",
        "displayName": "Acme Catalog",
        "pluginCount": 4,
        "skillCount": 9
    })]);
    assert_eq!(mkts.len(), 1);
    assert_eq!(mkts[0].display_name, "Acme Catalog");
}

#[test]
fn review_90_mcp_preserves_auth_extras_and_skills_catalog_gates_mutations() {
    use crate::state::{AppState, McpServerSummary};
    use crate::views::settings::mcp_server_draft::{
        build_mcp_server_config_with_extras, draft_extras_from_summary, draft_from_summary,
    };
    use crate::views::settings::mcp_servers::{
        effective_source, server_error_message, transport_kind_of,
    };
    use crate::views::settings::tool_access::collect_visible_skill_rows;

    let oauth_srv = McpServerSummary {
        name: "linear".to_string(),
        enabled: true,
        transport: "stdio".to_string(),
        source: Some("workspace".to_string()),
        config: serde_json::json!({
            "name": "linear",
            "source": "user",
            "icon": "https://linear.app/favicon.ico",
            "required": true,
            "retries": 2,
            "authMode": "error",
            "authMessage": "OAuth refresh failed",
            "transport": { "type": "http", "url": "https://mcp.linear.app/mcp" },
            "auth": {
                "type": "oauth",
                "scope": "read write",
                "resource": "https://api.linear.app",
                "oauthMode": "code"
            }
        }),
        ..Default::default()
    };
    assert_eq!(effective_source(&oauth_srv), "user");
    assert_eq!(transport_kind_of(&oauth_srv), "http");
    assert_eq!(
        server_error_message(&oauth_srv),
        Some("OAuth refresh failed")
    );

    let draft = draft_from_summary(&oauth_srv);
    let extras = draft_extras_from_summary(&oauth_srv);
    let (_, rebuilt) =
        build_mcp_server_config_with_extras(&draft, &extras, Some(&oauth_srv.config))
            .expect("rebuilt oauth mcp config validates");
    assert_eq!(rebuilt["required"], serde_json::json!(true));
    assert_eq!(rebuilt["retries"], serde_json::json!(2));
    assert_eq!(
        rebuilt["icon"],
        serde_json::json!("https://linear.app/favicon.ico")
    );
    assert_eq!(rebuilt["auth"]["type"], serde_json::json!("oauth"));
    assert_eq!(rebuilt["auth"]["scope"], serde_json::json!("read write"));
    assert_eq!(rebuilt["auth"]["oauthMode"], serde_json::json!("code"));

    let stdio_srv = McpServerSummary {
        name: "local-fs".to_string(),
        enabled: true,
        transport: "stdio".to_string(),
        config: serde_json::json!({
            "transport": { "type": "stdio", "command": "npx", "cwd": "/tmp/work" }
        }),
        ..Default::default()
    };
    let stdio_draft = draft_from_summary(&stdio_srv);
    let stdio_extras = draft_extras_from_summary(&stdio_srv);
    let (_, stdio_rebuilt) =
        build_mcp_server_config_with_extras(&stdio_draft, &stdio_extras, Some(&stdio_srv.config))
            .expect("rebuilt stdio cwd validates");
    assert_eq!(
        stdio_rebuilt["transport"]["cwd"],
        serde_json::json!("/tmp/work")
    );

    let state = AppState {
        skill_installations: vec![
            serde_json::json!({
                "installationId": "inst-disabled",
                "name": "disabled-skill",
                "description": "Kept visible when disabled",
                "scope": "global",
                "enabled": false,
                "writable": true,
                "state": "disabled"
            }),
            serde_json::json!({
                "installationId": "inst-shadowed",
                "name": "same-name",
                "description": "Global copy shadowed by project",
                "scope": "global",
                "enabled": true,
                "writable": true,
                "state": "shadowed",
                "shadowedByScope": "project"
            }),
            serde_json::json!({
                "installationId": "inst-project",
                "name": "same-name",
                "description": "Project copy",
                "scope": "project",
                "enabled": true,
                "writable": true,
                "state": "effective"
            }),
            serde_json::json!({
                "installationId": "inst-readonly",
                "name": "system-skill",
                "description": "Read-only skill",
                "scope": "built-in",
                "enabled": true,
                "writable": false,
                "state": "effective"
            }),
            serde_json::json!({
                "installationId": "inst-plugin",
                "name": "bundled-skill",
                "description": "Managed by plugin",
                "scope": "user",
                "enabled": true,
                "writable": false,
                "state": "effective",
                "plugin": { "pluginId": "p1", "displayName": "My Plugin" }
            }),
        ],
        ..Default::default()
    };

    let rows = collect_visible_skill_rows(&state);
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|r| r.name != "bundled-skill"));
    assert!(
        rows.iter()
            .any(|r| r.installation_id.as_deref() == Some("inst-disabled") && r.state == "disabled")
    );
    assert!(
        rows.iter()
            .any(|r| r.installation_id.as_deref() == Some("inst-shadowed") && r.state == "shadowed")
    );
    let ro = rows
        .iter()
        .find(|r| r.installation_id.as_deref() == Some("inst-readonly"))
        .expect("readonly row present");
    assert!(!ro.can_toggle());
    assert!(!ro.can_delete());
}

#[test]
fn models_page_selects_expose_accessible_names_and_desktop_tray_label_mentions_linux() {
    use crate::state::{ProviderModelSummary, ProviderSummary};

    fn render_root(s: &AppState, cx: &mut rune::Cx<AppState>) -> rune::El {
        let (kit, _) = crate::theme::build_kit(false, false, false);
        crate::views::settings::view(s, cx, &kit).content
    }

    let mut state = AppState {
        scene_mode: true,
        active_workspace_id: Some("ws-1".to_string()),
        ..Default::default()
    };
    state.workspaces.push(WorkspaceRecord {
        id: "ws-1".to_string(),
        name: "Demo".to_string(),
        path: "/tmp/demo".to_string(),
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-5.4".to_string()),
        default_preferred_child_model: Some("gpt-5.4".to_string()),
        ..Default::default()
    });
    state.provider_catalog.push(ProviderSummary {
        id: "openai".to_string(),
        name: "OpenAI".to_string(),
        configured: true,
        models: vec![ProviderModelSummary {
            id: "gpt-5.4".to_string(),
            name: "GPT-5.4".to_string(),
            enabled: true,
            ..Default::default()
        }],
        ..Default::default()
    });
    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Models,
    ))));

    let mut rt = rune::Runtime::new(
        state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt.frame(0.0);

    let els = rt.elements();
    let comboboxes: Vec<_> = els.iter().filter(|e| e.role == "combobox").collect();
    assert!(
        comboboxes.len() >= 4,
        "expected 4 Models dropdown triggers, saw {}",
        comboboxes.len()
    );
    for cb in &comboboxes {
        assert!(
            cb.label.as_deref().is_some_and(|l| !l.trim().is_empty()),
            "every combobox on Settings -> Models must have a non-empty a11y label: {cb:?}"
        );
    }
    for key in [
        "models-default-provider-trigger",
        "models-default-model-trigger",
        "models-subagent-source-trigger",
        "models-subagent-preferred-trigger",
    ] {
        assert!(
            comboboxes.iter().any(|e| {
                e.key.as_deref() == Some(key)
                    && e.label.as_deref().is_some_and(|l| !l.trim().is_empty())
            }),
            "expected named combobox `{key}` on Settings -> Models"
        );
    }

    let mut desktop_state = AppState {
        scene_mode: true,
        ..Default::default()
    };
    desktop_state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Desktop,
    ))));
    let mut rt_desktop = rune::Runtime::new(
        desktop_state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_desktop.frame(0.0);
    assert!(
        rt_desktop.elements().iter().any(|e| {
            e.text
                .as_deref()
                .is_some_and(|t| t.contains("Windows/Linux system tray"))
                || e.label
                    .as_deref()
                    .is_some_and(|l| l.contains("Windows/Linux system tray"))
        }),
        "Settings -> Desktop Quick Chat tray description must mention Windows/Linux system tray"
    );
}
