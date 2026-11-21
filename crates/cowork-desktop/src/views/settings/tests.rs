//! Unit tests for Settings navigation, gating, target resolution, and primitives.

use super::conversation_import::build_import_source_params;
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
use super::updates::{is_allowed_release_link, updater_status_meta};
use super::usage::{aggregate_usage, format_estimated_cost, format_token_count};
use crate::actions::{Action, NativeCommand, NavAction, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::{
    AppState, DesktopPlatformOverride, McpServerSummary, PrivacyTelemetrySettings,
    ProviderModelSummary, ProviderStatusSummary, ProviderSummary, ThreadRecord, ThreadRuntime,
    UpdaterState, UsageSummary, WorkspaceRecord,
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
        let (kit, _) = crate::theme::build_kit_with_accent(
            false,
            false,
            false,
            s.desktop_settings.accent_palette,
        );
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

#[test]
fn updater_status_meta_maps_disabled_by_packaging_mode() {
    assert_eq!(
        updater_status_meta("disabled", false),
        ("Not available in dev mode", StatusTone::Neutral)
    );
    assert_eq!(
        updater_status_meta("disabled", true),
        ("Unavailable", StatusTone::Neutral)
    );
    assert_eq!(
        updater_status_meta("unavailable", false),
        ("Unavailable", StatusTone::Neutral)
    );
    assert_eq!(
        updater_status_meta("up-to-date", true),
        ("Up to date", StatusTone::Success)
    );
    assert_eq!(
        updater_status_meta("error", true),
        ("Error", StatusTone::Danger)
    );
    assert_eq!(
        updater_status_meta("idle", false),
        ("Idle", StatusTone::Neutral)
    );
    assert_eq!(
        updater_status_meta("", false),
        ("Idle", StatusTone::Neutral)
    );
}

#[test]
fn updates_page_renders_disabled_status_and_disables_check_button() {
    fn render_root(s: &AppState, cx: &mut rune::Cx<AppState>) -> rune::El {
        let (kit, _) = crate::theme::build_kit_with_accent(
            false,
            false,
            false,
            s.desktop_settings.accent_palette,
        );
        crate::views::settings::view(s, cx, &kit).content
    }

    fn has_text(rt: &rune::Runtime<AppState>, needle: &str) -> bool {
        rt.elements().iter().any(|e| {
            e.text.as_deref().is_some_and(|t| t.contains(needle))
                || e.label.as_deref().is_some_and(|l| l.contains(needle))
        })
    }

    fn click_check_btn(rt: &mut rune::Runtime<AppState>) -> bool {
        let els = rt.elements();
        let btn = els
            .iter()
            .find(|e| e.key.as_deref() == Some("updates-check-btn"))
            .expect("updates-check-btn must render on Settings -> Updates");
        let was_focusable = btn.focusable;
        let [cx, cy] = [
            btn.rect[0] + btn.rect[2] * 0.5,
            btn.rect[1] + btn.rect[3] * 0.5,
        ];
        rt.pointer_move(cx, cy);
        rt.pointer_down(cx, cy);
        rt.pointer_up(cx, cy);
        rt.frame(0.0);
        was_focusable
    }

    // 1) Dev mode with status == "disabled" -> "Not available in dev mode" + disabled check action.
    let mut dev_state = AppState {
        scene_mode: true,
        is_packaged: false,
        updater: UpdaterState {
            status: "disabled".to_string(),
            current_version: "1.2.3".to_string(),
            ..UpdaterState::default()
        },
        ..Default::default()
    };
    dev_state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Updates,
    ))));
    let mut rt_dev = rune::Runtime::new(
        dev_state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_dev.frame(0.0);
    assert!(has_text(&rt_dev, "Not available in dev mode"));
    assert!(has_text(
        &rt_dev,
        "This is a development build, so in-app update checks are disabled."
    ));
    assert!(!click_check_btn(&mut rt_dev));
    assert!(
        rt_dev.state.services.emitted_native_commands.is_empty(),
        "disabled Check for updates button must not emit CheckForUpdates in dev mode"
    );

    // 2) Packaged mode (.deb / missing pubkey) with status == "disabled" -> "Unavailable" + disabled check action.
    let mut pkg_disabled_state = AppState {
        scene_mode: true,
        is_packaged: true,
        updater: UpdaterState {
            status: "disabled".to_string(),
            packaged: true,
            current_version: "1.2.3".to_string(),
            ..UpdaterState::default()
        },
        ..Default::default()
    };
    pkg_disabled_state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Updates,
    ))));
    let mut rt_pkg_disabled = rune::Runtime::new(
        pkg_disabled_state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_pkg_disabled.frame(0.0);
    assert!(has_text(&rt_pkg_disabled, "Unavailable"));
    assert!(!has_text(&rt_pkg_disabled, "Not available in dev mode"));
    assert!(has_text(
        &rt_pkg_disabled,
        "Automatic in-app updates are unavailable for this build."
    ));
    assert!(!click_check_btn(&mut rt_pkg_disabled));
    assert!(
        rt_pkg_disabled
            .state
            .services
            .emitted_native_commands
            .is_empty(),
        "disabled Check for updates button must not emit CheckForUpdates in packaged disabled mode"
    );

    // 3) Packaged mode with status == "idle" keeps Check for updates interactive.
    let mut pkg_idle_state = AppState {
        scene_mode: true,
        is_packaged: true,
        updater: UpdaterState {
            status: "idle".to_string(),
            packaged: true,
            current_version: "1.2.3".to_string(),
            ..UpdaterState::default()
        },
        ..Default::default()
    };
    pkg_idle_state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Updates,
    ))));
    let mut rt_pkg_idle = rune::Runtime::new(
        pkg_idle_state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_pkg_idle.frame(0.0);
    assert!(has_text(&rt_pkg_idle, "Idle"));
    assert!(click_check_btn(&mut rt_pkg_idle));
    assert!(
        rt_pkg_idle
            .state
            .services
            .emitted_native_commands
            .iter()
            .any(|cmd| matches!(cmd, NativeCommand::CheckForUpdates)),
        "interactive Check for updates button must emit NativeCommand::CheckForUpdates"
    );

    // 4) Empty current_version on Updates and Developer summary fall back to resolve_desktop_app_version().
    let expected_version = format!(
        "Cowork Desktop v{}",
        crate::native::resolve_desktop_app_version()
    );
    let mut updates_fallback_state = AppState {
        scene_mode: true,
        is_packaged: true,
        ..Default::default()
    };
    updates_fallback_state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Updates,
    ))));
    let mut rt_updates_fallback = rune::Runtime::new(
        updates_fallback_state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_updates_fallback.frame(0.0);
    assert!(
        has_text(&rt_updates_fallback, &expected_version),
        "Settings -> Updates empty current_version must fall back to {expected_version}"
    );

    let mut dev_summary_state = AppState {
        scene_mode: true,
        ..Default::default()
    };
    dev_summary_state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Developer,
    ))));
    let mut rt_dev_summary = rune::Runtime::new(
        dev_summary_state,
        render_root,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_dev_summary.frame(0.0);
    let copy_btn = rt_dev_summary
        .elements()
        .into_iter()
        .find(|e| e.role == "button" && e.label.as_deref() == Some("Copy Diagnostic Summary"))
        .expect("Copy Diagnostic Summary button must render on Settings -> Developer");
    let [dx, dy] = [
        copy_btn.rect[0] + copy_btn.rect[2] * 0.5,
        copy_btn.rect[1] + copy_btn.rect[3] * 0.5,
    ];
    rt_dev_summary.pointer_move(dx, dy);
    rt_dev_summary.pointer_down(dx, dy);
    rt_dev_summary.pointer_up(dx, dy);
    rt_dev_summary.frame(0.0);
    let copied = rt_dev_summary
        .state
        .services
        .emitted_native_commands
        .iter()
        .find_map(|cmd| match cmd {
            NativeCommand::CopyText(text) => Some(text.as_str()),
            _ => None,
        })
        .expect("clicking Copy Diagnostic Summary must emit NativeCommand::CopyText");
    assert!(
        copied.starts_with(&expected_version),
        "Diagnostic summary `{copied}` must start with {expected_version}"
    );
}

