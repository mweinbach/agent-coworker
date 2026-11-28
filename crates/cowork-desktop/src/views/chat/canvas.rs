//! Right-rail Canvas document workspace pane (`Canvas.tsx` port).
//!
//! Supports Markdown Document view (`desktop_markdown`) and monospace Source editing,
//! Markdown formatting toolbar, dirty/save/conflict/truncation states, native Save As
//! dialog, external reload confirmation, and `<canvas_request>` collaborative edits.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use rune::{
    Color, Cx, El, GrowthSpec, ImageCache, Key, KeyEvent, ScrollSpec, TextEdit, TextStyle, Tx,
    auto_grow, col, el, icon, memo, row, spacer, text, text_input,
};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Dialog, IconButton, IconButtonVariant, Kit,
    SegmentedControl, Spinner, State,
};

use crate::actions::{Action, ChatAction, NativeAction, ShellAction};
use crate::native::dialogs::build_save_canvas_dialog;
use crate::state::{AppState, CanvasDocumentStatus, ServerLifecycleState, ThreadBusyPolicy};
use crate::theme::ThemeTokens;
use crate::views::SubviewOutput;

use super::attachments::{image_decode_generation, shared_waker_image_cache};
use super::components::{StatusPillTone, status_pill};
use super::icons;
use super::markdown::{MarkdownHooks, desktop_markdown, split_markdown_block_ranges};
use super::math::raster_generation;
use super::model::{
    cached_mention_catalog_for_state, extract_references_from_text, workspace_is_reconnecting,
};
use super::resolve_cached_tokens;
use super::state::{CanvasLifecycleKind, CanvasTab, CanvasUiState};

/// Document file categories rendered inside the Canvas pane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CanvasFileKind {
    Markdown,
    Text,
}

impl CanvasFileKind {
    pub fn protocol_kind(self) -> &'static str {
        match self {
            CanvasFileKind::Markdown => "markdown",
            CanvasFileKind::Text => "text",
        }
    }
}

/// Markdown formatting operations exposed by the Canvas Styling toolbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkdownFormatKind {
    Bold,
    Italic,
    H1,
    H2,
    H3,
    Normal,
    BulletList,
    NumberedList,
}

/// Output of applying a Markdown formatting operation to a source buffer and selection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownFormatResult {
    pub next: String,
    pub selection_start: usize,
    pub selection_end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MarkdownFormatStep {
    replace_start: usize,
    replace_end: usize,
    replacement: String,
    next: String,
    selection_start: usize,
    selection_end: usize,
}

/// Classifies a workspace path into a Canvas-editable document kind, returning `None` for
/// spreadsheets (`.xlsx`/`.xls`/`.csv`, owned by `views/preview/`), rich binary documents
/// (`.docx`/`.pptx`/`.pdf`), and media/binary assets.
pub fn classify_canvas_path(path: &str) -> Option<CanvasFileKind> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let file_name = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);

    if matches!(
        ext.as_deref(),
        Some("md" | "markdown" | "mdx" | "mdown" | "mkd")
    ) {
        return Some(CanvasFileKind::Markdown);
    }

    if matches!(
        ext.as_deref(),
        Some(
            "txt"
                | "text"
                | "log"
                | "json"
                | "jsonc"
                | "json5"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
                | "html"
                | "htm"
                | "css"
                | "scss"
                | "sass"
                | "less"
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "mjs"
                | "cjs"
                | "rs"
                | "py"
                | "rb"
                | "go"
                | "java"
                | "kt"
                | "kts"
                | "swift"
                | "c"
                | "h"
                | "cpp"
                | "cc"
                | "cxx"
                | "hpp"
                | "cs"
                | "sh"
                | "bash"
                | "zsh"
                | "fish"
                | "ps1"
                | "bat"
                | "cmd"
                | "sql"
                | "graphql"
                | "gql"
                | "proto"
                | "php"
                | "vue"
                | "svelte"
                | "env"
                | "ini"
                | "conf"
                | "cfg"
                | "gitignore"
                | "gitattributes"
                | "editorconfig"
        )
    ) {
        return Some(CanvasFileKind::Text);
    }

    if ext.is_none()
        && matches!(
            file_name.as_str(),
            "readme"
                | "license"
                | "notice"
                | "changelog"
                | "makefile"
                | "dockerfile"
                | ".gitignore"
                | ".gitattributes"
                | ".editorconfig"
                | ".env"
        )
    {
        return Some(CanvasFileKind::Text);
    }

    None
}

/// Returns true if `path` is an editable text/markdown/code document supported by the Canvas pane.
pub fn is_canvas_document_path(path: &str) -> bool {
    classify_canvas_path(path).is_some()
}

/// Returns true when the Canvas pane is expanded over the primary chat workspace.
pub fn is_canvas_maximized(s: &AppState) -> bool {
    s.chat_ui.canvas.maximized
}

fn clamp_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn strip_markdown_line_prefix(line: &str) -> &str {
    let trimmed = line.trim_start_matches([' ', '\t']);
    // Headings: `# `..`###### `
    let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes)
        && let Some(after_hash) = trimmed.get(hashes..)
        && let Some(rest) = after_hash.strip_prefix(' ')
    {
        return rest;
    }
    // Bullet lists: `- `, `* `, `+ `
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        return rest;
    }
    // Numbered lists: `1. ` / `12) `
    let digits = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0
        && let Some(after_digits) = trimmed.get(digits..)
        && let Some(rest) = after_digits
            .strip_prefix(". ")
            .or_else(|| after_digits.strip_prefix(") "))
    {
        return rest;
    }
    trimmed
}

fn compute_markdown_format(
    value: &str,
    start: usize,
    end: usize,
    kind: MarkdownFormatKind,
) -> MarkdownFormatStep {
    let a = clamp_char_boundary(value, start.min(end));
    let b = clamp_char_boundary(value, start.max(end));

    match kind {
        MarkdownFormatKind::Bold | MarkdownFormatKind::Italic => {
            let marker = if kind == MarkdownFormatKind::Bold {
                "**"
            } else {
                "*"
            };
            let m = marker.len();
            let selected = &value[a..b];
            if a == b {
                let replacement = format!("{marker}{marker}");
                let mut next = String::with_capacity(value.len() + replacement.len());
                next.push_str(&value[..a]);
                next.push_str(&replacement);
                next.push_str(&value[b..]);
                return MarkdownFormatStep {
                    replace_start: a,
                    replace_end: b,
                    replacement,
                    next,
                    selection_start: a + m,
                    selection_end: a + m,
                };
            }
            let already_wrapped = selected.len() > 2 * m
                && selected.starts_with(marker)
                && selected.ends_with(marker)
                && (kind != MarkdownFormatKind::Italic
                    || (!selected.starts_with("**") && !selected.ends_with("**")));
            if already_wrapped {
                let inner = &selected[m..selected.len() - m];
                let replacement = inner.to_string();
                let mut next = String::with_capacity(value.len() - 2 * m);
                next.push_str(&value[..a]);
                next.push_str(&replacement);
                next.push_str(&value[b..]);
                return MarkdownFormatStep {
                    replace_start: a,
                    replace_end: b,
                    replacement,
                    next,
                    selection_start: a,
                    selection_end: a + inner.len(),
                };
            }
            let replacement = format!("{marker}{selected}{marker}");
            let mut next = String::with_capacity(value.len() + 2 * m);
            next.push_str(&value[..a]);
            next.push_str(&replacement);
            next.push_str(&value[b..]);
            MarkdownFormatStep {
                replace_start: a,
                replace_end: b,
                replacement,
                next,
                selection_start: a + m,
                selection_end: b + m,
            }
        }
        MarkdownFormatKind::H1
        | MarkdownFormatKind::H2
        | MarkdownFormatKind::H3
        | MarkdownFormatKind::Normal
        | MarkdownFormatKind::BulletList
        | MarkdownFormatKind::NumberedList => {
            // Do not bleed onto the next line when a block selection ends right on `\n`.
            let effective_end = if b > a && value.as_bytes().get(b - 1) == Some(&b'\n') {
                b - 1
            } else {
                b
            };
            let line_start = value[..a].rfind('\n').map_or(0, |idx| idx + 1);
            let line_end = value[effective_end..]
                .find('\n')
                .map_or(value.len(), |idx| effective_end + idx);
            let block = &value[line_start..line_end];

            let lines: Vec<&str> = block.split('\n').collect();
            let mut formatted_lines = Vec::with_capacity(lines.len());
            for (idx, line) in lines.into_iter().enumerate() {
                let body = strip_markdown_line_prefix(line);
                let out = match kind {
                    MarkdownFormatKind::H1 => format!("# {body}"),
                    MarkdownFormatKind::H2 => format!("## {body}"),
                    MarkdownFormatKind::H3 => format!("### {body}"),
                    MarkdownFormatKind::Normal => body.to_string(),
                    MarkdownFormatKind::BulletList => format!("- {body}"),
                    MarkdownFormatKind::NumberedList => format!("{}. {body}", idx + 1),
                    MarkdownFormatKind::Bold | MarkdownFormatKind::Italic => unreachable!(),
                };
                formatted_lines.push(out);
            }
            let replacement = formatted_lines.join("\n");
            let mut next = String::with_capacity(
                value.len().saturating_sub(line_end - line_start) + replacement.len(),
            );
            next.push_str(&value[..line_start]);
            next.push_str(&replacement);
            next.push_str(&value[line_end..]);
            let selection_end = line_start + replacement.len();
            MarkdownFormatStep {
                replace_start: line_start,
                replace_end: line_end,
                replacement,
                next,
                selection_start: line_start,
                selection_end,
            }
        }
    }
}

/// Applies `kind` formatting to `value` over byte range `start..end`, returning the updated
/// text and resulting selection offsets (ported from `canvasMarkdownFormat.ts`).
pub fn apply_markdown_format(
    value: &str,
    start: usize,
    end: usize,
    kind: MarkdownFormatKind,
) -> MarkdownFormatResult {
    let step = compute_markdown_format(value, start, end, kind);
    MarkdownFormatResult {
        next: step.next,
        selection_start: step.selection_start,
        selection_end: step.selection_end,
    }
}

/// Applies `kind` to `edit` as one undoable edit step while restoring the transformed selection.
pub fn apply_format_to_text_edit(edit: &mut TextEdit, kind: MarkdownFormatKind) {
    let (start, end) = edit.range();
    let step = compute_markdown_format(&edit.text, start, end, kind);
    edit.set_selection(step.replace_start, step.replace_end);
    edit.insert(&step.replacement);
    edit.set_selection(step.selection_start, step.selection_end);
}

