//! Ephemeral client-side UI state owned by the Settings view subtree.
//!
//! Kept isolated under `views::settings` so `AppState` only holds a single
//! `settings_ui: SettingsUiState` slot without requiring shared-core edits as
//! individual settings pages and dialogs evolve.

use std::collections::{HashMap, HashSet};

use rune::TextEdit;
use rune_kit::shell::PaneState;
use rune_kit::{ShortcutRecorderState, TreeModel};
use serde_json::Value;

/// Time filter options on the Usage page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UsageTimeWindow {
    Today,
    Days7,
    Days30,
    #[default]
    All,
}

impl UsageTimeWindow {
    /// Human-readable label shown in the segmented filter control.
    pub const fn label(self) -> &'static str {
        match self {
            UsageTimeWindow::Today => "Today",
            UsageTimeWindow::Days7 => "7d",
            UsageTimeWindow::Days30 => "30d",
            UsageTimeWindow::All => "All time",
        }
    }
}

/// Active breakdown tab on the Usage page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UsageViewTab {
    #[default]
    Overview,
    Sessions,
    Models,
    Workspaces,
}

/// Active sub-tab on the Tool Access page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolAccessTab {
    #[default]
    Plugins,
    Skills,
    McpServers,
    Marketplaces,
    Connectors,
    Search,
}

impl ToolAccessTab {
    /// Canonical string identifier matching `SettingsNavigation` tab routing.
    pub const fn id(self) -> &'static str {
        match self {
            ToolAccessTab::Plugins => "plugins",
            ToolAccessTab::Skills => "skills",
            ToolAccessTab::McpServers => "mcp",
            ToolAccessTab::Marketplaces => "marketplaces",
            ToolAccessTab::Connectors => "connectors",
            ToolAccessTab::Search => "search",
        }
    }

    /// Parses a SettingsIntent tab slug into a `ToolAccessTab`, honoring feature gating.
    pub fn from_id(raw: &str, apps_enabled: bool) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "skills" | "marketplaces" => ToolAccessTab::Skills,
            "mcp" | "mcp-servers" | "connectors-mcp" => ToolAccessTab::McpServers,
            "connectors" | "apps" if apps_enabled => ToolAccessTab::Connectors,
            "search" => ToolAccessTab::Search,
            _ => ToolAccessTab::Plugins,
        }
    }
}

/// Active sub-tab on the Subagents page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SubagentsTab {
    #[default]
    Profiles,
    Create,
}

/// Ephemeral local widget, draft, search, and dialog state for all Settings pages.
pub struct SettingsUiState {
    // Shared control state
    pub open_select_key: Option<String>,
    pub mobile_nav_open: bool,
    pub nav_pane: PaneState,

    // Desktop page
    pub quick_chat_recorder: ShortcutRecorderState,
    pub quick_chat_shortcut_error: Option<String>,
    pub quick_chat_synced_accel: Option<String>,

    // Privacy & Telemetry page
    pub privacy_disable_all_confirm_open: bool,
    pub privacy_trace_payloads_confirm_open: bool,

    // Diagnostics / Developer page
    pub diagnostics_status_banner: Option<String>,
    pub last_diagnostics_bundle_path: Option<String>,
    pub diagnostics_upload_confirm_open: bool,
    pub developer_restart_onboarding_confirm_open: bool,
    pub developer_overflow_threshold_edit: TextEdit,
    pub developer_overflow_threshold_workspace: Option<String>,

    // Usage page
    pub usage_window: UsageTimeWindow,
    pub usage_tab: UsageViewTab,
    pub usage_search_edit: TextEdit,
    pub usage_selected_thread_id: Option<String>,
    pub usage_detail_dialog_open: bool,
    pub usage_estimates_dialog_open: bool,

    // Chats / Archived & Conversation import
    pub chats_search_edit: TextEdit,
    pub chats_workspace_filter: Option<String>,
    pub chats_confirm_delete_id: Option<String>,
    pub import_dialog_open: bool,
    pub import_source: String,
    pub import_selected_sources: HashSet<String>,
    pub import_path_edit: TextEdit,

    // Backups page
    pub backup_selected_id: Option<String>,
    pub backup_file_query_edit: TextEdit,
    pub backup_restore_confirm_open: bool,
    pub backup_delete_confirm_id: Option<String>,
    pub backup_file_tree: TreeModel<String>,

    // Models / Providers page & ManageModelsDialog
    pub expanded_provider_id: Option<String>,
    pub provider_draft_for: Option<String>,
    pub provider_logout_confirm_id: Option<String>,
    pub provider_new_dialog_open: bool,
    pub manage_models_provider_id: Option<String>,
    pub manage_models_for: Option<String>,
    pub provider_search_edit: TextEdit,
    pub models_search_edit: TextEdit,
    pub api_key_edit: TextEdit,
    pub api_key_revealed: bool,
    pub base_url_edit: TextEdit,
    pub provider_lmstudio_url_edit: TextEdit,
    pub oauth_code_edit: TextEdit,
    pub custom_model_id_edit: TextEdit,
    pub custom_model_name_edit: TextEdit,

