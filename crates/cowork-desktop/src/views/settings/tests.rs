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