#[test]
fn build_layout_and_desktop_accent_picker_behave_cleanly() {
    use crate::theme::{self, AccentPalette};

    fn render_from_layout(s: &AppState, cx: &mut rune::Cx<AppState>) -> rune::El {
        let dark = s.effective_dark(cx.system_dark());
        let (kit, tokens) = theme::build_kit_with_accent(
            dark,
            s.desktop_settings.reduced_transparency,
            s.desktop_settings.high_contrast,
            s.desktop_settings.accent_palette,
        );
        let layout = super::build_layout(s, cx, &kit, &tokens);
        rune::row()
            .w_full()
            .h_full()
            .child(rune::el().w(268.0).h_full().child(layout.sidebar))
            .child(
                rune::col()
                    .grow(1.0)
                    .min_w(0.0)
                    .h_full()
                    .child(rune::row().children(layout.header_actions))
                    .child(layout.main),
            )
    }

    fn render_shell_view(s: &AppState, cx: &mut rune::Cx<AppState>) -> rune::El {
        let (kit, _) =
            theme::build_kit_with_accent(false, false, false, s.desktop_settings.accent_palette);
        super::view(s, cx, &kit).content
    }

    fn make_state(page: SettingsPageId) -> AppState {
        let mut s = AppState {
            scene_mode: true,
            active_workspace_id: Some("ws-1".to_string()),
            ..Default::default()
        };
        s.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Demo".to_string(),
            path: "/tmp/demo".to_string(),
            ..Default::default()
        });
        s.provider_catalog.push(ProviderSummary {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            configured: true,
            ..Default::default()
        });
        s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(page))));
        s
    }

    // Verify narrow-viewport search box fits cleanly without overflowing past pane edges
    // across both standalone `SplitView` and `build_layout`.
    for (label, render_fn) in [
        (
            "build_layout",
            render_from_layout as fn(&AppState, &mut rune::Cx<AppState>) -> rune::El,
        ),
        (
            "settings::view",
            render_shell_view as fn(&AppState, &mut rune::Cx<AppState>) -> rune::El,
        ),
    ] {
        let mut rt_narrow = rune::Runtime::new(
            make_state(SettingsPageId::Models),
            render_fn,
            (640.0, 820.0),
            rune::Env::new(true, 1.0),
        );
        rt_narrow.frame(0.0);
        let narrow_els = rt_narrow.elements();
        assert!(
            narrow_els
                .iter()
                .any(|e| e.key.as_deref() == Some("settings-main-pane")),
            "{label} Models must use key `settings-main-pane`"
        );
        let search_el = narrow_els
            .iter()
            .find(|e| e.label.as_deref() == Some("Filter providers and models"))
            .expect("Providers search input must render");
        assert!(
            search_el.rect[0] >= 268.0 && search_el.rect[0] + search_el.rect[2] <= 640.0 - 16.0,
            "{label} search input rect {:?} overflows 640px narrow viewport",
            search_el.rect
        );
    }

    // Verify Backup keeps the invariant `settings-main-pane` key so pages do not crossfade/ghost.
    let mut rt_backup = rune::Runtime::new(
        make_state(SettingsPageId::Backup),
        render_from_layout,
        (1100.0, 820.0),
        rune::Env::new(true, 1.0),
    );
    rt_backup.frame(0.0);
    assert!(
        rt_backup
            .elements()
            .iter()
            .any(|e| e.key.as_deref() == Some("settings-main-pane")),
        "Backup SettingsLayout.main must preserve invariant key `settings-main-pane`"
    );

    // Verify Desktop Accent color segmented picker updates `desktop_settings.accent_palette`
    // and produces no unlabeled focusable button elements.
    let mut rt_desktop = rune::Runtime::new(
        make_state(SettingsPageId::Desktop),
        render_from_layout,
        (1100.0, 820.0),
        rune::Env::new(true, 1.0),
    );
    rt_desktop.frame(0.0);
    let desktop_els = rt_desktop.elements();
    assert!(
        !desktop_els
            .iter()
            .any(|e| e.focusable && e.role == "button" && e.label.is_none()),
        "Desktop page must not expose unlabeled focusable buttons (e.g. accent swatch dots)"
    );
    let ochre_seg = desktop_els
        .iter()
        .find(|e| {
            e.text.as_deref() == Some("Ochre Amber") || e.label.as_deref() == Some("Ochre Amber")
        })
        .expect("Ochre Amber segment must render on Desktop -> Accent color");
    let [sx, sy] = [
        ochre_seg.rect[0] + ochre_seg.rect[2] * 0.5,
        ochre_seg.rect[1] + ochre_seg.rect[3] * 0.5,
    ];
    rt_desktop.pointer_move(sx, sy);
    rt_desktop.pointer_down(sx, sy);
    rt_desktop.pointer_up(sx, sy);
    rt_desktop.frame(0.0);
    assert_eq!(
        rt_desktop.state.desktop_settings.accent_palette,
        AccentPalette::OchreAmber
    );
    assert!(
        rt_desktop
            .elements()
            .iter()
            .any(|e| e.text.as_deref() == Some(AccentPalette::OchreAmber.description())),
        "Desktop Accent color description must reflect updated palette"
    );

    // Verify Developer bundle actions wrap cleanly inside 1024x768 (no clipping past card border)
    // and section headings use sentence case.
    let mut rt_dev = rune::Runtime::new(
        make_state(SettingsPageId::Developer),
        render_shell_view,
        (1024.0, 768.0),
        rune::Env::new(true, 1.0),
    );
    rt_dev.frame(0.0);
    let dev_els = rt_dev.elements();
    let copy_btn = dev_els
        .iter()
        .find(|e| e.role == "button" && e.label.as_deref() == Some("Copy Diagnostic Summary"))
        .expect("Copy Diagnostic Summary button must render on Developer");
    assert!(
        copy_btn.rect[0] + copy_btn.rect[2] <= 1024.0 - 32.0,
        "Copy Diagnostic Summary {:?} overflows 1024px Developer card",
        copy_btn.rect
    );
    assert!(
        dev_els
            .iter()
            .any(|e| e.text.as_deref() == Some("Diagnostics bundle"))
            && dev_els
                .iter()
                .any(|e| e.text.as_deref() == Some("File explorer")),
        "Developer section headings must use sentence case"
    );

    // Verify Tool Access exposes a single Refresh and single empty-state CTA per tab.
    for tab in [
        super::state::ToolAccessTab::Plugins,
        super::state::ToolAccessTab::Skills,
        super::state::ToolAccessTab::Connectors,
        super::state::ToolAccessTab::Search,
    ] {
        let mut s = make_state(SettingsPageId::ToolAccess);
        s.settings_ui.tool_access_tab = tab;
        let mut rt_ta = rune::Runtime::new(
            s,
            render_shell_view,
            (1100.0, 820.0),
            rune::Env::new(true, 1.0),
        );
        rt_ta.frame(0.0);
        let els = rt_ta.elements();
        let refresh_count = els
            .iter()
            .filter(|e| e.role == "button" && e.label.as_deref() == Some("Refresh"))
            .count();
        assert_eq!(
            refresh_count, 1,
            "Tool Access {:?} tab must render exactly one Refresh button",
            tab
        );
        for cta in ["Install plugin", "Install skill", "Add connector"] {
            let cta_count = els
                .iter()
                .filter(|e| e.role == "button" && e.label.as_deref() == Some(cta))
                .count();
            assert!(
                cta_count <= 1,
                "Tool Access {:?} must not duplicate empty-state CTA `{cta}` ({cta_count})",
                tab
            );
        }
        if tab == super::state::ToolAccessTab::Search {
            assert!(
                els.iter()
                    .any(|e| e.text.as_deref() == Some("Tool providers")),
                "Search tab must use sentence-case heading `Tool providers`"
            );
        }
    }
}

