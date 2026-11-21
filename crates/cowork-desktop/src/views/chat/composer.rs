//! Shared composer card, model/reasoning pickers, attachments, drag/drop/paste, and `@`/`/` menus.

use cowork_protocol::{CommandInfo, TurnReference};
use rune::{
    Align, Color, Cursor, El, Key, Side, TextEdit, auto_grow, col, icon, row, text, text_input,
};
use rune_kit::{
    Button, ButtonVariant, Combobox, ComboboxOption, ControlSize, IconButton, IconButtonVariant,
    Kit, Placement, PopupItem, PopupList, Select, SelectAppearance,
};

use crate::actions::{Action, ChatAction, NativeAction};
use crate::state::{
    AppState, ComposerDraft, ComposerSubmissionStatus, ProviderModelSummary, ProviderSummary,
    ReasoningEffortValue, ThreadBusyPolicy, ThreadRecord, ThreadRuntime, WorkspaceRecord,
};
use crate::theme::ThemeTokens;
use crate::ws::WsConnectionState;

use super::attachments::file_attachment_card;
use super::icons;
use super::model::{
    AttachmentDisplayInfo, MentionCatalog, MentionItem, MentionKind, attachment_display_info,
    build_mention_catalog, detect_active_mention_query, extract_references_from_text,
    filter_mention_items, is_active_child_agent,
};
use super::{components, state::ChatUiState};

const COMPOSER_MAX_WIDTH: f32 = 896.0;
const MENTION_POPUP_WIDTH: f32 = 384.0;
const COMPOSER_HEIGHT_DEFAULT: f32 = 160.0;
const COMPOSER_HEIGHT_MIN: f32 = 88.0;
const COMPOSER_HEIGHT_MAX: f32 = 360.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedComposerModel {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub model_label: String,
    pub supports_reasoning: bool,
    pub reasoning_efforts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SlashQuery<'a> {
    query: &'a str,
}

enum ActiveSuggestion<'a> {
    Mention {
        start: usize,
        query: String,
        items: Vec<&'a MentionItem>,
    },
    Slash {
        commands: Vec<&'a CommandInfo>,
    },
}

enum OwnedSuggestionPick {
    Mention { start: usize, name: String },
    Slash { name: String },
}

/// Renders the shared message composer used by both `ChatView` and `NewChatLanding`.
pub fn build_composer(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
    is_landing: bool,
) -> El {
    let key = s.composer_key();
    let thread = s.active_thread();
    let runtime = s.active_thread_runtime();
    let ws = resolve_composer_workspace(s, thread, is_landing);
    let ws_id = ws.map(|w| w.id.as_str());

    let draft = s.composer_drafts.get(&key);
    let catalog = build_mention_catalog(&s.skills, &s.plugins);
    let slash_commands = ws_id
        .and_then(|id| s.commands_by_workspace.get(id))
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let sock = ws_id.and_then(|id| s.workspace_socket_by_id.get(id));
    let ws_reconnecting = ws_id
        .and_then(|id| s.workspace_runtime_by_id.get(id))
        .is_some_and(|rt| rt.reconnecting)
        || matches!(sock, Some(WsConnectionState::Reconnecting { .. }));
    let disconnected = ws_id.is_some()
        && !matches!(
            sock,
            Some(
                WsConnectionState::Connected
                    | WsConnectionState::Connecting
                    | WsConnectionState::Handshaking
            )
        );

    let streaming = runtime.is_some_and(|rt| rt.streaming);
    let attachment_ingesting = runtime.is_some_and(|rt| rt.attachment_ingesting);
    let usage_hard_cap = runtime.is_some_and(|rt| rt.usage_hard_cap_reached);
    let input_disabled = !is_landing
        && runtime.is_some_and(|rt| rt.read_only_notice.is_some() || rt.source_task.is_some());
    let hydrating = runtime.is_some_and(|rt| rt.hydrating);
    let transcript_only = runtime.is_some_and(|rt| rt.transcript_only);
    let file_drop_disabled = input_disabled || (!is_landing && transcript_only);
    let thread_disconnected = disconnected
        || (!hydrating
            && !transcript_only
            && thread.is_some_and(|tr| tr.status != crate::state::ThreadStatus::Active));
    let session_missing = thread.is_some_and(|tr| tr.session_id.is_none());
    let is_draft = thread.is_some_and(|tr| tr.draft);
    // Note: `ThreadRuntime` does not carry `session_kind` yet; opening `AgentRunViewer`
    // inspects a child run without locking the main thread's selectors.
    let non_draft_locked = thread.is_some_and(|tr| !tr.draft)
        && (streaming || hydrating || transcript_only || thread_disconnected || session_missing);
    let stream_submit_blocked =
        !is_landing && streaming && !is_draft && (thread_disconnected || session_missing);
    let can_submit = !input_disabled
        && !stream_submit_blocked
        && !runtime.is_some_and(ThreadRuntime::sending_composer_message)
        && composer_can_submit(
            &s.composer_edit.text,
            draft,
            attachment_ingesting,
            usage_hard_cap,
        );

    let status_disconnected = !is_landing && !hydrating && !transcript_only && thread_disconnected;
    let input_area = build_composer_input_area(
        s,
        k,
        t,
        &catalog,
        is_landing,
        input_disabled,
        transcript_only,
        status_disconnected,
        ws_reconnecting,
    );
    let attachments_strip = build_draft_attachments_row(s, k, t, &key, draft, input_disabled);
    let footer = build_composer_footer(
        s,
        k,
        t,
        overlays,
        FooterCtx {
            key: &key,
            thread,
            runtime,
            ws,
            draft,
            is_landing,
            streaming,
            input_disabled,
            non_draft_locked,
            can_submit,
            usage_hard_cap,
            disconnected: status_disconnected,
            ws_reconnecting,
        },
    );

    if !input_disabled {
        build_suggestion_popup(s, k, &catalog, slash_commands, is_landing, overlays);
    }

    let radius = if is_landing { 22.0 } else { 16.0 };
    let border_color = if s.chat_ui.composer_drop_hover && !file_drop_disabled {
        t.accent
    } else if s.composer_edit.focused && !input_disabled {
        t.border_strong
    } else {
        t.border
    };

    let mut card = col()
        .key("chat-composer-card")
        .w_full()
        .radius(radius)
        .fill(t.input_bg)
        .border(1.0, border_color);
    if !file_drop_disabled {
        card = card
            .on_drop_hover(|s: &mut AppState, over, _| {
                s.chat_ui.composer_drop_hover = over;
            })
            .on_drop_files(|s: &mut AppState, files, _| {
                s.chat_ui.composer_drop_hover = false;
                let key = s.composer_key();
                if !files.is_empty() {
                    s.dispatch(Action::Native(NativeAction::IngestDroppedFiles {
                        key,
                        paths: files.to_vec(),
                    }));
                }
            });
    }

    if !is_landing && s.desktop_settings.developer_mode {
        card = card.child(build_dev_resizer_bar(s, k, t));
    }
    if let Some(strip) = attachments_strip {
        card = card.child(strip);
    }
    card = card.child(input_area).child(footer);

    let mut stack = col().w_full().gap(6.0);
    if !is_landing && let Some(banner) = build_submission_feedback(k, t, thread, runtime) {
        stack = stack.child(banner);
    }
    stack = stack.child(card);
    if !is_landing
        && let Some(hint) =
            build_composer_status_hint(k, t, runtime, status_disconnected, ws_reconnecting)
    {
        stack = stack.child(hint);
    }

    if is_landing {
        return stack;
    }

    col()
        .key("chat-composer-dock")
        .w_full()
        .items_center()
        .px(16.0)
        .pt(10.0)
        .pb(16.0)
        .fill(t.panel_bg)
        .child(col().w_full().max_w(COMPOSER_MAX_WIDTH).child(stack))
}

