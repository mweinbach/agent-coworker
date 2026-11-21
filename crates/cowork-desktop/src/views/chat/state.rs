//! Ephemeral UI state owned by `views/chat/`.
//!
//! Kept isolated here and attached once on `AppState` (`chat_ui`) so chat UI interactions,
//! collapsibles, popovers, scroll indicators, and per-prompt edit buffers stay clean without
//! coupling core store reducers to widget-level details.

use std::collections::{HashMap, HashSet};

use rune::TextEdit;
use rune_kit::ComboboxState;
use rune_kit::diff::DiffState;

use super::model::MentionItem;

pub const DEFAULT_VISIBLE_FEED_COUNT: usize = 80;
pub const FEED_OLDER_PAGE_SIZE: usize = 60;
const COPY_FEEDBACK_DURATION_SECS: f64 = 1.6;

/// Resolved external source attached to an assistant citation chip or sources drawer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CitationSource {
    pub url: String,
    pub title: Option<String>,
}

/// Active inline citation carousel popover state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CitationPopoverState {
    pub anchor_key: String,
    pub sources: Vec<CitationSource>,
    pub active_index: usize,
}

/// Active clicked `@`-mention overview popover state inside a user message bubble.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionPopoverState {
    pub anchor_key: String,
    pub item: MentionItem,
}

/// Active view mode inside the Canvas pane.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CanvasTab {
    #[default]
    Document,
    Source,
}

/// Lifecycle phase displayed by a Canvas fixture or document session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CanvasLifecycleKind {
    Loading,
    #[default]
    Ready,
    Saving,
    Conflict,
    LoadError,
    SaveError,
}

/// Self-contained fixture/override state allowing headless tests and stories to render every Canvas state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanvasFixtureState {
    pub workspace_id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub is_markdown: bool,
    pub truncated: bool,
    pub lifecycle: CanvasLifecycleKind,
    pub message: Option<String>,
}

/// Ephemeral UI & editor state for the right-rail Canvas document pane.
pub struct CanvasUiState {
    /// Active tab (`Document` prose preview vs `Source` raw text editor).
    pub active_tab: CanvasTab,
    /// Whether the Markdown formatting toolbar (`B`, `I`, `H1-H3`, lists) is shown.
    pub show_formatting_bar: bool,
    /// Whether Canvas is expanded over the primary chat area instead of docked right.
    pub maximized: bool,
    /// Confirmation modal asking whether to discard local edits and reload from disk.
    pub reload_confirm_open: bool,
    /// Live `TextEdit` buffer for the Canvas source editor.
    pub source_edit: TextEdit,
    /// Bottom collaborative prompt `TextEdit` ("Ask model to edit this document...").
    pub prompt_edit: TextEdit,
    /// Stable document identity (`"{kind}\0{workspace_id}\0{id_or_path}"`) across `Loading -> Ready`, reload, and Save As.
    pub synced_doc_identity: Option<String>,
    /// Snapshot/revision key (`"{workspace_id}\0{path_or_id}\0{generation}\0{phase}"`) of the currently synced buffer.
    pub synced_session_key: Option<String>,
    /// Hash of the disk content snapshot currently synced in `synced_disk_content`.
    pub synced_disk_hash: Option<u64>,
    /// Last synced disk snapshot text used to compute dirty state.
    pub synced_disk_content: String,
    /// Local UI error notice (e.g. Save As canceled/failed validation).
    pub local_error: Option<String>,
    /// Optional explicit fixture override used by headless verification and scenes.
    pub fixture: Option<CanvasFixtureState>,
}

impl Default for CanvasUiState {
    fn default() -> Self {
        Self {
            active_tab: CanvasTab::Document,
            show_formatting_bar: true,
            maximized: false,
            reload_confirm_open: false,
            source_edit: TextEdit::default(),
            prompt_edit: TextEdit::default(),
            synced_doc_identity: None,
            synced_session_key: None,
            synced_disk_hash: None,
            synced_disk_content: String::new(),
            local_error: None,
            fixture: None,
        }
    }
}

impl CanvasUiState {
    /// Returns true when the live Source buffer differs from the last synced disk content.
    pub fn is_dirty(&self) -> bool {
        self.synced_session_key.is_some() && self.source_edit.text != self.synced_disk_content
    }

