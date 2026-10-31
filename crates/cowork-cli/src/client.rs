use std::collections::VecDeque;
use std::time::Duration;

use cowork_protocol::{
    JsonRpcLiteClientResponse, JsonRpcLiteId, JsonRpcLiteNotification, JsonRpcLiteRequest,
    WEBSOCKET_SUBPROTOCOL,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

#[derive(Debug, Clone)]
pub enum InboundRpcEvent {
    Notification(JsonRpcLiteNotification),
    ServerRequest(JsonRpcLiteRequest),
}

/// JSON-RPC-lite WebSocket client (`cowork.jsonrpc.v1`) for `cowork-cli`.
pub struct ReplRpcClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: i64,
    pub pending_notifications: VecDeque<JsonRpcLiteNotification>,
    pub pending_server_requests: VecDeque<JsonRpcLiteRequest>,
}

impl ReplRpcClient {
    pub async fn connect_and_handshake(ws_url: &str, version: &str) -> anyhow::Result<Self> {
        let mut req = ws_url.into_client_request()?;
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static(WEBSOCKET_SUBPROTOCOL),
        );
        let (ws, _) = connect_async(req).await?;
        let mut client = Self {
            ws,
            next_id: 1,
            pending_notifications: VecDeque::new(),
            pending_server_requests: VecDeque::new(),
        };

        let _ = client
            .request(
                "initialize",
                Some(json!({
                    "clientInfo": {
                        "name": "cowork-cli",
                        "version": version,
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "toolRetryLineage": true,
                    }
                })),
            )
            .await?;

        client.notify("initialized", None).await?;
        Ok(client)
    }

    pub async fn notify(&mut self, method: &str, params: Option<Value>) -> anyhow::Result<()> {
        let frame = JsonRpcLiteNotification {
            method: method.to_owned(),
            params,
        };
        let raw = serde_json::to_string(&frame)?;
        self.ws.send(WsMessage::Text(raw.into())).await?;
        Ok(())
    }

    pub async fn respond_to_server_request(
        &mut self,
        id: JsonRpcLiteId,
        result: Value,
    ) -> anyhow::Result<()> {
        let frame = JsonRpcLiteClientResponse {
            id,
            result: Some(result),
            error: None,
        };
        let raw = serde_json::to_string(&frame)?;
        self.ws.send(WsMessage::Text(raw.into())).await?;
        Ok(())
    }

    fn buffer_non_response_frame(&mut self, val: &Value) {
        let Some(m) = val.get("method").and_then(Value::as_str) else {
            return;
        };
        if let Some(raw_id) = val.get("id")
            && let Ok(parsed_id) = serde_json::from_value::<JsonRpcLiteId>(raw_id.clone())
        {
            self.pending_server_requests.push_back(JsonRpcLiteRequest {
                id: parsed_id,
                method: m.to_owned(),
                params: val.get("params").cloned(),
            });
        } else {
            self.pending_notifications
                .push_back(JsonRpcLiteNotification {
                    method: m.to_owned(),
                    params: val.get("params").cloned(),
                });
        }
    }

    pub async fn request(&mut self, method: &str, params: Option<Value>) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        let req = JsonRpcLiteRequest {
            id: JsonRpcLiteId::Number(id),
            method: method.to_owned(),
            params,
        };
        let raw = serde_json::to_string(&req)?;
        self.ws.send(WsMessage::Text(raw.into())).await?;

        loop {
            let next_msg = tokio::time::timeout(Duration::from_secs(30), self.ws.next())
                .await
                .map_err(|_| anyhow::anyhow!("Timed out waiting for response to {method}"))?
                .ok_or_else(|| anyhow::anyhow!("WebSocket closed while awaiting {method}"))??;

            let text = match next_msg {
                WsMessage::Text(t) => t.to_string(),
                WsMessage::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                WsMessage::Close(_) => {
                    anyhow::bail!("Server closed WebSocket connection");
                }
                _ => continue,
            };

            let val: Value = serde_json::from_str(&text)?;
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                if let Some(err) = val.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("JSON-RPC error");
                    let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1);
                    anyhow::bail!("{msg} (code {code})");
                }
                return Ok(val.get("result").cloned().unwrap_or(Value::Null));
            }

            self.buffer_non_response_frame(&val);
        }
    }

    pub async fn next_inbound_event(&mut self) -> anyhow::Result<InboundRpcEvent> {
        if let Some(sr) = self.pending_server_requests.pop_front() {
            return Ok(InboundRpcEvent::ServerRequest(sr));
        }
        if let Some(notif) = self.pending_notifications.pop_front() {
            return Ok(InboundRpcEvent::Notification(notif));
        }

        loop {
            let next_msg = self
                .ws
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("WebSocket closed during active turn"))??;

            let text = match next_msg {
                WsMessage::Text(t) => t.to_string(),
                WsMessage::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                WsMessage::Close(_) => {
                    anyhow::bail!("Server closed WebSocket connection");
                }
                _ => continue,
            };

            let val: Value = serde_json::from_str(&text)?;
            if let Some(m) = val.get("method").and_then(Value::as_str) {
                if let Some(raw_id) = val.get("id")
                    && let Ok(parsed_id) = serde_json::from_value::<JsonRpcLiteId>(raw_id.clone())
                {
                    return Ok(InboundRpcEvent::ServerRequest(JsonRpcLiteRequest {
                        id: parsed_id,
                        method: m.to_owned(),
                        params: val.get("params").cloned(),
                    }));
                }
                return Ok(InboundRpcEvent::Notification(JsonRpcLiteNotification {
                    method: m.to_owned(),
                    params: val.get("params").cloned(),
                }));
            }
        }
    }

    pub async fn drain_brief_notifications(&mut self, wait_ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let WsMessage::Text(t) = msg
                && let Ok(val) = serde_json::from_str::<Value>(t.as_str())
            {
                self.buffer_non_response_frame(&val);
            }
        }
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}
