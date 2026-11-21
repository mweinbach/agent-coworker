//! Pure presentation logic for chat feeds, tool cards, `@`-mentions, transcripts, and prompts.
//!
//! Ported from `apps/desktop/src/ui/chat/` (`activityGroups.ts`, `agentRunTranscript.ts`,
//! `chatLogic.ts`, `composerMentions.ts`, `feedMessageParsing.ts`, `feedWindow.ts`,
//! `toolCards/toolCardFormatting.ts`) and `src/shared/toolCardFormatting.ts`.

use std::collections::{HashMap, HashSet};

use base64::Engine;
use chrono::{DateTime, Datelike, Local, TimeZone};
use cowork_protocol::{TurnAttachmentInputPart, TurnReference};
use rune_kit::diff::{self, FileDiff};
use serde_json::Value;

use crate::state::{
    FeedItem, FeedMessageRole, PendingSteerState, PluginSummary, ReasoningEffortValue,
    SkillSummary, ThreadAgentSummary, ToolRunStatus, WorkspaceRuntime,
};

/// Hidden turn text sent when retrying a failed tool call (`src/shared/chatRetry.ts`).
pub const HIDDEN_RETRY_TURN_PROMPT: &str = "Continue from where the previous turn stopped. Retry the failed step only if it is still necessary, then finish the user's request.";

/// Sentinel answer sent when the user skips an interactive `ask` prompt (`src/shared/ask.ts`).
pub const ASK_SKIP_TOKEN: &str = "[skipped]";

/// Maximum skill/plugin `@` references included on a single turn.
pub const MAX_TURN_REFERENCES: usize = 32;

const COMPACT_PROGRESS_ASSISTANT_CHARS: usize = 200;

/// One starter suggestion pill shown on `NewChatLanding`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StarterPrompt {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    pub prompt: &'static str,
}

const WORKSPACE_STARTER_PROMPTS: [StarterPrompt; 4] = [
    StarterPrompt {
        id: "summarize-repo",
        label: "Summarize this repo",
        detail: "Get oriented in the codebase",
        prompt: "Summarize this repository: structure, main technologies, and how to get started.",
    },
    StarterPrompt {
        id: "explain-folder",
        label: "Explain this folder",
        detail: "Understand how the pieces connect",
        prompt: "Explain the current folder: purpose, important files, and how pieces connect.",
    },
    StarterPrompt {
        id: "find-bugs",
        label: "Find rough edges",
        detail: "Spot bugs and brittle behavior",
        prompt: "Scan the workspace for rough edges, bugs, or brittle spots worth fixing next.",
    },
    StarterPrompt {
        id: "write-tests",
        label: "Suggest tests",
        detail: "Protect the behavior that matters",
        prompt: "Suggest high-value tests for the most important behavior in this workspace.",
    },
];

const QUICK_STARTER_PROMPTS: [StarterPrompt; 4] = [
    StarterPrompt {
        id: "draft-plan",
        label: "Draft a plan",
        detail: "Turn an idea into next steps",
        prompt: "Help me turn an idea into a clear, actionable plan.",
    },
    StarterPrompt {
        id: "brainstorm",
        label: "Brainstorm options",
        detail: "Explore approaches and trade-offs",
        prompt: "Help me brainstorm several approaches and compare their trade-offs.",
    },
    StarterPrompt {
        id: "polish-writing",
        label: "Polish writing",
        detail: "Make your message clear",
        prompt: "Help me make this writing clearer, tighter, and more persuasive.",
    },
    StarterPrompt {
        id: "explain-concept",
        label: "Break down a topic",
        detail: "Get a clear summary and mental model",
        prompt: "Break down this topic clearly with key trade-offs and concrete examples.",
    },
];

/// Returns starter suggestions matching whether a project workspace is selected.
pub fn landing_starter_prompts(has_workspace: bool) -> &'static [StarterPrompt] {
    if has_workspace {
        &WORKSPACE_STARTER_PROMPTS
    } else {
        &QUICK_STARTER_PROMPTS
    }
}

/// Human-readable display label for a reasoning effort level.
pub fn reasoning_effort_label(effort: ReasoningEffortValue) -> &'static str {
    match effort {
        ReasoningEffortValue::None => "Off",
        ReasoningEffortValue::Minimal => "Minimal",
        ReasoningEffortValue::Light => "Light",
        ReasoningEffortValue::Low => "Low",
        ReasoningEffortValue::Medium => "Medium",
        ReasoningEffortValue::High => "High",
        ReasoningEffortValue::Xhigh => "XHigh",
        ReasoningEffortValue::Max => "Max",
        ReasoningEffortValue::Dynamic => "Dynamic",
    }
}

/// Parses a persisted/thread reasoning effort string back into `ReasoningEffortValue`.
pub fn parse_reasoning_effort(raw: Option<&str>) -> Option<ReasoningEffortValue> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        "none" | "off" => Some(ReasoningEffortValue::None),
        "minimal" => Some(ReasoningEffortValue::Minimal),
        "light" => Some(ReasoningEffortValue::Light),
        "low" => Some(ReasoningEffortValue::Low),
        "medium" => Some(ReasoningEffortValue::Medium),
        "high" => Some(ReasoningEffortValue::High),
        "xhigh" | "extra high" => Some(ReasoningEffortValue::Xhigh),
        "max" => Some(ReasoningEffortValue::Max),
        "dynamic" => Some(ReasoningEffortValue::Dynamic),
        _ => None,
    }
}

/// Returns whether a feed message is the hidden synthetic retry turn prompt.
pub fn is_hidden_retry_turn(item: &FeedItem) -> bool {
    matches!(
        item,
        FeedItem::Message {
            role: FeedMessageRole::User,
            content,
            ..
        } if content.trim() == HIDDEN_RETRY_TURN_PROMPT
    )
}

/// Filters raw feed items for visibility (`Todos` and hidden retry turns always filtered;
/// `Log` and `System` only visible in developer mode).
pub fn prepare_feed(feed: &[FeedItem], developer_mode: bool) -> Vec<&FeedItem> {
    feed.iter()
        .filter(|item| match item {
            FeedItem::Todos { .. } => false,
            FeedItem::Log { .. } | FeedItem::System { .. } => developer_mode,
            FeedItem::Message { .. } => !is_hidden_retry_turn(item),
            FeedItem::Reasoning { .. } | FeedItem::Tool { .. } | FeedItem::Error { .. } => true,
        })
        .collect()
}

/// Slices the trailing `visible_count` items and returns `(visible_slice, hidden_count)`.
pub fn select_feed_window<T>(items: &[T], visible_count: usize) -> (&[T], usize) {
    let bounded = visible_count.max(1);
    if items.len() <= bounded {
        return (items, 0);
    }
    let hidden = items.len() - bounded;
    (&items[hidden..], hidden)
}

