//! Endpoint capability probe policy that decides whether a turn keeps native tool search and
//! programmatic tool calling. Official and OpenRouter hosts are classified from the base URL, so
//! these cases call the interpreters directly instead of those networks. The live tests use a
//! loopback server for header, path, cache, and explicit-denial wiring.

use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::header,
    response::{IntoResponse, Response},
};
use cowork_config::ProviderName;
use reqwest::StatusCode;
use serde_json::json;

use super::{
    EndpointCapabilitySource, EndpointToolCapabilities, NativeProgrammaticToolCallingKind,
    NativeToolSearchKind, ProbeFacts, anthropic_model_supports_native_tool_features,
    check_endpoint_capabilities, has_cached_endpoint_check, interpret_anthropic_model_probe,
    interpret_openai_model_probe, openai_model_supports_native_tool_features,
    probe_transport_error_fallback, record_rejected_native_capability,
};

const NOW_MS: u64 = 1_700_000_000_000;
const ENCODED_MODEL: &str = "model%2Fid";

type Features = (
    Option<NativeToolSearchKind>,
    Option<NativeProgrammaticToolCallingKind>,
);

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).expect("http status")
}

fn seed(
    search: Option<NativeToolSearchKind>,
    ptc: Option<NativeProgrammaticToolCallingKind>,
) -> EndpointToolCapabilities {
    EndpointToolCapabilities {
        provider: "static-provider".to_owned(),
        model_id: "seed-model".to_owned(),
        endpoint_host: Some("seed.example".to_owned()),
        native_tool_search: search,
        native_programmatic_tool_calling: ptc,
        source: EndpointCapabilitySource::StaticClassifier,
        checked_at_ms: None,
        detail: Some("static".to_owned()),
    }
}

fn facts<'a>(
    caps: &'a EndpointToolCapabilities,
    official: bool,
    openrouter: bool,
    model_id: &'a str,
) -> ProbeFacts<'a> {
    ProbeFacts {
        is_official: official,
        is_openrouter: openrouter,
        model_id,
        encoded_model: ENCODED_MODEL,
        static_caps: caps,
        now_ms: NOW_MS,
    }
}

fn features(caps: &EndpointToolCapabilities) -> Features {
    (
        caps.native_tool_search,
        caps.native_programmatic_tool_calling,
    )
}

fn assert_probe_identity(
    caps: &EndpointToolCapabilities,
    provider: &str,
    model_id: &str,
    label: &str,
) {
    assert_eq!(caps.provider, provider, "{label} provider");
    assert_eq!(caps.model_id, model_id, "{label} model id");
    assert_eq!(
        caps.endpoint_host.as_deref(),
        Some("seed.example"),
        "{label} host"
    );
    assert_eq!(
        caps.source,
        EndpointCapabilitySource::EndpointCheck,
        "{label}"
    );
    assert_eq!(caps.checked_at_ms, Some(NOW_MS), "{label} checked at");
    let detail = caps.detail.as_deref().unwrap_or("");
    assert!(
        detail.contains(ENCODED_MODEL),
        "{label} detail should name the encoded model, got {detail}"
    );
}

