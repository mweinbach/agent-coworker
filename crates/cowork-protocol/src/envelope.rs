use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error_codes;

/// JSON-RPC-lite request/response correlation identifier (string or finite integer).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum JsonRpcLiteId {
    String(String),
    Number(i64),
}

impl From<&str> for JsonRpcLiteId {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<String> for JsonRpcLiteId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<i64> for JsonRpcLiteId {
    fn from(value: i64) -> Self {
        Self::Number(value)
    }
}

/// JSON-RPC-lite error payload (`code`, `message`, optional `data`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcLiteError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcLiteError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i32, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }
}

/// JSON-RPC-lite request frame (`"jsonrpc": "2.0"` omitted on wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JsonRpcLiteRequest {
    pub id: JsonRpcLiteId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// JSON-RPC-lite notification frame (`"jsonrpc": "2.0"` omitted on wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JsonRpcLiteNotification {
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// JSON-RPC-lite response sent by a client in reply to a server-initiated request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JsonRpcLiteClientResponse {
    pub id: JsonRpcLiteId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcLiteError>,
}

/// Validated inbound client message over `/ws` or `/rpc`.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonRpcLiteClientMessage {
    Request(JsonRpcLiteRequest),
    Notification(JsonRpcLiteNotification),
    ClientResponse(JsonRpcLiteClientResponse),
}

/// Outbound JSON-RPC-lite response (`result` or `error`, never `"jsonrpc": "2.0"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum JsonRpcLiteResponse {
    Success {
        id: JsonRpcLiteId,
        result: Value,
    },
    Error {
        id: Option<JsonRpcLiteId>,
        error: JsonRpcLiteError,
    },
}

impl JsonRpcLiteResponse {
    pub fn success(id: JsonRpcLiteId, result: Value) -> Self {
        Self::Success { id, result }
    }

    pub fn error(id: Option<JsonRpcLiteId>, error: JsonRpcLiteError) -> Self {
        Self::Error { id, error }
    }

    pub fn id(&self) -> Option<&JsonRpcLiteId> {
        match self {
            Self::Success { id, .. } => Some(id),
            Self::Error { id, .. } => id.as_ref(),
        }
    }
}

/// Any outbound JSON-RPC-lite frame sent by the server (`"jsonrpc": "2.0"` always omitted).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum JsonRpcLiteOutbound {
    Response(JsonRpcLiteResponse),
    ServerRequest(JsonRpcLiteRequest),
    Notification(JsonRpcLiteNotification),
}

/// Structured envelope decode failure carrying the correlation ID (when valid) and error payload.
#[derive(Debug, Clone, PartialEq)]
pub struct EnvelopeParseError {
    pub id: Option<JsonRpcLiteId>,
    pub error: JsonRpcLiteError,
}

impl EnvelopeParseError {
    pub fn into_response(self) -> JsonRpcLiteResponse {
        JsonRpcLiteResponse::error(self.id, self.error)
    }
}

