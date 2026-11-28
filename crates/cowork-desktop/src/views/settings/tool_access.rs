//! Tool Access settings page (`apps/desktop/src/ui/settings/pages/ToolAccessPage.tsx`).
//!
//! Covers Plugins, Skills & Marketplaces, Custom Connectors (MCP), ChatGPT Apps
//! (feature-gated `openAiNativeConnectors`), and Search provider configuration.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rune::{El, TextEdit, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Dialog, Kit, Select, SelectAppearance, TextArea, TextInput,
};
use serde_json::{Value, json};

use crate::actions::{Action, NavAction, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::{AppState, PluginSummary, ProviderStatusSummary, SkillSummary, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, EntityIconSize, Section, StatusTone, callout_banner,
    cmp_ascii_ci, compact_tabs, confirm_dialog, contains_ascii_ci, entity_icon, mini_switch,
    search_input, settings_page, stat_tile, status_pill,
};
use crate::views::settings::shell::PageContent;
use crate::views::settings::state::ToolAccessTab;
use crate::views::settings::{connectors, icons, mcp_servers};

thread_local! {
    static PARSED_SKILLS_CACHE: RefCell<Option<(u64, Arc<Vec<SkillRowEntry>>)>> =
        const { RefCell::new(None) };
    static PARSED_MARKETPLACES_CACHE: RefCell<Option<(u64, Arc<Vec<MarketplaceItem>>)>> =
        const { RefCell::new(None) };
}

/// Supported workspace search backend identifiers matching `WorkspacesPage.tsx`.
pub const WEB_SEARCH_BACKENDS: &[(&str, &str)] = &[
    ("native", "Provider native"),
    ("exa", "Exa Search"),
    ("parallel", "Parallel Search"),
];

/// Supported local search fallback identifiers when `webSearchBackend == "native"`.
pub const LOCAL_SEARCH_FALLBACKS: &[(&str, &str)] =
    &[("exa", "Exa Search"), ("parallel", "Parallel Search")];

/// Supported Codex web search mode options.
pub const CODEX_WEB_SEARCH_MODES: &[&str] = &["disabled", "cached", "live"];

/// Resolves the effective search provider (`"native" | "exa" | "parallel"`) from `providerOptions`.
pub fn workspace_search_provider(provider_options: Option<&Value>) -> &'static str {
    let codex_backend = provider_options
        .and_then(|v| v.pointer("/codex-cli/webSearchBackend"))
        .and_then(Value::as_str)
        .unwrap_or("native");
    let google_native = provider_options
        .and_then(|v| v.pointer("/google/nativeWebSearch"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if codex_backend == "native" && !google_native {
        workspace_local_search_fallback(provider_options)
    } else {
        match codex_backend {
            "exa" => "exa",
            "parallel" => "parallel",
            _ => "native",
        }
    }
}

/// Resolves the non-Codex fallback local search provider (`"exa" | "parallel"`).
pub fn workspace_local_search_fallback(provider_options: Option<&Value>) -> &'static str {
    match provider_options
        .and_then(|v| v.pointer("/codex-cli/webSearchFallbackBackend"))
        .and_then(Value::as_str)
    {
        Some("parallel") => "parallel",
        _ => "exa",
    }
}

/// Resolves Codex web search mode (`"disabled" | "cached" | "live"`).
pub fn workspace_codex_search_mode(provider_options: Option<&Value>) -> &'static str {
    match provider_options
        .and_then(|v| v.pointer("/codex-cli/webSearchMode"))
        .and_then(Value::as_str)
    {
        Some("disabled") => "disabled",
        Some("live") => "live",
        _ => "cached",
    }
}

/// Produces an updated `providerOptions` map for changing search backend while preserving siblings.
pub fn patch_search_provider(existing: Option<&Value>, backend: &str) -> Value {
    let normalized = match backend {
        "exa" => "exa",
        "parallel" => "parallel",
        _ => "native",
    };
    let mut root = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut codex = root
        .get("codex-cli")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    codex.insert("webSearchBackend".to_string(), json!(normalized));
    root.insert("codex-cli".to_string(), Value::Object(codex));

    let mut google = root
        .get("google")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    google.insert("nativeWebSearch".to_string(), json!(normalized == "native"));
    root.insert("google".to_string(), Value::Object(google));

    Value::Object(root)
}

/// Produces an updated `providerOptions` map for changing local fallback provider.
pub fn patch_local_search_fallback(existing: Option<&Value>, fallback: &str) -> Value {
    let normalized = if fallback == "parallel" {
        "parallel"
    } else {
        "exa"
    };
    patch_codex_option(existing, "webSearchFallbackBackend", json!(normalized))
}

/// Produces an updated `providerOptions` map for changing Codex web search mode.
pub fn patch_codex_search_mode(existing: Option<&Value>, mode: &str) -> Value {
    let normalized = match mode {
        "disabled" => "disabled",
        "live" => "live",
        _ => "cached",
    };
    patch_codex_option(existing, "webSearchMode", json!(normalized))
}

fn patch_codex_option(existing: Option<&Value>, key: &str, value: Value) -> Value {
    let mut root = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut codex = root
        .get("codex-cli")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    codex.insert(key.to_string(), value);
    root.insert("codex-cli".to_string(), Value::Object(codex));
    Value::Object(root)
}

/// Builds JSON params for `cowork/plugins/install`.
pub fn plugin_install_params(source_input: &str, scope: &str) -> Value {
    let target_scope = if scope == "workspace" {
        "workspace"
    } else {
        "user"
    };
    json!({
        "sourceInput": source_input.trim(),
        "targetScope": target_scope,
    })
}

/// Builds JSON params for `cowork/skills/install`.
pub fn skill_install_params(source_input: &str, scope: &str) -> Value {
    let target_scope = if scope == "project" {
        "project"
    } else {
        "global"
    };
    json!({
        "sourceInput": source_input.trim(),
        "targetScope": target_scope,
    })
}

/// Parsed marketplace entry from `AppState::marketplaces`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketplaceItem {
    pub id: String,
    pub display_name: String,
    pub repo: String,
    pub plugin_count: Option<u64>,
    pub skill_count: Option<u64>,
    pub fetch_error: Option<String>,
}

/// Parses `AppState::marketplaces` raw JSON objects into typed summaries.
pub fn parse_marketplaces(raw: &[Value]) -> Vec<MarketplaceItem> {
    raw.iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }
            let repo = v
                .get("repo")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .trim()
                .to_string();
            let display_name = v
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&repo)
                .to_string();
            Some(MarketplaceItem {
                id: id.to_string(),
                display_name,
                repo,
                plugin_count: v.get("pluginCount").and_then(Value::as_u64),
                skill_count: v.get("skillCount").and_then(Value::as_u64),
                fetch_error: v
                    .get("fetchError")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            })
        })
        .collect()
}

fn resolve_target_workspace(s: &AppState) -> Option<&WorkspaceRecord> {
    if let Some(id) = s.active_workspace_id.as_deref()
        && let Some(ws) = s.workspaces.iter().find(|w| w.id == id && !w.archived)
    {
        return Some(ws);
    }
    s.workspaces
        .iter()
        .find(|w| !w.archived && !w.one_off_chat)
        .or_else(|| s.workspaces.iter().find(|w| !w.archived))
        .or_else(|| s.workspaces.first())
}

fn workspace_provider_statuses<'a>(
    s: &'a AppState,
    workspace_id: Option<&str>,
) -> &'a [ProviderStatusSummary] {
    workspace_id
        .and_then(|id| s.workspace_runtime_by_id.get(id))
        .map(|rt| rt.provider_statuses.as_slice())
        .unwrap_or(&[])
}

fn skill_scope_label(scope: &str) -> &'static str {
    match scope {
        "project" | "workspace" => "Workspace",
        "global" => "Cowork Library",
        "user" => "User",
        "built-in" | "builtin" => "Built-in",
        _ => "Other",
    }
}

/// View model representing a single non-plugin skill row or installation in the Skills tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SkillRowEntry {
    pub key: String,
    pub installation_id: Option<String>,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub scope: String,
    pub state: String,
    pub enabled: bool,
    pub writable: bool,
    pub plugin_owned: bool,
    pub update_available: bool,
    pub icon: Option<String>,
    pub source: Option<String>,
    pub diagnostics: Vec<String>,
    pub shadowed_by_scope: Option<String>,
}

impl SkillRowEntry {
    pub fn can_delete(&self) -> bool {
        self.writable
            && !self.plugin_owned
            && !matches!(self.scope.as_str(), "built-in" | "builtin")
    }

    pub fn can_toggle(&self) -> bool {
        self.writable && !self.plugin_owned
    }
}

/// Collects skill rows preferring workspace-scoped `skill_installations` (preserving disabled and
/// shadowed skills and excluding plugin-owned entries) and falling back to workspace-scoped
/// `skills` only when no installation catalog is loaded yet.
#[cfg(test)]
pub(crate) fn collect_visible_skill_rows(s: &AppState) -> Vec<SkillRowEntry> {
    if let Some(ws_id) = s.active_workspace_id.as_deref() {
        return collect_visible_skill_rows_for_workspace(s, ws_id);
    }
    collect_visible_skill_rows_from(&s.skill_installations, &s.skills)
}