#[test]
fn openai_status_preserves_official_auth_errors_and_openrouter_model_404s() {
    let seeded = seed(
        Some(NativeToolSearchKind::OpenAiResponses),
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
    );
    let seeded_features = features(&seeded);
    // label, status, official, openrouter, preserve static features
    let cases = [
        ("official 401", 401, true, false, true),
        ("official 403", 403, true, false, true),
        ("official 404", 404, true, false, false),
        ("official 400", 400, true, false, false),
        ("official 500", 500, true, false, false),
        ("official 200 without a json body", 200, true, false, false),
        ("openrouter 404", 404, false, true, true),
        ("openrouter 401", 401, false, true, true),
        ("openrouter 403", 403, false, true, true),
        ("openrouter 400", 400, false, true, false),
        ("openrouter 500", 500, false, true, false),
        ("custom 401", 401, false, false, false),
        ("custom 404", 404, false, false, false),
        (
            "openrouter 404 still preserves when the official flag is also set",
            404,
            true,
            true,
            true,
        ),
        ("500 preserves neither flag", 500, true, true, false),
    ];

    for (label, code, official, openrouter, preserve) in cases {
        let caps = interpret_openai_model_probe(
            status(code),
            None,
            false,
            &facts(&seeded, official, openrouter, "requested-id"),
        );
        let detail = caps.detail.clone().unwrap_or_default();
        assert_probe_identity(&caps, "openai", "requested-id", label);
        assert!(
            detail.contains(&format!("HTTP {code}")),
            "{label} detail should include the status, got {detail}"
        );
        if preserve {
            assert_eq!(features(&caps), seeded_features, "{label}");
            assert!(
                detail.contains("preserving host/model capabilities"),
                "{label} got {detail}"
            );
        } else {
            assert_eq!(features(&caps), (None, None), "{label}");
            assert!(
                detail.contains("using Cowork harness"),
                "{label} got {detail}"
            );
        }
    }

    let denial = json!({
        "id": "gpt-4.1",
        "capabilities": {
            "tool_search": false,
            "programmatic_tool_calling": false
        }
    });
    let auth_body = interpret_openai_model_probe(
        status(401),
        Some(&denial),
        false,
        &facts(&seeded, true, false, "gpt-5.4"),
    );
    assert_eq!(
        features(&auth_body),
        seeded_features,
        "a 401 body must not be read as a capability denial"
    );
}

#[test]
fn anthropic_status_preserves_auth_errors_on_official_and_openrouter_but_not_404() {
    let seeded = seed(
        Some(NativeToolSearchKind::AnthropicBm25),
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
    );
    let seeded_features = features(&seeded);
    let cases = [
        ("official 401", 401, true, false, true),
        ("official 403", 403, true, false, true),
        ("official 404", 404, true, false, false),
        ("official 400", 400, true, false, false),
        ("official 500", 500, true, false, false),
        ("official 200 without a json body", 200, true, false, false),
        ("openrouter 401", 401, false, true, true),
        ("openrouter 403", 403, false, true, true),
        ("openrouter 404", 404, false, true, false),
        ("openrouter 500", 500, false, true, false),
        ("custom 401", 401, false, false, false),
        ("custom 403", 403, false, false, false),
        ("both flags 404", 404, true, true, false),
        ("both flags 401", 401, true, true, true),
    ];

    for (label, code, official, openrouter, preserve) in cases {
        let caps = interpret_anthropic_model_probe(
            status(code),
            None,
            &facts(&seeded, official, openrouter, "requested-id"),
        );
        let detail = caps.detail.clone().unwrap_or_default();
        assert_probe_identity(&caps, "anthropic", "requested-id", label);
        assert!(
            detail.contains(&format!("HTTP {code}")),
            "{label} detail should include the status, got {detail}"
        );
        if preserve {
            assert_eq!(features(&caps), seeded_features, "{label}");
            assert!(
                detail.contains("preserving static host/model capabilities"),
                "{label} got {detail}"
            );
        } else {
            assert_eq!(features(&caps), (None, None), "{label}");
            assert!(
                detail.contains("using Cowork harness"),
                "{label} got {detail}"
            );
        }
    }

    let denial = json!({
        "type": "model",
        "id": "claude-haiku-4-5",
        "capabilities": { "code_execution": false, "tool_search": false }
    });
    let auth_body = interpret_anthropic_model_probe(
        status(403),
        Some(&denial),
        &facts(&seeded, true, false, "claude-sonnet-4-6"),
    );
    assert_eq!(
        features(&auth_body),
        seeded_features,
        "a 403 body must not be read as a capability denial"
    );
}

