//! Regression: TS `createTools` (`src/tools/index.ts`) omits the custom Exa/Parallel `webSearch`
//! tool when Gemini's native Google Search is active (provider `google`, `nativeWebSearch` on by
//! default) and for `codex-cli` unless its `webSearchBackend` is a local one (`exa` /
//! `parallel`; the default is `native`).

use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::{Map, Value, json};

fn has_web_search(provider: ProviderName, options: Value) -> bool {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = ToolExecutionContext::new_for_tests(
        dir.path().join("home"),
        dir.path().join("ws"),
        provider,
        "model",
    );
    ctx.provider_options = serde_json::from_value::<Map<String, Value>>(options).unwrap();
    let tools = create_builtin_tools(&ctx);
    assert!(tools.contains_key("webFetch"));
    tools.contains_key("webSearch")
}

#[test]
fn google_native_search_replaces_custom_web_search() {
    assert!(!has_web_search(ProviderName::Google, json!({})));
    assert!(!has_web_search(
        ProviderName::Google,
        json!({ "google": { "nativeWebSearch": true } })
    ));
    assert!(has_web_search(
        ProviderName::Google,
        json!({ "google": { "nativeWebSearch": false } })
    ));
    assert!(has_web_search(
        ProviderName::Google,
        json!({ "google": { "nativeWebSearch": "off" } })
    ));
    // No explicit flag: native search follows the Codex backend (legacy resolution).
    assert!(has_web_search(
        ProviderName::Google,
        json!({ "codex-cli": { "webSearchBackend": "exa" } })
    ));
}

#[test]
fn codex_cli_offers_custom_web_search_only_for_local_backends() {
    assert!(!has_web_search(ProviderName::CodexCli, json!({})));
    assert!(!has_web_search(
        ProviderName::CodexCli,
        json!({ "codex-cli": { "webSearchBackend": "native", "webSearchMode": "disabled" } })
    ));
    // An unknown backend falls back to `native`.
    assert!(!has_web_search(
        ProviderName::CodexCli,
        json!({ "codex-cli": { "webSearchBackend": "Exa" } })
    ));
    assert!(has_web_search(
        ProviderName::CodexCli,
        json!({ "codex-cli": { "webSearchBackend": "exa" } })
    ));
    assert!(has_web_search(
        ProviderName::CodexCli,
        json!({ "codex-cli": { "webSearchBackend": "parallel" } })
    ));
}

#[test]
fn other_providers_keep_custom_web_search() {
    for provider in [ProviderName::Openai, ProviderName::Anthropic] {
        assert!(has_web_search(provider, json!({})));
    }
}
