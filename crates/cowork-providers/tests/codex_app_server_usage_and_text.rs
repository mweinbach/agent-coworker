//! Codex app-server turn usage scoping (`parseUsage` + per-turn delta of the thread-cumulative
//! `tokenUsage.total`) and assistant-text assembly (commentary streamed live but excluded from the
//! persisted answer, remaining items joined with `\n`), driven by mocked notification sequences.

use std::collections::HashMap;
use std::path::PathBuf;

use cowork_inference::{
    CanonicalMessage, ContentBlock, MediaKind, MediaSource, MessageRole, ProviderOpaqueMeta,
    RequestPolicy, StepBudget, StreamEvent, TextPhase, TurnUsage,
};
use cowork_providers::codex_app_server::{
    CodexAppServerTransport, CodexTurnUsageTracker, codex_steer_input, parse_codex_usage,
};
use cowork_providers::{ProviderStepRequest, ProviderStepResult, ProviderTransport};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Mock app-server. `behavior`:
/// - `multi`: commentary item + two final items over two model requests (fresh thread), with a
///   duplicated usage report and a report for another turn; `turn/completed` lists the items.
/// - `multi_no_items`: same stream, but `turn/completed` carries no items (router fallback).
/// - `resumed`: a turn on a thread whose running total already includes earlier turns.
const USAGE_TEXT_MOCK: &str = r#"
import readline from "node:readline";

const [, , behavior] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const threadId = "thr-1";
const turnId = "turn-1";
const note = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const usage = (total, last, extra = {}) =>
  note("thread/tokenUsage/updated", { tokenUsage: { total, last, modelContextWindow: 272000 }, ...extra });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: turnId } } });
    if (behavior === "resumed") {
      note("item/agentMessage/delta", { itemId: "f1", delta: "Done." });
      usage(
        { totalTokens: 1160, inputTokens: 1100, cachedInputTokens: 800, outputTokens: 60, reasoningOutputTokens: 20 },
        { totalTokens: 110, inputTokens: 100, cachedInputTokens: 70, outputTokens: 10, reasoningOutputTokens: 4 },
      );
      usage(
        { totalTokens: 1380, inputTokens: 1300, cachedInputTokens: 950, outputTokens: 80, reasoningOutputTokens: 27 },
        { totalTokens: 220, inputTokens: 200, cachedInputTokens: 150, outputTokens: 20, reasoningOutputTokens: 7 },
      );
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      return;
    }
    // Model request 1: commentary preamble before a tool call.
    note("item/started", { item: { type: "agentMessage", id: "c1", text: "", phase: "commentary" } });
    note("item/agentMessage/delta", { itemId: "c1", delta: "I'll inspect the repo." });
    note("item/completed", { item: { type: "agentMessage", id: "c1", text: "I'll inspect the repo.", phase: "commentary" } });
    const first = { totalTokens: 110, inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 4 };
    usage(first, first);
    // A repeated report of an unchanged running total must not be counted twice.
    usage(first, first);
    // Model request 2: the final answer, split over two items (phase only on item/started).
    note("item/started", { item: { type: "agentMessage", id: "f1", text: "", phase: "final_answer" } });
    note("item/agentMessage/delta", { itemId: "f1", delta: "Here is " });
    note("item/agentMessage/delta", { itemId: "f1", delta: "the fix." });
    note("item/completed", { item: { type: "agentMessage", id: "f1", text: "Here is the fix.", phase: "final_answer" } });
    note("item/agentMessage/delta", { itemId: "f2", delta: "Second paragraph." });
    usage(
      { totalTokens: 280, inputTokens: 250, cachedInputTokens: 140, outputTokens: 30, reasoningOutputTokens: 9 },
      { totalTokens: 170, inputTokens: 150, cachedInputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5 },
    );
    // Another turn's report on the same connection is ignored.
    usage(
      { totalTokens: 9999, inputTokens: 9000, outputTokens: 999 },
      { totalTokens: 9999, inputTokens: 9000, outputTokens: 999 },
      { turnId: "turn-other" },
    );
    const items = behavior === "multi_no_items" ? undefined : [
      { type: "agentMessage", id: "c1", text: "I'll inspect the repo.", phase: "commentary" },
      { type: "agentMessage", id: "f1", text: "Here is the fix.", phase: "final_answer" },
      { type: "agentMessage", id: "f2", text: "Second paragraph.", phase: null },
    ];
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items } } });
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, result: {} });
  }
});
"#;