#[test]
fn transport_errors_keep_official_features_and_drop_openrouter_programmatic_calling() {
    let seeded = seed(
        Some(NativeToolSearchKind::OpenAiResponses),
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
    );
    let err = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "connection refused");
    let cases = [
        ("official", true, false, true, true),
        ("openrouter", false, true, true, false),
        ("official openrouter", true, true, true, true),
        ("custom", false, false, false, false),
    ];
    for (label, official, openrouter, keep_search, keep_ptc) in cases {
        let caps = probe_transport_error_fallback(
            &err,
            &facts(&seeded, official, openrouter, "requested-id"),
        );
        assert_eq!(caps.provider, "static-provider", "{label}");
        assert_eq!(caps.model_id, "requested-id", "{label}");
        assert_eq!(
            caps.endpoint_host.as_deref(),
            Some("seed.example"),
            "{label}"
        );
        assert_eq!(
            caps.source,
            EndpointCapabilitySource::EndpointCheck,
            "{label}"
        );
        assert_eq!(caps.checked_at_ms, Some(NOW_MS), "{label}");
        let detail = caps.detail.as_deref().unwrap_or("");
        assert!(
            detail.contains("Endpoint probe failed")
                && detail.contains("connection refused")
                && detail.contains("using fallback resolution"),
            "{label} got {detail}"
        );
        assert_eq!(
            caps.native_tool_search.is_some(),
            keep_search,
            "{label} tool search"
        );
        assert_eq!(
            caps.native_programmatic_tool_calling.is_some(),
            keep_ptc,
            "{label} programmatic calling"
        );
        if keep_search {
            assert_eq!(
                caps.native_tool_search,
                Some(NativeToolSearchKind::OpenAiResponses),
                "{label}"
            );
        }
        if keep_ptc {
            assert_eq!(
                caps.native_programmatic_tool_calling,
                Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
                "{label}"
            );
        }
    }
}

#[test]
fn openai_success_trusts_explicit_capabilities_body_id_and_ownership() {
    let seeded = seed(None, None);
    let both = (
        Some(NativeToolSearchKind::OpenAiResponses),
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
    );
    let openrouter_search = (Some(NativeToolSearchKind::OpenRouterResponses), None);
    let ptc_only = (
        None,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
    );
    let cases = [
        (
            "body id gpt-5.4 overrides an ineligible requested id",
            "local-llama",
            json!({"id": "gpt-5.4", "owned_by": "community"}),
            true,
            false,
            false,
            both,
        ),
        (
            "body id gpt-4.1 overrides an eligible requested id",
            "gpt-5.4",
            json!({"id": "gpt-4.1", "owned_by": "openai"}),
            true,
            false,
            false,
            (None, None),
        ),
        (
            "empty body id does not fall back to the requested id",
            "gpt-5.4",
            json!({"id": "", "owned_by": "openai"}),
            true,
            false,
            false,
            (None, None),
        ),
        (
            "missing body id uses the requested id",
            "gpt-5.4",
            json!({"owned_by": "community"}),
            true,
            false,
            false,
            both,
        ),
        (
            "explicit false wins over an eligible owned model",
            "gpt-5.4",
            json!({
                "id": "gpt-5.4",
                "owned_by": "openai",
                "capabilities": {
                    "tool_search": false,
                    "programmatic_tool_calling": {"supported": false}
                }
            }),
            true,
            false,
            false,
            (None, None),
        ),
        (
            "explicit tool-search false leaves programmatic calling to the heuristic",
            "gpt-5.4",
            json!({"id": "gpt-5.4", "owned_by": "openai", "capabilities": {"tool_search": false}}),
            true,
            false,
            false,
            ptc_only,
        ),
        (
            "explicit true enables an ineligible model",
            "gpt-4.1",
            json!({
                "id": "gpt-4.1",
                "capabilities": {"tool_search": true, "programmatic_tool_calling": true}
            }),
            false,
            false,
            false,
            both,
        ),
        (
            "openrouter implicit caps enable tool search only",
            "openai/gpt-5.4",
            json!({"id": "openai/gpt-5.4"}),
            false,
            true,
            false,
            openrouter_search,
        ),
        (
            "openrouter explicit programmatic calling stays off",
            "openai/gpt-5.4",
            json!({
                "id": "openai/gpt-5.4",
                "capabilities": {"tool_search": true, "programmatic_tool_calling": true}
            }),
            false,
            true,
            false,
            openrouter_search,
        ),
        (
            "custom unowned model without explicit caps stays on the harness",
            "gpt-5.4",
            json!({"id": "gpt-5.4", "owned_by": "community"}),
            false,
            false,
            false,
            (None, None),
        ),
        (
            "owned_by OpenAI is case-insensitive on a custom host",
            "gpt-5.4",
            json!({"id": "gpt-5.4", "owned_by": "OpenAI"}),
            false,
            false,
            false,
            both,
        ),
        (
            "owned_by system enables an eligible model",
            "gpt-5.4",
            json!({"id": "gpt-5.4", "owned_by": "SYSTEM"}),
            false,
            false,
            false,
            both,
        ),
        (
            "openai-processing-ms counts as OpenAI ownership without owned_by",
            "gpt-5.4",
            json!({"id": "gpt-5.4", "owned_by": "other"}),
            false,
            false,
            true,
            both,
        ),
        (
            "ownership does not enable an ineligible model",
            "gpt-4.1",
            json!({"id": "gpt-4.1", "owned_by": "openai-internal"}),
            false,
            false,
            false,
            (None, None),
        ),
        (
            "non-object success body still uses the requested id heuristic",
            "gpt-5.4",
            json!(["not-a-model"]),
            true,
            false,
            false,
            both,
        ),
    ];

    assert!(openai_model_supports_native_tool_features("gpt-5.4"));
    assert!(!openai_model_supports_native_tool_features("gpt-4.1"));

    for (label, model_id, body, official, openrouter, processing, expected) in cases {
        let caps = interpret_openai_model_probe(
            status(200),
            Some(&body),
            processing,
            &facts(&seeded, official, openrouter, model_id),
        );
        assert_probe_identity(&caps, "openai", model_id, label);
        let detail = caps.detail.as_deref().unwrap_or("");
        assert!(
            detail.contains("Verified via GET /models/"),
            "{label} got {detail}"
        );
        assert_eq!(features(&caps), expected, "{label}");
    }
}