fn parse_valid_id(val: &Value) -> Option<JsonRpcLiteId> {
    match val {
        Value::String(s) => Some(JsonRpcLiteId::String(s.clone())),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(JsonRpcLiteId::Number(i))
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u).ok().map(JsonRpcLiteId::Number)
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64
                {
                    Some(JsonRpcLiteId::Number(f as i64))
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

fn parse_non_empty_trimmed_method(val: &Value) -> Option<String> {
    let trimmed = val.as_str()?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn parse_strict_error_object(val: &Value) -> Option<JsonRpcLiteError> {
    let obj = val.as_object()?;
    for key in obj.keys() {
        if key != "code" && key != "message" && key != "data" {
            return None;
        }
    }
    let code_val = obj.get("code")?.as_number()?;
    let code = if let Some(i) = code_val.as_i64() {
        i32::try_from(i).ok()?
    } else {
        let f = code_val.as_f64()?;
        if f.is_finite() && f.fract() == 0.0 && f >= i32::MIN as f64 && f <= i32::MAX as f64 {
            f as i32
        } else {
            return None;
        }
    };
    let message = obj.get("message")?.as_str()?.to_owned();
    let data = obj.get("data").cloned();
    Some(JsonRpcLiteError {
        code,
        message,
        data,
    })
}

fn validate_object_envelope(
    obj: &Map<String, Value>,
) -> Result<JsonRpcLiteClientMessage, EnvelopeParseError> {
    let maybe_id = obj.get("id").and_then(parse_valid_id);
    let invalid_envelope = || EnvelopeParseError {
        id: maybe_id.clone(),
        error: JsonRpcLiteError::new(
            error_codes::INVALID_REQUEST,
            "Invalid JSON-RPC-lite envelope",
        ),
    };

    // 1. Try Request: keys subset of {"id", "method", "params"}, requires "id" and "method"
    if obj.contains_key("id")
        && obj.contains_key("method")
        && obj
            .keys()
            .all(|k| matches!(k.as_str(), "id" | "method" | "params"))
        && let (Some(id), Some(method)) = (
            obj.get("id").and_then(parse_valid_id),
            obj.get("method").and_then(parse_non_empty_trimmed_method),
        )
    {
        return Ok(JsonRpcLiteClientMessage::Request(JsonRpcLiteRequest {
            id,
            method,
            params: obj.get("params").cloned(),
        }));
    }

    // 2. Try Notification: keys subset of {"method", "params"}, requires "method", NO "id"
    if !obj.contains_key("id")
        && obj.contains_key("method")
        && obj
            .keys()
            .all(|k| matches!(k.as_str(), "method" | "params"))
        && let Some(method) = obj.get("method").and_then(parse_non_empty_trimmed_method)
    {
        return Ok(JsonRpcLiteClientMessage::Notification(
            JsonRpcLiteNotification {
                method,
                params: obj.get("params").cloned(),
            },
        ));
    }

    // 3. Try ClientResponse: keys subset of {"id", "result", "error"}, requires "id" and ("result" or "error")
    if obj.contains_key("id")
        && !obj.contains_key("method")
        && obj
            .keys()
            .all(|k| matches!(k.as_str(), "id" | "result" | "error"))
        && (obj.contains_key("result") || obj.contains_key("error"))
        && let Some(id) = obj.get("id").and_then(parse_valid_id)
    {
        let error = match obj.get("error") {
            Some(err_val) => match parse_strict_error_object(err_val) {
                Some(parsed) => Some(parsed),
                None => return Err(invalid_envelope()),
            },
            None => None,
        };
        return Ok(JsonRpcLiteClientMessage::ClientResponse(
            JsonRpcLiteClientResponse {
                id,
                result: obj.get("result").cloned(),
                error,
            },
        ));
    }

    Err(invalid_envelope())
}

/// Strictly parses a UTF-8 JSON-RPC-lite text frame, rejecting `"jsonrpc": "2.0"`, batches, and unknown keys.
pub fn parse_client_message(raw: &str) -> Result<JsonRpcLiteClientMessage, EnvelopeParseError> {
    let value: Value = serde_json::from_str(raw).map_err(|_| EnvelopeParseError {
        id: None,
        error: JsonRpcLiteError::new(error_codes::PARSE_ERROR, "Invalid JSON"),
    })?;

    let Value::Object(obj) = value else {
        return Err(EnvelopeParseError {
            id: None,
            error: JsonRpcLiteError::new(error_codes::INVALID_REQUEST, "Expected object"),
        });
    };

    validate_object_envelope(&obj)
}

/// Decodes raw WebSocket binary or text bytes into a validated `JsonRpcLiteClientMessage`.
pub fn decode_client_message_bytes(
    raw: &[u8],
) -> Result<JsonRpcLiteClientMessage, EnvelopeParseError> {
    let text = std::str::from_utf8(raw).map_err(|_| EnvelopeParseError {
        id: None,
        error: JsonRpcLiteError::new(error_codes::PARSE_ERROR, "Invalid JSON"),
    })?;
    parse_client_message(text)
}

/// Classifies whether an outbound JSON-RPC-lite frame is an evictable streaming delta under backpressure.
///
/// Exact parity with `src/server/runtime/SocketSendQueue.ts`:
/// - `method == "model_stream_chunk"`
/// - `method == "item/agentMessage/delta"`
/// - `method == "item/reasoning/delta"`
/// - `params.type == "agentMessage/delta"`
pub fn is_evictable_stream_delta(payload: &Value) -> bool {
    let Some(obj) = payload.as_object() else {
        return false;
    };
    if let Some(method) = obj.get("method").and_then(Value::as_str)
        && matches!(
            method,
            "model_stream_chunk" | "item/agentMessage/delta" | "item/reasoning/delta"
        )
    {
        return true;
    }
    if let Some(params_type) = obj
        .get("params")
        .and_then(Value::as_object)
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        && params_type == "agentMessage/delta"
    {
        return true;
    }
    false
}
