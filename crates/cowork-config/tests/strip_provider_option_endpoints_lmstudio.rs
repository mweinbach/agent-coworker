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
        "http://127.0.0.1:65535",
        "https://[::1]:1234",
        "http://[::1]",
        "https://[::1]/v1",
        "http://[0:0:0:0:0:0:0:1]:1234",
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
        // A WHATWG parser rewrites these to loopback. This filter compares the raw host
        // and must keep rejecting them, or a cloned repo can aim LM Studio at an address
        // the next client interprets as 127.0.0.1 only after a laxer parse.
        json!("http://2130706433"),
        json!("http://2130706433:80/v1"),
        json!("http://0x7f000001"),
        json!("http://0x7f.0.0.1:1234"),
        json!("http://0177.0.0.1"),
        json!("http://127.1"),
        json!("http://127.0.1:1234"),
        json!("http://127.0.0.1."),
        json!("http://localhost."),
        json!("http://localhost.:1234"),
        json!("http://127%2e0%2e0%2e1:1234"),
        json!("http://127.0.0.1%00"),
        json!("http://127.0.0.1%2eevil.com"),
        json!("http://[::ffff:127.0.0.1]:1234"),
        json!("http://[::ffff:7f00:1]"),
        json!("http://[127.0.0.1]:1234"),
        json!("http://[::1%eth0]:1234"),
        json!("http://[::1"),
        json!("http://[::]"),
        json!("http://0.0.0.0:1234"),
        json!("http://[::1]80"),
        json!("http://127.0.0.1:65536"),
        json!("http://127.0.0.1:+80"),
        json!("http://127.0.0.1:80:80"),
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

#[test]
fn loopback_exception_is_only_the_lmstudio_base_url_key() {
    let out = strip(json!({
        "base_url": "http://127.0.0.1:1",
        "extraHeaders": { "Authorization": "Bearer secret" },
        "extra_headers": { "x-api-key": "secret" },
        "api_key": "sk-top",
        "openai": {
            "base_url": "http://127.0.0.1:1",
            "baseURL": "http://localhost:1",
            "extraHeaders": { "x": "1" },
            "api_key": "sk-openai",
            "reasoningEffort": "low"
        },
        "google": {
            "endpoint": "http://[::1]:1",
            "headers": { "x": "1" },
            "apiKey": "sk-google"
        },
        "lmstudio": {
            "baseUrl": "http://127.0.0.1:1234",
            "base_url": "http://127.0.0.1:9",
            "baseURL": "http://localhost:9",
            "endpoint": "http://[::1]:9",
            "extraHeaders": { "Authorization": "Bearer lm" },
            "api_key": "lm-secret",
            "contextLength": 2048
        }
    }));
    assert!(!out.contains_key("base_url"));
    assert!(!out.contains_key("extraHeaders"));
    assert!(!out.contains_key("extra_headers"));
    assert!(!out.contains_key("api_key"));
    assert_eq!(out["openai"], json!({ "reasoningEffort": "low" }));
    assert_eq!(out["google"], json!({}));
    assert_eq!(
        out["lmstudio"],
        json!({ "baseUrl": "http://127.0.0.1:1234", "contextLength": 2048 })
    );
}

#[test]
fn strips_untrusted_cowork_home_at_every_level() {
    let out = strip(json!({
        "coworkHome": "/repo/evil",
        "bedrock": { "coworkHome": "/repo/evil", "profile": "dev", "region": "us-east-1" }
    }));
    assert!(out.get("coworkHome").is_none());
    assert!(out["bedrock"].get("coworkHome").is_none());
    assert_eq!(out["bedrock"]["profile"], "dev");
    assert_eq!(out["bedrock"]["region"], "us-east-1");
}
