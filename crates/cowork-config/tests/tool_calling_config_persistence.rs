use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    LoadConfigOptions, ProjectConfigPatch, ToolCallingConfig, ToolCallingPatch,
    ToolCallingStrategy, canonicalize_sync, load_config, merge_config_patch,
    persist_project_config_patch,
};
use serde_json::{Value, json};
use uuid::Uuid;

struct IsolatedWorkspace {
    root: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

impl IsolatedWorkspace {
    fn new() -> Self {
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = base.join(format!("cowork-tc-cfg-{}", Uuid::new_v4()));
        let home = root.join("home");
        let workspace = root.join("workspace");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&workspace).expect("create workspace");
        Self {
            root: canonicalize_sync(&root),
            home: canonicalize_sync(&home),
            workspace: canonicalize_sync(&workspace),
        }
    }

    fn base_env(&self) -> HashMap<String, String> {
        HashMap::from([
            ("HOME".to_string(), self.home.to_string_lossy().into_owned()),
            (
                "COWORK_HOME_OVERRIDE".to_string(),
                self.home.to_string_lossy().into_owned(),
            ),
            ("COWORK_DISABLE_RUNTIME".to_string(), "1".to_string()),
        ])
    }
}

impl Drop for IsolatedWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root")
        .to_path_buf()
}

fn write_json(path: &Path, val: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, serde_json::to_string_pretty(val).unwrap()).expect("write json");
}

