//! `routeAgentConfig` (`src/server/agents/modelRouter.ts`) rejects a same-provider LM Studio
//! child on a different model when LM Studio is missing from a non-empty connected-providers
//! set: "Requested child target lmstudio:<id> could not be used because LM Studio is not
//! connected. No child was started." An empty set (connectivity unknown), LM Studio being
//! connected, or the child staying on the parent's own model all pass.

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

fn setup(provider: ProviderName, model: &str) -> Env {
    let base = std::env::temp_dir().join(format!("cowork-child-lmstudio-{}", Uuid::new_v4()));
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

const PARENT_MODEL: &str = "qwen3";

fn route(
    env: &Env,
    requested: Option<&str>,
    conn: &[ProviderName],
) -> Result<cowork_harness::agents::ResolvedChildModel, String> {
    resolve_child_model_selection(
        &env.cfg,
        ProviderName::Lmstudio,
        PARENT_MODEL,
        requested,
        None,
        &connected(conn),
    )
}

#[test]
fn lmstudio_child_on_another_model_requires_lmstudio_connected() {
    let env = setup(ProviderName::Lmstudio, PARENT_MODEL);

    for requested in ["llama3:8b", "lmstudio:llama3:8b", "  llama3:8b  "] {
        let err = route(&env, Some(requested), &[ProviderName::Openai]).unwrap_err();
        assert_eq!(
            err,
            "Requested child target lmstudio:llama3:8b could not be used because LM Studio is not connected. No child was started.",
            "{requested}"
        );
    }
}

#[test]
fn lmstudio_child_passes_when_connected_unknown_or_unchanged() {
    let env = setup(ProviderName::Lmstudio, PARENT_MODEL);

    // LM Studio connected.
    let sel = route(
        &env,
        Some("llama3:8b"),
        &[ProviderName::Openai, ProviderName::Lmstudio],
    )
    .unwrap();
    assert_eq!(sel.provider, ProviderName::Lmstudio);
    assert_eq!(sel.model_id, "llama3:8b");

    // Empty connected set: connectivity is unknown, so the check does not apply.
    let sel = route(&env, Some("llama3:8b"), &[]).unwrap();
    assert_eq!(sel.model_id, "llama3:8b");

    // The parent's own model (bare or qualified) and no model request stay allowed.
    for requested in [Some(PARENT_MODEL), Some("lmstudio:qwen3"), None] {
        let sel = route(&env, requested, &[ProviderName::Openai]).unwrap();
        assert_eq!(sel.provider, ProviderName::Lmstudio, "{requested:?}");
        assert_eq!(sel.model_id, PARENT_MODEL, "{requested:?}");
    }
}

#[test]
fn other_providers_are_not_subject_to_the_lmstudio_check() {
    let env = setup(ProviderName::Openai, "gpt-5.4");
    // An OpenAI parent switching models on OpenAI with only another provider "connected"
    // is not blocked by connectivity (TS only checks LM Studio on the same-provider path).
    let sel = resolve_child_model_selection(
        &env.cfg,
        ProviderName::Openai,
        "gpt-5.4",
        Some("gpt-5.4-mini"),
        None,
        &connected(&[ProviderName::Anthropic]),
    )
    .unwrap();
    assert_eq!(sel.provider, ProviderName::Openai);
    assert_eq!(sel.model_id, "gpt-5.4-mini");
}
