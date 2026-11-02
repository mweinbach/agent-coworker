//! Regression (TS `test/plugins.catalog.test.ts` "plugin manifests can declare multiple bundled
//! skills directories"): a plugin manifest with `skills: ["./skills-a", "./skills-b"]` must expose
//! the skills from every declared directory in the plugin catalog, the skill installations list,
//! and runtime skill discovery.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use cowork_config::{LoadConfigOptions, load_config};
use cowork_harness::extensions::ExtensionManager;
use cowork_tools::discover_skills_for_config;
use serde_json::json;

fn write_bundled_skill(skills_dir: &Path, name: &str, description: &str) {
    let dir = skills_dir.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"),
    )
    .unwrap();
}

#[test]
fn plugin_manifests_can_declare_multiple_bundled_skills_directories() {
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

    let plugin_root = ws.join(".agents/plugins/multi-skill");
    fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        serde_json::to_string_pretty(&json!({
            "name": "multi-skill",
            "description": "Plugin with multiple bundled skill directories",
            "skills": ["./skills-a", "./skills-b"]
        }))
        .unwrap(),
    )
    .unwrap();
    write_bundled_skill(&plugin_root.join("skills-a"), "alpha", "Alpha skill");
    write_bundled_skill(&plugin_root.join("skills-b"), "beta", "Beta skill");

    let ext = ExtensionManager::new(env);
    let (plugins, warnings) = ext.collect_installed_plugins(&cfg);
    assert!(warnings.is_empty(), "{warnings:?}");
    let plugin = plugins.iter().find(|p| p.id == "multi-skill").unwrap();
    assert_eq!(
        plugin.skills_path,
        plugin_root.join("skills-a").to_string_lossy()
    );
    let raw_names: Vec<&str> = plugin.skills.iter().map(|s| s.raw_name.as_str()).collect();
    assert_eq!(raw_names, ["alpha", "beta"]);

    let mut installed: Vec<String> = ext
        .collect_skill_installations(&cfg)
        .into_iter()
        .filter(|s| s.name.starts_with("multi-skill:"))
        .map(|s| s.name)
        .collect();
    installed.sort();
    assert_eq!(installed, ["multi-skill:alpha", "multi-skill:beta"]);

    let mut discovered: Vec<String> = discover_skills_for_config(&cfg)
        .into_values()
        .filter(|s| s.plugin_id.as_deref() == Some("multi-skill"))
        .map(|s| s.name)
        .collect();
    discovered.sort();
    assert_eq!(discovered, ["multi-skill:alpha", "multi-skill:beta"]);
}
