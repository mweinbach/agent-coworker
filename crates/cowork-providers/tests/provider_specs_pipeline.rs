//! Proves that an OpenAI-compatible Chat Completions provider is pure data: every
//! `chat-completions` entry in `config/providers.json` resolves its transport, inference endpoint,
//! API-key environment variables, display label, discovery endpoint, default/title models and
//! auth methods from the spec alone, with no per-provider code path.

use std::collections::HashMap;

use cowork_config::{
    ProviderDiscoveryMode, ProviderName, ProviderWireProtocol, provider_spec, provider_specs,
};
use cowork_providers::{
    ChatCompletionsTransport, ProviderQuirks, ProviderTransportKind, default_inference_base_url,
    default_provider_auth_methods, default_provider_auth_methods_for, provider_display_label,
    registered_provider_ids, resolve_provider_api_key, transport_for_provider,
};
use serde_json::Value;

fn chat_completions_providers() -> Vec<ProviderName> {
    ProviderName::ALL
        .into_iter()
        .filter(|p| p.spec().transport == ProviderWireProtocol::ChatCompletions)
        .collect()
}

#[test]
fn registered_ids_follow_the_spec_order() {
    let ids: Vec<&str> = registered_provider_ids().collect();
    let spec_ids: Vec<&str> = provider_specs().iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, spec_ids);
}

#[test]
fn every_chat_completions_provider_resolves_purely_from_the_spec() {
    let providers = chat_completions_providers();
    assert!(!providers.is_empty());
    for provider in providers {
        let spec = provider_spec(provider);
        let id = spec.id.as_str();

        assert_eq!(
            transport_for_provider(id),
            Some(ProviderTransportKind::ChatCompletionsSse),
            "{id}"
        );
        assert_eq!(provider_display_label(provider), spec.display_name, "{id}");
        assert_eq!(
            Some(default_inference_base_url(provider)),
            spec.inference_base_url.as_deref(),
            "{id}"
        );
        assert_eq!(
            default_provider_auth_methods_for(provider),
            spec.auth_methods,
            "{id}"
        );

        let quirks = ProviderQuirks::for_provider(provider)
            .unwrap_or_else(|| panic!("{id}: chat-completions spec must yield quirks"));
        assert_eq!(
            Some(quirks.default_base_url),
            spec.inference_base_url.as_deref()
        );
        assert_eq!(quirks.env_api_keys, spec.api_key_env_vars.as_slice());
        assert_eq!(quirks.is_user_facing_enabled, spec.user_facing);
        assert!(
            ChatCompletionsTransport::new(provider).is_some(),
            "{id}: transport must construct from the spec"
        );

        // Every declared env var is honoured, in order, by the catalog resolver.
        for (index, env_var) in spec.api_key_env_vars.iter().enumerate() {
            let mut env = HashMap::new();
            env.insert(env_var.clone(), format!("key-{index}"));
            assert_eq!(
                resolve_provider_api_key(provider, None, &env).as_deref(),
                Some(format!("key-{index}").as_str()),
                "{id}: {env_var}"
            );
        }
        if let [first, second, ..] = spec.api_key_env_vars.as_slice() {
            let env = HashMap::from([
                (first.clone(), "first".to_owned()),
                (second.clone(), "second".to_owned()),
            ]);
            assert_eq!(
                resolve_provider_api_key(provider, None, &env).as_deref(),
                Some("first")
            );
        }
        assert_eq!(
            resolve_provider_api_key(provider, None, &HashMap::new()),
            None
        );

        if spec.discovery == ProviderDiscoveryMode::Api {
            assert!(spec.discovery_base_url.is_some(), "{id}");
        }
    }
}

#[test]
fn non_chat_completions_providers_have_no_quirks() {
    for provider in ProviderName::ALL {
        let is_chat = provider.spec().transport == ProviderWireProtocol::ChatCompletions;
        assert_eq!(
            ProviderQuirks::for_provider(provider).is_some(),
            is_chat,
            "{provider}"
        );
    }
}

#[test]
fn auth_method_payload_is_the_spec_auth_methods_json() {
    let raw: Value =
        serde_json::from_str(include_str!("../../../config/providers.json")).expect("valid json");
    let methods = default_provider_auth_methods();
    for entry in raw["providers"].as_array().expect("providers array") {
        let id = entry["id"].as_str().expect("id");
        assert_eq!(methods.get(id), Some(&entry["authMethods"]), "{id}");
    }
    assert_eq!(methods.len(), ProviderName::ALL.len());
}
