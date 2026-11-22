//! Headless end-to-end UI performance benchmark suite for the native desktop app.
//!
//! Drives the Main window's real `view`, `poll`, and `on_key` (`cowork_desktop::perf_hooks` /
//! `views::shell::handle_key`) in a Rune `Runtime` over a realistic multi-workspace, multi-provider,
//! mixed-content fixture (real temp workspace files, ~12 providers / ~84 models, 40 skills,
//! 100-entry explorer tree, populated usage, fenced code, tables, inline/display KaTeX math,
//! expanded diffs, Canvas, Spreadsheet, and Presentation previews).
//!
//! ```sh
//! cargo bench -p cowork-desktop --bench ui_perf                     # all scenarios (CPU)
//! cargo bench -p cowork-desktop --bench ui_perf -- --gpu            # include headless GPU pass
//! cargo bench -p cowork-desktop --bench ui_perf -- --check          # enforce 60/120Hz gates
//! cargo bench -p cowork-desktop --bench ui_perf -- typing scroll    # run a subset
//! cargo bench -p cowork-desktop --bench ui_perf -- --items 600 --json out.json
//! ```
//!
//! All 8 original scenario names (`open_thread`, `switch_thread`, `streaming`, `typing`,
//! `scroll`, `settings`, `resize`, `idle`) and CLI flags (`--items`, `--json`, positional
//! filters) remain intact for apples-to-apples comparisons against Phase 1 baselines.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use base64::Engine as _;
use cowork_desktop::actions::{Action, NavAction, ShellAction, StoreEvent};
use cowork_desktop::perf_hooks;
use cowork_desktop::router::{SettingsPageId, ViewId};
use cowork_desktop::state::{
    AppState, CanvasDocumentRevision, CanvasDocumentSession, CanvasDocumentStatus, FeedItem,
    FeedMessageRole, FilePreviewState, ModelUsageBreakdown, PluginSummary, ProviderModelSummary,
    ProviderStatusSummary, ProviderSummary, ServerLifecycleState, SkillSummary, ThreadRecord,
    ThreadStatus, ToolRunStatus, UsageSummary, WorkspaceFileEntry, WorkspaceRecord,
    wall_clock_epoch_secs,
};
use cowork_desktop::theme;
use cowork_desktop::views::chat::state::CanvasTab;
use cowork_desktop::views::preview::{
    PresentationLayoutMode, PresentationPreviewData, PresentationSlideData,
    decode_spreadsheet_preview,
};
use cowork_desktop::ws::WsConnectionState;
use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer, write_png};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use rune_kit::diff::{self, DiffState};
use serde_json::json;
use tempfile::TempDir;

const VIEWPORT: (f32, f32) = (1280.0, 820.0);
const SCALE: f32 = 2.0;
const DT: f64 = 1.0 / 120.0;
/// Frames a settle may run (2 s at 120 Hz) before the harness stops waiting for rest.
const SETTLE_CAP: u32 = 240;
/// 120 Hz and 60 Hz frame budget targets in milliseconds.
const BUDGET_120HZ_MS: f64 = 8.33;
const BUDGET_60HZ_MS: f64 = 16.67;

const WS_COUNT: usize = 6;
const PRIMARY_WS_ID: &str = "ws-perf-0";

struct Opts {
    items: usize,
    filter: Vec<String>,
    json: Option<String>,
    gpu: bool,
    check: bool,
}

fn parse_opts() -> Opts {
    let mut opts = Opts {
        items: 400,
        filter: Vec::new(),
        json: None,
        gpu: false,
        check: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--items" => {
                opts.items = args.next().and_then(|v| v.parse().ok()).expect("--items N");
            }
            "--json" => opts.json = args.next(),
            "--gpu" => opts.gpu = true,
            "--check" => opts.check = true,
            // `cargo bench` passes `--bench`; ignore it and any other unknown flag.
            a if a.starts_with('-') => {}
            a => opts.filter.push(a.to_string()),
        }
    }
    opts
}

// ---------------------------------------------------------------------------------------------
// Fixture Content
// ---------------------------------------------------------------------------------------------

const ASSISTANT_BODY_CODE: &str = "### Summary\n\nI traced the slow path through the **session runtime** and the `turn/start` handler. \
The main costs are:\n\n1. Rebuilding the transcript projection on every notification\n2. Serializing the full feed for persistence\n\
3. Re-shaping text that did not change\n\n```rust\nfn apply(&mut self, delta: &str) {\n    self.content.push_str(delta);\n    self.revision += 1;\n}\n```\n\n\
| Phase | Before | After |\n| --- | --- | --- |\n| view | 12 ms | 1 ms |\n| layout | 6 ms | 2 ms |\n\n\
See [the protocol doc](https://example.invalid/docs) and `crates/cowork-server/src/jsonrpc.rs` for details. \
Next I will verify the fix against the regression suite and report back with numbers.";

const ASSISTANT_BODY_MATH: &str = "### Frame Budget Analysis\n\nAt 120 Hz, each frame must stay within $\\Delta t_{\\text{frame}} \\le 8.33\\,\\text{ms}$, \
while grouping $G$ activity clusters across $N$ rows currently scales as $O(G \\times N)$.\n\n\
$$\\text{FPS} = \\frac{1000}{\\Delta t_{\\text{view}} + \\Delta t_{\\text{layout}} + \\Delta t_{\\text{gpu}}}$$\n\n\
Key references: `crates/cowork-desktop/src/views/chat/feed.rs:235`, `crates/cowork-desktop/src/lib.rs:621`, and `src/lib.rs:12`.\n\n\
```ts\nexport function frameHeadroomMs(cpuMs: number, gpuMs: number): number {\n  return Math.max(0, 8.33 - (cpuMs + gpuMs));\n}\n```";

const USER_BODY: &str = "Can you look at why the transcript lags when a thread gets long? Use @skill-3 to check `crates/cowork-desktop/src/views/chat/feed.rs` and the reducer.";

