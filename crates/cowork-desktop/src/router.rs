//! Client-side view routing and back/forward navigation history.
//!
//! Ported from `apps/desktop/src/app/navigation.ts` and
//! `apps/desktop/src/ui/settings/settingsPages.ts`.

use serde::{Deserialize, Serialize};

/// Top-level desktop view routes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewId {
    #[default]
    Chat,
    Task,
    Settings,
}

/// Settings page identifiers (canonical pages + legacy aliases from Electron).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsPageId {
    #[default]
    Models,
    Subagents,
    ToolAccess,
    Desktop,
    Defaults,
    ProfileMemory,
    RemoteAccess,
    Backup,
    Chats,
    Usage,
    PrivacyTelemetry,
    Experiments,
    Diagnostics,
    Updates,
    // Legacy aliases preserved for deep links & saved routes.
    Providers,
    OpenAiNativeConnectors,
    Mcp,
    Workspaces,
    Memory,
    FeatureFlags,
    Developer,
    ArchivedChats,
}

impl SettingsPageId {
    /// Normalizes legacy page aliases onto canonical settings pages.
    pub fn canonical(self) -> Self {
        match self {
            SettingsPageId::Providers => SettingsPageId::Models,
            SettingsPageId::OpenAiNativeConnectors | SettingsPageId::Mcp => {
                SettingsPageId::ToolAccess
            }
            SettingsPageId::Workspaces => SettingsPageId::Defaults,
            SettingsPageId::Memory => SettingsPageId::ProfileMemory,
            SettingsPageId::FeatureFlags => SettingsPageId::Experiments,
            SettingsPageId::Developer => SettingsPageId::Diagnostics,
            SettingsPageId::ArchivedChats => SettingsPageId::Chats,
            other => other,
        }
    }

    /// Canonical settings pages in default navigation order.
    pub const fn all_canonical() -> &'static [SettingsPageId] {
        &[
            SettingsPageId::Models,
            SettingsPageId::Subagents,
            SettingsPageId::ToolAccess,
            SettingsPageId::Defaults,
            SettingsPageId::ProfileMemory,
            SettingsPageId::RemoteAccess,
            SettingsPageId::Backup,
            SettingsPageId::Chats,
            SettingsPageId::Usage,
            SettingsPageId::PrivacyTelemetry,
            SettingsPageId::Desktop,
            SettingsPageId::Updates,
            SettingsPageId::Experiments,
            SettingsPageId::Diagnostics,
        ]
    }

    pub fn title(self) -> &'static str {
        match self.canonical() {
            SettingsPageId::Models => "Models",
            SettingsPageId::Subagents => "Subagents",
            SettingsPageId::ToolAccess => "Tool Access",
            SettingsPageId::Desktop => "Desktop",
            SettingsPageId::Defaults => "Behavior",
            SettingsPageId::ProfileMemory => "Profile & Memory",
            SettingsPageId::RemoteAccess => "Remote access",
            SettingsPageId::Backup => "Backups",
            SettingsPageId::Chats => "Chats",
            SettingsPageId::Usage => "Usage",
            SettingsPageId::PrivacyTelemetry => "Privacy & Telemetry",
            SettingsPageId::Experiments => "Experiments",
            SettingsPageId::Diagnostics => "Diagnostics",
            SettingsPageId::Updates => "Updates",
            _ => "Models",
        }
    }

    pub fn description(self) -> &'static str {
        match self.canonical() {
            SettingsPageId::Models => "Provider health, model defaults, and subagent routing.",
            SettingsPageId::Subagents => "Specialized child-agent profiles and scoped tool access.",
            SettingsPageId::ToolAccess => "Connect external tools and data sources.",
            SettingsPageId::Desktop => {
                "Menu bar, tray, and quick chat controls for the desktop app."
            }
            SettingsPageId::Defaults => "Defaults for models, tools, and behavior everywhere.",
            SettingsPageId::ProfileMemory => {
                "How Cowork should understand you and what it should remember."
            }
            SettingsPageId::RemoteAccess => {
                "Pair a phone to this folder or chat over the relay when the app is open."
            }
            SettingsPageId::Backup => "Recovery snapshots and restore points for chat sessions.",
            SettingsPageId::Chats => "Archived chat history, restore actions, and retention.",
            SettingsPageId::Usage => "Token usage and estimated cost across sessions.",
            SettingsPageId::PrivacyTelemetry => {
                "Optional crash reports, product analytics, and AI trace consent."
            }
            SettingsPageId::Experiments => "Enable or disable experimental capabilities.",
            SettingsPageId::Diagnostics => {
                "Debug visibility, runtime checks, and advanced output handling."
            }
            SettingsPageId::Updates => "App version and restart-based updates.",
            _ => "Provider health, model defaults, and subagent routing.",
        }
    }

    /// Parses a URL/route segment (canonical or legacy alias), falling back safely to `Models`.
    pub fn from_route_segment(segment: &str) -> Self {
        match segment.trim() {
            "models" | "providers" => SettingsPageId::Models,
            "subagents" => SettingsPageId::Subagents,
            "toolAccess" | "mcp" | "openaiNativeConnectors" => SettingsPageId::ToolAccess,
            "desktop" => SettingsPageId::Desktop,
            "defaults" | "workspaces" => SettingsPageId::Defaults,
            "profileMemory" | "memory" => SettingsPageId::ProfileMemory,
            "remoteAccess" => SettingsPageId::RemoteAccess,
            "backup" => SettingsPageId::Backup,
            "chats" | "archivedChats" => SettingsPageId::Chats,
            "usage" => SettingsPageId::Usage,
            "privacyTelemetry" => SettingsPageId::PrivacyTelemetry,
            "experiments" | "featureFlags" => SettingsPageId::Experiments,
            "diagnostics" | "developer" => SettingsPageId::Diagnostics,
            "updates" => SettingsPageId::Updates,
            _ => SettingsPageId::Models,
        }
    }
}