#[test]
fn desktop_show_menu_bar_toggle_visibility_and_action() {
    fn render_desktop(s: &AppState, cx: &mut rune::Cx<AppState>) -> rune::El {
        let (kit, tok) = crate::theme::build_kit_with_accent(
            false,
            false,
            false,
            s.desktop_settings.accent_palette,
        );
        super::build_layout(s, cx, &kit, &tok).main
    }
    let make_desktop_state = |platform: DesktopPlatformOverride| {
        let mut s = AppState {
            scene_mode: true,
            menu_platform_override: Some(platform),
            ..Default::default()
        };
        s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Desktop,
        ))));
        s
    };

    // Hidden on macOS.
    let mut rt_mac = rune::Runtime::new(
        make_desktop_state(DesktopPlatformOverride::MacOs),
        render_desktop,
        (1100.0, 900.0),
        rune::Env::new(true, 1.0),
    );
    rt_mac.frame(0.0);
    assert!(
        !rt_mac.elements().iter().any(|e| {
            e.label.as_deref() == Some("Show menu bar")
                || e.text.as_deref() == Some("Show menu bar")
                || e.text.as_deref() == Some("When off, press Alt or F10 to show it.")
        }),
        "macOS Desktop settings must not show the Linux/Windows menu bar toggle"
    );

    // Visible and interactive on Linux and Windows.
    for platform in [
        DesktopPlatformOverride::Linux,
        DesktopPlatformOverride::Windows,
    ] {
        let mut rt = rune::Runtime::new(
            make_desktop_state(platform),
            render_desktop,
            (1100.0, 900.0),
            rune::Env::new(true, 1.0),
        );
        rt.frame(0.0);
        let els = rt.elements();
        assert!(
            els.iter()
                .any(|e| e.text.as_deref() == Some("When off, press Alt or F10 to show it.")),
            "{platform:?} Desktop settings must render the Show menu bar hint"
        );
        let switch = els
            .iter()
            .find(|e| e.focusable && e.label.as_deref() == Some("Show menu bar"))
            .expect("Show menu bar switch must be present on Linux/Windows");
        let [cx, cy] = [
            switch.rect[0] + switch.rect[2] * 0.5,
            switch.rect[1] + switch.rect[3] * 0.5,
        ];

        assert!(rt.state.desktop_settings.show_menu_bar);
        rt.pointer_move(cx, cy);
        rt.pointer_down(cx, cy);
        rt.pointer_up(cx, cy);
        rt.frame(0.0);
        assert!(
            !rt.state.desktop_settings.show_menu_bar,
            "{platform:?} clicking Show menu bar must disable desktop_settings.show_menu_bar"
        );

        rt.pointer_down(cx, cy);
        rt.pointer_up(cx, cy);
        rt.frame(0.0);
        assert!(
            rt.state.desktop_settings.show_menu_bar,
            "{platform:?} clicking Show menu bar again must re-enable desktop_settings.show_menu_bar"
        );
    }
}