fn marketplaces_fingerprint(raw: &[Value]) -> u64 {
    let mut h = DefaultHasher::new();
    raw.len().hash(&mut h);
    for v in raw {
        (
            v.get("id").and_then(Value::as_str),
            v.get("repo").and_then(Value::as_str),
            v.get("displayName").and_then(Value::as_str),
            v.get("pluginCount").and_then(Value::as_u64),
            v.get("skillCount").and_then(Value::as_u64),
            v.get("fetchError").and_then(Value::as_str),
        )
            .hash(&mut h);
    }
    h.finish()
}

fn cached_marketplaces(raw: &[Value]) -> Arc<Vec<MarketplaceItem>> {
    let fp = marketplaces_fingerprint(raw);
    PARSED_MARKETPLACES_CACHE.with(|slot| {
        let mut cache = slot.borrow_mut();
        if let Some((cached_fp, items)) = cache.as_ref()
            && *cached_fp == fp
        {
            return Arc::clone(items);
        }
        let parsed = Arc::new(parse_marketplaces(raw));
        *cache = Some((fp, Arc::clone(&parsed)));
        parsed
    })
}

fn skills_source_fingerprint(
    ws_id: &str,
    skill_installations: &[Value],
    skills: &[SkillSummary],
) -> u64 {
    let mut h = DefaultHasher::new();
    (ws_id, skill_installations.len(), skills.len()).hash(&mut h);
    if !skill_installations.is_empty() {
        for inst in skill_installations {
            (
                inst.get("plugin").is_some_and(|p| !p.is_null()),
                inst.get("installationId").and_then(Value::as_str),
                inst.get("name").and_then(Value::as_str),
                inst.pointer("/interface/displayName")
                    .and_then(Value::as_str),
                inst.pointer("/interface/shortDescription")
                    .and_then(Value::as_str),
                inst.get("description").and_then(Value::as_str),
                inst.get("scope").and_then(Value::as_str),
                inst.get("enabled").and_then(Value::as_bool),
            )
                .hash(&mut h);
            (
                inst.get("writable").and_then(Value::as_bool),
                inst.get("state").and_then(Value::as_str),
                inst.get("updateAvailable").and_then(Value::as_bool),
                inst.get("shadowedByScope").and_then(Value::as_str),
                inst.pointer("/interface/iconSmall").and_then(Value::as_str),
                inst.pointer("/interface/iconLarge").and_then(Value::as_str),
                inst.pointer("/origin/repo").and_then(Value::as_str),
                inst.pointer("/origin/url").and_then(Value::as_str),
                inst.pointer("/origin/sourcePath").and_then(Value::as_str),
                inst.pointer("/origin/kind").and_then(Value::as_str),
            )
                .hash(&mut h);
            if let Some(diags) = inst.get("diagnostics").and_then(Value::as_array) {
                diags.len().hash(&mut h);
                for d in diags {
                    d.get("message").and_then(Value::as_str).hash(&mut h);
                }
            } else {
                0usize.hash(&mut h);
            }
        }
    } else {
        for sk in skills {
            (
                sk.name.as_str(),
                sk.description.as_str(),
                sk.scope.as_str(),
                sk.enabled,
                sk.update_available,
                sk.installation_id.as_deref(),
                sk.source.as_deref(),
                sk.icon.as_deref(),
                sk.error.as_deref(),
            )
                .hash(&mut h);
        }
    }
    h.finish()
}

fn cached_visible_skill_rows_for_workspace(s: &AppState, ws_id: &str) -> Arc<Vec<SkillRowEntry>> {
    let installations = s.skill_installations_for_workspace(ws_id);
    let skills = s.skills_for_workspace(ws_id);
    let fp = if s.skills_rev != 0 {
        let mut h = DefaultHasher::new();
        (ws_id, s.skills_rev, installations.len(), skills.len()).hash(&mut h);
        h.finish()
    } else {
        skills_source_fingerprint(ws_id, installations, skills)
    };
    PARSED_SKILLS_CACHE.with(|slot| {
        let mut cache = slot.borrow_mut();
        if let Some((cached_fp, rows)) = cache.as_ref()
            && *cached_fp == fp
        {
            return Arc::clone(rows);
        }
        let parsed = Arc::new(collect_visible_skill_rows_from(installations, skills));
        *cache = Some((fp, Arc::clone(&parsed)));
        parsed
    })
}

#[cfg(test)]
pub(crate) fn collect_visible_skill_rows_for_workspace(
    s: &AppState,
    ws_id: &str,
) -> Vec<SkillRowEntry> {
    collect_visible_skill_rows_from(
        s.skill_installations_for_workspace(ws_id),
        s.skills_for_workspace(ws_id),
    )
}

fn collect_visible_skill_rows_from(
    skill_installations: &[Value],
    skills: &[SkillSummary],
) -> Vec<SkillRowEntry> {
    let mut rows: Vec<SkillRowEntry> = if !skill_installations.is_empty() {
        skill_installations
            .iter()
            .filter_map(|inst| {
                // Plugin-owned skill installations are managed inside the Plugin detail dialog.
                if inst.get("plugin").is_some_and(|p| !p.is_null()) {
                    return None;
                }
                let name = inst
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())?
                    .to_string();
                let display_name = inst
                    .pointer("/interface/displayName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(&name)
                    .to_string();
                let description = inst
                    .pointer("/interface/shortDescription")
                    .and_then(Value::as_str)
                    .or_else(|| inst.get("description").and_then(Value::as_str))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let scope = inst
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("project")
                    .to_string();
                let enabled = inst.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                let writable = inst
                    .get("writable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let state = inst
                    .get("state")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        if enabled {
                            "effective".to_string()
                        } else {
                            "disabled".to_string()
                        }
                    });
                let installation_id = inst
                    .get("installationId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string);
                let icon = inst
                    .pointer("/interface/iconSmall")
                    .or_else(|| inst.pointer("/interface/iconLarge"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let source = inst
                    .pointer("/origin/repo")
                    .or_else(|| inst.pointer("/origin/url"))
                    .or_else(|| inst.pointer("/origin/sourcePath"))
                    .or_else(|| inst.pointer("/origin/kind"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string);
                let diagnostics = inst
                    .get("diagnostics")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|d| d.get("message").and_then(Value::as_str))
                            .map(str::trim)
                            .filter(|m| !m.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let shadowed_by_scope = inst
                    .get("shadowedByScope")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string);
                let update_available = inst
                    .get("updateAvailable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let key = installation_id
                    .clone()
                    .unwrap_or_else(|| format!("{scope}:{name}"));

                Some(SkillRowEntry {
                    key,
                    installation_id,
                    name,
                    display_name,
                    description,
                    scope,
                    state,
                    enabled,
                    writable,
                    plugin_owned: false,
                    update_available,
                    icon,
                    source,
                    diagnostics,
                    shadowed_by_scope,
                })
            })
            .collect()
    } else {
        skills
            .iter()
            .filter(|sk| sk.source.as_deref() != Some("plugin"))
            .map(|sk| {
                let installation_id = sk
                    .installation_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string);
                let key = installation_id
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", sk.scope, sk.name));
                let writable = !matches!(sk.scope.as_str(), "built-in" | "builtin")
                    && sk.source.as_deref() != Some("built-in");
                SkillRowEntry {
                    key,
                    installation_id,
                    name: sk.name.clone(),
                    display_name: sk.name.clone(),
                    description: sk.description.clone(),
                    scope: sk.scope.clone(),
                    state: if sk.enabled {
                        "effective".to_string()
                    } else {
                        "disabled".to_string()
                    },
                    enabled: sk.enabled,
                    writable,
                    plugin_owned: false,
                    update_available: sk.update_available,
                    icon: sk.icon.clone(),
                    source: sk.source.clone(),
                    diagnostics: sk.error.iter().cloned().collect(),
                    shadowed_by_scope: None,
                }
            })
            .collect()
    };

    rows.sort_by(|left, right| {
        let left_active = usize::from(left.state != "effective");
        let right_active = usize::from(right.state != "effective");
        left_active
            .cmp(&right_active)
            .then_with(|| cmp_ascii_ci(&left.name, &right.name))
            .then_with(|| left.scope.cmp(&right.scope))
            .then_with(|| left.key.cmp(&right.key))
    });
    rows
}

/// Renders `SettingsPageId::ToolAccess` (`Tool Access`).
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let apps_enabled = s
        .feature_flags
        .get("openAiNativeConnectors")
        .copied()
        .unwrap_or(false);

    let intent_tab = s.nav.current().settings_tab.clone();
    let effective_tab = if intent_tab.as_deref() != s.settings_ui.tool_access_synced_tab.as_deref()
    {
        intent_tab
            .as_deref()
            .map(|slug| ToolAccessTab::from_id(slug, apps_enabled))
            .unwrap_or(s.settings_ui.tool_access_tab)
    } else if s.settings_ui.tool_access_tab == ToolAccessTab::Connectors && !apps_enabled {
        ToolAccessTab::Plugins
    } else if s.settings_ui.tool_access_tab == ToolAccessTab::Marketplaces {
        ToolAccessTab::Skills
    } else {
        s.settings_ui.tool_access_tab
    };

    let target_ws = resolve_target_workspace(s);
    let ws_id = target_ws.map(|w| w.id.as_str());

    let mut overlays = Vec::new();
    let mut children = Vec::new();

    if let Some(err) = s
        .settings_mutation_error
        .as_deref()
        .filter(|e| !e.trim().is_empty())
    {
        children.push(
            row()
                .w_full()
                .items_center()
                .gap(8.0)
                .child(el().grow(1.0).min_w(0.0).child(callout_banner(
                    StatusTone::Danger,
                    err,
                    k,
                    t,
                )))
                .child(
                    Button::new("Dismiss")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(|s: &mut AppState| {
                            s.dispatch(Action::Settings(
                                SettingsAction::DismissSettingsMutationError,
                            ));
                        })
                        .build(k),
                ),
        );
    }

    let mut tabs: Vec<(&'static str, ToolAccessTab)> = vec![
        ("Plugins", ToolAccessTab::Plugins),
        ("Skills", ToolAccessTab::Skills),
        ("Connectors", ToolAccessTab::McpServers),
    ];
    if apps_enabled {
        tabs.push(("Apps", ToolAccessTab::Connectors));
    }
    tabs.push(("Search", ToolAccessTab::Search));

    let labels: Vec<&str> = tabs.iter().map(|(lbl, _)| *lbl).collect();
    let active_idx = tabs
        .iter()
        .position(|(_, tab)| *tab == effective_tab)
        .unwrap_or(0);
    let tab_targets: Vec<ToolAccessTab> = tabs.iter().map(|(_, tab)| *tab).collect();

    let tab_strip = compact_tabs(
        &labels,
        active_idx,
        "Tool access tabs",
        move |s: &mut AppState, idx, _tx| {
            if let Some(&picked) = tab_targets.get(idx) {
                s.settings_ui.tool_access_tab = picked;
                s.settings_ui.tool_access_synced_tab = s.nav.current().settings_tab.clone();
            }
        },
        k,
    );

    children.push(tab_strip);

    let tab_body = match effective_tab {
        ToolAccessTab::Plugins => plugins_tab_view(s, ws_id, k, t, &mut overlays),
        ToolAccessTab::Skills | ToolAccessTab::Marketplaces => {
            skills_tab_view(s, ws_id, k, t, &mut overlays)
        }
        ToolAccessTab::McpServers => mcp_servers::view_tab(s, ws_id, k, t, &mut overlays),
        ToolAccessTab::Connectors => connectors::view_tab(s, ws_id, k, t),
        ToolAccessTab::Search => search_tab_view(s, target_ws, k, t, &mut overlays),
    };
    children.push(tab_body);

    let header_actions: Vec<El> = ws_id
        .map(|id| {
            let ws_refresh = id.to_string();
            let on_apps = effective_tab == ToolAccessTab::Connectors;
            Button::new("Refresh")
                .variant(ButtonVariant::Outline)
                .icon(&icons::REFRESH_CCW)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::RefreshPluginsAndSkills {
                        workspace_id: ws_refresh.clone(),
                    }));
                    if on_apps {
                        s.dispatch(Action::Settings(
                            SettingsAction::RefreshOpenAiNativeConnectors {
                                workspace_id: ws_refresh.clone(),
                            },
                        ));
                    }
                })
                .build(k)
        })
        .into_iter()
        .collect();

    PageContent {
        header_actions,
        body: settings_page(children),
        overlays,
    }
}