#[allow(clippy::too_many_arguments)]
fn build_composer_input_area(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    catalog: &MentionCatalog,
    is_landing: bool,
    input_disabled: bool,
    transcript_only: bool,
    disconnected: bool,
    ws_reconnecting: bool,
) -> El {
    let decorations =
        super::components::composer_mention_spans(&s.composer_edit.text, catalog, k, t);
    let placeholder = if input_disabled {
        "Read-only conversation"
    } else if !is_landing && transcript_only {
        "Continue in a new thread..."
    } else if disconnected {
        if ws_reconnecting {
            "Reconnecting automatically... Keep writing."
        } else {
            "Write a message to reconnect..."
        }
    } else if is_landing {
        "Ask anything, @ to mention a skill or plugin, / for commands..."
    } else {
        "Reply... (@ for skills, / for commands)"
    };

    let mut field = text_input(&s.composer_edit, t.body_lg)
        .key("composer-input")
        .label("Message")
        .w_full()
        .placeholder(placeholder, t.text_faint)
        .caret(t.accent, t.selection_bg)
        .decorations(decorations)
        .disabled(input_disabled);
    if !input_disabled {
        field = field
            .on_edit(|s: &mut AppState| &mut s.composer_edit)
            .on_input_change(|s: &mut AppState, _| {
                let key = s.composer_key();
                let text = s.composer_edit.text.clone();
                s.composer_drafts.entry(key).or_default().text = text;
                let current_q =
                    detect_active_mention_query(&s.composer_edit.text, s.composer_edit.focus)
                        .map(|q| q.query);
                if s.chat_ui.mention_dismissed_query.as_ref() != current_q.as_ref() {
                    s.chat_ui.mention_dismissed_query = None;
                    s.chat_ui.mention_active_index = 0;
                }
            })
            .on_input_paste(|s: &mut AppState, content, _| {
                let key = s.composer_key();
                if content.text().is_empty()
                    && let Some(img) = content.image()
                {
                    s.dispatch(Action::Native(NativeAction::PasteClipboardImage {
                        key,
                        bytes: img.png().to_vec(),
                        mime_type: "image/png".to_string(),
                        filename: Some("pasted-image.png".to_string()),
                    }));
                    return true;
                }
                if content.text().is_empty() && !content.files().is_empty() {
                    s.dispatch(Action::Native(NativeAction::IngestDroppedFiles {
                        key,
                        paths: content.files().to_vec(),
                    }));
                    return true;
                }
                false
            })
            .on_input_key(|s: &mut AppState, ev, _| handle_composer_key(s, ev))
            .on_submit(|s: &mut AppState, _| {
                submit_composer_message(s);
            });
    }

    let box_wrapper = if let Some(h) = s.chat_ui.composer_height_override.filter(|_| !is_landing) {
        col()
            .w_full()
            .h(h.clamp(COMPOSER_HEIGHT_MIN, COMPOSER_HEIGHT_MAX))
            .scroll(rune::ScrollSpec {
                stick_bottom: false,
            })
            .child(field)
    } else if is_landing {
        auto_grow(field, 3, 9)
    } else {
        auto_grow(field, 1, 8)
    };

    col()
        .w_full()
        .px(16.0)
        .pt(if is_landing { 14.0 } else { 12.0 })
        .pb(4.0)
        .child(box_wrapper)
}

fn pick_from_active(active: &ActiveSuggestion<'_>, idx: usize) -> Option<OwnedSuggestionPick> {
    match active {
        ActiveSuggestion::Mention { start, items, .. } => items
            .get(idx.min(items.len().saturating_sub(1)))
            .map(|item| OwnedSuggestionPick::Mention {
                start: *start,
                name: item.name.clone(),
            }),
        ActiveSuggestion::Slash { commands } => commands
            .get(idx.min(commands.len().saturating_sub(1)))
            .map(|cmd| OwnedSuggestionPick::Slash {
                name: cmd.name.clone(),
            }),
    }
}

fn active_suggestion_meta(
    s: &AppState,
    idx: usize,
) -> Option<(usize, String, OwnedSuggestionPick)> {
    let catalog = build_mention_catalog(&s.skills, &s.plugins);
    let thread = s.active_thread();
    let ws_id = resolve_composer_workspace(s, thread, thread.is_none()).map(|w| w.id.as_str());
    let commands = ws_id
        .and_then(|id| s.commands_by_workspace.get(id))
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let active = detect_active_suggestions(&s.composer_edit, &s.chat_ui, &catalog, commands)?;
    let count = match &active {
        ActiveSuggestion::Mention { items, .. } => items.len(),
        ActiveSuggestion::Slash { commands } => commands.len(),
    };
    if count == 0 {
        return None;
    }
    let dismiss_key = match &active {
        ActiveSuggestion::Mention { query, .. } => query.clone(),
        ActiveSuggestion::Slash { .. } => "/".to_string(),
    };
    let pick = pick_from_active(&active, idx)?;
    Some((count, dismiss_key, pick))
}