const SAMPLE_UNIFIED_DIFF: &str = "\
--- a/crates/cowork-desktop/src/views/chat/feed.rs
+++ b/crates/cowork-desktop/src/views/chat/feed.rs
@@ -194,14 +194,11 @@ impl FeedRows {
     fn build(&self, s: &AppState, k: &Kit, t: &ThemeTokens, row: &RowSpec) -> El {
         match row {
             RowSpec::Ready { el, .. } => el.clone(),
-            RowSpec::Group { group_id, .. } => {
-                let prepared = prepare_feed(refs.feed, developer_mode);
-                let render_items = build_chat_render_items(&prepared, thread_busy);
-                build_activity_group_card(s, k, t, &render_items, group_id)
+            RowSpec::Group { group_id, feed_indices, .. } => {
+                // Direct O(|group|) slice avoids O(G * N_feed) cascade per row mount.
+                build_activity_group_from_indices(s, k, t, refs.feed, feed_indices, group_id)
             }
         }
     }
 }
";

/// Generates a ~6 KB realistic multi-block Markdown response for streaming benchmarks.
fn build_long_streaming_markdown() -> String {
    let mut doc = String::with_capacity(6_400);
    doc.push_str("## End-to-End 120 Hz Desktop Render Pipeline Audit\n\n");
    doc.push_str(
        "I profiled the full Rune frame lifecycle across `crates/cowork-desktop/src/lib.rs:621`, \
`crates/cowork-desktop/src/views/chat/feed.rs:235`, and `crates/cowork-server/src/jsonrpc.rs:42`. \
To sustain smooth 120 Hz motion ($\\Delta t \\le 8.33\\,\\text{ms}$) and zero 60 Hz frame drops \
($\\Delta t \\le 16.67\\,\\text{ms}$), every hot commit must keep view diffing, text shaping, and \
GPU atlas uploads strictly incremental.\n\n",
    );
    doc.push_str(
        "$$\\Delta t_{\\text{total}} = \\Delta t_{\\text{poll}} + \\Delta t_{\\text{view}} + \\Delta t_{\\text{layout}} + \\Delta t_{\\text{gpu}} \\le 8.33\\,\\text{ms}$$\n\n",
    );

    let sections = [
        (
            "1. Eliminating O(G × N) Virtual-Row Rebuilds & Full-Payload Hashing",
            "rust",
            "pub struct PreparedFeedCache {\n    pub thread_id: String,\n    pub feed_rev: u64,\n    pub items: Vec<PreparedEntry>,\n}\n\nimpl PreparedFeedCache {\n    pub fn refresh(&mut self, rev: u64, feed: &[FeedItem]) -> bool {\n        if self.feed_rev == rev {\n            return false;\n        }\n        self.feed_rev = rev;\n        self.items.clear();\n        self.items.reserve(feed.len());\n        for (idx, item) in feed.iter().enumerate() {\n            self.items.push(PreparedEntry::from_item(idx, item));\n        }\n        true\n    }\n}",
            "feed.rs:197",
        ),
        (
            "2. Splitting Streaming Markdown at Stable Block Boundaries",
            "rust",
            "pub fn split_settled_markdown(src: &str) -> (&str, &str) {\n    let mut in_fence = false;\n    let mut last_safe = 0usize;\n    let mut offset = 0usize;\n    for line in src.split_inclusive('\\n') {\n        let trimmed = line.trim_start();\n        if trimmed.starts_with(\"```\") || trimmed.starts_with(\"~~~\") {\n            in_fence = !in_fence;\n        } else if !in_fence && trimmed.is_empty() {\n            last_safe = offset + line.len();\n        }\n        offset += line.len();\n    }\n    src.split_at(last_safe)\n}",
            "markdown.rs:286",
        ),
        (
            "3. Shell Pane Memoization & Unmounting Settled-Closed Sidebars",
            "ts",
            "export interface PaneBudget {\n  readonly paneId: string;\n  readonly mountedWhenClosed: boolean;\n  readonly maxLayoutNodes: number;\n  readonly budgetMs120Hz: number;\n}\n\nexport const SHELL_BUDGETS: readonly PaneBudget[] = [\n  { paneId: \"sidebar\", mountedWhenClosed: false, maxLayoutNodes: 180, budgetMs120Hz: 1.5 },\n  { paneId: \"inspector\", mountedWhenClosed: false, maxLayoutNodes: 140, budgetMs120Hz: 1.5 },\n  { paneId: \"chat-feed\", mountedWhenClosed: true, maxLayoutNodes: 320, budgetMs120Hz: 4.0 },\n];",
            "split_frame.rs:435",
        ),
        (
            "4. Async Image Caching, Presentation Slide Reuse & FSEvents Filtering",
            "json",
            "{\n  \"watcher\": {\n    \"debounceMs\": 200,\n    \"ignore\": [\".git\", \"target\", \"node_modules\", \".cowork\"],\n    \"visibleDirsOnly\": true\n  },\n  \"presentationCache\": {\n    \"decodeOncePerUri\": true,\n    \"virtualizeGrid\": true,\n    \"maxSlidesDecodedPerFrame\": 4\n  }\n}",
            "presentation.rs:431",
        ),
    ];

    for (heading, lang, code, site) in sections {
        doc.push_str(&format!("### {heading}\n\n"));
        doc.push_str(&format!(
            "Inspecting `crates/cowork-desktop/src/views/chat/{site}` shows repeated work on every \
commit when streaming deltas arrive faster than $\\frac{{1}}{{120}}\\,\\text{{s}}$. By keying \
memoized subtrees on monotonic revision counters $r_i \\in \\mathbb{{N}}$, untouched blocks keep \
their shaped glyph runs and layout geometry in place.\n\n\
- Cache canonical workspace roots once per workspace instead of calling `canonicalize_sync` per inline code token.\n\
- Decouple sidebar open/close transitions from continuous `main-column` text re-wrapping across 60 animation frames.\n\
- Coalesce WebSocket streaming frames per display tick so background bursts never starve pointer or wheel input.\n\n\
```{lang}\n{code}\n```\n\n"
        ));
    }

    doc.push_str(
        "### Verification Targets\n\n\
| Scenario | Target Median | Target p95 (120 Hz) | Target Max (60 Hz) | Notes |\n\
| --- | --- | --- | --- | --- |\n\
| `open_thread` | <= 5.0 ms | <= 8.33 ms | <= 16.67 ms | Cold & warm transcript mount |\n\
| `streaming` | <= 2.0 ms | <= 6.0 ms | <= 8.33 ms | 6 KB response over 150 chunks |\n\
| `sidebar_toggle` | <= 2.0 ms | <= 6.0 ms | <= 8.33 ms | Full spring collapse/expand |\n\
| `resize_breakpoints` | <= 2.5 ms | <= 6.5 ms | <= 8.33 ms | 1 commit/step across breakpoints |\n\
| `idle` | <= 0.25 ms | <= 0.50 ms | <= 1.0 ms | Strictly 0 commits at rest |\n\n\
$$\\sum_{k=1}^{150} \\Delta t_k < 150 \\times 8.33\\,\\text{ms} \\implies \\text{zero dropped frames at 120 Hz}$$\n\n\
See [the WebSocket protocol spec](https://example.invalid/ws-protocol) and `docs/perf-spec.md` for full traceability.\n",
    );

    doc
}

/// Generates a ~20 KB realistic Markdown document for Canvas editing & preview benchmarks.
fn build_canvas_20kb_markdown() -> String {
    let section = build_long_streaming_markdown();
    let mut doc = String::with_capacity(21_000);
    doc.push_str("# Architecture & Performance Specification (Canvas 20 KB Fixture)\n\n");
    for idx in 1..=4 {
        doc.push_str(&format!("## Part {idx}\n\n"));
        doc.push_str(&section);
        doc.push('\n');
    }
    doc
}

/// Splits `text` into `target_chunks` deterministic non-empty UTF-8 slices.
fn split_into_chunks(text: &str, target_chunks: usize) -> Vec<String> {
    if text.is_empty() || target_chunks == 0 {
        return Vec::new();
    }
    let total = text.len();
    let mut boundaries = Vec::with_capacity(target_chunks + 1);
    boundaries.push(0usize);
    for i in 1..target_chunks {
        let approx = (i * total) / target_chunks;
        let mut idx = approx.min(total);
        while idx < total && !text.is_char_boundary(idx) {
            idx += 1;
        }
        if idx > *boundaries.last().unwrap_or(&0) && idx < total {
            boundaries.push(idx);
        }
    }
    boundaries.push(total);
    boundaries
        .windows(2)
        .filter(|w| w[0] < w[1])
        .map(|w| text[w[0]..w[1]].to_string())
        .collect()
}

fn tool_item(
    id: String,
    name: &str,
    ts: i64,
    input: serde_json::Value,
    output: serde_json::Value,
    diff: Option<String>,
) -> FeedItem {
    FeedItem::Tool {
        id: id.clone(),
        tool_name: name.to_string(),
        title: Some(format!("{name} {id}")),
        call_id: Some(format!("call-{id}")),
        status: ToolRunStatus::Completed,
        input,
        output: Some(output),
        error: None,
        diff,
        streaming: false,
        timestamp_ms: ts,
        completed_at_ms: Some(ts + 900),
        output_truncated: false,
    }
}

/// A thread of `items` feed items in realistic turns of user / reasoning / tools (incl. diff) / assistant (code + math).
fn long_feed(thread: &str, items: usize) -> Vec<FeedItem> {
    let mut feed = Vec::with_capacity(items);
    let mut ts = 1_700_000_000_000i64;
    let mut turn = 0usize;
    while feed.len() < items {
        let p = format!("{thread}-{turn}");
        feed.push(FeedItem::Message {
            id: format!("u-{p}"),
            role: FeedMessageRole::User,
            content: USER_BODY.to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            references: Vec::new(),
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: ts,
        });
        feed.push(FeedItem::Reasoning {
            id: format!("r-{p}"),
            content:
                "**Planning** Read the feed builder, patch the virtual-row cache, then measure."
                    .to_string(),
            mode: "summary".to_string(),
            streaming: false,
            timestamp_ms: ts + 1_000,
        });
        feed.push(tool_item(
            format!("t1-{p}"),
            "read_file",
            ts + 2_000,
            json!({ "path": "crates/cowork-desktop/src/views/chat/feed.rs" }),
            json!({ "lines": 288 }),
            None,
        ));
        if turn.is_multiple_of(3) {
            feed.push(tool_item(
                format!("t2-{p}"),
                "edit_file",
                ts + 3_000,
                json!({ "path": "crates/cowork-desktop/src/views/chat/feed.rs" }),
                json!({ "status": "applied", "filesChanged": 1 }),
                Some(SAMPLE_UNIFIED_DIFF.to_string()),
            ));
        } else {
            feed.push(tool_item(
                format!("t2-{p}"),
                "bash",
                ts + 3_000,
                json!({ "command": "cargo test -p cowork-desktop" }),
                json!({ "exitCode": 0, "stdout": "test result: ok. 412 passed; 0 failed\n".repeat(6) }),
                None,
            ));
        }
        let body = if turn % 4 == 3 {
            ASSISTANT_BODY_MATH
        } else {
            ASSISTANT_BODY_CODE
        };
        feed.push(FeedItem::Message {
            id: format!("a-{p}"),
            role: FeedMessageRole::Assistant,
            content: body.to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            references: Vec::new(),
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: ts + 4_000,
        });
        ts += 60_000;
        turn += 1;
    }
    feed.truncate(items);
    feed
}

/// The thread ids the fixture creates, newest first.
fn thread_id(i: usize) -> String {
    format!("th-perf-{i}")
}

fn workspace_id(i: usize) -> String {
    format!("ws-perf-{i}")
}

struct ProviderSpec {
    id: &'static str,
    name: &'static str,
    configured: bool,
    models: &'static [(&'static str, &'static str, bool)],
}

/// Populates ~12 realistic providers with 7 models each (~84 models total).
fn build_provider_catalog() -> (Vec<ProviderSummary>, Vec<ProviderStatusSummary>) {
    const SPECS: &[ProviderSpec] = &[
        ProviderSpec {
            id: "anthropic",
            name: "Anthropic",
            configured: true,
            models: &[
                ("claude-opus-4-6", "Claude Opus 4.6", true),
                ("claude-sonnet-4-5", "Claude Sonnet 4.5", true),
                ("claude-haiku-4-5", "Claude Haiku 4.5", false),
                ("claude-sonnet-4-0", "Claude Sonnet 4.0", true),
                ("claude-3-7-sonnet", "Claude 3.7 Sonnet", true),
                ("claude-3-5-sonnet", "Claude 3.5 Sonnet", false),
                ("claude-3-5-haiku", "Claude 3.5 Haiku", false),
            ],
        },
        ProviderSpec {
            id: "openai",
            name: "OpenAI",
            configured: true,
            models: &[
                ("gpt-5.4", "GPT-5.4", true),
                ("gpt-5.4-mini", "GPT-5.4 Mini", true),
                ("gpt-5", "GPT-5", true),
                ("gpt-4.1", "GPT-4.1", false),
                ("gpt-4.1-mini", "GPT-4.1 Mini", false),
                ("o3", "o3", true),
                ("o4-mini", "o4-mini", true),
            ],
        },
        ProviderSpec {
            id: "google",
            name: "Google Gemini",
            configured: true,
            models: &[
                ("gemini-2.5-pro", "Gemini 2.5 Pro", true),
                ("gemini-2.5-flash", "Gemini 2.5 Flash", true),
                ("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", false),
                ("gemini-2.0-flash", "Gemini 2.0 Flash", false),
                ("gemini-2.0-pro", "Gemini 2.0 Pro", true),
                ("gemini-1.5-pro", "Gemini 1.5 Pro", false),
                ("gemini-1.5-flash", "Gemini 1.5 Flash", false),
            ],
        },
        ProviderSpec {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            models: &[
                ("anthropic/claude-sonnet-4-5", "OR Claude Sonnet 4.5", true),
                ("openai/gpt-5", "OR GPT-5", true),
                ("google/gemini-2.5-pro", "OR Gemini 2.5 Pro", true),
                ("deepseek/deepseek-r1", "OR DeepSeek R1", true),
                ("qwen/qwen3-coder", "OR Qwen3 Coder", false),
                ("meta-llama/llama-4-maverick", "OR Llama 4 Maverick", false),
                ("mistralai/codestral-2501", "OR Codestral", false),
            ],
        },
        ProviderSpec {
            id: "deepseek",
            name: "DeepSeek",
            configured: true,
            models: &[
                ("deepseek-reasoner", "DeepSeek Reasoner", true),
                ("deepseek-chat", "DeepSeek Chat", false),
                ("deepseek-v3.1", "DeepSeek V3.1", true),
                ("deepseek-v3", "DeepSeek V3", false),
                ("deepseek-r1", "DeepSeek R1", true),
                ("deepseek-coder-v2", "DeepSeek Coder V2", false),
                ("deepseek-r1-distill-70b", "DeepSeek R1 Distill 70B", true),
            ],
        },
        ProviderSpec {
            id: "xai",
            name: "xAI",
            configured: true,
            models: &[
                ("grok-4", "Grok 4", true),
                ("grok-3", "Grok 3", true),
                ("grok-3-mini", "Grok 3 Mini", true),
                ("grok-3-fast", "Grok 3 Fast", false),
                ("grok-code-fast-1", "Grok Code Fast", false),
                ("grok-2-1212", "Grok 2", false),
                ("grok-2-vision", "Grok 2 Vision", false),
            ],
        },
        ProviderSpec {
            id: "mistral",
            name: "Mistral",
            configured: true,
            models: &[
                ("mistral-large-latest", "Mistral Large", false),
                ("mistral-medium-latest", "Mistral Medium", false),
                ("mistral-small-latest", "Mistral Small", false),
                ("codestral-latest", "Codestral", false),
                ("devstral-medium", "Devstral Medium", false),
                ("magistral-medium", "Magistral Medium", true),
                ("pixtral-large", "Pixtral Large", false),
            ],
        },
        ProviderSpec {
            id: "groq",
            name: "Groq",
            configured: true,
            models: &[
                ("llama-3.3-70b-versatile", "Llama 3.3 70B", false),
                ("llama-3.1-8b-instant", "Llama 3.1 8B Instant", false),
                ("qwen-qwq-32b", "Qwen QwQ 32B", true),
                ("deepseek-r1-distill-llama-70b", "R1 Distill 70B", true),
                ("mixtral-8x7b-32768", "Mixtral 8x7B", false),
                ("gemma2-9b-it", "Gemma 2 9B", false),
                ("compound-beta", "Compound Beta", true),
            ],
        },
        ProviderSpec {
            id: "bedrock",
            name: "Amazon Bedrock",
            configured: false,
            models: &[
                ("anthropic.claude-sonnet-4-5-v1", "Bedrock Sonnet 4.5", true),
                ("anthropic.claude-opus-4-v1", "Bedrock Opus 4", true),
                ("amazon.nova-pro-v1", "Amazon Nova Pro", false),
                ("amazon.nova-lite-v1", "Amazon Nova Lite", false),
                ("meta.llama3-3-70b-instruct", "Bedrock Llama 3.3 70B", false),
                ("mistral.mistral-large-2407", "Bedrock Mistral Large", false),
                ("cohere.command-r-plus", "Bedrock Command R+", false),
            ],
        },
        ProviderSpec {
            id: "vertex",
            name: "Google Vertex AI",
            configured: false,
            models: &[
                ("vertex/gemini-2.5-pro", "Vertex Gemini 2.5 Pro", true),
                ("vertex/gemini-2.5-flash", "Vertex Gemini 2.5 Flash", true),
                ("vertex/claude-sonnet-4-5", "Vertex Claude Sonnet 4.5", true),
                ("vertex/claude-haiku-4-5", "Vertex Claude Haiku 4.5", false),
                ("vertex/llama-4-scout", "Vertex Llama 4 Scout", false),
                ("vertex/codestral-2", "Vertex Codestral 2", false),
                ("vertex/mistral-large-2", "Vertex Mistral Large 2", false),
            ],
        },
        ProviderSpec {
            id: "ollama",
            name: "Ollama (Local)",
            configured: false,
            models: &[
                ("qwen2.5-coder:32b", "Qwen 2.5 Coder 32B", false),
                ("qwen3:32b", "Qwen 3 32B", true),
                ("deepseek-r1:32b", "DeepSeek R1 32B", true),
                ("llama3.3:70b", "Llama 3.3 70B", false),
                ("codestral:22b", "Codestral 22B", false),
                ("gemma3:27b", "Gemma 3 27B", false),
                ("phi4:14b", "Phi-4 14B", false),
            ],
        },
        ProviderSpec {
            id: "lmstudio",
            name: "LM Studio",
            configured: false,
            models: &[
                ("qwen2.5-coder-14b-instruct", "Qwen 2.5 Coder 14B", false),
                ("deepseek-r1-distill-qwen-14b", "R1 Distill Qwen 14B", true),
                ("llama-3.2-3b-instruct", "Llama 3.2 3B", false),
                ("mistral-nemo-instruct", "Mistral Nemo 12B", false),
                ("gemma-3-12b-it", "Gemma 3 12B", false),
                ("phi-4-mini-instruct", "Phi-4 Mini", false),
                ("starcoder2-15b", "StarCoder2 15B", false),
            ],
        },
    ];

    let mut catalog = Vec::with_capacity(SPECS.len());
    let mut statuses = Vec::with_capacity(SPECS.len());
    for spec in SPECS {
        let model_entries: Vec<ProviderModelSummary> = spec
            .models
            .iter()
            .map(|&(mid, mname, reasoning)| ProviderModelSummary {
                id: mid.to_string(),
                name: mname.to_string(),
                enabled: true,
                custom: false,
                supports_reasoning: reasoning,
                reasoning_efforts: if reasoning {
                    vec!["low".to_string(), "medium".to_string(), "high".to_string()]
                } else {
                    Vec::new()
                },
            })
            .collect();
        catalog.push(ProviderSummary {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            configured: spec.configured,
            models: model_entries,
            ..Default::default()
        });
        statuses.push(ProviderStatusSummary {
            provider: spec.id.to_string(),
            healthy: spec.configured,
            connected: spec.configured,
            auth_method: spec.configured.then(|| "api_key".to_string()),
            saved_api_key_mask: spec.configured.then(|| "sk-••••perf".to_string()),
            ..Default::default()
        });
    }
    (catalog, statuses)
}

fn build_usage_summary() -> UsageSummary {
    let mut by_model = HashMap::new();
    for (key, provider, model, turns, input, output, cached, cost) in [
        (
            "anthropic/claude-sonnet-4-5",
            "anthropic",
            "claude-sonnet-4-5",
            18,
            142_000,
            24_800,
            96_000,
            0.78,
        ),
        (
            "anthropic/claude-opus-4-6",
            "anthropic",
            "claude-opus-4-6",
            4,
            38_500,
            9_400,
            22_000,
            1.14,
        ),
        (
            "openai/gpt-5.4",
            "openai",
            "gpt-5.4",
            6,
            51_200,
            11_100,
            30_000,
            0.62,
        ),
        (
            "google/gemini-2.5-pro",
            "google",
            "gemini-2.5-pro",
            5,
            44_000,
            8_300,
            18_000,
            0.29,
        ),
    ] {
        by_model.insert(
            key.to_string(),
            ModelUsageBreakdown {
                provider: provider.to_string(),
                model: model.to_string(),
                turns,
                input_tokens: input,
                output_tokens: output,
                cached_tokens: cached,
                estimated_cost_usd: cost,
            },
        );
    }
    UsageSummary {
        input_tokens: 275_700,
        output_tokens: 53_600,
        cached_tokens: 166_000,
        estimated_cost_usd: 2.83,
        by_model,
    }
}

/// Populates 100 workspace explorer entries (4 expanded folders + 96 files) so context sidebar
/// open/closed & toggle scenarios exercise realistic file-tree sizes.
fn populate_explorer_tree(s: &mut AppState, ws_id: &str) {
    let top_dirs = ["src", "crates", "docs", "tests"];
    let mut root_entries = Vec::with_capacity(20);
    for dir in top_dirs {
        root_entries.push(WorkspaceFileEntry {
            name: dir.to_string(),
            path: dir.to_string(),
            is_dir: true,
            size_bytes: None,
            git_status: None,
        });
        s.explorer_expanded_dirs.insert(dir.to_string());
    }
    for i in 0..16usize {
        let name = format!("config-{i:02}.toml");
        root_entries.push(WorkspaceFileEntry {
            name: name.clone(),
            path: name,
            is_dir: false,
            size_bytes: Some(1024 + i as u64 * 256),
            git_status: i.is_multiple_of(5).then(|| "M".to_string()),
        });
    }
    s.explorer_entries_by_workspace
        .insert((ws_id.to_string(), ".".to_string()), root_entries.clone());
    s.explorer_entries_by_dir
        .insert(".".to_string(), root_entries);

    for (d_idx, dir) in top_dirs.iter().enumerate() {
        let mut children = Vec::with_capacity(20);
        for f_idx in 0..20usize {
            let ext = match d_idx {
                2 => "md",
                _ => "rs",
            };
            let name = format!("module_{d_idx}_{f_idx:02}.{ext}");
            let path = format!("{dir}/{name}");
            children.push(WorkspaceFileEntry {
                name,
                path,
                is_dir: false,
                size_bytes: Some(2048 + f_idx as u64 * 512),
                git_status: f_idx.is_multiple_of(4).then(|| "M".to_string()),
            });
        }
        s.explorer_entries_by_workspace
            .insert((ws_id.to_string(), (*dir).to_string()), children.clone());
        s.explorer_entries_by_dir
            .insert((*dir).to_string(), children);
    }
}

/// Creates a real temporary workspace directory populated with files referenced by inline code
/// links so path containment / `canonicalize_sync` exercises real filesystem lookups.
fn create_temp_workspace() -> TempDir {
    let dir = TempDir::new().expect("create perf temp workspace");
    let root = dir.path();
    let files = [
        ("src/lib.rs", "pub fn perf_fixture() {}\n"),
        (
            "crates/cowork-server/src/jsonrpc.rs",
            "pub fn handle_rpc() {}\n",
        ),
        ("crates/cowork-desktop/src/lib.rs", "pub fn poll_app() {}\n"),
        (
            "crates/cowork-desktop/src/views/chat/feed.rs",
            "pub fn build_chat_feed() {}\n",
        ),
        (
            "docs/perf-spec.md",
            "# Perf Spec\n\nTarget 120 Hz (8.33 ms).\n",
        ),
    ];
    for (rel, content) in files {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture subdir");
        }
        std::fs::write(&path, content).expect("write fixture file");
    }
    dir
}

