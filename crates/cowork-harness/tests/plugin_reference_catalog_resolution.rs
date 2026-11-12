//! Plugin references resolve through the installed plugin catalog (legacy
//! `resolveReferencedPlugins`): an enabled catalog entry matched by its catalog name yields its
//! enabled bundled skill names, with no dependency on a root-level `PLUGIN.md` / `README.md` or
//! on the install directory name.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, ProviderName, load_config};
use cowork_harness::extensions::ExtensionManager;
use cowork_harness::{
    ReferencedPluginContext, SystemPromptBuildOptions, TurnReference, TurnReferenceKind,
    build_layered_system_prompt, installed_plugin_catalog, resolve_turn_references,
    resolve_turn_references_with_plugin_catalog,
};
use cowork_tools::discover_skills_for_config;
use serde_json::json;

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    cfg: AgentConfig,
    env: HashMap<String, String>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let home = root.join("home");
    let ws = root.join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(root.join("builtin/skills")).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home),
        built_in_dir: Some(root.join("builtin")),
        env: Some(env.clone()),
    })
    .unwrap();
    Fixture {
        _tmp: tmp,
        ws,
        cfg,
        env,
    }
}

/// Writes a plugin with only a manifest and bundled skills (no `PLUGIN.md` / `README.md`).
fn write_plugin(dir: &Path, manifest: serde_json::Value, skills: &[&str]) {
    fs::create_dir_all(dir.join(".cowork-plugin")).unwrap();
    fs::write(dir.join(".cowork-plugin/plugin.json"), manifest.to_string()).unwrap();
    for skill in skills {
        let skill_dir = dir.join("skills").join(skill);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {skill}\ndescription: {skill} helper\n---\nBody of {skill}.\n"),
        )
        .unwrap();
    }
}

fn plugin_ref(name: &str) -> TurnReference {
    TurnReference {
        kind: TurnReferenceKind::Plugin,
        name: name.to_owned(),
    }
}

fn resolve(fx: &Fixture, text: &str, references: &[TurnReference]) -> Vec<ReferencedPluginContext> {
    let skills = discover_skills_for_config(&fx.cfg);
    resolve_turn_references_with_plugin_catalog(text, references, &skills, || {
        installed_plugin_catalog(&fx.cfg)
    })
    .referenced_plugins
}

#[test]
fn plugin_without_plugin_md_or_readme_resolves_to_its_bundled_skills() {
    let fx = fixture();
    let plugin_dir = fx.cfg.workspace_plugins_dir.join("docs-free");
    write_plugin(
        &plugin_dir,
        json!({ "name": "docs-free", "interface": { "displayName": "Docs Free" } }),
        &["alpha", "beta"],
    );
    assert!(!plugin_dir.join("PLUGIN.md").exists());
    assert!(!plugin_dir.join("README.md").exists());

    let expected = ReferencedPluginContext {
        name: "docs-free".to_owned(),
        display_name: "Docs Free".to_owned(),
        skill_names: vec!["docs-free:alpha".to_owned(), "docs-free:beta".to_owned()],
    };

    // Explicit `references` entry (desktop mention picker).
    let resolved = resolve(&fx, "go", &[plugin_ref("docs-free")]);
    assert_eq!(resolved, vec![expected.clone()]);

    // Desktop-style text mention: capitalized, trailing punctuation, deduplicated.
    let resolved = resolve(&fx, "Use @Docs-Free. and @docs-free", &[]);
    assert_eq!(resolved, vec![expected.clone()]);

    // Without a config the plugin still resolves through its discovered plugin-owned skills.
    let skills = discover_skills_for_config(&fx.cfg);
    let fallback = resolve_turn_references("go", &[plugin_ref("docs-free")], &skills);
    assert_eq!(fallback.referenced_plugins.len(), 1);
    assert_eq!(
        fallback.referenced_plugins[0].skill_names,
        expected.skill_names
    );

    // Rendered like legacy `renderReferencedPluginsSection`.
    let prompt = build_layered_system_prompt(&SystemPromptBuildOptions {
        prompts_dir: None,
        prompt_template: None,
        working_directory: fx.ws.clone(),
        output_directory: fx.ws.join("output"),
        uploads_directory: fx.ws.join("uploads"),
        cowork_home: fx.cfg.user_cowork_dir.clone(),
        provider: ProviderName::Openai,
        model: "gpt-5.4".to_owned(),
        sandbox_mode_label: "workspace-write".to_owned(),
        network_enabled: true,
        available_skills: skills,
        memory_section: None,
        task_context_section: None,
        workspace_context: None,
        harness_context: None,
        referenced_plugins: vec![expected],
        deferred_tool_search_enabled: false,
        code_mode_enabled: false,
        template_context: Default::default(),
    });
    assert!(prompt.contains(
        "## Referenced Plugins\n\nThe user explicitly referenced the following plugin(s) for this request.\nPrefer their bundled skills when relevant. Load a specific skill with the `skill` tool only when you actually need its instructions.\n\n- Docs Free (bundled skills: docs-free:alpha, docs-free:beta)"
    ));
}

