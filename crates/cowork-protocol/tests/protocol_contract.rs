use cowork_protocol::{
    JSONRPC_PROTOCOL_VERSION, JsonRpcLiteClientMessage, JsonRpcLiteError, JsonRpcLiteId,
    JsonRpcLiteNotification, JsonRpcLiteOutbound, JsonRpcLiteRequest, JsonRpcLiteResponse,
    NAMESPACE_NAMES, PersistedJournalEventView, ThreadTurnProjector, WEBSOCKET_PROTOCOL_VERSION,
    WEBSOCKET_SUBPROTOCOL, decode_client_message_bytes, error_codes,
    export_protocol_schema_manifest, is_evictable_stream_delta, occurrence_item_id,
    parse_client_message, parse_initialize_params, parse_initialized_params,
    project_tool_retry_compatibility,
};
use serde_json::json;

#[test]
fn outbound_envelopes_omit_jsonrpc_2_0_field() {
    let ok_resp = JsonRpcLiteOutbound::Response(JsonRpcLiteResponse::success(
        JsonRpcLiteId::Number(1),
        json!({"ok": true}),
    ));
    let serialized = serde_json::to_value(&ok_resp).unwrap();
    assert!(serialized.get("jsonrpc").is_none());
    assert_eq!(serialized, json!({"id": 1, "result": {"ok": true}}));

    let err_resp = JsonRpcLiteOutbound::Response(JsonRpcLiteResponse::error(
        Some(JsonRpcLiteId::String("req-9".into())),
        JsonRpcLiteError::new(error_codes::NOT_INITIALIZED, "Not initialized"),
    ));
    let err_val = serde_json::to_value(&err_resp).unwrap();
    assert!(err_val.get("jsonrpc").is_none());
    assert_eq!(
        err_val,
        json!({"id": "req-9", "error": {"code": -32002, "message": "Not initialized"}})
    );

    let notif = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
        method: "thread/started".into(),
        params: Some(json!({"thread": {"id": "t1"}})),
    });
    let notif_val = serde_json::to_value(&notif).unwrap();
    assert!(notif_val.get("jsonrpc").is_none());
    assert_eq!(
        notif_val,
        json!({"method": "thread/started", "params": {"thread": {"id": "t1"}}})
    );

    let srv_req = JsonRpcLiteOutbound::ServerRequest(JsonRpcLiteRequest {
        id: JsonRpcLiteId::String("srv-1".into()),
        method: "item/commandExecution/requestApproval".into(),
        params: Some(json!({"command": "ls"})),
    });
    let srv_val = serde_json::to_value(&srv_req).unwrap();
    assert!(srv_val.get("jsonrpc").is_none());
}