fn escape_xml(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Formats a collaborative Canvas edit prompt matching Electron `buildCanvasDocumentPrompt`.
pub fn build_canvas_document_prompt(
    path: &str,
    file_name: &str,
    kind: CanvasFileKind,
    selection: Option<&str>,
    request: &str,
) -> String {
    let trimmed_req = request.trim();
    let trimmed_sel = selection.map(str::trim).filter(|s| !s.is_empty());
    let mut lines = vec![
        r#"<canvas_request version="1" source="document">"#.to_string(),
        "  <assistant_instructions>".to_string(),
        "    <instruction>The user is viewing this document in Canvas. Apply or discuss the requested change referencing the file below.</instruction>".to_string(),
        "  </assistant_instructions>".to_string(),
        format!(
            r#"  <file name="{}" path="{}" kind="{}" />"#,
            escape_xml(file_name),
            escape_xml(path),
            escape_xml(kind.protocol_kind()),
        ),
    ];
    if let Some(sel) = trimmed_sel {
        lines.push(format!("  <selection>{}</selection>", escape_xml(sel)));
    }
    lines.push(format!(
        "  <user_request>{}</user_request>",
        escape_xml(trimmed_req)
    ));
    lines.push("</canvas_request>".to_string());
    lines.join("\n")
}

#[derive(Clone, Debug, Hash)]
struct LiveSessionMeta {
    document_id: String,
    generation: u64,
    dirty: bool,
}

#[derive(Clone, Debug)]
struct ResolvedCanvasDoc {
    doc_identity: String,
    session_key: String,
    workspace_id: String,
    path: String,
    title: String,
    disk_content: Rc<str>,
    draft_content: Rc<str>,
    disk_hash: u64,
    draft_hash: u64,
    kind: CanvasFileKind,
    truncated: bool,
    lifecycle: CanvasLifecycleKind,
    error_message: Option<String>,
    live_session: Option<LiveSessionMeta>,
}

fn hash_text(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

const VIRTUALIZE_MARKDOWN_MIN_BYTES: usize = 2048;

type CanvasTextSlot = Option<(u64, Rc<str>)>;
type CanvasBlockRanges = Arc<Vec<(usize, usize)>>;
type CanvasBlockRangesSlot = Option<(u64, Rc<str>, CanvasBlockRanges)>;

thread_local! {
    /// Three-slot `Rc<str>` cache (`0 = disk_content`, `1 = draft_content`, `2 = live_text`) so
    /// steady-state commits never reallocate 20 KB+ Canvas document buffers while remaining 100%
    /// exact via hash + equality check.
    static CANVAS_TEXT_CACHE: RefCell<[CanvasTextSlot; 3]> =
        const { RefCell::new([None, None, None]) };
    /// Two-slot cache of top-level Markdown block byte ranges verified by hash + exact string match.
    static CANVAS_BLOCK_RANGES_CACHE: RefCell<[CanvasBlockRangesSlot; 2]> =
        const { RefCell::new([None, None]) };
}

fn cached_canvas_text(slot: usize, text: &str) -> (u64, Rc<str>) {
    CANVAS_TEXT_CACHE.with(|cache| {
        let mut slots = cache.borrow_mut();
        if let Some((cached_hash, cached_rc)) = slots[slot].as_ref()
            && cached_rc.as_ref() == text
        {
            return (*cached_hash, Rc::clone(cached_rc));
        }
        let hash = hash_text(text);
        let rc: Rc<str> = Rc::from(text);
        slots[slot] = Some((hash, Rc::clone(&rc)));
        (hash, rc)
    })
}

fn cached_canvas_block_ranges(hash: u64, text_rc: &Rc<str>) -> CanvasBlockRanges {
    CANVAS_BLOCK_RANGES_CACHE.with(|cache| {
        let mut slots = cache.borrow_mut();
        for slot in slots.iter() {
            if let Some((h, cached_rc, ranges)) = slot.as_ref()
                && *h == hash
                && (Rc::ptr_eq(cached_rc, text_rc) || cached_rc.as_ref() == text_rc.as_ref())
            {
                return Arc::clone(ranges);
            }
        }
        let ranges = Arc::new(split_markdown_block_ranges(text_rc.as_ref()));
        slots[1] = slots[0].take();
        slots[0] = Some((hash, Rc::clone(text_rc), Arc::clone(&ranges)));
        ranges
    })
}

fn title_for_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn resolve_active_canvas_doc(s: &AppState) -> Option<Rc<ResolvedCanvasDoc>> {
    if let Some(ref fx) = s.chat_ui.canvas.fixture {
        let kind = if fx.is_markdown {
            CanvasFileKind::Markdown
        } else {
            classify_canvas_path(&fx.path).unwrap_or(CanvasFileKind::Text)
        };
        let title = if fx.title.trim().is_empty() {
            title_for_path(&fx.path)
        } else {
            fx.title.clone()
        };
        let (disk_hash, disk_content) = cached_canvas_text(0, &fx.content);
        let draft_content = Rc::clone(&disk_content);
        return Some(Rc::new(ResolvedCanvasDoc {
            doc_identity: format!("fixture\0{}\0{}", fx.workspace_id, fx.path),
            session_key: format!("fixture\0{}\0{}", fx.workspace_id, fx.path),
            workspace_id: fx.workspace_id.clone(),
            path: fx.path.clone(),
            title,
            disk_hash,
            draft_hash: disk_hash,
            disk_content,
            draft_content,
            kind,
            truncated: fx.truncated,
            lifecycle: fx.lifecycle,
            error_message: fx.message.clone(),
            live_session: None,
        }));
    }

    // Electron parity (#110): Canvas activates when `feature_flags["canvas"] == true`
    // and the opened file preview is an editable markdown/text/code document.
    if !s.is_canvas_enabled() {
        return None;
    }

    if let Some(ref doc) = s.canvas_document {
        let (lifecycle, error_message) = match &doc.status {
            CanvasDocumentStatus::Loading => (CanvasLifecycleKind::Loading, None),
            CanvasDocumentStatus::Ready => (CanvasLifecycleKind::Ready, None),
            CanvasDocumentStatus::Saving => (CanvasLifecycleKind::Saving, None),
            CanvasDocumentStatus::LoadError { message, .. } => {
                (CanvasLifecycleKind::LoadError, Some(message.clone()))
            }
            CanvasDocumentStatus::SaveError { message, .. } => {
                (CanvasLifecycleKind::SaveError, Some(message.clone()))
            }
            CanvasDocumentStatus::Conflict { message, .. } => {
                (CanvasLifecycleKind::Conflict, Some(message.clone()))
            }
        };
        let ready_phase = match doc.status {
            CanvasDocumentStatus::Loading => 0u8,
            CanvasDocumentStatus::LoadError { .. } => 1u8,
            CanvasDocumentStatus::Ready
            | CanvasDocumentStatus::Saving
            | CanvasDocumentStatus::SaveError { .. }
            | CanvasDocumentStatus::Conflict { .. } => 2u8,
        };
        let kind = classify_canvas_path(&doc.path).unwrap_or(CanvasFileKind::Text);
        let (disk_hash, disk_content) = cached_canvas_text(0, &doc.disk_content);
        let (draft_hash, draft_content) = if doc.draft_content == doc.disk_content {
            (disk_hash, Rc::clone(&disk_content))
        } else {
            cached_canvas_text(1, &doc.draft_content)
        };
        return Some(Rc::new(ResolvedCanvasDoc {
            doc_identity: format!("session\0{}\0{}", doc.workspace_id, doc.document_id),
            session_key: format!(
                "session\0{}\0{}\0{}\0{ready_phase}",
                doc.workspace_id, doc.document_id, doc.generation
            ),
            workspace_id: doc.workspace_id.clone(),
            path: doc.path.clone(),
            title: title_for_path(&doc.path),
            disk_hash,
            draft_hash,
            disk_content,
            draft_content,
            kind,
            truncated: doc.truncated,
            lifecycle,
            error_message,
            live_session: Some(LiveSessionMeta {
                document_id: doc.document_id.clone(),
                generation: doc.generation,
                dirty: doc.dirty(),
            }),
        }));
    }

    let preview = s.active_file_preview.as_ref()?;
    if preview.is_binary {
        return None;
    }
    let kind = classify_canvas_path(&preview.path)?;
    let raw_content = preview.content.as_deref().unwrap_or("");
    let (disk_hash, disk_content) = cached_canvas_text(0, raw_content);
    let draft_content = Rc::clone(&disk_content);
    let lifecycle = if preview.error.is_some() {
        CanvasLifecycleKind::LoadError
    } else if preview.content.is_none() && !preview.truncated {
        CanvasLifecycleKind::Loading
    } else {
        CanvasLifecycleKind::Ready
    };

    Some(Rc::new(ResolvedCanvasDoc {
        doc_identity: format!("preview\0{}\0{}", preview.workspace_id, preview.path),
        session_key: format!("preview\0{}\0{}", preview.workspace_id, preview.path),
        workspace_id: preview.workspace_id.clone(),
        path: preview.path.clone(),
        title: preview.title.clone(),
        disk_hash,
        draft_hash: disk_hash,
        draft_content,
        disk_content,
        kind,
        truncated: preview.truncated,
        lifecycle,
        error_message: preview.error.clone(),
        live_session: None,
    }))
}

fn ensure_canvas_synced(ui: &mut CanvasUiState, doc: &ResolvedCanvasDoc, force_reset: bool) {
    ui.sync_session(
        &doc.doc_identity,
        &doc.session_key,
        doc.disk_hash,
        &doc.disk_content,
        &doc.draft_content,
        doc.kind == CanvasFileKind::Markdown,
        doc.live_session.is_some(),
        force_reset,
    );
}

fn sync_live_draft(s: &mut AppState, doc: &ResolvedCanvasDoc) {
    let Some(ref live) = doc.live_session else {
        return;
    };
    if doc.truncated
        || matches!(
            doc.lifecycle,
            CanvasLifecycleKind::Loading | CanvasLifecycleKind::LoadError
        )
    {
        return;
    }
    if s.chat_ui.canvas.synced_session_key.as_deref() != Some(doc.session_key.as_str()) {
        return;
    }
    let needs_dispatch = s.canvas_document.as_ref().is_some_and(|session| {
        session.document_id == live.document_id
            && session.generation == live.generation
            && session.draft_content != s.chat_ui.canvas.source_edit.text
    });
    if needs_dispatch {
        let next = s.chat_ui.canvas.source_edit.text.clone();
        s.dispatch(Action::Chat(ChatAction::UpdateCanvasDraft {
            document_id: live.document_id.clone(),
            generation: live.generation,
            content: next,
        }));
    }
}

fn resolve_canvas_abs_path(s: &AppState, workspace_id: &str, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    if let Some(ws) = s.workspaces.iter().find(|w| w.id == workspace_id) {
        return Path::new(&ws.path).join(p);
    }
    p.to_path_buf()
}

fn trigger_save(s: &mut AppState, doc: &ResolvedCanvasDoc) {
    ensure_canvas_synced(&mut s.chat_ui.canvas, doc, false);
    if doc.truncated {
        return;
    }
    if let Some(ref live) = doc.live_session {
        sync_live_draft(s, doc);
        let is_dirty_now = s.chat_ui.canvas.is_dirty()
            || s.canvas_document
                .as_ref()
                .is_some_and(|session| session.dirty());
        if !is_dirty_now && doc.lifecycle != CanvasLifecycleKind::SaveError {
            return;
        }
        s.chat_ui.canvas.local_error = None;
        if s.canvas_document.as_ref().is_some_and(|session| {
            session.document_id == live.document_id && session.generation == live.generation
        }) {
            s.dispatch(Action::Chat(ChatAction::SaveCanvasDocument));
        }
        return;
    }
    if !s.chat_ui.canvas.is_dirty() {
        return;
    }
    s.chat_ui.canvas.local_error = Some(
        "Workspace document save requires an active workspace document session; local edits remain in your draft buffer."
            .to_string(),
    );
}

fn trigger_save_as_dialog(s: &AppState, tx: &mut Tx, doc: &Rc<ResolvedCanvasDoc>) {
    if doc.truncated {
        return;
    }
    let suggested = resolve_canvas_abs_path(s, &doc.workspace_id, &doc.path);
    let opts = build_save_canvas_dialog(&suggested);
    let doc_for_cb = Rc::clone(doc);
    tx.save_file(opts, move |s: &mut AppState, result, _| {
        ensure_canvas_synced(&mut s.chat_ui.canvas, &doc_for_cb, false);
        match result {
            Ok(Some(chosen_path)) => {
                if doc_for_cb.live_session.is_some() {
                    sync_live_draft(s, &doc_for_cb);
                    s.chat_ui.canvas.local_error = None;
                    s.dispatch(Action::Chat(ChatAction::SaveCanvasDocumentAs {
                        path: chosen_path.to_string_lossy().into_owned(),
                    }));
                } else {
                    s.chat_ui.canvas.local_error = Some(format!(
                        "Selected \"{}\" for Save As; live workspace document session is unavailable for this preview.",
                        chosen_path.display()
                    ));
                }
            }
            Ok(None) => {}
            Err(err) => {
                s.chat_ui.canvas.local_error =
                    Some(format!("Could not open Save As dialog: {err}"));
            }
        }
    });
}

fn trigger_reload(s: &mut AppState, doc: &ResolvedCanvasDoc) {
    s.chat_ui.canvas.reload_confirm_open = false;
    s.chat_ui.canvas.local_error = None;
    if let Some(ref mut fx) = s.chat_ui.canvas.fixture {
        if matches!(
            fx.lifecycle,
            CanvasLifecycleKind::Conflict
                | CanvasLifecycleKind::LoadError
                | CanvasLifecycleKind::SaveError
        ) {
            fx.lifecycle = CanvasLifecycleKind::Ready;
            fx.message = None;
        }
        let content = fx.content.clone();
        let is_md = fx.is_markdown;
        s.chat_ui.canvas.sync_session(
            &doc.doc_identity,
            &doc.session_key,
            hash_text(&content),
            &content,
            &content,
            is_md,
            false,
            true,
        );
        return;
    }

    if let Some(ref live) = doc.live_session
        && s.canvas_document.as_ref().is_some_and(|session| {
            session.document_id == live.document_id && session.generation == live.generation
        })
    {
        // Keep `synced_doc_identity` intact across Reload so the user's tab (`Document`/`Source`)
        // persists while the incoming generation refreshes disk/draft state.
        s.chat_ui.canvas.synced_session_key = None;
        s.chat_ui.canvas.synced_disk_hash = None;
        s.chat_ui.canvas.synced_disk_content.clear();
        s.chat_ui.canvas.source_edit.clear();
        s.dispatch(Action::Chat(ChatAction::ReloadCanvasDocument));
        return;
    }

    s.chat_ui.canvas.sync_session(
        &doc.doc_identity,
        &doc.session_key,
        doc.disk_hash,
        &doc.disk_content,
        &doc.draft_content,
        doc.kind == CanvasFileKind::Markdown,
        false,
        true,
    );
    s.dispatch(Action::Native(NativeAction::LoadFilePreview {
        workspace_id: doc.workspace_id.clone(),
        path: doc.path.clone(),
    }));
}

fn trigger_close(s: &mut AppState) {
    if s.canvas_document.is_some() {
        s.dispatch(Action::Chat(ChatAction::CloseCanvasDocument));
    } else {
        s.chat_ui.canvas.clear();
    }
    if s.active_file_preview.is_some() {
        s.dispatch(Action::Shell(ShellAction::CloseFilePreview));
    }
}

fn canvas_view_synced(ui: &CanvasUiState, doc: &ResolvedCanvasDoc) -> bool {
    if ui.synced_session_key.as_deref() != Some(doc.session_key.as_str()) {
        return false;
    }
    // Own save completions (including undo-during-save) update `doc.disk_content` without
    // changing `doc.draft_content`, so `source_edit.text == *doc.draft_content` stays true and
    // must keep `source_edit` mounted and focused. Only flag out-of-sync when an external
    // disk+draft refresh diverges from a clean UI buffer.
    let disk_changed_while_ui_clean = ui.synced_disk_hash != Some(doc.disk_hash)
        && !ui.is_dirty()
        && ui.source_edit.text != *doc.draft_content;
    !disk_changed_while_ui_clean
}

fn active_selection_excerpt<'a>(ui: &'a CanvasUiState, doc: &ResolvedCanvasDoc) -> Option<&'a str> {
    if !canvas_view_synced(ui, doc) {
        return None;
    }
    let (a, b) = ui.source_edit.range();
    if a >= b {
        return None;
    }
    ui.source_edit
        .text
        .get(a..b)
        .filter(|s| !s.trim().is_empty())
}