#[test]
fn marketplace_plugin_whose_directory_differs_from_manifest_name_resolves() {
    let fx = fixture();

    // Marketplace install whose directory is not the manifest name.
    let installed = fx.cfg.user_plugins_dir.join("acme-suite-src");
    write_plugin(&installed, json!({ "name": "acme-suite" }), &["runner"]);
    fs::write(
        installed.join(".cowork-plugin/install.json"),
        json!({ "marketplace": { "name": "cowork-skills" } }).to_string(),
    )
    .unwrap();

    // Local `marketplace.json` entry whose `source` directory differs from the manifest name.
    let ws_plugins = fx.cfg.workspace_plugins_dir.clone();
    write_plugin(
        &ws_plugins.join("vendor/tools-src"),
        json!({ "name": "vendor-tools" }),
        &["lint"],
    );
    fs::write(
        ws_plugins.join("marketplace.json"),
        json!({
            "name": "local-market",
            "plugins": [{ "name": "vendor-tools", "source": "./vendor/tools-src" }],
        })
        .to_string(),
    )
    .unwrap();

    let catalog = installed_plugin_catalog(&fx.cfg);
    for name in ["acme-suite", "vendor-tools"] {
        let entry = catalog.iter().find(|p| p.name == name).unwrap();
        assert_eq!(entry.discovery_kind, "marketplace", "{name}");
    }

    let resolved = resolve(
        &fx,
        "go",
        &[plugin_ref("acme-suite"), plugin_ref("vendor-tools")],
    );
    assert_eq!(
        resolved,
        vec![
            ReferencedPluginContext {
                name: "acme-suite".to_owned(),
                display_name: "acme-suite".to_owned(),
                skill_names: vec!["acme-suite:runner".to_owned()],
            },
            ReferencedPluginContext {
                name: "vendor-tools".to_owned(),
                display_name: "vendor-tools".to_owned(),
                skill_names: vec!["vendor-tools:lint".to_owned()],
            },
        ]
    );

    // The install directory name is not a catalog name.
    assert!(resolve(&fx, "go", &[plugin_ref("acme-suite-src")]).is_empty());
    assert!(resolve(&fx, "go", &[plugin_ref("tools-src")]).is_empty());
}

#[test]
fn disabled_plugin_does_not_resolve() {
    let fx = fixture();
    let plugin_dir = fx.cfg.workspace_plugins_dir.join("quiet");
    write_plugin(&plugin_dir, json!({ "name": "quiet" }), &["hush"]);
    // Even a root document does not make a disabled plugin resolvable.
    fs::write(plugin_dir.join("PLUGIN.md"), "Quiet plugin docs.").unwrap();

    assert_eq!(resolve(&fx, "go", &[plugin_ref("quiet")]).len(), 1);

    ExtensionManager::new(fx.env.clone())
        .set_plugin_enabled(&fx.cfg, "quiet", None, false)
        .unwrap();
    assert!(
        installed_plugin_catalog(&fx.cfg)
            .iter()
            .any(|p| p.name == "quiet" && !p.enabled)
    );

    assert!(resolve(&fx, "go", &[plugin_ref("quiet")]).is_empty());
    assert!(resolve(&fx, "use @quiet now", &[]).is_empty());
}

#[test]
fn plugin_catalog_is_not_loaded_without_plugin_candidates() {
    let fx = fixture();
    let skills = discover_skills_for_config(&fx.cfg);
    let resolved =
        resolve_turn_references_with_plugin_catalog("no mentions here", &[], &skills, || {
            panic!("plugin catalog must load lazily")
        });
    assert!(resolved.referenced_plugins.is_empty());
}
