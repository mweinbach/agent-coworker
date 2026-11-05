use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use url::Url;

pub const EXPOSED_CORS_HEADERS: &str = "X-Cowork-File-Path, X-Cowork-Byte-Length, X-Cowork-Truncated, X-Cowork-File-Modified-At, X-Cowork-File-Change-Time, X-Cowork-File-Size, X-Cowork-File-Fingerprint";
pub const ALLOWED_CORS_METHODS: &str = "GET, POST, PATCH, DELETE, OPTIONS";
pub const ALLOWED_CORS_HEADERS: &str = "Authorization, Content-Type, Idempotency-Key, Sec-WebSocket-Protocol, X-Cowork-Browser-Token, X-Cowork-Client-Id";

/// Checks whether a host string refers to loopback (`127.0.0.1`, `::1`, `localhost`, `::ffff:127.0.0.1`).
pub fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim().to_ascii_lowercase();
    let stripped = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(&trimmed);
    matches!(
        stripped,
        "127.0.0.1" | "::1" | "localhost" | "::ffff:127.0.0.1"
    )
}

/// Returns `Some(origin)` iff `origin` parses as a URL with a loopback hostname.
pub fn pick_loopback_origin(origin: Option<&str>) -> Option<String> {
    let raw = origin?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = Url::parse(raw).ok()?;
    let host = parsed.host_str()?;
    is_loopback_host(host).then(|| raw.to_owned())
}

/// Checks whether `origin` is `"null"` or `file://...` (Electron `file://` renderer origins).
pub fn is_file_browser_origin(origin: Option<&str>) -> bool {
    let Some(raw) = origin else {
        return false;
    };
    let lower = raw.trim().to_ascii_lowercase();
    lower == "null" || lower.starts_with("file://")
}

/// True when an `Origin` header is present and is neither loopback nor `file://`/`"null"`.
pub fn has_untrusted_browser_origin(headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    origin.is_some_and(|o| {
        pick_loopback_origin(Some(o)).is_none() && !is_file_browser_origin(Some(o))
    })
}

/// True for server routes guarded by `browserAccessToken` (`/ws`, `/rpc`, `/cowork*`).
pub fn is_protected_server_path(pathname: &str) -> bool {
    pathname == "/ws" || pathname == "/rpc" || pathname.starts_with("/cowork")
}