fn plugins_tab_view(
    s: &AppState,
    ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> El {
    let Some(ws_id) = ws_id else {
        return Section::new()
            .title("Installed plugins")
            .description("Manage plugin packages providing skills and MCP tools.")
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::WRENCH)
                        .description("Select or add a workspace to manage plugins.")
                        .build(k, t),
                ),
            )
            .build(k, t);
    };

    let query = s
        .settings_ui
        .tool_search_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let workspace_plugins = s.plugins_for_workspace(ws_id);
    let workspace_available_plugins = s.available_plugins_for_workspace(ws_id);
    let workspace_plugin_warnings = s.plugin_catalog_warnings_for_workspace(ws_id);
    let mut plugins: Vec<&PluginSummary> = workspace_plugins.iter().collect();
    plugins.sort_by(|a, b| cmp_ascii_ci(a.display_label(), b.display_label()));

    let visible: Vec<&PluginSummary> = plugins
        .iter()
        .copied()
        .filter(|p| {
            if query.is_empty() {
                true
            } else {
                contains_ascii_ci(p.display_label(), &query)
                    || contains_ascii_ci(&p.name, &query)
                    || contains_ascii_ci(&p.description, &query)
                    || contains_ascii_ci(&p.id, &query)
            }
        })
        .collect();

    let mut installed_section = Section::new()
        .title("Installed plugins")
        .description("Toggle plugins on or off or inspect their bundled skills and MCP servers.");
    if !plugins.is_empty() {
        installed_section = installed_section.action(
            Button::new("Install plugin")
                .variant(ButtonVariant::Submit)
                .icon(&icons::PLUS)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.install_target_edit = TextEdit::new("");
                    s.settings_ui.plugin_install_scope = "user".to_string();
                    s.settings_ui.install_plugin_open = true;
                })
                .build(k),
        );
    }

    if !workspace_plugin_warnings.is_empty() {
        installed_section = installed_section.child(el().px(16.0).pt(12.0).child(callout_banner(
            StatusTone::Warning,
            workspace_plugin_warnings.join("\n"),
            k,
            t,
        )));
    }

    if plugins.is_empty() {
        installed_section = installed_section.child(
            el().px(16.0).py(16.0).child(
                EmptyState::new("No plugins installed")
                    .icon(&icons::WRENCH)
                    .description("Install a plugin from a GitHub repository, URL, or local path.")
                    .action(
                        Button::new("Install plugin")
                            .variant(ButtonVariant::Submit)
                            .icon(&icons::PLUS)
                            .control_size(ControlSize::Regular)
                            .on_press(|s: &mut AppState| {
                                s.settings_ui.install_target_edit = TextEdit::new("");
                                s.settings_ui.plugin_install_scope = "user".to_string();
                                s.settings_ui.install_plugin_open = true;
                            })
                            .build(k),
                    )
                    .build(k, t),
            ),
        );
    } else {
        installed_section = installed_section.child(
            row()
                .w_full()
                .items_center()
                .flex_wrap()
                .gap(12.0)
                .px(16.0)
                .py(12.0)
                .child(search_input(
                    &s.settings_ui.tool_search_edit,
                    "Search installed plugins",
                    "Search installed plugins...",
                    Some(300.0),
                    |s: &mut AppState| &mut s.settings_ui.tool_search_edit,
                    |s: &mut AppState, _tx| {
                        s.settings_ui.tool_search_edit = TextEdit::new("");
                    },
                    k,
                ))
                .child(el().grow(1.0))
                .child(status_pill(
                    format!("{} of {}", visible.len(), plugins.len()),
                    StatusTone::Neutral,
                    k,
                    t,
                )),
        );

        if visible.is_empty() {
            installed_section = installed_section.child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No matching plugins")
                        .icon(&icons::SEARCH)
                        .description(format!(
                            "No plugins matched \"{}\".",
                            s.settings_ui.tool_search_edit.text.trim()
                        ))
                        .build(k, t),
                ),
            );
        } else {
            for plugin in visible {
                installed_section =
                    installed_section.child(render_plugin_row(s, plugin, ws_id, k, t));
            }
        }
    }

    append_install_plugin_dialog(s, ws_id, k, t, overlays);
    append_plugin_detail_dialog(s, ws_id, k, t, overlays);
    append_plugin_delete_confirm(s, ws_id, k, overlays);

    let available_entries: Vec<&Value> = workspace_available_plugins
        .iter()
        .filter(|item| item.get("installed").and_then(Value::as_bool) != Some(true))
        .filter(|item| {
            if query.is_empty() {
                true
            } else {
                let name = item
                    .get("displayName")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let desc = item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                contains_ascii_ci(name, &query) || contains_ascii_ci(desc, &query)
            }
        })
        .collect();

    if available_entries.is_empty() {
        return installed_section.build(k, t);
    }

    let mut avail_section = Section::new()
        .title("Available plugins")
        .description("Marketplace plugins ready to install into your library or active workspace.");

    for item in available_entries {
        let display_name = item
            .get("displayName")
            .or_else(|| item.get("name"))
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("Plugin")
            .to_string();
        let desc = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let install_source = item
            .get("installSource")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let marketplace_name = item
            .get("marketplace")
            .and_then(|m| {
                m.get("displayName")
                    .or_else(|| m.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string);

        let mut title_row = row()
            .items_center()
            .gap(8.0)
            .child(text(&display_name).font(k.ty.ui_medium).color(t.text_base));
        if let Some(mkt) = marketplace_name {
            title_row = title_row.child(status_pill(mkt, StatusTone::Neutral, k, t));
        }

        let mut info = col().grow(1.0).min_w(0.0).gap(3.0).child(title_row);
        if !desc.is_empty() {
            info = info.child(text(desc).font(k.ty.small).color(t.text_muted).wrap());
        }

        let action_btn = if let Some(src) = install_source {
            let ws_inst = ws_id.to_string();
            Button::new("Install")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    let params = plugin_install_params(&src, "user");
                    s.dispatch(Action::Settings(SettingsAction::InstallPlugin {
                        workspace_id: ws_inst.clone(),
                        params,
                    }));
                })
                .build(k)
        } else {
            Button::new("Install…")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.install_target_edit = TextEdit::new("");
                    s.settings_ui.install_plugin_open = true;
                })
                .build(k)
        };

        avail_section = avail_section.child(
            row()
                .w_full()
                .min_w(0.0)
                .items_center()
                .justify_between()
                .gap(12.0)
                .px(16.0)
                .py(12.0)
                .child(
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .items_center()
                        .gap(12.0)
                        .child(entity_icon(
                            s,
                            None,
                            &display_name,
                            EntityIconSize::Sm,
                            k,
                            t,
                        ))
                        .child(info),
                )
                .child(action_btn),
        );
    }

    col()
        .w_full()
        .min_w(0.0)
        .gap(20.0)
        .child(installed_section.build(k, t))
        .child(avail_section.build(k, t))
}

