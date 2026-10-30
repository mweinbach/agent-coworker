//! `cowork-protocol` — Foundation Layer (zero internal crate dependencies).
//!
//! Module boundaries owned by this crate:
//! - **JSON-RPC-lite wire envelope**: Outbound messages omit `"jsonrpc": "2.0"`, enforce strict
//!   top-level envelope key validation, and map canonical error codes (`-32700..-32603`,
//!   `-32001..-32003`).
//! - **Schema namespaces**: Typed request, result, notification, and server-request payloads across
//!   all 21 protocol namespaces (`core`, `threadTurn`, `threadManagement`, `session`, `agents`,
//!   `agentProfiles`, `connectors`, `creation`, `provider`, `runtime`, `mcp`, `plugins`, `skills`,
//!   `marketplaces`, `import`, `memory`, `backups`, `skillImprovement`, `commands`, `workspace`,
//!   `tasks`).
//! - **Occurrence-stable `item/*` projectors**: Deterministic turn item lifecycle projection,
//!   `clientMessageId` preservation, and `toolRetryLineage` capability filtering.
//! - **Schema & manifest codegen**: Deterministic `schemars` JSON Schema bundle export for
//!   `docs/generated/websocket-jsonrpc.schema.json`.

use serde::{Deserialize, Serialize};

/// Current Cowork WebSocket protocol version (`docs/websocket-protocol.md`).
pub const WEBSOCKET_PROTOCOL_VERSION: &str = "7.48";

/// Current JSON-RPC-lite wire envelope version.
pub const JSONRPC_PROTOCOL_VERSION: &str = "0.1";

/// Required WebSocket subprotocol negotiated on `GET /ws`.
pub const WEBSOCKET_SUBPROTOCOL: &str = "cowork.jsonrpc.v1";

/// Canonical JSON-RPC-lite error codes.
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const SERVER_OVERLOADED: i32 = -32001;
    pub const NOT_INITIALIZED: i32 = -32002;
    pub const ALREADY_INITIALIZED: i32 = -32003;
}

/// JSON-RPC-lite request/response correlation identifier (string or finite integer/number).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcLiteId {
    String(String),
    Number(i64),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_constants_match_wire_contract() {
        assert_eq!(WEBSOCKET_PROTOCOL_VERSION, "7.48");
        assert_eq!(JSONRPC_PROTOCOL_VERSION, "0.1");
        assert_eq!(WEBSOCKET_SUBPROTOCOL, "cowork.jsonrpc.v1");
        assert_eq!(error_codes::PARSE_ERROR, -32700);
        assert_eq!(error_codes::NOT_INITIALIZED, -32002);
        assert_eq!(error_codes::ALREADY_INITIALIZED, -32003);
    }

    #[test]
    fn jsonrpc_lite_id_roundtrips_string_and_number() {
        let str_id = JsonRpcLiteId::String("req-1".to_owned());
        let num_id = JsonRpcLiteId::Number(42);

        assert_eq!(
            serde_json::from_str::<JsonRpcLiteId>(&serde_json::to_string(&str_id).unwrap())
                .unwrap(),
            str_id
        );
        assert_eq!(
            serde_json::from_str::<JsonRpcLiteId>(&serde_json::to_string(&num_id).unwrap())
                .unwrap(),
            num_id
        );
    }
}