fn conversation_import_fixture() -> AppState {
    let mut s = AppState {
        scene_mode: true,
        workspaces: vec![
            WorkspaceRecord::new("source", "Current", "/current", 1),
            WorkspaceRecord::new("dest", "Destination", "/destination", 1),
        ],
        active_workspace_id: Some("source".into()),
        ..Default::default()
    };
    s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Chats,
    ))));
    super::conversation_import::open(&mut s);
    s
}

fn import_request(s: &AppState, method: &str) -> Option<(u64, serde_json::Value)> {
    s.services
        .emitted_ws_commands
        .iter()
        .rev()
        .find_map(|cmd| match cmd {
            crate::ws::WsCommand::SendRequest {
                method: sent,
                request_id,
                params,
                ..
            } if sent == method => Some((*request_id, params.clone())),
            _ => None,
        })
}

fn import_response(
    s: &mut AppState,
    workspace: &str,
    id: u64,
    method: &str,
    payload: serde_json::Value,
) {
    s.apply_store_event(crate::actions::StoreEvent::WsResponse {
        workspace_id: workspace.into(),
        request_id: id,
        method: method.into(),
        result: Ok(payload),
    });
}

fn preview_seven() -> serde_json::Value {
    serde_json::json!({"conversations": (0..7).map(|i| serde_json::json!({
        "source": "codex", "fingerprint": format!("fp{i}"), "title": format!("Conversation {i}"),
        "mapping": { "status": if i == 0 { "missing" } else { "matched" } },
        "alreadyImportedThreadId": if (2..6).contains(&i) { Some("existing") } else { None },
    })).collect::<Vec<_>>()})
}