fn render_plugin_row(
    s: &AppState,
    plugin: &PluginSummary,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let display_label = plugin.display_label();
    let mut header = row()
        .items_center()
        .gap(8.0)
        .child(text(display_label).font(k.ty.ui_medium).color(t.text_base));
    if plugin.update_available {
        header = header.child(status_pill("Update available", StatusTone::Warning, k, t));
    }
    if !plugin.enabled {
        header = header.child(status_pill("Disabled", StatusTone::Neutral, k, t));
    }

    let scope_txt = if plugin.scope.as_deref() == Some("workspace") {
        "Workspace"
    } else {
        "Library"
    };
    let summary_line = format!(
        "{} skill{} · {} MCP server{} · {}",
        plugin.skill_count,
        if plugin.skill_count == 1 { "" } else { "s" },
        plugin.mcp_count,
        if plugin.mcp_count == 1 { "" } else { "s" },
        scope_txt
    );

    let pid_open = plugin.id.clone();
    let scope_open = plugin.scope.clone();
    let mut info_col = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(3.0)
        .radius(k.radius.md)
        .hover(t.hover)
        .role("button")
        .label(format!("Inspect plugin {display_label}"))
        .on_press(move |s: &mut AppState| {
            s.settings_ui.selected_plugin_id = Some(pid_open.clone());
            s.settings_ui.selected_plugin_scope = scope_open.clone();
        })
        .child(header);
    if !plugin.description.trim().is_empty() {
        info_col = info_col.child(
            text(&plugin.description)
                .font(k.ty.small)
                .color(t.text_muted)
                .wrap(),
        );
    }
    info_col = info_col.child(text(summary_line).font(k.ty.small).color(t.text_muted));

    let ws_toggle = ws_id.to_string();
    let pid_toggle = plugin.id.clone();
    let scope_toggle = plugin.scope.clone();
    let next_enabled = !plugin.enabled;

    let mut actions = row().items_center().gap(8.0).shrink();
    if plugin.update_available {
        let ws_upd = ws_id.to_string();
        let pid_upd = plugin.id.clone();
        let scope_upd = plugin.scope.clone();
        actions = actions.child(
            Button::new("Update")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::UpdatePluginScoped {
                        workspace_id: ws_upd.clone(),
                        id: pid_upd.clone(),
                        scope: scope_upd.clone(),
                    }));
                })
                .build(k),
        );
    }

    actions = actions
        .child(mini_switch(
            plugin.enabled,
            format!("Enable {display_label}"),
            false,
            move |s: &mut AppState| {
                s.dispatch(Action::Settings(SettingsAction::SetPluginEnabledScoped {
                    workspace_id: ws_toggle.clone(),
                    id: pid_toggle.clone(),
                    scope: scope_toggle.clone(),
                    enabled: next_enabled,
                }));
            },
            k,
        ))
        .child(
            Button::new("Details")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press({
                    let pid = plugin.id.clone();
                    let pscope = plugin.scope.clone();
                    move |s: &mut AppState| {
                        s.settings_ui.selected_plugin_id = Some(pid.clone());
                        s.settings_ui.selected_plugin_scope = pscope.clone();
                    }
                })
                .build(k),
        );

    row()
        .w_full()
        .min_w(0.0)
        .items_center()
        .justify_between()
        .gap(12.0)
        .px(16.0)
        .py(12.0)
        .child(
            row()
                .grow(1.0)
                .min_w(0.0)
                .items_center()
                .gap(12.0)
                .child(entity_icon(
                    s,
                    plugin.icon.as_deref(),
                    display_label,
                    EntityIconSize::Md,
                    k,
                    t,
                ))
                .child(info_col),
        )
        .child(actions)
}

fn append_install_plugin_dialog(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    if !s.settings_ui.install_plugin_open {
        return;
    }

    let scope_idx = usize::from(s.settings_ui.plugin_install_scope == "workspace");
    let scope_seg = compact_tabs(
        &["Library (all projects)", "Workspace only"],
        scope_idx,
        "Install plugin scope",
        |s: &mut AppState, idx, _tx| {
            s.settings_ui.plugin_install_scope = if idx == 1 {
                "workspace".to_string()
            } else {
                "user".to_string()
            };
        },
        k,
    );

    let ws_install = ws_id.to_string();
    let can_install = !s.settings_ui.install_target_edit.text.trim().is_empty();

    let body = col()
        .w_full()
        .min_w(0.0)
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(
            text("Install a plugin from a GitHub repo slug, repository URL, or local directory.")
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap(),
        )
        .child(scope_seg)
        .child(
            TextArea::new(&s.settings_ui.install_target_edit)
                .label("Source")
                .placeholder("owner/repo or https://github.com/owner/repo")
                .width(None)
                .rows(2)
                .on_edit(|s: &mut AppState| &mut s.settings_ui.install_target_edit)
                .build(k),
        )
        .child(
            row()
                .w_full()
                .justify_end()
                .gap(8.0)
                .pt(6.0)
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Regular)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.install_plugin_open = false;
                        })
                        .build(k),
                )
                .child(
                    Button::new("Install plugin")
                        .variant(ButtonVariant::Submit)
                        .control_size(ControlSize::Regular)
                        .disabled(!can_install)
                        .on_press(move |s: &mut AppState| {
                            let src = s.settings_ui.install_target_edit.text.trim().to_string();
                            if !src.is_empty() {
                                let params = plugin_install_params(
                                    &src,
                                    &s.settings_ui.plugin_install_scope,
                                );
                                s.dispatch(Action::Settings(SettingsAction::InstallPlugin {
                                    workspace_id: ws_install.clone(),
                                    params,
                                }));
                                s.settings_ui.install_plugin_open = false;
                            }
                        })
                        .build(k),
                ),
        );

    Dialog::new("install-plugin-dialog", "Install plugin")
        .open(true)
        .width(480.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.install_plugin_open = false;
        })
        .child(body)
        .build(k, overlays);
}

fn append_plugin_detail_dialog(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    let Some(plugin_id) = s.settings_ui.selected_plugin_id.as_deref() else {
        return;
    };
    let selected_scope = s.settings_ui.selected_plugin_scope.clone();
    let workspace_plugins = s.plugins_for_workspace(ws_id);
    let Some(plugin) = workspace_plugins
        .iter()
        .find(|p| p.id == plugin_id && (selected_scope.is_none() || p.scope == selected_scope))
        .or_else(|| workspace_plugins.iter().find(|p| p.id == plugin_id))
    else {
        return;
    };

    let stats_row = row()
        .w_full()
        .gap(10.0)
        .child(stat_tile(
            "Skills",
            plugin.skill_count.to_string(),
            None,
            k,
            t,
        ))
        .child(stat_tile(
            "MCP Servers",
            plugin.mcp_count.to_string(),
            None,
            k,
            t,
        ))
        .child(stat_tile(
            "Subagents",
            plugin.subagent_count.to_string(),
            None,
            k,
            t,
        ));

    let display_label = plugin.display_label();
    let mut content = col().w_full().min_w(0.0).px(16.0).pb(16.0).gap(12.0).child(
        row()
            .items_center()
            .gap(10.0)
            .child(entity_icon(
                s,
                plugin.icon.as_deref(),
                display_label,
                EntityIconSize::Lg,
                k,
                t,
            ))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(2.0)
                    .child(text(display_label).font(k.ty.ui_medium).color(t.text_base))
                    .child(text(&plugin.id).font(k.ty.small).color(t.text_muted)),
            ),
    );

    if !plugin.description.trim().is_empty() {
        content = content.child(
            text(&plugin.description)
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap(),
        );
    }

    content = content.child(stats_row);

    if let Some(err) = plugin.error.as_deref().filter(|e| !e.trim().is_empty()) {
        content = content.child(callout_banner(StatusTone::Danger, err, k, t));
    }

    let ws_toggle = ws_id.to_string();
    let pid_toggle = plugin.id.clone();
    let scope_toggle = plugin.scope.clone();
    let next_enabled = !plugin.enabled;
    let pid_delete = plugin.id.clone();
    let scope_delete = plugin.scope.clone();

    let mut footer = row()
        .w_full()
        .justify_between()
        .items_center()
        .gap(8.0)
        .pt(6.0)
        .child(
            Button::new("Remove plugin")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.settings_ui.selected_plugin_id = None;
                    s.settings_ui.selected_plugin_scope = None;
                    s.settings_ui.plugin_delete_confirm_scoped =
                        Some((pid_delete.clone(), scope_delete.clone()));
                })
                .build(k),
        );

    let mut right_actions = row().items_center().gap(8.0);
    if plugin.update_available {
        let ws_upd = ws_id.to_string();
        let pid_upd = plugin.id.clone();
        let scope_upd = plugin.scope.clone();
        right_actions = right_actions.child(
            Button::new("Update")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::UpdatePluginScoped {
                        workspace_id: ws_upd.clone(),
                        id: pid_upd.clone(),
                        scope: scope_upd.clone(),
                    }));
                })
                .build(k),
        );
    }
    right_actions = right_actions
        .child(
            Button::new(if plugin.enabled { "Disable" } else { "Enable" })
                .variant(ButtonVariant::Submit)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::SetPluginEnabledScoped {
                        workspace_id: ws_toggle.clone(),
                        id: pid_toggle.clone(),
                        scope: scope_toggle.clone(),
                        enabled: next_enabled,
                    }));
                })
                .build(k),
        )
        .child(
            Button::new("Close")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.selected_plugin_id = None;
                    s.settings_ui.selected_plugin_scope = None;
                })
                .build(k),
        );
    footer = footer.child(right_actions);

    content = content.child(footer);

    Dialog::new("plugin-detail-dialog", "Plugin details")
        .open(true)
        .width(500.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.selected_plugin_id = None;
            s.settings_ui.selected_plugin_scope = None;
        })
        .child(content)
        .build(k, overlays);
}