/// Snapshot of the current navigation location.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NavigationSnapshot {
    pub view: ViewId,
    pub settings_page: SettingsPageId,
    pub last_non_settings_view: ViewId,
    pub settings_tab: Option<String>,
    pub settings_section: Option<String>,
    pub new_provider_intent: bool,
    pub active_thread_id: Option<String>,
    pub active_task_id: Option<String>,
}

/// Partial update patch for `NavigationHistory::update`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NavigationPatch {
    pub view: Option<ViewId>,
    pub settings_page: Option<SettingsPageId>,
    pub last_non_settings_view: Option<ViewId>,
    pub settings_tab: Option<Option<String>>,
    pub settings_section: Option<Option<String>>,
    pub new_provider_intent: Option<bool>,
    pub active_thread_id: Option<Option<String>>,
    pub active_task_id: Option<Option<String>>,
}

/// Bounded browser-style navigation history stack with return-context preservation.
#[derive(Clone, Debug)]
pub struct NavigationHistory {
    entries: Vec<NavigationSnapshot>,
    cursor: usize,
    max_entries: usize,
    initialized: bool,
    creation_intent_epoch: u64,
    active_creation_intent: Option<u64>,
}

impl Default for NavigationHistory {
    fn default() -> Self {
        Self::new(NavigationSnapshot::default())
    }
}

impl NavigationHistory {
    pub fn new(mut initial: NavigationSnapshot) -> Self {
        initial.settings_page = initial.settings_page.canonical();
        if initial.last_non_settings_view == ViewId::Settings {
            initial.last_non_settings_view = ViewId::Chat;
        }
        Self {
            entries: vec![initial],
            cursor: 0,
            max_entries: 64,
            initialized: false,
            creation_intent_epoch: 0,
            active_creation_intent: None,
        }
    }