fn handle_composer_key(s: &mut AppState, ev: &rune::KeyEvent) -> bool {
    // Plain typing never interacts with the suggestion popup; skip rebuilding the mention catalog
    // on every keystroke.
    let navigates = match &ev.key {
        Key::Down | Key::Up | Key::Escape | Key::Tab => true,
        Key::Enter => !ev.mods.shift && !ev.mods.alt,
        _ => false,
    };
    if !navigates {
        return false;
    }
    let Some((count, dismiss_key, pick)) =
        active_suggestion_meta(s, s.chat_ui.mention_active_index)
    else {
        return false;
    };

    match &ev.key {
        Key::Down => {
            s.chat_ui.mention_active_index = (s.chat_ui.mention_active_index + 1) % count;
            true
        }
        Key::Up => {
            s.chat_ui.mention_active_index = if s.chat_ui.mention_active_index == 0 {
                count - 1
            } else {
                s.chat_ui.mention_active_index - 1
            };
            true
        }
        Key::Escape => {
            s.chat_ui.mention_dismissed_query = Some(dismiss_key);
            true
        }
        Key::Tab => {
            apply_suggestion_pick(s, pick);
            true
        }
        Key::Enter if !ev.mods.shift && !ev.mods.alt => {
            apply_suggestion_pick(s, pick);
            true
        }
        _ => false,
    }
}

fn apply_suggestion_pick(s: &mut AppState, pick: OwnedSuggestionPick) {
    match pick {
        OwnedSuggestionPick::Mention { start, name } => {
            let end = s.composer_edit.focus.min(s.composer_edit.text.len());
            s.composer_edit.anchor = start.min(end);
            s.composer_edit.focus = end;
            s.composer_edit.insert(&format!("@{name} "));
            sync_edit_back_to_draft(s);
        }
        OwnedSuggestionPick::Slash { name } => {
            let replacement = format!("/{name} ");
            s.composer_edit = TextEdit::new(&replacement);
            s.composer_edit.focused = true;
            sync_edit_back_to_draft(s);
        }
    }
    s.chat_ui.mention_active_index = 0;
    s.chat_ui.mention_dismissed_query = None;
}

fn sync_edit_back_to_draft(s: &mut AppState) {
    let key = s.composer_key();
    s.composer_drafts.entry(key).or_default().text = s.composer_edit.text.clone();
}

fn build_suggestion_popup(
    s: &AppState,
    k: &Kit,
    catalog: &MentionCatalog,
    commands: &[CommandInfo],
    is_landing: bool,
    overlays: &mut Vec<El>,
) {
    let Some(active) = detect_active_suggestions(&s.composer_edit, &s.chat_ui, catalog, commands)
    else {
        return;
    };

    let (side, align) = if is_landing {
        (Side::Bottom, Align::Start)
    } else {
        (Side::Top, Align::Start)
    };

    let items: Vec<PopupItem> = match &active {
        ActiveSuggestion::Mention { items, .. } => items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let glyph = match item.kind {
                    MentionKind::Skill => &icons::SPARKLES,
                    MentionKind::Plugin => &icons::WRENCH,
                };
                PopupItem::new(format!("mention:{i}"), format!("@{}", item.name))
                    .description(item.description.clone())
                    .leading(icon(glyph, 14.0).color(k.c.text_accent))
                    .trailing(
                        text(item.badge.clone())
                            .font(k.ty.small)
                            .color(k.c.text_muted),
                    )
            })
            .collect(),
        ActiveSuggestion::Slash { commands } => commands
            .iter()
            .enumerate()
            .map(|(i, cmd)| {
                PopupItem::new(format!("slash:{i}"), format!("/{}", cmd.name))
                    .description(cmd.description.clone().unwrap_or_default())
                    .leading(icon(&icons::TERMINAL, 14.0).color(k.c.text_accent))
                    .trailing(
                        text(cmd.source.clone())
                            .font(k.ty.small)
                            .color(k.c.text_muted),
                    )
            })
            .collect(),
    };

    if items.is_empty() {
        return;
    }

    let active_idx = s.chat_ui.mention_active_index.min(items.len() - 1);
    let dismissed_val = match &active {
        ActiveSuggestion::Mention { query, .. } => query.clone(),
        ActiveSuggestion::Slash { .. } => "/".to_string(),
    };

    PopupList::new("composer-mention-menu", "composer-input")
        .anchored("composer-input", side, align, 6.0)
        .width(MENTION_POPUP_WIDTH)
        .max_height(224.0)
        .open(true)
        .items(items)
        .active(Some(active_idx))
        .on_active(|s: &mut AppState, idx| {
            s.chat_ui.mention_active_index = idx;
        })
        .on_close(move |s: &mut AppState| {
            s.chat_ui.mention_dismissed_query = Some(dismissed_val.clone());
        })
        .on_choose(|s: &mut AppState, id, _| {
            if let Some((_, raw_idx)) = id.split_once(':')
                && let Ok(idx) = raw_idx.parse::<usize>()
                && let Some((_, _, pick)) = active_suggestion_meta(s, idx)
            {
                apply_suggestion_pick(s, pick);
            }
        })
        .build(k, overlays);
}

fn build_draft_attachments_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    key: &str,
    draft: Option<&ComposerDraft>,
    input_disabled: bool,
) -> Option<El> {
    let draft = draft?;
    if draft.attachments.is_empty() {
        return None;
    }
    let previews = s.attachment_previews_by_key.get(key);
    let mut strip = row().w_full().flex_wrap().gap(8.0).px(14.0).pt(12.0);
    for (idx, part) in draft.attachments.iter().enumerate() {
        let mut info: AttachmentDisplayInfo = attachment_display_info(part);
        if info.decoded_image_bytes.is_none()
            && let Some(meta) = previews.and_then(|list| list.get(idx))
            && let Some(ref data_url) = meta.data_url
            && let Some((_, b64)) = data_url.split_once("base64,")
            && let Ok(bytes) =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64.trim())
        {
            info.decoded_image_bytes = Some(bytes);
        }
        let remove_key = key.to_string();
        let remove_btn = IconButton::new(k.glyph.close)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Mini)
            .label("Remove attachment")
            .disabled(input_disabled)
            .on_press(move |s: &mut AppState| {
                s.dispatch(Action::Chat(ChatAction::RemoveComposerAttachment {
                    key: remove_key.clone(),
                    index: idx,
                }));
            })
            .build(k);
        strip = strip.child(file_attachment_card(
            k,
            t,
            &info,
            format!("draft-att:{key}:{idx}"),
            Some(remove_btn),
            None,
        ));
    }
    Some(strip)
}

