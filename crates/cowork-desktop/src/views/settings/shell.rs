//! Settings navigation shell ported from `apps/desktop/src/ui/settings/SettingsShell.tsx`.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use rune::{El, Icon, ScrollSpec, Transition, col, memo, text};
use rune_kit::Kit;
use rune_kit::shell::{Sidebar, SidebarRow, SidebarSection};

use crate::actions::{Action, NavAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::experiments::is_flag_enabled;
use crate::views::settings::icons;
use crate::views::settings::primitives::{active_workspace_banner_label, theme_memo_sig};
use crate::views::shell::helpers::{warm_row, warm_selected};
use crate::views::shell::state::settings_back_action;

/// One item in the Settings navigation sidebar.
#[derive(Clone, Copy)]
pub struct SettingsNavItem {
    pub id: SettingsPageId,
    pub label: &'static str,
    pub icon: &'static Icon,
}

/// One labeled group in the Settings navigation sidebar.
#[derive(Clone)]
pub struct SettingsNavGroup {
    pub label: &'static str,
    pub pages: Vec<SettingsNavItem>,
}

/// Output produced by an individual settings page for mounting inside `SettingsShell`.
pub struct PageContent {
    pub header_actions: Vec<El>,
    pub body: El,
    pub overlays: Vec<El>,
}

impl PageContent {
    /// Creates a standard settings page with no header actions or modal overlays.
    pub fn simple(body: El) -> Self {
        Self {
            header_actions: Vec::new(),
            body,
            overlays: Vec::new(),
        }
    }

    /// Attaches right-aligned header actions to the page chrome.
    pub fn with_header_actions(mut self, actions: Vec<El>) -> Self {
        self.header_actions = actions;
        self
    }

    /// Attaches modal/popover overlay layers mounted above the Settings shell.
    pub fn with_overlays(mut self, overlays: Vec<El>) -> Self {
        self.overlays = overlays;
        self
    }
}

/// Stable DOM-like element key suffix for a canonical `SettingsPageId`.
pub fn page_key(page: SettingsPageId) -> &'static str {
    match page.canonical() {
        SettingsPageId::Models => "models",
        SettingsPageId::Subagents => "subagents",
        SettingsPageId::ToolAccess => "tool-access",
        SettingsPageId::Defaults => "defaults",
        SettingsPageId::ProfileMemory => "profile-memory",
        SettingsPageId::RemoteAccess => "remote-access",
        SettingsPageId::Backup => "backup",
        SettingsPageId::Chats => "chats",
        SettingsPageId::Usage => "usage",
        SettingsPageId::PrivacyTelemetry => "privacy-telemetry",
        SettingsPageId::Desktop => "desktop",
        SettingsPageId::Updates => "updates",
        SettingsPageId::Experiments => "experiments",
        SettingsPageId::Diagnostics => "diagnostics",
        _ => "models",
    }
}