/// Extracts `X-Cowork-Browser-Token` header first, falling back to `?coworkBrowserToken=` query param.
pub fn read_browser_access_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(hdr) = headers
        .get("x-cowork-browser-token")
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = hdr.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    let q = query?;
    for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
        if k == "coworkBrowserToken" {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// Attaches loopback CORS response headers when `Origin` is an allowed loopback origin.
pub fn apply_cors_headers(resp_headers: &mut HeaderMap, req_headers: &HeaderMap) {
    let origin = req_headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if let Some(allowed) = pick_loopback_origin(origin)
        && let Ok(val) = HeaderValue::from_str(&allowed)
    {
        resp_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
        resp_headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(EXPOSED_CORS_HEADERS),
        );
        resp_headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
}

/// Decision returned by the top-level Origin + CORS + `browserAccessToken` security gate.
#[derive(Debug)]
pub enum SecurityGateDecision {
    Allow,
    Reject {
        status: StatusCode,
        body: &'static str,
    },
    OptionsPreflight,
}

pub fn evaluate_security_gate(
    method: &Method,
    pathname: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    network_exposed_listener: bool,
    configured_browser_token: Option<&str>,
) -> SecurityGateDecision {
    if has_untrusted_browser_origin(headers) {
        return SecurityGateDecision::Reject {
            status: StatusCode::FORBIDDEN,
            body: "Forbidden origin",
        };
    }

    if method == Method::OPTIONS {
        return SecurityGateDecision::OptionsPreflight;
    }

    let has_browser_origin = headers.contains_key(header::ORIGIN);
    if is_protected_server_path(pathname) && (has_browser_origin || network_exposed_listener) {
        let Some(expected_token) = configured_browser_token.filter(|t| !t.is_empty()) else {
            return SecurityGateDecision::Reject {
                status: StatusCode::FORBIDDEN,
                body: "Browser access is not enabled for this server",
            };
        };
        let provided = read_browser_access_token(headers, query);
        if provided.as_deref() != Some(expected_token) {
            return SecurityGateDecision::Reject {
                status: StatusCode::UNAUTHORIZED,
                body: if has_browser_origin {
                    "Unauthorized browser access"
                } else {
                    "Unauthorized server access"
                },
            };
        }
    }

    SecurityGateDecision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                HeaderName::try_from(*name).expect("header name"),
                HeaderValue::from_str(value).expect("header value"),
            );
        }
        headers
    }

    fn origin(value: &str) -> HeaderMap {
        headers(&[(header::ORIGIN.as_str(), value)])
    }

    fn reject(decision: SecurityGateDecision) -> (StatusCode, &'static str) {
        match decision {
            SecurityGateDecision::Reject { status, body } => (status, body),
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn loopback_host_allowlist_is_exact() {
        for host in [
            "127.0.0.1",
            " 127.0.0.1 ",
            "::1",
            "[::1]",
            "LOCALHOST",
            "::ffff:127.0.0.1",
            "[::FFFF:127.0.0.1]",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in [
            "127.0.0.2",
            "127.0.0.1.evil.com",
            "localhost.evil.com",
            "evil.localhost",
            "localhost.",
            "[::1",
            "::1]",
            "::2",
            "0.0.0.0",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn untrusted_and_lookalike_origins_stay_forbidden_with_a_valid_token() {
        let token = Some("secret-browser-token");
        for raw in [
            "https://evil.example",
            "http://127.0.0.1.evil.com",
            "http://localhost.evil.com",
            "http://evil.localhost",
            "http://127.0.0.2:14330",
            "http://[::2]:14330",
            "https://api.openai.com",
            "   ",
            "",
        ] {
            let headers = origin(raw);
            assert_eq!(
                reject(evaluate_security_gate(
                    &Method::GET,
                    "/cowork/health",
                    Some("coworkBrowserToken=secret-browser-token"),
                    &headers,
                    false,
                    token,
                )),
                (StatusCode::FORBIDDEN, "Forbidden origin"),
                "{raw}"
            );
            assert_eq!(
                reject(evaluate_security_gate(
                    &Method::OPTIONS,
                    "/ws",
                    None,
                    &headers,
                    true,
                    token,
                )),
                (StatusCode::FORBIDDEN, "Forbidden origin"),
                "preflight {raw}"
            );
            let mut response_headers = HeaderMap::new();
            apply_cors_headers(&mut response_headers, &headers);
            assert!(
                response_headers
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .is_none(),
                "reflected CORS for {raw}"
            );
        }
    }

    #[test]
    fn loopback_file_and_null_origins_require_the_browser_token() {
        let token = Some("secret-browser-token");
        for raw in [
            "http://127.0.0.1:14330",
            "http://localhost",
            "http://LOCALHOST:9",
            "http://[::1]:14330",
            "file:///tmp/index.html",
            "File:///C:/app",
            "null",
            "NULL",
        ] {
            let headers = origin(raw);
            assert_eq!(
                reject(evaluate_security_gate(
                    &Method::GET,
                    "/cowork/health",
                    None,
                    &headers,
                    false,
                    token,
                )),
                (StatusCode::UNAUTHORIZED, "Unauthorized browser access"),
                "{raw}"
            );
            let mut authorized = headers.clone();
            authorized.insert(
                "x-cowork-browser-token",
                HeaderValue::from_static("secret-browser-token"),
            );
            assert!(
                matches!(
                    evaluate_security_gate(
                        &Method::GET,
                        "/rpc",
                        Some("coworkBrowserToken=wrong"),
                        &authorized,
                        false,
                        token,
                    ),
                    SecurityGateDecision::Allow
                ),
                "{raw}"
            );
            let mut cors = HeaderMap::new();
            apply_cors_headers(&mut cors, &headers);
            let reflected = cors
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|value| value.to_str().ok());
            if pick_loopback_origin(Some(raw)).is_some() {
                assert_eq!(reflected, Some(raw), "{raw}");
            } else {
                assert_eq!(reflected, None, "{raw}");
            }
        }

        assert!(matches!(
            evaluate_security_gate(
                &Method::OPTIONS,
                "/cowork/health",
                None,
                &origin("http://127.0.0.1:1"),
                false,
                token,
            ),
            SecurityGateDecision::OptionsPreflight
        ));
    }

    #[test]
    fn token_source_and_protected_paths_fail_closed() {
        let token = Some("secret");

        let mut padded = HeaderMap::new();
        padded.insert(
            "x-cowork-browser-token",
            HeaderValue::from_static("  secret  "),
        );
        assert!(matches!(
            evaluate_security_gate(
                &Method::GET,
                "/ws",
                Some("coworkBrowserToken=wrong"),
                &padded,
                true,
                token,
            ),
            SecurityGateDecision::Allow
        ));

        let mut blank_header = HeaderMap::new();
        blank_header.insert("x-cowork-browser-token", HeaderValue::from_static("   "));
        assert!(matches!(
            evaluate_security_gate(
                &Method::GET,
                "/rpc",
                Some("coworkBrowserToken=%20secret%20"),
                &blank_header,
                true,
                token,
            ),
            SecurityGateDecision::Allow
        ));
        assert_eq!(
            reject(evaluate_security_gate(
                &Method::GET,
                "/cowork",
                Some("coworkBrowserToken=nope&coworkBrowserToken=secret"),
                &blank_header,
                true,
                token,
            )),
            (StatusCode::UNAUTHORIZED, "Unauthorized server access")
        );
        assert!(matches!(
            evaluate_security_gate(
                &Method::POST,
                "/cowork/health",
                Some("coworkBrowserToken=&coworkBrowserToken=secret"),
                &HeaderMap::new(),
                true,
                token,
            ),
            SecurityGateDecision::Allow
        ));
        assert_eq!(
            reject(evaluate_security_gate(
                &Method::GET,
                "/ws",
                Some("CoworkBrowserToken=secret"),
                &HeaderMap::new(),
                true,
                token,
            )),
            (StatusCode::UNAUTHORIZED, "Unauthorized server access")
        );

        let loopback = origin("http://127.0.0.1:14330");
        assert_eq!(
            reject(evaluate_security_gate(
                &Method::GET,
                "/rpc",
                Some("coworkBrowserToken=secret"),
                &loopback,
                true,
                Some("other-secret"),
            )),
            (StatusCode::UNAUTHORIZED, "Unauthorized browser access")
        );

        assert_eq!(
            reject(evaluate_security_gate(
                &Method::GET,
                "/cowork/health",
                None,
                &HeaderMap::new(),
                true,
                Some(""),
            )),
            (
                StatusCode::FORBIDDEN,
                "Browser access is not enabled for this server"
            )
        );

        for path in ["/ws", "/rpc", "/cowork", "/cowork/health", "/cowork-extra"] {
            assert_eq!(
                reject(evaluate_security_gate(
                    &Method::GET,
                    path,
                    None,
                    &HeaderMap::new(),
                    true,
                    token,
                )),
                (StatusCode::UNAUTHORIZED, "Unauthorized server access"),
                "{path}"
            );
        }
        assert!(matches!(
            evaluate_security_gate(&Method::GET, "/", None, &HeaderMap::new(), true, token,),
            SecurityGateDecision::Allow
        ));
    }
}
