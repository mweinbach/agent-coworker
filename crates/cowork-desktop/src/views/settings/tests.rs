//! Unit tests for Settings navigation, gating, target resolution, and primitives.

use super::desktop::{DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR, format_quick_chat_shortcut_label};
use super::experiments::{KNOWN_FEATURE_FLAGS, is_flag_enabled, resolve_flag_enabled};
use super::primitives::{entity_palette_index, management_targets, name_initials};
use super::shell::{page_key, resolve_active_page, settings_groups};
use super::updates::is_allowed_release_link;
use super::usage::{aggregate_usage, format_estimated_cost, format_token_count};
use crate::actions::{Action, NavAction, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::{AppState, ThreadRecord, ThreadRuntime, UsageSummary, WorkspaceRecord};

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
            },
            WorkspaceRecord {
                id: "ws-1".to_string(),
                name: "Project Alpha".to_string(),
                path: "/tmp/alpha".to_string(),
                one_off_chat: false,
                archived: false,
                created_at: 2,
                last_opened_at: 2,
            },
            WorkspaceRecord {
                id: "chat-2".to_string(),
                name: "Ad-hoc 2".to_string(),
                path: "/tmp/c2".to_string(),
                one_off_chat: true,
                archived: false,
                created_at: 3,
                last_opened_at: 3,
            },
            WorkspaceRecord {
                id: "ws-arch".to_string(),
                name: "Archived".to_string(),
                path: "/tmp/arch".to_string(),
                one_off_chat: false,
                archived: true,
                created_at: 4,
                last_opened_at: 4,
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