fn submit_canvas_prompt(s: &mut AppState, doc: &ResolvedCanvasDoc) {
    let request = s.chat_ui.canvas.prompt_edit.text.trim().to_string();
    if request.is_empty() || doc.truncated {
        return;
    }
    let Some(thread_id) = s.nav.current().active_thread_id.clone() else {
        s.chat_ui.canvas.local_error = Some(
            "Open or start a conversation thread to ask the model to edit this document."
                .to_string(),
        );
        return;
    };

    let rt = s.thread_runtime_by_id.get(&thread_id);
    if rt.is_some_and(|r| r.transcript_only) {
        return;
    }
    let streaming = rt.is_some_and(|r| r.streaming || r.active_turn_id.is_some());
    let selection = active_selection_excerpt(&s.chat_ui.canvas, doc).map(str::to_string);
    let prompt_xml = build_canvas_document_prompt(
        &doc.path,
        &doc.title,
        doc.kind,
        selection.as_deref(),
        &request,
    );

    let (catalog, _) = cached_mention_catalog_for_state(s);
    let references = extract_references_from_text(&request, &catalog);
    let busy_policy = if streaming {
        ThreadBusyPolicy::Steer
    } else {
        ThreadBusyPolicy::Queue
    };

    s.chat_ui.canvas.prompt_edit.clear();
    s.chat_ui.canvas.local_error = None;
    s.dispatch(Action::Chat(ChatAction::SendMessage {
        thread_id: Some(thread_id),
        text: prompt_xml,
        busy_policy,
        attachments: Vec::new(),
        references,
    }));
}

fn save_badge_meta(doc: &ResolvedCanvasDoc, dirty: bool) -> (&'static str, StatusPillTone) {
    if doc.truncated {
        return ("Read-only", StatusPillTone::Warning);
    }
    match doc.lifecycle {
        CanvasLifecycleKind::Loading => ("Loading", StatusPillTone::Neutral),
        CanvasLifecycleKind::Saving => ("Saving", StatusPillTone::Accent),
        CanvasLifecycleKind::Conflict => ("Conflict", StatusPillTone::Danger),
        CanvasLifecycleKind::LoadError | CanvasLifecycleKind::SaveError => {
            ("Error", StatusPillTone::Danger)
        }
        CanvasLifecycleKind::Ready => {
            if dirty {
                ("Unsaved", StatusPillTone::Warning)
            } else {
                ("Saved", StatusPillTone::Success)
            }
        }
    }
}

struct CanvasDocTabMemoInputs<'a> {
    ws_path: Option<&'a str>,
    live_text_rc: Rc<str>,
    live_text_hash: u64,
    active_copied_key: Option<&'a str>,
    doc_math_gen: u64,
    doc_img_gen: u64,
    dark: bool,
}

