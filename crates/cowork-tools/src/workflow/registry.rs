use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use cowork_js_vm::{DEFAULT_INSPECTION_TIMEOUT_MS, inspect_workflow_source};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const WORKFLOW_DEFINITION_MAX_BYTES: usize = 200_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowDefinitionScope {
    Project,
    Global,
    Bundled,
}

impl WorkflowDefinitionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
            Self::Bundled => "bundled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCatalogEntry {
    pub name: String,
    pub description: String,
    pub phases: Vec<String>,
    pub scope: WorkflowDefinitionScope,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCatalogDiagnostic {
    pub name: String,
    pub scope: WorkflowDefinitionScope,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCatalogSnapshot {
    pub workflows: Vec<WorkflowCatalogEntry>,
    pub diagnostics: Vec<WorkflowCatalogDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkflowExecutionDefinition {
    pub name: String,
    pub scope: WorkflowDefinitionScope,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct WorkflowRegistryPaths {
    pub project_cowork_dir: PathBuf,
    pub user_cowork_dir: PathBuf,
    pub built_in_dir: Option<PathBuf>,
}

pub fn is_valid_workflow_definition_name(s: &str) -> bool {
    if s.is_empty() || s.len() > 80 {
        return false;
    }
    let bytes = s.as_bytes();
    if bytes.first() == Some(&b'-') || bytes.last() == Some(&b'-') {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        if b == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else if b.is_ascii_lowercase() || b.is_ascii_digit() {
            prev_hyphen = false;
        } else {
            return false;
        }
    }
    true
}

pub fn assert_workflow_definition_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if !is_valid_workflow_definition_name(trimmed) {
        return Err(
            "workflow name must be 1-80 characters of lowercase letters, digits, and single hyphens"
                .to_owned(),
        );
    }
    Ok(trimmed.to_owned())
}

fn workflow_definition_roots(
    paths: &WorkflowRegistryPaths,
) -> Vec<(WorkflowDefinitionScope, PathBuf)> {
    let mut out = vec![
        (
            WorkflowDefinitionScope::Project,
            paths.project_cowork_dir.join("workflows"),
        ),
        (
            WorkflowDefinitionScope::Global,
            paths.user_cowork_dir.join("workflows"),
        ),
    ];
    if let Some(ref built_in) = paths.built_in_dir {
        out.push((WorkflowDefinitionScope::Bundled, built_in.join("workflows")));
    }
    out
}

fn assert_safe_workflow_directory(dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                Err(
                    "workflow definition directory must be a real directory, not a symlink"
                        .to_owned(),
                )
            } else {
                Ok(())
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "failed stating workflow directory {}: {e}",
            dir.display()
        )),
    }
}