#[test]
fn anthropic_success_trusts_explicit_capabilities_and_model_payload() {
    let seeded = seed(None, None);
    let both = (
        Some(NativeToolSearchKind::AnthropicBm25),
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
    );
    let search_only = (Some(NativeToolSearchKind::AnthropicBm25), None);
    let ptc_only = (
        None,
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
    );
    let openrouter_search = (Some(NativeToolSearchKind::AnthropicRegex), None);
    let cases = [
        (
            "body id sonnet overrides an ineligible requested id",
            "local-model",
            json!({"id": "claude-sonnet-4-6"}),
            true,
            false,
            both,
        ),
        (
            "body id haiku overrides an eligible requested id",
            "claude-sonnet-4-6",
            json!({"id": "claude-haiku-4-5"}),
            true,
            false,
            (None, None),
        ),
        (
            "empty body id does not fall back to the requested id",
            "claude-sonnet-4-6",
            json!({"id": ""}),
            true,
            false,
            (None, None),
        ),
        (
            "missing body id uses the requested id",
            "claude-sonnet-4-6",
            json!({}),
            true,
            false,
            both,
        ),
        (
            "explicit false code execution leaves tool search on",
            "claude-sonnet-4-6",
            json!({"id": "claude-sonnet-4-6", "capabilities": {"code_execution": false}}),
            true,
            false,
            search_only,
        ),
        (
            "explicit false tool search leaves code execution on",
            "claude-sonnet-4-6",
            json!({"id": "claude-sonnet-4-6", "capabilities": {"tool_search": {"supported": false}}}),
            true,
            false,
            ptc_only,
        ),
        (
            "explicit false on both wins over an eligible model",
            "claude-sonnet-4-6",
            json!({
                "id": "claude-sonnet-4-6",
                "capabilities": {"code_execution": {"supported": false}, "tool_search": false}
            }),
            true,
            false,
            (None, None),
        ),
        (
            "type model keeps tool search when code execution is explicitly false",
            "claude-sonnet-4-6",
            json!({
                "type": "model",
                "id": "claude-sonnet-4-6",
                "capabilities": {"code_execution": false}
            }),
            false,
            false,
            search_only,
        ),
        (
            "custom host without a model payload does not infer features",
            "claude-sonnet-4-6",
            json!({"id": "claude-sonnet-4-6"}),
            false,
            false,
            (None, None),
        ),
        (
            "explicit code execution enables haiku and omitted tool search stays off",
            "claude-haiku-4-5",
            json!({"type": "model", "id": "claude-haiku-4-5", "capabilities": {"code_execution": true}}),
            false,
            false,
            ptc_only,
        ),
        (
            "openrouter implicit caps enable regex tool search only",
            "anthropic/claude-sonnet-4-6",
            json!({"id": "claude-sonnet-4-6"}),
            false,
            true,
            openrouter_search,
        ),
        (
            "openrouter explicit code execution stays off",
            "claude-sonnet-4-6",
            json!({
                "id": "claude-sonnet-4-6",
                "capabilities": {"tool_search": true, "code_execution": true}
            }),
            false,
            true,
            openrouter_search,
        ),
        (
            "explicit tool search enables haiku on openrouter",
            "claude-haiku-4-5",
            json!({"id": "claude-haiku-4-5", "capabilities": {"tool_search": {"supported": true}}}),
            false,
            true,
            openrouter_search,
        ),
    ];

    assert!(anthropic_model_supports_native_tool_features(
        "claude-sonnet-4-6"
    ));
    assert!(!anthropic_model_supports_native_tool_features(
        "claude-haiku-4-5"
    ));

    for (label, model_id, body, official, openrouter, expected) in cases {
        let caps = interpret_anthropic_model_probe(
            status(200),
            Some(&body),
            &facts(&seeded, official, openrouter, model_id),
        );
        assert_probe_identity(&caps, "anthropic", model_id, label);
        let detail = caps.detail.as_deref().unwrap_or("");
        assert!(
            detail.contains("Verified via GET /v1/models/"),
            "{label} got {detail}"
        );
        assert_eq!(features(&caps), expected, "{label}");
    }
}