/// Builds the 5 sidebar navigation groups matching `settingsPages.ts::getSettingsGroups`.
pub fn settings_groups(
    remote_access_available: bool,
    include_development_pages: bool,
) -> Vec<SettingsNavGroup> {
    let mut workspace_pages = vec![
        SettingsNavItem {
            id: SettingsPageId::Defaults,
            label: "Behavior",
            icon: &icons::SLIDERS_HORIZONTAL,
        },
        SettingsNavItem {
            id: SettingsPageId::ProfileMemory,
            label: "Profile & Memory",
            icon: &icons::USER_ROUND_COG,
        },
    ];
    if remote_access_available {
        workspace_pages.push(SettingsNavItem {
            id: SettingsPageId::RemoteAccess,
            label: "Remote access",
            icon: &icons::WIFI,
        });
    }

    let mut advanced_pages = Vec::new();
    if include_development_pages {
        advanced_pages.push(SettingsNavItem {
            id: SettingsPageId::Experiments,
            label: "Experiments",
            icon: &icons::FLASK_CONICAL,
        });
    }
    advanced_pages.push(SettingsNavItem {
        id: SettingsPageId::Diagnostics,
        label: "Diagnostics",
        icon: &icons::ACTIVITY,
    });

    vec![
        SettingsNavGroup {
            label: "Models & tools",
            pages: vec![
                SettingsNavItem {
                    id: SettingsPageId::Models,
                    label: "Models",
                    icon: &icons::BOT,
                },
                SettingsNavItem {
                    id: SettingsPageId::Subagents,
                    label: "Subagents",
                    icon: &icons::USERS_ROUND,
                },
                SettingsNavItem {
                    id: SettingsPageId::ToolAccess,
                    label: "Tool Access",
                    icon: &icons::WRENCH,
                },
            ],
        },
        SettingsNavGroup {
            label: "Workspace",
            pages: workspace_pages,
        },
        SettingsNavGroup {
            label: "History & data",
            pages: vec![
                SettingsNavItem {
                    id: SettingsPageId::Backup,
                    label: "Backups",
                    icon: &icons::ARCHIVE_RESTORE,
                },
                SettingsNavItem {
                    id: SettingsPageId::Chats,
                    label: "Chats",
                    icon: &icons::HISTORY,
                },
                SettingsNavItem {
                    id: SettingsPageId::Usage,
                    label: "Usage",
                    icon: &icons::BAR_CHART_3,
                },
            ],
        },
        SettingsNavGroup {
            label: "App",
            pages: vec![
                SettingsNavItem {
                    id: SettingsPageId::PrivacyTelemetry,
                    label: "Privacy & Telemetry",
                    icon: &icons::SHIELD_CHECK,
                },
                SettingsNavItem {
                    id: SettingsPageId::Desktop,
                    label: "Desktop",
                    icon: &icons::MONITOR,
                },
                SettingsNavItem {
                    id: SettingsPageId::Updates,
                    label: "Updates",
                    icon: &icons::REFRESH_CCW,
                },
            ],
        },
        SettingsNavGroup {
            label: "Advanced",
            pages: advanced_pages,
        },
    ]
}

/// Resolves the canonical active settings page along with the sidebar groups so callers
/// avoid constructing `settings_groups` twice per commit.
pub(crate) fn resolve_active_page_with_groups(
    s: &AppState,
) -> (SettingsPageId, bool, bool, Vec<SettingsNavGroup>) {
    let remote_access_available = is_flag_enabled(s, "remoteAccess");
    let include_dev = !s.is_packaged;
    let groups = settings_groups(remote_access_available, include_dev);
    let requested = s.route().settings_page.canonical();
    let active_page = if groups
        .iter()
        .any(|g| g.pages.iter().any(|p| p.id == requested))
    {
        requested
    } else {
        SettingsPageId::Models
    };
    (active_page, remote_access_available, include_dev, groups)
}

/// Resolves the canonical active settings page, falling back cleanly if a gated
/// route is selected when hidden.
pub fn resolve_active_page(s: &AppState) -> SettingsPageId {
    resolve_active_page_with_groups(s).0
}

fn nav_pane(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    active_page: SettingsPageId,
    remote_access_available: bool,
    include_dev: bool,
    groups: &[SettingsNavGroup],
) -> El {
    let return_view = s.route().last_non_settings_view;
    let mut h = DefaultHasher::new();
    (
        page_key(active_page),
        return_view,
        remote_access_available,
        include_dev,
        theme_memo_sig(s, t),
    )
        .hash(&mut h);

    memo("settings-nav-rail", h.finish(), || {
        let back_label = match return_view {
            ViewId::Task => "Back to Tasks",
            ViewId::Chat | ViewId::Settings => "Back to chat",
        };
        let back_button = SidebarRow::new(back_label)
            .icon(&icons::ARROW_LEFT)
            .height(30.0)
            .on_select(|s: &mut AppState, tx| {
                s.settings_ui.mobile_nav_open = false;
                let action = settings_back_action(s);
                s.dispatch_tx(Action::Navigate(action), tx);
            })
            .build(k)
            .key("settings-back-button");

        let mut sb = Sidebar::new()
            .label("Settings sections")
            .inset(8.0)
            .header_gap(3.0)
            .header_padding(0.0, 8.0)
            .row_gap(2.0)
            .header(back_button);

        for (idx, group) in groups.iter().enumerate() {
            let mut sec = SidebarSection::new(group.label).key(format!("settings-nav-group-{idx}"));
            for item in &group.pages {
                let page_id = item.id;
                let is_active = page_id == active_page;
                let nav_row = warm_selected(
                    warm_row(
                        SidebarRow::new(item.label),
                        Some(item.icon),
                        is_active,
                        k,
                        t,
                    )
                    .height(30.0)
                    .selected(is_active)
                    .on_select(move |s: &mut AppState, tx| {
                        s.settings_ui.mobile_nav_open = false;
                        s.settings_ui.open_select_key = None;
                        s.dispatch_tx(Action::Navigate(NavAction::OpenSettings(Some(page_id))), tx);
                    })
                    .build(k)
                    .key(format!("settings-nav-{}", page_key(page_id))),
                    is_active,
                    t,
                );
                sec = sec.row(nav_row);
            }
            sb = sb.section(sec);
        }

        sb.build(k)
            .key("settings-nav-rail")
            .transition(Transition::none())
    })
}