fn append_plugin_delete_confirm(s: &AppState, ws_id: &str, k: &Kit, overlays: &mut Vec<El>) {
    let Some((plugin_id, plugin_scope)) = s.settings_ui.plugin_delete_confirm_scoped.as_ref()
    else {
        return;
    };
    let display = s
        .plugins_for_workspace(ws_id)
        .iter()
        .find(|p| p.id == *plugin_id && (plugin_scope.is_none() || p.scope == *plugin_scope))
        .or_else(|| {
            s.plugins_for_workspace(ws_id)
                .iter()
                .find(|p| p.id == *plugin_id)
        })
        .map(PluginSummary::display_label)
        .unwrap_or(plugin_id.as_str());
    let ws_del = ws_id.to_string();
    let pid_del = plugin_id.clone();
    let scope_del = plugin_scope.clone();
    confirm_dialog(
        ConfirmDialogSpec {
            key: "plugin-delete-confirm",
            title: "Uninstall plugin",
            description: format!(
                "Remove plugin \"{display}\"? Skills and MCP tools provided by this plugin will stop working."
            ),
            confirm_label: "Uninstall",
            danger: true,
            open: true,
        },
        |s| {
            s.settings_ui.plugin_delete_confirm_scoped = None;
        },
        move |s| {
            s.dispatch(Action::Settings(SettingsAction::DeletePluginScoped {
                workspace_id: ws_del.clone(),
                id: pid_del.clone(),
                scope: scope_del.clone(),
            }));
            s.settings_ui.plugin_delete_confirm_scoped = None;
        },
        k,
        overlays,
    );
}

fn skills_tab_view(
    s: &AppState,
    ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> El {
    let Some(ws_id) = ws_id else {
        return Section::new()
            .title("Skills & marketplaces")
            .description("Manage skills available to Cowork and configure marketplace catalogs.")
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::WRENCH)
                        .description("Select or add a workspace to manage skills and marketplaces.")
                        .build(k, t),
                ),
            )
            .build(k, t);
    };

    let query = s
        .settings_ui
        .tool_search_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let skills = cached_visible_skill_rows_for_workspace(s, ws_id);

    let visible: Vec<&SkillRowEntry> = skills
        .iter()
        .filter(|sk| {
            if query.is_empty() {
                true
            } else {
                contains_ascii_ci(&sk.display_name, &query)
                    || contains_ascii_ci(&sk.name, &query)
                    || contains_ascii_ci(&sk.description, &query)
            }
        })
        .collect();

    let mut skills_section = Section::new()
        .title("Installed skills")
        .description("Enable, disable, inspect, or remove installed agent skills.");
    if !skills.is_empty() {
        skills_section = skills_section.action(
            Button::new("Install skill")
                .variant(ButtonVariant::Submit)
                .icon(&icons::PLUS)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.install_target_edit = TextEdit::new("");
                    s.settings_ui.skill_install_scope = "global".to_string();
                    s.settings_ui.install_skill_open = true;
                })
                .build(k),
        );
    }

    if skills.is_empty() {
        skills_section = skills_section.child(
            el().px(16.0).py(16.0).child(
                EmptyState::new("No skills installed")
                    .icon(&icons::WRENCH)
                    .description(
                        "Install a skill from GitHub, a URL, or a local SKILL.md directory.",
                    )
                    .action(
                        Button::new("Install skill")
                            .variant(ButtonVariant::Submit)
                            .icon(&icons::PLUS)
                            .control_size(ControlSize::Regular)
                            .on_press(|s: &mut AppState| {
                                s.settings_ui.install_target_edit = TextEdit::new("");
                                s.settings_ui.skill_install_scope = "global".to_string();
                                s.settings_ui.install_skill_open = true;
                            })
                            .build(k),
                    )
                    .build(k, t),
            ),
        );
    } else {
        skills_section = skills_section.child(
            row()
                .w_full()
                .items_center()
                .flex_wrap()
                .gap(12.0)
                .px(16.0)
                .py(12.0)
                .child(search_input(
                    &s.settings_ui.tool_search_edit,
                    "Search skills",
                    "Search skills...",
                    Some(300.0),
                    |s: &mut AppState| &mut s.settings_ui.tool_search_edit,
                    |s: &mut AppState, _tx| {
                        s.settings_ui.tool_search_edit = TextEdit::new("");
                    },
                    k,
                ))
                .child(el().grow(1.0))
                .child(status_pill(
                    format!("{} of {}", visible.len(), skills.len()),
                    StatusTone::Neutral,
                    k,
                    t,
                )),
        );

        if visible.is_empty() {
            skills_section = skills_section.child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No matching skills")
                        .icon(&icons::SEARCH)
                        .description(format!(
                            "No skills matched \"{}\".",
                            s.settings_ui.tool_search_edit.text.trim()
                        ))
                        .build(k, t),
                ),
            );
        } else {
            for sk in visible {
                skills_section = skills_section.child(render_skill_row(s, sk, ws_id, k, t));
            }
        }
    }

    let marketplaces = cached_marketplaces(&s.marketplaces);
    let add_mkt_btn = Button::new("+ Add marketplace")
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Small)
        .on_press(|s: &mut AppState| {
            s.settings_ui.marketplace_url_edit = TextEdit::new("");
            s.settings_ui.marketplace_dialog_open = true;
        })
        .build(k);

    let mut mkt_section = Section::new()
        .title("Marketplace sources")
        .description("Catalogs Cowork can install plugins and skills from.")
        .action(add_mkt_btn);

    if marketplaces.is_empty() {
        mkt_section = mkt_section.child(
            el().px(16.0).py(16.0).child(
                EmptyState::new("No marketplaces configured")
                    .icon(&icons::SEARCH)
                    .description(
                        "Add a GitHub repository or URL containing a Cowork marketplace index.",
                    )
                    .build(k, t),
            ),
        );
    } else {
        for mkt in marketplaces.iter() {
            let mut meta_parts = vec![mkt.repo.clone()];
            if let Some(p) = mkt.plugin_count {
                meta_parts.push(format!("{p} plugin{}", if p == 1 { "" } else { "s" }));
            }
            if let Some(sk) = mkt.skill_count {
                meta_parts.push(format!("{sk} skill{}", if sk == 1 { "" } else { "s" }));
            }

            let mut info = col()
                .grow(1.0)
                .min_w(0.0)
                .gap(3.0)
                .child(
                    text(&mkt.display_name)
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(
                    text(meta_parts.join(" · "))
                        .font(k.ty.small)
                        .color(t.text_muted),
                );
            if let Some(err) = mkt.fetch_error.as_deref() {
                info = info.child(text(err).font(k.ty.small).color(t.danger).wrap());
            }

            let mkt_id_rm = mkt.id.clone();
            let mkt_name_rm = mkt.display_name.clone();
            let row_el = row()
                .w_full()
                .min_w(0.0)
                .items_center()
                .justify_between()
                .gap(12.0)
                .px(16.0)
                .py(12.0)
                .child(info)
                .child(
                    Button::new("Remove")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.settings_ui.marketplace_remove_confirm =
                                Some((mkt_id_rm.clone(), mkt_name_rm.clone()));
                        })
                        .build(k),
                );
            mkt_section = mkt_section.child(row_el);
        }
    }

    let available_skills: Vec<&Value> = s
        .available_skills_for_workspace(ws_id)
        .iter()
        .filter(|item| item.get("installed").and_then(Value::as_bool) != Some(true))
        .filter(|item| {
            if query.is_empty() {
                true
            } else {
                let name = item
                    .get("displayName")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let desc = item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                contains_ascii_ci(name, &query) || contains_ascii_ci(desc, &query)
            }
        })
        .collect();

    append_install_skill_dialog(s, ws_id, k, t, overlays);
    append_skill_detail_dialog(s, ws_id, &skills, k, t, overlays);
    append_skill_delete_confirm(s, ws_id, k, overlays);
    append_add_marketplace_dialog(s, ws_id, k, t, overlays);
    append_marketplace_remove_confirm(s, ws_id, k, overlays);

    let mut stack = col()
        .w_full()
        .min_w(0.0)
        .gap(20.0)
        .child(skills_section.build(k, t));

    if !available_skills.is_empty() {
        let mut avail_section = Section::new()
            .title("Available skills")
            .description("Marketplace skills ready to install globally or per project.");
        for item in available_skills {
            let display_name = item
                .get("displayName")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("Skill")
                .to_string();
            let desc = item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let install_source = item
                .get("installSource")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string);
            let mkt_name = item
                .get("marketplace")
                .and_then(|m| {
                    m.get("displayName")
                        .or_else(|| m.get("name"))
                        .and_then(Value::as_str)
                })
                .map(str::to_string);

            let mut title_row = row()
                .items_center()
                .gap(8.0)
                .child(text(&display_name).font(k.ty.ui_medium).color(t.text_base));
            if let Some(mkt) = mkt_name {
                title_row = title_row.child(status_pill(mkt, StatusTone::Neutral, k, t));
            }
            let mut info = col().grow(1.0).min_w(0.0).gap(3.0).child(title_row);
            if !desc.is_empty() {
                info = info.child(text(desc).font(k.ty.small).color(t.text_muted).wrap());
            }
            let install_action = if let Some(src) = install_source {
                let ws_inst = ws_id.to_string();
                Button::new("Install")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        let params = skill_install_params(&src, "global");
                        s.dispatch(Action::Settings(SettingsAction::InstallSkill {
                            workspace_id: ws_inst.clone(),
                            params,
                        }));
                    })
                    .build(k)
            } else {
                Button::new("Install…")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.install_target_edit = TextEdit::new("");
                        s.settings_ui.install_skill_open = true;
                    })
                    .build(k)
            };
            avail_section = avail_section.child(
                row()
                    .w_full()
                    .min_w(0.0)
                    .items_center()
                    .justify_between()
                    .gap(12.0)
                    .px(16.0)
                    .py(12.0)
                    .child(
                        row()
                            .grow(1.0)
                            .min_w(0.0)
                            .items_center()
                            .gap(12.0)
                            .child(entity_icon(
                                s,
                                None,
                                &display_name,
                                EntityIconSize::Sm,
                                k,
                                t,
                            ))
                            .child(info),
                    )
                    .child(install_action),
            );
        }
        stack = stack.child(avail_section.build(k, t));
    }

    stack.child(mkt_section.build(k, t))
}

