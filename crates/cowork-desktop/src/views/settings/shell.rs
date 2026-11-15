//! Settings navigation shell ported from `apps/desktop/src/ui/settings/SettingsShell.tsx`.

use rune::{Cx, El, Icon, ScrollSpec, Transition, col, el, icon, row, text};
use rune_kit::Kit;

use crate::actions::{Action, NavAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::AppState;
use crate::theme::{self, ThemeTokens};
use crate::views::SubviewOutput;
use crate::views::settings::experiments::is_flag_enabled;
use crate::views::settings::icons;
use crate::views::settings::primitives::active_workspace_banner_label;

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
            label: "History & Data",
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

/// Resolves the canonical active settings page, falling back cleanly if a gated
/// route is selected when hidden.
pub fn resolve_active_page(s: &AppState) -> SettingsPageId {
    let remote_access_available = is_flag_enabled(s, "remoteAccess");
    let include_dev = !s.is_packaged;
    let groups = settings_groups(remote_access_available, include_dev);
    let requested = s.route().settings_page.canonical();
    if groups
        .iter()
        .any(|g| g.pages.iter().any(|p| p.id == requested))
    {
        requested
    } else {
        SettingsPageId::Models
    }
}

fn nav_pane(
    s: &AppState,
    _cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    active_page: SettingsPageId,
    groups: &[SettingsNavGroup],
) -> El {
    let back_button = row()
        .key("settings-back-button")
        .w_full()
        .h(36.0)
        .px(10.0)
        .radius(6.0)
        .gap(8.0)
        .items_center()
        .hover(t.text_base.alpha(0.05))
        .press(t.pressed)
        .role("button")
        .label("Back to chat")
        .on_press(|s: &mut AppState| {
            s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
        })
        .child(icon(&icons::ARROW_LEFT, 16.0).color(t.text_muted))
        .child(text("Back").font(k.ty.body_medium).color(t.text_muted));

    let mut header = col()
        .w_full()
        .px(12.0)
        .pt(12.0)
        .pb(10.0)
        .gap(6.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .child(back_button);

    if let Some(ws_label) = active_workspace_banner_label(s) {
        header = header.child(
            text(ws_label)
                .px(8.0)
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
                .truncate(),
        );
    }

    let mut group_els = Vec::with_capacity(groups.len());
    for group in groups {
        let mut items = Vec::with_capacity(group.pages.len());
        for item in &group.pages {
            let is_active = item.id == active_page;
            let page_id = item.id;
            let icon_color = if is_active { t.accent } else { t.text_muted };
            let text_color = if is_active { t.text_base } else { t.text_muted };
            let label_font = if is_active {
                k.ty.body_medium
            } else {
                k.ty.ui_medium
            };

            let mut nav_btn = row()
                .key(format!("settings-nav-{}", page_key(page_id)))
                .w_full()
                .min_h(34.0)
                .px(10.0)
                .py(7.0)
                .radius(8.0)
                .gap(10.0)
                .items_center()
                .role("button")
                .label(item.label)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(page_id))));
                })
                .child(icon(item.icon, 16.0).color(icon_color))
                .child(
                    text(item.label)
                        .grow(1.0)
                        .min_w(0.0)
                        .font(label_font)
                        .color(text_color)
                        .truncate(),
                );

            if is_active {
                nav_btn = nav_btn.fill(t.accent.alpha(0.12));
            } else {
                nav_btn = nav_btn.hover(t.text_base.alpha(0.05)).press(t.pressed);
            }

            items.push(nav_btn);
        }

        group_els.push(
            col()
                .w_full()
                .min_w(0.0)
                .gap(2.0)
                .child(
                    text(group.label.to_uppercase())
                        .px(8.0)
                        .py(6.0)
                        .font(t.label)
                        .color(t.text_faint),
                )
                .children(items),
        );
    }

    let scroll_nav = k.scroll_bar(
        col()
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .px(10.0)
            .pt(10.0)
            .pb(16.0)
            .gap(14.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .children(group_els),
    );

    col()
        .key("settings-nav-rail")
        .w(theme::layout::SIDEBAR_DEFAULT_WIDTH)
        .h_full()
        .min_h(0.0)
        .shrink()
        .fill(t.sidebar_bg)
        .border_sides([0.0, 1.0, 0.0, 0.0], t.border_muted)
        .child(header)
        .child(el().grow(1.0).min_h(0.0).w_full().child(scroll_nav))
}

/// Wraps an active page inside the Settings shell (navigation sidebar + sticky header + scroll body).
pub fn settings_shell(
    s: &AppState,
    cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    active_page: SettingsPageId,
    content: PageContent,
) -> SubviewOutput {
    let remote_access_available = is_flag_enabled(s, "remoteAccess");
    let include_dev = !s.is_packaged;
    let groups = settings_groups(remote_access_available, include_dev);

    let main_bg = t.panel_bg.mix(t.app_bg, 0.12);
    let is_backup_page = active_page == SettingsPageId::Backup;

    let mut header_title_col = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(4.0)
        .child(
            text(active_page.title())
                .font(t.title)
                .color(t.text_base)
                .wrap(),
        )
        .child(
            text(active_page.description())
                .font(k.ty.body)
                .color(t.text_muted)
                .max_w(576.0)
                .wrap(),
        );

    if active_page != s.route().settings_page {
        header_title_col = header_title_col.child(
            text(format!(
                "Redirected from {}",
                s.route().settings_page.title()
            ))
            .font(k.ty.text_xsmall)
            .color(t.text_faint),
        );
    }

    let mut header_row = row()
        .w_full()
        .justify_between()
        .items_start()
        .gap(16.0)
        .child(header_title_col);

    if !content.header_actions.is_empty() {
        header_row = header_row.child(
            row()
                .shrink()
                .flex_wrap()
                .items_center()
                .justify_end()
                .gap(8.0)
                .children(content.header_actions),
        );
    }

    let page_header = el()
        .key("settings-page-header")
        .w_full()
        .px(20.0)
        .py(16.0)
        .fill(main_bg)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .child(header_row);

    // Instant page unmount matches the Electron settings shell and prevents
    // outgoing page text from ghosting underneath the incoming page.
    let body_area = if is_backup_page {
        col()
            .key(format!("settings-page-{}", page_key(active_page)))
            .grow(1.0)
            .min_h(0.0)
            .min_w(0.0)
            .w_full()
            .px(20.0)
            .pb(20.0)
            .pt(16.0)
            .transition(Transition::none())
            .child(content.body)
    } else {
        let scroll_body = k.scroll_bar(
            col()
                .grow(1.0)
                .min_h(0.0)
                .min_w(0.0)
                .w_full()
                .px(20.0)
                .pt(16.0)
                .pb(24.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(
                    col()
                        .key(format!("settings-page-{}", page_key(active_page)))
                        .w_full()
                        .transition(Transition::none())
                        .child(content.body),
                ),
        );
        el().grow(1.0)
            .min_h(0.0)
            .min_w(0.0)
            .w_full()
            .child(scroll_body)
    };

    let main_pane = col()
        .key("settings-main-pane")
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .h_full()
        .fill(main_bg)
        .child(page_header)
        .child(body_area);

    let shell_row = row()
        .key("settings-shell")
        .w_full()
        .h_full()
        .min_h(0.0)
        .min_w(0.0)
        .fill(t.app_bg)
        .child(nav_pane(s, cx, k, t, active_page, &groups))
        .child(main_pane);

    SubviewOutput {
        content: shell_row,
        overlays: content.overlays,
    }
}