/// Structural pieces of the Settings surface mounted by `views::shell` (or wrapped in `SplitView`
/// by `views::settings::view` for standalone tests).
pub struct SettingsLayout {
    pub sidebar: El,
    pub title: String,
    pub workspace_badge: Option<String>,
    pub header_actions: Vec<El>,
    pub main: El,
    pub overlays: Vec<El>,
}

/// Builds the Settings navigation rail, page description header, and scrollable body.
pub fn settings_layout(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    active_page: SettingsPageId,
    content: PageContent,
) -> SettingsLayout {
    let remote_access_available = is_flag_enabled(s, "remoteAccess");
    let include_dev = !s.is_packaged;
    let groups = settings_groups(remote_access_available, include_dev);
    settings_layout_with_groups(
        s,
        k,
        t,
        active_page,
        remote_access_available,
        include_dev,
        &groups,
        content,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn settings_layout_with_groups(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    active_page: SettingsPageId,
    remote_access_available: bool,
    include_dev: bool,
    groups: &[SettingsNavGroup],
    content: PageContent,
) -> SettingsLayout {
    let is_backup_page = active_page == SettingsPageId::Backup;

    let mut intro = col().w_full().max_w(1040.0).gap(4.0).child(
        text(active_page.description())
            .font(k.ty.small)
            .color(t.text_muted)
            .wrap(),
    );
    if active_page != s.route().settings_page {
        intro = intro.child(
            text(format!(
                "Redirected from {}",
                s.route().settings_page.title()
            ))
            .font(k.ty.small)
            .color(t.text_faint),
        );
    }

    // Instant page and toolbar unmounts match the Electron settings shell and prevent
    // outgoing controls or body copy from ghosting underneath the incoming page.
    let inner_page_key = format!("settings-page-{}", page_key(active_page));
    let main_body = if is_backup_page {
        col()
            .key(inner_page_key)
            .grow(1.0)
            .min_h(0.0)
            .min_w(0.0)
            .w_full()
            .px(24.0)
            .pt(16.0)
            .pb(20.0)
            .gap(16.0)
            .transition(Transition::none())
            .child(intro)
            .child(content.body)
    } else {
        let centered_intro = col().w_full().items_center().child(intro);
        k.scroll_bar(
            col()
                .grow(1.0)
                .min_h(0.0)
                .min_w(0.0)
                .w_full()
                .px(24.0)
                .pt(16.0)
                .pb(28.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(
                    col()
                        .key(inner_page_key)
                        .w_full()
                        .gap(16.0)
                        .transition(Transition::none())
                        .child(centered_intro)
                        .child(content.body),
                ),
        )
        .key("settings-scroll-body")
        .transition(Transition::none())
    };
    let main = rune::el()
        .key("settings-main-pane")
        .grow(1.0)
        .min_h(0.0)
        .min_w(0.0)
        .w_full()
        .transition(Transition::none())
        .child(main_body);

    let header_actions = content
        .header_actions
        .into_iter()
        .map(|el| el.transition(Transition::none()))
        .collect();

    SettingsLayout {
        sidebar: nav_pane(
            s,
            k,
            t,
            active_page,
            remote_access_available,
            include_dev,
            groups,
        ),
        title: active_page.title().to_string(),
        workspace_badge: active_workspace_banner_label(s),
        header_actions,
        main,
        overlays: content.overlays,
    }
}