struct FooterCtx<'a> {
    key: &'a str,
    thread: Option<&'a ThreadRecord>,
    runtime: Option<&'a ThreadRuntime>,
    ws: Option<&'a WorkspaceRecord>,
    draft: Option<&'a ComposerDraft>,
    is_landing: bool,
    streaming: bool,
    input_disabled: bool,
    non_draft_locked: bool,
    can_submit: bool,
    usage_hard_cap: bool,
    disconnected: bool,
    ws_reconnecting: bool,
}

fn build_composer_footer(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
    ctx: FooterCtx<'_>,
) -> El {
    let key_attach = ctx.key.to_string();
    let attach_btn = IconButton::new(&icons::PAPERCLIP)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label("Attach files")
        .help("Attach image or file")
        .disabled(ctx.input_disabled)
        .on_press(move |s: &mut AppState| {
            s.dispatch(Action::Native(NativeAction::PickComposerAttachments {
                key: key_attach.clone(),
            }));
        })
        .build(k);

    let resolved_model = resolve_composer_model(s, ctx.thread, ctx.draft, ctx.ws);
    let model_picker = build_model_selector(s, k, t, overlays, &ctx, resolved_model.as_ref());
    let reasoning_picker = build_reasoning_selector(s, k, overlays, &ctx, resolved_model.as_ref());

    let mut left_controls = row()
        .items_center()
        .gap(6.0)
        .child(attach_btn)
        .child(model_picker);
    if let Some(rp) = reasoning_picker {
        left_controls = left_controls.child(rp);
    }

    let right_controls = build_right_submit_controls(k, t, &ctx);

    row()
        .w_full()
        .items_center()
        .justify_between()
        .gap(8.0)
        .px(12.0)
        .pt(6.0)
        .pb(if ctx.is_landing { 12.0 } else { 10.0 })
        .child(left_controls)
        .child(right_controls)
}

fn build_model_selector(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
    ctx: &FooterCtx<'_>,
    resolved: Option<&ResolvedComposerModel>,
) -> El {
    let options = build_model_options(&s.provider_catalog);
    let current_id = resolved.map(|r| encode_model_option_id(&r.provider_id, &r.model_id));
    let label_text = resolved
        .map(|r| r.model_label.clone())
        .unwrap_or_else(|| "Select model".to_string());

    let model_disabled = ctx.input_disabled || ctx.non_draft_locked;
    let mut trigger = row()
        .key("composer-model-picker-button")
        .role("combobox")
        .label("Model")
        .disabled(model_disabled)
        .focusable(!model_disabled)
        .items_center()
        .gap(5.0)
        .px(8.0)
        .py(4.0)
        .radius(8.0)
        .fill(Color::TRANSPARENT)
        .help("Choose model")
        .child(
            text(label_text)
                .font(k.ty.small_medium)
                .color(if model_disabled || resolved.is_none() {
                    t.text_muted
                } else {
                    t.text_base
                })
                .max_w(180.0)
                .truncate(),
        )
        .child(icon(k.glyph.chevron_down, 12.0).color(t.text_muted));
    if model_disabled {
        trigger = trigger.layer_opacity(0.55);
    } else {
        trigger = trigger.hover(t.hover).cursor(Cursor::Pointer);
    }

    let placement = if ctx.is_landing {
        Placement::BottomStart
    } else {
        Placement::TopStart
    };
    let key_choose = ctx.key.to_string();
    let tid_choose = ctx.thread.filter(|tr| !tr.draft).map(|tr| tr.id.clone());

    Combobox::new(
        "composer-model-picker",
        &s.chat_ui.model_combobox,
        &options,
        |s: &mut AppState| &mut s.chat_ui.model_combobox,
    )
    .label("Model")
    .current(current_id.as_deref())
    .search_placeholder("Search models...")
    .empty_message("No configured models")
    .width(300.0)
    .max_height(260.0)
    .placement(placement)
    .trigger(trigger)
    .disabled(model_disabled)
    .on_choose(move |s: &mut AppState, option_id, _| {
        if let Some((provider, model)) = decode_model_option_id(option_id) {
            s.dispatch(Action::Chat(ChatAction::SetComposerDraftModel {
                key: key_choose.clone(),
                provider: provider.clone(),
                model: model.clone(),
            }));
            if let Some(ref tid) = tid_choose {
                s.dispatch(Action::Chat(ChatAction::SetThreadModel {
                    thread_id: tid.clone(),
                    provider,
                    model,
                }));
            }
        }
    })
    .build(k, overlays)
}