fn render_skill_row(s: &AppState, sk: &SkillRowEntry, ws_id: &str, k: &Kit, t: &ThemeTokens) -> El {
    let mut header = row()
        .items_center()
        .gap(8.0)
        .child(
            text(&sk.display_name)
                .font(k.ty.ui_medium)
                .color(t.text_base),
        )
        .child(status_pill(
            skill_scope_label(&sk.scope),
            StatusTone::Neutral,
            k,
            t,
        ));
    if !sk.writable {
        header = header.child(status_pill("Read-only", StatusTone::Neutral, k, t));
    }
    match sk.state.as_str() {
        "effective" => {
            if !sk.enabled {
                header = header.child(status_pill("Disabled", StatusTone::Neutral, k, t));
            }
        }
        "disabled" => {
            header = header.child(status_pill("Disabled", StatusTone::Neutral, k, t));
        }
        "shadowed" => {
            header = header.child(status_pill("Shadowed", StatusTone::Neutral, k, t));
        }
        "invalid" => {
            header = header.child(status_pill("Invalid", StatusTone::Danger, k, t));
        }
        _ => {}
    }
    if sk.update_available {
        header = header.child(status_pill("Update available", StatusTone::Warning, k, t));
    }

    let skill_select = sk.key.clone();
    let mut info = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(3.0)
        .radius(k.radius.md)
        .hover(t.hover)
        .role("button")
        .label(format!("Inspect skill {}", sk.display_name))
        .on_press(move |s: &mut AppState| {
            s.settings_ui.selected_skill_id = Some(skill_select.clone());
        })
        .child(header);
    if !sk.description.trim().is_empty() {
        info = info.child(
            text(&sk.description)
                .font(k.ty.small)
                .color(t.text_muted)
                .wrap(),
        );
    }

    let ws_toggle = ws_id.to_string();
    let name_toggle = sk.name.clone();
    let inst_id = sk.installation_id.clone();
    let inst_id_toggle = inst_id.clone();
    let next_enabled = !sk.enabled;
    let can_toggle = sk.can_toggle();

    let mut actions = row().items_center().gap(8.0).shrink();
    if sk.can_delete()
        && sk.update_available
        && let Some(inst_upd) = inst_id.clone()
    {
        let ws_upd = ws_id.to_string();
        actions = actions.child(
            Button::new("Update")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::UpdateSkillInstallation {
                        workspace_id: ws_upd.clone(),
                        installation_id: inst_upd.clone(),
                    }));
                })
                .build(k),
        );
    }

    actions = actions
        .child(mini_switch(
            sk.enabled,
            format!("Enable {}", sk.display_name),
            !can_toggle,
            move |s: &mut AppState| {
                if let Some(id) = inst_id_toggle.as_ref() {
                    s.dispatch(Action::Settings(
                        SettingsAction::SetSkillInstallationEnabled {
                            workspace_id: ws_toggle.clone(),
                            installation_id: id.clone(),
                            enabled: next_enabled,
                        },
                    ));
                } else {
                    s.dispatch(Action::Settings(SettingsAction::SetSkillEnabled {
                        workspace_id: ws_toggle.clone(),
                        name: name_toggle.clone(),
                        enabled: next_enabled,
                    }));
                }
            },
            k,
        ))
        .child(
            Button::new("Details")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press({
                    let sk_key = sk.key.clone();
                    move |s: &mut AppState| {
                        s.settings_ui.selected_skill_id = Some(sk_key.clone());
                    }
                })
                .build(k),
        );

    if sk.can_delete() {
        let sk_del = sk.name.clone();
        let inst_del = inst_id;
        actions = actions.child(
            Button::new("Delete")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    if let Some(id) = inst_del.as_ref() {
                        s.settings_ui.skill_delete_confirm_inst =
                            Some((id.clone(), sk_del.clone()));
                    } else {
                        s.settings_ui.skill_delete_confirm = Some(sk_del.clone());
                    }
                })
                .build(k),
        );
    }

    row()
        .w_full()
        .min_w(0.0)
        .items_center()
        .justify_between()
        .gap(12.0)
        .px(16.0)
        .py(12.0)
        .child(
            row()
                .grow(1.0)
                .min_w(0.0)
                .items_center()
                .gap(12.0)
                .child(entity_icon(
                    s,
                    sk.icon.as_deref(),
                    &sk.display_name,
                    EntityIconSize::Md,
                    k,
                    t,
                ))
                .child(info),
        )
        .child(actions)
}

fn append_install_skill_dialog(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    if !s.settings_ui.install_skill_open {
        return;
    }

    let scope_idx = usize::from(s.settings_ui.skill_install_scope == "project");
    let scope_seg = compact_tabs(
        &["Cowork Library", "This workspace"],
        scope_idx,
        "Install skill scope",
        |s: &mut AppState, idx, _tx| {
            s.settings_ui.skill_install_scope = if idx == 1 {
                "project".to_string()
            } else {
                "global".to_string()
            };
        },
        k,
    );

    let ws_install = ws_id.to_string();
    let can_install = !s.settings_ui.install_target_edit.text.trim().is_empty();

    let body = col()
        .w_full()
        .min_w(0.0)
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(
            text("Install a skill from GitHub (owner/repo), a URL, or a local folder containing SKILL.md.")
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap(),
        )
        .child(scope_seg)
        .child(
            TextArea::new(&s.settings_ui.install_target_edit)
                .label("Source")
                .placeholder("owner/repo or https://github.com/owner/repo")
                .width(None)
                .rows(2)
                .on_edit(|s: &mut AppState| &mut s.settings_ui.install_target_edit)
                .build(k),
        )
        .child(
            row()
                .w_full()
                .justify_end()
                .gap(8.0)
                .pt(6.0)
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Regular)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.install_skill_open = false;
                        })
                        .build(k),
                )
                .child(
                    Button::new("Install skill")
                        .variant(ButtonVariant::Submit)
                        .control_size(ControlSize::Regular)
                        .disabled(!can_install)
                        .on_press(move |s: &mut AppState| {
                            let src = s.settings_ui.install_target_edit.text.trim().to_string();
                            if !src.is_empty() {
                                let params =
                                    skill_install_params(&src, &s.settings_ui.skill_install_scope);
                                s.dispatch(Action::Settings(SettingsAction::InstallSkill {
                                    workspace_id: ws_install.clone(),
                                    params,
                                }));
                                s.settings_ui.install_skill_open = false;
                            }
                        })
                        .build(k),
                ),
        );

    Dialog::new("install-skill-dialog", "Install skill")
        .open(true)
        .width(480.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.install_skill_open = false;
        })
        .child(body)
        .build(k, overlays);
}