    // Behavior / Workspaces page
    pub workspace_search_edit: TextEdit,
    pub expanded_workspace_ids: HashSet<String>,
    pub workspace_budget_edit: TextEdit,
    pub new_workspace_name_edit: TextEdit,

    // Subagents page & editor dialog
    pub subagents_tab: SubagentsTab,
    pub subagent_search_edit: TextEdit,
    pub selected_subagent_id: Option<String>,
    pub subagent_dialog_open: bool,
    pub subagent_delete_confirm_id: Option<String>,
    pub subagent_name_edit: TextEdit,
    pub subagent_desc_edit: TextEdit,
    pub subagent_prompt_edit: TextEdit,
    pub subagent_draft_provider: String,
    pub subagent_draft_model: String,
    pub subagent_draft_tool_preset: String,
    pub subagent_draft_allowed_tools: HashSet<String>,

    // Profile & Memory page
    pub user_profile_edit: TextEdit,
    pub memory_filter_edit: TextEdit,
    pub memory_key_edit: TextEdit,
    pub memory_content_edit: TextEdit,
    pub advanced_memory_key_edit: TextEdit,
    pub advanced_memory_content_edit: TextEdit,
    pub skill_improvement_expanded: bool,

    // Remote Access page
    pub forget_phone_id: Option<String>,
    pub forget_all_phones_open: bool,
    pub remote_access_copied_url: Option<String>,

    // Tool Access & MCP server editor
    pub tool_access_tab: ToolAccessTab,
    pub tool_search_edit: TextEdit,
    pub mcp_search_edit: TextEdit,
    pub mcp_editor_open: bool,
    pub mcp_editing_name: Option<String>,
    pub mcp_transport: String,
    pub mcp_name_edit: TextEdit,
    pub mcp_command_edit: TextEdit,
    pub mcp_args_edit: TextEdit,
    pub mcp_url_edit: TextEdit,
    pub mcp_env_edit: TextEdit,
    pub mcp_headers_edit: TextEdit,
    pub mcp_api_key_edits: HashMap<String, TextEdit>,
    pub mcp_cwd_edit: TextEdit,
    pub mcp_icon_edit: TextEdit,
    pub mcp_required: bool,
    pub mcp_retries_edit: TextEdit,
    pub mcp_auth_type: String,
    pub mcp_auth_header_name_edit: TextEdit,
    pub mcp_auth_prefix_edit: TextEdit,
    pub mcp_auth_key_id_edit: TextEdit,
    pub mcp_oauth_scope_edit: TextEdit,
    pub mcp_oauth_resource_edit: TextEdit,
    pub mcp_oauth_mode: String,
    pub mcp_editing_base_config: Option<Value>,
    pub marketplace_dialog_open: bool,
    pub marketplace_url_edit: TextEdit,
    pub install_plugin_open: bool,
    pub install_skill_open: bool,
    pub install_target_edit: TextEdit,
    pub selected_plugin_id: Option<String>,
    pub selected_skill_id: Option<String>,
    pub developer_overflow_threshold_synced: Option<String>,

    // Slice 5 draft/confirm state (Behavior, Subagents, Profile & Memory)
    pub workspace_share_confirm_open: bool,
    pub workspace_remove_confirm_id: Option<String>,
    pub workspace_yolo_confirm: Option<(String, bool)>,
    pub workspace_advanced_open: bool,
    pub subagent_scope: String,
    pub subagent_workspace_id: Option<String>,
    pub subagent_editing_id: Option<String>,
    pub subagent_base_role: String,
    pub subagent_enabled: bool,
    pub subagent_reasoning_effort: Option<String>,
    pub subagent_draft_mcp_servers: HashSet<String>,
    pub subagent_draft_skill_names: HashSet<String>,
    pub workflow_concurrency_edit: TextEdit,
    pub workflow_concurrency_synced_ws: Option<String>,
    pub profile_name_edit: TextEdit,
    pub profile_work_edit: TextEdit,
    pub profile_instructions_edit: TextEdit,
    pub profile_details_edit: TextEdit,
    pub profile_synced_workspace_id: Option<String>,
    pub profile_saved_banner: bool,
    pub memory_scope_filter: String,
    pub memory_draft_scope: String,
    pub memory_dialog_open: bool,
    pub memory_editing_key: Option<String>,
    pub memory_delete_confirm_key: Option<String>,
    pub expanded_memory_keys: HashSet<String>,
    pub advanced_memory_dialog_open: bool,
    pub advanced_memory_editing_slug: Option<String>,
    pub advanced_memory_type: String,
    pub advanced_memory_desc_edit: TextEdit,
    pub advanced_memory_delete_confirm_slug: Option<String>,
    pub expanded_advanced_memory_slugs: HashSet<String>,
    pub skill_restore_confirm_name: Option<String>,