    pub fn current(&self) -> &NavigationSnapshot {
        &self.entries[self.cursor]
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn can_go_back(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.cursor + 1 < self.entries.len()
    }

    /// Restores saved navigation once, allowing an explicit deep link to win.
    pub fn initialize_once(
        &mut self,
        saved: Option<NavigationPatch>,
        has_explicit_initial_link: bool,
    ) {
        if self.initialized {
            return;
        }
        self.initialized = true;
        if has_explicit_initial_link {
            let mut cur = self.entries[self.cursor].clone();
            cur.settings_page = cur.settings_page.canonical();
            if cur.last_non_settings_view == ViewId::Settings {
                cur.last_non_settings_view = ViewId::Chat;
            }
            self.entries[self.cursor] = cur;
            return;
        }
        if let Some(patch) = saved {
            self.apply_patch(patch, true);
        }
    }

    /// Starts a tracked creation-navigation intent (preserved by programmatic routing,
    /// revoked when the user navigates back/forward through history).
    pub fn begin_creation_intent(&mut self) -> u64 {
        self.creation_intent_epoch += 1;
        let id = self.creation_intent_epoch;
        self.active_creation_intent = Some(id);
        id
    }

    pub fn is_creation_intent_current(&self, intent_id: u64) -> bool {
        self.active_creation_intent == Some(intent_id)
    }

    /// Applies a partial navigation command, matching Cowork Desktop history rules:
    /// updating `settings_page` while outside Settings updates in place without pushing history,
    /// and entering Settings saves `last_non_settings_view`.
    pub fn update(&mut self, patch: NavigationPatch) {
        self.apply_patch(patch, false);
    }

    fn apply_patch(&mut self, patch: NavigationPatch, replace_in_place: bool) {
        let cur = self.entries[self.cursor].clone();
        let target_view = patch.view.unwrap_or(cur.view);
        let target_page = patch
            .settings_page
            .map(SettingsPageId::canonical)
            .unwrap_or_else(|| cur.settings_page.canonical());

        let remember_settings_only =
            patch.view.is_none() && cur.view != ViewId::Settings && patch.settings_page.is_some();

        let last_non_settings = if let Some(explicit) = patch.last_non_settings_view {
            if explicit == ViewId::Settings {
                ViewId::Chat
            } else {
                explicit
            }
        } else if cur.view != ViewId::Settings {
            cur.view
        } else if target_view != ViewId::Settings {
            target_view
        } else {
            cur.last_non_settings_view
        };

        let next = NavigationSnapshot {
            view: target_view,
            settings_page: target_page,
            last_non_settings_view: last_non_settings,
            settings_tab: patch.settings_tab.unwrap_or(cur.settings_tab),
            settings_section: patch.settings_section.unwrap_or(cur.settings_section),
            new_provider_intent: patch.new_provider_intent.unwrap_or(cur.new_provider_intent),
            active_thread_id: patch.active_thread_id.unwrap_or(cur.active_thread_id),
            active_task_id: patch.active_task_id.unwrap_or(cur.active_task_id),
        };

        if self.current() == &next {
            return;
        }
        if replace_in_place || remember_settings_only {
            self.entries[self.cursor] = next;
        } else {
            self.push(next);
        }
    }

    /// Pushes a new location, dropping forward entries if different from current.
    pub fn push(&mut self, mut next: NavigationSnapshot) {
        next.settings_page = next.settings_page.canonical();
        let cur = self.current();
        if next.last_non_settings_view == ViewId::Settings {
            next.last_non_settings_view = if cur.view != ViewId::Settings {
                cur.view
            } else {
                cur.last_non_settings_view
            };
        } else if cur.view != ViewId::Settings && next.view == ViewId::Settings {
            next.last_non_settings_view = cur.view;
        }
        if cur == &next {
            return;
        }
        self.entries.truncate(self.cursor + 1);
        self.entries.push(next);
        if self.entries.len() > self.max_entries {
            let overflow = self.entries.len() - self.max_entries;
            self.entries.drain(0..overflow);
        }
        self.cursor = self.entries.len() - 1;
    }

    /// Updates the current snapshot in place without pushing a history entry.
    pub fn replace_current(&mut self, mut next: NavigationSnapshot) {
        next.settings_page = next.settings_page.canonical();
        if next.last_non_settings_view == ViewId::Settings {
            next.last_non_settings_view = ViewId::Chat;
        }
        self.entries[self.cursor] = next;
    }

    /// Rewrites every history entry pointing at `old_id` (including back/forward entries) to `new_id`.
    pub fn rekey_thread_id(&mut self, old_id: &str, new_id: &str) -> bool {
        if old_id == new_id {
            return false;
        }
        let mut changed = false;
        for entry in &mut self.entries {
            if entry.active_thread_id.as_deref() == Some(old_id) {
                entry.active_thread_id = Some(new_id.to_string());
                changed = true;
            }
        }
        changed
    }

    /// Clears `active_thread_id` across every history entry (current and back/forward)
    /// that points to any ID in `removed_ids`.
    pub fn clear_thread_ids(&mut self, removed_ids: &[String]) -> bool {
        if removed_ids.is_empty() {
            return false;
        }
        let mut changed = false;
        for entry in &mut self.entries {
            if entry
                .active_thread_id
                .as_deref()
                .is_some_and(|tid| removed_ids.iter().any(|id| id == tid))
            {
                entry.active_thread_id = None;
                changed = true;
            }
        }
        changed
    }

    /// Clears `active_task_id` across every history entry (current and back/forward)
    /// that points to any ID in `removed_ids`.
    pub fn clear_task_ids(&mut self, removed_ids: &[String]) -> bool {
        if removed_ids.is_empty() {
            return false;
        }
        let mut changed = false;
        for entry in &mut self.entries {
            if entry
                .active_task_id
                .as_deref()
                .is_some_and(|tid| removed_ids.iter().any(|id| id == tid))
            {
                entry.active_task_id = None;
                changed = true;
            }
        }
        changed
    }

    pub fn go_back(&mut self) -> bool {
        if !self.can_go_back() {
            return false;
        }
        self.cursor -= 1;
        self.active_creation_intent = None;
        true
    }

    pub fn go_forward(&mut self) -> bool {
        if !self.can_go_forward() {
            return false;
        }
        self.cursor += 1;
        self.active_creation_intent = None;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_canonical_saved_navigation_once() {
        let mut nav = NavigationHistory::new(NavigationSnapshot::default());
        nav.initialize_once(
            Some(NavigationPatch {
                view: Some(ViewId::Settings),
                settings_page: Some(SettingsPageId::Providers),
                last_non_settings_view: Some(ViewId::Task),
                ..Default::default()
            }),
            false,
        );
        assert_eq!(nav.current().view, ViewId::Settings);
        assert_eq!(nav.current().settings_page, SettingsPageId::Models);
        assert_eq!(nav.current().last_non_settings_view, ViewId::Task);

        nav.update(NavigationPatch {
            settings_page: Some(SettingsPageId::Updates),
            ..Default::default()
        });
        nav.initialize_once(
            Some(NavigationPatch {
                view: Some(ViewId::Chat),
                ..Default::default()
            }),
            false,
        );
        assert_eq!(nav.current().view, ViewId::Settings);
        assert_eq!(nav.current().settings_page, SettingsPageId::Updates);
    }

    #[test]
    fn explicit_initial_links_beat_saved_and_normalize_aliases() {
        let mut nav = NavigationHistory::new(NavigationSnapshot {
            view: ViewId::Settings,
            settings_page: SettingsPageId::from_route_segment("mcp"),
            ..Default::default()
        });
        nav.initialize_once(
            Some(NavigationPatch {
                view: Some(ViewId::Task),
                settings_page: Some(SettingsPageId::Updates),
                ..Default::default()
            }),
            true,
        );
        assert_eq!(nav.current().settings_page, SettingsPageId::ToolAccess);
        assert_eq!(nav.current().last_non_settings_view, ViewId::Chat);
        assert_eq!(nav.len(), 1);
    }

    #[test]
    fn settings_page_changes_preserve_task_return_context_across_back_forward() {
        let mut nav = NavigationHistory::new(NavigationSnapshot {
            view: ViewId::Task,
            last_non_settings_view: ViewId::Task,
            ..Default::default()
        });
        nav.initialize_once(None, false);
        nav.update(NavigationPatch {
            view: Some(ViewId::Settings),
            settings_page: Some(SettingsPageId::Updates),
            ..Default::default()
        });
        nav.update(NavigationPatch {
            settings_page: Some(SettingsPageId::Usage),
            ..Default::default()
        });
        assert_eq!(nav.current().last_non_settings_view, ViewId::Task);
        assert!(nav.go_back());
        assert_eq!(nav.current().settings_page, SettingsPageId::Updates);
        assert!(nav.go_forward());
        assert_eq!(nav.current().settings_page, SettingsPageId::Usage);
        let return_view = nav.current().last_non_settings_view;
        nav.update(NavigationPatch {
            view: Some(return_view),
            ..Default::default()
        });
        assert_eq!(nav.current().view, ViewId::Task);
    }

    #[test]
    fn remembering_settings_page_does_not_open_settings_or_grow_history() {
        let mut nav = NavigationHistory::new(NavigationSnapshot::default());
        nav.update(NavigationPatch {
            settings_page: Some(SettingsPageId::Usage),
            ..Default::default()
        });
        assert_eq!(nav.current().view, ViewId::Chat);
        assert_eq!(nav.len(), 1);
        nav.update(NavigationPatch {
            view: Some(ViewId::Settings),
            ..Default::default()
        });
        assert_eq!(nav.current().settings_page, SettingsPageId::Usage);
    }

    #[test]
    fn identical_commands_and_unknown_segments_behave_safely() {
        let mut nav = NavigationHistory::new(NavigationSnapshot::default());
        let intent = nav.begin_creation_intent();
        nav.initialize_once(None, false);
        nav.update(NavigationPatch {
            view: Some(ViewId::Chat),
            ..Default::default()
        });
        nav.update(NavigationPatch::default());
        assert_eq!(nav.len(), 1);
        nav.update(NavigationPatch {
            view: Some(ViewId::Task),
            ..Default::default()
        });
        assert!(nav.is_creation_intent_current(intent));
        assert!(nav.go_back());
        assert!(!nav.is_creation_intent_current(intent));

        assert_eq!(
            SettingsPageId::from_route_segment("not-a-page"),
            SettingsPageId::Models
        );
    }

    #[test]
    fn rekey_thread_id_updates_current_and_history_entries() {
        let mut nav = NavigationHistory::new(NavigationSnapshot::default());
        nav.update(NavigationPatch {
            view: Some(ViewId::Chat),
            active_thread_id: Some(Some("__draft-1".to_string())),
            ..Default::default()
        });
        nav.update(NavigationPatch {
            view: Some(ViewId::Settings),
            settings_page: Some(SettingsPageId::Models),
            ..Default::default()
        });
        assert!(nav.rekey_thread_id("__draft-1", "srv-1"));
        assert!(!nav.rekey_thread_id("__draft-1", "srv-1"));
        assert_eq!(nav.current().active_thread_id.as_deref(), Some("srv-1"));
        assert!(nav.go_back());
        assert_eq!(nav.current().active_thread_id.as_deref(), Some("srv-1"));
    }
}
