//! Parity tests for conversation-import fingerprints and generated item ids.
//!
//! `tests/fixtures/conversation_import_parity/expected_typescript.json` was produced by running
//! the TypeScript adapters from `origin/main` (`src/import/conversations/adapters/*`, under Bun)
//! on the sibling fixture files, using the same source paths and row values as below. The
//! fingerprints are persisted dedupe keys, so they must match byte for byte.

use serde_json::{Map, Value, json};

use super::*;

const CLAUDE_SESSION: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/claude_session.jsonl");
const CLAUDE_NO_SESSION: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/claude_no_session.jsonl");
const CLAUDE_EMPTY: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/claude_empty.jsonl");
const CODEX_ROLLOUT_THREAD: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/codex_rollout_thread.jsonl");
const CODEX_ROLLOUT_FILE: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/codex_rollout_file.jsonl");
const COWORK_SNAPSHOT: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/cowork_snapshot.json");
const COWORK_MESSAGES: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/cowork_messages.json");
const EXPECTED_TYPESCRIPT: &str =
    include_str!("../../tests/fixtures/conversation_import_parity/expected_typescript.json");

fn expected(source_id: &str) -> Value {
    let all: Vec<Value> = serde_json::from_str(EXPECTED_TYPESCRIPT).expect("expected json");
    all.into_iter()
        .find(|c| c["sourceId"] == source_id)
        .unwrap_or_else(|| panic!("no TypeScript expectation for {source_id}"))
}

/// JavaScript numbers are doubles; compare item payloads with every number widened to f64.
fn widen_numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
        Value::Array(items) => Value::Array(items.into_iter().map(widen_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, widen_numbers(v)))
                .collect(),
        ),
        other => other,
    }
}