#[test]
fn conversation_import_selects_from_all_rows_and_requires_a_valid_destination() {
    use super::conversation_import::{IMPORT, PREVIEW};
    use crate::ws::WsConnectionState;
    use rune::{El, Runtime};

    fn render(s: &AppState, cx: &mut rune::Cx<AppState>) -> El {
        let (kit, _) = crate::theme::build_kit_with_accent(
            false,
            false,
            false,
            s.desktop_settings.accent_palette,
        );
        let out = crate::views::settings::view(s, cx, &kit);
        rune::el()
            .w_full()
            .h_full()
            .child(rune_kit::root(out.content, out.overlays))
    }
    fn click(rt: &mut Runtime<AppState>, key: &str) {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        rt.settle_all();
        rt.frame(0.0);
    }

    let mut s = conversation_import_fixture();
    s.workspace_socket_by_id
        .insert("dest".into(), WsConnectionState::Connected);
    let (old, _) = import_request(&s, PREVIEW).unwrap();
    let mut rt = Runtime::new(s, render, (1100.0, 820.0), rune::Env::new(true, 1.0));
    rt.settle_all();
    rt.frame(0.0);
    click(&mut rt, "import-source-codex");
    import_response(&mut rt.state, "source", old, PREVIEW, preview_seven());
    rt.invalidate();
    rt.frame(0.0);
    assert!(rt.find("import-check-fp0").is_none());
    click(&mut rt, "import-source-codex");
    rt.state
        .dispatch(Action::Settings(SettingsAction::PreviewConversationImport));
    let (id, _) = import_request(&rt.state, PREVIEW).unwrap();
    import_response(&mut rt.state, "source", id, PREVIEW, preview_seven());
    rt.invalidate();
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.role == "checkbox" && e.label.as_deref() == Some("Conversation 6"))
    );
    click(&mut rt, "conversation-import-submit");
    assert!(import_request(&rt.state, IMPORT).is_none());

    click(&mut rt, "import-check-fp1");
    click(&mut rt, "import-map-fp0");
    click(&mut rt, "import-destination-fp0-item1");
    click(&mut rt, "conversation-import-submit");
    let (id, params) = import_request(&rt.state, IMPORT).expect("valid selection should submit");
    assert_eq!(
        params,
        serde_json::json!({
            "includeCodex": true, "includeClaudeCode": true, "includeCowork": false,
            "selected": [{"source":"codex","fingerprint":"fp0"},{"source":"codex","fingerprint":"fp6"}],
            "mappings": {"fp0":{"kind":"fallback","workspaceId":"dest"}}, "mode":"skip-existing"
        })
    );
    let sent = rt.state.services.emitted_ws_commands.len();
    rt.state
        .dispatch(Action::Settings(SettingsAction::ExecuteConversationImport));
    assert_eq!(rt.state.services.emitted_ws_commands.len(), sent);
    import_response(
        &mut rt.state,
        "source",
        id,
        IMPORT,
        serde_json::json!({
            "imported":[{"fingerprint":"fp0","threadId":"new","workspaceId":"dest","workspacePath":"/destination"}],
            "skipped":[], "failed":[{"fingerprint":"fp6","message":"Source file moved"}], "createdWorkspaces":[]
        }),
    );
    assert!(rt.state.services.emitted_ws_commands.iter().any(|cmd| matches!(cmd,
        crate::ws::WsCommand::SendRequest { method, workspace_id, .. } if method == "thread/list" && workspace_id == "dest")));
    rt.invalidate();
    rt.frame(0.0);
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.text.as_deref() == Some("Imported 1, skipped 0, failed 1."))
    );
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.text.as_deref() == Some("Conversation 6 — Source file moved"))
    );
}