    // Slice 6 draft/confirm state (Tool Access, MCP Servers, Connectors)
    pub tool_access_synced_tab: Option<String>,
    pub connectors_search_edit: TextEdit,
    pub connectors_enabled_only: bool,
    pub expanded_mcp_servers: HashSet<String>,
    pub mcp_delete_confirm_name: Option<String>,
    pub mcp_oauth_entry_key: Option<String>,
    pub mcp_oauth_code_edit: TextEdit,
    pub mcp_editor_error: Option<String>,
    pub mcp_editor_advanced_open: bool,
    pub mcp_enabled: bool,
    pub plugin_install_scope: String,
    pub plugin_delete_confirm: Option<String>,
    pub plugin_delete_confirm_scoped: Option<(String, Option<String>)>,
    pub selected_plugin_scope: Option<String>,
    pub skill_install_scope: String,
    pub skill_delete_confirm: Option<String>,
    pub skill_delete_confirm_inst: Option<(String, String)>,
    pub marketplace_remove_confirm: Option<(String, String)>,
    pub subagent_editing_scope: String,
    pub subagent_delete_confirm: Option<(String, String)>,
    pub memory_editing_scope: String,
    pub memory_delete_confirm: Option<(String, String)>,
    pub mcp_editing_source: Option<String>,
    pub mcp_delete_confirm: Option<(String, String)>,
}

