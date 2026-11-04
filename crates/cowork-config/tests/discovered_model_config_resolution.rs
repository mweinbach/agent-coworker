//! Config resolution must seed non-bundled models with capability-aware `providerOptionsDefaults`
//! before reconciling the configured `providerOptions` (`mergeProviderOptionDefaults` +
//! `getResolvedModelMetadataSync` in `src/config.ts` / `src/models/metadata.ts`): a discovered
//! model that advertises reasoning keeps the saved thinking/reasoning settings, a discovered model
//! without reasoning info has them stripped, and custom-store ids follow the id heuristics.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, CachedModelDiscoveryModel, CachedModelReasoning, LoadConfigOptions,
    ModelDiscoveryResult, ModelDiscoverySource, ProviderName, get_ai_coworker_paths, load_config,
    upsert_custom_model, write_model_discovery_cache,
};
use serde_json::{Value, json};
use tempfile::TempDir;

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-cfg-discovered-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let userdata = base.join("userdata").to_string_lossy().into_owned();
        let env = HashMap::from([
            ("HOME".to_owned(), home.to_string_lossy().into_owned()),
            (
                "COWORK_HOME_OVERRIDE".to_owned(),
                home.to_string_lossy().into_owned(),
            ),
            ("COWORK_ELECTRON_USER_DATA_DIR".to_owned(), userdata.clone()),
            ("COWORK_DESKTOP_USER_DATA_DIR".to_owned(), userdata),
            ("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned()),
            ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
        ]);
        Self {
            _root: root,
            home,
            workspace,
            env,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn write_discovery(&self, provider: ProviderName, models: Vec<CachedModelDiscoveryModel>) {
        let paths = get_ai_coworker_paths(Some(&self.home), &self.env);
        Self::rt()
            .block_on(write_model_discovery_cache(
                &paths,
                provider,
                ModelDiscoveryResult {
                    provider,
                    source: ModelDiscoverySource::Api,
                    models,
                    updated_at: None,
                    expires_at: None,
                    message: None,
                },
                None,
                None,
            ))
            .unwrap();
    }

    fn add_custom_model(&self, provider: ProviderName, id: &str) {
        let paths = get_ai_coworker_paths(Some(&self.home), &self.env);
        Self::rt()
            .block_on(upsert_custom_model(&paths, provider, id))
            .unwrap();
    }

    fn load_with_workspace(&self, workspace_config: &Value) -> AgentConfig {
        let path = self.workspace.join(".cowork/config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_string_pretty(workspace_config).unwrap(),
        )
        .unwrap();
        load_config(LoadConfigOptions {
            cwd: Some(self.workspace.clone()),
            homedir: Some(self.home.clone()),
            built_in_dir: Some(repo_root()),
            env: Some(self.env.clone()),
        })
        .unwrap()
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf()
}

fn discovered(id: &str, reasoning: Option<CachedModelReasoning>) -> CachedModelDiscoveryModel {
    CachedModelDiscoveryModel {
        id: id.to_owned(),
        model: None,
        display_name: format!("{id} (discovered)"),
        description: None,
        knowledge_cutoff: None,
        supports_image_input: None,
        is_default: None,
        reasoning,
        runtime_options: None,
        runtime_overrides: None,
    }
}

fn efforts(default: Option<&str>, available: &[&str]) -> Option<CachedModelReasoning> {
    Some(CachedModelReasoning {
        default_effort: default.map(ToOwned::to_owned),
        available_efforts: (!available.is_empty())
            .then(|| available.iter().map(|s| (*s).to_owned()).collect()),
    })
}

fn section<'a>(cfg: &'a AgentConfig, provider: &str) -> Option<&'a serde_json::Map<String, Value>> {
    cfg.provider_options
        .as_ref()?
        .get(provider)
        .and_then(Value::as_object)
}

#[test]
fn discovered_google_reasoning_model_keeps_saved_thinking_config() {
    let iso = Iso::new();
    iso.write_discovery(
        ProviderName::Google,
        vec![
            discovered("gemini-9-thinker", efforts(Some("high"), &["low", "high"])),
            discovered("gemini-9-plain", None),
        ],
    );

    let cfg = iso.load_with_workspace(&json!({
        "provider": "google",
        "model": "gemini-9-thinker",
        "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": "low" } } }
    }));
    assert_eq!(cfg.model, "gemini-9-thinker");
    let google = section(&cfg, "google").expect("google provider options");
    assert_eq!(google["thinkingConfig"]["thinkingLevel"], "low");
    // Provider-default thinking keys are merged underneath the saved setting.
    assert_eq!(google["thinkingConfig"]["includeThoughts"], true);

    let plain = iso.load_with_workspace(&json!({
        "provider": "google",
        "model": "gemini-9-plain",
        "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": "low" } } }
    }));
    assert_eq!(plain.model, "gemini-9-plain");
    assert!(
        section(&plain, "google").is_none_or(|s| !s.contains_key("thinkingConfig")),
        "a discovered model without reasoning info must not keep thinkingConfig: {:?}",
        plain.provider_options
    );
}