    /// Synchronizes editor buffer and default tab for an opened or reloaded Canvas session.
    #[allow(clippy::too_many_arguments)]
    pub fn sync_session(
        &mut self,
        doc_identity: &str,
        session_key: &str,
        disk_hash: u64,
        disk_content: &str,
        initial_text: &str,
        is_markdown: bool,
        is_live: bool,
        force_reset: bool,
    ) {
        let same_document = self.synced_doc_identity.as_deref() == Some(doc_identity);
        let same_session = self.synced_session_key.as_deref() == Some(session_key);

        if !force_reset && same_session {
            if self.synced_disk_hash != Some(disk_hash) {
                if is_live {
                    // Save/SaveAs updates `disk_content` without bumping `generation`; refresh
                    // the clean disk baseline in place so caret and in-flight typing stay intact.
                    self.synced_disk_hash = Some(disk_hash);
                    self.synced_disk_content = disk_content.to_string();
                } else if !self.is_dirty() {
                    self.synced_disk_hash = Some(disk_hash);
                    self.synced_disk_content = disk_content.to_string();
                    self.source_edit.replace_text(initial_text);
                }
            }
            return;
        }

        self.synced_doc_identity = Some(doc_identity.to_string());
        self.synced_session_key = Some(session_key.to_string());
        self.synced_disk_hash = Some(disk_hash);
        self.synced_disk_content = disk_content.to_string();
        self.source_edit.replace_text(initial_text);
        if !same_document || force_reset {
            self.active_tab = if is_markdown {
                CanvasTab::Document
            } else {
                CanvasTab::Source
            };
            self.reload_confirm_open = false;
            self.local_error = None;
        } else {
            self.reload_confirm_open = false;
        }
    }

    /// Clears transient Canvas buffers and overlays when closing the document.
    pub fn clear(&mut self) {
        self.synced_doc_identity = None;
        self.synced_session_key = None;
        self.synced_disk_hash = None;
        self.synced_disk_content.clear();
        self.source_edit.clear();
        self.prompt_edit.clear();
        self.reload_confirm_open = false;
        self.local_error = None;
        self.maximized = false;
        self.fixture = None;
    }
}

/// Local UI state for the chat view, landing composer, feed, tool cards, and chat dialogs.
pub struct ChatUiState {
    /// Explicit open/closed overrides for grouped activity cards, keyed by group ID.
    pub expanded_activity_groups: HashMap<String, bool>,
    /// Expanded reasoning timeline section keys (`"{item_id}:{section_index}"`).
    pub expanded_reasoning_sections: HashSet<String>,
    /// Expanded same-title tool cluster keys (`"{group_id}:{cluster_id}"`).
    pub expanded_tool_clusters: HashSet<String>,
    /// Explicit open/closed overrides for individual tool detail panels, keyed by tool item ID.
    pub expanded_tool_details: HashMap<String, bool>,
    /// Tool item IDs whose raw input/output JSON section is expanded.
    pub expanded_raw_io: HashSet<String>,
    /// Interactive `DiffView` state cache keyed by tool item ID.
    pub tool_diff_states: HashMap<String, DiffState>,
    /// Immutable empty fallback used by `DiffView` closures if a state entry is cleared mid-frame.
    pub(super) empty_diff_state: DiffState,
    /// Error feed row IDs whose full text is expanded.
    pub expanded_errors: HashSet<String>,
    /// Assistant message IDs whose bottom `Sources` carousel is expanded.
    pub open_citation_sources: HashSet<String>,
    /// Currently open citation chip carousel popover.
    pub active_citation_popover: Option<CitationPopoverState>,
    /// Currently open clicked `@`-mention detail popover.
    pub active_mention_popover: Option<MentionPopoverState>,
    /// Highlighted option index in the active `@`-mention autocomplete list.
    pub mention_active_index: usize,
    /// Query token dismissed via Escape so the popover stays hidden until the query changes.
    pub mention_dismissed_query: Option<String>,
    /// Active drag-over visual highlight on the composer drop zone.
    pub composer_drop_hover: bool,
    /// Searchable model selector state.
    pub model_combobox: ComboboxState,
    /// Reasoning effort selector open flag.
    pub reasoning_open: bool,
    /// Landing workspace/project target popover open flag.
    pub landing_target_open: bool,
    /// Developer-mode vertical composer resize override (points).
    pub composer_height_override: Option<f32>,
    /// Confirmation modal when stopping a turn that has running subagents.
    pub cancel_subagents_open: bool,
    /// Originating thread ID captured when opening the cancel-subagents modal.
    pub cancel_subagents_thread_id: Option<String>,
    /// Number of tail feed items currently rendered per thread key.
    pub feed_visible_count_by_thread: HashMap<String, usize>,
    /// Latest `on_at_bottom` signal per thread key.
    pub feed_at_bottom_by_thread: HashMap<String, bool>,
    /// Latest `on_far_from_bottom_under` signal per thread key (drives jump-to-latest pill).
    pub feed_far_from_bottom_by_thread: HashMap<String, bool>,
    /// Unseen appended updates while scrolled away from the bottom, per thread key.
    pub feed_unseen_updates_by_thread: HashMap<String, usize>,
    /// Last rendered item count observed while at the bottom, per thread key.
    pub feed_seen_count_by_thread: HashMap<String, usize>,
    /// Nested live activity timeline scroll at-bottom tracking, keyed by group ID.
    pub activity_at_bottom: HashMap<String, bool>,
    /// Transient `"Copied"` indicator `(target_key, expires_at_secs)`.
    pub copied_feedback: Option<(String, f64)>,
    /// Freeform `TextEdit` inputs for pending `ask` interactions, keyed by `"{request_id}:{question_id}"`.
    pub ask_text_edits: HashMap<String, TextEdit>,
    /// Selected option labels for pending `ask` interactions, keyed by `"{request_id}:{question_id}"`.
    pub ask_selected_options: HashMap<String, Vec<String>>,
    /// Active step index for multi-question `ask` interactions, keyed by request ID string.
    pub ask_active_question_idx: HashMap<String, usize>,
    /// Last `composer_key()` synced with `AppState::composer_edit`.
    pub synced_composer_key: Option<String>,
    /// Cached `TextEdit` snapshot per composer key so thread switching keeps local cursor/drafts.
    pub cached_composer_edits: HashMap<String, TextEdit>,
    /// Right-rail Canvas document view/edit UI state.
    pub canvas: CanvasUiState,
}