struct Fixture {
    base: PathBuf,
    script: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("cowork-codex-usage-text-{}", Uuid::new_v4()));
        std::fs::create_dir_all(base.join("workspace")).unwrap();
        std::fs::create_dir_all(base.join("home/.cowork")).unwrap();
        let base = std::fs::canonicalize(&base).unwrap();
        let script = base.join("mock_codex_usage_text.mjs");
        std::fs::write(&script, USAGE_TEXT_MOCK).unwrap();
        Self { base, script }
    }

    async fn run(&self, behavior: &str) -> (ProviderStepResult, Vec<StreamEvent>) {
        let mut opts = Map::new();
        opts.insert(
            "cwd".into(),
            json!(self.base.join("workspace").to_string_lossy()),
        );
        opts.insert(
            "coworkHome".into(),
            json!(self.base.join("home/.cowork").to_string_lossy()),
        );
        let mut env = HashMap::new();
        env.insert(
            "PATH".into(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        );
        env.insert(
            "HOME".into(),
            self.base.join("home").to_string_lossy().into(),
        );
        let mut transport = CodexAppServerTransport::with_command_override(
            "node".into(),
            vec![self.script.to_string_lossy().into_owned(), behavior.into()],
        );
        transport.env_override = Some(env);
        let mut events = Vec::new();
        let result = transport
            .stream_step(
                ProviderStepRequest {
                    model_id: "gpt-5.6-sol".into(),
                    base_url: None,
                    api_key: None,
                    extra_headers: HashMap::new(),
                    system_prompt: "Instructions".into(),
                    messages: vec![user_message("fix the bug")],
                    tools: Vec::new(),
                    authorized_tool_names: None,
                    provider_options: opts,
                    continuation: None,
                    policy: RequestPolicy::default(),
                    turn_id: "turn-usage-text".into(),
                },
                &StepBudget::new(60_000, None),
                &mut |ev| events.push(ev),
            )
            .await
            .expect("codex turn succeeds");
        (result, events)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn user_message(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: "u1".into(),
        role: MessageRole::User,
        content: vec![text_block(text)],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".into(),
    }
}

fn text_block(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.into(),
        phase: None,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn texts(message: &CanonicalMessage) -> Vec<(String, Option<TextPhase>)> {
    message
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, phase, .. } => Some((text.clone(), *phase)),
            _ => None,
        })
        .collect()
}

fn usage(prompt: u64, completion: u64, total: u64, cached: u64, reasoning: u64) -> TurnUsage {
    TurnUsage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
        cached_prompt_tokens: Some(cached),
        cache_write_prompt_tokens: None,
        reasoning_output_tokens: Some(reasoning),
        estimated_cost_usd: None,
    }
}

#[tokio::test]
async fn multi_request_turn_reports_whole_turn_usage_with_cache_and_reasoning_tokens() {
    let fx = Fixture::new();
    let (result, _) = fx.run("multi").await;
    // Both model requests (not just the last one), each running-total report counted once,
    // another turn's report ignored, cached + reasoning tokens mapped.
    assert_eq!(result.usage, usage(250, 30, 280, 140, 9));
}

#[tokio::test]
async fn resumed_thread_turn_usage_excludes_earlier_turns_in_the_running_total() {
    let fx = Fixture::new();
    let (result, _) = fx.run("resumed").await;
    // Running total 1380 minus the pre-turn total (1160 - 110 = 1050) = this turn's two requests.
    assert_eq!(result.usage, usage(300, 30, 330, 220, 11));
    assert_eq!(texts(&result.assistant), vec![("Done.".into(), None)]);
}

#[tokio::test]
async fn commentary_streams_live_but_final_text_joins_only_answer_items_with_newlines() {
    for behavior in ["multi", "multi_no_items"] {
        let fx = Fixture::new();
        let (result, events) = fx.run(behavior).await;

        let expected = "Here is the fix.\nSecond paragraph.".to_string();
        assert_eq!(
            texts(&result.assistant),
            vec![(expected.clone(), None)],
            "{behavior}"
        );
        let persisted = result.persisted_assistant.as_ref().expect("persisted");
        assert_eq!(texts(persisted), vec![(expected, None)], "{behavior}");

        // Live stream: one block per item, commentary included and tagged with its phase.
        let starts: Vec<(usize, Option<TextPhase>)> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextStart {
                    block_index, phase, ..
                } => Some((*block_index, *phase)),
                _ => None,
            })
            .collect();
        assert_eq!(
            starts,
            vec![
                (0, Some(TextPhase::Commentary)),
                (1, Some(TextPhase::FinalAnswer)),
                (2, None),
            ],
            "{behavior}"
        );
        let ends: Vec<(usize, String, Option<TextPhase>)> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextEnd {
                    block_index,
                    text,
                    phase,
                    ..
                } => Some((*block_index, text.clone(), *phase)),
                _ => None,
            })
            .collect();
        assert_eq!(
            ends,
            vec![
                (
                    0,
                    "I'll inspect the repo.".into(),
                    Some(TextPhase::Commentary)
                ),
                (1, "Here is the fix.".into(), Some(TextPhase::FinalAnswer)),
                (2, "Second paragraph.".into(), None),
            ],
            "{behavior}"
        );
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::TextDelta { block_index: 0, delta, phase: Some(TextPhase::Commentary), .. }
                if delta == "I'll inspect the repo."
        )));
    }
}

