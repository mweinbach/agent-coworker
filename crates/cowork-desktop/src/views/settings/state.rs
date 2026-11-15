//! Ephemeral client-side UI state owned by the Settings view subtree.
//!
//! Kept isolated under `views::settings` so `AppState` only holds a single
//! `settings_ui: SettingsUiState` slot without requiring shared-core edits as
//! individual settings pages and dialogs evolve.

use std::collections::HashSet;

use rune::TextEdit;
use rune_kit::{ShortcutRecorderState, TreeModel};

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
    pub manage_models_provider_id: Option<String>,
    pub provider_search_edit: TextEdit,
    pub models_search_edit: TextEdit,
    pub api_key_edit: TextEdit,
    pub api_key_revealed: bool,
    pub base_url_edit: TextEdit,
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
    pub mcp_api_key_edit: TextEdit,
    pub marketplace_dialog_open: bool,
    pub marketplace_url_edit: TextEdit,
    pub install_plugin_open: bool,
    pub install_skill_open: bool,
    pub install_target_edit: TextEdit,
    pub selected_plugin_id: Option<String>,
    pub selected_skill_id: Option<String>,
}

impl Default for SettingsUiState {
    fn default() -> Self {
        Self {
            open_select_key: None,
            mobile_nav_open: false,
            quick_chat_recorder: ShortcutRecorderState::default(),
            quick_chat_shortcut_error: None,
            quick_chat_synced_accel: None,
            privacy_disable_all_confirm_open: false,
            privacy_trace_payloads_confirm_open: false,
            diagnostics_status_banner: None,
            last_diagnostics_bundle_path: None,
            developer_restart_onboarding_confirm_open: false,
            developer_overflow_threshold_edit: TextEdit::new("30000"),
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
            manage_models_provider_id: None,
            provider_search_edit: TextEdit::new(""),
            models_search_edit: TextEdit::new(""),
            api_key_edit: TextEdit::new(""),
            api_key_revealed: false,
            base_url_edit: TextEdit::new(""),
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
            mcp_api_key_edit: TextEdit::new(""),
            marketplace_dialog_open: false,
            marketplace_url_edit: TextEdit::new(""),
            install_plugin_open: false,
            install_skill_open: false,
            install_target_edit: TextEdit::new(""),
            selected_plugin_id: None,
            selected_skill_id: None,
        }
    }
}
