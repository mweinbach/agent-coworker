use std::time::Duration;

use cowork_protocol::{
    JsonRpcLiteId, JsonRpcLiteNotification, JsonRpcLiteRequest, WEBSOCKET_SUBPROTOCOL,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

/// JSON-RPC-lite WebSocket client (`cowork.jsonrpc.v1`) for `cowork-cli`.
pub struct ReplRpcClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: i64,
    pub pending_notifications: Vec<JsonRpcLiteNotification>,
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
            pending_notifications: Vec::new(),
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
            if val.get("id") == Some(&json!(id)) {
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

            if let Some(m) = val.get("method").and_then(Value::as_str)
                && val.get("id").is_none()
            {
                self.pending_notifications.push(JsonRpcLiteNotification {
                    method: m.to_owned(),
                    params: val.get("params").cloned(),
                });
            }
        }
    }

    pub async fn drain_brief_notifications(&mut self, wait_ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let WsMessage::Text(t) = msg
                && let Ok(val) = serde_json::from_str::<Value>(t.as_str())
                && let Some(m) = val.get("method").and_then(Value::as_str)
                && val.get("id").is_none()
            {
                self.pending_notifications.push(JsonRpcLiteNotification {
                    method: m.to_owned(),
                    params: val.get("params").cloned(),
                });
            }
        }
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}
