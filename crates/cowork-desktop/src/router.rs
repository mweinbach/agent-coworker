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
}

/// Snapshot of the current navigation location.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NavigationSnapshot {
    pub view: ViewId,
    pub settings_page: SettingsPageId,
    pub settings_tab: Option<String>,
    pub settings_section: Option<String>,
    pub new_provider_intent: bool,
    pub active_thread_id: Option<String>,
    pub active_task_id: Option<String>,
}

/// Bounded browser-style navigation history stack.
#[derive(Clone, Debug)]
pub struct NavigationHistory {
    entries: Vec<NavigationSnapshot>,
    cursor: usize,
    max_entries: usize,
}

impl Default for NavigationHistory {
    fn default() -> Self {
        Self::new(NavigationSnapshot::default())
    }
}

impl NavigationHistory {
    pub fn new(initial: NavigationSnapshot) -> Self {
        Self {
            entries: vec![initial],
            cursor: 0,
            max_entries: 64,
        }
    }

    pub fn current(&self) -> &NavigationSnapshot {
        &self.entries[self.cursor]
    }

    pub fn can_go_back(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.cursor + 1 < self.entries.len()
    }

    /// Pushes a new location, dropping forward entries if different from current.
    pub fn push(&mut self, mut next: NavigationSnapshot) {
        next.settings_page = next.settings_page.canonical();
        if self.current() == &next {
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
        self.entries[self.cursor] = next;
    }

    pub fn go_back(&mut self) -> bool {
        if !self.can_go_back() {
            return false;
        }
        self.cursor -= 1;
        true
    }

    pub fn go_forward(&mut self) -> bool {
        if !self.can_go_forward() {
            return false;
        }
        self.cursor += 1;
        true
    }
}