#[derive(Clone, Debug)]
struct ProbeHit {
    path: String,
    authorization: Option<String>,
    api_key: Option<String>,
    anthropic_version: Option<String>,
    accept: Option<String>,
}

fn header_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn record_probe(State(hits): State<Arc<Mutex<Vec<ProbeHit>>>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let headers = request.headers();
    hits.lock().expect("probe hits").push(ProbeHit {
        path: path.clone(),
        authorization: header_value(headers, header::AUTHORIZATION.as_str()),
        api_key: header_value(headers, "x-api-key"),
        anthropic_version: header_value(headers, "anthropic-version"),
        accept: header_value(headers, header::ACCEPT.as_str()),
    });
    let model = path.rsplit('/').next().unwrap_or("");
    if model.contains("explicit-off") {
        return Json(json!({
            "id": "gpt-5.4",
            "owned_by": "OpenAI",
            "capabilities": {
                "tool_search": false,
                "programmatic_tool_calling": {"supported": false}
            }
        }))
        .into_response();
    }
    if model.contains("refresh-restores") {
        return Json(json!({
            "id": "gpt-5.4",
            "owned_by": "openai",
            "capabilities": {"tool_search": true, "programmatic_tool_calling": true}
        }))
        .into_response();
    }
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .expect("401 response")
}

async fn spawn_probe_server() -> (String, Arc<Mutex<Vec<ProbeHit>>>) {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(record_probe)
        .with_state(Arc::clone(&hits));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback probe");
    let addr = listener.local_addr().expect("probe addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), hits)
}

fn hit_named<'a>(hits: &'a [ProbeHit], needle: &str) -> &'a ProbeHit {
    hits.iter()
        .find(|hit| hit.path.contains(needle))
        .unwrap_or_else(|| panic!("missing probe for {needle} in {hits:?}"))
}

#[tokio::test]
async fn live_probe_trims_auth_encodes_the_model_and_joins_anthropic_v1_once() {
    let (origin, hits) = spawn_probe_server().await;
    let v1 = format!("{origin}/v1");
    let gateway = format!("{origin}/gateway");

    check_endpoint_capabilities(
        ProviderName::Anthropic,
        Some(&v1),
        "claude-sonnet-4-6-oat",
        Some("  sk-ant-oat01-probe  "),
        None,
        true,
    )
    .await;
    check_endpoint_capabilities(
        ProviderName::Anthropic,
        Some(&v1),
        "claude-sonnet-4-6-key",
        Some("  sk-ant-api03-probe  "),
        None,
        true,
    )
    .await;
    check_endpoint_capabilities(
        ProviderName::Anthropic,
        Some(&gateway),
        "claude-sonnet-4-6-gateway",
        Some("sk-ant-api03-gateway"),
        None,
        true,
    )
    .await;
    check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&format!("{v1}/")),
        "openai/gpt-5.4+mini",
        Some("  sk-live  "),
        None,
        true,
    )
    .await;

    let recorded = hits.lock().expect("hits").clone();
    assert!(
        recorded.iter().all(|hit| !hit.path.contains("/v1/v1/")),
        "anthropic base ending in /v1 must not gain a second /v1: {recorded:?}"
    );

    let oat = hit_named(&recorded, "/v1/models/claude-sonnet-4-6-oat");
    assert_eq!(
        oat.authorization.as_deref(),
        Some("Bearer sk-ant-oat01-probe")
    );
    assert_eq!(oat.api_key, None);
    assert_eq!(oat.anthropic_version.as_deref(), Some("2023-06-01"));
    assert_eq!(oat.accept.as_deref(), Some("application/json"));

    let key = hit_named(&recorded, "/v1/models/claude-sonnet-4-6-key");
    assert_eq!(key.authorization, None);
    assert_eq!(key.api_key.as_deref(), Some("sk-ant-api03-probe"));
    assert_eq!(key.anthropic_version.as_deref(), Some("2023-06-01"));

    let routed = hit_named(&recorded, "/gateway/v1/models/claude-sonnet-4-6-gateway");
    assert_eq!(routed.api_key.as_deref(), Some("sk-ant-api03-gateway"));

    let encoded = hit_named(&recorded, "/v1/models/gpt-5.4%2Bmini");
    assert!(
        !encoded.path.contains("openai/"),
        "non-OpenRouter OpenAI probes strip the provider prefix: {}",
        encoded.path
    );
    assert_eq!(encoded.authorization.as_deref(), Some("Bearer sk-live"));
}

