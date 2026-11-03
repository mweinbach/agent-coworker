//! `strip_provider_option_endpoints` is the filter every untrusted `providerOptions` input goes
//! through (session `cowork/session/config/set` overrides, `cowork/session/defaults/apply`,
//! resumed session overrides, child routing and the workspace `.cowork/config.json` tier). Its
//! single `lmstudio.baseUrl` exception must only keep a loopback LM Studio server, so a paired
//! client cannot send prompts and the saved LM Studio token to a remote host.

use cowork_config::strip_provider_option_endpoints;
use serde_json::{Map, Value, json};

fn strip(value: Value) -> Map<String, Value> {
    let Value::Object(mut map) = value else {
        panic!("expected object");
    };
    strip_provider_option_endpoints(&mut map);
    map
}

#[test]
fn keeps_loopback_lmstudio_base_url() {
    for url in [
        "http://localhost:1234",
        "http://127.0.0.1:1234/v1",
        "https://[::1]:1234",
        "http://LOCALHOST",
    ] {
        let out = strip(json!({ "lmstudio": { "baseUrl": url, "contextLength": 4096 } }));
        assert_eq!(out["lmstudio"]["baseUrl"], url, "{url}");
        assert_eq!(out["lmstudio"]["contextLength"], 4096, "{url}");
    }
}

#[test]
fn drops_non_loopback_lmstudio_base_url_but_keeps_siblings() {
    for url in [
        json!("https://evil.example:1234"),
        json!("http://192.168.1.20:1234"),
        json!("http://localhost.evil.example"),
        json!("http://user@localhost:1234"),
        json!("ftp://localhost"),
        json!(""),
        json!(42),
        json!(null),
    ] {
        let out = strip(json!({
            "lmstudio": { "baseUrl": url.clone(), "autoLoad": false, "apiKey": "x" }
        }));
        let section = out["lmstudio"].as_object().unwrap();
        assert!(!section.contains_key("baseUrl"), "{url}");
        assert!(!section.contains_key("apiKey"), "{url}");
        assert_eq!(section["autoLoad"], false, "{url}");
    }
}

#[test]
fn still_strips_other_endpoint_overrides() {
    let out = strip(json!({
        "baseUrl": "http://localhost:1",
        "openai": { "baseUrl": "http://localhost:1234", "headers": { "x": "1" }, "reasoningEffort": "low" },
        "lmstudio": { "baseURL": "http://localhost:1234", "endpoint": "http://localhost:1234" }
    }));
    assert!(!out.contains_key("baseUrl"));
    assert_eq!(out["openai"], json!({ "reasoningEffort": "low" }));
    assert_eq!(out["lmstudio"], json!({}));
}
