//! Reasoning-effort resolution for routed child agents, ported from the reasoning-effort cases
//! of `test/server/agents/modelRouter.test.ts` (`routeAgentConfig` in
//! `src/server/agents/modelRouter.ts`):
//!
//! `effective = requested ?? (childModelChanged ? childModelDefault : parentCurrentEffort)`,
//! where `childModelChanged` is true whenever a model was requested at all, and requested
//! efforts pass through verbatim (the runtime normalizes them per model).
//!
//! The role `modelPolicy.fixedModel` / `fixedReasoningEffort` cases are not ported: no Rust
//! (or TS built-in) role declares a model policy.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;

use cowork_config::{
    AgentConfig, ChildModelRoutingMode, LoadConfigOptions, ProviderName, load_config,
};
use cowork_harness::agents::{ResolvedChildModel, resolve_child_model_selection};
use serde_json::{Map, Value, json};
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

fn setup(tag: &str) -> Env {
    let base = std::env::temp_dir().join(format!("cowork-child-effort-{tag}-{}", Uuid::new_v4()));
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
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home),
        built_in_dir: Some(builtin),
        env: Some(env),
    })
    .unwrap();
    Env { base, cfg }
}

/// A parent config on `provider`/`model` whose current provider options are `options`.
fn parent(env: &Env, provider: ProviderName, model: &str, options: Option<Value>) -> AgentConfig {
    let mut cfg = env.cfg.clone();
    cfg.provider = provider;
    cfg.model = model.to_owned();
    cfg.provider_options = options.map(|v| match v {
        Value::Object(m) => m,
        _ => Map::new(),
    });
    cfg
}

fn route(
    cfg: &AgentConfig,
    model: Option<&str>,
    effort: Option<&str>,
    connected: &[ProviderName],
) -> ResolvedChildModel {
    let connected: BTreeSet<ProviderName> = connected.iter().copied().collect();
    resolve_child_model_selection(cfg, cfg.provider, &cfg.model, model, effort, &connected)
        .unwrap_or_else(|e| panic!("route {model:?}/{effort:?}: {e}"))
}

// ---------------------------------------------------------------------------------------------
// routeAgentConfig: no model requested
// ---------------------------------------------------------------------------------------------

#[test]
fn no_effective_effort_for_google_parent_without_effort() {
    let env = setup("google-none");
    let cfg = parent(&env, ProviderName::Google, "gemini-3-flash-preview", None);
    let sel = route(&cfg, None, None, &[]);
    assert_eq!(sel.model_id, "gemini-3-flash-preview");
    assert_eq!(sel.requested_model, None);
    assert_eq!(sel.effective_reasoning_effort, None);
}

#[test]
fn inherits_parent_reasoning_effort_from_provider_options_when_no_model_requested() {
    let env = setup("inherit-52");
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.2",
        Some(json!({ "openai": { "reasoningEffort": "low" } })),
    );
    let sel = route(&cfg, None, None, &[]);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("low"));
    assert_eq!(sel.requested_reasoning_effort, None);
}

#[test]
fn does_not_inherit_parent_effort_when_routing_to_a_non_reasoning_child_model() {
    let env = setup("gpt4o");
    let home = env.cfg.user_cowork_dir.parent().unwrap().to_path_buf();
    let paths = cowork_config::get_ai_coworker_paths(Some(&home), &HashMap::new());
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(cowork_config::upsert_custom_model(
            &paths,
            ProviderName::Openai,
            "gpt-4o",
        ))
        .unwrap();
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "high", "reasoningSummary": "detailed" } })),
    );
    let sel = route(&cfg, Some("gpt-4o"), None, &[]);
    assert_eq!(sel.model_id, "gpt-4o");
    assert_eq!(sel.effective_reasoning_effort, None);
}

#[test]
fn reasoning_child_model_keeps_an_effort() {
    let env = setup("keep-52");
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "high" } })),
    );
    let sel = route(&cfg, Some("gpt-5.2"), None, &[]);
    assert_eq!(sel.model_id, "gpt-5.2");
    assert!(sel.effective_reasoning_effort.is_some());
}

// ---------------------------------------------------------------------------------------------
// routeAgentConfig: same-provider model request
// ---------------------------------------------------------------------------------------------

#[test]
fn picks_up_model_default_effort_when_a_different_same_provider_model_is_requested() {
    let env = setup("default-52");
    let cfg = parent(&env, ProviderName::Openai, "gpt-5.4", None);
    let sel = route(&cfg, Some("gpt-5.2"), None, &[]);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn explicit_requested_effort_overrides_model_default() {
    let env = setup("explicit-52");
    let cfg = parent(&env, ProviderName::Openai, "gpt-5.4", None);
    let sel = route(&cfg, Some("gpt-5.2"), Some("low"), &[]);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("low"));
    assert_eq!(sel.requested_reasoning_effort.as_deref(), Some("low"));
}

#[test]
fn model_default_used_when_parent_effort_differs_and_model_changes() {
    // A changed child model never inherits the parent's current effort.
    let env = setup("changed-ignores-parent");
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "low" } })),
    );
    let sel = route(&cfg, Some("gpt-5.2"), None, &[]);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn explicitly_requesting_the_parent_model_uses_its_default_not_the_parent_effort() {
    // TS `childModelChanged = Boolean(requestedModel) || ...`: any explicit model request
    // counts as a change, even when it names the parent's own model.
    let env = setup("same-model-requested");
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "low" } })),
    );
    let sel = route(&cfg, Some("gpt-5.4"), None, &[]);
    assert_eq!(sel.model_id, "gpt-5.4");
    assert_eq!(sel.requested_model.as_deref(), Some("gpt-5.4"));
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("high"));

    // A whitespace-only request is "no model requested" and inherits.
    let sel = route(&cfg, Some("   "), None, &[]);
    assert_eq!(sel.requested_model, None);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("low"));
}

