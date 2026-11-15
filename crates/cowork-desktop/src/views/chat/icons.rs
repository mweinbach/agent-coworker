//! Lucide-compatible vector icons for chat views and tool timeline cards.

use rune::Icon;

use super::model::ToolIconCategory;

const fn lucide(name: &'static str, body: &'static str) -> Icon {
    Icon {
        name,
        view: 24.0,
        body,
    }
}

macro_rules! stroke_icon {
    ($name:expr, $inner:expr) => {
        lucide(
            $name,
            concat!(
                r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#,
                $inner,
                r#"</g>"#,
            ),
        )
    };
}

#[allow(dead_code)]
pub static PAPERCLIP: Icon = stroke_icon!(
    "chat-paperclip",
    r#"<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>"#
);

#[allow(dead_code)]
pub static ARROW_UP: Icon = stroke_icon!(
    "chat-arrow-up",
    r#"<path d="M5 12l7-7 7 7"/><path d="M12 19V5"/>"#
);

#[allow(dead_code)]
pub static ARROW_DOWN: Icon = stroke_icon!(
    "chat-arrow-down",
    r#"<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>"#
);

#[allow(dead_code)]
pub static STOP_SQUARE: Icon = lucide(
    "chat-stop-square",
    r#"<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>"#,
);

#[allow(dead_code)]
pub static BRAIN: Icon = stroke_icon!(
    "chat-brain",
    r#"<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>"#
);

#[allow(dead_code)]
pub static BOT: Icon = stroke_icon!(
    "chat-bot",
    r#"<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>"#
);

#[allow(dead_code)]
pub static TERMINAL: Icon = stroke_icon!(
    "chat-terminal",
    r#"<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>"#
);

pub static FILE_TEXT: Icon = stroke_icon!(
    "chat-file-text",
    r#"<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>"#
);

pub static SPREADSHEET: Icon = stroke_icon!(
    "chat-spreadsheet",
    r#"<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>"#
);

pub static IMAGE: Icon = stroke_icon!(
    "chat-image",
    r#"<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>"#
);

pub static AUDIO: Icon = stroke_icon!(
    "chat-audio",
    r#"<path d="M17.5 22h.5a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="6" cy="18" r="2"/><circle cx="12" cy="16" r="2"/><path d="M8 18v-6l6-1.5V16"/>"#
);

pub static VIDEO: Icon = stroke_icon!(
    "chat-video",
    r#"<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3v-6Z"/>"#
);

pub static GLOBE: Icon = stroke_icon!(
    "chat-globe",
    r#"<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>"#
);

#[allow(dead_code)]
pub static SEARCH: Icon = stroke_icon!(
    "chat-search",
    r#"<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>"#
);

#[allow(dead_code)]
pub static CHECKLIST: Icon = stroke_icon!(
    "chat-checklist",
    r#"<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>"#
);

#[allow(dead_code)]
pub static WRENCH: Icon = stroke_icon!(
    "chat-wrench",
    r#"<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>"#
);

#[allow(dead_code)]
pub static ALERT: Icon = stroke_icon!(
    "chat-alert",
    r#"<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>"#
);

#[allow(dead_code)]
pub static SHIELD_ALERT: Icon = stroke_icon!(
    "chat-shield-alert",
    r#"<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>"#
);

#[allow(dead_code)]
pub static BOOK_OPEN: Icon = stroke_icon!(
    "chat-book-open",
    r#"<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>"#
);

#[allow(dead_code)]
pub static COMPASS: Icon = stroke_icon!(
    "chat-compass",
    r#"<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>"#
);

#[allow(dead_code)]
pub static SCAN_SEARCH: Icon = stroke_icon!(
    "chat-scan-search",
    r#"<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>"#
);

#[allow(dead_code)]
pub static LIGHTBULB: Icon = stroke_icon!(
    "chat-lightbulb",
    r#"<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>"#
);

pub static EXTERNAL_LINK: Icon = stroke_icon!(
    "chat-external-link",
    r#"<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>"#
);

#[allow(dead_code)]
pub static FOLDER: Icon = stroke_icon!(
    "chat-folder",
    r#"<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>"#
);

#[allow(dead_code)]
pub static SPARKLES: Icon = stroke_icon!(
    "chat-sparkles",
    r#"<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>"#
);

#[allow(dead_code)]
pub static ROTATE_CCW: Icon = stroke_icon!(
    "chat-rotate-ccw",
    r#"<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>"#
);

#[allow(dead_code)]
pub static CORNER_DOWN_RIGHT: Icon = stroke_icon!(
    "chat-corner-down-right",
    r#"<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>"#
);

/// Maps a tool category into its matching Lucide timeline icon.
#[allow(dead_code)]
pub fn tool_icon(category: ToolIconCategory) -> &'static Icon {
    match category {
        ToolIconCategory::Todo => &CHECKLIST,
        ToolIconCategory::Search => &SEARCH,
        ToolIconCategory::Web => &GLOBE,
        ToolIconCategory::Terminal => &TERMINAL,
        ToolIconCategory::File => &FILE_TEXT,
        ToolIconCategory::Agent => &BOT,
        ToolIconCategory::Wrench => &WRENCH,
    }
}
