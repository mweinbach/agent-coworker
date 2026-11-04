//! `item/started` for an `agentMessage` waits for visible text (`conversationProjection*.ts`
//! starts the assistant item on its first text delta, never on `text-start`), so a text block
//! that ends empty or whitespace-only leaves no orphaned assistant bubble. Native citations on
//! `TextEnd` (Anthropic `citations_delta`) surface as annotations when no raw annotations exist.

use cowork_inference::{
    Citation, ClientCapabilities, ProjectedNotification, StreamEvent, StreamEventProjector,
};
use serde_json::{Map, Value, json};

const TURN: &str = "turn-1";

fn project(events: Vec<StreamEvent>) -> Vec<ProjectedNotification> {
    let mut projector = StreamEventProjector::new("thread_1", ClientCapabilities::default());
    events.iter().flat_map(|ev| projector.project(ev)).collect()
}

fn text_start(block_index: usize) -> StreamEvent {
    StreamEvent::TextStart {
        turn_id: TURN.into(),
        block_index,
        phase: None,
    }
}

fn text_delta(block_index: usize, delta: &str) -> StreamEvent {
    StreamEvent::TextDelta {
        turn_id: TURN.into(),
        block_index,
        delta: delta.into(),
        phase: None,
    }
}

fn text_end(block_index: usize, text: &str, citations: Vec<Citation>) -> StreamEvent {
    StreamEvent::TextEnd {
        turn_id: TURN.into(),
        block_index,
        text: text.into(),
        phase: None,
        citations,
        annotations: Vec::new(),
    }
}

fn agent_items(out: &[ProjectedNotification], method: &str) -> Vec<Value> {
    out.iter()
        .filter(|n| n.method == method && n.params["item"]["type"] == "agentMessage")
        .map(|n| n.params["item"].clone())
        .collect()
}

#[test]
fn whitespace_only_text_block_before_a_tool_call_emits_no_assistant_item() {
    let out = project(vec![
        text_start(0),
        text_delta(0, "\n\n"),
        text_end(0, "\n\n", Vec::new()),
        StreamEvent::ToolCallStart {
            turn_id: TURN.into(),
            key: "call_1".into(),
            name: "bash".into(),
            initial_args: None,
        },
        StreamEvent::ToolCallEnd {
            turn_id: TURN.into(),
            key: "call_1".into(),
            name: "bash".into(),
            arguments: Some(Map::new()),
            retry_of: None,
            input_digest: None,
        },
        text_start(1),
        text_delta(1, "Done."),
        text_end(1, "Done.", Vec::new()),
    ]);
    let started = agent_items(&out, "item/started");
    let completed = agent_items(&out, "item/completed");
    assert_eq!(started.len(), 1, "{out:#?}");
    assert_eq!(completed.len(), 1, "{out:#?}");
    // The whitespace-only delta still consumes an occurrence (TS `ensureActiveAssistantState`
    // runs for any non-empty delta), but is never started.
    assert_eq!(started[0]["id"], "agentMessage:turn-1:2");
    assert_eq!(completed[0]["id"], "agentMessage:turn-1:2");
    assert_eq!(completed[0]["text"], "Done.");
    assert!(
        !out.iter()
            .any(|n| n.method == "item/agentMessage/delta" && n.params["delta"] == "\n\n"),
        "whitespace-only deltas are not streamed on their own"
    );
}

#[test]
fn text_start_alone_does_not_start_an_assistant_item() {
    // e.g. the stream is interrupted right after `TextStart`.
    let out = project(vec![text_start(0)]);
    assert!(agent_items(&out, "item/started").is_empty(), "{out:#?}");
    assert!(!text_start(0).is_visible_output());
    assert!(!text_delta(0, " \n").is_visible_output());
    assert!(text_delta(0, "Hi").is_visible_output());
}

#[test]
fn buffered_leading_whitespace_is_flushed_with_the_first_visible_delta() {
    let out = project(vec![
        text_start(0),
        text_delta(0, "\n"),
        text_delta(0, "Hello"),
        text_delta(0, " world"),
        text_end(0, "\nHello world", Vec::new()),
    ]);
    let started_at = out
        .iter()
        .position(|n| n.method == "item/started")
        .expect("item started");
    let deltas: Vec<&Value> = out
        .iter()
        .filter(|n| n.method == "item/agentMessage/delta")
        .map(|n| &n.params["delta"])
        .collect();
    assert_eq!(deltas, [&json!("\nHello"), &json!(" world")]);
    let first_delta_at = out
        .iter()
        .position(|n| n.method == "item/agentMessage/delta")
        .unwrap();
    assert!(started_at < first_delta_at);
}

#[test]
fn text_end_citations_project_as_annotations_when_none_are_given() {
    let citation = Citation {
        url: "https://docs.rs/tokio".into(),
        title: Some("tokio docs".into()),
        cited_text: Some("A runtime for async Rust".into()),
        start_index: None,
        end_index: None,
        source_type: Some("web_search_result_location".into()),
        provider_meta: Map::new(),
    };
    let out = project(vec![
        text_start(0),
        text_delta(0, "Tokio is a runtime."),
        text_end(0, "Tokio is a runtime.", vec![citation]),
    ]);
    let completed = agent_items(&out, "item/completed");
    assert_eq!(
        completed[0]["annotations"],
        json!([{
            "type": "url_citation",
            "url": "https://docs.rs/tokio",
            "title": "tokio docs",
            "cited_text": "A runtime for async Rust"
        }])
    );

    // Raw provider annotations still win when present.
    let raw = json!({"type": "url_citation", "url": "https://openai.com", "start_index": 0, "end_index": 5});
    let out = project(vec![
        text_delta(0, "Hello"),
        StreamEvent::TextEnd {
            turn_id: TURN.into(),
            block_index: 0,
            text: "Hello".into(),
            phase: None,
            citations: vec![Citation {
                url: "https://other.example".into(),
                title: None,
                cited_text: None,
                start_index: None,
                end_index: None,
                source_type: None,
                provider_meta: Map::new(),
            }],
            annotations: vec![raw.clone()],
        },
    ]);
    assert_eq!(
        agent_items(&out, "item/completed")[0]["annotations"],
        json!([raw])
    );
}