fn fixture(items: usize) -> (AppState, TempDir) {
    let temp_dir = create_temp_workspace();
    let primary_root = temp_dir.path().to_string_lossy().into_owned();

    // Real (non-scene) code paths: poll, menus, and store reducers run as in the live desktop app.
    let mut s = AppState::default();
    s.scene_mode = false;
    s.onboarding.completed = true;
    s.native_ready = true;
    s.system_dark_override = Some(true);

    let (provider_catalog, provider_statuses) = build_provider_catalog();
    s.provider_catalog = provider_catalog;
    s.default_model_by_provider
        .insert("anthropic".to_string(), "claude-sonnet-4-5".to_string());
    s.default_model_by_provider
        .insert("openai".to_string(), "gpt-5.4".to_string());
    s.default_model_by_provider
        .insert("google".to_string(), "gemini-2.5-pro".to_string());

    let ws_names = [
        "Perf Project",
        "Core Harness",
        "Protocol SDK",
        "Desktop Rune",
        "Mobile Client",
        "Docs & Specs",
    ];
    for (i, &ws_name) in ws_names.iter().enumerate().take(WS_COUNT) {
        let ws_id = workspace_id(i);
        let ws_path = if i == 0 {
            primary_root.clone()
        } else {
            temp_dir
                .path()
                .join(format!("ws-{i}"))
                .to_string_lossy()
                .into_owned()
        };
        let mut ws = WorkspaceRecord::new(
            ws_id.clone(),
            ws_name,
            ws_path,
            1_700_000_000_000 - i as i64 * 10_000,
        );
        ws.default_provider = Some("anthropic".to_string());
        ws.default_model = Some("claude-sonnet-4-5".to_string());
        s.workspaces.push(ws);
        s.workspace_order.push(ws_id.clone());
        s.workspace_socket_by_id
            .insert(ws_id.clone(), WsConnectionState::Connected);
        let ws_rt = s.workspace_runtime_by_id.entry(ws_id).or_default();
        ws_rt.server_state = ServerLifecycleState::Running {
            ws_url: format!("ws://127.0.0.1:{}/ws", 7337 + i),
            port: 7337 + i as u16,
        };
        ws_rt.provider_statuses = provider_statuses.clone();
    }
    s.active_workspace_id = Some(PRIMARY_WS_ID.to_string());
    populate_explorer_tree(&mut s, PRIMARY_WS_ID);

    for i in 0..40usize {
        s.skills.push(SkillSummary {
            name: format!("skill-{i}"),
            description: "A bundled skill used to populate the mention catalog.".to_string(),
            scope: if i.is_multiple_of(2) {
                "global"
            } else {
                "project"
            }
            .to_string(),
            enabled: true,
            ..Default::default()
        });
    }
    for i in 0..4 {
        s.plugins.push(PluginSummary {
            id: format!("plugin-{i}"),
            name: format!("plugin-{i}"),
            display_name: Some(format!("Plugin {i}")),
            description: "Workspace plugin providing tools and skills.".to_string(),
            version: Some("1.2.0".to_string()),
            enabled: true,
            skill_count: 3,
            mcp_count: 1,
            ..Default::default()
        });
    }

    let usage = build_usage_summary();
    s.usage_summary = Some(usage.clone());

    // 60 threads across 6 workspaces; threads 0 and 1 are long transcripts in PRIMARY_WS_ID.
    for i in 0..60 {
        let id = thread_id(i);
        let ws_id = if i < 12 {
            PRIMARY_WS_ID.to_string()
        } else {
            workspace_id(i % WS_COUNT)
        };
        s.threads.push(ThreadRecord {
            id: id.clone(),
            workspace_id: ws_id,
            title: format!("Perf thread {i}: investigate transcript lag"),
            status: ThreadStatus::Active,
            session_id: Some(id.clone()),
            pinned: (2..=4).contains(&i),
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4-5".to_string()),
            created_at: 1_700_000_000_000 - i as i64 * 1_000,
            updated_at: 1_700_000_060_000 - i as i64 * 1_000,
            ..Default::default()
        });
        let rt = s.thread_runtime_by_id.entry(id.clone()).or_default();
        rt.hydrated = true;
        rt.feed = long_feed(&id, if i < 2 { items } else { 10 });
        if i < 2 {
            rt.usage = Some(usage.clone());
        }
    }

    (s, temp_dir)
}