impl Default for SettingsUiState {
    fn default() -> Self {
        Self {
            open_select_key: None,
            mobile_nav_open: false,
            nav_pane: PaneState::new(crate::theme::layout::SIDEBAR_DEFAULT_WIDTH).range(
                crate::theme::layout::SIDEBAR_MIN_WIDTH,
                crate::theme::layout::SIDEBAR_MAX_WIDTH,
            ),
            quick_chat_recorder: ShortcutRecorderState::default(),
            quick_chat_shortcut_error: None,
            quick_chat_synced_accel: None,
            privacy_disable_all_confirm_open: false,
            privacy_trace_payloads_confirm_open: false,
            diagnostics_status_banner: None,
            last_diagnostics_bundle_path: None,
            diagnostics_upload_confirm_open: false,
            developer_restart_onboarding_confirm_open: false,
            developer_overflow_threshold_edit: TextEdit::new(""),
            developer_overflow_threshold_workspace: None,
            usage_window: UsageTimeWindow::All,
            usage_tab: UsageViewTab::Overview,
            usage_search_edit: TextEdit::new(""),
            usage_selected_thread_id: None,
            usage_detail_dialog_open: false,
            usage_estimates_dialog_open: false,
            chats_search_edit: TextEdit::new(""),
            chats_workspace_filter: None,
            chats_confirm_delete_id: None,
            import_dialog_open: false,
            import_source: "chatgpt".to_string(),
            import_selected_sources: HashSet::from([
                "codex".to_string(),
                "claude-code".to_string(),
            ]),
            import_path_edit: TextEdit::new(""),
            backup_selected_id: None,
            backup_file_query_edit: TextEdit::new(""),
            backup_restore_confirm_open: false,
            backup_delete_confirm_id: None,
            backup_file_tree: TreeModel::new(),
            expanded_provider_id: None,
            provider_draft_for: None,
            provider_logout_confirm_id: None,
            provider_new_dialog_open: false,
            manage_models_provider_id: None,
            manage_models_for: None,
            provider_search_edit: TextEdit::new(""),
            models_search_edit: TextEdit::new(""),
            api_key_edit: TextEdit::new(""),
            api_key_revealed: false,
            base_url_edit: TextEdit::new(""),
            provider_lmstudio_url_edit: TextEdit::new("http://127.0.0.1:1234"),
            oauth_code_edit: TextEdit::new(""),
            custom_model_id_edit: TextEdit::new(""),
            custom_model_name_edit: TextEdit::new(""),
            workspace_search_edit: TextEdit::new(""),
            expanded_workspace_ids: HashSet::new(),
            workspace_budget_edit: TextEdit::new(""),
            new_workspace_name_edit: TextEdit::new(""),
            subagents_tab: SubagentsTab::Profiles,
            subagent_search_edit: TextEdit::new(""),
            selected_subagent_id: None,
            subagent_dialog_open: false,
            subagent_delete_confirm_id: None,
            subagent_name_edit: TextEdit::new(""),
            subagent_desc_edit: TextEdit::new(""),
            subagent_prompt_edit: TextEdit::new(""),
            subagent_draft_provider: String::new(),
            subagent_draft_model: String::new(),
            subagent_draft_tool_preset: "standard".to_string(),
            subagent_draft_allowed_tools: HashSet::new(),
            user_profile_edit: TextEdit::new(""),
            memory_filter_edit: TextEdit::new(""),
            memory_key_edit: TextEdit::new(""),
            memory_content_edit: TextEdit::new(""),
            advanced_memory_key_edit: TextEdit::new(""),
            advanced_memory_content_edit: TextEdit::new(""),
            skill_improvement_expanded: false,
            forget_phone_id: None,
            forget_all_phones_open: false,
            remote_access_copied_url: None,
            tool_access_tab: ToolAccessTab::Plugins,
            tool_search_edit: TextEdit::new(""),
            mcp_search_edit: TextEdit::new(""),
            mcp_editor_open: false,
            mcp_editing_name: None,
            mcp_transport: "stdio".to_string(),
            mcp_name_edit: TextEdit::new(""),
            mcp_command_edit: TextEdit::new(""),
            mcp_args_edit: TextEdit::new(""),
            mcp_url_edit: TextEdit::new(""),
            mcp_env_edit: TextEdit::new(""),
            mcp_headers_edit: TextEdit::new(""),
            mcp_api_key_edits: HashMap::new(),
            mcp_cwd_edit: TextEdit::new(""),
            mcp_icon_edit: TextEdit::new(""),
            mcp_required: false,
            mcp_retries_edit: TextEdit::new(""),
            mcp_auth_type: "none".to_string(),
            mcp_auth_header_name_edit: TextEdit::new(""),
            mcp_auth_prefix_edit: TextEdit::new(""),
            mcp_auth_key_id_edit: TextEdit::new(""),
            mcp_oauth_scope_edit: TextEdit::new(""),
            mcp_oauth_resource_edit: TextEdit::new(""),
            mcp_oauth_mode: "auto".to_string(),
            mcp_editing_base_config: None,
            marketplace_dialog_open: false,
            marketplace_url_edit: TextEdit::new(""),
            install_plugin_open: false,
            install_skill_open: false,
            install_target_edit: TextEdit::new(""),
            selected_plugin_id: None,
            selected_skill_id: None,
            developer_overflow_threshold_synced: None,
            workspace_share_confirm_open: false,
            workspace_remove_confirm_id: None,
            workspace_yolo_confirm: None,
            workspace_advanced_open: false,
            subagent_scope: "global".to_string(),
            subagent_workspace_id: None,
            subagent_editing_id: None,
            subagent_base_role: "worker".to_string(),
            subagent_enabled: true,
            subagent_reasoning_effort: None,
            subagent_draft_mcp_servers: HashSet::new(),
            subagent_draft_skill_names: HashSet::new(),
            workflow_concurrency_edit: TextEdit::new("12"),
            workflow_concurrency_synced_ws: None,
            profile_name_edit: TextEdit::new(""),
            profile_work_edit: TextEdit::new(""),
            profile_instructions_edit: TextEdit::new(""),
            profile_details_edit: TextEdit::new(""),
            profile_synced_workspace_id: None,
            profile_saved_banner: false,
            memory_scope_filter: "all".to_string(),
            memory_draft_scope: "workspace".to_string(),
            memory_dialog_open: false,
            memory_editing_key: None,
            memory_delete_confirm_key: None,
            expanded_memory_keys: HashSet::new(),
            advanced_memory_dialog_open: false,
            advanced_memory_editing_slug: None,
            advanced_memory_type: "note".to_string(),
            advanced_memory_desc_edit: TextEdit::new(""),
            advanced_memory_delete_confirm_slug: None,
            expanded_advanced_memory_slugs: HashSet::new(),
            skill_restore_confirm_name: None,
            tool_access_synced_tab: None,
            connectors_search_edit: TextEdit::new(""),
            connectors_enabled_only: false,
            expanded_mcp_servers: HashSet::new(),
            mcp_delete_confirm_name: None,
            mcp_oauth_entry_key: None,
            mcp_oauth_code_edit: TextEdit::new(""),
            mcp_editor_error: None,
            mcp_editor_advanced_open: false,
            mcp_enabled: true,
            plugin_install_scope: "user".to_string(),
            plugin_delete_confirm: None,
            plugin_delete_confirm_scoped: None,
            selected_plugin_scope: None,
            skill_install_scope: "global".to_string(),
            skill_delete_confirm: None,
            skill_delete_confirm_inst: None,
            marketplace_remove_confirm: None,
            subagent_editing_scope: "workspace".to_string(),
            subagent_delete_confirm: None,
            memory_editing_scope: "workspace".to_string(),
            memory_delete_confirm: None,
            mcp_editing_source: None,
            mcp_delete_confirm: None,
        }
    }
}
