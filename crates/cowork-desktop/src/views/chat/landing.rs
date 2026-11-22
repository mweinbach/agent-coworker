//! New-chat landing surface (`NewChatLanding`): workspace picker, hero composer, and starter prompts.

use rune::{Align, Cursor, El, ScrollSpec, Side, TextEdit, col, el, icon, row, text};
use rune_kit::{Kit, PopupItem, PopupList};

use crate::actions::{Action, ChatAction, NativeAction, ShellAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;

use super::composer;
use super::icons;
use super::model::landing_starter_prompts;

const LANDING_MAX_WIDTH: f32 = 672.0;

/// Renders the new-chat landing experience when no active thread is open.
pub fn build_landing_view(s: &AppState, k: &Kit, t: &ThemeTokens, overlays: &mut Vec<El>) -> El {
    let selected_ws = composer::resolve_composer_workspace(s, None, true);
    let has_project_ws = selected_ws.is_some_and(|w| !w.one_off_chat);
    let has_draft_input = !s.composer_edit.text.trim().is_empty()
        || s.composer_drafts
            .get(&s.composer_key())
            .is_some_and(|d| !d.attachments.is_empty());

    let greeting = build_greeting_header(s, k, t, selected_ws);
    let target_picker = build_workspace_target_picker(s, k, t, overlays, selected_ws);
    let hero_composer = composer::build_composer(s, k, t, overlays, true);
    let starters = build_starter_prompts(k, t, has_project_ws, has_draft_input);

    let center_col = col()
        .key("new-chat-landing")
        .w_full()
        .max_w(LANDING_MAX_WIDTH)
        .items_center()
        .gap(20.0)
        .child(greeting)
        .child(
            col()
                .w_full()
                .gap(10.0)
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_start()
                        .child(target_picker),
                )
                .child(hero_composer),
        )
        .child(starters);

    col()
        .key("landing-scroll")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .items_center()
                .px(24.0)
                .py(24.0)
                .child(rune::el().grow(1.0).min_h(0.0))
                .child(center_col)
                .child(rune::el().grow(1.0).min_h(0.0)),
        )
}

fn build_greeting_header(
    _s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    selected_ws: Option<&crate::state::WorkspaceRecord>,
) -> El {
    let profile_name = selected_ws
        .and_then(|w| w.user_name.as_deref())
        .map(str::trim)
        .filter(|n| !n.is_empty());

    let heading = match profile_name {
        Some(name) => format!("How can I help, {name}?"),
        None => "What should we work on?".to_string(),
    };

    let subtitle = match selected_ws {
        Some(ws) if !ws.one_off_chat => format!("Working in {}", ws.name),
        _ => "Choose a workspace folder or start a quick chat.".to_string(),
    };

    col()
        .w_full()
        .items_center()
        .gap(6.0)
        .child(
            text(heading)
                .font(rune::TextStyle::new(26.0, 600.0).lh(32.0).tracking(-0.55))
                .color(t.text_base),
        )
        .child(text(subtitle).font(k.ty.ui).color(t.text_muted))
}