/// Top-level render node produced by grouping activity runs.
#[derive(Clone, Debug)]
pub enum ChatRenderItem<'a> {
    Row(&'a FeedItem),
    ActivityGroup(ActivityGroup<'a>),
}

/// Child entry inside a grouped activity card.
#[derive(Clone, Debug)]
pub enum ActivityNode<'a> {
    Reasoning(&'a FeedItem),
    ProgressMessage(&'a FeedItem),
    ToolCluster {
        cluster_id: String,
        title: String,
        items: Vec<&'a FeedItem>,
    },
}

/// Collapsible activity card grouping contiguous reasoning, tools, and compact progress notes.
#[derive(Clone, Debug)]
pub struct ActivityGroup<'a> {
    pub id: String,
    pub items: Vec<&'a FeedItem>,
    pub nodes: Vec<ActivityNode<'a>>,
    pub is_live: bool,
    pub tool_count: usize,
    pub has_reasoning: bool,
    pub error_count: usize,
    pub has_pending_approval: bool,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub is_retryable: bool,
    pub current_action: String,
    pub summary_label: String,
}

fn is_activity_core_item(item: &FeedItem) -> bool {
    matches!(item, FeedItem::Reasoning { .. } | FeedItem::Tool { .. })
}

fn is_compact_progress_assistant(item: &FeedItem) -> bool {
    let FeedItem::Message {
        role: FeedMessageRole::Assistant,
        content,
        attachments,
        ..
    } = item
    else {
        return false;
    };
    if !attachments.is_empty() {
        return false;
    }
    let trimmed = content.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= COMPACT_PROGRESS_ASSISTANT_CHARS
}

pub(super) fn item_id(item: &FeedItem) -> &str {
    match item {
        FeedItem::Message { id, .. }
        | FeedItem::Reasoning { id, .. }
        | FeedItem::Tool { id, .. }
        | FeedItem::Todos { id, .. }
        | FeedItem::Log { id, .. }
        | FeedItem::Error { id, .. }
        | FeedItem::System { id, .. } => id,
    }
}

fn item_timestamp_ms(item: &FeedItem) -> i64 {
    match item {
        FeedItem::Message { timestamp_ms, .. }
        | FeedItem::Reasoning { timestamp_ms, .. }
        | FeedItem::Tool { timestamp_ms, .. }
        | FeedItem::Todos { timestamp_ms, .. }
        | FeedItem::Log { timestamp_ms, .. }
        | FeedItem::Error { timestamp_ms, .. }
        | FeedItem::System { timestamp_ms, .. } => *timestamp_ms,
    }
}

fn item_is_streaming(item: &FeedItem) -> bool {
    match item {
        FeedItem::Message { streaming, .. } | FeedItem::Reasoning { streaming, .. } => *streaming,
        FeedItem::Tool {
            status, streaming, ..
        } => *streaming || matches!(status, ToolRunStatus::Pending | ToolRunStatus::Running),
        _ => false,
    }
}

/// Builds grouped render items from filtered feed items (`buildChatRenderItems` + `mergeTurnActivity`).
pub fn build_chat_render_items<'a>(
    items: &[&'a FeedItem],
    thread_busy: bool,
) -> Vec<ChatRenderItem<'a>> {
    // Pass 1: split on User / Error / System / Log and merge compact progress assistant messages
    // only within turns that also contain tool/reasoning activity and another assistant reply.
    let mut raw_groups: Vec<ChatRenderItem<'a>> = Vec::new();
    let mut turn_start = 0;
    while turn_start < items.len() {
        if !matches!(
            items[turn_start],
            FeedItem::Message {
                role: FeedMessageRole::Assistant,
                ..
            } | FeedItem::Reasoning { .. }
                | FeedItem::Tool { .. }
        ) {
            raw_groups.push(ChatRenderItem::Row(items[turn_start]));
            turn_start += 1;
            continue;
        }

        let mut turn_end = turn_start + 1;
        while turn_end < items.len()
            && matches!(
                items[turn_end],
                FeedItem::Message {
                    role: FeedMessageRole::Assistant,
                    ..
                } | FeedItem::Reasoning { .. }
                    | FeedItem::Tool { .. }
            )
        {
            turn_end += 1;
        }

        let turn_slice = &items[turn_start..turn_end];
        let last_assistant_idx = turn_slice.iter().rposition(|it| {
            matches!(
                it,
                FeedItem::Message {
                    role: FeedMessageRole::Assistant,
                    ..
                }
            )
        });
        let has_core_activity = turn_slice.iter().any(|it| is_activity_core_item(it));

        let mut i = 0;
        while i < turn_slice.len() {
            let can_merge_progress = has_core_activity
                && last_assistant_idx.is_some_and(|last| i < last)
                && is_compact_progress_assistant(turn_slice[i])
                && (i > 0 && is_activity_core_item(turn_slice[i - 1])
                    || turn_slice
                        .get(i + 1)
                        .is_some_and(|next| is_activity_core_item(next)));

            if is_activity_core_item(turn_slice[i]) || can_merge_progress {
                let mut grouped = Vec::new();
                while i < turn_slice.len() {
                    let is_progress_here = has_core_activity
                        && last_assistant_idx.is_some_and(|last| i < last)
                        && is_compact_progress_assistant(turn_slice[i])
                        && turn_slice
                            .get(i + 1)
                            .is_some_and(|next| is_activity_core_item(next));
                    if is_activity_core_item(turn_slice[i]) || is_progress_here {
                        grouped.push(turn_slice[i]);
                        i += 1;
                    } else {
                        break;
                    }
                }
                raw_groups.push(ChatRenderItem::ActivityGroup(build_activity_group(grouped)));
            } else {
                raw_groups.push(ChatRenderItem::Row(turn_slice[i]));
                i += 1;
            }
        }
        turn_start = turn_end;
    }

    // Live ownership: only the latest top-level item can be live when the thread is busy.
    if let Some(last) = raw_groups.last_mut() {
        match last {
            ChatRenderItem::ActivityGroup(group) => {
                group.is_live = thread_busy && group.items.iter().any(|it| item_is_streaming(it));
                let has_failures = group.error_count > 0;
                group.is_retryable = !thread_busy && has_failures && !group.has_pending_approval;
            }
            ChatRenderItem::Row(_) => {}
        }
    }

    raw_groups
}

fn build_activity_group<'a>(items: Vec<&'a FeedItem>) -> ActivityGroup<'a> {
    let first = items.first().copied();
    let id = first
        .map(|it| format!("activity-{}", item_id(it)))
        .unwrap_or_else(|| "activity-empty".to_string());
    let started_at_ms = first.map(item_timestamp_ms).unwrap_or(0);
    let ended_at_ms = items
        .last()
        .copied()
        .map(item_timestamp_ms)
        .unwrap_or(started_at_ms);

    let mut tool_count = 0usize;
    let mut has_reasoning = false;
    let mut error_count = 0usize;
    let mut nodes: Vec<ActivityNode<'a>> = Vec::new();
    let mut last_tool_label: Option<String> = None;
    let mut cluster_idx = 0usize;

    let mut idx = 0usize;
    while idx < items.len() {
        match items[idx] {
            FeedItem::Reasoning { .. } => {
                has_reasoning = true;
                nodes.push(ActivityNode::Reasoning(items[idx]));
                idx += 1;
            }
            FeedItem::Message { .. } => {
                nodes.push(ActivityNode::ProgressMessage(items[idx]));
                idx += 1;
            }
            FeedItem::Tool {
                tool_name,
                input,
                output,
                error,
                status,
                ..
            } => {
                let formatted =
                    format_tool_card(tool_name, input, output.as_ref(), error.as_deref(), *status);
                let title = formatted.title.clone();
                let mut cluster = vec![items[idx]];
                tool_count += 1;
                if matches!(status, ToolRunStatus::Failed | ToolRunStatus::Declined) {
                    error_count += 1;
                }
                last_tool_label = Some(if formatted.subtitle.is_empty() {
                    title.clone()
                } else {
                    format!("{title} · {}", formatted.subtitle)
                });
                idx += 1;

                while idx < items.len() {
                    if let FeedItem::Tool {
                        tool_name: next_name,
                        input: next_input,
                        output: next_output,
                        error: next_error,
                        status: next_status,
                        ..
                    } = items[idx]
                    {
                        let next_fmt = format_tool_card(
                            next_name,
                            next_input,
                            next_output.as_ref(),
                            next_error.as_deref(),
                            *next_status,
                        );
                        if next_fmt.title == title {
                            tool_count += 1;
                            if matches!(
                                next_status,
                                ToolRunStatus::Failed | ToolRunStatus::Declined
                            ) {
                                error_count += 1;
                            }
                            last_tool_label = Some(if next_fmt.subtitle.is_empty() {
                                next_fmt.title
                            } else {
                                format!("{} · {}", next_fmt.title, next_fmt.subtitle)
                            });
                            cluster.push(items[idx]);
                            idx += 1;
                            continue;
                        }
                    }
                    break;
                }

                nodes.push(ActivityNode::ToolCluster {
                    cluster_id: format!("{id}-c{cluster_idx}"),
                    title,
                    items: cluster,
                });
                cluster_idx += 1;
            }
            _ => {
                idx += 1;
            }
        }
    }

    let current_action = if let Some(label) = last_tool_label {
        label
    } else if has_reasoning {
        "Thinking…".to_string()
    } else {
        "Working…".to_string()
    };

    let mut summary_parts = Vec::new();
    if tool_count > 0 {
        summary_parts.push(if tool_count == 1 {
            "1 tool used".to_string()
        } else {
            format!("{tool_count} tools used")
        });
    }
    if has_reasoning {
        summary_parts.push("Reasoning".to_string());
    }
    let summary_label = if summary_parts.is_empty() {
        "Activity".to_string()
    } else {
        summary_parts.join(" · ")
    };

    ActivityGroup {
        id,
        items,
        nodes,
        is_live: false,
        tool_count,
        has_reasoning,
        error_count,
        has_pending_approval: false,
        started_at_ms,
        ended_at_ms,
        is_retryable: false,
        current_action,
        summary_label,
    }
}