fn build_reasoning_selector(
    s: &AppState,
    k: &Kit,
    overlays: &mut Vec<El>,
    ctx: &FooterCtx<'_>,
    resolved: Option<&ResolvedComposerModel>,
) -> Option<El> {
    let model = resolved?;
    if !model.supports_reasoning && model.reasoning_efforts.is_empty() {
        return None;
    }

    let raw_efforts: Vec<&str> = if model.reasoning_efforts.is_empty() {
        vec!["low", "medium", "high"]
    } else {
        model.reasoning_efforts.iter().map(String::as_str).collect()
    };

    let labels: Vec<String> = raw_efforts.iter().map(|e| format_effort_label(e)).collect();
    let current_effort = resolve_current_effort(ctx.draft, ctx.thread, ctx.ws, &raw_efforts);
    let current_label = format_effort_label(current_effort.as_str());

    let key_choose = ctx.key.to_string();
    let tid_choose = ctx.thread.filter(|tr| !tr.draft).map(|tr| tr.id.clone());
    let provider_choose = model.provider_id.clone();

    let placement = if ctx.is_landing {
        Placement::BottomStart
    } else {
        Placement::TopStart
    };

    let reasoning_disabled = ctx.input_disabled || ctx.streaming || ctx.non_draft_locked;
    Some(
        Select::new("composer-reasoning-select", &labels)
            .appearance(SelectAppearance::Inline)
            .placement(placement)
            .width(124.0)
            .label("Reasoning effort")
            .current(Some(&current_label))
            .open(s.chat_ui.reasoning_open && !reasoning_disabled)
            .disabled(reasoning_disabled)
            .on_toggle(|s: &mut AppState| {
                s.chat_ui.reasoning_open = !s.chat_ui.reasoning_open;
            })
            .on_close(|s: &mut AppState| {
                s.chat_ui.reasoning_open = false;
            })
            .on_choose(move |s: &mut AppState, label, _| {
                s.chat_ui.reasoning_open = false;
                if let Some(effort) = parse_reasoning_effort_label(label) {
                    s.dispatch(Action::Chat(ChatAction::SetComposerDraftEffort {
                        key: key_choose.clone(),
                        effort: Some(effort),
                    }));
                    if let Some(ref tid) = tid_choose {
                        s.dispatch(Action::Chat(ChatAction::SetThreadReasoningEffort {
                            thread_id: tid.clone(),
                            provider: provider_choose.clone(),
                            effort,
                        }));
                    }
                }
            })
            .build(k, overlays),
    )
}

fn build_right_submit_controls(k: &Kit, t: &ThemeTokens, ctx: &FooterCtx<'_>) -> El {
    let mut row_btns = row().items_center().gap(6.0);

    if ctx.disconnected
        && !ctx.ws_reconnecting
        && let Some(ws) = ctx.ws
    {
        let ws_id = ws.id.clone();
        row_btns = row_btns.child(
            Button::new("Reconnect")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                        ws_id.clone(),
                    )));
                })
                .build(k),
        );
    }

    if ctx.streaming
        && let Some(thread) = ctx.thread
    {
        let stop_tid = thread.id.clone();
        let has_active_subagents = ctx
            .runtime
            .is_some_and(|rt| rt.agents.iter().any(is_active_child_agent));
        let stop_btn = Button::new("Stop")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Small)
            .icon(&icons::STOP_SQUARE)
            .help("Stop generating")
            .on_press(move |s: &mut AppState| {
                if has_active_subagents {
                    s.chat_ui.cancel_subagents_thread_id = Some(stop_tid.clone());
                    s.chat_ui.cancel_subagents_open = true;
                } else {
                    s.dispatch(Action::Chat(ChatAction::CancelTurn {
                        thread_id: stop_tid.clone(),
                        include_subagents: false,
                    }));
                }
            })
            .build(k)
            .key("composer-stop-btn")
            .radius(9999.0);
        row_btns = row_btns.child(stop_btn);
    }

    if !ctx.streaming || ctx.can_submit {
        let send_help = if ctx.usage_hard_cap {
            "Usage cap reached"
        } else if ctx.streaming {
            "Send follow-up steer"
        } else {
            "Send message"
        };
        let send_variant = if ctx.can_submit {
            IconButtonVariant::Submit
        } else {
            IconButtonVariant::GhostMuted
        };
        let mut send_btn = IconButton::new(&icons::ARROW_UP)
            .variant(send_variant)
            .control_size(ControlSize::Regular)
            .label(send_help)
            .help(send_help)
            .disabled(!ctx.can_submit);
        if ctx.can_submit {
            send_btn = send_btn.on_press(|s: &mut AppState| {
                submit_composer_message(s);
            });
        }
        let mut built = send_btn.build(k).radius(9999.0);
        if !ctx.can_submit {
            built = built.fill(k.alpha(t.text_muted, 0.14));
        }
        row_btns = row_btns.child(if ctx.can_submit && ctx.streaming {
            row()
                .items_center()
                .gap(4.0)
                .child(text("Steer").font(k.ty.small_medium).color(t.text_muted))
                .child(built)
        } else {
            built
        });
    }

    row_btns
}

fn build_dev_resizer_bar(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let custom = s.chat_ui.composer_height_override;
    row()
        .w_full()
        .items_center()
        .justify_between()
        .px(12.0)
        .py(3.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .child(
            text(match custom {
                Some(h) => format!("Composer height: {}pt", h as i32),
                None => "Composer: auto".to_string(),
            })
            .font(k.ty.small)
            .color(t.text_faint),
        )
        .child(
            row()
                .items_center()
                .gap(4.0)
                .child(
                    Button::new("−")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Mini)
                        .on_press(|s: &mut AppState| {
                            let cur = s
                                .chat_ui
                                .composer_height_override
                                .unwrap_or(COMPOSER_HEIGHT_DEFAULT);
                            s.chat_ui.composer_height_override =
                                Some((cur - 40.0).clamp(COMPOSER_HEIGHT_MIN, COMPOSER_HEIGHT_MAX));
                        })
                        .build(k),
                )
                .child(
                    Button::new("+")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Mini)
                        .on_press(|s: &mut AppState| {
                            let cur = s
                                .chat_ui
                                .composer_height_override
                                .unwrap_or(COMPOSER_HEIGHT_DEFAULT);
                            s.chat_ui.composer_height_override =
                                Some((cur + 40.0).clamp(COMPOSER_HEIGHT_MIN, COMPOSER_HEIGHT_MAX));
                        })
                        .build(k),
                )
                .child(
                    Button::new("Auto")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Mini)
                        .on_press(|s: &mut AppState| {
                            s.chat_ui.composer_height_override = None;
                        })
                        .build(k),
                ),
        )
}