// ---------------------------------------------------------------------------------------------
// Optional Headless GPU Context (`--gpu`)
// ---------------------------------------------------------------------------------------------

struct GpuBenchContext {
    gpu: Gpu,
    renderer: Renderer,
    target: Offscreen,
    dw: u32,
    dh: u32,
}

impl GpuBenchContext {
    fn new(viewport: (f32, f32), scale: f32) -> Self {
        let gpu = Gpu::headless();
        let renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
        let dw = ((viewport.0 * scale).round() as u32).max(1);
        let dh = ((viewport.1 * scale).round() as u32).max(1);
        let target = Offscreen::new(&gpu.device, dw, dh);
        Self {
            gpu,
            renderer,
            target,
            dw,
            dh,
        }
    }

    fn ensure_size(&mut self, viewport: (f32, f32), scale: f32) {
        let dw = ((viewport.0 * scale).round() as u32).max(1);
        let dh = ((viewport.1 * scale).round() as u32).max(1);
        if dw != self.dw || dh != self.dh {
            self.dw = dw;
            self.dh = dh;
            self.target = Offscreen::new(&self.gpu.device, dw, dh);
        }
    }

    /// Runs the full headless GPU render path (`upload_images`, `prepare_surfaces`, `prepare`,
    /// `draw`, `submit`) and returns the elapsed milliseconds on the UI thread.
    fn render_frame(
        &mut self,
        rt: &mut Runtime<AppState>,
        viewport: (f32, f32),
        scale: f32,
    ) -> f64 {
        self.ensure_size(viewport, scale);
        let dark = rt.state.effective_dark(true);
        let tokens = theme::resolve_tokens_with_accent(
            dark,
            rt.state.desktop_settings.reduced_transparency,
            rt.state.desktop_settings.high_contrast,
            rt.state.desktop_settings.accent_palette,
        );
        let clear = [
            tokens.panel_bg.r,
            tokens.panel_bg.g,
            tokens.panel_bg.b,
            tokens.panel_bg.a,
        ];

        let start = Instant::now();
        self.renderer
            .upload_images(&self.gpu.device, &self.gpu.queue, &mut rt.images);
        self.renderer.prepare_surfaces(
            &self.gpu.device,
            &self.gpu.queue,
            &rt.surfaces,
            (self.dw, self.dh),
        );
        self.renderer.prepare(
            &self.gpu.device,
            &self.gpu.queue,
            &mut rt.text.atlas,
            &rt.instances,
            (self.dw, self.dh),
        );
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        self.renderer.draw(&mut enc, &self.target.view, clear);
        self.renderer.submit(&self.gpu.queue, enc);
        start.elapsed().as_secs_f64() * 1000.0
    }
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

struct Harness {
    rt: Runtime<AppState>,
    clock: f64,
    viewport: (f32, f32),
    scale: f32,
    gpu: Option<GpuBenchContext>,
    _temp_dir: TempDir,
}

impl Harness {
    fn new(state: AppState, temp_dir: TempDir, enable_gpu: bool) -> Self {
        let mut rt = Runtime::new(
            state,
            perf_hooks::root_view,
            VIEWPORT,
            Env::new(true, SCALE),
        );
        rt.on_key = Some(cowork_desktop::views::shell::handle_key);
        rt.frame(0.0);
        let gpu = enable_gpu.then(|| GpuBenchContext::new(VIEWPORT, SCALE));
        let mut h = Self {
            rt,
            clock: 0.0,
            viewport: VIEWPORT,
            scale: SCALE,
            gpu,
            _temp_dir: temp_dir,
        };
        h.settle();
        // Warm up GPU pipelines / initial glyph atlas outside timed regions when `--gpu` is set.
        if h.gpu.is_some() {
            let _ = h.render_gpu();
        }
        h
    }

    fn set_viewport(&mut self, viewport: (f32, f32), scale: f32) {
        self.viewport = viewport;
        self.scale = scale;
        self.rt.set_viewport(viewport, scale);
    }

    /// One native-loop turn: `poll`, then the frame (commit only when something changed).
    fn frame(&mut self) -> bool {
        self.clock += DT;
        let now = self.clock;
        self.rt.update_if(|s, tx| perf_hooks::poll(s, now, tx));
        self.rt.frame(DT)
    }

    fn render_gpu(&mut self) -> Option<f64> {
        let vp = self.viewport;
        let scale = self.scale;
        self.gpu
            .as_mut()
            .map(|ctx| ctx.render_frame(&mut self.rt, vp, scale))
    }

    /// Runs frames until the runtime rests (bounded); returns how many ran.
    fn settle(&mut self) -> u32 {
        let mut frames = 0;
        while frames < SETTLE_CAP {
            frames += 1;
            if !self.frame() {
                break;
            }
        }
        frames
    }

    fn dispatch(&mut self, action: Action) {
        self.rt.update(move |s, _| s.dispatch(action));
    }

    fn commits(&self) -> u64 {
        self.rt.stats.commits
    }

    fn instances_len(&self) -> usize {
        self.rt.instances.len()
    }