// ---------------------------------------------------------------------------------------------
// routeAgentConfig: cross-provider routing success
// ---------------------------------------------------------------------------------------------

#[test]
fn cross_provider_success_applies_model_default_effort_for_new_provider() {
    let env = setup("cross");
    let mut cfg = parent(&env, ProviderName::Google, "gemini-3-flash-preview", None);
    cfg.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
    cfg.allowed_child_model_refs = vec!["openai:gpt-5.4".to_owned()];
    let sel = route(
        &cfg,
        Some("openai:gpt-5.4"),
        None,
        &[ProviderName::Openai, ProviderName::Google],
    );
    assert_eq!(sel.provider, ProviderName::Openai);
    assert_eq!(sel.model_id, "gpt-5.4");
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn cross_provider_child_does_not_inherit_parent_effort() {
    let env = setup("cross-no-inherit");
    let mut cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "low" } })),
    );
    cfg.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
    cfg.allowed_child_model_refs = vec!["google:gemini-3-flash-preview".to_owned()];
    let sel = route(
        &cfg,
        Some("google:gemini-3-flash-preview"),
        None,
        &[ProviderName::Openai, ProviderName::Google],
    );
    assert_eq!(sel.provider, ProviderName::Google);
    assert_eq!(sel.effective_reasoning_effort, None);
}

// ---------------------------------------------------------------------------------------------
// routeAgentConfig: reasoningEffort resolution
// ---------------------------------------------------------------------------------------------

#[test]
fn explicit_requested_effort_wins_over_parent_inherited() {
    let env = setup("explicit-over-parent");
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.2",
        Some(json!({ "openai": { "reasoningEffort": "low" } })),
    );
    let sel = route(&cfg, None, Some("high"), &[]);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn parent_provider_options_effort_used_as_last_fallback_without_model_change() {
    // The regression: a gpt-5.4 parent set to "low" used to get a "high" (model default) child.
    let env = setup("fallback-54");
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "low" } })),
    );
    let sel = route(&cfg, None, None, &[]);
    assert_eq!(sel.model_id, "gpt-5.4");
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("low"));
}

#[test]
fn same_model_child_without_parent_effort_reports_no_effort() {
    // `currentReasoningEffort` reads only the parent's current options; it does not fall back
    // to the model default.
    let env = setup("no-parent-effort");
    let cfg = parent(&env, ProviderName::Openai, "gpt-5.4", None);
    assert_eq!(
        route(&cfg, None, None, &[]).effective_reasoning_effort,
        None
    );

    // An unrecognised stored value is ignored (`isOpenAiReasoningEffort`).
    let cfg = parent(
        &env,
        ProviderName::Openai,
        "gpt-5.4",
        Some(json!({ "openai": { "reasoningEffort": "turbo" } })),
    );
    assert_eq!(
        route(&cfg, None, None, &[]).effective_reasoning_effort,
        None
    );
}

#[test]
fn only_openai_compatible_parents_hand_down_their_current_effort() {
    let env = setup("compat");
    let cfg = parent(
        &env,
        ProviderName::CodexCli,
        "gpt-5.4",
        Some(json!({ "codex-cli": { "reasoningEffort": "medium" } })),
    );
    assert_eq!(
        route(&cfg, None, None, &[])
            .effective_reasoning_effort
            .as_deref(),
        Some("medium")
    );

    let cfg = parent(
        &env,
        ProviderName::Google,
        "gemini-3-flash-preview",
        Some(json!({ "google": { "reasoningEffort": "low" } })),
    );
    assert_eq!(
        route(&cfg, None, None, &[]).effective_reasoning_effort,
        None
    );
}

#[test]
fn requested_effort_is_reported_for_non_openai_compatible_providers() {
    let env = setup("google-requested");
    let cfg = parent(&env, ProviderName::Google, "gemini-3-flash-preview", None);
    let sel = route(&cfg, None, Some("high"), &[]);
    assert_eq!(sel.effective_reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn requested_effort_field_is_present_only_when_requested() {
    let env = setup("requested-field");
    let cfg = parent(&env, ProviderName::Openai, "gpt-5.2", None);
    let with = route(&cfg, None, Some("low"), &[]);
    assert_eq!(with.requested_reasoning_effort.as_deref(), Some("low"));
    let without = route(&cfg, None, None, &[]);
    assert_eq!(without.requested_reasoning_effort, None);
}

#[test]
fn requested_effort_passes_through_even_when_the_model_does_not_list_it() {
    // TS never clamps a requested effort to the model's supported list; the runtime
    // normalizes it per model when it builds the request.
    let env = setup("passthrough");
    let cfg = parent(&env, ProviderName::Openai, "gpt-5.4", None);
    for effort in ["max", "light"] {
        let sel = route(&cfg, None, Some(effort), &[]);
        assert_eq!(sel.requested_reasoning_effort.as_deref(), Some(effort));
        assert_eq!(sel.effective_reasoning_effort.as_deref(), Some(effort));
        let sel = route(&cfg, Some("gpt-5.2"), Some(effort), &[]);
        assert_eq!(sel.effective_reasoning_effort.as_deref(), Some(effort));
    }
}