/// Returns true when the top-level working dots indicator should follow the feed tail.
pub fn should_show_working_placeholder(
    render_items: &[ChatRenderItem<'_>],
    thread_busy: bool,
) -> bool {
    if !thread_busy {
        return false;
    }
    match render_items.last() {
        None => true,
        Some(ChatRenderItem::Row(item)) => match item {
            FeedItem::Message {
                role: FeedMessageRole::Assistant,
                streaming: true,
                ..
            } => false,
            FeedItem::Message { .. }
            | FeedItem::Error { .. }
            | FeedItem::Log { .. }
            | FeedItem::System { .. }
            | FeedItem::Reasoning { .. }
            | FeedItem::Tool { .. }
            | FeedItem::Todos { .. } => true,
        },
        Some(ChatRenderItem::ActivityGroup(group)) => !group.is_live,
    }
}

/// Formats millisecond durations into concise human labels (`2s`, `1m 14s`, `420ms`).
pub fn format_duration_compact(ms: i64) -> String {
    let clamped = ms.max(0);
    if clamped < 1000 {
        return format!("{clamped}ms");
    }
    let total_secs = clamped / 1000;
    if total_secs < 60 {
        return format!("{total_secs}s");
    }
    let mins = total_secs / 60;
    let rem_secs = total_secs % 60;
    if mins < 60 {
        if rem_secs == 0 {
            format!("{mins}m")
        } else {
            format!("{mins}m {rem_secs}s")
        }
    } else {
        let hours = mins / 60;
        let rem_mins = mins % 60;
        if rem_mins == 0 {
            format!("{hours}h")
        } else {
            format!("{hours}h {rem_mins}m")
        }
    }
}

/// One collapsible section parsed out of reasoning text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReasoningSection {
    pub title: String,
    pub body: String,
}

/// Splits reasoning markdown into titled sections at `# Heading` or standalone `**Heading**` lines.
pub fn parse_reasoning_sections(text: &str) -> Vec<ReasoningSection> {
    let mut sections: Vec<ReasoningSection> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_lines: Vec<&str> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        let heading = if let Some(rest) = trimmed.strip_prefix('#') {
            let clean = rest.trim_start_matches('#').trim();
            (!clean.is_empty()).then(|| clean.to_string())
        } else if (trimmed.starts_with("**")
            && trimmed.ends_with("**")
            && trimmed.len() > 4
            && !trimmed[2..trimmed.len() - 2].contains("**"))
            || (trimmed.starts_with("__")
                && trimmed.ends_with("__")
                && trimmed.len() > 4
                && !trimmed[2..trimmed.len() - 2].contains("__"))
        {
            let inner = trimmed[2..trimmed.len() - 2].trim();
            (!inner.is_empty()).then(|| inner.to_string())
        } else {
            None
        };

        if let Some(title) = heading {
            if current_title.is_some() || !current_lines.is_empty() {
                let body = current_lines.join("\n").trim().to_string();
                sections.push(ReasoningSection {
                    title: current_title
                        .take()
                        .unwrap_or_else(|| "Thinking".to_string()),
                    body,
                });
                current_lines.clear();
            }
            current_title = Some(title);
        } else if !trimmed.is_empty() || !current_lines.is_empty() {
            current_lines.push(line);
        }
    }

    if current_title.is_some() || !current_lines.is_empty() {
        let body = current_lines.join("\n").trim().to_string();
        if !body.is_empty() || current_title.is_some() {
            sections.push(ReasoningSection {
                title: current_title.unwrap_or_else(|| "Thinking".to_string()),
                body,
            });
        }
    }
    sections
}

/// Icon group for tool timeline rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolIconCategory {
    Todo,
    Search,
    Web,
    Terminal,
    File,
    Agent,
    Wrench,
}

/// Categorizes a tool name for timeline icon choice.
pub fn tool_icon_category(tool_name: &str) -> ToolIconCategory {
    let lower = tool_name.to_ascii_lowercase();
    if lower.contains("todo") {
        ToolIconCategory::Todo
    } else if lower.contains("grep")
        || lower.contains("glob")
        || lower.contains("find")
        || (lower.contains("search") && !lower.contains("web"))
    {
        ToolIconCategory::Search
    } else if lower.contains("web") || lower.contains("fetch") || lower.contains("url") {
        ToolIconCategory::Web
    } else if lower.contains("bash") || lower.contains("command") || lower.contains("shell") {
        ToolIconCategory::Terminal
    } else if lower.contains("read")
        || lower.contains("write")
        || lower.contains("edit")
        || lower.contains("file")
    {
        ToolIconCategory::File
    } else if lower.contains("agent") {
        ToolIconCategory::Agent
    } else {
        ToolIconCategory::Wrench
    }
}

/// Formatted tool row card content (`toolCardFormatting.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCardFormatted {
    pub title: String,
    pub subtitle: String,
    pub details: Vec<(String, String)>,
}

/// Middle-truncates paths keeping directory prefix and filename suffix.
pub fn middle_truncate_path(path: &str, max_chars: usize) -> String {
    let count = path.chars().count();
    if count <= max_chars || max_chars < 6 {
        return path.to_string();
    }
    let keep = max_chars - 1;
    let head = keep / 2;
    let tail = keep - head;
    let prefix: String = path.chars().take(head).collect();
    let suffix: String = path.chars().skip(count - tail).collect();
    format!("{prefix}…{suffix}")
}

/// End-truncates general single-line text safely on char boundaries.
pub fn truncate_text(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars || max_chars < 2 {
        return text.to_string();
    }
    let prefix: String = text.chars().take(max_chars - 1).collect();
    format!("{prefix}…")
}

/// Converts a raw tool name to human-readable title (`src/shared/toolCardFormatting.ts`).
pub fn humanize_tool_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "nativewebsearch" | "websearch" | "web_search" => return "Web Search".to_string(),
        "nativeurlcontext" => return "URL Context".to_string(),
        "webfetch" | "web_fetch" => return "Web Fetch".to_string(),
        "bash" | "commandexecution" | "command_execution" => return "Run command".to_string(),
        "read" | "read_file" | "readfile" => return "Read file".to_string(),
        "write" | "write_file" | "writefile" => return "Write file".to_string(),
        "edit" | "edit_file" | "editfile" => return "Edit file".to_string(),
        // Repo contract: standard-chat todoWrite is a plan checklist, never durable Task mode.
        "todowrite" | "todo_write" => return "Plan checklist".to_string(),
        "spawnagent" | "spawn_agent" => return "Subagent".to_string(),
        "waitforagent" | "wait_for_agent" => return "Wait for subagent".to_string(),
        _ => {}
    }
    let compact = name
        .strip_prefix("tool:")
        .or_else(|| name.strip_prefix("tool."))
        .or_else(|| name.strip_prefix("tool_"))
        .unwrap_or(name);
    let mut out = String::with_capacity(compact.len() + 4);
    let mut prev_lower = false;
    for ch in compact.chars() {
        if ch == '_' || ch == '-' {
            out.push(' ');
            prev_lower = false;
        } else if ch.is_ascii_uppercase() && prev_lower {
            out.push(' ');
            out.push(ch);
            prev_lower = false;
        } else {
            out.push(ch);
            prev_lower = ch.is_ascii_lowercase();
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return "Tool".to_string();
    }
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "Tool".to_string(),
    }
}

