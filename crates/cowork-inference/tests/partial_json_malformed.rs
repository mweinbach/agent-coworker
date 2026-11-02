//! Regression coverage for the streaming tool-argument parser on malformed or chunk-split
//! input: escapes, multibyte text and surrogate pairs must never panic the projector.

use cowork_inference::{StreamingToolDeltaParser, parse_partial_json, parse_partial_json_object};
use serde_json::{Value, json};

fn object(input: &str) -> Value {
    Value::Object(parse_partial_json_object(input))
}

#[test]
fn unicode_escape_followed_by_multibyte_char_does_not_panic() {
    // Reported input: the byte-length check passes but the 4 bytes end inside `é`.
    let input = "{\"x\":\"\\u123\u{e9}\"}";
    let mut parser = StreamingToolDeltaParser::new();
    assert_eq!(Value::Object(parser.push_delta(input)), json!({"x": ""}));
    assert!(parser.finalize().is_err());

    for input in [
        "{\"x\":\"ok\\u\u{e9}\u{e9}\u{e9}\"}",
        "{\"x\":\"ok\\u1\u{1F600}\"}",
        "{\"x\":\"ok\\u12\u{4e2d}\u{6587}\"}",
        "{\"x\":\"ok\\uZZZZ\", \"y\": 1}",
    ] {
        assert_eq!(object(input), json!({"x": "ok"}), "input: {input:?}");
    }
}

#[test]
fn truncated_unicode_escape_waits_for_more_bytes() {
    for input in [
        "{\"x\":\"ab\\",
        "{\"x\":\"ab\\u",
        "{\"x\":\"ab\\u1",
        "{\"x\":\"ab\\u12",
        "{\"x\":\"ab\\u123",
    ] {
        assert_eq!(object(input), json!({"x": "ab"}), "input: {input:?}");
    }
    assert_eq!(object("{\"x\":\"ab\\u00e9"), json!({"x": "ab\u{e9}"}));

    let mut parser = StreamingToolDeltaParser::new();
    assert_eq!(
        Value::Object(parser.push_delta("{\"x\":\"\u{e9}\\u0")),
        json!({"x": "\u{e9}"})
    );
    assert_eq!(
        Value::Object(parser.push_delta("0e9\"}")),
        json!({"x": "\u{e9}\u{e9}"})
    );
    assert_eq!(
        Value::Object(parser.finalize().expect("valid json")),
        json!({"x": "\u{e9}\u{e9}"})
    );
}

#[test]
fn surrogate_pairs_and_lone_surrogates_decode_without_panicking() {
    // Pair split across the partial view is combined, or dropped until complete.
    assert_eq!(
        object("{\"x\":\"a\\uD83D\\uDE00"),
        json!({"x": "a\u{1F600}"})
    );
    for input in [
        "{\"x\":\"a\\uD83D",
        "{\"x\":\"a\\uD83D\\",
        "{\"x\":\"a\\uD83D\\u",
        "{\"x\":\"a\\uD83D\\uDE0",
    ] {
        assert_eq!(object(input), json!({"x": "a"}), "input: {input:?}");
    }

    // Lone or mismatched surrogates become U+FFFD instead of being lost or panicking.
    assert_eq!(object("{\"x\":\"\\uD83Dz"), json!({"x": "\u{FFFD}z"}));
    assert_eq!(object("{\"x\":\"\\uDE00z"), json!({"x": "\u{FFFD}z"}));
    assert_eq!(object("{\"x\":\"\\uD83D\\u0041"), json!({"x": "\u{FFFD}A"}));
    assert_eq!(
        object("{\"x\":\"\\uD83D\\uD83D\\uDE00"),
        json!({"x": "\u{FFFD}\u{1F600}"})
    );
    assert_eq!(object("{\"x\":\"\\uD83D\\n"), json!({"x": "\u{FFFD}\n"}));
    assert_eq!(object("{\"x\":\"\\uD83D\\uZZZZ"), json!({"x": "\u{FFFD}"}));

    let mut parser = StreamingToolDeltaParser::new();
    for delta in ["{\"x\":\"\\uD8", "3D\\u", "DE00\"}"] {
        parser.push_delta(delta);
    }
    assert_eq!(
        Value::Object(parser.finalize().expect("valid json")),
        json!({"x": "\u{1F600}"})
    );
}

#[test]
fn unknown_escape_truncates_like_partial_json() {
    assert_eq!(object("{\"x\":\"a\\qb\", \"y\": 1}"), json!({"x": "a"}));
}

#[test]
fn deeply_nested_malformed_input_does_not_overflow_the_stack() {
    let input = "[".repeat(200_000);
    assert!(parse_partial_json(&input).is_array());
    let mut parser = StreamingToolDeltaParser::new();
    assert!(
        parser
            .push_delta(&format!("{{\"x\":{input}"))
            .contains_key("x")
    );
}

/// Feeds every char-boundary prefix of each document through the parser (both as one buffer and
/// as successive deltas) and checks that nothing panics and the full document round-trips.
#[test]
fn every_prefix_of_multibyte_and_escaped_documents_parses_without_panicking() {
    let documents = [
        r#"{"cmd": "echo \"h\u00e9llo\" \u4e2d\u6587 \ud83d\ude00", "n": -12.5e3}"#,
        "{\"path\": \"/tmp/caf\u{e9}/\u{1F600}.txt\", \"flags\": [\"--\u{e9}\", true, null]}",
        r#"{"a": {"b": ["\\", "\/", "\b\f\n\r\t", "\u0000\u001f"]}, "c": false}"#,
        "{\"mixed\": \"\u{e9}\\u00e9\u{1F600}\\ud83d\\ude00\u{4e2d}\\n\"}",
        // Malformed inputs the provider might stream before final validation rejects them.
        "{\"x\":\"\\u123\u{e9}\u{e9}\u{e9}\u{e9}\"}",
        "{\"x\":\"\\ud83d\u{e9}\\udc00\u{1F600}\\uzz\u{e9}\"}",
        "{\"x\":\"\\\u{e9}\\\u{1F600}\"}",
        "{\"x\": [1, 2, {\"y\": \"\\u\"}]}",
    ];

    for document in documents {
        let boundaries: Vec<usize> = (0..=document.len())
            .filter(|idx| document.is_char_boundary(*idx))
            .collect();

        for &end in &boundaries {
            let _ = parse_partial_json(&document[..end]);
        }

        let mut parser = StreamingToolDeltaParser::new();
        for pair in boundaries.windows(2) {
            parser.push_delta(&document[pair[0]..pair[1]]);
        }
        assert_eq!(parser.buffer(), document);

        if let Ok(expected) = serde_json::from_str::<Value>(document) {
            assert_eq!(parse_partial_json(document), expected);
            assert_eq!(
                Value::Object(parser.finalize().expect("valid json")),
                expected
            );
        } else {
            assert!(parser.finalize().is_err(), "document: {document:?}");
        }
    }
}
