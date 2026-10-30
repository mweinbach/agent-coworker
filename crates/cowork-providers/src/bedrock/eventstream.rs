use aws_smithy_eventstream::frame::{DecodedFrame, MessageFrameDecoder, write_message_to};
use aws_smithy_types::event_stream::{Header, HeaderValue, Message};
use bytes::BytesMut;
use cowork_inference::ProviderTransportError;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
pub enum BedrockDecodedEvent {
    Event {
        event_type: String,
        payload: Value,
    },
    Exception {
        exception_type: String,
        message: String,
    },
}

#[derive(Debug, Default)]
pub struct BedrockStreamFrameDecoder {
    buffer: BytesMut,
    decoder: MessageFrameDecoder,
    in_frame: bool,
}

impl BedrockStreamFrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_bytes(
        &mut self,
        chunk: &[u8],
    ) -> Result<Vec<BedrockDecodedEvent>, ProviderTransportError> {
        if !chunk.is_empty() {
            self.buffer.extend_from_slice(chunk);
        }

        let mut decoded = Vec::new();
        loop {
            let had_prelude_bytes = self.buffer.len() >= 12;
            match self.decoder.decode_frame(&mut self.buffer) {
                Ok(DecodedFrame::Incomplete) => {
                    if had_prelude_bytes {
                        self.in_frame = true;
                    }
                    break;
                }
                Ok(DecodedFrame::Complete(msg)) => {
                    self.in_frame = false;
                    decoded.push(decode_smithy_message(&msg)?);
                }
                Err(err) => {
                    self.in_frame = false;
                    return Err(ProviderTransportError::protocol(format!(
                        "Bedrock EventStream frame decode error: {err}"
                    )));
                }
            }
        }

        Ok(decoded)
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty() && !self.in_frame
    }
}

fn header_string(msg: &Message, name: &str) -> Option<String> {
    msg.headers()
        .iter()
        .find(|h| h.name().as_str() == name)
        .and_then(|h| h.value().as_string().ok())
        .map(|s| s.as_str().to_string())
}

fn decode_smithy_message(msg: &Message) -> Result<BedrockDecodedEvent, ProviderTransportError> {
    let msg_type = header_string(msg, ":message-type").unwrap_or_else(|| "event".to_string());
    let payload_bytes = msg.payload().as_ref();

    if msg_type == "exception" || msg_type == "error" {
        let exception_type = header_string(msg, ":exception-type")
            .or_else(|| header_string(msg, ":error-code"))
            .unwrap_or_else(|| "unknownException".to_string());

        let message = if !payload_bytes.is_empty() {
            if let Ok(json_val) = serde_json::from_slice::<Value>(payload_bytes) {
                json_val
                    .get("message")
                    .or_else(|| json_val.get("Message"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| json_val.to_string())
            } else {
                String::from_utf8_lossy(payload_bytes).into_owned()
            }
        } else {
            header_string(msg, ":error-message").unwrap_or_else(|| exception_type.clone())
        };

        return Ok(BedrockDecodedEvent::Exception {
            exception_type,
            message,
        });
    }

    let event_type = header_string(msg, ":event-type").unwrap_or_default();
    let payload = if payload_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(payload_bytes).map_err(|err| {
            ProviderTransportError::protocol(format!(
                "Invalid JSON in Bedrock EventStream frame ({event_type}): {err}"
            ))
        })?
    };

    Ok(BedrockDecodedEvent::Event {
        event_type,
        payload,
    })
}

pub fn encode_eventstream_json_frame(
    event_type: &str,
    payload: &Value,
) -> Result<Vec<u8>, ProviderTransportError> {
    let payload_bytes = serde_json::to_vec(payload).map_err(|err| {
        ProviderTransportError::protocol(format!("Failed to serialize EventStream payload: {err}"))
    })?;
    let message = Message::new(payload_bytes)
        .add_header(Header::new(
            ":message-type",
            HeaderValue::String("event".into()),
        ))
        .add_header(Header::new(
            ":event-type",
            HeaderValue::String(event_type.to_string().into()),
        ))
        .add_header(Header::new(
            ":content-type",
            HeaderValue::String("application/json".into()),
        ));

    let mut buf = Vec::new();
    write_message_to(&message, &mut buf).map_err(|err| {
        ProviderTransportError::protocol(format!("Failed to encode EventStream frame: {err}"))
    })?;
    Ok(buf)
}

pub fn encode_eventstream_exception_frame(
    exception_type: &str,
    message_text: &str,
) -> Result<Vec<u8>, ProviderTransportError> {
    let payload_bytes = serde_json::to_vec(&json!({ "message": message_text })).map_err(|err| {
        ProviderTransportError::protocol(format!(
            "Failed to serialize EventStream exception: {err}"
        ))
    })?;
    let message = Message::new(payload_bytes)
        .add_header(Header::new(
            ":message-type",
            HeaderValue::String("exception".into()),
        ))
        .add_header(Header::new(
            ":exception-type",
            HeaderValue::String(exception_type.to_string().into()),
        ))
        .add_header(Header::new(
            ":content-type",
            HeaderValue::String("application/json".into()),
        ));

    let mut buf = Vec::new();
    write_message_to(&message, &mut buf).map_err(|err| {
        ProviderTransportError::protocol(format!(
            "Failed to encode EventStream exception frame: {err}"
        ))
    })?;
    Ok(buf)
}