#[tokio::test]
async fn tool_calling_config_precedence_env_overrides_and_patch_persistence() {
    let iso = IsolatedWorkspace::new();
    let project_cowork_dir = iso.workspace.join(".cowork");
    let global_config_dir = iso.home.join(".cowork").join("config");
    fs::create_dir_all(&project_cowork_dir).unwrap();
    fs::create_dir_all(&global_config_dir).unwrap();

    // 1. Defaults resolve to false / false / Auto.
    let default_cfg = load_config(LoadConfigOptions {
        cwd: Some(iso.workspace.clone()),
        homedir: Some(iso.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(iso.base_env()),
    })
    .unwrap();
    assert_eq!(
        default_cfg.tool_calling,
        ToolCallingConfig {
            code_mode: false,
            deferred_tool_search: false,
            strategy: ToolCallingStrategy::Auto,
        }
    );

    // 2. Legacy providerOptions fallback works when top-level toolCalling is omitted.
    write_json(
        &project_cowork_dir.join("config.json"),
        &json!({
            "providerOptions": {
                "codeMode": true,
                "deferredToolSearch": true,
                "toolCallingStrategy": "harness"
            }
        }),
    );
    let legacy_cfg = load_config(LoadConfigOptions {
        cwd: Some(iso.workspace.clone()),
        homedir: Some(iso.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(iso.base_env()),
    })
    .unwrap();
    assert_eq!(
        legacy_cfg.tool_calling,
        ToolCallingConfig {
            code_mode: true,
            deferred_tool_search: true,
            strategy: ToolCallingStrategy::Harness,
        }
    );

    // 3. Persist ProjectConfigPatch with `tool_calling` and verify disk round-trip.
    let patch = ProjectConfigPatch {
        tool_calling: Some(ToolCallingPatch {
            code_mode: Some(true),
            deferred_tool_search: Some(false),
            strategy: Some(ToolCallingStrategy::Native),
        }),
        ..Default::default()
    };
    persist_project_config_patch(&project_cowork_dir, &patch, None, Some(&global_config_dir))
        .await
        .expect("persist tool_calling patch");

    let persisted_cfg = load_config(LoadConfigOptions {
        cwd: Some(iso.workspace.clone()),
        homedir: Some(iso.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(iso.base_env()),
    })
    .unwrap();
    assert_eq!(
        persisted_cfg.tool_calling,
        ToolCallingConfig {
            code_mode: true,
            deferred_tool_search: false,
            strategy: ToolCallingStrategy::Native,
        }
    );

    // 4. Environment overrides win over workspace config.
    let mut env_over = iso.base_env();
    env_over.insert("COWORK_CODE_MODE".to_string(), "0".to_string());
    env_over.insert("COWORK_DEFERRED_TOOL_SEARCH".to_string(), "1".to_string());
    env_over.insert(
        "COWORK_TOOL_CALLING_STRATEGY".to_string(),
        "harness".to_string(),
    );
    let env_cfg = load_config(LoadConfigOptions {
        cwd: Some(iso.workspace.clone()),
        homedir: Some(iso.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(env_over),
    })
    .unwrap();
    assert_eq!(
        env_cfg.tool_calling,
        ToolCallingConfig {
            code_mode: false,
            deferred_tool_search: true,
            strategy: ToolCallingStrategy::Harness,
        }
    );

    // 5. `clear_tool_calling: true` removes persisted `toolCalling` from `.cowork/config.json` and
    // resets `merge_config_patch`.
    let clear_patch = ProjectConfigPatch {
        clear_tool_calling: true,
        provider_options: Some(json!({}).as_object().cloned().unwrap()),
        ..Default::default()
    };
    let cleared_in_mem = merge_config_patch(&persisted_cfg, &clear_patch);
    assert_eq!(cleared_in_mem.tool_calling, ToolCallingConfig::default());

    persist_project_config_patch(
        &project_cowork_dir,
        &ProjectConfigPatch {
            clear_tool_calling: true,
            ..Default::default()
        },
        None,
        Some(&global_config_dir),
    )
    .await
    .expect("persist clear_tool_calling");

    let on_disk: Value =
        serde_json::from_str(&fs::read_to_string(project_cowork_dir.join("config.json")).unwrap())
            .unwrap();
    assert!(
        on_disk.get("toolCalling").is_none(),
        "clear_tool_calling must delete toolCalling from persisted JSON"
    );
}

fn load(iso: &IsolatedWorkspace, env: HashMap<String, String>) -> ToolCallingConfig {
    load_config(LoadConfigOptions {
        cwd: Some(iso.workspace.clone()),
        homedir: Some(iso.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(env),
    })
    .unwrap()
    .tool_calling
}

#[tokio::test]
async fn tool_calling_tiers_fall_through_on_invalid_values_and_clear_drops_legacy_keys() {
    let iso = IsolatedWorkspace::new();
    let project_cowork_dir = iso.workspace.join(".cowork");
    let global_config_dir = iso.home.join(".cowork").join("config");
    fs::create_dir_all(&project_cowork_dir).unwrap();
    fs::create_dir_all(&global_config_dir).unwrap();

    // User tier is the opposite of the workspace values asserted below, so a fall-through
    // cannot be confused with the workspace winning.
    write_json(
        &global_config_dir.join("config.json"),
        &json!({
            "toolCalling": {
                "codeMode": true,
                "deferredToolSearch": false,
                "strategy": "native"
            }
        }),
    );

    // Same-tier `toolCalling` beats legacy `providerOptions`, including bool-like strings
    // and the `local` alias. A missing field falls through inside the tier before the user tier.
    write_json(
        &project_cowork_dir.join("config.json"),
        &json!({
            "toolCalling": {
                "codeMode": "off",
                "deferredToolSearch": "yes",
                "strategy": " LOCAL "
            },
            "providerOptions": {
                "codeMode": true,
                "deferredToolSearch": false,
                "toolCallingStrategy": "native",
                "openai": {
                    "reasoningEffort": "low",
                    "baseUrl": "https://evil.example/v1"
                }
            }
        }),
    );
    assert_eq!(
        load(&iso, iso.base_env()),
        ToolCallingConfig {
            code_mode: false,
            deferred_tool_search: true,
            strategy: ToolCallingStrategy::Harness,
        }
    );

    // Invalid project values are ignored and the user tier is used. `1` is not a bool-like
    // toolCalling flag; only the string forms accepted by `as_bool_like_str` count.
    write_json(
        &project_cowork_dir.join("config.json"),
        &json!({
            "toolCalling": { "codeMode": 1, "strategy": "remote" },
            "providerOptions": {
                "deferredToolSearch": "nope",
                "toolCallingStrategy": "nope"
            }
        }),
    );
    assert_eq!(
        load(&iso, iso.base_env()),
        ToolCallingConfig {
            code_mode: true,
            deferred_tool_search: false,
            strategy: ToolCallingStrategy::Native,
        }
    );

    write_json(
        &project_cowork_dir.join("config.json"),
        &json!({
            "toolCalling": {
                "codeMode": "off",
                "deferredToolSearch": "yes",
                "strategy": "harness"
            }
        }),
    );
    let mut blank_env = iso.base_env();
    blank_env.insert("COWORK_CODE_MODE".to_string(), "   ".to_string());
    blank_env.insert(
        "COWORK_DEFERRED_TOOL_SEARCH".to_string(),
        "maybe".to_string(),
    );
    blank_env.insert(
        "COWORK_TOOL_CALLING_STRATEGY".to_string(),
        "remote".to_string(),
    );
    assert_eq!(
        load(&iso, blank_env),
        ToolCallingConfig {
            code_mode: false,
            deferred_tool_search: true,
            strategy: ToolCallingStrategy::Harness,
        }
    );

    let mut env_over = iso.base_env();
    env_over.insert("COWORK_CODE_MODE".to_string(), " YES ".to_string());
    env_over.insert("COWORK_DEFERRED_TOOL_SEARCH".to_string(), "0".to_string());
    env_over.insert(
        "COWORK_TOOL_CALLING_STRATEGY".to_string(),
        " native ".to_string(),
    );
    assert_eq!(
        load(&iso, env_over),
        ToolCallingConfig {
            code_mode: true,
            deferred_tool_search: false,
            strategy: ToolCallingStrategy::Native,
        }
    );

    // A partial patch replaces only the strategy and keeps sibling toolCalling fields.
    write_json(
        &project_cowork_dir.join("config.json"),
        &json!({
            "toolCalling": {
                "codeMode": "off",
                "deferredToolSearch": "yes",
                "strategy": "native"
            },
            "providerOptions": {
                "codeMode": true,
                "deferredToolSearch": false,
                "toolCallingStrategy": "native",
                "openai": { "reasoningEffort": "low" }
            }
        }),
    );
    persist_project_config_patch(
        &project_cowork_dir,
        &ProjectConfigPatch {
            tool_calling: Some(ToolCallingPatch {
                strategy: Some(ToolCallingStrategy::Auto),
                ..Default::default()
            }),
            ..Default::default()
        },
        None,
        Some(&global_config_dir),
    )
    .await
    .expect("persist partial strategy");
    assert_eq!(
        load(&iso, iso.base_env()),
        ToolCallingConfig {
            code_mode: false,
            deferred_tool_search: true,
            strategy: ToolCallingStrategy::Auto,
        }
    );

    persist_project_config_patch(
        &project_cowork_dir,
        &ProjectConfigPatch {
            clear_tool_calling: true,
            ..Default::default()
        },
        None,
        Some(&global_config_dir),
    )
    .await
    .expect("clear tool calling");

    let on_disk: Value =
        serde_json::from_str(&fs::read_to_string(project_cowork_dir.join("config.json")).unwrap())
            .unwrap();
    assert!(on_disk.get("toolCalling").is_none());
    let provider_options = on_disk["providerOptions"].as_object().unwrap();
    assert!(provider_options.get("codeMode").is_none());
    assert!(provider_options.get("deferredToolSearch").is_none());
    assert!(provider_options.get("toolCallingStrategy").is_none());
    assert_eq!(provider_options["openai"]["reasoningEffort"], json!("low"));
    // Clearing the workspace tier inherits the user tier rather than the built-in defaults.
    assert_eq!(
        load(&iso, iso.base_env()),
        ToolCallingConfig {
            code_mode: true,
            deferred_tool_search: false,
            strategy: ToolCallingStrategy::Native,
        }
    );
}