#[test]
fn parse_codex_usage_matches_legacy_parse_usage() {
    // OpenAI-style snake_case with nested details.
    let openai = json!({
        "total": {
            "total_tokens": 33,
            "input_tokens": 20,
            "input_tokens_details": { "cached_tokens": 6, "cache_creation_tokens": 4 },
            "output_tokens": 13,
            "output_tokens_details": { "reasoning_tokens": 5 },
        },
        "last": { "total_tokens": 1, "input_tokens": 1 },
    });
    assert_eq!(
        parse_codex_usage(&openai),
        Some(TurnUsage {
            prompt_tokens: 20,
            completion_tokens: 13,
            total_tokens: 33,
            cached_prompt_tokens: Some(6),
            cache_write_prompt_tokens: Some(4),
            reasoning_output_tokens: Some(5),
            estimated_cost_usd: None,
        })
    );
    // `total` preferred over `last`; `last` used when `total` is absent.
    let cumulative = json!({
        "total": { "totalTokens": 3476387, "inputTokens": 3455915, "cachedInputTokens": 2987776, "outputTokens": 20472, "reasoningOutputTokens": 5929 },
        "last": { "totalTokens": 182780, "inputTokens": 182693, "cachedInputTokens": 173952, "outputTokens": 87, "reasoningOutputTokens": 0 },
    });
    assert_eq!(
        parse_codex_usage(&cumulative),
        Some(usage(3455915, 20472, 3476387, 2987776, 5929))
    );
    assert_eq!(
        parse_codex_usage(&json!({ "last": { "inputTokens": 7, "outputTokens": 3 } })).map(|u| (
            u.prompt_tokens,
            u.completion_tokens,
            u.total_tokens
        )),
        Some((7, 3, 10))
    );
    // Completion derived from total when output is missing; all-zero reports are dropped.
    assert_eq!(
        parse_codex_usage(&json!({ "total": { "inputTokens": 7, "totalTokens": 12 } }))
            .map(|u| u.completion_tokens),
        Some(5)
    );
    assert_eq!(
        parse_codex_usage(&json!({ "total": { "inputTokens": 0 } })),
        None
    );
    assert_eq!(parse_codex_usage(&json!({})), None);

    // A single report on a long-running thread is scoped to this turn's request.
    let mut tracker = CodexTurnUsageTracker::new();
    tracker.record(&cumulative);
    assert_eq!(tracker.usage(), Some(usage(182693, 87, 182780, 173952, 0)));
}

#[test]
fn steer_input_forwards_reference_context_text_and_images() {
    let content = vec![
        text_block("Reference context for this steer:\n\nSKILL BODY"),
        text_block("Look at this screenshot"),
        ContentBlock::Media {
            kind: MediaKind::Image,
            source: MediaSource::Base64 {
                mime_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
            provider_meta: ProviderOpaqueMeta::default(),
        },
        ContentBlock::Media {
            kind: MediaKind::Image,
            source: MediaSource::FileRef {
                path: "/tmp/shot.png".into(),
                mime_type: Some("image/png".into()),
            },
            provider_meta: ProviderOpaqueMeta::default(),
        },
    ];
    let input = codex_steer_input("Look at this screenshot", &content).expect("deliverable");
    assert_eq!(
        input,
        vec![
            json!({
                "type": "text",
                "text": "Reference context for this steer:\n\nSKILL BODY\nLook at this screenshot",
                "text_elements": [],
            }),
            json!({ "type": "image", "url": "data:image/png;base64,iVBORw0KGgo=" }),
            json!({ "type": "localImage", "path": "/tmp/shot.png" }),
        ]
    );

    // Plain steers keep the single text item.
    assert_eq!(
        codex_steer_input("focus", &[]),
        Some(vec![
            json!({ "type": "text", "text": "focus", "text_elements": [] })
        ])
    );

    // Inline non-image data cannot be delivered natively.
    let pdf = vec![
        text_block("see attached"),
        ContentBlock::Media {
            kind: MediaKind::Document,
            source: MediaSource::Base64 {
                mime_type: "application/pdf".into(),
                data: "JVBERi0=".into(),
            },
            provider_meta: ProviderOpaqueMeta::default(),
        },
    ];
    assert_eq!(codex_steer_input("see attached", &pdf), None::<Vec<Value>>);
}