fn json_str<'a>(val: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let obj = val.as_object()?;
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            return Some(s.trim());
        }
    }
    None
}

fn json_val<'a>(val: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let obj = val.as_object()?;
    for key in keys {
        if let Some(v) = obj.get(*key) {
            return Some(v);
        }
    }
    None
}

fn value_as_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => v.to_string(),
    }
}

/// Formats a tool call for timeline display and expandable detail cards.
pub fn format_tool_card(
    tool_name: &str,
    input: &Value,
    output: Option<&Value>,
    error: Option<&str>,
    status: ToolRunStatus,
) -> ToolCardFormatted {
    let lower = tool_name.to_ascii_lowercase();
    let title = humanize_tool_name(tool_name);
    let mut details: Vec<(String, String)> = Vec::new();

    let subtitle = match lower.as_str() {
        "bash" | "commandexecution" | "command_execution" => {
            let cmd = json_str(input, &["command", "cmd", "script"]).unwrap_or("");
            let desc = json_str(input, &["description"]);
            if !cmd.is_empty() {
                details.push(("Command".to_string(), cmd.to_string()));
            }
            if let Some(cwd) = json_str(input, &["cwd", "workdir"]) {
                details.push(("Directory".to_string(), middle_truncate_path(cwd, 64)));
            }
            desc.map(|d| truncate_text(d, 72))
                .unwrap_or_else(|| truncate_text(cmd, 64))
        }
        "read" | "read_file" | "readfile" => {
            let path = json_str(input, &["file_path", "path", "filePath"]).unwrap_or("");
            if !path.is_empty() {
                details.push(("Path".to_string(), path.to_string()));
            }
            middle_truncate_path(path, 52)
        }
        "write" | "write_file" | "writefile" | "edit" | "edit_file" | "editfile" => {
            let path = json_str(input, &["file_path", "path", "filePath"]).unwrap_or("");
            if !path.is_empty() {
                details.push(("File".to_string(), path.to_string()));
            }
            middle_truncate_path(path, 52)
        }
        "websearch" | "web_search" | "nativewebsearch" => {
            let query = json_str(input, &["query", "q"]).unwrap_or("");
            if !query.is_empty() {
                details.push(("Query".to_string(), query.to_string()));
                format!("Searching for: {}", truncate_text(query, 80))
            } else {
                "Searching the web".to_string()
            }
        }
        "webfetch" | "web_fetch" => {
            let url = json_str(input, &["url"]).unwrap_or("");
            if !url.is_empty() {
                details.push(("URL".to_string(), url.to_string()));
                format!("Fetching: {}", truncate_text(url, 80))
            } else {
                String::new()
            }
        }
        "grep" | "glob" | "find" => {
            let pattern = json_str(input, &["pattern", "query"]).unwrap_or("");
            if !pattern.is_empty() {
                details.push(("Pattern".to_string(), pattern.to_string()));
            }
            if let Some(path) = json_str(input, &["path", "cwd"]) {
                details.push(("Path".to_string(), middle_truncate_path(path, 56)));
            }
            truncate_text(pattern, 64)
        }
        "todowrite" | "todo_write" => {
            let count = json_val(input, &["todos", "items"])
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if count > 0 {
                format!(
                    "{count} checklist item{}",
                    if count == 1 { "" } else { "s" }
                )
            } else {
                "Updated checklist".to_string()
            }
        }
        "spawnagent" | "spawn_agent" => {
            let target = json_str(input, &["nickname", "title", "role", "agent"])
                .or_else(|| json_str(input, &["task", "prompt"]));
            target.map(|t| truncate_text(t, 64)).unwrap_or_default()
        }
        "waitforagent" | "wait_for_agent" => json_str(input, &["agentId", "id", "target"])
            .map(|t| truncate_text(t, 56))
            .unwrap_or_default(),
        _ => json_str(
            input,
            &["path", "file_path", "url", "query", "command", "question"],
        )
        .map(|t| truncate_text(t, 64))
        .unwrap_or_default(),
    };

    if let Some(err) = error.filter(|e| !e.trim().is_empty()) {
        details.push(("Error".to_string(), err.trim().to_string()));
    } else if let Some(out) = output {
        if let Some(exit_code) = json_val(out, &["exitCode", "exit_code"]) {
            details.push(("Exit code".to_string(), value_as_string(exit_code)));
        }
        if matches!(status, ToolRunStatus::Completed)
            && let Some(summary) = summarize_ask_or_generic_output(&lower, out)
        {
            details.push(("Result".to_string(), summary));
        }
    }

    let final_subtitle = if !subtitle.is_empty() {
        subtitle
    } else {
        match status {
            ToolRunStatus::Pending => "Preparing…".to_string(),
            ToolRunStatus::Running => "Running…".to_string(),
            ToolRunStatus::Completed => "Completed".to_string(),
            ToolRunStatus::Failed => "Finished with an issue".to_string(),
            ToolRunStatus::Declined => "Denied".to_string(),
        }
    };

    ToolCardFormatted {
        title,
        subtitle: final_subtitle,
        details,
    }
}

fn summarize_ask_or_generic_output(lower_name: &str, out: &Value) -> Option<String> {
    if lower_name == "ask"
        && let Some(answer) = json_str(out, &["answer"])
    {
        return Some(if answer == ASK_SKIP_TOKEN {
            "Skipped".to_string()
        } else {
            truncate_text(answer, 90)
        });
    }
    if let Some(msg) = json_str(out, &["summary", "message", "status"]) {
        return Some(truncate_text(msg, 90));
    }
    None
}

/// Builds parsed `FileDiff` objects for `rune_kit::diff::DiffView` when a tool has a patch
/// or old/new file edit inputs.
pub fn extract_tool_diff(
    tool_name: &str,
    input: &Value,
    output: Option<&Value>,
    raw_diff: Option<&str>,
) -> Option<Vec<FileDiff>> {
    if let Some(patch) = raw_diff.filter(|s| !s.trim().is_empty()) {
        let parsed = diff::parse(patch);
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }
    if let Some(out_diff) = output
        .and_then(|v| json_str(v, &["diff", "patch", "unifiedDiff"]))
        .filter(|s| !s.trim().is_empty())
    {
        let parsed = diff::parse(out_diff);
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }
    if let Some(in_diff) = json_str(input, &["patch", "diff"]) {
        let parsed = diff::parse(in_diff);
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }

    let lower = tool_name.to_ascii_lowercase();
    let path = json_str(input, &["file_path", "path", "filePath"]).unwrap_or("file");
    if matches!(lower.as_str(), "edit" | "edit_file" | "editfile") {
        let old = input
            .get("old_string")
            .or_else(|| input.get("oldString"))
            .and_then(Value::as_str);
        let new = input
            .get("new_string")
            .or_else(|| input.get("newString"))
            .and_then(Value::as_str);
        if let (Some(old), Some(new)) = (old, new)
            && old != new
        {
            return Some(vec![FileDiff::from_texts(path, old, new)]);
        }
    }
    if matches!(lower.as_str(), "write" | "write_file" | "writefile")
        && let Some(content) = input.get("content").and_then(Value::as_str)
        && !content.is_empty()
    {
        return Some(vec![FileDiff::from_texts(path, "", content)]);
    }
    None
}

