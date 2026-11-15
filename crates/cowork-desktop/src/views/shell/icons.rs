//! Static Lucide-aligned 16x16 vector icons used across the desktop shell.

use rune::Icon;

pub static PLUS: Icon = Icon {
    name: "cowork-plus",
    view: 16.0,
    body: r#"<path d="M8 3.25V12.75M3.25 8H12.75" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>"#,
};

pub static SEARCH: Icon = Icon {
    name: "cowork-search",
    view: 16.0,
    body: r#"<circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>"#,
};

pub static FOLDER: Icon = Icon {
    name: "cowork-folder",
    view: 16.0,
    body: r#"<path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.4L7.7 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#,
};

pub static FOLDER_PLUS: Icon = Icon {
    name: "cowork-folder-plus",
    view: 16.0,
    body: r#"<path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.4L7.7 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 7.25V10.75M6.25 9H9.75" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
};

pub static MESSAGE: Icon = Icon {
    name: "cowork-message",
    view: 16.0,
    body: r#"<path d="M3 4.2C3 3.54 3.54 3 4.2 3H11.8C12.46 3 13 3.54 13 4.2V9.8C13 10.46 12.46 11 11.8 11H6.2L3.5 13.2V11H4.2C3.54 11 3 10.46 3 9.8V4.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#,
};

pub static CHECK_SQUARE: Icon = Icon {
    name: "cowork-check-square",
    view: 16.0,
    body: r#"<rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M5.5 8.1L7.3 9.9L10.7 6.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

pub static SETTINGS: Icon = Icon {
    name: "cowork-settings",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 2.2V3.6M8 12.4V13.8M2.2 8H3.6M12.4 8H13.8M3.9 3.9L4.9 4.9M11.1 11.1L12.1 12.1M12.1 3.9L11.1 4.9M4.9 11.1L3.9 12.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
};

pub static PLUGINS: Icon = Icon {
    name: "cowork-plugins",
    view: 16.0,
    body: r#"<path d="M6 2.5V5.5M10 2.5V5.5M4.5 5.5H11.5V8.2C11.5 10.1 9.9 11.5 8 11.5C6.1 11.5 4.5 10.1 4.5 8.2V5.5ZM8 11.5V13.75" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};

pub static ARROW_LEFT: Icon = Icon {
    name: "cowork-arrow-left",
    view: 16.0,
    body: r#"<path d="M9.75 4L5.75 8L9.75 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};

pub static ARROW_RIGHT: Icon = Icon {
    name: "cowork-arrow-right",
    view: 16.0,
    body: r#"<path d="M6.25 4L10.25 8L6.25 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};

pub static REFRESH: Icon = Icon {
    name: "cowork-refresh",
    view: 16.0,
    body: r#"<path d="M12.8 6.4A5 5 0 1 0 12.3 10.7M12.8 3.2V6.4H9.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};

pub static ALERT_TRIANGLE: Icon = Icon {
    name: "cowork-alert-triangle",
    view: 16.0,
    body: r#"<path d="M8 2.6L13.7 12.8H2.3L8 2.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 6.3V9.1M8 11.1H8.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>"#,
};

pub static INFO: Icon = Icon {
    name: "cowork-info",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 7.3V11M8 5.1H8.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>"#,
};

pub static CHECK_CIRCLE: Icon = Icon {
    name: "cowork-check-circle",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M5.6 8.1L7.2 9.7L10.6 6.2" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

pub static PIN: Icon = Icon {
    name: "cowork-pin",
    view: 16.0,
    body: r#"<path d="M5.5 3H10.5L9.8 7L12 9.2H4L6.2 7L5.5 3ZM8 9.2V13.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" fill="none"/>"#,
};

pub static EXTERNAL_LINK: Icon = Icon {
    name: "cowork-external-link",
    view: 16.0,
    body: r#"<path d="M9.5 3H13V6.5M13 3L7.5 8.5M11.5 9.2V12.2C11.5 12.64 11.14 13 10.7 13H3.8C3.36 13 3 12.64 3 12.2V5.3C3 4.86 3.36 4.5 3.8 4.5H6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};

pub static SPARKLES: Icon = Icon {
    name: "cowork-sparkles",
    view: 16.0,
    body: r#"<path d="M8 2.2L9.2 6L13 7.2L9.2 8.4L8 12.2L6.8 8.4L3 7.2L6.8 6L8 2.2ZM12.5 11L13 12.4L14.4 12.9L13 13.4L12.5 14.8L12 13.4L10.6 12.9L12 12.4L12.5 11Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" fill="none"/>"#,
};

pub static STOP_CIRCLE: Icon = Icon {
    name: "cowork-stop-circle",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="6" y="6" width="4" height="4" rx="0.6" fill="currentColor"/>"#,
};

pub static FILE_TEXT: Icon = Icon {
    name: "cowork-file-text",
    view: 16.0,
    body: r#"<path d="M4 2.5H9.5L12.5 5.5V13.5H4V2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M9.5 2.5V5.5H12.5M6 8.2H10.5M6 10.6H9.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
};

pub static TERMINAL: Icon = Icon {
    name: "cowork-terminal",
    view: 16.0,
    body: r#"<rect x="2.2" y="3" width="11.6" height="10" rx="1.8" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.8 6.3L6.8 8.2L4.8 10.1M8.2 10.1H11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

pub static CLOCK: Icon = Icon {
    name: "cowork-clock",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 5V8.2L10.3 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

pub static POPOUT: Icon = Icon {
    name: "cowork-popout",
    view: 16.0,
    body: r#"<rect x="2.5" y="4.5" width="9" height="9" rx="1.6" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7.5 8.5L13.2 2.8M10 2.5H13.5V6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

pub static CHEVRON_RIGHT: Icon = Icon {
    name: "cowork-chevron-right",
    view: 16.0,
    body: r#"<path d="M6.5 5L9.5 8L6.5 11" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};

pub static MORE_HORIZONTAL: Icon = Icon {
    name: "cowork-more-horizontal",
    view: 16.0,
    body: r#"<circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/>"#,
};

pub static PENCIL: Icon = Icon {
    name: "cowork-pencil",
    view: 16.0,
    body: r#"<path d="M10.8 2.8L13.2 5.2L5.6 12.8L2.6 13.4L3.2 10.4L10.8 2.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>"#,
};

pub static ZOOM_IN: Icon = Icon {
    name: "cowork-zoom-in",
    view: 16.0,
    body: r#"<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M10.3 10.3L13.5 13.5M7 5V9M5 7H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
};

pub static ZOOM_OUT: Icon = Icon {
    name: "cowork-zoom-out",
    view: 16.0,
    body: r#"<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M10.3 10.3L13.5 13.5M5 7H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>"#,
};