#[test]
fn conversation_import_discards_outdated_scans_and_closed_dialog_replies() {
    use super::conversation_import::{IMPORT, PREVIEW};
    let ready = serde_json::json!({"conversations":[{
        "source":"codex","fingerprint":"stale","title":"Stale","mapping":{"status":"matched"}
    }]});
    let mut s = conversation_import_fixture();
    let (first, _) = import_request(&s, PREVIEW).unwrap();
    s.dispatch(Action::Settings(SettingsAction::PreviewConversationImport));
    let (latest, _) = import_request(&s, PREVIEW).unwrap();
    import_response(&mut s, "source", first, PREVIEW, ready.clone());
    import_response(&mut s, "dest", latest, PREVIEW, ready.clone());
    s.dispatch(Action::Settings(SettingsAction::ExecuteConversationImport));
    assert!(import_request(&s, IMPORT).is_none());

    s.dispatch(Action::Navigate(NavAction::SelectWorkspace("dest".into())));
    super::conversation_import::open(&mut s);
    import_response(&mut s, "source", latest, PREVIEW, ready.clone());
    s.dispatch(Action::Settings(SettingsAction::ExecuteConversationImport));
    assert!(import_request(&s, IMPORT).is_none());
    let (dest_id, _) = import_request(&s, PREVIEW).unwrap();
    import_response(
        &mut s,
        "dest",
        dest_id,
        PREVIEW,
        serde_json::json!({"conversations":[{
            "source":"codex","fingerprint":"fresh","title":"Current","mapping":{"status":"matched"}
        }]}),
    );
    s.dispatch(Action::Settings(SettingsAction::ExecuteConversationImport));
    let (_, params) = import_request(&s, IMPORT).unwrap();
    assert_eq!(
        params["selected"],
        serde_json::json!([{"source":"codex","fingerprint":"fresh"}])
    );
}