#[test]
fn inbound_parser_enforces_strict_envelope_and_error_codes() {
    // 1. Parse error (-32700)
    let bad_json = parse_client_message("{not-json");
    let err = bad_json.unwrap_err();
    assert_eq!(err.id, None);
    assert_eq!(err.error.code, error_codes::PARSE_ERROR);
    assert_eq!(err.error.message, "Invalid JSON");

    // Invalid UTF-8 bytes -> Parse error (-32700)
    let bad_utf8 = decode_client_message_bytes(&[0xff, 0xfe]);
    assert_eq!(bad_utf8.unwrap_err().error.code, error_codes::PARSE_ERROR);

    // 2. Non-object / batch array -> Invalid Request (-32600 "Expected object")
    for raw in [
        r#"[{"id":1,"method":"ping"}]"#,
        "42",
        r#""hello""#,
        "null",
        "true",
    ] {
        let res = parse_client_message(raw).unwrap_err();
        assert_eq!(res.id, None);
        assert_eq!(res.error.code, error_codes::INVALID_REQUEST);
        assert_eq!(res.error.message, "Expected object");
    }

    // 3. Rejects "jsonrpc": "2.0" and any unknown top-level envelope key (-32600), preserving valid id
    let with_jsonrpc =
        parse_client_message(r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}"#)
            .unwrap_err();
    assert_eq!(with_jsonrpc.id, Some(JsonRpcLiteId::Number(7)));
    assert_eq!(with_jsonrpc.error.code, error_codes::INVALID_REQUEST);
    assert_eq!(with_jsonrpc.error.message, "Invalid JSON-RPC-lite envelope");

    let extra_notif_key =
        parse_client_message(r#"{"method":"initialized","extra":123}"#).unwrap_err();
    assert_eq!(extra_notif_key.id, None);
    assert_eq!(extra_notif_key.error.code, error_codes::INVALID_REQUEST);

    // 4. Rejects whitespace-only method
    let blank_method = parse_client_message(r#"{"id":"a","method":"   "}"#).unwrap_err();
    assert_eq!(blank_method.id, Some(JsonRpcLiteId::String("a".into())));
    assert_eq!(blank_method.error.code, error_codes::INVALID_REQUEST);

    // 5. Rejects client response with neither result nor error
    let empty_resp = parse_client_message(r#"{"id":"r1"}"#).unwrap_err();
    assert_eq!(empty_resp.id, Some(JsonRpcLiteId::String("r1".into())));
    assert_eq!(empty_resp.error.code, error_codes::INVALID_REQUEST);

    // 6. Accepts valid request (trimming method), notification, and client response with null result
    let valid_req =
        parse_client_message(r#"{"id":10,"method":"  thread/list  ","params":{"limit":5}}"#)
            .unwrap();
    match valid_req {
        JsonRpcLiteClientMessage::Request(req) => {
            assert_eq!(req.id, JsonRpcLiteId::Number(10));
            assert_eq!(req.method, "thread/list");
            assert_eq!(req.params, Some(json!({"limit": 5})));
        }
        other => panic!("expected request, got {other:?}"),
    }

    let valid_notif = parse_client_message(r#"{"method":"initialized"}"#).unwrap();
    assert!(matches!(
        valid_notif,
        JsonRpcLiteClientMessage::Notification(n) if n.method == "initialized" && n.params.is_none()
    ));

    let null_result_resp = parse_client_message(r#"{"id":"ask-1","result":null}"#).unwrap();
    match null_result_resp {
        JsonRpcLiteClientMessage::ClientResponse(resp) => {
            assert_eq!(resp.id, JsonRpcLiteId::String("ask-1".into()));
            assert_eq!(resp.result, Some(json!(null)));
            assert!(resp.error.is_none());
        }
        other => panic!("expected client response, got {other:?}"),
    }
}

#[test]
fn initialize_and_initialized_params_enforce_strict_schemas() {
    let ok = parse_initialize_params(Some(&json!({
        "clientInfo": { "name": "cowork-cli", "version": "0.1.0" },
        "capabilities": {
            "experimentalApi": true,
            "toolRetryLineage": true,
            "optOutNotificationMethods": ["model_stream_chunk"]
        }
    })))
    .unwrap();
    assert_eq!(ok.client_info.name, "cowork-cli");
    assert_eq!(
        ok.capabilities.as_ref().and_then(|c| c.tool_retry_lineage),
        Some(true)
    );

    // Missing clientInfo -> -32602
    assert_eq!(
        parse_initialize_params(Some(&json!({}))).unwrap_err().code,
        error_codes::INVALID_PARAMS
    );

    // Unknown field in initialize -> -32602
    assert_eq!(
        parse_initialize_params(Some(&json!({
            "clientInfo": { "name": "cli" },
            "unknownField": true
        })))
        .unwrap_err()
        .code,
        error_codes::INVALID_PARAMS
    );

    // experimentalApi: false -> -32602 (must be literal true if present)
    assert_eq!(
        parse_initialize_params(Some(&json!({
            "clientInfo": { "name": "cli" },
            "capabilities": { "experimentalApi": false }
        })))
        .unwrap_err()
        .code,
        error_codes::INVALID_PARAMS
    );

    // initialized accepts None or {} and rejects extra fields
    assert!(parse_initialized_params(None).is_ok());
    assert!(parse_initialized_params(Some(&json!({}))).is_ok());
    assert_eq!(
        parse_initialized_params(Some(&json!({"unexpected": 1})))
            .unwrap_err()
            .code,
        error_codes::INVALID_PARAMS
    );
}

#[test]
fn stream_delta_classification_matches_socket_send_queue_rules() {
    assert!(is_evictable_stream_delta(
        &json!({"method": "model_stream_chunk", "params": {}})
    ));
    assert!(is_evictable_stream_delta(
        &json!({"method": "item/agentMessage/delta", "params": {"delta": "hi"}})
    ));
    assert!(is_evictable_stream_delta(
        &json!({"method": "item/reasoning/delta", "params": {"delta": "hmm"}})
    ));
    assert!(is_evictable_stream_delta(
        &json!({"method": "legacy", "params": {"type": "agentMessage/delta"}})
    ));

    // Lifecycle, requests, and responses are NEVER evictable deltas
    assert!(!is_evictable_stream_delta(
        &json!({"method": "turn/started", "params": {}})
    ));
    assert!(!is_evictable_stream_delta(
        &json!({"method": "item/started", "params": {}})
    ));
    assert!(!is_evictable_stream_delta(
        &json!({"method": "item/completed", "params": {}})
    ));
    assert!(!is_evictable_stream_delta(
        &json!({"method": "turn/completed", "params": {}})
    ));
    assert!(!is_evictable_stream_delta(
        &json!({"id": "req-1", "method": "item/commandExecution/requestApproval", "params": {}})
    ));
    assert!(!is_evictable_stream_delta(
        &json!({"id": 1, "result": {"ok": true}})
    ));
}

#[test]
fn projector_assigns_occurrence_ids_and_strips_retry_lineage_when_unsupported() {
    assert_eq!(occurrence_item_id("msg-1", 1), "msg-1");
    assert_eq!(occurrence_item_id("msg-1", 2), "msg-1:2");

    let mut projector = ThreadTurnProjector::new();
    projector.handle(&PersistedJournalEventView {
        event_type: "turn/started",
        turn_id: Some("turn-1"),
        item_id: None,
        payload: &json!({"turn": {"id": "turn-1", "status": "inProgress"}}),
    });
    projector.handle(&PersistedJournalEventView {
        event_type: "item/started",
        turn_id: Some("turn-1"),
        item_id: Some("assistant-msg"),
        payload: &json!({"turnId": "turn-1", "item": {"id": "assistant-msg", "type": "agentMessage", "text": ""}}),
    });
    projector.handle(&PersistedJournalEventView {
        event_type: "item/agentMessage/delta",
        turn_id: Some("turn-1"),
        item_id: Some("assistant-msg"),
        payload: &json!({"turnId": "turn-1", "itemId": "assistant-msg", "delta": "First segment"}),
    });
    projector.handle(&PersistedJournalEventView {
        event_type: "item/started",
        turn_id: Some("turn-1"),
        item_id: Some("tool-1"),
        payload: &json!({"turnId": "turn-1", "item": {"id": "tool-1", "type": "toolCall", "toolName": "read"}}),
    });
    projector.handle(&PersistedJournalEventView {
        event_type: "item/started",
        turn_id: Some("turn-1"),
        item_id: Some("assistant-msg"),
        payload: &json!({"turnId": "turn-1", "item": {"id": "assistant-msg", "type": "agentMessage", "text": ""}}),
    });
    projector.handle(&PersistedJournalEventView {
        event_type: "item/agentMessage/delta",
        turn_id: Some("turn-1"),
        item_id: Some("assistant-msg"),
        payload: &json!({"turnId": "turn-1", "itemId": "assistant-msg", "delta": "Second segment"}),
    });
    projector.handle(&PersistedJournalEventView {
        event_type: "turn/completed",
        turn_id: Some("turn-1"),
        item_id: None,
        payload: &json!({"turn": {"id": "turn-1", "status": "completed"}}),
    });

    let turns = projector.build();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].status, "completed");
    assert_eq!(turns[0].items.len(), 3);
    assert_eq!(turns[0].items[0]["id"], "assistant-msg");
    assert_eq!(turns[0].items[0]["text"], "First segment");
    assert_eq!(turns[0].items[1]["id"], "tool-1");
    assert_eq!(turns[0].items[2]["id"], "assistant-msg:2");
    assert_eq!(turns[0].items[2]["text"], "Second segment");

    // Retry lineage stripping
    let tool_payload = json!({
        "method": "item/completed",
        "params": {
            "item": {
                "id": "tc-1",
                "type": "toolCall",
                "toolName": "bash",
                "retryOf": "tc-0",
                "inputDigest": "sha256:abc"
            }
        }
    });
    let stripped = project_tool_retry_compatibility(false, &tool_payload).unwrap();
    assert!(stripped["params"]["item"].get("retryOf").is_none());
    assert!(stripped["params"]["item"].get("inputDigest").is_none());

    let preserved = project_tool_retry_compatibility(true, &tool_payload).unwrap();
    assert_eq!(preserved["params"]["item"]["retryOf"], "tc-0");

    // Hidden retry user message is omitted when unsupported
    let hidden_retry_msg = json!({
        "id": "u-retry",
        "type": "userMessage",
        "annotations": [{"type": "cowork.toolRetryTurn"}]
    });
    assert!(project_tool_retry_compatibility(false, &hidden_retry_msg).is_none());
}

#[test]
fn schema_manifest_exports_all_21_namespaces() {
    assert_eq!(NAMESPACE_NAMES.len(), 21);
    let manifest = export_protocol_schema_manifest();
    assert_eq!(manifest["protocolVersion"], JSONRPC_PROTOCOL_VERSION);
    assert_eq!(
        manifest["websocketProtocolVersion"],
        WEBSOCKET_PROTOCOL_VERSION
    );
    assert_eq!(manifest["subprotocol"], WEBSOCKET_SUBPROTOCOL);
    assert_eq!(manifest["namespaces"].as_array().unwrap().len(), 21);
}