    fn click_key(&mut self, key: &str) -> bool {
        if let Some((x, y)) = self.rt.find(key) {
            self.rt.pointer_move(x, y);
            self.rt.pointer_down(x, y);
            self.rt.pointer_up(x, y);
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
struct Samples {
    ms: Vec<f64>,
    gpu_ms: Vec<f64>,
    total_ms: Vec<f64>,
    commits: u64,
    /// Per step, the frames after it until the runtime rests: total ms and frame count.
    settle_ms: Vec<f64>,
    settle_frames: Vec<f64>,
}

impl Samples {
    fn time(&mut self, h: &mut Harness, f: impl FnOnce(&mut Harness)) {
        self.time_returning(h, f);
    }

    fn time_returning<T>(&mut self, h: &mut Harness, f: impl FnOnce(&mut Harness) -> T) -> T {
        let c0 = h.commits();
        let start = Instant::now();
        let out = f(h);
        let cpu_ms = start.elapsed().as_secs_f64() * 1000.0;
        self.ms.push(cpu_ms);
        self.commits += h.commits() - c0;
        if let Some(gpu_ms) = h.render_gpu() {
            self.gpu_ms.push(gpu_ms);
            self.total_ms.push(cpu_ms + gpu_ms);
        }
        out
    }

    /// Times `f`, then the motion and fill frames it leaves running until the window rests.
    fn time_settled(&mut self, h: &mut Harness, f: impl FnOnce(&mut Harness)) {
        self.time(h, f);
        let start = Instant::now();
        let frames = h.settle();
        self.settle_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        self.settle_frames.push(f64::from(frames));
    }
}

struct Report {
    name: &'static str,
    what: &'static str,
    samples: Samples,
    nodes: usize,
    instances: usize,
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

fn drop_stats(values: &[f64], budget_ms: f64) -> (u64, u64) {
    let mut total = 0u64;
    let mut cur_run = 0u64;
    let mut max_run = 0u64;
    for &v in values {
        if v > budget_ms {
            total += 1;
            cur_run += 1;
            if cur_run > max_run {
                max_run = cur_run;
            }
        } else {
            cur_run = 0;
        }
    }
    (total, max_run)
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// Puts the pointer over a thread's sidebar row and lets the hover settle (untimed).
fn hover_thread(h: &mut Harness, id: &str) {
    if let Some((x, y)) = h.rt.find(&format!("thread-{id}")) {
        h.rt.pointer_move(x, y);
        h.settle();
    }
}

/// Opens a thread as a user does, by clicking its sidebar row; dispatches the navigation when
/// the row isn't mounted. The step ends after the click's frame.
fn open_thread(h: &mut Harness, id: &str) {
    if !h.click_key(&format!("thread-{id}")) {
        h.dispatch(Action::Navigate(NavAction::OpenThread(id.to_string())));
    }
    h.frame();
    let active = h.rt.state.nav.current().active_thread_id.as_deref();
    assert_eq!(
        active,
        Some(id),
        "opening {id} took effect on the click's frame"
    );
}

/// Enqueues a WebSocket notification through the real production `StoreEvent` channel so
/// `Harness::frame()` drains it via `perf_hooks::poll -> AppState::drain_events()`, matching
/// the live app's batching and background-delta repaint suppression.
fn send_ws_notification(h: &Harness, method: &str, params: serde_json::Value) {
    let event = StoreEvent::WsNotification {
        workspace_id: PRIMARY_WS_ID.to_string(),
        method: method.to_string(),
        params,
    };
    let _ = h.rt.state.services.event_tx.send(event);
}

fn streamed_message_len(h: &Harness, tid: &str, item_id: &str) -> usize {
    let Some(rt) = h.rt.state.thread_runtime_by_id.get(tid) else {
        return 0;
    };
    let found = rt.feed.iter().rev().find_map(|item| match item {
        FeedItem::Message { id, content, .. } if id == item_id => Some(content.len()),
        _ => None,
    });
    found.unwrap_or(0)
}

fn focus_composer(h: &mut Harness) {
    let (x, y) = h.rt.find("composer-input").expect("composer-input mounted");
    h.rt.pointer_move(x, y);
    h.frame();
    h.rt.pointer_down(x, y);
    h.frame();
    h.rt.pointer_up(x, y);
    h.settle();
}

fn escape_xml_text(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn encode_png_slide_data_url(temp_dir: &Path, idx: usize, width: u32, height: u32) -> String {
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    let accent = [
        ((idx * 53 + 40) % 210) as u8,
        ((idx * 97 + 60) % 210) as u8,
        ((idx * 131 + 80) % 210) as u8,
    ];
    for y in 0..height {
        for x in 0..width {
            if y < 18 {
                rgba.extend_from_slice(&[accent[0], accent[1], accent[2], 255]);
            } else if x > 24 && x < width - 24 && y > 36 && y < height - 20 {
                let stripe = ((x / 16 + y / 16 + idx as u32) % 2) as u8 * 8;
                rgba.extend_from_slice(&[240 - stripe, 242 - stripe, 248 - stripe, 255]);
            } else {
                rgba.extend_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
    let file = temp_dir.join(format!("slide-{idx}.png"));
    write_png(&file, width, height, &rgba).expect("write slide png");
    let png_bytes = std::fs::read(&file).expect("read slide png");
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png_bytes)
    )
}

fn encode_svg_slide_data_url(slide_num: usize) -> String {
    let lines = [
        format!("Slide {slide_num}: Desktop Render Throughput & Latency Budget"),
        format!("• Target frame time: 8.33 ms @ 120 Hz / 16.67 ms @ 60 Hz (slide {slide_num})"),
        "• Incremental memoization across shell chrome, feed rows, and markdown blocks".to_string(),
        "• Off-thread image decode + URI-keyed GPU pixel cache prevents base64 stalls".to_string(),
        "• Filtered FSEvents watcher eliminates 40 ms explorer clone & canonicalize bursts"
            .to_string(),
        "• Zero idle commits and zero background spinner ticks on collapsed panes".to_string(),
    ];
    let tspans: String = lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let dy = if i == 0 { 0 } else { 42 };
            format!(
                r#"<tspan x="80" dy="{dy}">{}</tspan>"#,
                escape_xml_text(line)
            )
        })
        .collect();
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#ffffff"/><rect x="0" y="0" width="1600" height="28" fill="#2563eb"/><text x="80" y="72" font-family="Arial,sans-serif" font-size="24" fill="#666666">Deck Review · Slide {slide_num} of 20</text><text x="80" y="140" font-family="Arial,sans-serif" font-size="30" fill="#18181b">{tspans}</text></svg>"##
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
    )
}

fn build_500x20_csv() -> String {
    let mut csv = String::with_capacity(96_000);
    for c in 0..20 {
        if c > 0 {
            csv.push(',');
        }
        csv.push_str(&format!("Col_{c:02}"));
    }
    csv.push('\n');
    for r in 1..=500 {
        csv.push_str(&format!("Row-{r:04},Workspace-{}", r % WS_COUNT));
        for c in 2..20usize {
            if c.is_multiple_of(3) {
                csv.push_str(&format!(
                    ",\"{},{:03}.{:02}\"",
                    r + c,
                    (r * 17) % 1000,
                    c * 5
                ));
            } else if c % 3 == 1 {
                csv.push_str(&format!(",{:.2}%", (r % 97) as f64 + 0.25));
            } else {
                csv.push_str(&format!(",metric_{r}_{c}"));
            }
        }
        csv.push('\n');
    }
    csv
}

// ---------------------------------------------------------------------------------------------
// Original 8 Scenarios (Backward-Compatible Names)
// ---------------------------------------------------------------------------------------------

/// Opening a long thread from the new-chat landing: the commit that first builds it.
fn scenario_open_thread(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    for _ in 0..8 {
        h.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
        h.dispatch(Action::Navigate(NavAction::OpenNewChat {
            workspace_id: None,
        }));
        h.settle();
        hover_thread(&mut h, &thread_id(0));
        samples.time_settled(&mut h, |h| open_thread(h, &thread_id(0)));
    }
    Report {
        name: "open_thread",
        what: "landing -> long thread, first frame",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Switching between two long threads in the sidebar.
fn scenario_switch_thread(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for i in 0..16usize {
        let target = thread_id((i + 1) % 2);
        hover_thread(&mut h, &target);
        samples.time_settled(&mut h, |h| open_thread(h, &target));
    }
    Report {
        name: "switch_thread",
        what: "long thread <-> long thread, first frame",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Assistant text streaming into the open long thread: ~6 KB realistic markdown over 150 chunks.
fn scenario_streaming(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    let tid = thread_id(0);
    open_thread(&mut h, &tid);
    h.settle();
    send_ws_notification(
        &h,
        "turn/started",
        json!({ "threadId": tid, "turnId": "turn-perf" }),
    );
    h.settle();
    let body = build_long_streaming_markdown();
    let chunks = split_into_chunks(&body, 150);
    assert!(
        chunks.len() >= 140 && body.len() >= 5_500,
        "streaming fixture should cover ~6KB over ~150 chunks (got {} bytes, {} chunks)",
        body.len(),
        chunks.len()
    );
    for delta in chunks {
        samples.time(&mut h, |h| {
            send_ws_notification(
                h,
                "item/agentMessage/delta",
                json!({ "threadId": tid, "itemId": "a-stream", "delta": delta }),
            );
            h.frame();
        });
    }
    assert_eq!(
        streamed_message_len(&h, &tid, "a-stream"),
        body.len(),
        "streaming deltas should drain and apply via poll()"
    );
    Report {
        name: "streaming",
        what: "~6KB markdown delta -> frame (150 chunks)",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Typing into the composer of the open long thread: one key per frame.
fn scenario_typing(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    focus_composer(&mut h);
    for ch in "please profile the transcript and fix the lag".chars() {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    let typed = h.rt.state.composer_edit.text.len();
    assert!(typed > 10, "typing reached the composer ({typed} bytes)");
    Report {
        name: "typing",
        what: "composer keystroke -> frame",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Wheel-scrolling the long transcript up then down: one wheel event per frame.
fn scenario_scroll(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    let (x, y) = h.rt.find("chat-feed-scroll").expect("feed viewport");
    for i in 0..160 {
        let dy = if i < 80 { 120.0 } else { -120.0 };
        samples.time(&mut h, |h| {
            h.rt.wheel(x, y, dy);
            h.frame();
        });
    }
    Report {
        name: "scroll",
        what: "wheel -> frame over long transcript",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Opening Settings (Models with populated 12-provider / 84-model catalog) and going back.
fn scenario_settings(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for _ in 0..8 {
        samples.time_settled(&mut h, |h| {
            h.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
                SettingsPageId::Models,
            ))));
            h.frame();
        });
        samples.time_settled(&mut h, |h| open_thread(h, &thread_id(0)));
    }
    Report {
        name: "settings",
        what: "thread <-> settings (84 models), first frame",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// A live window resize with a long thread open: one width step per frame (1280 -> 1040 -> 1280).
fn scenario_resize(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for i in 0..60 {
        let w = if i < 30 {
            VIEWPORT.0 - i as f32 * 8.0
        } else {
            VIEWPORT.0 - (60 - i) as f32 * 8.0
        };
        samples.time(&mut h, |h| {
            h.set_viewport((w, VIEWPORT.1), SCALE);
            h.frame();
        });
    }
    Report {
        name: "resize",
        what: "viewport width step -> frame (1280..1040)",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// An untouched window with a long thread open: polls and frames should commit nothing.
fn scenario_idle(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for _ in 0..240 {
        samples.time(&mut h, |h| {
            h.frame();
        });
    }
    Report {
        name: "idle",
        what: "poll + frame, nothing changed",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

// ---------------------------------------------------------------------------------------------
// New Phase 2 Scenarios (Stutter, Animation, Overlay, Preview, and Background-Activity Guards)
// ---------------------------------------------------------------------------------------------

/// High-throughput streaming burst: 8 WS deltas delivered per display frame (240 deltas / 30 frames).
fn scenario_streaming_burst(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    let tid = thread_id(0);
    open_thread(&mut h, &tid);
    h.settle();
    send_ws_notification(
        &h,
        "turn/started",
        json!({ "threadId": tid, "turnId": "turn-burst" }),
    );
    h.settle();
    let body = build_long_streaming_markdown();
    let chunks = split_into_chunks(&body, 240);
    for burst in chunks.chunks(8) {
        samples.time(&mut h, |h| {
            for delta in burst {
                send_ws_notification(
                    h,
                    "item/agentMessage/delta",
                    json!({ "threadId": tid, "itemId": "a-burst", "delta": delta }),
                );
            }
            h.frame();
        });
    }
    assert_eq!(
        streamed_message_len(&h, &tid, "a-burst"),
        body.len(),
        "burst deltas should all drain and apply on their frame"
    );
    Report {
        name: "streaming_burst",
        what: "8 deltas coalesced/frame over ~6KB markdown",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Left sidebar collapse & expand animations with a long thread open: times every animation frame
/// until settled plus per-toggle settle time & frame count.
fn scenario_sidebar_toggle(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for _ in 0..6 {
        let toggle_start = Instant::now();
        let mut anim_frames = 0u32;
        let first_active = samples.time_returning(&mut h, |h| {
            h.dispatch(Action::Shell(ShellAction::ToggleSidebar));
            h.frame()
        });
        anim_frames += 1;
        if first_active {
            while anim_frames < SETTLE_CAP {
                let active = samples.time_returning(&mut h, |h| h.frame());
                anim_frames += 1;
                if !active {
                    break;
                }
            }
        }
        samples
            .settle_ms
            .push(toggle_start.elapsed().as_secs_f64() * 1000.0);
        samples.settle_frames.push(f64::from(anim_frames));
    }
    Report {
        name: "sidebar_toggle",
        what: "sidebar collapse/expand animation frames",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Right context-sidebar (inspector with 100-entry explorer tree) open & close animation frames.
fn scenario_inspector_toggle(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for _ in 0..6 {
        let toggle_start = Instant::now();
        let mut anim_frames = 0u32;
        let first_active = samples.time_returning(&mut h, |h| {
            h.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
            h.frame()
        });
        anim_frames += 1;
        if first_active {
            while anim_frames < SETTLE_CAP {
                let active = samples.time_returning(&mut h, |h| h.frame());
                anim_frames += 1;
                if !active {
                    break;
                }
            }
        }
        samples
            .settle_ms
            .push(toggle_start.elapsed().as_secs_f64() * 1000.0);
        samples.settle_frames.push(f64::from(anim_frames));
    }
    Report {
        name: "inspector_toggle",
        what: "context sidebar (100 files) open/close anim",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Continuous window resize crossing ALL adaptive breakpoints (1280 -> 920 -> 680 -> 920 -> 1280).
fn scenario_resize_breakpoints(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();
    // 60 steps down (1280 -> 680, -10px/step) + 60 steps up (680 -> 1280, +10px/step) = 120 steps.
    for i in 1..=120 {
        let w = if i <= 60 {
            1280.0 - i as f32 * 10.0
        } else {
            680.0 + (i - 60) as f32 * 10.0
        };
        samples.time(&mut h, |h| {
            h.set_viewport((w, VIEWPORT.1), SCALE);
            h.frame();
        });
    }
    Report {
        name: "resize_breakpoints",
        what: "resize 1280->920->680->1280 (commits/step)",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Active steer workflow: user types into the composer while assistant streams markdown deltas.
fn scenario_typing_while_streaming(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    let tid = thread_id(0);
    open_thread(&mut h, &tid);
    h.settle();
    focus_composer(&mut h);
    send_ws_notification(
        &h,
        "turn/started",
        json!({ "threadId": tid, "turnId": "turn-steer" }),
    );
    h.settle();

    let body = build_long_streaming_markdown();
    let chunks = split_into_chunks(&body, 60);
    let prompt: Vec<char> =
        "please focus on the layout text shaping cache and also check sidebar memoization"
            .chars()
            .collect();

    for (idx, delta) in chunks.into_iter().enumerate() {
        let ch = prompt[idx % prompt.len()];
        samples.time(&mut h, |h| {
            send_ws_notification(
                h,
                "item/agentMessage/delta",
                json!({ "threadId": tid, "itemId": "a-steer", "delta": delta }),
            );
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    assert_eq!(
        streamed_message_len(&h, &tid, "a-steer"),
        body.len(),
        "streaming deltas should drain during interleaved composer typing"
    );
    let typed = h.rt.state.composer_edit.text.len();
    assert!(typed > 10, "steer typing reached composer ({typed}B)");
    Report {
        name: "typing_while_streaming",
        what: "composer typing interleaved w/ live stream",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Full-history fling scroll: all 400 feed items visible + expanded activity group & diff card.
fn scenario_scroll_full_history(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (mut state, temp_dir) = fixture(items);
    let tid = thread_id(0);

    // Reveal the full transcript history (equivalent to clicking "Show older messages" to end).
    state
        .chat_ui
        .feed_visible_count_by_thread
        .insert(tid.clone(), items);

    // Expand one recent edit_file tool with a real parsed DiffState so DiffView is active in feed.
    let diff_tool_id = state.thread_runtime_by_id.get(&tid).and_then(|rt| {
        rt.feed.iter().rev().find_map(|item| match item {
            FeedItem::Tool {
                id,
                diff: Some(patch),
                ..
            } => Some((id.clone(), patch.clone())),
            _ => None,
        })
    });
    if let Some((tool_id, patch)) = diff_tool_id {
        if let Some(suffix) = tool_id.strip_prefix("t2-") {
            state
                .chat_ui
                .expanded_activity_groups
                .insert(format!("activity-r-{suffix}"), true);
        }
        state
            .chat_ui
            .expanded_tool_details
            .insert(tool_id.clone(), true);
        let parsed = diff::parse(&patch);
        if !parsed.is_empty() {
            state
                .chat_ui
                .tool_diff_states
                .insert(tool_id, DiffState::new(parsed));
        }
    }

    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &tid);
    h.settle();
    let (x, y) = h.rt.find("chat-feed-scroll").expect("feed viewport");
    for i in 0..160 {
        let dy = if i < 80 { 240.0 } else { -240.0 };
        samples.time(&mut h, |h| {
            h.rt.wheel(x, y, dy);
            h.frame();
        });
    }
    Report {
        name: "scroll_full_history",
        what: "400-item visible window + diff fling scroll",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Interactive overlays: `@` mention autocomplete, model picker combobox filter, command palette.
fn scenario_overlays(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (state, temp_dir) = fixture(items);
    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();

    // 1. `@` mention autocomplete typing in composer.
    focus_composer(&mut h);
    for ch in "@skill-1".chars() {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    samples.time(&mut h, |h| {
        h.rt.key(KeyEvent {
            key: Key::Escape,
            mods: Mods::default(),
        });
        h.frame();
    });

    // 2. Model picker combobox open, search filter across 84 models, navigate, close.
    samples.time(&mut h, |h| {
        assert!(
            h.click_key("composer-model-picker-button"),
            "composer-model-picker-button should be mounted"
        );
        h.frame();
    });
    if h.click_key("composer-model-search") {
        h.frame();
    }
    for ch in "claude".chars() {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    for key in [Key::Down, Key::Down, Key::Escape] {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key,
                mods: Mods::default(),
            });
            h.frame();
        });
    }

    // 3. Command palette open, query typing across actions + 60 threads + 6 workspaces, navigate, close.
    samples.time(&mut h, |h| {
        h.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(true)));
        h.frame();
    });
    // Click near the search input inside `command-palette-card` so Rune routes keys to it.
    if let Some(card_rect) =
        h.rt.elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("command-palette-card"))
            .map(|e| e.rect)
    {
        let ix = card_rect[0] + 120.0;
        let iy = card_rect[1] + 24.0;
        h.rt.pointer_move(ix, iy);
        h.rt.pointer_down(ix, iy);
        h.rt.pointer_up(ix, iy);
        h.frame();
    }
    for ch in "perf thread".chars() {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    for key in [Key::Down, Key::Down, Key::Escape] {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key,
                mods: Mods::default(),
            });
            h.frame();
        });
    }

    Report {
        name: "overlays",
        what: "@mention, model picker (84), cmd palette",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Heavy document & preview surfaces: 20 KB Canvas edit/preview, 500×20 Spreadsheet scroll,
/// and 20-slide base64 PNG/SVG Presentation Deck & Grid navigation.
fn scenario_canvas_and_previews(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (mut state, temp_dir) = fixture(items);
    let temp_root = temp_dir.path().to_path_buf();
    state.feature_flags.insert("canvas".to_string(), true);

    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();

    // 1. 20 KB Markdown Canvas: open Document preview, switch to Source, type 20 chars, back to Document.
    let canvas_doc = build_canvas_20kb_markdown();
    let canvas_path = temp_root
        .join("docs/perf-spec.md")
        .to_string_lossy()
        .into_owned();
    let now = wall_clock_epoch_secs();
    samples.time(&mut h, |h| {
        h.rt.update(move |s, _| {
            s.canvas_document = Some(CanvasDocumentSession {
                workspace_id: PRIMARY_WS_ID.to_string(),
                document_id: "canvas-perf-1".to_string(),
                generation: 1,
                path: canvas_path,
                disk_content: canvas_doc.clone(),
                draft_content: canvas_doc,
                edit_revision: 1,
                last_saved_edit_revision: 1,
                truncated: false,
                revision: Some(CanvasDocumentRevision {
                    modified_at_ms: now * 1000.0,
                    change_time_ms: now * 1000.0,
                    size: 20_480,
                    fingerprint: "perf-v1".to_string(),
                }),
                status: CanvasDocumentStatus::Ready,
                last_saved_at_secs: Some(now),
                dirty_since_secs: None,
                last_poll_secs: now + 60.0,
            });
            s.shell_ui.canvas_pane.set_open(true);
            s.chat_ui.canvas.active_tab = CanvasTab::Document;
        });
        h.frame();
    });
    h.settle();
    if let Some((cx, cy)) = h.rt.find("canvas-document-tab") {
        for _ in 0..8 {
            samples.time(&mut h, |h| {
                h.rt.wheel(cx, cy, -160.0);
                h.frame();
            });
        }
    }
    samples.time(&mut h, |h| {
        h.rt.update(|s, _| {
            s.chat_ui.canvas.active_tab = CanvasTab::Source;
            s.chat_ui.canvas.source_edit.focused = true;
        });
        h.frame();
    });
    if h.click_key("canvas-source-input") {
        h.frame();
    }
    for ch in "## Added perf notes!".chars() {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    samples.time(&mut h, |h| {
        h.rt.update(|s, _| {
            s.chat_ui.canvas.active_tab = CanvasTab::Document;
        });
        h.frame();
    });

    // Close Canvas cleanly before opening inline Spreadsheet & Presentation previews.
    h.rt.update(|s, _| {
        s.canvas_document = None;
        s.chat_ui.canvas.clear();
        s.context_sidebar.set_open(false);
    });
    h.settle();

    // 2. 500×20 Spreadsheet Preview: open & scroll 16 wheel steps.
    let csv = build_500x20_csv();
    let csv_path = temp_root
        .join("metrics_500x20.csv")
        .to_string_lossy()
        .into_owned();
    let spreadsheet = decode_spreadsheet_preview(Path::new(&csv_path), csv.as_bytes(), false)
        .expect("decode 500x20 csv fixture");
    samples.time(&mut h, |h| {
        h.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: PRIMARY_WS_ID.to_string(),
                path: csv_path,
                title: "metrics_500x20.csv".to_string(),
                content: Some(csv),
                spreadsheet: Some(spreadsheet),
                ..Default::default()
            },
        )));
        h.frame();
    });
    h.settle();
    if let Some((sx, sy)) =
        h.rt.find("spreadsheet-table-scroll-0")
            .or_else(|| h.rt.find("spreadsheet-preview-root"))
    {
        for i in 0..16usize {
            let dy = if i < 8 { -180.0 } else { 180.0 };
            samples.time(&mut h, |h| {
                h.rt.wheel(sx, sy, dy);
                h.frame();
            });
        }
    }

    // 3. 20-Slide Base64 PNG/SVG Presentation Preview: Deck navigation + Grid layout scroll.
    let slides: Vec<PresentationSlideData> = (0..20)
        .map(|idx| PresentationSlideData {
            slide_index: idx,
            slide_id: Some(format!("slide-{idx}")),
            title: Some(format!("Slide {}: Perf Review", idx + 1)),
            png_base64: if idx.is_multiple_of(2) {
                encode_png_slide_data_url(&temp_root, idx, 320, 180)
            } else {
                encode_svg_slide_data_url(idx + 1)
            },
        })
        .collect();
    let pres_path = temp_root
        .join("perf_deck.pptx")
        .to_string_lossy()
        .into_owned();
    samples.time(&mut h, |h| {
        h.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: PRIMARY_WS_ID.to_string(),
                path: pres_path,
                title: "perf_deck.pptx".to_string(),
                is_binary: true,
                presentation: Some(Box::new(PresentationPreviewData {
                    loading: false,
                    slides,
                    rendering_mode: Some("rendered".to_string()),
                    ..Default::default()
                })),
                ..Default::default()
            },
        )));
        h.frame();
    });
    h.settle();
    if h.click_key("pptx-preview-root") {
        h.frame();
    }
    for _ in 0..10 {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Right,
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    samples.time(&mut h, |h| {
        if !h.click_key("pptx-layout-grid") {
            h.rt.update(|s, _| {
                s.preview_ui
                    .set_presentation_layout(PresentationLayoutMode::Grid);
            });
        }
        h.frame();
    });
    if let Some((px, py)) = h.rt.find("pptx-preview-root") {
        for _ in 0..8 {
            samples.time(&mut h, |h| {
                h.rt.wheel(px, py, -160.0);
                h.frame();
            });
        }
    }

    Report {
        name: "canvas_and_previews",
        what: "20KB Canvas, 500x20 Sheet, 20-slide PPTX",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

/// Idle frame cost while a background thread is actively streaming and a Canvas document is open.
fn scenario_idle_with_bg_activity(items: usize, gpu: bool) -> Report {
    let mut samples = Samples::default();
    let (mut state, temp_dir) = fixture(items);
    let temp_root = temp_dir.path().to_path_buf();
    state.feature_flags.insert("canvas".to_string(), true);

    // Mark background thread (th-perf-2, NOT the active thread) as busy/streaming.
    if let Some(bg_rt) = state.thread_runtime_by_id.get_mut(&thread_id(2)) {
        bg_rt.streaming = true;
        bg_rt.active_turn_id = Some("turn-bg-busy".to_string());
    }

    // Open a clean 6 KB Canvas document in the right rail with timer polling active.
    let doc_text = build_long_streaming_markdown();
    let now = wall_clock_epoch_secs();
    state.canvas_document = Some(CanvasDocumentSession {
        workspace_id: PRIMARY_WS_ID.to_string(),
        document_id: "canvas-bg-1".to_string(),
        generation: 1,
        path: temp_root
            .join("docs/perf-spec.md")
            .to_string_lossy()
            .into_owned(),
        disk_content: doc_text.clone(),
        draft_content: doc_text,
        edit_revision: 1,
        last_saved_edit_revision: 1,
        truncated: false,
        revision: Some(CanvasDocumentRevision {
            modified_at_ms: now * 1000.0,
            change_time_ms: now * 1000.0,
            size: 6_144,
            fingerprint: "bg-v1".to_string(),
        }),
        status: CanvasDocumentStatus::Ready,
        last_saved_at_secs: Some(now),
        dirty_since_secs: None,
        last_poll_secs: 0.0,
    });
    state.shell_ui.canvas_pane.set_open(true);

    let mut h = Harness::new(state, temp_dir, gpu);
    open_thread(&mut h, &thread_id(0));
    h.settle();

    for i in 0..120usize {
        samples.time(&mut h, |h| {
            // Deliver occasional background-thread deltas every 15 frames to verify background
            // activity does not cause main-pane reflows or frame drops.
            if i.is_multiple_of(15) {
                send_ws_notification(
                    h,
                    "item/agentMessage/delta",
                    json!({
                        "threadId": thread_id(2),
                        "itemId": "bg-stream",
                        "delta": "background token "
                    }),
                );
            }
            h.frame();
        });
    }
    assert_eq!(
        streamed_message_len(&h, &thread_id(2), "bg-stream"),
        8 * "background token ".len(),
        "background deltas should drain into background thread state without repainting"
    );

    Report {
        name: "idle_with_bg_activity",
        what: "idle w/ bg streaming thread + open Canvas",
        nodes: h.rt.stats.layout_nodes,
        instances: h.instances_len(),
        samples,
    }
}

// ---------------------------------------------------------------------------------------------
// Scenario Registry & Budget Gates
// ---------------------------------------------------------------------------------------------

type Scenario = (&'static str, fn(usize, bool) -> Report);

const SCENARIOS: &[Scenario] = &[
    // Original 8 scenarios (exact names preserved for Phase 1 baseline comparison)
    ("open_thread", scenario_open_thread),
    ("switch_thread", scenario_switch_thread),
    ("streaming", scenario_streaming),
    ("typing", scenario_typing),
    ("scroll", scenario_scroll),
    ("settings", scenario_settings),
    ("resize", scenario_resize),
    ("idle", scenario_idle),
    // Phase 2 expanded real-world stutter & glitch guard scenarios
    ("streaming_burst", scenario_streaming_burst),
    ("sidebar_toggle", scenario_sidebar_toggle),
    ("inspector_toggle", scenario_inspector_toggle),
    ("resize_breakpoints", scenario_resize_breakpoints),
    ("typing_while_streaming", scenario_typing_while_streaming),
    ("scroll_full_history", scenario_scroll_full_history),
    ("overlays", scenario_overlays),
    ("canvas_and_previews", scenario_canvas_and_previews),
    ("idle_with_bg_activity", scenario_idle_with_bg_activity),
];

struct ScenarioSummary {
    name: &'static str,
    med: f64,
    p95: f64,
    max: f64,
    commits: u64,
    commits_per_step: f64,
    total_p95: Option<f64>,
    total_max: Option<f64>,
}

fn check_budgets(summaries: &[ScenarioSummary], gpu_enabled: bool) -> Vec<String> {
    let mut failures = Vec::new();
    for s in summaries {
        let eff_p95 = if gpu_enabled {
            s.total_p95.unwrap_or(s.p95)
        } else {
            s.p95
        };
        let eff_max = if gpu_enabled {
            s.total_max.unwrap_or(s.max)
        } else {
            s.max
        };
        let label = if gpu_enabled { "cpu+gpu" } else { "cpu" };

        match s.name {
            "idle" => {
                if s.commits != 0 {
                    failures.push(format!(
                        "idle: expected 0 commits, got {} (continuous idle repaint!)",
                        s.commits
                    ));
                }
                if eff_p95 > 2.0 {
                    failures.push(format!(
                        "idle: {label} p95 {eff_p95:.2}ms > 2.00ms idle budget"
                    ));
                }
            }
            "idle_with_bg_activity" => {
                if s.commits != 0 {
                    failures.push(format!(
                        "idle_with_bg_activity: expected 0 commits, got {} (bg delta caused repaint!)",
                        s.commits
                    ));
                }
                if s.p95 > 2.0 {
                    failures.push(format!(
                        "idle_with_bg_activity: cpu p95 {:.2}ms > 2.00ms idle budget",
                        s.p95
                    ));
                }
                if eff_p95 > BUDGET_120HZ_MS {
                    failures.push(format!(
                        "idle_with_bg_activity: {label} p95 {eff_p95:.2}ms > {BUDGET_120HZ_MS:.2}ms (120Hz)"
                    ));
                }
                if eff_max > BUDGET_60HZ_MS {
                    failures.push(format!(
                        "idle_with_bg_activity: {label} max {eff_max:.2}ms > {BUDGET_60HZ_MS:.2}ms (60Hz)"
                    ));
                }
            }
            "open_thread" | "switch_thread" | "settings" => {
                if s.med > BUDGET_120HZ_MS {
                    failures.push(format!(
                        "{}: cpu median {:.2}ms > {BUDGET_120HZ_MS:.2}ms (120Hz)",
                        s.name, s.med
                    ));
                }
                if eff_p95 > BUDGET_60HZ_MS {
                    failures.push(format!(
                        "{}: {label} p95 {eff_p95:.2}ms > {BUDGET_60HZ_MS:.2}ms (60Hz)",
                        s.name
                    ));
                }
            }
            "resize_breakpoints" => {
                if s.commits_per_step > 1.05 {
                    failures.push(format!(
                        "resize_breakpoints: {:.2} commits/step > 1.05 (on_layout double-commit jitter)",
                        s.commits_per_step
                    ));
                }
                if eff_p95 > BUDGET_120HZ_MS {
                    failures.push(format!(
                        "resize_breakpoints: {label} p95 {eff_p95:.2}ms > {BUDGET_120HZ_MS:.2}ms (120Hz)"
                    ));
                }
                if eff_max > BUDGET_60HZ_MS {
                    failures.push(format!(
                        "resize_breakpoints: {label} max {eff_max:.2}ms > {BUDGET_60HZ_MS:.2}ms (60Hz)"
                    ));
                }
            }
            _ => {
                if eff_p95 > BUDGET_120HZ_MS {
                    failures.push(format!(
                        "{}: {label} p95 {eff_p95:.2}ms > {BUDGET_120HZ_MS:.2}ms (120Hz)",
                        s.name
                    ));
                }
                if eff_max > BUDGET_60HZ_MS {
                    failures.push(format!(
                        "{}: {label} max {eff_max:.2}ms > {BUDGET_60HZ_MS:.2}ms (60Hz)",
                        s.name
                    ));
                }
            }
        }
    }
    failures
}

fn main() {
    let opts = parse_opts();
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "optimized"
    };
    let mode_tag = if opts.gpu { "CPU+GPU" } else { "CPU-only" };
    println!(
        "cowork-desktop ui_perf: {} feed items/long thread, {profile} build, {mode_tag}, {}x{} @{}x",
        opts.items, VIEWPORT.0, VIEWPORT.1, SCALE
    );
    if opts.gpu {
        println!(
            "{:<22} {:>5} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>8} {:>6}  what",
            "scenario",
            "steps",
            "median",
            "p95",
            "p99",
            "max",
            "gpu_med",
            "gpu_p95",
            "tot_p95",
            ">8.3m",
            ">16.7",
            "commits",
            "c/step",
            "nodes",
            "inst",
            "settle",
            "frames"
        );
    } else {
        println!(
            "{:<22} {:>5} {:>8} {:>8} {:>8} {:>8} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>8} {:>6}  what",
            "scenario",
            "steps",
            "median",
            "p95",
            "p99",
            "max",
            ">8.3m",
            ">16.7",
            "commits",
            "c/step",
            "nodes",
            "inst",
            "settle",
            "frames"
        );
    }

    let mut json_rows = Vec::new();
    let mut summaries = Vec::new();

    for (name, run) in SCENARIOS {
        if !opts.filter.is_empty() && !opts.filter.iter().any(|f| name.contains(f.as_str())) {
            continue;
        }
        let report = run(opts.items, opts.gpu);
        let steps = report.samples.ms.len();
        let mut sorted = report.samples.ms.clone();
        sorted.sort_by(f64::total_cmp);
        let (med, p95, p99, max) = (
            pct(&sorted, 0.50),
            pct(&sorted, 0.95),
            pct(&sorted, 0.99),
            sorted.last().copied().unwrap_or(0.0),
        );
        let (over_120, max_consec_120) = drop_stats(&report.samples.ms, BUDGET_120HZ_MS);
        let (over_60, max_consec_60) = drop_stats(&report.samples.ms, BUDGET_60HZ_MS);
        let commits_per_step = if steps > 0 {
            report.samples.commits as f64 / steps as f64
        } else {
            0.0
        };

        let median_of = |v: &[f64]| {
            let mut v = v.to_vec();
            v.sort_by(f64::total_cmp);
            pct(&v, 0.5)
        };
        let settled = !report.samples.settle_ms.is_empty();
        let (settle_ms, settle_frames) = (
            median_of(&report.samples.settle_ms),
            median_of(&report.samples.settle_frames),
        );
        let (settle_col, frames_col) = if settled {
            (format!("{settle_ms:.1}ms"), format!("{settle_frames:.0}"))
        } else {
            ("-".to_string(), "-".to_string())
        };

        let (gpu_stats, total_stats) = if opts.gpu && !report.samples.gpu_ms.is_empty() {
            let mut g_sorted = report.samples.gpu_ms.clone();
            g_sorted.sort_by(f64::total_cmp);
            let mut t_sorted = report.samples.total_ms.clone();
            t_sorted.sort_by(f64::total_cmp);
            let (t_over_120, t_consec_120) = drop_stats(&report.samples.total_ms, BUDGET_120HZ_MS);
            let (t_over_60, t_consec_60) = drop_stats(&report.samples.total_ms, BUDGET_60HZ_MS);
            (
                Some((
                    pct(&g_sorted, 0.50),
                    pct(&g_sorted, 0.95),
                    pct(&g_sorted, 0.99),
                    g_sorted.last().copied().unwrap_or(0.0),
                )),
                Some((
                    pct(&t_sorted, 0.95),
                    t_sorted.last().copied().unwrap_or(0.0),
                    t_over_120,
                    t_over_60,
                    t_consec_120,
                    t_consec_60,
                )),
            )
        } else {
            (None, None)
        };

        if let (Some((g_med, g_p95, _, _)), Some((t_p95, _, t_over_120, t_over_60, _, _))) =
            (gpu_stats, total_stats)
        {
            println!(
                "{:<22} {:>5} {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6} {:>6} {:>7} {:>6.2} {:>6} {:>6} {:>8} {:>6}  {}",
                report.name,
                steps,
                med,
                p95,
                p99,
                max,
                g_med,
                g_p95,
                t_p95,
                t_over_120,
                t_over_60,
                report.samples.commits,
                commits_per_step,
                report.nodes,
                report.instances,
                settle_col,
                frames_col,
                report.what
            );
        } else {
            println!(
                "{:<22} {:>5} {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6.2}ms {:>6} {:>6} {:>7} {:>6.2} {:>6} {:>6} {:>8} {:>6}  {}",
                report.name,
                steps,
                med,
                p95,
                p99,
                max,
                over_120,
                over_60,
                report.samples.commits,
                commits_per_step,
                report.nodes,
                report.instances,
                settle_col,
                frames_col,
                report.what
            );
        }

        let mut row = json!({
            "scenario": report.name,
            "steps": steps,
            "median_ms": med,
            "p95_ms": p95,
            "p99_ms": p99,
            "max_ms": max,
            "over_8_33ms": over_120,
            "over_16_67ms": over_60,
            "max_consec_over_8_33ms": max_consec_120,
            "max_consec_over_16_67ms": max_consec_60,
            "commits": report.samples.commits,
            "commits_per_step": commits_per_step,
            "layout_nodes": report.nodes,
            "instances": report.instances,
        });
        if settled {
            row["settle_median_ms"] = json!(settle_ms);
            row["settle_median_frames"] = json!(settle_frames);
        }
        if let (
            Some((g_med, g_p95, g_p99, g_max)),
            Some((t_p95, t_max, t_over_120, t_over_60, t_consec_120, t_consec_60)),
        ) = (gpu_stats, total_stats)
        {
            row["gpu_median_ms"] = json!(g_med);
            row["gpu_p95_ms"] = json!(g_p95);
            row["gpu_p99_ms"] = json!(g_p99);
            row["gpu_max_ms"] = json!(g_max);
            row["total_p95_ms"] = json!(t_p95);
            row["total_max_ms"] = json!(t_max);
            row["total_over_8_33ms"] = json!(t_over_120);
            row["total_over_16_67ms"] = json!(t_over_60);
            row["total_max_consec_over_8_33ms"] = json!(t_consec_120);
            row["total_max_consec_over_16_67ms"] = json!(t_consec_60);
        }
        json_rows.push(row);

        summaries.push(ScenarioSummary {
            name: report.name,
            med,
            p95,
            max,
            commits: report.samples.commits,
            commits_per_step,
            total_p95: total_stats.map(|t| t.0),
            total_max: total_stats.map(|t| t.1),
        });
    }

    if let Some(path) = opts.json {
        let body = json!({
            "items": opts.items,
            "profile": profile,
            "gpu": opts.gpu,
            "results": json_rows
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&body).expect("json"))
            .expect("write --json output");
        println!("wrote {path}");
    }

    if opts.check {
        let failures = check_budgets(&summaries, opts.gpu);
        if failures.is_empty() {
            println!(
                "ui_perf --check: PASS ({} scenarios within 60/120Hz budgets)",
                summaries.len()
            );
        } else {
            eprintln!(
                "ui_perf --check: FAIL ({} budget violations):",
                failures.len()
            );
            for f in &failures {
                eprintln!("  - {f}");
            }
            std::process::exit(1);
        }
    }
}