fn build_submission_feedback(
    k: &Kit,
    t: &ThemeTokens,
    thread: Option<&ThreadRecord>,
    runtime: Option<&ThreadRuntime>,
) -> Option<El> {
    let tid = thread?.id.clone();
    let rt = runtime?;

    if rt.usage_hard_cap_reached {
        let cap_tid = tid.clone();
        return Some(
            row()
                .w_full()
                .items_center()
                .gap(10.0)
                .px(12.0)
                .py(8.0)
                .radius(10.0)
                .fill(k.alpha(t.warning, 0.12))
                .border(1.0, k.alpha(t.warning, 0.35))
                .child(icon(&icons::ALERT, 15.0).color(t.warning))
                .child(
                    text("Thread spend cap reached.")
                        .font(k.ty.small_medium)
                        .color(t.text_base)
                        .grow(1.0),
                )
                .child(
                    Button::new("Continue")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.dispatch(Action::Chat(ChatAction::ClearThreadUsageHardCap(
                                cap_tid.clone(),
                            )));
                        })
                        .build(k),
                ),
        );
    }

    let ComposerSubmissionStatus::Failed(error) = &rt.composer_submission.as_ref()?.status else {
        return None;
    };
    let retry_tid = tid.clone();
    let err_msg = format!("Message wasn’t sent. {error}");

    Some(
        row()
            .w_full()
            .items_center()
            .gap(10.0)
            .px(12.0)
            .py(8.0)
            .radius(10.0)
            .fill(k.alpha(t.danger, 0.10))
            .border(1.0, k.alpha(t.danger, 0.35))
            .child(icon(&icons::ALERT, 15.0).color(t.danger))
            .child(
                text(err_msg)
                    .font(k.ty.small)
                    .color(t.text_base)
                    .grow(1.0)
                    .min_w(0.0)
                    .truncate(),
            )
            .child(
                Button::new("Retry exact message")
                    .variant(ButtonVariant::Danger)
                    .control_size(ControlSize::Small)
                    .icon(&icons::ROTATE_CCW)
                    .disabled(rt.streaming)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Chat(ChatAction::RetryComposerSubmission(
                            retry_tid.clone(),
                        )));
                    })
                    .build(k)
                    .key("composer-retry-submission"),
            )
            .child(
                IconButton::new(k.glyph.close)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .label("Dismiss send failure")
                    .help("Dismiss send failure")
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Chat(ChatAction::DismissComposerFailure(
                            tid.clone(),
                        )));
                    })
                    .build(k)
                    .key("composer-dismiss-failure"),
            ),
    )
}

fn build_composer_status_hint(
    k: &Kit,
    t: &ThemeTokens,
    runtime: Option<&ThreadRuntime>,
    disconnected: bool,
    ws_reconnecting: bool,
) -> Option<El> {
    if let Some(rt) = runtime {
        if let Some(ref steer) = rt.pending_steer {
            return Some(
                row()
                    .w_full()
                    .items_center()
                    .gap(6.0)
                    .px(6.0)
                    .child(components::status_pill(
                        k,
                        t,
                        "Steer queued",
                        components::StatusPillTone::Accent,
                    ))
                    .child(
                        text(steer.text.clone())
                            .font(k.ty.small)
                            .color(t.text_muted)
                            .truncate()
                            .grow(1.0),
                    ),
            );
        }
        if rt.pending_turn_count > 0 {
            let label = if rt.pending_turn_count == 1 {
                "1 queued follow-up waiting".to_string()
            } else {
                format!("{} queued follow-ups waiting", rt.pending_turn_count)
            };
            return Some(
                row()
                    .w_full()
                    .px(6.0)
                    .child(text(label).font(k.ty.small).color(t.text_muted)),
            );
        }
    }

    if ws_reconnecting {
        return Some(
            row().w_full().px(6.0).child(
                text("Reconnecting workspace session... Draft is safe.")
                    .font(k.ty.small)
                    .color(t.text_muted),
            ),
        );
    }
    if disconnected {
        return Some(
            row().w_full().px(6.0).child(
                text("Workspace disconnected. Use Reconnect or send to retry.")
                    .font(k.ty.small)
                    .color(t.text_muted),
            ),
        );
    }

    None
}

/// Dispatches `ChatAction::SendMessage` using the live editor text, draft attachments, and `@` references.
pub fn submit_composer_message(s: &mut AppState) {
    let key = s.composer_key();
    let thread_id = s.nav.current().active_thread_id.clone();
    let tr_ref = thread_id
        .as_deref()
        .and_then(|id| s.threads.iter().find(|t| t.id == id));
    let rt_ref = thread_id
        .as_deref()
        .and_then(|id| s.thread_runtime_by_id.get(id));
    if rt_ref.is_some_and(|rt| {
        rt.read_only_notice.is_some() || rt.source_task.is_some() || rt.sending_composer_message()
    }) {
        return;
    }
    let streaming = rt_ref.is_some_and(|rt| rt.streaming);
    let hydrating = rt_ref.is_some_and(|rt| rt.hydrating);
    let transcript_only = rt_ref.is_some_and(|rt| rt.transcript_only);
    let ws_id = resolve_composer_workspace(s, tr_ref, tr_ref.is_none()).map(|w| w.id.as_str());
    let sock = ws_id.and_then(|id| s.workspace_socket_by_id.get(id));
    let sock_disconnected = ws_id.is_some()
        && !matches!(
            sock,
            Some(
                WsConnectionState::Connected
                    | WsConnectionState::Connecting
                    | WsConnectionState::Handshaking
            )
        );
    let thread_disconnected = sock_disconnected
        || (!hydrating
            && !transcript_only
            && tr_ref.is_some_and(|tr| tr.status != crate::state::ThreadStatus::Active));
    let session_missing = tr_ref.is_some_and(|tr| tr.session_id.is_none());
    let is_draft = tr_ref.is_some_and(|tr| tr.draft);
    if tr_ref.is_some() && streaming && !is_draft && (thread_disconnected || session_missing) {
        return;
    }
    let attachment_ingesting = rt_ref.is_some_and(|rt| rt.attachment_ingesting);
    let usage_hard_cap = rt_ref.is_some_and(|rt| rt.usage_hard_cap_reached);

    let draft = s.composer_drafts.get(&key).cloned().unwrap_or_default();
    if !composer_can_submit(
        &s.composer_edit.text,
        Some(&draft),
        attachment_ingesting,
        usage_hard_cap,
    ) {
        return;
    }

    let catalog = build_mention_catalog(&s.skills, &s.plugins);
    let text = s.composer_edit.text.clone();
    let references: Vec<TurnReference> = extract_references_from_text(&text, &catalog);
    let busy_policy = if streaming {
        ThreadBusyPolicy::Steer
    } else {
        draft.busy_policy
    };

    s.chat_ui.mention_dismissed_query = None;
    s.chat_ui.mention_active_index = 0;

    s.dispatch(Action::Chat(ChatAction::SendMessage {
        thread_id,
        text,
        busy_policy,
        attachments: draft.attachments,
        references,
    }));
}