fn append_skill_detail_dialog(
    s: &AppState,
    ws_id: &str,
    rows: &[SkillRowEntry],
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    let Some(selected_key) = s.settings_ui.selected_skill_id.as_deref() else {
        return;
    };
    let Some(sk) = rows
        .iter()
        .find(|entry| entry.key == selected_key || entry.name == selected_key)
    else {
        return;
    };

    let ws_toggle = ws_id.to_string();
    let sk_toggle = sk.name.clone();
    let next_enabled = !sk.enabled;
    let can_delete = sk.can_delete();
    let can_toggle = sk.can_toggle();
    let sk_del = sk.name.clone();
    let state_label = match sk.state.as_str() {
        "effective" => "Active",
        "disabled" => "Disabled",
        "shadowed" => "Shadowed",
        "invalid" => "Invalid",
        other => other,
    };
    let state_tone = match sk.state.as_str() {
        "effective" => StatusTone::Success,
        "invalid" => StatusTone::Danger,
        _ => StatusTone::Neutral,
    };

    let mut content = col().w_full().min_w(0.0).px(16.0).pb(16.0).gap(12.0).child(
        row()
            .items_center()
            .gap(10.0)
            .child(entity_icon(
                s,
                sk.icon.as_deref(),
                &sk.display_name,
                EntityIconSize::Lg,
                k,
                t,
            ))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(4.0)
                    .child(
                        text(&sk.display_name)
                            .font(k.ty.ui_medium)
                            .color(t.text_base),
                    )
                    .child(
                        row()
                            .items_center()
                            .gap(6.0)
                            .child(status_pill(
                                skill_scope_label(&sk.scope),
                                StatusTone::Neutral,
                                k,
                                t,
                            ))
                            .child(status_pill(state_label, state_tone, k, t))
                            .child(status_pill(
                                if sk.writable { "Writable" } else { "Read-only" },
                                StatusTone::Neutral,
                                k,
                                t,
                            )),
                    ),
            ),
    );

    if !sk.description.trim().is_empty() {
        content = content.child(
            text(&sk.description)
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap(),
        );
    }
    if let Some(shadowed_by) = sk.shadowed_by_scope.as_deref() {
        content = content.child(callout_banner(
            StatusTone::Warning,
            format!(
                "Shadowed by a higher-precedence {} installation.",
                skill_scope_label(shadowed_by)
            ),
            k,
            t,
        ));
    }
    for diag in &sk.diagnostics {
        content = content.child(callout_banner(StatusTone::Danger, diag, k, t));
    }
    if let Some(src) = sk.source.as_deref().filter(|v| !v.trim().is_empty()) {
        content = content.child(
            text(format!("Source: {src}"))
                .font(k.ty.small)
                .color(t.text_muted)
                .wrap(),
        );
    }

    let inst_detail_id = sk.installation_id.clone();
    let mut footer = row()
        .w_full()
        .justify_between()
        .items_center()
        .gap(8.0)
        .pt(6.0);
    if can_delete {
        let inst_del = inst_detail_id.clone();
        footer = footer.child(
            Button::new("Delete")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.settings_ui.selected_skill_id = None;
                    if let Some(id) = inst_del.as_ref() {
                        s.settings_ui.skill_delete_confirm_inst =
                            Some((id.clone(), sk_del.clone()));
                    } else {
                        s.settings_ui.skill_delete_confirm = Some(sk_del.clone());
                    }
                })
                .build(k),
        );
    } else {
        footer = footer.child(el());
    }
    let inst_toggle = inst_detail_id;
    let mut right_actions = row().items_center().gap(8.0);
    if can_delete
        && sk.update_available
        && let Some(inst_upd) = inst_toggle.clone()
    {
        let ws_upd = ws_id.to_string();
        right_actions = right_actions.child(
            Button::new("Update")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::UpdateSkillInstallation {
                        workspace_id: ws_upd.clone(),
                        installation_id: inst_upd.clone(),
                    }));
                })
                .build(k),
        );
    }
    if can_toggle {
        right_actions = right_actions.child(
            Button::new(if sk.enabled { "Disable" } else { "Enable" })
                .variant(ButtonVariant::Submit)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    if let Some(id) = inst_toggle.as_ref() {
                        s.dispatch(Action::Settings(
                            SettingsAction::SetSkillInstallationEnabled {
                                workspace_id: ws_toggle.clone(),
                                installation_id: id.clone(),
                                enabled: next_enabled,
                            },
                        ));
                    } else {
                        s.dispatch(Action::Settings(SettingsAction::SetSkillEnabled {
                            workspace_id: ws_toggle.clone(),
                            name: sk_toggle.clone(),
                            enabled: next_enabled,
                        }));
                    }
                })
                .build(k),
        );
    }
    right_actions = right_actions.child(
        Button::new("Close")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Regular)
            .on_press(|s: &mut AppState| {
                s.settings_ui.selected_skill_id = None;
            })
            .build(k),
    );
    footer = footer.child(right_actions);
    content = content.child(footer);

    Dialog::new("skill-detail-dialog", "Skill details")
        .open(true)
        .width(480.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.selected_skill_id = None;
        })
        .child(content)
        .build(k, overlays);
}

fn append_skill_delete_confirm(s: &AppState, ws_id: &str, k: &Kit, overlays: &mut Vec<El>) {
    if let Some((inst_id, label)) = s.settings_ui.skill_delete_confirm_inst.clone() {
        let ws_del = ws_id.to_string();
        confirm_dialog(
            ConfirmDialogSpec {
                key: "skill-delete-confirm",
                title: "Delete skill",
                description: format!(
                    "Delete skill \"{label}\"? This removes it from the active scope."
                ),
                confirm_label: "Delete",
                danger: true,
                open: true,
            },
            |s| {
                s.settings_ui.skill_delete_confirm_inst = None;
            },
            move |s| {
                s.dispatch(Action::Settings(SettingsAction::DeleteSkillInstallation {
                    workspace_id: ws_del.clone(),
                    installation_id: inst_id.clone(),
                }));
                s.settings_ui.skill_delete_confirm_inst = None;
            },
            k,
            overlays,
        );
        return;
    }
    let Some(name) = s.settings_ui.skill_delete_confirm.as_deref() else {
        return;
    };
    let ws_del = ws_id.to_string();
    let sk_del = name.to_string();
    confirm_dialog(
        ConfirmDialogSpec {
            key: "skill-delete-confirm",
            title: "Delete skill",
            description: format!("Delete skill \"{name}\"? This removes it from the active scope."),
            confirm_label: "Delete",
            danger: true,
            open: true,
        },
        |s| {
            s.settings_ui.skill_delete_confirm = None;
        },
        move |s| {
            s.dispatch(Action::Settings(SettingsAction::DeleteSkill {
                workspace_id: ws_del.clone(),
                name: sk_del.clone(),
            }));
            s.settings_ui.skill_delete_confirm = None;
        },
        k,
        overlays,
    );
}

fn append_add_marketplace_dialog(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    if !s.settings_ui.marketplace_dialog_open {
        return;
    }
    let ws_add = ws_id.to_string();
    let can_add = !s.settings_ui.marketplace_url_edit.text.trim().is_empty();

    let body = col()
        .w_full()
        .min_w(0.0)
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(
            text("Add a GitHub repo (owner/repo) or marketplace URL to browse installable skills and plugins.")
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap(),
        )
        .child(
            TextInput::new(&s.settings_ui.marketplace_url_edit)
                .label("Marketplace source")
                .placeholder("owner/repo or https://github.com/owner/repo")
                .width(None)
                .on_edit(|s: &mut AppState| &mut s.settings_ui.marketplace_url_edit)
                .build(k),
        )
        .child(
            row()
                .w_full()
                .justify_end()
                .gap(8.0)
                .pt(6.0)
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Regular)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.marketplace_dialog_open = false;
                        })
                        .build(k),
                )
                .child(
                    Button::new("Add marketplace")
                        .variant(ButtonVariant::Submit)
                        .control_size(ControlSize::Regular)
                        .disabled(!can_add)
                        .on_press(move |s: &mut AppState| {
                            let url = s.settings_ui.marketplace_url_edit.text.trim().to_string();
                            if !url.is_empty() {
                                s.dispatch(Action::Settings(SettingsAction::AddMarketplace {
                                    workspace_id: ws_add.clone(),
                                    url,
                                }));
                                s.settings_ui.marketplace_dialog_open = false;
                            }
                        })
                        .build(k),
                ),
        );

    Dialog::new("add-marketplace-dialog", "Add marketplace")
        .open(true)
        .width(460.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.marketplace_dialog_open = false;
        })
        .child(body)
        .build(k, overlays);
}

fn append_marketplace_remove_confirm(s: &AppState, ws_id: &str, k: &Kit, overlays: &mut Vec<El>) {
    let Some((mkt_id, mkt_name)) = s.settings_ui.marketplace_remove_confirm.as_ref() else {
        return;
    };
    let ws_rm = ws_id.to_string();
    let id_rm = mkt_id.clone();
    confirm_dialog(
        ConfirmDialogSpec {
            key: "marketplace-remove-confirm",
            title: "Remove marketplace",
            description: format!(
                "Remove marketplace \"{mkt_name}\"? Already installed items stay intact."
            ),
            confirm_label: "Remove",
            danger: true,
            open: true,
        },
        |s| {
            s.settings_ui.marketplace_remove_confirm = None;
        },
        move |s| {
            s.dispatch(Action::Settings(SettingsAction::RemoveMarketplace {
                workspace_id: ws_rm.clone(),
                id: id_rm.clone(),
            }));
            s.settings_ui.marketplace_remove_confirm = None;
        },
        k,
        overlays,
    );
}