fn assert_matches_typescript(conversation: &ExternalConversation) {
    let expected = expected(&conversation.source_id);
    assert_eq!(conversation.source.as_str(), expected["source"]);
    assert_eq!(
        conversation.source_path.as_deref(),
        expected["sourcePath"].as_str()
    );
    assert_eq!(conversation.created_at, expected["createdAt"]);
    assert_eq!(conversation.updated_at, expected["updatedAt"]);
    let ids: Vec<&str> = conversation
        .items
        .iter()
        .map(|item| match item {
            ExternalConversationItem::User { id, .. }
            | ExternalConversationItem::Assistant { id, .. }
            | ExternalConversationItem::Tool { id, .. }
            | ExternalConversationItem::Reasoning { id, .. }
            | ExternalConversationItem::System { id, .. } => id.as_str(),
        })
        .collect();
    let expected_ids: Vec<&str> = expected["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, expected_ids, "item ids for {}", conversation.source_id);
    assert_eq!(
        widen_numbers(serde_json::to_value(&conversation.items).expect("items")),
        widen_numbers(expected["items"].clone()),
        "items for {}",
        conversation.source_id
    );
    assert_eq!(
        conversation.fingerprint, expected["fingerprint"],
        "fingerprint for {}",
        conversation.source_id
    );
}

fn parse_records(text: &str) -> (Vec<JsJson>, Vec<ConversationImportWarning>) {
    let mut warnings = Vec::new();
    let records = parse_jsonl_records(text, &mut warnings);
    (records, warnings)
}

#[test]
fn claude_code_fingerprints_and_item_ids_match_typescript() {
    for (path, text) in [
        (
            "/fixtures/claude/projects/-work-app/claude-session.jsonl",
            CLAUDE_SESSION,
        ),
        (
            "/fixtures/claude/projects/-work-app/claude-no-session.jsonl",
            CLAUDE_NO_SESSION,
        ),
        (
            "/fixtures/claude/projects/-work-app/claude-empty.jsonl",
            CLAUDE_EMPTY,
        ),
    ] {
        let (records, warnings) = parse_records(text);
        let conversation =
            claude_code_conversation(path, &records, warnings, Some("/work/app".to_owned()));
        assert_matches_typescript(&conversation);
    }
}

#[test]
fn claude_code_item_ids_match_typescript_when_read_from_disk() {
    // Item ids depend on the session id, not the file path, so they survive relocation.
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("claude-session.jsonl");
    fs::write(&file, CLAUDE_SESSION).expect("write fixture");
    let conversation = parse_claude_code_jsonl(&file, None);
    let expected = expected("claude-sess-1");
    let ids: Vec<Value> = serde_json::to_value(&conversation.items)
        .expect("items")
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["id"].clone())
        .collect();
    let expected_ids: Vec<Value> = expected["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["id"].clone())
        .collect();
    assert_eq!(ids, expected_ids);
}

#[test]
fn codex_thread_fingerprint_and_item_ids_match_typescript() {
    let row: Map<String, Value> = json!({
        "id": "codex-thread-1",
        "title": "Codex task",
        "cwd": "/work/codex",
        "model": "gpt-5",
        "model_provider": "openai",
        "rollout_path": "/fixtures/codex/sessions/rollout-thread.jsonl",
        "created_at_ms": null,
        "created_at": 1767225600,
        "updated_at_ms": 1767225660123_i64,
        "updated_at": 1767225660,
        "archived": 0,
    })
    .as_object()
    .cloned()
    .expect("row");
    let mut load = |path: &Path, warnings: &mut Vec<ConversationImportWarning>| {
        assert_eq!(
            path,
            Path::new("/fixtures/codex/sessions/rollout-thread.jsonl")
        );
        parse_jsonl_records(CODEX_ROLLOUT_THREAD, warnings)
    };
    let conversation =
        codex_thread_row_to_conversation(&row, Path::new("/fixtures/codex"), &mut load)
            .expect("conversation");
    assert_matches_typescript(&conversation);
}

#[test]
fn codex_rollout_file_fingerprint_and_item_ids_match_typescript() {
    let (records, warnings) = parse_records(CODEX_ROLLOUT_FILE);
    let conversation = codex_rollout_file_conversation(
        "/fixtures/codex/rollout-file.jsonl",
        "rollout-file.jsonl".to_owned(),
        "2026-01-02T03:04:05.678Z".to_owned(),
        &records,
        warnings,
    );
    assert_matches_typescript(&conversation);
}

#[test]
fn cowork_fingerprints_and_item_ids_match_typescript() {
    let snapshot_row = CoworkSessionRow {
        session_id: Some("cowork-snap".to_owned()),
        title: Some("Snapshot session".to_owned()),
        provider: Some("google".to_owned()),
        model: Some("gemini-3-flash-preview".to_owned()),
        working_directory: Some("/work/cw".to_owned()),
        created_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
        updated_at: Some("2026-01-01T00:00:05.000Z".to_owned()),
        messages_json: Some("[]".to_owned()),
        snapshot_json: Some(COWORK_SNAPSHOT.trim().to_owned()),
    };
    let messages_row = CoworkSessionRow {
        session_id: Some("cowork-msgs".to_owned()),
        title: Some("Messages only".to_owned()),
        provider: Some("openai".to_owned()),
        model: Some("gpt-5".to_owned()),
        working_directory: Some(String::new()),
        created_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
        updated_at: Some("2026-01-01T00:00:02.000Z".to_owned()),
        messages_json: Some(COWORK_MESSAGES.trim().to_owned()),
        snapshot_json: None,
    };
    for row in [snapshot_row, messages_row] {
        let conversation =
            cowork_row_to_conversation(row, "cowork-fixture/sessions.db").expect("conversation");
        assert_matches_typescript(&conversation);
    }
}

#[test]
fn js_json_numbers_match_json_stringify() {
    // [JSON text, JSON.stringify(JSON.parse(text))] from Node 22.
    let cases = [
        ("0", "0"),
        ("-0", "0"),
        ("1", "1"),
        ("1.0", "1"),
        ("-2.5", "-2.5"),
        ("1e21", "1e+21"),
        ("1e20", "100000000000000000000"),
        ("123456789012345680000", "123456789012345680000"),
        ("1.5e-7", "1.5e-7"),
        ("0.000001", "0.000001"),
        ("1e-7", "1e-7"),
        ("12345678901234567890", "12345678901234567000"),
        ("9007199254740993", "9007199254740992"),
        ("5e-324", "5e-324"),
        ("1.7976931348623157e308", "1.7976931348623157e+308"),
        ("0.1", "0.1"),
        ("100", "100"),
        ("1E+2", "100"),
        ("123.456e5", "12345600"),
        ("-1.5e300", "-1.5e+300"),
        ("4.35", "4.35"),
        ("0.30000000000000004", "0.30000000000000004"),
        ("999999999999999999999", "1e+21"),
        ("1e-6", "0.000001"),
        ("0.0000012345", "0.0000012345"),
        ("-0.0", "0"),
    ];
    for (input, stringified) in cases {
        let parsed = JsJson::parse(input).expect("number");
        assert_eq!(parsed.stringify(), stringified, "JSON.stringify({input})");
    }
}

#[test]
fn js_json_strings_and_key_order_match_json_stringify() {
    let mut s: String = (0u8..0x80).map(char::from).collect();
    s.push_str("\u{2028}\u{2029}\u{feff}\u{e9}\u{1f600}");
    let stringified = JsJson::String(s).stringify();
    assert!(stringified.starts_with(r#""\u0000\u0001"#));
    assert!(stringified.contains(r#"\b\t\n\u000b\f\r\u000e"#));
    assert_eq!(
        sha256_hex(&stringified),
        "d4d2c9a9f438bccf3b97f389f0eb075bd4c3c5c44f22e86e193d4a039da77fcb"
    );

    let object = JsJson::parse(
        r#"{"b":1,"10":2,"2":3,"a":4,"01":5,"4294967294":6,"4294967295":7,"-1":8,"1.5":9,"b":10,"0":{"z":[],"y":{}}}"#,
    )
    .expect("object");
    assert_eq!(
        object.stringify(),
        r#"{"0":{"z":[],"y":{}},"2":3,"10":2,"4294967294":6,"b":10,"a":4,"01":5,"4294967295":7,"-1":8,"1.5":9}"#
    );
}

#[test]
fn js_string_coercion_matches_javascript_string() {
    let value = JsJson::parse(r#"[1, null, "a", [2, [3]], {"k": 1}, true, 1e21]"#).expect("array");
    assert_eq!(
        js_string_coerce(&value),
        "1,,a,2,3,[object Object],true,1e+21"
    );
}