pub fn composer_can_submit(
    text: &str,
    draft: Option<&ComposerDraft>,
    attachment_ingesting: bool,
    usage_hard_cap: bool,
) -> bool {
    if attachment_ingesting || usage_hard_cap {
        return false;
    }
    !text.trim().is_empty() || draft.is_some_and(|d| !d.attachments.is_empty())
}

pub fn resolve_composer_workspace<'a>(
    s: &'a AppState,
    thread: Option<&ThreadRecord>,
    is_landing: bool,
) -> Option<&'a WorkspaceRecord> {
    if !is_landing && let Some(tr) = thread {
        return s.workspaces.iter().find(|w| w.id == tr.workspace_id);
    }
    if s.landing_workspace_id.as_deref() == Some(crate::state::ONE_OFF_LANDING_SENTINEL) {
        return None;
    }
    let id = s
        .landing_workspace_id
        .as_deref()
        .or(s.active_workspace_id.as_deref())
        .or_else(|| s.resolve_management_workspace_id());
    id.and_then(|target| s.workspaces.iter().find(|w| w.id == target && !w.archived))
        .or_else(|| s.resolve_workspace_display_targets().into_iter().next())
}

pub fn is_hidden_lmstudio_model(provider_id: &str, model: &ProviderModelSummary) -> bool {
    crate::state::is_hidden_lmstudio_model_id(provider_id, &model.id)
}

pub fn build_model_options(providers: &[ProviderSummary]) -> Vec<ComboboxOption> {
    let mut out = Vec::new();
    for provider in providers.iter().filter(|p| p.configured) {
        for model in provider
            .models
            .iter()
            .filter(|m| m.enabled && !is_hidden_lmstudio_model(&provider.id, m))
        {
            let label = if model.name.trim().is_empty() {
                model.id.clone()
            } else {
                model.name.clone()
            };
            let mut opt =
                ComboboxOption::new(encode_model_option_id(&provider.id, &model.id), label);
            opt.detail = provider.name.clone();
            out.push(opt);
        }
    }
    out
}

pub fn resolve_composer_model(
    s: &AppState,
    thread: Option<&ThreadRecord>,
    draft: Option<&ComposerDraft>,
    ws: Option<&WorkspaceRecord>,
) -> Option<ResolvedComposerModel> {
    let (pid, mid) = s.resolve_submission_model(thread, draft, ws)?;
    Some(lookup_or_fallback_model(&s.provider_catalog, &pid, &mid))
}

fn lookup_or_fallback_model(
    catalog: &[ProviderSummary],
    provider_id: &str,
    model_id: &str,
) -> ResolvedComposerModel {
    if let Some(provider) = catalog.iter().find(|p| p.id == provider_id) {
        if let Some(model) = provider.models.iter().find(|m| m.id == model_id) {
            return resolved_from_summary(provider, model);
        }
        return ResolvedComposerModel {
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            model_id: model_id.to_string(),
            model_label: model_id.to_string(),
            supports_reasoning: false,
            reasoning_efforts: Vec::new(),
        };
    }
    ResolvedComposerModel {
        provider_id: provider_id.to_string(),
        provider_name: provider_id.to_string(),
        model_id: model_id.to_string(),
        model_label: model_id.to_string(),
        supports_reasoning: false,
        reasoning_efforts: Vec::new(),
    }
}

fn resolved_from_summary(
    provider: &ProviderSummary,
    model: &ProviderModelSummary,
) -> ResolvedComposerModel {
    ResolvedComposerModel {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        model_id: model.id.clone(),
        model_label: if model.name.trim().is_empty() {
            model.id.clone()
        } else {
            model.name.clone()
        },
        supports_reasoning: model.supports_reasoning,
        reasoning_efforts: model.reasoning_efforts.clone(),
    }
}

fn resolve_current_effort(
    draft: Option<&ComposerDraft>,
    thread: Option<&ThreadRecord>,
    ws: Option<&WorkspaceRecord>,
    allowed: &[&str],
) -> ReasoningEffortValue {
    let raw = draft
        .and_then(|d| d.reasoning_effort)
        .or_else(|| {
            thread
                .and_then(|t| t.reasoning_effort.as_deref())
                .and_then(parse_reasoning_effort)
        })
        .or_else(|| {
            ws.and_then(|w| w.defaults.get("reasoningEffort"))
                .and_then(|v| v.as_str())
                .and_then(parse_reasoning_effort)
        });

    if let Some(val) = raw
        && (allowed.is_empty() || allowed.contains(&val.as_str()))
    {
        return val;
    }

    allowed
        .iter()
        .copied()
        .find(|e| *e == "medium")
        .or_else(|| allowed.first().copied())
        .and_then(parse_reasoning_effort)
        .unwrap_or(ReasoningEffortValue::Medium)
}

fn parse_reasoning_effort(raw: &str) -> Option<ReasoningEffortValue> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "none" | "off" => Some(ReasoningEffortValue::None),
        "minimal" => Some(ReasoningEffortValue::Minimal),
        "low" => Some(ReasoningEffortValue::Low),
        "medium" => Some(ReasoningEffortValue::Medium),
        "high" => Some(ReasoningEffortValue::High),
        "xhigh" | "extra high" => Some(ReasoningEffortValue::Xhigh),
        "max" => Some(ReasoningEffortValue::Max),
        "dynamic" => Some(ReasoningEffortValue::Dynamic),
        _ => None,
    }
}

fn parse_reasoning_effort_label(label: &str) -> Option<ReasoningEffortValue> {
    parse_reasoning_effort(label)
}

fn format_effort_label(effort: &str) -> String {
    match effort.trim().to_ascii_lowercase().as_str() {
        "none" => "None".to_string(),
        "minimal" => "Minimal".to_string(),
        "low" => "Low".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra high".to_string(),
        "max" => "Max".to_string(),
        "dynamic" => "Dynamic".to_string(),
        other => other.to_string(),
    }
}

fn detect_active_slash_query(text: &str, focus: usize) -> Option<SlashQuery<'_>> {
    if !text.starts_with('/') || focus < 1 || focus > text.len() || !text.is_char_boundary(focus) {
        return None;
    }
    let slice = &text[1..focus];
    if slice.contains(char::is_whitespace) {
        return None;
    }
    Some(SlashQuery { query: slice })
}