/// Renders the right-rail (or maximized) Canvas document pane when a supported document is active
/// and the `"canvas"` feature flag (or a headless Canvas fixture) is enabled.
pub fn canvas_pane(s: &AppState, cx: &mut Cx<AppState>, k: &Kit) -> Option<SubviewOutput> {
    let doc = resolve_active_canvas_doc(s)?;
    let dark = s.effective_dark(cx.system_dark());
    let t = resolve_cached_tokens(
        dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        s.desktop_settings.accent_palette,
    );

    let same_doc =
        s.chat_ui.canvas.synced_doc_identity.as_deref() == Some(doc.doc_identity.as_str());
    let view_synced = canvas_view_synced(&s.chat_ui.canvas, &doc);
    let dirty = if let Some(ref live) = doc.live_session {
        live.dirty || (view_synced && s.chat_ui.canvas.source_edit.text != *doc.draft_content)
    } else if view_synced {
        s.chat_ui.canvas.is_dirty()
    } else {
        false
    };
    let active_tab = if view_synced || same_doc {
        s.chat_ui.canvas.active_tab
    } else if doc.kind == CanvasFileKind::Markdown {
        CanvasTab::Document
    } else {
        CanvasTab::Source
    };
    let (live_text_hash, live_text_rc) =
        if !view_synced || s.chat_ui.canvas.source_edit.text == *doc.draft_content {
            (doc.draft_hash, Rc::clone(&doc.draft_content))
        } else {
            cached_canvas_text(2, &s.chat_ui.canvas.source_edit.text)
        };
    let live_text = live_text_rc.as_ref();

    let mut overlays = Vec::new();
    build_reload_confirm_dialog(s, k, &doc, dirty, &mut overlays);
    build_discard_confirm_dialog(s, k, &doc, &mut overlays);

    let ws_path = s
        .workspaces
        .iter()
        .find(|w| w.id == doc.workspace_id)
        .map(|w| w.path.as_str());
    let thread = s.active_thread();
    let rt = s.active_thread_runtime();
    let ws_rt = thread.and_then(|tr| s.workspace_runtime_by_id.get(&tr.workspace_id));
    let transcript_only = rt.is_some_and(|r| r.transcript_only);
    let disconnected = thread.is_none()
        || ws_rt.is_some_and(|w| !matches!(w.server_state, ServerLifecycleState::Running { .. }));
    let reconnecting = workspace_is_reconnecting(ws_rt);

    let is_markdown_doc_tab =
        active_tab == CanvasTab::Document && doc.kind == CanvasFileKind::Markdown;
    let active_copied_key = if is_markdown_doc_tab {
        s.chat_ui
            .copied_feedback
            .as_ref()
            .filter(|(key, exp)| {
                s.now_secs < *exp
                    && key
                        .strip_prefix("canvas:")
                        .is_some_and(|rest| rest.starts_with(doc.session_key.as_str()))
            })
            .map(|(key, _)| key.as_str())
    } else {
        None
    };
    let doc_math_gen = if is_markdown_doc_tab && live_text.contains("$$") {
        raster_generation()
    } else {
        0
    };
    let doc_img_gen =
        if is_markdown_doc_tab && (live_text.contains("![") || live_text.contains("<img")) {
            image_decode_generation()
        } else {
            0
        };

    let doc_tab_inputs = CanvasDocTabMemoInputs {
        ws_path,
        live_text_rc: Rc::clone(&live_text_rc),
        live_text_hash,
        active_copied_key,
        doc_math_gen,
        doc_img_gen,
        dark,
    };

    let has_preedit = s.chat_ui.canvas.source_edit.preedit().is_some()
        || s.chat_ui.canvas.prompt_edit.preedit().is_some();

    let build_root = || {
        let mut root = col()
            .w_full()
            .h_full()
            .grow(1.0)
            .min_w(0.0)
            .min_h(0.0)
            .fill(t.panel_bg)
            .child(build_header_row(s, k, &t, &doc, dirty))
            .child(build_toolbar_row(s, k, &t, &doc, active_tab, dirty));

        if doc.kind == CanvasFileKind::Markdown
            && active_tab == CanvasTab::Source
            && s.chat_ui.canvas.show_formatting_bar
            && !doc.truncated
            && !matches!(
                doc.lifecycle,
                CanvasLifecycleKind::Loading | CanvasLifecycleKind::LoadError
            )
        {
            root = root.child(build_formatting_bar(k, &t, &doc));
        }

        if let Some(banners) = build_banners(s, k, &t, &doc, dirty) {
            root = root.child(banners);
        }

        root.child(build_body(
            s,
            k,
            &t,
            &doc,
            view_synced,
            active_tab,
            live_text,
            &doc_tab_inputs,
        ))
        .child(build_prompt_footer(s, k, &t, &doc, view_synced))
    };

    let content = if has_preedit {
        build_root().key("canvas-pane")
    } else {
        let mut h = DefaultHasher::new();
        doc.doc_identity.hash(&mut h);
        doc.session_key.hash(&mut h);
        doc.workspace_id.hash(&mut h);
        doc.path.hash(&mut h);
        doc.title.hash(&mut h);
        doc.disk_hash.hash(&mut h);
        doc.draft_hash.hash(&mut h);
        doc.kind.hash(&mut h);
        doc.truncated.hash(&mut h);
        doc.lifecycle.hash(&mut h);
        doc.error_message.hash(&mut h);
        doc.live_session.hash(&mut h);
        view_synced.hash(&mut h);
        dirty.hash(&mut h);
        active_tab.hash(&mut h);
        live_text_hash.hash(&mut h);
        live_text.len().hash(&mut h);
        s.chat_ui.canvas.maximized.hash(&mut h);
        s.chat_ui.canvas.show_formatting_bar.hash(&mut h);
        s.chat_ui.canvas.local_error.hash(&mut h);
        if view_synced {
            s.chat_ui.canvas.source_edit.anchor.hash(&mut h);
            s.chat_ui.canvas.source_edit.focus.hash(&mut h);
            s.chat_ui.canvas.source_edit.focused.hash(&mut h);
        }
        s.chat_ui.canvas.prompt_edit.text.hash(&mut h);
        s.chat_ui.canvas.prompt_edit.anchor.hash(&mut h);
        s.chat_ui.canvas.prompt_edit.focus.hash(&mut h);
        s.chat_ui.canvas.prompt_edit.focused.hash(&mut h);
        ws_path.hash(&mut h);
        thread.map(|tr| tr.id.as_str()).hash(&mut h);
        transcript_only.hash(&mut h);
        disconnected.hash(&mut h);
        reconnecting.hash(&mut h);
        dark.hash(&mut h);
        s.desktop_settings.reduced_transparency.hash(&mut h);
        s.desktop_settings.high_contrast.hash(&mut h);
        s.desktop_settings.accent_palette.hash(&mut h);
        s.desktop_settings.reduce_motion.hash(&mut h);
        s.ui_scale.to_bits().hash(&mut h);
        s.services.waker.is_some().hash(&mut h);
        active_copied_key.hash(&mut h);
        doc_math_gen.hash(&mut h);
        doc_img_gen.hash(&mut h);
        memo("canvas-pane", h.finish(), build_root)
    };

    Some(SubviewOutput { content, overlays })
}

fn build_header_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &ResolvedCanvasDoc,
    dirty: bool,
) -> El {
    let (badge_label, badge_tone) = save_badge_meta(doc, dirty);
    let maximized = s.chat_ui.canvas.maximized;
    let max_glyph = if maximized {
        &icons::MINIMIZE_2
    } else {
        &icons::MAXIMIZE_2
    };
    let max_help = if maximized {
        "Restore side panel"
    } else {
        "Maximize Canvas"
    };

    row()
        .key("canvas-header")
        .w_full()
        .items_center()
        .gap(8.0)
        .px(12.0)
        .py(8.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .fill(t.panel_bg)
        .child(icon(&icons::FILE_TEXT, 15.0).color(t.accent))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .gap(1.0)
                .child(
                    text(doc.title.clone())
                        .font(k.ty.ui_medium)
                        .color(t.text_base)
                        .truncate(),
                )
                .child(
                    text(doc.path.clone())
                        .font(k.ty.small)
                        .color(t.text_faint)
                        .truncate(),
                ),
        )
        .child(status_pill(k, t, badge_label, badge_tone).key("canvas-save-badge"))
        .child(
            IconButton::new(max_glyph)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .label(max_help)
                .help(max_help)
                .on_press(|s: &mut AppState| {
                    s.chat_ui.canvas.maximized = !s.chat_ui.canvas.maximized;
                })
                .build(k)
                .key("canvas-maximize-btn"),
        )
        .child(
            IconButton::new(k.glyph.close)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .label("Close Canvas")
                .help("Close Canvas")
                .on_press(|s: &mut AppState| {
                    trigger_close(s);
                })
                .build(k)
                .key("canvas-close-btn"),
        )
}

fn build_toolbar_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &Rc<ResolvedCanvasDoc>,
    active_tab: CanvasTab,
    dirty: bool,
) -> El {
    let tab_idx = match active_tab {
        CanvasTab::Document => 0,
        CanvasTab::Source => 1,
    };
    let doc_tabs = Rc::clone(doc);
    let disabled_tabs = matches!(
        doc.lifecycle,
        CanvasLifecycleKind::Loading | CanvasLifecycleKind::LoadError
    );

    let mut seg = SegmentedControl::new(&["Document", "Source"], Some(tab_idx))
        .label("Canvas view")
        .fit();
    if disabled_tabs {
        seg = seg
            .segment_state(0, State::Disabled)
            .segment_state(1, State::Disabled);
    } else {
        seg = seg.on_pick(move |s: &mut AppState, idx, tx| {
            ensure_canvas_synced(&mut s.chat_ui.canvas, &doc_tabs, false);
            s.chat_ui.canvas.active_tab = if idx == 0 {
                CanvasTab::Document
            } else {
                CanvasTab::Source
            };
            if s.chat_ui.canvas.active_tab == CanvasTab::Source {
                s.chat_ui.canvas.source_edit.focused = true;
                tx.focus("canvas-source-input", false);
            }
        });
    }

    let mut left_group = row()
        .items_center()
        .gap(6.0)
        .child(el().key("canvas-view-tabs").child(seg.build(k)));

    if doc.kind == CanvasFileKind::Markdown && active_tab == CanvasTab::Source {
        let formatting_on = s.chat_ui.canvas.show_formatting_bar;
        let doc_fmt = Rc::clone(doc);
        left_group = left_group.child(
            Button::new("Styling")
                .variant(if formatting_on {
                    ButtonVariant::Outline
                } else {
                    ButtonVariant::Ghost
                })
                .control_size(ControlSize::Small)
                .disabled(disabled_tabs || doc.truncated)
                .help("Toggle Markdown formatting toolbar")
                .on_press(move |s: &mut AppState| {
                    ensure_canvas_synced(&mut s.chat_ui.canvas, &doc_fmt, false);
                    s.chat_ui.canvas.show_formatting_bar = !s.chat_ui.canvas.show_formatting_bar;
                })
                .build(k)
                .key("canvas-styling-toggle"),
        );
    }

    let can_save = (dirty || doc.lifecycle == CanvasLifecycleKind::SaveError)
        && !doc.truncated
        && !matches!(
            doc.lifecycle,
            CanvasLifecycleKind::Loading
                | CanvasLifecycleKind::Saving
                | CanvasLifecycleKind::LoadError
                | CanvasLifecycleKind::Conflict
        );
    let can_save_as = !doc.truncated
        && !matches!(
            doc.lifecycle,
            CanvasLifecycleKind::Loading | CanvasLifecycleKind::LoadError
        );
    let doc_save = Rc::clone(doc);
    let doc_save_as = Rc::clone(doc);

    let save_label = if doc.lifecycle == CanvasLifecycleKind::Saving {
        "Saving..."
    } else {
        "Save"
    };
    let right_group = row()
        .items_center()
        .gap(6.0)
        .child(
            Button::new(save_label)
                .variant(if can_save {
                    ButtonVariant::Neutral
                } else {
                    ButtonVariant::Ghost
                })
                .control_size(ControlSize::Small)
                .icon(&icons::SAVE)
                .disabled(!can_save)
                .help(format!(
                    "Save document ({})",
                    crate::shortcut_label("Cmd+S")
                ))
                .on_press(move |s: &mut AppState| {
                    trigger_save(s, &doc_save);
                })
                .build(k)
                .key("canvas-save-btn"),
        )
        .child(
            Button::new("Save As")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::FILE_PLUS)
                .disabled(!can_save_as)
                .help(if doc.truncated {
                    "Save As is disabled because this document is truncated"
                } else {
                    "Save a copy in workspace"
                })
                .on_press_tx(move |s: &mut AppState, tx| {
                    trigger_save_as_dialog(s, tx, &doc_save_as);
                })
                .build(k)
                .key("canvas-save-as-btn"),
        );

    row()
        .key("canvas-toolbar")
        .w_full()
        .flex_wrap()
        .items_center()
        .justify_between()
        .gap(8.0)
        .px(12.0)
        .py(6.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .fill(k.alpha(t.sidebar_bg, 0.55))
        .child(left_group)
        .child(right_group)
}