#[test]
fn conversation_import_loads_new_destinations_after_leaving_settings() {
    use super::conversation_import::{IMPORT, PREVIEW};
    use crate::actions::StoreEvent;
    use crate::router::ViewId;

    let mut s = conversation_import_fixture();
    let (id, _) = import_request(&s, PREVIEW).unwrap();
    import_response(
        &mut s,
        "source",
        id,
        PREVIEW,
        serde_json::json!({"conversations":[{
            "source":"codex","fingerprint":"fp","title":"New project","mapping":{"status":"create"}
        }]}),
    );
    s.dispatch(Action::Settings(SettingsAction::ExecuteConversationImport));
    let (id, _) = import_request(&s, IMPORT).unwrap();
    s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
    import_response(
        &mut s,
        "source",
        id,
        IMPORT,
        serde_json::json!({
            "imported":[{"workspaceId":"new-project","workspacePath":"/registered"}],
            "createdWorkspaces":[{"workspaceId":"new-project","path":"/registered","name":"New project"}],
            "skipped":[], "failed":[]
        }),
    );
    assert!(s.workspaces.iter().all(|w| w.id != "new-project"));
    assert!(
        s.services
            .emitted_native_commands
            .iter()
            .any(|cmd| matches!(
                cmd, NativeCommand::LoadImportedWorkspaces(ids) if ids == &["new-project"]
            ))
    );
    s.apply_store_event(StoreEvent::ImportedWorkspacesLoaded(vec![
        WorkspaceRecord::new("new-project", "New project", "/registered", 1),
    ]));
    assert!(s.workspaces.iter().any(|w| w.id == "new-project"));
    assert_eq!(s.active_workspace_id.as_deref(), Some("source"));
    assert!(s.settings_ui.conversation_import.is_none());
    assert!(s.services.emitted_native_commands.iter().any(|cmd| matches!(
        cmd, NativeCommand::StartWorkspaceServer { workspace_id, path, .. } if workspace_id == "new-project" && path == "/registered"
    )));
}

#[test]
fn mcp_args_formatter_escapes_backslash_only_arguments_for_lossless_roundtrip() {
    use super::mcp_server_draft::{
        McpServerDraftExtras, build_mcp_server_config_with_extras, format_args_line,
    };

    let original = vec![
        r"C:\tools\server.js".to_string(),
        "--flag".to_string(),
        r"C:\Program Files\My App\run.exe".to_string(),
        r"trailing\".to_string(),
        "plain-arg".to_string(),
    ];
    let formatted = format_args_line(&original);
    assert_eq!(parse_args_line(&formatted).unwrap(), original);

    let summary = McpServerSummary {
        name: "win-tool".to_string(),
        transport: "stdio".to_string(),
        enabled: true,
        config: serde_json::json!({
            "transport": {
                "type": "stdio",
                "command": "node",
                "args": [r"C:\tools\server.js"],
            }
        }),
        ..Default::default()
    };
    let mut draft = draft_from_summary(&summary);
    // Edit an unrelated field and save; Windows path argument must stay intact.
    draft.enabled = false;
    let (_, config) =
        build_mcp_server_config_with_extras(&draft, &McpServerDraftExtras::default(), None)
            .expect("valid stdio config");
    assert_eq!(
        config["transport"]["args"],
        serde_json::json!([r"C:\tools\server.js"])
    );
}