#[tokio::test]
async fn custom_host_explicit_denial_downgrades_an_owned_eligible_model() {
    let (origin, hits) = spawn_probe_server().await;
    let base = format!("{origin}/v1");
    let caps = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        "gpt-5.4-explicit-off",
        Some("sk-test"),
        None,
        true,
    )
    .await;
    assert_eq!(caps.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(features(&caps), (None, None));
    let detail = caps.detail.as_deref().unwrap_or("");
    assert!(
        detail.contains("Verified via GET /models/gpt-5.4-explicit-off"),
        "{detail}"
    );
    assert_eq!(hits.lock().expect("hits").len(), 1);
    assert!(has_cached_endpoint_check(
        ProviderName::Openai,
        Some(&base),
        "gpt-5.4-explicit-off",
    ));
}

#[tokio::test]
async fn rejection_cache_skips_the_network_until_force_refresh() {
    let official = "https://api.openai.com/v1";
    let model = "gpt-5.4-probe-rejection-hold";
    record_rejected_native_capability(
        ProviderName::Openai,
        Some(official),
        model,
        true,
        false,
        "tool_search unsupported",
    );
    assert!(has_cached_endpoint_check(
        ProviderName::Openai,
        Some(official),
        model,
    ));
    let held = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(official),
        model,
        Some("sk-test"),
        None,
        false,
    )
    .await;
    assert_eq!(held.source, EndpointCapabilitySource::RuntimeFallback);
    assert_eq!(held.native_tool_search, None);
    assert_eq!(
        held.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );
    let detail = held.detail.as_deref().unwrap_or("");
    assert!(
        detail.contains("fell back to Cowork harness"),
        "cached rejection must not probe api.openai.com, got {detail}"
    );

    let (origin, hits) = spawn_probe_server().await;
    let base = format!("{origin}/v1");
    let refresh_model = "gpt-5.4-refresh-restores";
    record_rejected_native_capability(
        ProviderName::Openai,
        Some(&base),
        refresh_model,
        true,
        true,
        "both rejected",
    );
    let blocked = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        refresh_model,
        Some("sk-test"),
        None,
        false,
    )
    .await;
    assert_eq!(features(&blocked), (None, None));
    assert_eq!(blocked.source, EndpointCapabilitySource::RuntimeFallback);
    assert!(
        hits.lock().expect("hits").is_empty(),
        "a fresh rejection is served from the cache"
    );

    let refreshed = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        refresh_model,
        Some("sk-test"),
        None,
        true,
    )
    .await;
    assert_eq!(
        features(&refreshed),
        (
            Some(NativeToolSearchKind::OpenAiResponses),
            Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
        )
    );
    assert_eq!(refreshed.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(hits.lock().expect("hits").len(), 1);

    let cached = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        refresh_model,
        Some("sk-test"),
        None,
        false,
    )
    .await;
    assert_eq!(features(&cached), features(&refreshed));
    assert_eq!(cached.checked_at_ms, refreshed.checked_at_ms);
    assert_eq!(
        hits.lock().expect("hits").len(),
        1,
        "the refreshed probe replaces the rejection and is reused"
    );
}