#[test]
fn discovered_openai_reasoning_model_keeps_saved_reasoning_effort() {
    let iso = Iso::new();
    iso.write_discovery(
        ProviderName::Openai,
        vec![
            discovered(
                "gpt-4.9-thinker",
                efforts(Some("medium"), &["low", "medium"]),
            ),
            discovered("gpt-4.9-plain", None),
        ],
    );

    let cfg = iso.load_with_workspace(&json!({
        "provider": "openai",
        "model": "gpt-4.9-thinker",
        "providerOptions": { "openai": { "reasoningEffort": "low", "textVerbosity": "high" } }
    }));
    assert_eq!(cfg.model, "gpt-4.9-thinker");
    let openai = section(&cfg, "openai").expect("openai provider options");
    assert_eq!(openai["reasoningEffort"], "low");
    assert_eq!(openai["reasoningSummary"], "detailed");
    // Verbosity remains GPT-5-family only even for a discovered reasoning model.
    assert!(!openai.contains_key("textVerbosity"));

    // Without a saved effort the advertised default seeds the effort.
    let seeded = iso.load_with_workspace(&json!({
        "provider": "openai",
        "model": "gpt-4.9-thinker"
    }));
    assert_eq!(
        section(&seeded, "openai").unwrap()["reasoningEffort"],
        "medium"
    );

    let plain = iso.load_with_workspace(&json!({
        "provider": "openai",
        "model": "gpt-4.9-plain",
        "providerOptions": { "openai": { "reasoningEffort": "low", "reasoningSummary": "auto" } }
    }));
    assert_eq!(plain.model, "gpt-4.9-plain");
    let plain_openai = section(&plain, "openai");
    assert!(
        plain_openai.is_none_or(|s| {
            !s.contains_key("reasoningEffort") && !s.contains_key("reasoningSummary")
        }),
        "a discovered model without reasoning info must not keep reasoning keys: {:?}",
        plain.provider_options
    );
}

#[test]
fn discovered_model_wins_over_custom_store_and_matches_by_model_field() {
    let iso = Iso::new();
    let mut aliased = discovered("gemini-9-aliased", efforts(None, &["low", "high"]));
    aliased.model = Some("models/gemini-9-aliased-001".to_owned());
    iso.write_discovery(ProviderName::Google, vec![aliased]);
    // Also present in the custom store: the discovered (reasoning-aware) metadata must win.
    iso.add_custom_model(ProviderName::Google, "gemini-9-aliased");

    let cfg = iso.load_with_workspace(&json!({
        "provider": "google",
        "model": "gemini-9-aliased",
        "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": "high" } } }
    }));
    assert_eq!(
        section(&cfg, "google").unwrap()["thinkingConfig"]["thinkingLevel"],
        "high"
    );

    let by_model = iso.load_with_workspace(&json!({
        "provider": "google",
        "model": "models/gemini-9-aliased-001",
        "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": "high" } } }
    }));
    assert_eq!(by_model.model, "gemini-9-aliased");
    assert_eq!(
        section(&by_model, "google").unwrap()["thinkingConfig"]["thinkingLevel"],
        "high"
    );
}

#[test]
fn custom_model_ids_follow_reasoning_heuristics() {
    let iso = Iso::new();
    iso.add_custom_model(ProviderName::Openai, "o9-custom");
    iso.add_custom_model(ProviderName::Openai, "gpt-5.9-custom");
    iso.add_custom_model(ProviderName::Openai, "gpt-4o-custom");
    iso.add_custom_model(ProviderName::Google, "gemini-custom");

    // `o*` ids reason but are not GPT-5 family: effort/summary kept, verbosity dropped.
    let o_series = iso.load_with_workspace(&json!({
        "provider": "openai",
        "model": "o9-custom",
        "providerOptions": { "openai": { "reasoningEffort": "low", "textVerbosity": "high" } }
    }));
    assert_eq!(o_series.model, "o9-custom");
    let openai = section(&o_series, "openai").unwrap();
    assert_eq!(openai["reasoningEffort"], "low");
    assert_eq!(openai["reasoningSummary"], "detailed");
    assert!(!openai.contains_key("textVerbosity"));

    // `gpt-5*` ids keep reasoning and verbosity.
    let gpt5 = iso.load_with_workspace(&json!({
        "provider": "openai",
        "model": "gpt-5.9-custom",
        "providerOptions": { "openai": { "reasoningEffort": "low", "textVerbosity": "high" } }
    }));
    let openai = section(&gpt5, "openai").unwrap();
    assert_eq!(openai["reasoningEffort"], "low");
    assert_eq!(openai["textVerbosity"], "high");

    // Other OpenAI ids do not reason.
    let plain = iso.load_with_workspace(&json!({
        "provider": "openai",
        "model": "gpt-4o-custom",
        "providerOptions": { "openai": { "reasoningEffort": "low" } }
    }));
    assert_eq!(plain.model, "gpt-4o-custom");
    assert!(section(&plain, "openai").is_none_or(|s| !s.contains_key("reasoningEffort")));

    // Non-OpenAI custom ids conservatively assume no reasoning.
    let google = iso.load_with_workspace(&json!({
        "provider": "google",
        "model": "gemini-custom",
        "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": "low" } } }
    }));
    assert_eq!(google.model, "gemini-custom");
    assert!(section(&google, "google").is_none_or(|s| !s.contains_key("thinkingConfig")));
}
