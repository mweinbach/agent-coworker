//! Reconnecting JSON-RPC 2.0-lite WebSocket client manager per workspace.
//!
//! Ported from `src/client/jsonRpcSocket.ts` and
//! `apps/desktop/src/app/store.helpers/jsonRpcSocket.ts`, reusing `cowork-protocol`.

use cowork_protocol::{
    ClientCapabilities, ClientInfo, InitializeParams, JsonRpcLiteId, WEBSOCKET_SUBPROTOCOL,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::actions::StoreEvent;

/// Connection lifecycle state for a workspace's JSON-RPC WebSocket.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum WsConnectionState {
    #[default]
    Disconnected,
    Connecting,
    Handshaking,
    Connected,
    Reconnecting {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        reason: String,
    },
    Exhausted {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

impl WsConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, WsConnectionState::Connected)
    }

    pub fn is_connecting_or_reconnecting(&self) -> bool {
        matches!(
            self,
            WsConnectionState::Connecting
                | WsConnectionState::Handshaking
                | WsConnectionState::Reconnecting { .. }
        )
    }
}

/// JSON-RPC error returned by a workspace server or transport failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WsRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for WsRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON-RPC error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for WsRpcError {}

/// Commands sent from the store/UI thread to the background WebSocket manager.
#[derive(Clone, Debug, PartialEq)]
pub enum WsCommand {
    ConnectWorkspace {
        workspace_id: String,
        ws_url: String,
        browser_access_token: Option<String>,
    },
    DisconnectWorkspace {
        workspace_id: String,
    },
    SendRequest {
        workspace_id: String,
        request_id: u64,
        method: String,
        params: Value,
        timeout_ms: Option<u64>,
        retry_on_disconnect: bool,
    },
    SendNotification {
        workspace_id: String,
        method: String,
        params: Value,
    },
    SendServerResponse {
        workspace_id: String,
        id: JsonRpcLiteId,
        result: Value,
    },
    Shutdown,
}

/// Metadata kept by `AppState` for correlating in-flight JSON-RPC responses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRpcMeta {
    pub workspace_id: String,
    pub method: String,
}

/// Builds the standard `initialize` payload for a Cowork desktop client.
pub fn desktop_initialize_params(opt_out_notification_methods: Vec<String>) -> InitializeParams {
    InitializeParams {
        client_info: ClientInfo {
            name: "cowork-desktop".to_string(),
            title: Some("Cowork Desktop".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
        },
        capabilities: Some(ClientCapabilities {
            experimental_api: Some(true),
            tool_retry_lineage: Some(true),
            opt_out_notification_methods: Some(opt_out_notification_methods),
        }),
    }
}

/// Required WebSocket subprotocol string for `cowork-server`.
pub const SUBPROTOCOL: &str = WEBSOCKET_SUBPROTOCOL;

/// Spawns the background Tokio WebSocket manager thread and returns its command sender.
///
/// Step 1 stub: runs the command pump cleanly and exits on `WsCommand::Shutdown`.
/// Step 2 replaces the stubbed loop with real `tokio-tungstenite` multi-workspace sockets,
/// `initialize`/`initialized` handshakes, exponential backoff reconnects, and timeouts.
pub fn spawn_ws_manager(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> mpsc::UnboundedSender<WsCommand> {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    std::thread::Builder::new()
        .name("cowork-ws-manager".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            rt.block_on(ws_manager_loop(cmd_rx, event_tx, waker));
        })
        .ok();
    cmd_tx
}

async fn ws_manager_loop(
    mut cmd_rx: mpsc::UnboundedReceiver<WsCommand>,
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            WsCommand::ConnectWorkspace { workspace_id, .. } => {
                let _ = event_tx.send(StoreEvent::WsStateChanged {
                    workspace_id,
                    state: WsConnectionState::Connecting,
                });
                if let Some(ref w) = waker {
                    w();
                }
            }
            WsCommand::DisconnectWorkspace { workspace_id } => {
                let _ = event_tx.send(StoreEvent::WsStateChanged {
                    workspace_id,
                    state: WsConnectionState::Disconnected,
                });
                if let Some(ref w) = waker {
                    w();
                }
            }
            WsCommand::SendRequest { .. }
            | WsCommand::SendNotification { .. }
            | WsCommand::SendServerResponse { .. } => {}
            WsCommand::Shutdown => break,
        }
    }
}