#[tokio::test]
async fn blank_api_key_and_non_openai_providers_do_not_probe() {
    let (origin, hits) = spawn_probe_server().await;
    let base = format!("{origin}/v1");
    for key in [None, Some(""), Some("   "), Some("\t")] {
        let caps = check_endpoint_capabilities(
            ProviderName::Openai,
            Some(&base),
            "gpt-5.4-blank-key",
            key,
            None,
            true,
        )
        .await;
        assert_eq!(caps.source, EndpointCapabilitySource::StaticClassifier);
        let detail = caps.detail.as_deref().unwrap_or("");
        assert!(
            detail.contains("no API key configured for live endpoint probe"),
            "{detail}"
        );
        assert!(!has_cached_endpoint_check(
            ProviderName::Openai,
            Some(&base),
            "gpt-5.4-blank-key",
        ));
    }
    assert!(hits.lock().expect("hits").is_empty());

    let followed = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        "gpt-5.4-after-blank",
        Some("sk-follow"),
        None,
        true,
    )
    .await;
    assert_eq!(followed.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(hits.lock().expect("hits").len(), 1);
    assert_eq!(
        hit_named(&hits.lock().expect("hits"), "gpt-5.4-after-blank")
            .authorization
            .as_deref(),
        Some("Bearer sk-follow")
    );

    let before_google = hits.lock().expect("hits").len();
    let google = check_endpoint_capabilities(
        ProviderName::Google,
        Some(&base),
        "gemini-2.5-pro",
        Some("secret"),
        None,
        true,
    )
    .await;
    assert_eq!(google.source, EndpointCapabilitySource::StaticClassifier);
    assert_eq!(features(&google), (None, None));
    assert!(google.checked_at_ms.is_some());
    let detail = google.detail.as_deref().unwrap_or("");
    assert!(detail.contains("built-in Rust toolSearch"), "{detail}");
    assert!(!detail.contains("no API key"));
    assert!(!has_cached_endpoint_check(
        ProviderName::Google,
        Some(&base),
        "gemini-2.5-pro",
    ));
    assert_eq!(hits.lock().expect("hits").len(), before_google);
}

#[tokio::test]
async fn custom_host_auth_failure_is_a_cached_harness_fallback() {
    let (origin, hits) = spawn_probe_server().await;
    let base = format!("{origin}/v1");
    let model = "gpt-5.4-custom-unauthorized";
    let caps = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        model,
        Some("sk-test"),
        None,
        true,
    )
    .await;
    assert_eq!(caps.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(features(&caps), (None, None));
    let detail = caps.detail.clone().unwrap_or_default();
    assert!(
        detail.contains("HTTP 401") && detail.contains("using Cowork harness"),
        "{detail}"
    );
    assert!(!detail.contains("preserving"));
    assert!(has_cached_endpoint_check(
        ProviderName::Openai,
        Some(&base),
        model,
    ));

    let again = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        model,
        Some("sk-test"),
        None,
        false,
    )
    .await;
    assert_eq!(again.detail.as_deref(), Some(detail.as_str()));
    assert_eq!(again.checked_at_ms, caps.checked_at_ms);
    assert_eq!(hits.lock().expect("hits").len(), 1);
}

#[tokio::test]
async fn connection_refused_probe_is_cached() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind closed port");
    let addr = listener.local_addr().expect("closed addr");
    drop(listener);
    let base = format!("http://{addr}/v1");
    let model = "gpt-5.4-offline-probe";
    let caps = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        model,
        Some("sk-test"),
        None,
        true,
    )
    .await;
    let detail = caps.detail.clone().unwrap_or_default();
    assert!(
        detail.contains("Endpoint probe failed") && detail.contains("using fallback resolution"),
        "{detail}"
    );
    assert_eq!(caps.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(features(&caps), (None, None));
    assert!(has_cached_endpoint_check(
        ProviderName::Openai,
        Some(&base),
        model,
    ));
    let again = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&base),
        model,
        Some("sk-test"),
        None,
        false,
    )
    .await;
    assert_eq!(again.checked_at_ms, caps.checked_at_ms);
    assert_eq!(again.detail, caps.detail);
}