fn format_icon_btn(
    k: &Kit,
    doc: &Rc<ResolvedCanvasDoc>,
    key: &'static str,
    glyph: &'static rune::Icon,
    help: impl Into<String>,
    kind: MarkdownFormatKind,
) -> El {
    let doc_cb = Rc::clone(doc);
    let help = help.into();
    IconButton::new(glyph)
        .variant(IconButtonVariant::Ghost)
        .control_size(ControlSize::Mini)
        .label(help.clone())
        .help(help)
        .on_press_tx(move |s: &mut AppState, tx| {
            apply_canvas_format_action(s, &doc_cb, kind, Some(tx));
        })
        .build(k)
        .key(key)
}

fn format_text_btn(
    k: &Kit,
    doc: &Rc<ResolvedCanvasDoc>,
    key: &'static str,
    label: &'static str,
    help: &'static str,
    kind: MarkdownFormatKind,
) -> El {
    let doc_cb = Rc::clone(doc);
    Button::new(label)
        .variant(ButtonVariant::Ghost)
        .control_size(ControlSize::Mini)
        .help(help)
        .on_press_tx(move |s: &mut AppState, tx| {
            apply_canvas_format_action(s, &doc_cb, kind, Some(tx));
        })
        .build(k)
        .key(key)
}

fn apply_canvas_format_action(
    s: &mut AppState,
    doc: &ResolvedCanvasDoc,
    kind: MarkdownFormatKind,
    tx: Option<&mut Tx>,
) {
    if doc.truncated || doc.kind != CanvasFileKind::Markdown {
        return;
    }
    ensure_canvas_synced(&mut s.chat_ui.canvas, doc, false);
    apply_format_to_text_edit(&mut s.chat_ui.canvas.source_edit, kind);
    s.chat_ui.canvas.active_tab = CanvasTab::Source;
    s.chat_ui.canvas.source_edit.focused = true;
    s.chat_ui.canvas.local_error = None;
    sync_live_draft(s, doc);
    if let Some(tx) = tx {
        tx.focus("canvas-source-input", false);
    }
}

fn build_formatting_bar(k: &Kit, t: &ThemeTokens, doc: &Rc<ResolvedCanvasDoc>) -> El {
    let sep = || {
        el().w(1.0)
            .h(14.0)
            .mx(2.0)
            .fill(k.alpha(t.border_strong, 0.55))
    };

    row()
        .key("canvas-formatting-bar")
        .w_full()
        .flex_wrap()
        .items_center()
        .gap(3.0)
        .px(12.0)
        .py(5.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .fill(t.elevated_bg)
        .child(format_icon_btn(
            k,
            doc,
            "canvas-fmt-bold",
            &icons::BOLD,
            format!("Bold ({})", crate::shortcut_label("Cmd+B")),
            MarkdownFormatKind::Bold,
        ))
        .child(format_icon_btn(
            k,
            doc,
            "canvas-fmt-italic",
            &icons::ITALIC,
            format!("Italic ({})", crate::shortcut_label("Cmd+I")),
            MarkdownFormatKind::Italic,
        ))
        .child(sep())
        .child(format_text_btn(
            k,
            doc,
            "canvas-fmt-h1",
            "H1",
            "Heading 1",
            MarkdownFormatKind::H1,
        ))
        .child(format_text_btn(
            k,
            doc,
            "canvas-fmt-h2",
            "H2",
            "Heading 2",
            MarkdownFormatKind::H2,
        ))
        .child(format_text_btn(
            k,
            doc,
            "canvas-fmt-h3",
            "H3",
            "Heading 3",
            MarkdownFormatKind::H3,
        ))
        .child(format_text_btn(
            k,
            doc,
            "canvas-fmt-body",
            "Body",
            "Normal paragraph",
            MarkdownFormatKind::Normal,
        ))
        .child(sep())
        .child(format_icon_btn(
            k,
            doc,
            "canvas-fmt-ul",
            &icons::LIST,
            "Bullet list",
            MarkdownFormatKind::BulletList,
        ))
        .child(format_icon_btn(
            k,
            doc,
            "canvas-fmt-ol",
            &icons::LIST_ORDERED,
            "Numbered list",
            MarkdownFormatKind::NumberedList,
        ))
}

fn build_banners(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &Rc<ResolvedCanvasDoc>,
    dirty: bool,
) -> Option<El> {
    let mut stack = col()
        .key("canvas-banners")
        .w_full()
        .px(12.0)
        .pt(8.0)
        .gap(6.0);
    let mut any = false;

    if doc.lifecycle == CanvasLifecycleKind::Conflict {
        any = true;
        let msg = doc.error_message.clone().unwrap_or_else(|| {
            "File changed on disk. Your unsaved edits were not overwritten.".to_string()
        });
        let doc_reload = Rc::clone(doc);
        let doc_save_as = Rc::clone(doc);
        stack = stack.child(
            alert_banner(
                k,
                t,
                "canvas-conflict-banner",
                t.danger,
                "File changed on disk",
                &msg,
            )
            .child(
                row()
                    .w_full()
                    .flex_wrap()
                    .gap(6.0)
                    .pt(2.0)
                    .child(
                        Button::new("Reload from disk")
                            .variant(ButtonVariant::Danger)
                            .control_size(ControlSize::Small)
                            .icon(&icons::ROTATE_CCW)
                            .on_press(move |s: &mut AppState| {
                                if dirty {
                                    s.chat_ui.canvas.reload_confirm_open = true;
                                } else {
                                    trigger_reload(s, &doc_reload);
                                }
                            })
                            .build(k)
                            .key("canvas-conflict-reload-btn"),
                    )
                    .child(
                        Button::new("Save As")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .icon(&icons::FILE_PLUS)
                            .disabled(doc.truncated)
                            .on_press_tx(move |s: &mut AppState, tx| {
                                trigger_save_as_dialog(s, tx, &doc_save_as);
                            })
                            .build(k),
                    ),
            ),
        );
    }

    if doc.lifecycle == CanvasLifecycleKind::SaveError {
        any = true;
        let msg = doc
            .error_message
            .clone()
            .unwrap_or_else(|| "Failed to save changes.".to_string());
        let doc_retry = Rc::clone(doc);
        let doc_save_as = Rc::clone(doc);
        stack = stack.child(
            alert_banner(
                k,
                t,
                "canvas-save-error-banner",
                t.danger,
                "Save failed",
                &msg,
            )
            .child(
                row()
                    .w_full()
                    .flex_wrap()
                    .gap(6.0)
                    .pt(2.0)
                    .child(
                        Button::new("Retry Save")
                            .variant(ButtonVariant::Danger)
                            .control_size(ControlSize::Small)
                            .icon(&icons::ROTATE_CCW)
                            .on_press(move |s: &mut AppState| {
                                trigger_save(s, &doc_retry);
                            })
                            .build(k)
                            .key("canvas-retry-save-btn"),
                    )
                    .child(
                        Button::new("Save As")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .icon(&icons::FILE_PLUS)
                            .disabled(doc.truncated)
                            .on_press_tx(move |s: &mut AppState, tx| {
                                trigger_save_as_dialog(s, tx, &doc_save_as);
                            })
                            .build(k),
                    ),
            ),
        );
    }

    if doc.truncated {
        any = true;
        stack = stack.child(alert_banner(
            k,
            t,
            "canvas-truncated-banner",
            t.warning,
            "Large document (read-only)",
            "This file exceeded the inline size limit and was truncated. Editing and saving are disabled to prevent overwriting unshown content.",
        ));
    }

    if let Some(ref local_err) = s.chat_ui.canvas.local_error {
        any = true;
        stack = stack.child(
            alert_banner(
                k,
                t,
                "canvas-local-notice",
                t.warning,
                "Canvas notice",
                local_err,
            )
            .child(
                row().w_full().justify_end().child(
                    Button::new("Dismiss")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Mini)
                        .on_press(|s: &mut AppState| {
                            s.chat_ui.canvas.local_error = None;
                        })
                        .build(k),
                ),
            ),
        );
    }

    any.then_some(stack)
}

fn alert_banner(
    k: &Kit,
    t: &ThemeTokens,
    key: &'static str,
    accent: Color,
    title: &str,
    message: &str,
) -> El {
    col()
        .key(key)
        .w_full()
        .min_w(0.0)
        .gap(4.0)
        .px(10.0)
        .py(8.0)
        .radius(8.0)
        .fill(k.alpha(accent, 0.11))
        .border(1.0, k.alpha(accent, 0.35))
        .child(
            row()
                .items_center()
                .gap(6.0)
                .child(icon(&icons::ALERT, 14.0).color(accent))
                .child(
                    text(title.to_string())
                        .font(k.ty.small_medium)
                        .color(t.text_base),
                ),
        )
        .child(
            text(message.to_string())
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
                .w_full()
                .min_w(0.0)
                .wrap(),
        )
}

#[allow(clippy::too_many_arguments)]
fn build_body(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &Rc<ResolvedCanvasDoc>,
    synced: bool,
    active_tab: CanvasTab,
    live_text: &str,
    doc_tab_inputs: &CanvasDocTabMemoInputs<'_>,
) -> El {
    if doc.lifecycle == CanvasLifecycleKind::Loading {
        return col()
            .key("canvas-loading")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .center()
            .gap(10.0)
            .child(Spinner::new().size(20.0).color(t.text_muted).build(k))
            .child(
                text("Loading document...")
                    .font(k.ty.text_small)
                    .color(t.text_muted),
            );
    }

    if doc.lifecycle == CanvasLifecycleKind::LoadError {
        let msg = doc
            .error_message
            .clone()
            .unwrap_or_else(|| "Unable to open this file in Canvas.".to_string());
        let doc_retry = Rc::clone(doc);
        return col()
            .key("canvas-load-error")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .center()
            .padding(20.0)
            .child(
                col()
                    .w_full()
                    .max_w(360.0)
                    .gap(10.0)
                    .padding(16.0)
                    .radius(10.0)
                    .fill(t.elevated_bg)
                    .border(1.0, k.alpha(t.danger, 0.35))
                    .child(
                        row()
                            .items_center()
                            .gap(8.0)
                            .child(icon(&icons::ALERT, 16.0).color(t.danger))
                            .child(
                                text("Failed to load document")
                                    .font(k.ty.ui_medium)
                                    .color(t.text_base),
                            ),
                    )
                    .child(
                        text(msg)
                            .font(k.ty.text_small)
                            .color(t.text_muted)
                            .w_full()
                            .wrap(),
                    )
                    .child(
                        row()
                            .gap(8.0)
                            .pt(4.0)
                            .child(
                                Button::new("Retry")
                                    .variant(ButtonVariant::Outline)
                                    .control_size(ControlSize::Small)
                                    .icon(&icons::ROTATE_CCW)
                                    .on_press(move |s: &mut AppState| {
                                        trigger_reload(s, &doc_retry);
                                    })
                                    .build(k)
                                    .key("canvas-load-retry-btn"),
                            )
                            .child(
                                Button::new("Close")
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .on_press(|s: &mut AppState| {
                                        trigger_close(s);
                                    })
                                    .build(k),
                            ),
                    ),
            );
    }

    match active_tab {
        CanvasTab::Document => build_document_tab(s, k, t, doc, live_text, doc_tab_inputs),
        CanvasTab::Source => build_source_tab(s, k, t, doc, synced, live_text),
    }
}

