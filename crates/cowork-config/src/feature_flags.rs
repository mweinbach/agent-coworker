use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Canonical feature flag identifiers matching `src/shared/featureFlags.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FeatureFlagId {
    #[serde(rename = "menuBar")]
    MenuBar,
    #[serde(rename = "remoteAccess")]
    RemoteAccess,
    #[serde(rename = "workspacePicker")]
    WorkspacePicker,
    #[serde(rename = "workspaceLifecycle")]
    WorkspaceLifecycle,
    #[serde(rename = "openAiNativeConnectors")]
    OpenAiNativeConnectors,
    #[serde(rename = "canvas")]
    Canvas,
    #[serde(rename = "tasks")]
    Tasks,
    #[serde(rename = "workflows")]
    Workflows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackagedAvailability {
    Normal,
    ForcedOff,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlagDefinition {
    pub id: FeatureFlagId,
    pub label: &'static str,
    pub description: &'static str,
    pub default_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_override: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packaged_availability: Option<PackagedAvailability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_required: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlags {
    pub menu_bar: bool,
    pub remote_access: bool,
    pub workspace_picker: bool,
    pub workspace_lifecycle: bool,
    pub open_ai_native_connectors: bool,
    pub canvas: bool,
    pub tasks: bool,
    pub workflows: bool,
}

impl Default for FeatureFlags {
    fn default() -> Self {
        Self {
            menu_bar: true,
            remote_access: false,
            workspace_picker: true,
            workspace_lifecycle: true,
            open_ai_native_connectors: false,
            canvas: false,
            tasks: false,
            workflows: false,
        }
    }
}

impl FeatureFlags {
    pub fn get(&self, id: FeatureFlagId) -> bool {
        match id {
            FeatureFlagId::MenuBar => self.menu_bar,
            FeatureFlagId::RemoteAccess => self.remote_access,
            FeatureFlagId::WorkspacePicker => self.workspace_picker,
            FeatureFlagId::WorkspaceLifecycle => self.workspace_lifecycle,
            FeatureFlagId::OpenAiNativeConnectors => self.open_ai_native_connectors,
            FeatureFlagId::Canvas => self.canvas,
            FeatureFlagId::Tasks => self.tasks,
            FeatureFlagId::Workflows => self.workflows,
        }
    }

    pub fn set(&mut self, id: FeatureFlagId, enabled: bool) {
        match id {
            FeatureFlagId::MenuBar => self.menu_bar = enabled,
            FeatureFlagId::RemoteAccess => self.remote_access = enabled,
            FeatureFlagId::WorkspacePicker => self.workspace_picker = enabled,
            FeatureFlagId::WorkspaceLifecycle => self.workspace_lifecycle = enabled,
            FeatureFlagId::OpenAiNativeConnectors => self.open_ai_native_connectors = enabled,
            FeatureFlagId::Canvas => self.canvas = enabled,
            FeatureFlagId::Tasks => self.tasks = enabled,
            FeatureFlagId::Workflows => self.workflows = enabled,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlagOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menu_bar: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_access: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_picker: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_lifecycle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_ai_native_connectors: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tasks: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflows: Option<bool>,
}

impl FeatureFlagOverrides {
    pub fn get(&self, id: FeatureFlagId) -> Option<bool> {
        match id {
            FeatureFlagId::MenuBar => self.menu_bar,
            FeatureFlagId::RemoteAccess => self.remote_access,
            FeatureFlagId::WorkspacePicker => self.workspace_picker,
            FeatureFlagId::WorkspaceLifecycle => self.workspace_lifecycle,
            FeatureFlagId::OpenAiNativeConnectors => self.open_ai_native_connectors,
            FeatureFlagId::Canvas => self.canvas,
            FeatureFlagId::Tasks => self.tasks,
            FeatureFlagId::Workflows => self.workflows,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.menu_bar.is_none()
            && self.remote_access.is_none()
            && self.workspace_picker.is_none()
            && self.workspace_lifecycle.is_none()
            && self.open_ai_native_connectors.is_none()
            && self.canvas.is_none()
            && self.tasks.is_none()
            && self.workflows.is_none()
    }
}

pub const ALL_FEATURE_FLAG_IDS: [FeatureFlagId; 8] = [
    FeatureFlagId::MenuBar,
    FeatureFlagId::RemoteAccess,
    FeatureFlagId::WorkspacePicker,
    FeatureFlagId::WorkspaceLifecycle,
    FeatureFlagId::OpenAiNativeConnectors,
    FeatureFlagId::Canvas,
    FeatureFlagId::Tasks,
    FeatureFlagId::Workflows,
];

pub fn feature_flag_definition(id: FeatureFlagId) -> FeatureFlagDefinition {
    match id {
        FeatureFlagId::MenuBar => FeatureFlagDefinition {
            id,
            label: "Menu bar / tray",
            description: "Keep Cowork available from the macOS menu bar or Windows system tray, including the quick chat global shortcut.",
            default_enabled: true,
            env_override: None,
            packaged_availability: None,
            restart_required: None,
        },
        FeatureFlagId::RemoteAccess => FeatureFlagDefinition {
            id,
            label: "Remote access",
            description: "Enable phone pairing and relay access while the desktop app is open.",
            default_enabled: false,
            env_override: Some("COWORK_ENABLE_REMOTE_ACCESS"),
            packaged_availability: Some(PackagedAvailability::ForcedOff),
            restart_required: Some(true),
        },
        FeatureFlagId::WorkspacePicker => FeatureFlagDefinition {
            id,
            label: "Workspace picker",
            description: "Show multi-workspace switching UI in desktop settings, onboarding, and sidebar flows.",
            default_enabled: true,
            env_override: None,
            packaged_availability: None,
            restart_required: None,
        },
        FeatureFlagId::WorkspaceLifecycle => FeatureFlagDefinition {
            id,
            label: "Workspace lifecycle actions",
            description: "Allow adding, removing, reordering, and restarting workspaces from the desktop UI.",
            default_enabled: true,
            env_override: None,
            packaged_availability: None,
            restart_required: None,
        },
        FeatureFlagId::OpenAiNativeConnectors => FeatureFlagDefinition {
            id,
            label: "OpenAI native connectors",
            description: "Enable the OpenAI Native Connectors settings view and Codex apps tooling.",
            default_enabled: false,
            env_override: None,
            packaged_availability: Some(PackagedAvailability::Normal),
            restart_required: Some(true),
        },
        FeatureFlagId::Canvas => FeatureFlagDefinition {
            id,
            label: "Canvas",
            description: "Work alongside the agent on documents in the right sidebar. Allows real-time edits, commenting, and collaborative writing.",
            default_enabled: false,
            env_override: None,
            packaged_availability: None,
            restart_required: None,
        },
        FeatureFlagId::Tasks => FeatureFlagDefinition {
            id,
            label: "Tasks",
            description: "Enable the durable Tasks workspace surfaces (task list, task view, new task), the createTask agent tool, and the task/* routes.",
            default_enabled: false,
            env_override: Some("COWORK_ENABLE_TASKS"),
            packaged_availability: None,
            restart_required: Some(true),
        },
        FeatureFlagId::Workflows => FeatureFlagDefinition {
            id,
            label: "Workflows",
            description: "Enable the `workflow` agent tool: deterministic multi-agent orchestration driven by a sandboxed script.",
            default_enabled: false,
            env_override: Some("COWORK_ENABLE_WORKFLOWS"),
            packaged_availability: None,
            restart_required: Some(true),
        },
    }
}

pub fn parse_env_flag_boolean(raw: Option<&str>) -> Option<bool> {
    let normalized = raw?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub struct ResolveFeatureFlagsOptions<'a> {
    pub is_packaged: bool,
    pub env: Option<&'a HashMap<String, String>>,
    pub overrides: Option<FeatureFlagOverrides>,
}

/// Evaluates all 8 feature flags identically to `src/shared/featureFlags.ts`.
pub fn resolve_feature_flags(options: ResolveFeatureFlagsOptions<'_>) -> FeatureFlags {
    let mut values = FeatureFlags::default();

    for id in ALL_FEATURE_FLAG_IDS {
        let def = feature_flag_definition(id);
        values.set(id, def.default_enabled);
        if let Some(env_key) = def.env_override
            && let Some(env_map) = options.env
            && let Some(parsed) = parse_env_flag_boolean(env_map.get(env_key).map(String::as_str))
        {
            values.set(id, parsed);
        }
    }

    // Locally persisted/dev overrides only apply when !is_packaged.
    if !options.is_packaged
        && let Some(overrides) = options.overrides
    {
        for id in ALL_FEATURE_FLAG_IDS {
            if let Some(ov) = overrides.get(id) {
                values.set(id, ov);
            }
        }
    }

    // Packaged builds enforce forced-off clamps regardless of env or local overrides.
    if options.is_packaged {
        for id in ALL_FEATURE_FLAG_IDS {
            let def = feature_flag_definition(id);
            if def.packaged_availability == Some(PackagedAvailability::ForcedOff) {
                values.set(id, false);
            }
        }
    }

    values
}

pub fn is_openai_native_connectors_experiment_enabled(env: &HashMap<String, String>) -> bool {
    parse_env_flag_boolean(
        env.get("COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS")
            .map(String::as_str),
    )
    .unwrap_or(false)
}