/// Category of an interactive `@`-mention target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MentionKind {
    Skill,
    Plugin,
}

/// Entry inside the composer `@`-mention catalog.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MentionItem {
    pub kind: MentionKind,
    pub name: String,
    pub label: String,
    pub description: String,
    pub badge: String,
}

/// Sorted greedy catalog for composer and transcript `@`-mention parsing.
#[derive(Clone, Debug, Default)]
pub struct MentionCatalog {
    pub items: Vec<MentionItem>,
    pub names: Vec<String>,
    pub kind_by_name: HashMap<String, MentionKind>,
}

/// One segment of user text split between literal text and matched `@mention` chips.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComposerSegment<'a> {
    Text {
        text: &'a str,
        start: usize,
        end: usize,
    },
    Mention {
        kind: MentionKind,
        name: String,
        raw: &'a str,
        start: usize,
        end: usize,
    },
}

/// In-progress `@query` token under the text caret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveMentionQuery {
    pub start: usize,
    pub query: String,
}

fn source_badge(scope: &str) -> String {
    match scope {
        "project" => "Project".to_string(),
        "global" => "Global".to_string(),
        "user" => "User".to_string(),
        "built-in" => "Built-in".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "Skill".to_string(),
    }
}

/// Builds the live `@`-mention catalog with skills prioritized before plugins.
pub fn build_mention_catalog(skills: &[SkillSummary], plugins: &[PluginSummary]) -> MentionCatalog {
    let mut items = Vec::new();
    let mut seen_lower = HashSet::new();

    for skill in skills
        .iter()
        .filter(|s| s.enabled && !s.name.trim().is_empty())
    {
        seen_lower.insert(skill.name.to_ascii_lowercase());
        items.push(MentionItem {
            kind: MentionKind::Skill,
            name: skill.name.clone(),
            label: skill.name.clone(),
            description: skill.description.clone(),
            badge: source_badge(&skill.scope),
        });
    }

    for plugin in plugins
        .iter()
        .filter(|p| p.enabled && !p.name.trim().is_empty())
    {
        let key = plugin.name.to_ascii_lowercase();
        if seen_lower.contains(&key) {
            continue;
        }
        seen_lower.insert(key);
        items.push(MentionItem {
            kind: MentionKind::Plugin,
            name: plugin.name.clone(),
            label: plugin.name.clone(),
            description: plugin
                .version
                .as_ref()
                .map(|v| format!("Plugin v{v}"))
                .unwrap_or_default(),
            badge: "Plugin".to_string(),
        });
    }

    let mut kind_by_name = HashMap::new();
    for item in &items {
        kind_by_name.entry(item.name.clone()).or_insert(item.kind);
    }
    let mut names: Vec<String> = kind_by_name.keys().cloned().collect();
    names.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));

    MentionCatalog {
        items,
        names,
        kind_by_name,
    }
}

fn boundary_before(text: &str, byte_idx: usize) -> bool {
    if byte_idx == 0 {
        return true;
    }
    text[..byte_idx]
        .chars()
        .next_back()
        .is_some_and(char::is_whitespace)
}

fn is_mention_name_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.'
}

fn match_mention_at(
    text: &str,
    at_idx: usize,
    catalog: &MentionCatalog,
) -> Option<(String, MentionKind, usize)> {
    let after_at = &text[at_idx + 1..];
    for name in &catalog.names {
        if after_at.len() < name.len() || !after_at.is_char_boundary(name.len()) {
            continue;
        }
        let candidate = &after_at[..name.len()];
        if !candidate.eq_ignore_ascii_case(name) {
            continue;
        }
        let end = at_idx + 1 + name.len();
        if text[end..].chars().next().is_some_and(is_mention_name_char) {
            continue;
        }
        if let Some(&kind) = catalog.kind_by_name.get(name) {
            return Some((name.clone(), kind, end));
        }
    }
    None
}

/// Splits `text` into plain runs and matched `@mention` segments.
pub fn parse_composer_segments<'a>(
    text: &'a str,
    catalog: &MentionCatalog,
) -> Vec<ComposerSegment<'a>> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut segments = Vec::new();
    let has_names = !catalog.names.is_empty();
    let mut text_start = 0usize;
    let mut cursor = 0usize;

    while cursor < text.len() {
        let ch = text[cursor..].chars().next().unwrap_or('\0');
        if has_names
            && ch == '@'
            && boundary_before(text, cursor)
            && let Some((name, kind, end)) = match_mention_at(text, cursor, catalog)
        {
            if text_start < cursor {
                segments.push(ComposerSegment::Text {
                    text: &text[text_start..cursor],
                    start: text_start,
                    end: cursor,
                });
            }
            segments.push(ComposerSegment::Mention {
                kind,
                name,
                raw: &text[cursor..end],
                start: cursor,
                end,
            });
            cursor = end;
            text_start = end;
            continue;
        }
        cursor += ch.len_utf8();
    }

    if text_start < text.len() {
        segments.push(ComposerSegment::Text {
            text: &text[text_start..],
            start: text_start,
            end: text.len(),
        });
    }
    segments
}

/// Extracts deduped first-occurrence `TurnReference` entries from composer text.
pub fn extract_references_from_text(text: &str, catalog: &MentionCatalog) -> Vec<TurnReference> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for seg in parse_composer_segments(text, catalog) {
        if let ComposerSegment::Mention { kind, name, .. } = seg {
            let kind_str = match kind {
                MentionKind::Skill => "skill",
                MentionKind::Plugin => "plugin",
            };
            let key = format!("{kind_str}:{name}");
            if seen.insert(key) {
                out.push(TurnReference {
                    kind: kind_str.to_string(),
                    name,
                });
                if out.len() >= MAX_TURN_REFERENCES {
                    break;
                }
            }
        }
    }
    out
}

/// Detects an active `@query` ending at UTF-8 byte offset `caret`.
pub fn detect_active_mention_query(text: &str, caret: usize) -> Option<ActiveMentionQuery> {
    if caret > text.len() || !text.is_char_boundary(caret) {
        return None;
    }
    let before = &text[..caret];
    for (idx, ch) in before.char_indices().rev() {
        if ch == '@' {
            return boundary_before(text, idx).then(|| ActiveMentionQuery {
                start: idx,
                query: text[idx + 1..caret].to_string(),
            });
        }
        if ch.is_whitespace() {
            return None;
        }
    }
    None
}

/// Filters mention items case-insensitively by name, label, or description.
pub fn filter_mention_items<'a>(
    catalog: &'a MentionCatalog,
    query: &str,
    limit: usize,
) -> Vec<&'a MentionItem> {
    let q = query.trim().to_ascii_lowercase();
    catalog
        .items
        .iter()
        .filter(|item| {
            q.is_empty()
                || item.name.to_ascii_lowercase().contains(&q)
                || item.label.to_ascii_lowercase().contains(&q)
                || item.description.to_ascii_lowercase().contains(&q)
        })
        .take(limit)
        .collect()
}

/// Cleaned visible user message separating display prose from protocol wrappers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VisibleUserMessage {
    pub text: String,
    pub canvas_title: Option<String>,
    pub attached_names: Vec<String>,
}

