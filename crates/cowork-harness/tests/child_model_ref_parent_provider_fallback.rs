//! Child model refs resolve against the parent provider, like `routeAgentConfig`
//! (`src/server/agents/modelRouter.ts`) calling `parseChildModelRef(requested, parentProvider)`:
//! only a known provider name before the first `:` selects another provider; any other
//! colon-bearing string (Bedrock `amazon.nova-micro-v1:0`, inference-profile ARNs, Ollama-style
//! `llama3:8b`) is a model ID on the parent provider.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;

use cowork_config::{
    AgentConfig, ChildModelRoutingMode, LoadConfigOptions, ProviderName, load_config,
};
use cowork_harness::agents::resolve_child_model_selection;
use uuid::Uuid;

struct Env {
    base: PathBuf,
    cfg: AgentConfig,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn setup(tag: &str, provider: ProviderName, model: &str) -> Env {
    let base =
        std::env::temp_dir().join(format!("cowork-child-model-ref-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&builtin).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let mut cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home),
        built_in_dir: Some(builtin),
        env: Some(env),
    })
    .unwrap();
    cfg.provider = provider;
    cfg.model = model.to_owned();
    cfg.child_model_routing_mode = ChildModelRoutingMode::SameProvider;
    cfg.allowed_child_model_refs = Vec::new();
    Env { base, cfg }
}

fn connected(providers: &[ProviderName]) -> BTreeSet<ProviderName> {
    providers.iter().copied().collect()
}

const NOVA_MICRO: &str = "amazon.nova-micro-v1:0";
const INFERENCE_PROFILE_ARN: &str =
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6";

#[test]
fn bedrock_parent_spawns_colon_bearing_model_ids_on_bedrock() {
    let env = setup("bedrock", ProviderName::Bedrock, NOVA_MICRO);
    let conn = connected(&[ProviderName::Bedrock]);

    // The parent's own (bundled) model, requested unqualified.
    let same = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        NOVA_MICRO,
        Some(NOVA_MICRO),
        None,
        &conn,
    )
    .unwrap_or_else(|e| panic!("{NOVA_MICRO}: {e}"));
    assert_eq!(same.provider, ProviderName::Bedrock);
    assert_eq!(same.model_id, NOVA_MICRO);
    assert_eq!(same.canonical_ref, format!("bedrock:{NOVA_MICRO}"));

    // A bundled colon-bearing model that differs from the parent's model.
    let other_parent = "amazon.nova-lite-v1:0";
    let nova = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        other_parent,
        Some(NOVA_MICRO),
        None,
        &conn,
    )
    .unwrap_or_else(|e| panic!("{NOVA_MICRO}: {e}"));
    assert_eq!(nova.provider, ProviderName::Bedrock);
    assert_eq!(nova.model_id, NOVA_MICRO);

    // An inference-profile ARN (runtime-resolved, not in the bundled manifests).
    let arn = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        NOVA_MICRO,
        Some(INFERENCE_PROFILE_ARN),
        None,
        &conn,
    )
    .unwrap_or_else(|e| panic!("{INFERENCE_PROFILE_ARN}: {e}"));
    assert_eq!(arn.provider, ProviderName::Bedrock);
    assert_eq!(arn.model_id, INFERENCE_PROFILE_ARN);
    assert_eq!(
        arn.canonical_ref,
        format!("bedrock:{INFERENCE_PROFILE_ARN}")
    );

    // Explicitly provider-qualified: splits only at the first colon.
    let qualified = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        other_parent,
        Some(&format!("bedrock:{NOVA_MICRO}")),
        None,
        &conn,
    )
    .unwrap();
    assert_eq!(qualified.provider, ProviderName::Bedrock);
    assert_eq!(qualified.model_id, NOVA_MICRO);
}

#[test]
fn unknown_provider_prefix_stays_on_parent_provider() {
    let env = setup("unknown-prefix", ProviderName::Bedrock, NOVA_MICRO);
    let conn = connected(&[ProviderName::Bedrock, ProviderName::Openai]);
    let sel = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        NOVA_MICRO,
        Some("custom-vendor:model-x"),
        None,
        &conn,
    )
    .unwrap();
    assert_eq!(sel.provider, ProviderName::Bedrock);
    assert_eq!(sel.model_id, "custom-vendor:model-x");
    assert_eq!(sel.canonical_ref, "bedrock:custom-vendor:model-x");

    // LM Studio accepts arbitrary runtime IDs, including Ollama-style tags.
    let lm = setup("lmstudio", ProviderName::Lmstudio, "qwen3");
    let lm_sel = resolve_child_model_selection(
        &lm.cfg,
        ProviderName::Lmstudio,
        "qwen3",
        Some("llama3:8b"),
        None,
        &connected(&[ProviderName::Lmstudio]),
    )
    .unwrap();
    assert_eq!(lm_sel.provider, ProviderName::Lmstudio);
    assert_eq!(lm_sel.model_id, "llama3:8b");

    // On a provider that validates IDs, an unknown prefixed ID is a parent-provider model
    // lookup (rejected as unsupported), not a provider-prefix parse error.
    let oa = setup("openai-unknown", ProviderName::Openai, "gpt-5.4");
    let err = resolve_child_model_selection(
        &oa.cfg,
        ProviderName::Openai,
        "gpt-5.4",
        Some("custom-vendor:model-x"),
        None,
        &connected(&[ProviderName::Openai]),
    )
    .unwrap_err();
    assert!(
        err.contains("not supported by parent provider 'openai'"),
        "{err}"
    );
}

#[test]
fn known_provider_prefix_still_switches_provider_subject_to_routing_mode() {
    let mut env = setup("cross", ProviderName::Bedrock, NOVA_MICRO);
    let conn = connected(&[ProviderName::Bedrock, ProviderName::Openai]);

    let blocked = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        NOVA_MICRO,
        Some("openai:gpt-5.4"),
        None,
        &conn,
    )
    .unwrap_err();
    assert!(blocked.contains("same-provider"), "{blocked}");

    env.cfg.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
    let unlisted = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        NOVA_MICRO,
        Some("openai:gpt-5.4"),
        None,
        &conn,
    )
    .unwrap_err();
    assert!(unlisted.contains("allowedChildModelRefs"), "{unlisted}");

    env.cfg.allowed_child_model_refs = vec!["openai:gpt-5.4".to_owned()];
    let routed = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Bedrock,
        NOVA_MICRO,
        Some("openai:gpt-5.4"),
        None,
        &conn,
    )
    .unwrap();
    assert_eq!(routed.provider, ProviderName::Openai);
    assert_eq!(routed.model_id, "gpt-5.4");
    assert_eq!(routed.canonical_ref, "openai:gpt-5.4");

    // A known provider with an empty model ID is still an invalid ref.
    assert!(
        resolve_child_model_selection(
            &env.cfg,
            ProviderName::Bedrock,
            NOVA_MICRO,
            Some("openai:"),
            None,
            &conn,
        )
        .is_err()
    );
}
