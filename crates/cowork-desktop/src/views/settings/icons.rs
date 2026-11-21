//! Vector SVG icon catalog for Settings navigation, status pills, and controls.
//!
//! Uses Lucide-compatible 24x24 geometry with `stroke="currentColor"` so Rune
//! tints every glyph dynamically from the active `ThemeTokens`.

use rune::Icon;

use crate::router::SettingsPageId;

/// Back navigation arrow.
pub static ARROW_LEFT: Icon = Icon {
    name: "settings-arrow-left",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></g>"#,
};

/// Bot icon for Models / Providers.
pub static BOT: Icon = Icon {
    name: "settings-bot",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></g>"#,
};

/// Users icon for Subagents.
pub static USERS_ROUND: Icon = Icon {
    name: "settings-users-round",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></g>"#,
};

/// Wrench icon for Tool Access.
pub static WRENCH: Icon = Icon {
    name: "settings-wrench",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></g>"#,
};

/// Sliders icon for Behavior / Defaults.
pub static SLIDERS_HORIZONTAL: Icon = Icon {
    name: "settings-sliders-horizontal",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></g>"#,
};

/// User profile & cog icon for Profile & Memory.
pub static USER_ROUND_COG: Icon = Icon {
    name: "settings-user-round-cog",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="5"/><path d="M2 21a8 8 0 0 1 10.434-7.62"/><circle cx="18" cy="18" r="3"/><path d="m19.5 14.3-.4.9"/><path d="m16.9 20.8-.4.9"/><path d="m21.7 19.5-.9-.4"/><path d="m15.2 16.9-.9-.4"/><path d="m21.7 16.5-.9.4"/><path d="m15.2 19.1-.9.4"/><path d="m19.5 21.7-.4-.9"/><path d="m16.9 15.2-.4-.9"/></g>"#,
};

/// Wifi icon for Remote access.
pub static WIFI: Icon = Icon {
    name: "settings-wifi",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/></g>"#,
};

/// Archive restore icon for Backups.
pub static ARCHIVE_RESTORE: Icon = Icon {
    name: "settings-archive-restore",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></g>"#,
};

/// History clock icon for Chats.
pub static HISTORY: Icon = Icon {
    name: "settings-history",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></g>"#,
};

/// Bar chart icon for Usage.
pub static BAR_CHART_3: Icon = Icon {
    name: "settings-bar-chart-3",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></g>"#,
};

/// Shield check icon for Privacy & Telemetry.
pub static SHIELD_CHECK: Icon = Icon {
    name: "settings-shield-check",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></g>"#,
};

/// Monitor icon for Desktop.
pub static MONITOR: Icon = Icon {
    name: "settings-monitor",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></g>"#,
};

/// Refresh counterclockwise icon for Updates.
pub static REFRESH_CCW: Icon = Icon {
    name: "settings-refresh-ccw",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></g>"#,
};

/// Flask icon for Experiments.
pub static FLASK_CONICAL: Icon = Icon {
    name: "settings-flask-conical",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></g>"#,
};

/// Activity pulse icon for Diagnostics.
pub static ACTIVITY: Icon = Icon {
    name: "settings-activity",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></g>"#,
};

/// Plus icon for Add actions.
pub static PLUS: Icon = Icon {
    name: "settings-plus",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></g>"#,
};

/// Trash icon for Delete / Remove actions.
pub static TRASH: Icon = Icon {
    name: "settings-trash",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></g>"#,
};

/// Alert triangle icon for warnings / errors.
pub static ALERT_TRIANGLE: Icon = Icon {
    name: "settings-alert-triangle",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></g>"#,
};

/// Check circle icon for healthy / connected status.
pub static CHECK_CIRCLE: Icon = Icon {
    name: "settings-check-circle",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></g>"#,
};

/// Info circle icon for informational banners.
pub static INFO: Icon = Icon {
    name: "settings-info",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></g>"#,
};

/// Key icon for API key / auth sections.
pub static KEY: Icon = Icon {
    name: "settings-key",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></g>"#,
};

/// Folder icon for workspace directories.
pub static FOLDER: Icon = Icon {
    name: "settings-folder",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></g>"#,
};

/// Download icon for updates / bundles.
pub static DOWNLOAD: Icon = Icon {
    name: "settings-download",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></g>"#,
};

/// Upload icon for conversation import.
pub static UPLOAD: Icon = Icon {
    name: "settings-upload",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></g>"#,
};

/// Copy icon for sharing IDs/URLs.
pub static COPY: Icon = Icon {
    name: "settings-copy",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></g>"#,
};

/// Search icon for filter inputs.
pub static SEARCH: Icon = Icon {
    name: "settings-search",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></g>"#,
};

/// Save icon for creating checkpoints / saving edits.
pub static SAVE: Icon = Icon {
    name: "settings-save",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></g>"#,
};

/// Smartphone icon for paired mobile devices.
pub static SMARTPHONE: Icon = Icon {
    name: "settings-smartphone",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></g>"#,
};

/// QR code icon for pairing empty states.
pub static QR_CODE: Icon = Icon {
    name: "settings-qr-code",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/></g>"#,
};

/// Chevron down icon for expanded cards/panels.
pub static CHEVRON_DOWN: Icon = Icon {
    name: "settings-chevron-down",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></g>"#,
};

/// Chevron right icon for collapsed cards/panels.
pub static CHEVRON_RIGHT: Icon = Icon {
    name: "settings-chevron-right",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></g>"#,
};

/// Eye icon for revealing secret inputs.
pub static EYE: Icon = Icon {
    name: "settings-eye",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></g>"#,
};

/// Eye-off icon for masking secret inputs.
pub static EYE_OFF: Icon = Icon {
    name: "settings-eye-off",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></g>"#,
};

/// External link icon for OAuth verification links.
pub static EXTERNAL_LINK: Icon = Icon {
    name: "settings-external-link",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></g>"#,
};

/// Returns the navigation icon matching a canonical `SettingsPageId`.
pub fn page_icon(page: SettingsPageId) -> &'static Icon {
    match page.canonical() {
        SettingsPageId::Models => &BOT,
        SettingsPageId::Subagents => &USERS_ROUND,
        SettingsPageId::ToolAccess => &WRENCH,
        SettingsPageId::Desktop => &MONITOR,
        SettingsPageId::Defaults => &SLIDERS_HORIZONTAL,
        SettingsPageId::ProfileMemory => &USER_ROUND_COG,
        SettingsPageId::RemoteAccess => &WIFI,
        SettingsPageId::Backup => &ARCHIVE_RESTORE,
        SettingsPageId::Chats => &HISTORY,
        SettingsPageId::Usage => &BAR_CHART_3,
        SettingsPageId::PrivacyTelemetry => &SHIELD_CHECK,
        SettingsPageId::Experiments => &FLASK_CONICAL,
        SettingsPageId::Diagnostics => &ACTIVITY,
        SettingsPageId::Updates => &REFRESH_CCW,
        _ => &BOT,
    }
}