fn estimate_canvas_block_height(text: &str, ranges: &[(usize, usize)]) -> f32 {
    if ranges.is_empty() {
        return 64.0;
    }
    let mut sum = 0.0_f32;
    for &(start, end) in ranges {
        let block = text.get(start..end).unwrap_or("");
        let newlines = block.as_bytes().iter().filter(|&&b| b == b'\n').count() as f32;
        let wrapped = (block.len() as f32 / 78.0).max(1.0);
        let est = (16.0 + wrapped.max(newlines + 1.0) * 22.0).clamp(32.0, 360.0);
        sum += est;
    }
    (sum / ranges.len() as f32).clamp(48.0, 180.0)
}

struct CanvasDocBlocks {
    live_text: Rc<str>,
    live_text_hash: u64,
    ranges: CanvasBlockRanges,
    session_key: String,
    workspace_id: String,
    ws_path: Option<String>,
    reduce_motion: bool,
    ui_scale: f32,
    active_copied_key: Option<String>,
    doc_math_gen: u64,
    doc_img_gen: u64,
    external_cache: Option<Arc<ImageCache>>,
    math_waker: Option<Arc<dyn Fn() + Send + Sync>>,
    shared_ver: u64,
    kit: Kit,
    tokens: ThemeTokens,
}

impl CanvasDocBlocks {
    fn build(&self, _s: &AppState, idx: usize) -> El {
        let blk_key = format!("canvas-blk:{}:{idx}", self.session_key);
        let Some(&(start, end)) = self.ranges.get(idx) else {
            return col().key(blk_key);
        };
        let Some(block_src) = self.live_text.get(start..end) else {
            return col().key(blk_key);
        };
        let md_prefix = format!("canvas:{}:blk:{idx}", self.session_key);
        let scoped_copied = self.active_copied_key.as_deref().filter(|ck| {
            ck.strip_prefix(md_prefix.as_str())
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
        });
        let math_gen = if block_src.contains("$$") {
            self.doc_math_gen
        } else {
            0
        };
        let img_gen = if block_src.contains("![") || block_src.contains("<img") {
            self.doc_img_gen
        } else {
            0
        };
        let mut h = DefaultHasher::new();
        (
            self.shared_ver,
            self.live_text_hash,
            idx,
            start,
            end,
            scoped_copied,
            math_gen,
            img_gen,
        )
            .hash(&mut h);
        memo(blk_key.as_str(), h.finish(), || {
            let active_copied = scoped_copied.map(str::to_string);
            let active_copied_check = active_copied.clone();
            let rendered = desktop_markdown(
                &self.kit,
                &self.tokens,
                block_src,
                &md_prefix,
                false,
                false,
                self.reduce_motion,
                Some(self.workspace_id.as_str()),
                self.ws_path.as_deref(),
                &[],
                self.external_cache.clone(),
                MarkdownHooks {
                    is_copied: Some(Rc::new(move |key: &str| {
                        active_copied_check.as_deref() == Some(key)
                    })),
                    active_copied_key: active_copied,
                    on_copy: Some(Rc::new(
                        move |state: &mut AppState, key: String, _tx: &mut Tx| {
                            let now = state.now_secs;
                            state.chat_ui.mark_copied(key, now);
                        },
                    )),
                    on_citation_click: None,
                    math_waker: self.math_waker.clone(),
                    math_scale: Some((2.0 * self.ui_scale).clamp(2.0, 4.0)),
                },
            );
            col()
                .w_full()
                .max_w(840.0)
                .min_w(0.0)
                .child(rendered)
                .arrives_whole()
        })
    }
}

fn build_document_tab(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &ResolvedCanvasDoc,
    live_text: &str,
    inputs: &CanvasDocTabMemoInputs<'_>,
) -> El {
    if doc.kind == CanvasFileKind::Markdown && live_text.len() > VIRTUALIZE_MARKDOWN_MIN_BYTES {
        let ranges = cached_canvas_block_ranges(inputs.live_text_hash, &inputs.live_text_rc);
        if ranges.len() > 1 {
            let external_cache = shared_waker_image_cache(s.services.waker.as_ref());
            let mut sh = DefaultHasher::new();
            (
                doc.session_key.as_str(),
                doc.workspace_id.as_str(),
                inputs.ws_path,
                inputs.dark,
                s.desktop_settings.reduced_transparency,
                s.desktop_settings.high_contrast,
                s.desktop_settings.accent_palette,
                s.desktop_settings.reduce_motion,
                s.ui_scale.to_bits(),
                s.services.waker.is_some(),
                external_cache.as_ref().map(|c| Arc::as_ptr(c) as usize),
            )
                .hash(&mut sh);
            let shared_ver = sh.finish();

            let block_count = ranges.len();
            let est_h = estimate_canvas_block_height(live_text, &ranges);
            let session_key_for_keys = doc.session_key.clone();
            let blocks = Rc::new(CanvasDocBlocks {
                live_text: Rc::clone(&inputs.live_text_rc),
                live_text_hash: inputs.live_text_hash,
                ranges,
                session_key: doc.session_key.clone(),
                workspace_id: doc.workspace_id.clone(),
                ws_path: inputs.ws_path.map(str::to_string),
                reduce_motion: s.desktop_settings.reduce_motion,
                ui_scale: s.ui_scale,
                active_copied_key: inputs.active_copied_key.map(str::to_string),
                doc_math_gen: inputs.doc_math_gen,
                doc_img_gen: inputs.doc_img_gen,
                external_cache,
                math_waker: s.services.waker.clone(),
                shared_ver,
                kit: k.clone(),
                tokens: *t,
            });

            let blocks_stack = col()
                .key("canvas-doc-body")
                .w_full()
                .min_w(0.0)
                .items_center()
                .px(20.0)
                .py(18.0)
                .gap(10.0)
                .growth(GrowthSpec::default())
                .virtual_rows(
                    block_count,
                    est_h,
                    move |_: &AppState, i| {
                        Cow::Owned(format!("canvas-blk:{session_key_for_keys}:{i}"))
                    },
                    move |s: &AppState, i| blocks.build(s, i),
                );

            return col()
                .key("canvas-document-tab")
                .w_full()
                .grow(1.0)
                .min_w(0.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(blocks_stack);
        }
    }

    let mut h = DefaultHasher::new();
    doc.session_key.hash(&mut h);
    doc.workspace_id.hash(&mut h);
    doc.kind.hash(&mut h);
    inputs.ws_path.hash(&mut h);
    inputs.live_text_hash.hash(&mut h);
    live_text.len().hash(&mut h);
    inputs.active_copied_key.hash(&mut h);
    inputs.doc_math_gen.hash(&mut h);
    inputs.doc_img_gen.hash(&mut h);
    inputs.dark.hash(&mut h);
    s.desktop_settings.reduced_transparency.hash(&mut h);
    s.desktop_settings.high_contrast.hash(&mut h);
    s.desktop_settings.accent_palette.hash(&mut h);
    s.desktop_settings.reduce_motion.hash(&mut h);
    s.ui_scale.to_bits().hash(&mut h);
    s.services.waker.is_some().hash(&mut h);
    let body_ver = h.finish();

    let rendered = memo("canvas-doc-body", body_ver, || {
        let inner = if live_text.trim().is_empty() {
            text("This document is empty. Switch to Source to start writing.")
                .font(t.body)
                .color(t.text_faint)
                .wrap()
        } else if doc.kind == CanvasFileKind::Markdown {
            let active_copied = inputs.active_copied_key.map(str::to_string);
            let active_copied_check = active_copied.clone();
            let external_cache = shared_waker_image_cache(s.services.waker.as_ref());
            desktop_markdown(
                k,
                t,
                live_text,
                &format!("canvas:{}", doc.session_key),
                false,
                false,
                s.desktop_settings.reduce_motion,
                Some(&doc.workspace_id),
                inputs.ws_path,
                &[],
                external_cache,
                MarkdownHooks {
                    is_copied: Some(Rc::new(move |key: &str| {
                        active_copied_check.as_deref() == Some(key)
                    })),
                    active_copied_key: active_copied,
                    on_copy: Some(Rc::new(
                        move |state: &mut AppState, key: String, _tx: &mut Tx| {
                            let now = state.now_secs;
                            state.chat_ui.mark_copied(key, now);
                        },
                    )),
                    on_citation_click: None,
                    math_waker: s.services.waker.clone(),
                    math_scale: Some((2.0 * s.ui_scale).clamp(2.0, 4.0)),
                },
            )
        } else {
            col()
                .w_full()
                .min_w(0.0)
                .padding(14.0)
                .radius(8.0)
                .fill(t.code_bg)
                .border(1.0, t.border_muted)
                .child(
                    text(live_text.to_string())
                        .font(t.code)
                        .color(t.text_base)
                        .w_full()
                        .min_w(0.0)
                        .wrap()
                        .selectable(true),
                )
        };
        col().w_full().min_w(0.0).child(inner)
    });

    col()
        .key("canvas-document-tab")
        .w_full()
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .items_center()
                .px(20.0)
                .py(18.0)
                .child(col().w_full().max_w(840.0).min_w(0.0).child(rendered)),
        )
}

