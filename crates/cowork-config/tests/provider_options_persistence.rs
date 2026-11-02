//! `persist_project_config_patch` provider-option persistence parity with
//! `ConfigPatchStore.ts`: each editable provider section is merged shallowly
//! (`{...runtime, ...persisted, ...patch}`), so a nested value in the patch replaces the
//! persisted one wholesale and explicit nested clears survive the write.

use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{ProjectConfigPatch, persist_project_config_patch};
use serde_json::{Map, Value, json};

struct Workspace {
    _root: tempfile::TempDir,
    project_cowork_dir: PathBuf,
    global_config_dir: PathBuf,
}

impl Workspace {
    fn new(persisted: Value) -> Self {
        let root = tempfile::tempdir().expect("tempdir");
        let project_cowork_dir = root.path().join("workspace").join(".cowork");
        let global_config_dir = root.path().join("home").join(".cowork").join("config");
        fs::create_dir_all(&project_cowork_dir).expect("create project dir");
        fs::create_dir_all(&global_config_dir).expect("create global dir");
        fs::write(
            project_cowork_dir.join("config.json"),
            serde_json::to_string_pretty(&persisted).expect("serialize"),
        )
        .expect("write config");
        Self {
            _root: root,
            project_cowork_dir,
            global_config_dir,
        }
    }

    async fn persist(&self, provider_options: Value, runtime: Option<Value>) -> Value {
        let patch = ProjectConfigPatch {
            provider_options: Some(as_map(provider_options)),
            ..Default::default()
        };
        let runtime = runtime.map(as_map);
        persist_project_config_patch(
            &self.project_cowork_dir,
            &patch,
            runtime.as_ref(),
            Some(&self.global_config_dir),
        )
        .await
        .expect("persist patch");
        read_json(&self.project_cowork_dir.join("config.json"))
    }
}

fn as_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected object, got {other}"),
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("read config")).expect("parse config")
}

#[tokio::test]
async fn google_empty_thinking_config_clears_persisted_level() {
    let ws = Workspace::new(json!({
        "model": "gemini-3-pro",
        "providerOptions": {
            "google": {
                "nativeWebSearch": false,
                "thinkingConfig": { "thinkingLevel": "high" }
            },
            "openai": { "reasoningEffort": "low" }
        }
    }));

    // `googleProviderOptionsForReasoningEffort("dynamic")` sends `thinkingConfig: {}`.
    let written = ws
        .persist(json!({ "google": { "thinkingConfig": {} } }), None)
        .await;

    assert_eq!(
        written,
        json!({
            "model": "gemini-3-pro",
            "providerOptions": {
                "google": {
                    "nativeWebSearch": false,
                    "thinkingConfig": {}
                },
                "openai": { "reasoningEffort": "low" }
            }
        })
    );
}

#[tokio::test]
async fn google_new_thinking_level_replaces_persisted_level() {
    let ws = Workspace::new(json!({
        "providerOptions": {
            "google": {
                "nativeWebSearch": true,
                "responseMimeType": "text/plain",
                "thinkingConfig": { "thinkingLevel": "high" }
            }
        }
    }));

    let written = ws
        .persist(
            json!({ "google": { "thinkingConfig": { "thinkingLevel": "low" } } }),
            None,
        )
        .await;

    assert_eq!(
        written["providerOptions"],
        json!({
            "google": {
                "nativeWebSearch": true,
                "responseMimeType": "text/plain",
                "thinkingConfig": { "thinkingLevel": "low" }
            }
        })
    );
}

#[tokio::test]
async fn google_clear_overrides_runtime_level_and_keeps_runtime_siblings() {
    // Merge order (lowest -> highest priority): runtime, persisted config, incoming patch.
    let ws = Workspace::new(json!({}));

    let written = ws
        .persist(
            json!({ "google": { "thinkingConfig": {} } }),
            Some(json!({
                "google": {
                    "nativeWebSearch": false,
                    "thinkingConfig": { "thinkingLevel": "medium" }
                }
            })),
        )
        .await;

    assert_eq!(
        written["providerOptions"],
        json!({
            "google": {
                "nativeWebSearch": false,
                "thinkingConfig": {}
            }
        })
    );
}

#[tokio::test]
async fn codex_web_search_patch_replaces_persisted_web_search() {
    let ws = Workspace::new(json!({
        "providerOptions": {
            "codex-cli": {
                "reasoningEffort": "high",
                "webSearchMode": "live",
                "webSearch": {
                    "contextSize": "low",
                    "allowedDomains": ["old.example.com"],
                    "location": { "country": "US", "city": "Boston" }
                }
            }
        }
    }));

    // The client merged the section and cleared `location`; the persisted object must not
    // resurrect it (or the stale `allowedDomains`).
    let written = ws
        .persist(
            json!({
                "codex-cli": {
                    "webSearch": {
                        "contextSize": "high",
                        "allowedDomains": ["new.example.com"]
                    }
                }
            }),
            None,
        )
        .await;

    assert_eq!(
        written["providerOptions"],
        json!({
            "codex-cli": {
                "reasoningEffort": "high",
                "webSearchMode": "live",
                "webSearch": {
                    "contextSize": "high",
                    "allowedDomains": ["new.example.com"]
                }
            }
        })
    );
}

#[tokio::test]
async fn openai_patch_merges_fields_and_keeps_siblings() {
    let ws = Workspace::new(json!({
        "providerOptions": {
            "openai": {
                "reasoningEffort": "high",
                "reasoningSummary": "detailed",
                "textVerbosity": "low"
            }
        }
    }));

    let written = ws
        .persist(json!({ "openai": { "reasoningEffort": "minimal" } }), None)
        .await;

    assert_eq!(
        written["providerOptions"],
        json!({
            "openai": {
                "reasoningEffort": "minimal",
                "reasoningSummary": "detailed",
                "textVerbosity": "low"
            }
        })
    );
}

#[tokio::test]
async fn lmstudio_patch_merges_fields_and_keeps_siblings() {
    let ws = Workspace::new(json!({
        "providerOptions": {
            "lmstudio": {
                "baseUrl": "http://127.0.0.1:1234",
                "contextLength": 8192,
                "autoLoad": true
            }
        }
    }));

    let written = ws
        .persist(
            json!({ "lmstudio": { "contextLength": 32768, "reloadOnContextMismatch": false } }),
            None,
        )
        .await;

    assert_eq!(
        written["providerOptions"],
        json!({
            "lmstudio": {
                "baseUrl": "http://127.0.0.1:1234",
                "contextLength": 32768,
                "autoLoad": true,
                "reloadOnContextMismatch": false
            }
        })
    );
}