impl Default for ChatUiState {
    fn default() -> Self {
        Self {
            expanded_activity_groups: HashMap::new(),
            expanded_reasoning_sections: HashSet::new(),
            expanded_tool_clusters: HashSet::new(),
            expanded_tool_details: HashMap::new(),
            expanded_raw_io: HashSet::new(),
            tool_diff_states: HashMap::new(),
            empty_diff_state: DiffState::new(Vec::new()),
            expanded_errors: HashSet::new(),
            open_citation_sources: HashSet::new(),
            active_citation_popover: None,
            active_mention_popover: None,
            mention_active_index: 0,
            mention_dismissed_query: None,
            composer_drop_hover: false,
            model_combobox: ComboboxState::default(),
            reasoning_open: false,
            landing_target_open: false,
            composer_height_override: None,
            cancel_subagents_open: false,
            cancel_subagents_thread_id: None,
            feed_visible_count_by_thread: HashMap::new(),
            feed_at_bottom_by_thread: HashMap::new(),
            feed_far_from_bottom_by_thread: HashMap::new(),
            feed_unseen_updates_by_thread: HashMap::new(),
            feed_seen_count_by_thread: HashMap::new(),
            activity_at_bottom: HashMap::new(),
            copied_feedback: None,
            ask_text_edits: HashMap::new(),
            ask_selected_options: HashMap::new(),
            ask_active_question_idx: HashMap::new(),
            synced_composer_key: None,
            cached_composer_edits: HashMap::new(),
            canvas: CanvasUiState::default(),
        }
    }
}

impl std::fmt::Debug for ChatUiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatUiState")
            .field(
                "expanded_activity_groups",
                &self.expanded_activity_groups.len(),
            )
            .field("expanded_tool_details", &self.expanded_tool_details.len())
            .field("cancel_subagents_open", &self.cancel_subagents_open)
            .field("reasoning_open", &self.reasoning_open)
            .field("landing_target_open", &self.landing_target_open)
            .finish_non_exhaustive()
    }
}

impl ChatUiState {
    /// Returns true while a copy badge for `key` should show confirmation feedback.
    pub fn is_copied(&self, key: &str, now_secs: f64) -> bool {
        matches!(
            &self.copied_feedback,
            Some((active_key, expires_at)) if active_key == key && now_secs < *expires_at
        )
    }

    /// Marks `key` as recently copied for brief visual confirmation.
    pub fn mark_copied(&mut self, key: impl Into<String>, now_secs: f64) {
        self.copied_feedback = Some((key.into(), now_secs + COPY_FEEDBACK_DURATION_SECS));
    }

    /// Resolves whether an activity group card should currently be expanded.
    pub fn is_activity_expanded(&self, group_id: &str, default_open: bool) -> bool {
        self.expanded_activity_groups
            .get(group_id)
            .copied()
            .unwrap_or(default_open)
    }

    /// Toggles an activity group card relative to its current resolved open state.
    pub fn toggle_activity(&mut self, group_id: &str, currently_open: bool) {
        self.expanded_activity_groups
            .insert(group_id.to_string(), !currently_open);
    }

    /// Returns whether an individual tool detail card should be expanded.
    pub fn is_tool_expanded(&self, tool_id: &str, default_open: bool) -> bool {
        self.expanded_tool_details
            .get(tool_id)
            .copied()
            .unwrap_or(default_open)
    }