fn build_source_tab(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &Rc<ResolvedCanvasDoc>,
    synced: bool,
    live_text: &str,
) -> El {
    let fallback_edit;
    let edit_ref = if synced {
        &s.chat_ui.canvas.source_edit
    } else {
        fallback_edit = TextEdit::new(doc.draft_content.as_ref());
        &fallback_edit
    };
    let read_only = doc.truncated || doc.lifecycle == CanvasLifecycleKind::Loading;
    let doc_edit = Rc::clone(doc);
    let doc_change = Rc::clone(doc);
    let doc_key = Rc::clone(doc);

    let mut field = text_input(
        edit_ref,
        TextStyle {
            line_height: 19.0,
            ..t.code
        },
    )
    .key("canvas-source-input")
    .label("Canvas document source")
    .color(t.text_base)
    .w_full()
    .min_h(220.0)
    .placeholder("Write Markdown or plain text...", t.text_faint)
    .caret(t.accent, t.selection_bg)
    .disabled(read_only);

    if !read_only {
        field = field
            .on_edit(move |state: &mut AppState| {
                ensure_canvas_synced(&mut state.chat_ui.canvas, &doc_edit, false);
                &mut state.chat_ui.canvas.source_edit
            })
            .on_input_change(move |state: &mut AppState, _| {
                state.chat_ui.canvas.local_error = None;
                sync_live_draft(state, &doc_change);
            })
            .on_input_key(move |state: &mut AppState, ev: &KeyEvent, tx| {
                handle_source_editor_key(state, &doc_key, ev, tx)
            });
    }

    let char_count = if live_text.is_ascii() {
        live_text.len()
    } else {
        live_text.chars().count()
    };
    let line_count = if live_text.is_empty() {
        1
    } else {
        live_text.as_bytes().iter().filter(|&&b| b == b'\n').count() + 1
    };
    let char_unit = if char_count == 1 { "char" } else { "chars" };
    let line_unit = if line_count == 1 { "line" } else { "lines" };
    let border_col = if edit_ref.focused && !read_only {
        t.focus_ring
    } else {
        t.border
    };

    let mut editor_card = col()
        .key("canvas-source-editor-card")
        .w_full()
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .radius(8.0)
        .fill(t.input_bg)
        .border(1.0, border_col)
        .padding(12.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(field);
    if !read_only {
        editor_card = editor_card.on_press_tx(|_: &mut AppState, tx| {
            tx.focus("canvas-source-input", false);
        });
    }

    col()
        .key("canvas-source-tab")
        .w_full()
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .padding(12.0)
        .gap(6.0)
        .child(editor_card)
        .child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .px(2.0)
                .child(
                    text(source_shortcut_hint(doc.kind, read_only))
                        .font(k.ty.small)
                        .color(t.text_faint)
                        .truncate(),
                )
                .child(
                    text(format!(
                        "{char_count} {char_unit} · {line_count} {line_unit}"
                    ))
                    .font(k.ty.small)
                    .color(t.text_muted),
                ),
        )
}

fn source_shortcut_hint_for_platform(
    kind: CanvasFileKind,
    read_only: bool,
    is_macos: bool,
) -> String {
    if read_only {
        return "Read-only preview".to_string();
    }
    let save = crate::shortcut_label_for_platform("Cmd+S", is_macos);
    if kind == CanvasFileKind::Markdown {
        let bold = crate::shortcut_label_for_platform("Cmd+B", is_macos);
        let italic = crate::shortcut_label_for_platform("Cmd+I", is_macos);
        format!("{save} Save · {bold} Bold · {italic} Italic")
    } else {
        format!("{save} Save")
    }
}

fn source_shortcut_hint(kind: CanvasFileKind, read_only: bool) -> String {
    source_shortcut_hint_for_platform(kind, read_only, crate::is_apple_platform())
}

fn handle_source_editor_key(
    s: &mut AppState,
    doc: &ResolvedCanvasDoc,
    ev: &KeyEvent,
    tx: &mut Tx,
) -> bool {
    if ev.is_command('s') {
        trigger_save(s, doc);
        return true;
    }
    if doc.kind == CanvasFileKind::Markdown && !ev.mods.shift && !ev.mods.alt {
        if ev.is_command('b') {
            apply_canvas_format_action(s, doc, MarkdownFormatKind::Bold, Some(tx));
            return true;
        }
        if ev.is_command('i') {
            apply_canvas_format_action(s, doc, MarkdownFormatKind::Italic, Some(tx));
            return true;
        }
    }
    false
}

fn build_prompt_footer(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    doc: &Rc<ResolvedCanvasDoc>,
    synced: bool,
) -> El {
    let thread = s.active_thread();
    let rt = s.active_thread_runtime();
    let ws_rt = thread.and_then(|tr| s.workspace_runtime_by_id.get(&tr.workspace_id));
    let transcript_only = rt.is_some_and(|r| r.transcript_only);
    let disconnected = thread.is_none()
        || ws_rt.is_some_and(|w| !matches!(w.server_state, ServerLifecycleState::Running { .. }));
    let reconnecting = workspace_is_reconnecting(ws_rt);

    let read_only = doc.truncated || transcript_only || thread.is_none();
    let has_prompt = !s.chat_ui.canvas.prompt_edit.text.trim().is_empty();
    let can_send = has_prompt && !read_only;

    let placeholder = if doc.truncated {
        "Truncated files are read-only"
    } else if thread.is_none() {
        "Open a chat thread to ask for edits"
    } else if transcript_only {
        "Read-only transcript"
    } else if disconnected && !reconnecting {
        "Ask model to edit this document (reconnects on send)..."
    } else {
        "Ask model to edit this document..."
    };

    let doc_submit = Rc::clone(doc);
    let doc_send = Rc::clone(doc);

    let mut prompt_field = text_input(&s.chat_ui.canvas.prompt_edit, t.body)
        .key("canvas-prompt-input")
        .label("Ask model to edit this document")
        .w_full()
        .placeholder(placeholder, t.text_faint)
        .caret(t.accent, t.selection_bg)
        .disabled(read_only);

    if !read_only {
        prompt_field = prompt_field
            .on_edit(|state: &mut AppState| &mut state.chat_ui.canvas.prompt_edit)
            .on_input_key(|_state: &mut AppState, ev: &KeyEvent, _| {
                matches!(ev.key, Key::Enter) && (ev.mods.shift || ev.mods.alt)
            })
            .on_submit(move |state: &mut AppState, _| {
                submit_canvas_prompt(state, &doc_submit);
            });
    }

    let send_btn = IconButton::new(&icons::ARROW_UP)
        .variant(if can_send {
            IconButtonVariant::Submit
        } else {
            IconButtonVariant::GhostMuted
        })
        .control_size(ControlSize::Small)
        .label("Send edit request")
        .help("Send collaborative edit request")
        .disabled(!can_send)
        .on_press(move |state: &mut AppState| {
            submit_canvas_prompt(state, &doc_send);
        })
        .build(k)
        .key("canvas-prompt-send")
        .radius(9999.0);

    let mut container = col()
        .key("canvas-prompt-footer")
        .w_full()
        .gap(6.0)
        .px(12.0)
        .py(10.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
        .fill(t.panel_bg);

    if synced && let Some(sel) = active_selection_excerpt(&s.chat_ui.canvas, doc) {
        let sel_len = if sel.is_ascii() {
            sel.len()
        } else {
            sel.chars().count()
        };
        container = container.child(
            row()
                .key("canvas-selection-chip")
                .items_center()
                .gap(6.0)
                .px(8.0)
                .py(3.0)
                .radius(6.0)
                .fill(k.alpha(t.accent, 0.12))
                .border(1.0, k.alpha(t.accent, 0.25))
                .child(icon(&icons::PENCIL, 12.0).color(t.accent))
                .child(
                    text(format!("Selection attached ({sel_len} chars)"))
                        .font(k.ty.small_medium)
                        .color(t.text_base)
                        .grow(1.0)
                        .truncate(),
                )
                .child(
                    IconButton::new(k.glyph.close)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(ControlSize::Mini)
                        .label("Clear selection")
                        .on_press(|state: &mut AppState| {
                            let caret = state.chat_ui.canvas.source_edit.focus;
                            state.chat_ui.canvas.source_edit.set_caret(caret);
                        })
                        .build(k),
                ),
        );
    }

    container.child(
        row()
            .key("canvas-prompt-composer")
            .w_full()
            .items_end()
            .gap(8.0)
            .px(10.0)
            .py(6.0)
            .radius(10.0)
            .fill(t.input_bg)
            .border(
                1.0,
                if s.chat_ui.canvas.prompt_edit.focused && !read_only {
                    t.focus_ring
                } else {
                    t.border
                },
            )
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .child(auto_grow(prompt_field, 1, 4)),
            )
            .child(send_btn),
    )
}

fn build_reload_confirm_dialog(
    s: &AppState,
    k: &Kit,
    doc: &Rc<ResolvedCanvasDoc>,
    dirty: bool,
    overlays: &mut Vec<El>,
) {
    if !s.chat_ui.canvas.reload_confirm_open {
        return;
    }
    let doc_reload = Rc::clone(doc);
    let msg = if dirty {
        "You have unsaved edits in this Canvas document. Reloading from disk will discard your local changes and load the latest file contents."
    } else {
        "Reload the latest document contents from disk?"
    };

    Dialog::new("canvas-reload-confirm-dialog", "Reload from disk?")
        .open(true)
        .width(420.0)
        .fit()
        .click_outside(true)
        .on_close(|state: &mut AppState| {
            state.chat_ui.canvas.reload_confirm_open = false;
        })
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(
                    text(msg)
                        .font(k.ty.ui)
                        .color(k.c.text_muted)
                        .w_full()
                        .min_w(0.0)
                        .wrap(),
                )
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .pt(4.0)
                        .child(spacer())
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::Ghost)
                                .control_size(ControlSize::Regular)
                                .on_press(|state: &mut AppState| {
                                    state.chat_ui.canvas.reload_confirm_open = false;
                                })
                                .build(k)
                                .key("canvas-reload-cancel-btn"),
                        )
                        .child(
                            Button::new("Discard & Reload")
                                .variant(ButtonVariant::Danger)
                                .control_size(ControlSize::Regular)
                                .on_press(move |state: &mut AppState| {
                                    trigger_reload(state, &doc_reload);
                                })
                                .build(k)
                                .key("canvas-reload-confirm-btn"),
                        ),
                ),
        )
        .build(k, overlays);
}