/// Strips protocol `<canvas_request>` / `<spreadsheet_canvas_request>` XML envelopes and
/// trailing attachment annotations (`Attached: ...`) from rendered user bubbles.
pub fn build_visible_user_message(raw: &str) -> VisibleUserMessage {
    let mut text = raw.trim().to_string();
    let mut canvas_title = None;

    for tag in ["spreadsheet_canvas_request", "canvas_request"] {
        if let Some((start, end, inner)) = find_xml_envelope(&text, tag) {
            let parsed_title = extract_xml_tag_text(inner, "title")
                .or_else(|| extract_xml_tag_text(inner, "file_name"))
                .or_else(|| extract_xml_attr(inner, "file", "name"))
                .or_else(|| extract_xml_attr(inner, "workbook", "file_name"));
            canvas_title = Some(parsed_title.unwrap_or_else(|| "Canvas".to_string()));

            let without_instructions = strip_xml_block(inner, "assistant_instructions");
            let selection =
                extract_xml_tag_text(&without_instructions, "selection").and_then(|s| {
                    if let Some(val) = extract_xml_tag_text(&s, "value") {
                        Some(val)
                    } else if s.trim_start().starts_with('<') {
                        None
                    } else {
                        Some(s)
                    }
                });
            let prompt = extract_xml_tag_text(&without_instructions, "user_request")
                .or_else(|| extract_xml_tag_text(&without_instructions, "instruction"))
                .unwrap_or_default();

            let body = match (selection.as_deref(), prompt.as_str()) {
                (Some(sel), p) if !sel.is_empty() && !p.is_empty() => {
                    format!("\u{201C}{sel}\u{201D}\n\n{p}")
                }
                (Some(sel), _) if !sel.is_empty() => format!("\u{201C}{sel}\u{201D}"),
                (_, p) => p.to_string(),
            };

            let before = text[..start].trim();
            let after = text[end..].trim();
            text = [before, body.as_str(), after]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
        }
    }

    if let Some(stripped) = text.strip_prefix("[Canvas Collaborative Edit]") {
        canvas_title.get_or_insert_with(|| "Canvas Edit".to_string());
        text = stripped.trim().to_string();
    }

    let mut attached_names = Vec::new();
    let mut lines: Vec<&str> = text.lines().collect();
    while let Some(last) = lines.last().map(|l| l.trim()) {
        if let Some(rest) = last.strip_prefix("Attached:") {
            for part in rest.split(',') {
                let clean = part.trim().trim_matches(|c| c == '[' || c == ']');
                if !clean.is_empty() {
                    attached_names.push(clean.to_string());
                }
            }
            lines.pop();
        } else {
            break;
        }
    }
    text = lines.join("\n").trim().to_string();

    VisibleUserMessage {
        text,
        canvas_title,
        attached_names,
    }
}

fn find_xml_envelope<'a>(text: &'a str, tag: &str) -> Option<(usize, usize, &'a str)> {
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut search_from = 0usize;
    while let Some(rel_start) = text[search_from..].find(&open_prefix) {
        let start = search_from + rel_start;
        let after_name = start + open_prefix.len();
        let next = text.as_bytes().get(after_name).copied();
        if !matches!(next, Some(b'>' | b' ' | b'\t' | b'\r' | b'\n')) {
            search_from = after_name;
            continue;
        }
        let open_end = text[after_name..].find('>')? + after_name + 1;
        let rel_close = text[open_end..].find(&close)?;
        let inner = &text[open_end..open_end + rel_close];
        let total_end = open_end + rel_close + close.len();
        return Some((start, total_end, inner));
    }
    None
}

fn strip_xml_block(xml: &str, tag: &str) -> String {
    if let Some((start, end, _)) = find_xml_envelope(xml, tag) {
        let mut out = String::with_capacity(xml.len());
        out.push_str(&xml[..start]);
        out.push_str(&xml[end..]);
        out
    } else {
        xml.to_string()
    }
}