fn build_workspace_target_picker(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
    selected_ws: Option<&crate::state::WorkspaceRecord>,
) -> El {
    let display_label = match selected_ws {
        Some(ws) if !ws.one_off_chat => ws.name.clone(),
        _ => "Quick chat".to_string(),
    };
    let leading_glyph = if selected_ws.is_some_and(|w| !w.one_off_chat) {
        &icons::FOLDER
    } else {
        &icons::MESSAGE_SQUARE
    };

    let trigger = row()
        .key("landing-target-trigger")
        .items_center()
        .gap(6.0)
        .px(8.0)
        .py(5.0)
        .radius(8.0)
        .hover(t.hover)
        .cursor(Cursor::Pointer)
        .help("Select workspace target")
        .on_press(|s: &mut AppState| {
            s.chat_ui.landing_target_open = !s.chat_ui.landing_target_open;
        })
        .child(icon(leading_glyph, 13.0).color(t.text_muted))
        .child(
            text(display_label)
                .font(k.ty.small_medium)
                .color(t.text_base)
                .max_w(220.0)
                .truncate(),
        )
        .child(icon(k.glyph.chevron_down, 12.0).color(t.text_faint));

    if s.chat_ui.landing_target_open {
        let mut items: Vec<PopupItem> = Vec::new();
        for ws in s
            .resolve_workspace_display_targets()
            .into_iter()
            .filter(|w| !w.one_off_chat)
        {
            let selected = selected_ws.is_some_and(|sel| sel.id == ws.id);
            let mut item = PopupItem::new(format!("ws:{}", ws.id), ws.name.clone())
                .description(ws.path.clone())
                .leading(icon(&icons::FOLDER, 14.0).color(t.text_muted));
            if selected {
                item = item.trailing(icon(k.glyph.check, 13.0).color(t.accent));
            }
            items.push(item);
        }

        let quick_selected = selected_ws.is_none_or(|w| w.one_off_chat);
        let mut quick_item = PopupItem::new("quick", "Quick chat")
            .description("Start without a folder")
            .leading(icon(&icons::MESSAGE_SQUARE, 14.0).color(t.text_muted));
        if quick_selected {
            quick_item = quick_item.trailing(icon(k.glyph.check, 13.0).color(t.accent));
        }
        items.push(quick_item);

        items.push(
            PopupItem::new("pick", "Add workspace folder...")
                .description("Browse local directory")
                .leading(icon(&icons::EXTERNAL_LINK, 14.0).color(t.accent)),
        );

        PopupList::new("landing-target-menu", "landing-target-trigger")
            .anchored("landing-target-trigger", Side::Bottom, Align::Start, 6.0)
            .width(400.0)
            .max_height(260.0)
            .open(true)
            .items(items)
            .on_close(|s: &mut AppState| {
                s.chat_ui.landing_target_open = false;
            })
            .on_choose(|s: &mut AppState, choice, _| {
                s.chat_ui.landing_target_open = false;
                if choice == "pick" {
                    s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                } else if choice == "quick" {
                    s.dispatch(Action::Shell(ShellAction::SelectLandingQuickChat));
                } else if let Some(ws_id) = choice.strip_prefix("ws:") {
                    s.dispatch(Action::Shell(ShellAction::SetLandingWorkspace(Some(
                        ws_id.to_string(),
                    ))));
                }
            })
            .build(k, overlays);
    }

    trigger
}

fn starter_icon(id: &str) -> &'static rune::Icon {
    match id {
        "summarize-repo" => &icons::BOOK_OPEN,
        "explain-folder" => &icons::COMPASS,
        "find-bugs" => &icons::SCAN_SEARCH,
        "write-tests" => &icons::CHECKLIST,
        "draft-plan" => &icons::CHECKLIST,
        "brainstorm" => &icons::LIGHTBULB,
        "polish-writing" => &icons::PENCIL,
        "explain-concept" => &icons::BOOK_OPEN,
        _ => &icons::MESSAGE_SQUARE,
    }
}

fn build_starter_prompts(k: &Kit, t: &ThemeTokens, has_workspace: bool, hidden: bool) -> El {
    if hidden {
        return el()
            .key("landing-starters-hidden")
            .w_full()
            .h(136.0)
            .layer_opacity(0.0)
            .disabled(true);
    }
    let prompts = landing_starter_prompts(has_workspace);
    let mut grid = row().w_full().flex_wrap().gap(10.0);

    for prompt in prompts {
        let prompt_text = prompt.prompt.to_string();
        let mut card = col()
            .key(format!("starter:{}", prompt.id))
            .grow(1.0)
            .min_w(260.0)
            .max_w(331.0)
            .gap(3.0)
            .px(13.0)
            .py(10.0)
            .radius(10.0)
            .border(1.0, t.border_muted)
            .child(
                row()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap(6.0)
                    .child(
                        row()
                            .items_center()
                            .gap(6.0)
                            .min_w(0.0)
                            .grow(1.0)
                            .child(icon(starter_icon(prompt.id), 13.0).color(t.text_muted))
                            .child(
                                text(prompt.label)
                                    .font(k.ty.ui_medium)
                                    .color(t.text_base)
                                    .truncate(),
                            ),
                    )
                    .child(icon(&icons::ARROW_UP, 12.0).color(t.text_faint)),
            )
            .child(
                text(prompt.detail)
                    .font(k.ty.small)
                    .color(t.text_muted)
                    .truncate(),
            );

        card = card
            .hover(t.elevated_bg)
            .cursor(Cursor::Pointer)
            .help("Insert starter prompt")
            .on_press(move |s: &mut AppState| {
                let key = s.composer_key();
                s.composer_edit = TextEdit::new(&prompt_text);
                s.composer_edit.focused = true;
                s.dispatch(Action::Chat(ChatAction::SetComposerDraftText {
                    key,
                    text: prompt_text.clone(),
                }));
            });

        grid = grid.child(card);
    }

    grid
}
