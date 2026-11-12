//! Web-search provider-option resolution shared by the runtime transports, the tool catalog and
//! the system prompt (legacy `src/shared/openaiCompatibleOptions.ts`), so the prompt's web
//! guidance and the tools a request attaches are derived from one decision.

use serde_json::{Map, Value};

/// Legacy `CODEX_WEB_SEARCH_BACKEND_VALUES`.
const CODEX_WEB_SEARCH_BACKENDS: [&str; 3] = ["native", "exa", "parallel"];
/// Legacy `LOCAL_WEB_SEARCH_PROVIDER_VALUES`.
const LOCAL_WEB_SEARCH_PROVIDERS: [&str; 2] = ["exa", "parallel"];

/// Legacy `pickBoolean`: a boolean, or a string spelling one (`1/true/yes/y/on`,
/// `0/false/no/n/off`, trimmed and case-insensitive).
pub fn pick_boolean(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(b) => Some(*b),
        Value::String(raw) => match raw.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "y" | "on" => Some(true),
            "0" | "false" | "no" | "n" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn section<'a>(options: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    options.get(key).and_then(Value::as_object)
}

/// Legacy `getCodexWebSearchBackendFromProviderOptions` without a fallback: the
/// `codex-cli.webSearchBackend` value when it is exactly `native`, `exa`, or `parallel`.
pub fn codex_web_search_backend(options: Option<&Map<String, Value>>) -> Option<&'static str> {
    let raw = section(options?, "codex-cli")?
        .get("webSearchBackend")
        .and_then(Value::as_str)?;
    CODEX_WEB_SEARCH_BACKENDS
        .into_iter()
        .find(|backend| *backend == raw)
}

/// Legacy `getLocalWebSearchProviderFromProviderOptions`: `"exa"` or `"parallel"`. A local Codex
/// backend wins, then `codex-cli.webSearchFallbackBackend`, then `"exa"`.
pub fn local_web_search_provider(options: Option<&Map<String, Value>>) -> &'static str {
    match codex_web_search_backend(options) {
        Some("exa") => return "exa",
        Some("parallel") => return "parallel",
        _ => {}
    }
    options
        .and_then(|options| section(options, "codex-cli"))
        .and_then(|codex| codex.get("webSearchFallbackBackend"))
        .and_then(Value::as_str)
        .and_then(|raw| {
            LOCAL_WEB_SEARCH_PROVIDERS
                .into_iter()
                .find(|provider| *provider == raw)
        })
        .unwrap_or("exa")
}

/// Legacy `getGoogleNativeWebSearchFromProviderOptions`: absent options enable Gemini's native
/// Google Search / URL Context; an explicit `google.nativeWebSearch` (via [`pick_boolean`]) wins;
/// otherwise native search is on only while the Codex web-search backend is `native` (its
/// default).
pub fn google_native_web_search_enabled(options: Option<&Map<String, Value>>) -> bool {
    let Some(options) = options else {
        return true;
    };
    if let Some(explicit) =
        pick_boolean(section(options, "google").and_then(|google| google.get("nativeWebSearch")))
    {
        return explicit;
    }
    codex_web_search_backend(Some(options)).unwrap_or("native") == "native"
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn opts(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn google_native_web_search_matches_legacy_resolution() {
        assert!(google_native_web_search_enabled(None));
        assert!(google_native_web_search_enabled(Some(&Map::new())));
        for (raw, expected) in [
            (json!(false), false),
            (json!("off"), false),
            (json!(" No "), false),
            (json!("1"), true),
            (json!(true), true),
        ] {
            let options = opts(json!({ "google": { "nativeWebSearch": raw } }));
            assert_eq!(
                google_native_web_search_enabled(Some(&options)),
                expected,
                "{raw}"
            );
        }
        // Unparseable flags and non-`google` sections fall through to the Codex backend.
        let options = opts(json!({
            "google": { "nativeWebSearch": "maybe" },
            "vertex": { "nativeWebSearch": false },
            "nativeWebSearch": false,
        }));
        assert!(google_native_web_search_enabled(Some(&options)));
        let options = opts(json!({ "codex-cli": { "webSearchBackend": "parallel" } }));
        assert!(!google_native_web_search_enabled(Some(&options)));
        let options = opts(json!({ "codex-cli": { "webSearchBackend": "Exa" } }));
        assert!(google_native_web_search_enabled(Some(&options)));
    }

    #[test]
    fn local_web_search_provider_matches_legacy_resolution() {
        assert_eq!(local_web_search_provider(None), "exa");
        let options = opts(json!({
            "codex-cli": { "webSearchBackend": "native", "webSearchFallbackBackend": "parallel" }
        }));
        assert_eq!(local_web_search_provider(Some(&options)), "parallel");
        let options = opts(json!({
            "codex-cli": { "webSearchBackend": "exa", "webSearchFallbackBackend": "parallel" }
        }));
        assert_eq!(local_web_search_provider(Some(&options)), "exa");
        let options = opts(json!({ "codex-cli": { "webSearchFallbackBackend": "bing" } }));
        assert_eq!(local_web_search_provider(Some(&options)), "exa");
    }
}