fn extract_xml_attr(xml: &str, element: &str, attr: &str) -> Option<String> {
    let elem_prefix = format!("<{element}");
    let elem_start = xml.find(&elem_prefix)?;
    let after_elem = &xml[elem_start + elem_prefix.len()..];
    let elem_end = after_elem.find('>')?;
    let attrs = &after_elem[..elem_end];
    let needle = format!("{attr}=\"");
    let mut search_from = 0usize;
    while let Some(rel_idx) = attrs[search_from..].find(&needle) {
        let idx = search_from + rel_idx;
        let prev_ok = idx == 0
            || attrs[..idx]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if !prev_ok {
            search_from = idx + needle.len();
            continue;
        }
        let val_start = idx + needle.len();
        let val_end = attrs[val_start..].find('"')?;
        let decoded = unescape_xml(&attrs[val_start..val_start + val_end]);
        let trimmed = decoded.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    None
}

fn extract_xml_tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut search_from = 0usize;
    while let Some(rel_start) = xml[search_from..].find(&open) {
        let start = search_from + rel_start;
        let after_name = start + open.len();
        let next = xml.as_bytes().get(after_name).copied();
        if !matches!(next, Some(b'>' | b' ' | b'\t' | b'\r' | b'\n')) {
            search_from = after_name;
            continue;
        }
        let open_end = xml[after_name..].find('>')? + after_name + 1;
        let end = xml[open_end..].find(&close)?;
        let decoded = unescape_xml(&xml[open_end..open_end + end]);
        let trimmed = decoded.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    None
}

fn unescape_xml(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        if let Some(after) = tail.strip_prefix("&lt;") {
            out.push('<');
            rest = after;
        } else if let Some(after) = tail.strip_prefix("&gt;") {
            out.push('>');
            rest = after;
        } else if let Some(after) = tail.strip_prefix("&quot;") {
            out.push('"');
            rest = after;
        } else if let Some(after) = tail.strip_prefix("&apos;") {
            out.push('\'');
            rest = after;
        } else if let Some(after) = tail.strip_prefix("&amp;") {
            out.push('&');
            rest = after;
        } else {
            out.push('&');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

/// Cleans `<workflow_result>` and `<agent_report>` JSON envelopes inside subagent transcripts.
pub fn format_agent_run_message_text(text: &str) -> String {
    if !text.contains("<workflow_result>") && !text.contains("<agent_report>") {
        return text.to_string();
    }
    let step1 = replace_xml_envelope(text, "workflow_result", format_workflow_result_body);
    replace_xml_envelope(&step1, "agent_report", format_agent_report_body)
}

fn replace_xml_envelope(input: &str, tag: &str, renderer: fn(&str) -> String) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + open.len()..];
        if let Some(end) = after_open.find(&close) {
            out.push_str(&renderer(&after_open[..end]));
            rest = &after_open[end + close.len()..];
        } else {
            out.push_str(&renderer(after_open));
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn format_workflow_result_body(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        if let Some(s) = val.as_str() {
            let clean = s.trim();
            return if clean.is_empty() {
                String::new()
            } else {
                format!("\n\n{clean}\n\n")
            };
        }
        if let Ok(pretty) = serde_json::to_string_pretty(&val) {
            return format!("\n\n```json\n{pretty}\n```\n\n");
        }
    }
    format!("\n\n```text\n{trimmed}\n```\n\n")
}

fn format_agent_report_body(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(val) = serde_json::from_str::<Value>(trimmed)
        && let Some(obj) = val.as_object()
        && let Some(summary) = obj.get("summary").and_then(Value::as_str)
    {
        let status = match obj.get("status").and_then(Value::as_str) {
            Some("blocked") => "blocked",
            Some("failed") => "failed",
            _ => "finished",
        };
        let quoted = summary
            .lines()
            .map(|l| format!("> {l}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut sections = vec![format!("**Report to main agent** · {status}\n\n{quoted}")];
        if let Some(files) = obj.get("filesChanged").and_then(Value::as_array)
            && !files.is_empty()
        {
            let formatted: Vec<String> = files
                .iter()
                .filter_map(Value::as_str)
                .map(|p| format!("`{p}`"))
                .collect();
            if !formatted.is_empty() {
                sections.push(format!("**Files changed:** {}", formatted.join(", ")));
            }
        }
        if let Some(read_files) = obj.get("filesRead").and_then(Value::as_array)
            && !read_files.is_empty()
        {
            sections.push(format!(
                "**Files read:** {} {}",
                read_files.len(),
                if read_files.len() == 1 {
                    "file"
                } else {
                    "files"
                }
            ));
        }
        return format!("\n\n{}\n\n", sections.join("\n\n"));
    }
    format_workflow_result_body(trimmed)
}

/// Visual attachment category matching `FileAttachment.tsx`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentCategory {
    Image,
    Spreadsheet,
    Pdf,
    Word,
    Presentation,
    Audio,
    Video,
    Generic,
}

/// Resolved presentation attributes for an attachment pill/card.
#[derive(Clone, Debug)]
pub struct AttachmentDisplayInfo {
    pub filename: String,
    pub mime_type: String,
    pub subtitle: String,
    pub category: AttachmentCategory,
    pub decoded_image_bytes: Option<Vec<u8>>,
    pub path: Option<String>,
}

/// Computes display filename, category, type subtitle, and decoded image bytes if inline.
pub fn attachment_display_info(part: &TurnAttachmentInputPart) -> AttachmentDisplayInfo {
    let (filename, mime_type, path, decoded_image_bytes) = match part {
        TurnAttachmentInputPart::InlineFile {
            filename,
            content_base64,
            mime_type,
        } => {
            let decoded = if mime_type.starts_with("image/") {
                base64::engine::general_purpose::STANDARD
                    .decode(content_base64.trim())
                    .ok()
            } else {
                None
            };
            (filename.clone(), mime_type.clone(), None, decoded)
        }
        TurnAttachmentInputPart::UploadedFile {
            filename,
            path,
            mime_type,
        } => (
            filename.clone(),
            mime_type.clone(),
            Some(path.clone()),
            None,
        ),
    };

    let ext = filename
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let lower_mime = mime_type.to_ascii_lowercase();

    let (category, subtitle) = if lower_mime.starts_with("image/")
        || matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
        ) {
        (AttachmentCategory::Image, "Image attachment")
    } else if matches!(ext.as_str(), "csv") {
        (AttachmentCategory::Spreadsheet, "CSV spreadsheet")
    } else if matches!(ext.as_str(), "xlsx" | "xls" | "ods") || lower_mime.contains("spreadsheet") {
        (AttachmentCategory::Spreadsheet, "Spreadsheet")
    } else if ext == "pdf" || lower_mime == "application/pdf" {
        (AttachmentCategory::Pdf, "PDF document")
    } else if matches!(ext.as_str(), "doc" | "docx" | "rtf")
        || lower_mime.contains("wordprocessing")
    {
        (AttachmentCategory::Word, "Word document")
    } else if matches!(ext.as_str(), "ppt" | "pptx" | "key") || lower_mime.contains("presentation")
    {
        (AttachmentCategory::Presentation, "Presentation")
    } else if lower_mime.starts_with("audio/")
        || matches!(ext.as_str(), "mp3" | "wav" | "m4a" | "ogg" | "flac")
    {
        (AttachmentCategory::Audio, "Audio attachment")
    } else if lower_mime.starts_with("video/")
        || matches!(ext.as_str(), "mp4" | "mov" | "webm" | "mkv")
    {
        (AttachmentCategory::Video, "Video attachment")
    } else {
        (AttachmentCategory::Generic, "File attachment")
    };

    AttachmentDisplayInfo {
        filename,
        mime_type,
        subtitle: subtitle.to_string(),
        category,
        decoded_image_bytes,
        path,
    }
}

/// Truncates `filename` from the middle while preserving its `.ext` suffix.
pub fn truncate_filename_preserve_ext(filename: &str, max_chars: usize) -> String {
    let len = filename.chars().count();
    if len <= max_chars || max_chars < 6 {
        return filename.to_string();
    }
    if let Some(dot) = filename.rfind('.')
        && dot > 0
        && dot + 1 < filename.len()
    {
        let ext = &filename[dot..];
        let ext_len = ext.chars().count();
        if ext_len + 3 < max_chars {
            let keep = max_chars - ext_len - 1;
            let stem: String = filename[..dot].chars().take(keep).collect();
            return format!("{stem}…{ext}");
        }
    }
    truncate_text(filename, max_chars)
}

/// Formats approval reason codes from `InteractionCard.tsx`.
pub fn approval_risk_label(reason_code: &str) -> String {
    match reason_code {
        "requires_manual_review" => "Needs your review".to_string(),
        "sandbox_denied_escalation" => "Run outside the OS sandbox".to_string(),
        "outside_allowed_scope" => "Outside the allowed scope".to_string(),
        "matches_dangerous_pattern" => "Potentially dangerous command".to_string(),
        "contains_shell_control_operator" => "Contains shell control operators".to_string(),
        "file_read_command_requires_review" => "File read needs review".to_string(),
        "safe_auto_approved" => "Auto-approved".to_string(),
        other => {
            let words = other.replace('_', " ");
            let mut chars = words.chars();
            match chars.next() {
                Some(c) => format!("{}{}", c.to_ascii_uppercase(), chars.as_str()),
                None => "Needs review".to_string(),
            }
        }
    }
}

/// Active child subagent predicates (`chatLogic.ts`).
pub fn is_active_child_agent(agent: &ThreadAgentSummary) -> bool {
    let status = agent.status.to_ascii_lowercase();
    !matches!(
        status.as_str(),
        "closed" | "completed" | "failed" | "errored" | "error" | "cancelled" | "canceled"
    ) && agent.completed_at.is_none()
}

pub fn count_active_child_agents(agents: &[ThreadAgentSummary]) -> usize {
    agents.iter().filter(|a| is_active_child_agent(a)).count()
}

pub fn active_child_agent_labels(agents: &[ThreadAgentSummary]) -> Vec<String> {
    agents
        .iter()
        .filter(|a| is_active_child_agent(a))
        .filter_map(|a| {
            let name = a.name.trim();
            if !name.is_empty() {
                Some(name.to_string())
            } else {
                a.role
                    .as_ref()
                    .map(|r| r.trim().to_string())
                    .filter(|s| !s.is_empty())
            }
        })
        .collect()
}

/// Day separator bucket key `(year, ordinal_day)` in local timezone.
pub fn day_bucket_key(timestamp_ms: i64) -> Option<(i32, u32)> {
    if timestamp_ms <= 0 {
        return None;
    }
    let dt = Local.timestamp_millis_opt(timestamp_ms).single()?;
    Some((dt.year(), dt.ordinal()))
}

/// Human-friendly day separator label (`Today`, `Yesterday`, or `Mon, Nov 14`).
pub fn format_day_separator(timestamp_ms: i64, now_secs: f64) -> String {
    let Some(dt) = Local.timestamp_millis_opt(timestamp_ms).single() else {
        return String::new();
    };
    let now_dt: DateTime<Local> = if now_secs > 1_000_000.0 {
        Local
            .timestamp_opt(now_secs as i64, 0)
            .single()
            .unwrap_or_else(Local::now)
    } else {
        Local::now()
    };
    let date = dt.date_naive();
    let today = now_dt.date_naive();
    if date == today {
        return "Today".to_string();
    }
    if let Some(yesterday) = today.pred_opt()
        && date == yesterday
    {
        return "Yesterday".to_string();
    }
    if dt.year() == now_dt.year() {
        dt.format("%a, %b %-d").to_string()
    } else {
        dt.format("%b %-d, %Y").to_string()
    }
}

/// Composer submit button visual mode (`getComposerSubmitState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitMode {
    Send,
    SteerReady,
    SteerPending,
}

/// Computed composer submit status & hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerSubmitState {
    pub pending: bool,
    pub disabled: bool,
    pub mode: SubmitMode,
    pub busy_hint: Option<&'static str>,
}