fn search_tab_view(
    s: &AppState,
    target_ws: Option<&WorkspaceRecord>,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> El {
    let Some(ws) = target_ws else {
        return Section::new()
            .title("Search")
            .description(
                "Choose provider-native search or a local search tool for models that need one.",
            )
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::SEARCH)
                        .description("Open or add a workspace to configure web search defaults.")
                        .build(k, t),
                ),
            )
            .build(k, t);
    };

    let current_backend = workspace_search_provider(ws.provider_options.as_ref());
    let uses_native = current_backend == "native";
    let local_fallback = workspace_local_search_fallback(ws.provider_options.as_ref());
    let codex_mode = workspace_codex_search_mode(ws.provider_options.as_ref());

    let backend_labels: Vec<&str> = WEB_SEARCH_BACKENDS.iter().map(|(_, lbl)| *lbl).collect();
    let backend_current = WEB_SEARCH_BACKENDS
        .iter()
        .find(|(id, _)| *id == current_backend)
        .map(|(_, lbl)| *lbl)
        .unwrap_or("Provider native");

    let backend_open =
        s.settings_ui.open_select_key.as_deref() == Some("tool-access-search-backend");
    let ws_id_backend = ws.id.clone();
    let backend_select = Select::new("tool-access-search-backend", &backend_labels)
        .label("Web search provider")
        .appearance(SelectAppearance::Field)
        .width(220.0)
        .current(Some(backend_current))
        .open(backend_open)
        .on_toggle(|s: &mut AppState| {
            let open =
                s.settings_ui.open_select_key.as_deref() == Some("tool-access-search-backend");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("tool-access-search-backend".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("tool-access-search-backend") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            if let Some((backend_id, _)) =
                WEB_SEARCH_BACKENDS.iter().find(|(_, lbl)| *lbl == chosen)
            {
                let existing_opts = s
                    .workspaces
                    .iter()
                    .find(|w| w.id == ws_id_backend)
                    .and_then(|w| w.provider_options.as_ref());
                let next_opts = patch_search_provider(existing_opts, backend_id);
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_id_backend.clone(),
                    defaults: json!({ "providerOptions": next_opts }),
                }));
            }
        })
        .build(k, overlays);

    let mut search_section = Section::new()
        .title("Search")
        .description(
            "Choose provider-native search or a local search tool for models that need one.",
        )
        .child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .gap(16.0)
                .px(16.0)
                .py(14.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(3.0)
                        .child(
                            text("Search provider")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(
                            text(if uses_native {
                                "Use provider-native search when the active model supports it."
                            } else {
                                "Use the local webSearch tool for models without built-in search."
                            })
                            .font(k.ty.small)
                            .color(t.text_muted)
                            .wrap(),
                        ),
                )
                .child(backend_select),
        );

    if uses_native {
        let fb_labels: Vec<&str> = LOCAL_SEARCH_FALLBACKS.iter().map(|(_, lbl)| *lbl).collect();
        let fb_current = LOCAL_SEARCH_FALLBACKS
            .iter()
            .find(|(id, _)| *id == local_fallback)
            .map(|(_, lbl)| *lbl)
            .unwrap_or("Exa Search");
        let fb_open =
            s.settings_ui.open_select_key.as_deref() == Some("tool-access-search-fallback");
        let ws_id_fb = ws.id.clone();
        let fb_select = Select::new("tool-access-search-fallback", &fb_labels)
            .label("Fallback local search tool")
            .appearance(SelectAppearance::Field)
            .width(220.0)
            .current(Some(fb_current))
            .open(fb_open)
            .on_toggle(|s: &mut AppState| {
                let open =
                    s.settings_ui.open_select_key.as_deref() == Some("tool-access-search-fallback");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("tool-access-search-fallback".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("tool-access-search-fallback") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(move |s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                if let Some((fb_id, _)) = LOCAL_SEARCH_FALLBACKS
                    .iter()
                    .find(|(_, lbl)| *lbl == chosen)
                {
                    let existing_opts = s
                        .workspaces
                        .iter()
                        .find(|w| w.id == ws_id_fb)
                        .and_then(|w| w.provider_options.as_ref());
                    let next_opts = patch_local_search_fallback(existing_opts, fb_id);
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_id_fb.clone(),
                        defaults: json!({ "providerOptions": next_opts }),
                    }));
                }
            })
            .build(k, overlays);

        search_section = search_section.child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .gap(16.0)
                .px(16.0)
                .py(14.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(3.0)
                        .child(
                            text("Fallback local search tool")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(
                            text("Used for non-Codex models without provider-native web search.")
                                .font(k.ty.small)
                                .color(t.text_muted)
                                .wrap(),
                        ),
                )
                .child(fb_select),
        );
    }

    let mode_open = s.settings_ui.open_select_key.as_deref() == Some("tool-access-codex-mode");
    let ws_id_mode = ws.id.clone();
    let mode_select = Select::new("tool-access-codex-mode", CODEX_WEB_SEARCH_MODES)
        .label("Codex web search mode")
        .appearance(SelectAppearance::Field)
        .width(220.0)
        .disabled(!uses_native)
        .current(Some(codex_mode))
        .open(mode_open)
        .on_toggle(|s: &mut AppState| {
            let open = s.settings_ui.open_select_key.as_deref() == Some("tool-access-codex-mode");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("tool-access-codex-mode".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("tool-access-codex-mode") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            let existing_opts = s
                .workspaces
                .iter()
                .find(|w| w.id == ws_id_mode)
                .and_then(|w| w.provider_options.as_ref());
            let next_opts = patch_codex_search_mode(existing_opts, chosen);
            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                workspace_id: ws_id_mode.clone(),
                defaults: json!({ "providerOptions": next_opts }),
            }));
        })
        .build(k, overlays);

    search_section = search_section.child(
        row()
            .w_full()
            .items_center()
            .justify_between()
            .gap(16.0)
            .px(16.0)
            .py(14.0)
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(3.0)
                    .child(
                        text("Codex web search mode")
                            .font(k.ty.ui_medium)
                            .color(t.text_base),
                    )
                    .child(
                        text("Controls Codex app-server native search behavior when native search is enabled.")
                            .font(k.ty.small)
                            .color(t.text_muted)
                            .wrap(),
                    ),
            )
            .child(mode_select),
    );

    let tool_providers = tool_providers_section(s, ws, k, t);

    col()
        .w_full()
        .min_w(0.0)
        .gap(20.0)
        .child(search_section.build(k, t))
        .child(tool_providers)
}

fn tool_providers_section(s: &AppState, ws: &WorkspaceRecord, k: &Kit, t: &ThemeTokens) -> El {
    let mut section = Section::new()
        .title("Tool providers")
        .description("API keys powering local web search tools for models without native search.")
        .action(
            Button::new("Configure in Models")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press_tx(|s: &mut AppState, tx| {
                    s.dispatch_tx(
                        Action::Navigate(NavAction::OpenSettings(Some(SettingsPageId::Models))),
                        tx,
                    );
                })
                .build(k),
        );

    let statuses = workspace_provider_statuses(s, Some(ws.id.as_str()));
    let google_status = statuses.iter().find(|st| st.provider == "google");

    for (method_id, name, subtitle, is_exa) in [
        (
            "exa_api_key",
            "Exa Search",
            "Semantic web search and page content extraction.",
            true,
        ),
        (
            "parallel_api_key",
            "Parallel Search",
            "Parallel AI search queries and curated web extracts.",
            false,
        ),
    ] {
        let saved_mask = google_status
            .and_then(|st| st.saved_api_key_masks.get(method_id))
            .filter(|m| !m.trim().is_empty());
        let connected = saved_mask.is_some();
        let edit = if is_exa {
            &s.settings_ui.tool_key_exa_edit
        } else {
            &s.settings_ui.tool_key_parallel_edit
        };
        let empty = edit.text.trim().is_empty();
        let ws_id = ws.id.clone();
        let method_owned = method_id.to_string();

        section = section.child(
            col()
                .w_full()
                .gap(8.0)
                .px(16.0)
                .py(12.0)
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap(12.0)
                        .child(
                            row()
                                .grow(1.0)
                                .min_w(0.0)
                                .items_center()
                                .gap(12.0)
                                .child(entity_icon(s, None, name, EntityIconSize::Sm, k, t))
                                .child(
                                    col()
                                        .grow(1.0)
                                        .min_w(0.0)
                                        .gap(2.0)
                                        .child(text(name).font(k.ty.ui_medium).color(t.text_base))
                                        .child(text(subtitle).font(k.ty.small).color(t.text_muted)),
                                ),
                        )
                        .child(status_pill(
                            if let Some(mask) = saved_mask {
                                format!("Configured ({mask})")
                            } else {
                                "Not configured".to_string()
                            },
                            if connected {
                                StatusTone::Success
                            } else {
                                StatusTone::Neutral
                            },
                            k,
                            t,
                        )),
                )
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .flex_wrap()
                        .gap(8.0)
                        .child(
                            TextInput::new(edit)
                                .label(format!("{name} API key"))
                                .placeholder(if connected {
                                    "Enter replacement API key..."
                                } else {
                                    "Paste API key..."
                                })
                                .secure()
                                .width(Some(280.0))
                                .on_edit(move |s: &mut AppState| {
                                    if is_exa {
                                        &mut s.settings_ui.tool_key_exa_edit
                                    } else {
                                        &mut s.settings_ui.tool_key_parallel_edit
                                    }
                                })
                                .build(k),
                        )
                        .child(
                            Button::new("Save key")
                                .variant(ButtonVariant::Outline)
                                .icon(&icons::KEY)
                                .control_size(ControlSize::Regular)
                                .disabled(empty)
                                .on_press(move |s: &mut AppState| {
                                    let val = if is_exa {
                                        s.settings_ui.tool_key_exa_edit.text.trim().to_string()
                                    } else {
                                        s.settings_ui.tool_key_parallel_edit.text.trim().to_string()
                                    };
                                    if !val.is_empty() {
                                        s.dispatch(Action::Settings(
                                            SettingsAction::SetProviderApiKeyForMethod {
                                                workspace_id: ws_id.clone(),
                                                provider: "google".to_string(),
                                                method_id: method_owned.clone(),
                                                api_key: val,
                                            },
                                        ));
                                        if is_exa {
                                            s.settings_ui.tool_key_exa_edit =
                                                rune::TextEdit::new("");
                                        } else {
                                            s.settings_ui.tool_key_parallel_edit =
                                                rune::TextEdit::new("");
                                        }
                                    }
                                })
                                .build(k),
                        ),
                ),
        );
    }

    section.build(k, t)
}
