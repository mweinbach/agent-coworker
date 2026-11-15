//! Unit tests for Settings navigation, gating, target resolution, and primitives.

use super::experiments::{KNOWN_FEATURE_FLAGS, resolve_flag_enabled};
use super::primitives::{entity_palette_index, management_targets, name_initials};
use super::shell::{page_key, resolve_active_page, settings_groups};
use crate::actions::{Action, NavAction, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::{AppState, WorkspaceRecord};

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
}