#[test]
fn backup_page_exposes_saved_checkpoints_and_dispatches_checkpoint_actions() {
    use crate::state::{BackupCheckpointSummary, BackupSummary};
    use crate::ws::WsCommand;
    use rune::{El, Runtime};

    fn render_backup(s: &AppState, cx: &mut rune::Cx<AppState>) -> El {
        let (kit, tok) = crate::theme::build_kit_with_accent(
            false,
            false,
            false,
            s.desktop_settings.accent_palette,
        );
        let out = crate::views::settings::backup::view(s, &kit, &tok);
        let _ = cx;
        rune::el()
            .w_full()
            .h_full()
            .child(rune_kit::root(out.body, out.overlays))
    }

    fn click(rt: &mut Runtime<AppState>, key: &str) {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        rt.settle_all();
        rt.frame(0.0);
    }

    let mut s = AppState {
        scene_mode: true,
        workspaces: vec![WorkspaceRecord::new("ws-1", "Alpha", "/tmp/alpha", 1)],
        active_workspace_id: Some("ws-1".into()),
        backups: vec![BackupSummary {
            id: "sess-1".into(),
            target_session_id: "sess-1".into(),
            label: "Refactor".into(),
            title: Some("Refactor".into()),
            created_at: 1_763_000_000_000,
            size_bytes: 4096,
            original_snapshot_bytes: Some(2048),
            checkpoints: vec![
                BackupCheckpointSummary {
                    id: "cp-1".into(),
                    index: 1,
                    created_at: "2026-11-20T10:00:00Z".into(),
                    trigger: "auto".into(),
                    changed: true,
                    patch_bytes: 512,
                },
                BackupCheckpointSummary {
                    id: "cp-2".into(),
                    index: 2,
                    created_at: "2026-11-20T11:00:00Z".into(),
                    trigger: "manual".into(),
                    changed: true,
                    patch_bytes: 1024,
                },
            ],
            ..Default::default()
        }],
        ..Default::default()
    };
    s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Backup,
    ))));

    let mut rt = Runtime::new(s, render_backup, (1100.0, 820.0), rune::Env::new(true, 1.0));
    rt.frame(0.0);
    rt.settle_all();
    rt.frame(0.0);

    // Both saved checkpoints and the original snapshot are exposed with distinct IDs.
    assert!(rt.find("backup-item-sess-1::cp-2").is_some());
    assert!(rt.find("backup-item-sess-1::cp-1").is_some());
    assert!(rt.find("backup-item-sess-1").is_some());

    // Select cp-1 and verify Inspect delta, Restore checkpoint, and Delete snapshot carry cp-1.
    click(&mut rt, "backup-item-sess-1::cp-1");
    assert_eq!(
        rt.state.settings_ui.backup_selected_id.as_deref(),
        Some("sess-1::cp-1")
    );

    click(&mut rt, "backup-inspect-btn");
    assert!(
        rt.state
            .services
            .emitted_ws_commands
            .iter()
            .any(|cmd| matches!(
                cmd,
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/backups/workspace/delta/read"
                        && params["targetSessionId"] == "sess-1"
                        && params["checkpointId"] == "cp-1"
            )),
        "expected delta/read for selected checkpoint cp-1"
    );

    click(&mut rt, "backup-restore-btn");
    assert!(rt.state.settings_ui.backup_restore_confirm_open);
    click(&mut rt, "backup-restore-confirm-confirm");
    assert!(
        rt.state
            .services
            .emitted_ws_commands
            .iter()
            .any(|cmd| matches!(
                cmd,
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/backups/workspace/restore"
                        && params["targetSessionId"] == "sess-1"
                        && params["checkpointId"] == "cp-1"
            )),
        "expected restore to pass checkpointId cp-1 instead of restoring original snapshot"
    );

    click(&mut rt, "backup-delete-btn");
    assert_eq!(
        rt.state.settings_ui.backup_delete_confirm_id.as_deref(),
        Some("sess-1::cp-1")
    );
    click(&mut rt, "backup-delete-confirm-confirm");
    assert!(
        rt.state
            .services
            .emitted_ws_commands
            .iter()
            .any(|cmd| matches!(
                cmd,
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/backups/workspace/deleteCheckpoint"
                        && params["targetSessionId"] == "sess-1"
                        && params["checkpointId"] == "cp-1"
            )),
        "expected deleteCheckpoint for selected checkpoint cp-1"
    );
}