    /// Toggles an individual tool detail card relative to its current state.
    pub fn toggle_tool(&mut self, tool_id: &str, currently_open: bool) {
        self.expanded_tool_details
            .insert(tool_id.to_string(), !currently_open);
    }

    /// Returns the number of tail feed items visible for `thread_key`.
    pub fn visible_count_for(&self, thread_key: &str) -> usize {
        self.feed_visible_count_by_thread
            .get(thread_key)
            .copied()
            .unwrap_or(DEFAULT_VISIBLE_FEED_COUNT)
    }

    /// Expands the rendered window upward to reveal older messages.
    pub fn show_older_messages(&mut self, thread_key: &str, total_items: usize, page_size: usize) {
        let current = self.visible_count_for(thread_key);
        let next = current.saturating_add(page_size.max(1)).min(total_items);
        self.feed_visible_count_by_thread
            .insert(thread_key.to_string(), next);
    }

    /// Records viewport scroll state reported by Rune's edge callbacks.
    pub fn update_scroll_state(
        &mut self,
        thread_key: &str,
        at_bottom: Option<bool>,
        far_from_bottom: Option<bool>,
        total_items: usize,
    ) {
        if let Some(at) = at_bottom {
            self.feed_at_bottom_by_thread
                .insert(thread_key.to_string(), at);
            if at {
                self.feed_unseen_updates_by_thread
                    .insert(thread_key.to_string(), 0);
                self.feed_seen_count_by_thread
                    .insert(thread_key.to_string(), total_items);
            }
        }
        if let Some(far) = far_from_bottom {
            self.feed_far_from_bottom_by_thread
                .insert(thread_key.to_string(), far);
            if !far {
                self.feed_unseen_updates_by_thread
                    .insert(thread_key.to_string(), 0);
                self.feed_seen_count_by_thread
                    .insert(thread_key.to_string(), total_items);
            }
        }
    }

    /// Clears unseen update count when the user jumps back to the bottom.
    pub fn mark_jumped_to_latest(&mut self, thread_key: &str, total_items: usize) {
        self.feed_at_bottom_by_thread
            .insert(thread_key.to_string(), true);
        self.feed_far_from_bottom_by_thread
            .insert(thread_key.to_string(), false);
        self.feed_unseen_updates_by_thread
            .insert(thread_key.to_string(), 0);
        self.feed_seen_count_by_thread
            .insert(thread_key.to_string(), total_items);
    }

    /// Returns whether the jump-to-latest pill should be displayed for `thread_key`.
    pub fn show_jump_to_latest(&self, thread_key: &str, total_items: usize) -> bool {
        let far = self
            .feed_far_from_bottom_by_thread
            .get(thread_key)
            .copied()
            .unwrap_or(false);
        let unseen = self.unseen_update_count(thread_key, total_items);
        far || unseen > 0
    }

    /// Returns unseen updates appended while detached from the bottom.
    pub fn unseen_update_count(&self, thread_key: &str, total_items: usize) -> usize {
        let at_bottom = self
            .feed_at_bottom_by_thread
            .get(thread_key)
            .copied()
            .unwrap_or(true);
        if at_bottom {
            return 0;
        }
        let baseline = self
            .feed_seen_count_by_thread
            .get(thread_key)
            .copied()
            .unwrap_or(total_items);
        let recorded = self
            .feed_unseen_updates_by_thread
            .get(thread_key)
            .copied()
            .unwrap_or(0);
        recorded.max(total_items.saturating_sub(baseline))
    }

    /// Clears transient `ask` form buffers and active step for `req_key` after WS confirmation.
    pub fn clear_ask_request_by_key(&mut self, req_key: &str) {
        self.ask_active_question_idx.remove(req_key);
        let prefix = format!("{req_key}:");
        self.ask_text_edits.retain(|k, _| !k.starts_with(&prefix));
        self.ask_selected_options
            .retain(|k, _| !k.starts_with(&prefix));
    }

    /// Prunes `ask` form buffers whose request keys are no longer pending on any thread runtime.
    pub fn retain_active_ask_requests(&mut self, active_req_keys: &HashSet<String>) {
        self.ask_active_question_idx
            .retain(|req_key, _| active_req_keys.contains(req_key));
        self.ask_text_edits.retain(|q_key, _| {
            active_req_keys
                .iter()
                .any(|rk| q_key.starts_with(rk) && q_key.as_bytes().get(rk.len()) == Some(&b':'))
        });
        self.ask_selected_options.retain(|q_key, _| {
            active_req_keys
                .iter()
                .any(|rk| q_key.starts_with(rk) && q_key.as_bytes().get(rk.len()) == Some(&b':'))
        });
    }
}
