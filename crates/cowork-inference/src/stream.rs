use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ast::{Citation, TextPhase};
use crate::cost_tracker::TurnUsage;

/// Reasoning projection mode (`reasoning` raw tokens vs `summary`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningStreamMode {
    Reasoning,
    Summary,
}

impl ReasoningStreamMode {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Reasoning => "reasoning",
            Self::Summary => "summary",
        }
    }
}

/// Unified streaming event emitted by provider transports and turn runners, consumed by
/// `StreamEventProjector` and reliability middleware.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    TurnStarted {
        turn_id: String,
    },
    UserMessage {
        turn_id: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_message_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        steer_request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        annotations: Vec<Value>,
    },
    TextStart {
        turn_id: String,
        block_index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<TextPhase>,
    },
    TextDelta {
        turn_id: String,
        block_index: usize,
        delta: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<TextPhase>,
    },
    TextEnd {
        turn_id: String,
        block_index: usize,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<TextPhase>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        citations: Vec<Citation>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        annotations: Vec<Value>,
    },
    ThinkingStart {
        turn_id: String,
        stream_id: String,
        mode: ReasoningStreamMode,
    },
    ThinkingDelta {
        turn_id: String,
        stream_id: String,
        mode: ReasoningStreamMode,
        delta: String,
    },
    ThinkingEnd {
        turn_id: String,
        stream_id: String,
        mode: ReasoningStreamMode,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(default)]
        redacted: bool,
    },
    ToolCallStart {
        turn_id: String,
        key: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_args: Option<Map<String, Value>>,
    },
    ToolCallDelta {
        turn_id: String,
        key: String,
        name: String,
        delta: String,
    },
    ToolCallEnd {
        turn_id: String,
        key: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<Map<String, Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_of: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        input_digest: Option<Value>,
    },
    ToolApprovalRequested {
        turn_id: String,
        key: String,
        name: String,
        approval: Value,
    },
    ToolResult {
        turn_id: String,
        key: String,
        name: String,
        result: Value,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        denied: bool,
    },
    TurnCompleted {
        turn_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<TurnUsage>,
    },
    Error {
        turn_id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

impl StreamEvent {
    /// Returns `true` when this event surfaces visible assistant text, reasoning, or tool activity
    /// to connected clients. Once `true`, pre-output retry middleware MUST NOT restart the call.
    pub fn is_visible_output(&self) -> bool {
        matches!(
            self,
            Self::TextStart { .. }
                | Self::TextDelta { .. }
                | Self::TextEnd { .. }
                | Self::ThinkingStart { .. }
                | Self::ThinkingDelta { .. }
                | Self::ThinkingEnd { .. }
                | Self::ToolCallStart { .. }
                | Self::ToolCallDelta { .. }
                | Self::ToolCallEnd { .. }
                | Self::ToolApprovalRequested { .. }
                | Self::ToolResult { .. }
        )
    }
}