fn read_definition_source(path: &Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("failed stating workflow file {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("workflow definition must be a regular file, not a symlink".to_owned());
    }
    if meta.len() > WORKFLOW_DEFINITION_MAX_BYTES as u64 {
        return Err(format!(
            "workflow definition exceeds the {WORKFLOW_DEFINITION_MAX_BYTES}-byte limit"
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("failed reading {}: {e}", path.display()))
}

fn list_names_in_dir(dir: &Path) -> Vec<String> {
    if assert_safe_workflow_directory(dir).is_err() {
        return Vec::new();
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() || ft.is_symlink() {
            continue;
        }
        let file_name = entry.file_name();
        let Some(name_str) = file_name.to_str() else {
            continue;
        };
        let Some(stem) = name_str.strip_suffix(".ts") else {
            continue;
        };
        if is_valid_workflow_definition_name(stem) {
            names.push(stem.to_owned());
        }
    }
    names.sort();
    names
}

async fn inspect_definition(
    name: &str,
    scope: WorkflowDefinitionScope,
    path: &Path,
) -> Result<(WorkflowCatalogEntry, String), String> {
    let source = read_definition_source(path)?;
    let inspected = inspect_workflow_source(&source, DEFAULT_INSPECTION_TIMEOUT_MS)
        .await
        .map_err(|issues| {
            issues
                .into_iter()
                .map(|i| format!("{}: {}", i.path, i.message))
                .collect::<Vec<_>>()
                .join("; ")
        })?;
    if inspected.meta.name != name {
        return Err(format!(
            "workflow filename/name mismatch: expected meta.name \"{name}\", found \"{}\"",
            inspected.meta.name
        ));
    }
    Ok((
        WorkflowCatalogEntry {
            name: name.to_owned(),
            description: inspected.meta.description,
            phases: inspected.meta.phases,
            scope,
            path: path.to_string_lossy().into_owned(),
        },
        source,
    ))
}

pub async fn list_workflow_definitions(paths: &WorkflowRegistryPaths) -> WorkflowCatalogSnapshot {
    let mut selected = BTreeMap::<String, (WorkflowDefinitionScope, PathBuf)>::new();
    for (scope, root_dir) in workflow_definition_roots(paths) {
        for name in list_names_in_dir(&root_dir) {
            selected
                .entry(name.clone())
                .or_insert_with(|| (scope, root_dir.join(format!("{name}.ts"))));
        }
    }

    let mut workflows = Vec::new();
    let mut diagnostics = Vec::new();
    for (name, (scope, file_path)) in selected {
        match inspect_definition(&name, scope, &file_path).await {
            Ok((entry, _)) => workflows.push(entry),
            Err(message) => diagnostics.push(WorkflowCatalogDiagnostic {
                name,
                scope,
                path: file_path.to_string_lossy().into_owned(),
                message,
            }),
        }
    }

    WorkflowCatalogSnapshot {
        workflows,
        diagnostics,
    }
}

pub async fn resolve_workflow_definition_for_execution(
    paths: &WorkflowRegistryPaths,
    raw_name: &str,
) -> Result<ResolvedWorkflowExecutionDefinition, String> {
    let safe_name = assert_workflow_definition_name(raw_name)?;
    for (scope, root_dir) in workflow_definition_roots(paths) {
        assert_safe_workflow_directory(&root_dir)?;
        let target_path = root_dir.join(format!("{safe_name}.ts"));
        if target_path.exists() || fs::symlink_metadata(&target_path).is_ok() {
            let source = read_definition_source(&target_path)?;
            return Ok(ResolvedWorkflowExecutionDefinition {
                name: safe_name,
                scope,
                path: target_path.to_string_lossy().into_owned(),
                source,
            });
        }
    }
    Err(format!("saved workflow \"{safe_name}\" was not found"))
}

pub async fn save_workflow_definition(
    paths: &WorkflowRegistryPaths,
    raw_name: &str,
    scope: WorkflowDefinitionScope,
    raw_source: &str,
    overwrite: bool,
) -> Result<WorkflowCatalogEntry, String> {
    if scope == WorkflowDefinitionScope::Bundled {
        return Err("workflow scope \"bundled\" is not writable".to_owned());
    }
    let name = assert_workflow_definition_name(raw_name)?;
    let source = format!("{}\n", raw_source.trim_end());
    if source.len() > WORKFLOW_DEFINITION_MAX_BYTES {
        return Err(format!(
            "workflow definition exceeds the {WORKFLOW_DEFINITION_MAX_BYTES}-byte limit"
        ));
    }

    let inspected = inspect_workflow_source(&source, DEFAULT_INSPECTION_TIMEOUT_MS)
        .await
        .map_err(|issues| {
            issues
                .into_iter()
                .map(|i| format!("{}: {}", i.path, i.message))
                .collect::<Vec<_>>()
                .join("; ")
        })?;
    if inspected.meta.name != name {
        return Err(format!(
            "workflow save name must match meta.name: expected \"{name}\", found \"{}\"",
            inspected.meta.name
        ));
    }

    let root_dir = match scope {
        WorkflowDefinitionScope::Project => paths.project_cowork_dir.join("workflows"),
        WorkflowDefinitionScope::Global => paths.user_cowork_dir.join("workflows"),
        WorkflowDefinitionScope::Bundled => unreachable!(),
    };

    fs::create_dir_all(&root_dir).map_err(|e| {
        format!(
            "failed creating workflow directory {}: {e}",
            root_dir.display()
        )
    })?;
    assert_safe_workflow_directory(&root_dir)?;
    let target_path = root_dir.join(format!("{name}.ts"));

    if !overwrite {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!(
                        "workflow \"{name}\" already exists in {} scope; pass overwrite:true to replace it",
                        scope.as_str()
                    )
                } else {
                    format!("failed creating workflow file {}: {e}", target_path.display())
                }
            })?;
        f.write_all(source.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| {
                format!(
                    "failed writing workflow file {}: {e}",
                    target_path.display()
                )
            })?;
    } else {
        if let Ok(existing) = fs::symlink_metadata(&target_path)
            && (existing.file_type().is_symlink() || !existing.is_file())
        {
            return Err(
                "refusing to overwrite a workflow path that is not a regular file".to_owned(),
            );
        }
        let temp_path = root_dir.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
        let write_res = (|| -> Result<(), String> {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)
                .map_err(|e| format!("failed creating temp workflow file: {e}"))?;
            f.write_all(source.as_bytes())
                .and_then(|_| f.sync_all())
                .map_err(|e| format!("failed writing temp workflow file: {e}"))?;
            assert_safe_workflow_directory(&root_dir)?;
            if let Ok(existing) = fs::symlink_metadata(&target_path)
                && (existing.file_type().is_symlink() || !existing.is_file())
            {
                return Err(
                    "refusing to overwrite a workflow path that is not a regular file".to_owned(),
                );
            }
            fs::rename(&temp_path, &target_path)
                .map_err(|e| format!("failed replacing workflow file: {e}"))?;
            Ok(())
        })();
        if let Err(err) = write_res {
            let _ = fs::remove_file(&temp_path);
            return Err(err);
        }
    }

    Ok(WorkflowCatalogEntry {
        name,
        description: inspected.meta.description,
        phases: inspected.meta.phases,
        scope,
        path: target_path.to_string_lossy().into_owned(),
    })
}