/// Computes composer send/steer button state matching `getComposerSubmitState` + `composerBusyHint`.
pub fn compute_composer_submit_state(
    busy: bool,
    has_blocking_overlay: bool,
    composer_text: &str,
    attachment_count: usize,
    submitting: bool,
    pending_steer: Option<&PendingSteerState>,
    connected_active: bool,
) -> ComposerSubmitState {
    let trimmed = composer_text.trim();
    let has_input = !trimmed.is_empty() || attachment_count > 0;
    let steer_matches =
        busy && has_input && pending_steer.is_some_and(|p| p.text.trim() == trimmed);

    if submitting {
        let mode = if busy {
            SubmitMode::SteerPending
        } else {
            SubmitMode::Send
        };
        return ComposerSubmitState {
            pending: true,
            disabled: true,
            mode,
            busy_hint: Some(if mode == SubmitMode::SteerPending {
                "Sending guidance. Stop remains available."
            } else {
                "Sending message. Waiting for the run to start."
            }),
        };
    }

    let mode = if busy && steer_matches {
        SubmitMode::SteerPending
    } else if busy {
        SubmitMode::SteerReady
    } else {
        SubmitMode::Send
    };
    let disabled =
        has_blocking_overlay || !has_input || steer_matches || (busy && !connected_active);

    let busy_hint = match mode {
        SubmitMode::SteerPending => {
            Some("Guidance sent. Waiting for the current run to accept it.")
        }
        SubmitMode::SteerReady if !disabled => Some("Enter to send guidance"),
        _ => None,
    };

    ComposerSubmitState {
        pending: false,
        disabled,
        mode,
        busy_hint,
    }
}

/// Extracts display domain (`example.com` without `www.`) from an external URL.
pub fn display_domain(site_url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(site_url)
        && let Some(host) = parsed.host_str()
    {
        return host.strip_prefix("www.").unwrap_or(host).to_string();
    }
    site_url.to_string()
}

/// Derives whether the active workspace runtime has an active WebSocket reconnect banner.
pub fn workspace_is_reconnecting(runtime: Option<&WorkspaceRuntime>) -> bool {
    runtime.is_some_and(|rt| rt.reconnecting)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn activity_grouping_merges_compact_progress_before_final_reply() {
        let f = [
            FeedItem::Message {
                id: "u1".into(),
                role: FeedMessageRole::User,
                content: "Check status".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 100,
            },
            FeedItem::Reasoning {
                id: "r1".into(),
                content: "**Scanning files**\nChecking crate layout".into(),
                mode: "reasoning".into(),
                streaming: false,
                timestamp_ms: 200,
            },
            FeedItem::Message {
                id: "a1".into(),
                role: FeedMessageRole::Assistant,
                content: "Looking at Cargo.toml now.".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 250,
            },
            FeedItem::Tool {
                id: "t1".into(),
                tool_name: "read".into(),
                title: None,
                call_id: None,
                status: ToolRunStatus::Completed,
                input: json!({ "path": "Cargo.toml" }),
                output: None,
                error: None,
                diff: None,
                streaming: false,
                timestamp_ms: 300,
                completed_at_ms: Some(310),
                output_truncated: false,
            },
            FeedItem::Message {
                id: "a2".into(),
                role: FeedMessageRole::Assistant,
                content: "All dependencies look good.".into(),
                client_message_id: None,
                attachments: vec![],
                references: vec![],
                citations: vec![],
                streaming: false,
                timestamp_ms: 400,
            },
        ];

        let prepared = prepare_feed(&f, false);
        let rendered = build_chat_render_items(&prepared, false);
        assert_eq!(rendered.len(), 3);
        assert!(matches!(rendered[0], ChatRenderItem::Row(_)));
        match &rendered[1] {
            ChatRenderItem::ActivityGroup(g) => {
                assert_eq!(g.tool_count, 1);
                assert!(g.has_reasoning);
                assert_eq!(g.nodes.len(), 3);
            }
            _ => panic!("expected ActivityGroup"),
        }
        assert!(matches!(rendered[2], ChatRenderItem::Row(_)));
    }

    #[test]
    fn todo_write_uses_plan_checklist_label() {
        let fmt = format_tool_card(
            "todoWrite",
            &json!({ "todos": [{ "content": "x" }, { "content": "y" }] }),
            None,
            None,
            ToolRunStatus::Completed,
        );
        assert_eq!(fmt.title, "Plan checklist");
        assert_eq!(fmt.subtitle, "2 checklist items");
    }

    #[test]
    fn mention_query_and_references_respect_boundaries_and_priority() {
        let skills = vec![SkillSummary {
            name: "review-pr".into(),
            description: "Review a pull request".into(),
            scope: "project".into(),
            enabled: true,
            ..Default::default()
        }];
        let plugins = vec![
            PluginSummary {
                id: "p1".into(),
                name: "review-pr".into(),
                version: None,
                enabled: true,
                ..Default::default()
            },
            PluginSummary {
                id: "p2".into(),
                name: "github".into(),
                version: Some("1.0".into()),
                enabled: true,
                ..Default::default()
            },
        ];
        let catalog = build_mention_catalog(&skills, &plugins);
        let text = "Please @review-pr and email me@example.com then @github";
        let refs = extract_references_from_text(text, &catalog);
        assert_eq!(
            refs,
            vec![
                TurnReference {
                    kind: "skill".into(),
                    name: "review-pr".into(),
                },
                TurnReference {
                    kind: "plugin".into(),
                    name: "github".into(),
                },
            ]
        );
        let query = detect_active_mention_query("hello @rev", 10);
        assert_eq!(
            query,
            Some(ActiveMentionQuery {
                start: 6,
                query: "rev".into(),
            })
        );
        assert_eq!(detect_active_mention_query("a@rev", 5), None);
    }

    #[test]
    fn visible_user_message_strips_canvas_envelope_and_attached_lines() {
        let raw = "<canvas_request><title>Budget.xlsx</title><user_request>Sum column B</user_request></canvas_request>\nAttached: [report.csv, notes.txt]";
        let parsed = build_visible_user_message(raw);
        assert_eq!(parsed.canvas_title.as_deref(), Some("Budget.xlsx"));
        assert_eq!(parsed.text, "Sum column B");
        assert_eq!(parsed.attached_names, vec!["report.csv", "notes.txt"]);
    }

    #[test]
    fn visible_user_message_parses_electron_v1_canvas_request_with_selection() {
        let raw = concat!(
            "<canvas_request version=\"1\" source=\"document\">\n",
            "  <assistant_instructions><instruction>Treat this as structured context.</instruction></assistant_instructions>\n",
            "  <file name=\"spec.md\" path=\"/w/spec.md\" kind=\"markdown\" />\n",
            "  <selection>Legacy &amp; verbose intro</selection>\n",
            "  <user_request>Rewrite &lt;v1&gt; concisely</user_request>\n",
            "</canvas_request>",
        );
        let parsed = build_visible_user_message(raw);
        assert_eq!(parsed.canvas_title.as_deref(), Some("spec.md"));
        assert_eq!(
            parsed.text,
            "\u{201C}Legacy & verbose intro\u{201D}\n\nRewrite <v1> concisely"
        );
    }

    #[test]
    fn visible_user_message_preserves_malformed_unclosed_canvas_request() {
        let raw = "<canvas_request version=\"1\">broken payload";
        let parsed = build_visible_user_message(raw);
        assert_eq!(parsed.canvas_title, None);
        assert_eq!(parsed.text, raw);
    }

    #[test]
    fn agent_report_formats_readable_markdown() {
        let raw = "Done checking.\n<agent_report>{\"status\":\"completed\",\"summary\":\"Tests pass\",\"filesChanged\":[\"src/lib.rs\"]}</agent_report>";
        let formatted = format_agent_run_message_text(raw);
        assert!(formatted.contains("**Report to main agent** · finished"));
        assert!(formatted.contains("> Tests pass"));
        assert!(formatted.contains("`src/lib.rs`"));
    }

    #[test]
    fn reasoning_sections_split_markdown_headings() {
        let sections =
            parse_reasoning_sections("**Analyze**\nCheck files\n\n### Plan\nEdit mod.rs");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].title, "Analyze");
        assert_eq!(sections[0].body, "Check files");
        assert_eq!(sections[1].title, "Plan");
        assert_eq!(sections[1].body, "Edit mod.rs");
    }
}