fn detect_active_suggestions<'a>(
    edit: &TextEdit,
    ui: &ChatUiState,
    catalog: &'a MentionCatalog,
    commands: &'a [CommandInfo],
) -> Option<ActiveSuggestion<'a>> {
    if !edit.focused {
        return None;
    }
    if let Some(q) = detect_active_mention_query(&edit.text, edit.focus) {
        if ui.mention_dismissed_query.as_deref() == Some(q.query.as_str()) {
            return None;
        }
        let items = filter_mention_items(catalog, &q.query, 8);
        return (!items.is_empty()).then_some(ActiveSuggestion::Mention {
            start: q.start,
            query: q.query,
            items,
        });
    }
    if let Some(sq) = detect_active_slash_query(&edit.text, edit.focus) {
        if ui.mention_dismissed_query.as_deref() == Some("/") {
            return None;
        }
        let lower = sq.query.to_ascii_lowercase();
        let filtered: Vec<&CommandInfo> = commands
            .iter()
            .filter(|cmd| lower.is_empty() || cmd.name.to_ascii_lowercase().contains(&lower))
            .take(8)
            .collect();
        return (!filtered.is_empty()).then_some(ActiveSuggestion::Slash { commands: filtered });
    }
    None
}

fn encode_model_option_id(provider_id: &str, model_id: &str) -> String {
    format!("{provider_id}\x1f{model_id}")
}

fn decode_model_option_id(encoded: &str) -> Option<(String, String)> {
    let (provider, model) = encoded.split_once('\x1f')?;
    Some((provider.to_string(), model.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_provider() -> ProviderSummary {
        ProviderSummary {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            configured: true,
            models: vec![
                ProviderModelSummary {
                    id: "gpt-5".to_string(),
                    name: "GPT-5".to_string(),
                    enabled: true,
                    custom: false,
                    supports_reasoning: true,
                    reasoning_efforts: vec!["low".into(), "medium".into(), "high".into()],
                },
                ProviderModelSummary {
                    id: "text-embedding-3".to_string(),
                    name: "Embedding".to_string(),
                    enabled: false,
                    custom: false,
                    supports_reasoning: false,
                    reasoning_efforts: vec![],
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn resolve_composer_model_prefers_draft_over_thread_and_catalog() {
        let mut s = AppState {
            provider_catalog: vec![sample_provider()],
            ..Default::default()
        };
        let thread = ThreadRecord {
            id: "th-1".into(),
            provider: Some("openai".into()),
            model: Some("gpt-5".into()),
            ..Default::default()
        };
        let draft = ComposerDraft {
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet".into()),
            ..Default::default()
        };

        let resolved = resolve_composer_model(&s, Some(&thread), Some(&draft), None)
            .expect("draft model should resolve");
        assert_eq!(resolved.provider_id, "anthropic");
        assert_eq!(resolved.model_id, "claude-sonnet");

        let from_thread = resolve_composer_model(&s, Some(&thread), None, None)
            .expect("thread model should resolve");
        assert_eq!(from_thread.model_label, "GPT-5");
        assert!(from_thread.supports_reasoning);

        s.default_model_by_provider
            .insert("openai".into(), "gpt-5".into());
        let from_catalog =
            resolve_composer_model(&s, None, None, None).expect("catalog fallback should work");
        assert_eq!(from_catalog.model_id, "gpt-5");
    }

    #[test]
    fn build_model_options_filters_hidden_lmstudio_and_disabled_models() {
        let providers = vec![
            sample_provider(),
            ProviderSummary {
                id: "lmstudio".into(),
                name: "LM Studio".into(),
                configured: true,
                models: vec![
                    ProviderModelSummary {
                        id: "nomic-embed-text-v1.5".into(),
                        name: "Nomic Embed".into(),
                        enabled: true,
                        ..Default::default()
                    },
                    ProviderModelSummary {
                        id: "qwen2.5-coder".into(),
                        name: "Qwen 2.5 Coder".into(),
                        enabled: true,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        ];

        let opts = build_model_options(&providers);
        let ids: Vec<&str> = opts.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"openai\x1fgpt-5"));
        assert!(ids.contains(&"lmstudio\x1fqwen2.5-coder"));
    }

    #[test]
    fn model_option_id_roundtrips_with_colons_and_slashes() {
        let encoded = encode_model_option_id("openrouter", "openai/gpt-5:free");
        assert_eq!(
            decode_model_option_id(&encoded),
            Some(("openrouter".into(), "openai/gpt-5:free".into()))
        );
    }

    #[test]
    fn reasoning_effort_parser_and_resolver_preserve_dynamic_and_max() {
        assert_eq!(
            parse_reasoning_effort_label(&format_effort_label("dynamic")),
            Some(ReasoningEffortValue::Dynamic)
        );
        assert_eq!(
            parse_reasoning_effort_label(&format_effort_label("max")),
            Some(ReasoningEffortValue::Max)
        );
        let thread_dynamic = ThreadRecord {
            reasoning_effort: Some("dynamic".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_current_effort(
                None,
                Some(&thread_dynamic),
                None,
                &["none", "minimal", "low", "medium", "high", "dynamic"],
            ),
            ReasoningEffortValue::Dynamic
        );
        let thread_max = ThreadRecord {
            reasoning_effort: Some("max".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_current_effort(
                None,
                Some(&thread_max),
                None,
                &["none", "low", "medium", "high", "xhigh", "max"],
            ),
            ReasoningEffortValue::Max
        );
    }

    #[test]
    fn detect_active_slash_query_ignores_caret_before_leading_slash() {
        assert!(detect_active_slash_query("/help", 0).is_none());
        assert!(detect_active_slash_query("/", 0).is_none());
        assert_eq!(detect_active_slash_query("/", 1).map(|q| q.query), Some(""));
        assert_eq!(
            detect_active_slash_query("/help", 5).map(|q| q.query),
            Some("help")
        );
        assert_eq!(
            detect_active_slash_query("/help", 3).map(|q| q.query),
            Some("he")
        );
        assert!(detect_active_slash_query("/help arg", 9).is_none());
    }
}