fn build_discard_confirm_dialog(
    s: &AppState,
    k: &Kit,
    doc: &ResolvedCanvasDoc,
    overlays: &mut Vec<El>,
) {
    let Some(ref pending) = s.canvas_discard_confirm else {
        return;
    };
    let is_switch = matches!(
        pending,
        crate::state::PendingCanvasTransition::OpenDocument { .. }
    );
    let action_verb = if is_switch {
        "Discard & Switch"
    } else {
        "Discard & Close"
    };
    let detail = doc
        .error_message
        .as_deref()
        .map(str::trim)
        .filter(|msg| !msg.is_empty());
    let msg = match detail {
        Some(err) => format!(
            "Your edits could not be saved ({err}). Keep editing to resolve this, or discard your unsaved changes."
        ),
        None => "You have unsaved edits in this Canvas document that could not be saved. Keep editing or discard your unsaved changes.".to_string(),
    };
    let can_retry = doc.lifecycle == CanvasLifecycleKind::SaveError;

    let mut actions = row().w_full().gap(8.0).pt(4.0).child(spacer()).child(
        Button::new("Keep editing")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Regular)
            .on_press(|state: &mut AppState| {
                state.dispatch(Action::Chat(ChatAction::CancelCanvasTransition));
            })
            .build(k)
            .key("canvas-discard-cancel-btn"),
    );
    if can_retry {
        actions = actions.child(
            Button::new("Retry save")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .on_press(|state: &mut AppState| {
                    if let Some(transition) = state.canvas_discard_confirm.take() {
                        state.pending_canvas_transition = Some(transition);
                    }
                    state.dispatch(Action::Chat(ChatAction::SaveCanvasDocument));
                })
                .build(k)
                .key("canvas-discard-retry-btn"),
        );
    }
    actions = actions.child(
        Button::new(action_verb)
            .variant(ButtonVariant::Danger)
            .control_size(ControlSize::Regular)
            .on_press(|state: &mut AppState| {
                state.dispatch(Action::Chat(ChatAction::ConfirmDiscardCanvasTransition));
            })
            .build(k)
            .key("canvas-discard-confirm-btn"),
    );

    Dialog::new("canvas-discard-confirm-dialog", "Unsaved Canvas changes")
        .open(true)
        .width(440.0)
        .fit()
        .click_outside(true)
        .on_close(|state: &mut AppState| {
            state.dispatch(Action::Chat(ChatAction::CancelCanvasTransition));
        })
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(
                    text(msg)
                        .font(k.ty.ui)
                        .color(k.c.text_muted)
                        .w_full()
                        .min_w(0.0)
                        .wrap(),
                )
                .child(actions),
        )
        .build(k, overlays);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_canvas_path_matches_editable_docs_and_excludes_spreadsheets_office_and_media() {
        assert_eq!(
            classify_canvas_path("/w/README.md"),
            Some(CanvasFileKind::Markdown)
        );
        assert_eq!(
            classify_canvas_path("C:\\docs\\Guide.MDX"),
            Some(CanvasFileKind::Markdown)
        );
        assert_eq!(
            classify_canvas_path("/w/notes.txt"),
            Some(CanvasFileKind::Text)
        );
        assert_eq!(
            classify_canvas_path("/w/src/lib.rs"),
            Some(CanvasFileKind::Text)
        );
        assert_eq!(
            classify_canvas_path("/w/Dockerfile"),
            Some(CanvasFileKind::Text)
        );
        for p in [
            "/w/setup.bat",
            "/w/build.cmd",
            "/w/index.php",
            "/w/App.vue",
            "/w/Page.svelte",
            "/w/.gitignore",
        ] {
            assert_eq!(
                classify_canvas_path(p),
                Some(CanvasFileKind::Text),
                "expected text Canvas kind for {p}"
            );
        }

        // Spreadsheets belong to views/preview/, office/media stay on FilePreview.
        assert_eq!(classify_canvas_path("/w/data.csv"), None);
        assert_eq!(classify_canvas_path("/w/budget.xlsx"), None);
        assert_eq!(classify_canvas_path("/w/slides.pptx"), None);
        assert_eq!(classify_canvas_path("/w/spec.docx"), None);
        assert_eq!(classify_canvas_path("/w/report.pdf"), None);
        assert_eq!(classify_canvas_path("/w/diagram.png"), None);
        assert_eq!(classify_canvas_path("/w/archive.zip"), None);
        assert!(is_canvas_document_path("/w/README.md"));
        assert!(is_canvas_document_path("/w/.gitignore"));
        assert!(!is_canvas_document_path("/w/data.csv"));
        assert!(!is_canvas_document_path("/w/budget.xlsx"));
    }

    #[test]
    fn markdown_format_bold_and_italic_wrap_toggle_and_caret() {
        let r = apply_markdown_format("hello world", 6, 11, MarkdownFormatKind::Bold);
        assert_eq!(r.next, "hello **world**");
        assert_eq!((r.selection_start, r.selection_end), (8, 13));

        let toggled = apply_markdown_format("hello **world**", 6, 15, MarkdownFormatKind::Bold);
        assert_eq!(toggled.next, "hello world");
        assert_eq!((toggled.selection_start, toggled.selection_end), (6, 11));

        let empty = apply_markdown_format("abc", 1, 1, MarkdownFormatKind::Italic);
        assert_eq!(empty.next, "a**bc");
        assert_eq!((empty.selection_start, empty.selection_end), (2, 2));
    }

    #[test]
    fn markdown_format_lists_and_headings_preserve_newline_boundaries() {
        let ul = apply_markdown_format("one\ntwo", 0, 7, MarkdownFormatKind::BulletList);
        assert_eq!(ul.next, "- one\n- two");
        assert_eq!((ul.selection_start, ul.selection_end), (0, 11));

        // Selection ending immediately after `\n` must not prefix the following line.
        let nl = apply_markdown_format("one\ntwo\nthree", 0, 8, MarkdownFormatKind::BulletList);
        assert_eq!(nl.next, "- one\n- two\nthree");
        assert_eq!(nl.selection_end, 11);

        // Trailing document newline must not invent an empty item.
        let ol = apply_markdown_format("one\ntwo\n", 0, 8, MarkdownFormatKind::NumberedList);
        assert_eq!(ol.next, "1. one\n2. two\n");

        let h2 = apply_markdown_format("Title", 0, 5, MarkdownFormatKind::H2);
        assert_eq!(h2.next, "## Title");

        let normal = apply_markdown_format("### Header", 0, 10, MarkdownFormatKind::Normal);
        assert_eq!(normal.next, "Header");
    }

    #[test]
    fn markdown_format_handles_multibyte_utf8_safely() {
        let res = apply_markdown_format("café crème", 6, 12, MarkdownFormatKind::Bold);
        assert_eq!(res.next, "café **crème**");
    }

    #[test]
    fn text_edit_format_supports_undo_and_selection_restore() {
        let mut edit = TextEdit::new("hello world");
        edit.set_selection(6, 11);
        apply_format_to_text_edit(&mut edit, MarkdownFormatKind::Bold);
        assert_eq!(edit.text, "hello **world**");
        assert_eq!(edit.range(), (8, 13));
    }

    #[test]
    fn build_canvas_document_prompt_escapes_xml_and_roundtrips_through_visible_parser() {
        let prompt = build_canvas_document_prompt(
            "/w/spec & plan.md",
            "spec & plan.md",
            CanvasFileKind::Markdown,
            Some("Old <draft> intro"),
            "Tighten \"section\" & add KPIs",
        );
        assert!(prompt.contains(r#"<canvas_request version="1" source="document">"#));
        assert!(prompt.contains(r#"<file name="spec &amp; plan.md""#));

        let visible = crate::views::chat::model::build_visible_user_message(&prompt);
        assert_eq!(visible.canvas_title.as_deref(), Some("spec & plan.md"));
        assert_eq!(
            visible.text,
            "\u{201C}Old <draft> intro\u{201D}\n\nTighten \"section\" & add KPIs"
        );
    }

    #[test]
    fn canvas_shortcut_hint_adapts_by_platform_and_kind() {
        assert_eq!(
            source_shortcut_hint_for_platform(CanvasFileKind::Markdown, false, true),
            "⌘S Save · ⌘B Bold · ⌘I Italic"
        );
        assert_eq!(
            source_shortcut_hint_for_platform(CanvasFileKind::Markdown, false, false),
            "Ctrl+S Save · Ctrl+B Bold · Ctrl+I Italic"
        );
        assert_eq!(
            source_shortcut_hint_for_platform(CanvasFileKind::Text, false, false),
            "Ctrl+S Save"
        );
        assert_eq!(
            source_shortcut_hint_for_platform(CanvasFileKind::Markdown, true, false),
            "Read-only preview"
        );
    }

    #[test]
    fn canvas_sync_preserves_undo_during_save_and_syncs_external_clean_updates() {
        let make_doc = |disk: &str, draft: &str| ResolvedCanvasDoc {
            doc_identity: "session\x00ws\x00doc-1".to_string(),
            session_key: "session\x00ws\x00doc-1\x001\x002".to_string(),
            workspace_id: "ws".to_string(),
            path: "/ws/doc.md".to_string(),
            title: "doc.md".to_string(),
            disk_hash: hash_text(disk),
            draft_hash: hash_text(draft),
            disk_content: Rc::from(disk),
            draft_content: Rc::from(draft),
            kind: CanvasFileKind::Markdown,
            truncated: false,
            lifecycle: CanvasLifecycleKind::Ready,
            error_message: None,
            live_session: Some(LiveSessionMeta {
                document_id: "doc-1".to_string(),
                generation: 1,
                dirty: disk != draft,
            }),
        };

        let mut ui = CanvasUiState::default();
        let initial = make_doc("v1", "v1");
        ensure_canvas_synced(&mut ui, &initial, false);
        ui.source_edit.set_selection(0, 2);

        // Undo-during-save: user edited v1 -> v12, saved v12, then undid back to v1 while save
        // was in-flight; save completes with disk="v12", draft="v1".
        let after_undo_save = make_doc("v12", "v1");
        assert!(canvas_view_synced(&ui, &after_undo_save));
        assert_eq!(active_selection_excerpt(&ui, &after_undo_save), Some("v1"));
        ensure_canvas_synced(&mut ui, &after_undo_save, false);
        assert_eq!(ui.synced_disk_content, "v12");
        assert_eq!(ui.source_edit.text, "v1");
        assert!(ui.is_dirty());

        // External disk+draft update while UI is clean hides stale selection and syncs source_edit.
        let mut clean_ui = CanvasUiState::default();
        ensure_canvas_synced(&mut clean_ui, &initial, false);
        clean_ui.source_edit.set_selection(0, 2);
        let external_v2 = make_doc("v2", "v2");
        assert!(!canvas_view_synced(&clean_ui, &external_v2));
        assert_eq!(active_selection_excerpt(&clean_ui, &external_v2), None);
        ensure_canvas_synced(&mut clean_ui, &external_v2, false);
        assert_eq!(clean_ui.source_edit.text, "v2");
        assert_eq!(clean_ui.synced_disk_content, "v2");
        assert!(!clean_ui.is_dirty());
        assert!(canvas_view_synced(&clean_ui, &external_v2));
    }
}
