//! JSON-RPC route handlers for Milestone 3 extended surfaces:
//! - Canvas documents (`cowork/workspace/document/{open,revision,save,saveAs,close}`)
//! - Spreadsheets (`cowork/workspace/spreadsheet/{workbook,version,patch}`)
//! - Presentation previews (`cowork/workspace/presentation/preview`)
//! - Opt-in workspace backups (`cowork/backups/workspace/{read,delta/read,checkpoint,restore,deleteCheckpoint,deleteEntry}`)
//! - External skill & plugin importers (`cowork/import/{list,plugin,skill}`)
//! - External conversation importers (`cowork/conversationImport/{sources/list,preview,workspaceMappings/validate,import}`)
//! - Skill improvement (`cowork/skills/improvement/{status,run,restore}`)

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::{ProviderName, canonicalize_sync, get_ai_coworker_paths};
use cowork_harness::ExtensionManager;
use cowork_harness::backups::{BackupLifecycle, BackupTrigger, SessionLookupMetadata};
use cowork_harness::canvas::{
    CANVAS_DOCUMENT_MAX_BYTES, CanvasDocumentOpenRequest, CanvasDocumentSaveAsRequest,
    CanvasDocumentSaveRequest, CanvasDocumentSaveResult, CanvasDocumentSessionRef,
};
use cowork_harness::importers::{
    ConversationImportRunInput, ConversationImportService, ConversationSourceRequest,
    ConversationSourceSelectionOptions, ConversationWorkspaceMappingInput, ExternalImportSource,
    ImportableKind, KnownWorkspaceEntry, SelectedConversationInput, import_external_plugin,
    import_external_skill, list_importable,
};
use cowork_harness::ooxml::{
    FileChangeVersion, MAX_BATCH_PATCH_OPERATIONS, SpreadsheetBatchPatchOperation,
    SpreadsheetBatchPatchRequest, SpreadsheetEditResult, SpreadsheetFileVersionResult,
    SpreadsheetWorkbookRequest, patch_spreadsheet_batch, read_file_change_version,
    read_spreadsheet_file_version, read_spreadsheet_workbook_snapshot, resolve_workspace_file_path,
};
use cowork_harness::presentation::{PresentationPreviewRequest, preview_presentation_file};
use cowork_harness::skill_improvement::{SkillImprovementService, SkillImprovementServiceDeps};
use cowork_mcp::read_mcp_servers_snapshot;
use cowork_protocol::{JsonRpcLiteError, JsonRpcLiteNotification, error_codes};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::extension_mcp_agent_routes::build_mcp_servers_event;
use crate::http_desktop::build_workspace_summaries;
use crate::jsonrpc::ConnectionRpcState;
use crate::registry::ServerRuntimeState;

const BACKUPS_DISABLED_MESSAGE: &str = "Workspace backup APIs are disabled. Enable backups for this workspace or session to use advanced backup snapshots.";

// =============================================================================
// Strict Request Param Structs (exact parity with `schema.*.ts`)
// =============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpreadsheetWorkbookParams {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
    #[serde(default)]
    sheet_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpreadsheetVersionParams {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpreadsheetPatchParams {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
    operations: Vec<SpreadsheetBatchPatchOperation>,
    #[serde(default)]
    expected_file_version: Option<FileChangeVersion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresentationPreviewParams {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBackupsReadParams {
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBackupsDeltaReadParams {
    #[serde(default)]
    cwd: Option<String>,
    target_session_id: String,
    checkpoint_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBackupsCheckpointParams {
    #[serde(default)]
    cwd: Option<String>,
    target_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBackupsRestoreParams {
    #[serde(default)]
    cwd: Option<String>,
    target_session_id: String,
    #[serde(default)]
    checkpoint_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBackupsDeleteCheckpointParams {
    #[serde(default)]
    cwd: Option<String>,
    target_session_id: String,
    checkpoint_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBackupsDeleteEntryParams {
    #[serde(default)]
    cwd: Option<String>,
    target_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportListParams {
    #[serde(default)]
    cwd: Option<String>,
    source: ExternalImportSource,
    kind: ImportableKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportPluginParams {
    #[serde(default)]
    cwd: Option<String>,
    source: ExternalImportSource,
    source_path: String,
    conversion_required: bool,
    target_scope: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportSkillParams {
    #[serde(default)]
    cwd: Option<String>,
    source: ExternalImportSource,
    source_path: String,
    target_scope: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationImportSourcesListParams {
    #[serde(default)]
    sources: Option<Vec<ConversationSourceRequest>>,
    #[serde(default)]
    include_codex: Option<bool>,
    #[serde(default)]
    include_claude_code: Option<bool>,
    #[serde(default)]
    include_cowork: Option<bool>,
    #[serde(default)]
    explicit_paths: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationImportPreviewParams {
    #[serde(default)]
    sources: Option<Vec<ConversationSourceRequest>>,
    #[serde(default)]
    include_codex: Option<bool>,
    #[serde(default)]
    include_claude_code: Option<bool>,
    #[serde(default)]
    include_cowork: Option<bool>,
    #[serde(default)]
    explicit_paths: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    include_archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationImportValidateMappingsParams {
    mappings: BTreeMap<String, ConversationWorkspaceMappingInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationImportRunParams {
    #[serde(default)]
    sources: Option<Vec<ConversationSourceRequest>>,
    #[serde(default)]
    include_codex: Option<bool>,
    #[serde(default)]
    include_claude_code: Option<bool>,
    #[serde(default)]
    include_cowork: Option<bool>,
    #[serde(default)]
    explicit_paths: Option<Vec<String>>,
    selected: Vec<SelectedConversationInput>,
    #[serde(default)]
    mappings: Option<BTreeMap<String, ConversationWorkspaceMappingInput>>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    default_provider: Option<String>,
    #[serde(default)]
    default_model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    include_archived: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillImprovementStatusParams {
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillImprovementRunParams {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    skill_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillImprovementRestoreParams {
    #[serde(default)]
    cwd: Option<String>,
    skill_name: String,
}

// =============================================================================
// Param Validation Helpers
// =============================================================================

fn parse_strict_required<T: DeserializeOwned>(
    method: &str,
    raw: Option<&Value>,
) -> Result<T, JsonRpcLiteError> {
    let Some(val) = raw else {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid params"),
        ));
    };
    if !val.is_object() {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid params"),
        ));
    }
    serde_json::from_value::<T>(val.clone())
        .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {e}")))
}

fn parse_strict_optional<T: DeserializeOwned + Default>(
    method: &str,
    raw: Option<&Value>,
) -> Result<T, JsonRpcLiteError> {
    match raw {
        None | Some(Value::Null) => Ok(T::default()),
        Some(val) if val.is_object() => serde_json::from_value::<T>(val.clone()).map_err(|e| {
            JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {e}"))
        }),
        Some(_) => Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: invalid params"),
        )),
    }
}

fn require_non_empty_trimmed(
    method: &str,
    field: &str,
    raw: &str,
) -> Result<String, JsonRpcLiteError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: {field} must be a non-empty string"),
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_optional_non_empty_trimmed(
    method: &str,
    field: &str,
    raw: &Option<String>,
) -> Result<Option<String>, JsonRpcLiteError> {
    let Some(s) = raw else {
        return Ok(None);
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("{method}: {field} must be a non-empty string"),
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

fn validate_selection_non_empty(
    method: &str,
    sel: &ConversationSourceSelectionOptions,
) -> Result<(), JsonRpcLiteError> {
    if let Some(sources) = &sel.sources {
        for item in sources {
            if let Some(p) = &item.path
                && p.trim().is_empty()
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("{method}: source path must be non-empty"),
                ));
            }
        }
    }
    if let Some(paths) = &sel.explicit_paths {
        for p in paths {
            if p.trim().is_empty() {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("{method}: explicitPaths entries must be non-empty"),
                ));
            }
        }
    }
    Ok(())
}

fn defer_workspace_file_changed(
    conn: &ConnectionRpcState,
    cwd: &Path,
    file_path: &Path,
    fallback_version: FileChangeVersion,
) {
    let version = read_file_change_version(file_path).unwrap_or(fallback_version);
    conn.defer_post_response_broadcast(JsonRpcLiteNotification {
        method: "cowork/workspace/fileChanged".to_owned(),
        params: Some(json!({
            "cwd": cwd.to_string_lossy(),
            "kind": "changed",
            "path": file_path.to_string_lossy(),
            "version": version,
        })),
    });
}

// =============================================================================
// ServerRuntimeState Route Implementations
// =============================================================================

impl ServerRuntimeState {
    pub(crate) fn ensure_skill_improvement_service(
        self: &Arc<Self>,
    ) -> Arc<SkillImprovementService> {
        {
            let guard = self.skill_improvement.lock();
            if let Some((ref svc, _)) = *guard {
                return Arc::clone(svc);
            }
        }

        let ai_paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let weak_cfg = Arc::downgrade(self);
        let load_cfg: cowork_harness::skill_improvement::LoadConfigFn =
            Arc::new(move |cwd: Option<&Path>| {
                let rt = weak_cfg
                    .upgrade()
                    .ok_or_else(|| "Server runtime closed".to_owned())?;
                let target = cwd
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| rt.working_directory.clone());
                rt.load_workspace_config(&target).map_err(|e| e.to_string())
            });

        let weak_busy = Arc::downgrade(self);
        let has_busy: cowork_harness::skill_improvement::HasBusySessionsFn = Arc::new(move || {
            let Some(rt) = weak_busy.upgrade() else {
                return false;
            };
            if !rt.active_turns.is_empty() {
                return true;
            }
            if rt.sessions.iter().any(|e| e.value().lock().busy) {
                return true;
            }
            rt.agent_controls
                .iter()
                .any(|c| c.value().list(false).iter().any(|a| a.busy))
        });

        let weak_mut = Arc::downgrade(self);
        let signal_mut: cowork_harness::skill_improvement::SignalSkillMutationFn =
            Arc::new(move || {
                if let Some(rt) = weak_mut.upgrade() {
                    if let Some(bus) = rt.ensure_skill_mutation_bus() {
                        let _ = bus.publish_mutation();
                    }
                    let cwds: Vec<PathBuf> = rt
                        .workspace_subscribers
                        .iter()
                        .map(|e| PathBuf::from(e.key()))
                        .collect();
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        for cwd in cwds {
                            let rt_clone = Arc::clone(&rt);
                            handle.spawn(async move {
                                rt_clone.broadcast_workspace_control_refresh(&cwd).await;
                            });
                        }
                    }
                }
            });

        let weak_bcast = Arc::downgrade(self);
        let bcast_status: cowork_harness::skill_improvement::BroadcastSkillStatusFn =
            Arc::new(move |evt| {
                let Some(rt) = weak_bcast.upgrade() else {
                    return;
                };
                let Ok(val) = serde_json::to_value(&evt) else {
                    return;
                };
                let cwds: Vec<PathBuf> = rt
                    .workspace_subscribers
                    .iter()
                    .map(|e| PathBuf::from(e.key()))
                    .collect();
                for cwd in cwds {
                    rt.broadcast_control_event(&cwd, &val);
                }
            });

        let svc = Arc::new(SkillImprovementService::new(SkillImprovementServiceDeps {
            cowork_home: ai_paths.root_dir,
            env: self.env.clone(),
            load_config: load_cfg,
            has_busy_sessions: has_busy,
            signal_skill_mutation: signal_mut,
            broadcast_status: Some(bcast_status),
            improver: None,
        }));

        let ticker = if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let svc_bg = Arc::clone(&svc);
            Some(handle.spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(30));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let _ = svc_bg.run_due_job().await;
                }
            }))
        } else {
            None
        };

        let mut guard = self.skill_improvement.lock();
        if let Some((ref existing, _)) = *guard {
            if let Some(h) = ticker {
                h.abort();
            }
            return Arc::clone(existing);
        }
        *guard = Some((Arc::clone(&svc), ticker));
        svc
    }

    fn canvas_workspace_root(&self, method: &str) -> Result<PathBuf, JsonRpcLiteError> {
        let wd_str = self.working_directory.to_string_lossy();
        if wd_str.trim().is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method} requires a server-owned workspace root"),
            ));
        }
        Ok(canonicalize_sync(&self.working_directory))
    }

    // -------------------------------------------------------------------------
    // 1. Canvas, Spreadsheet & Presentation (`VAL-EXT-005`)
    // -------------------------------------------------------------------------

    pub async fn handle_office_workspace_rpc(
        self: &Arc<Self>,
        conn: &ConnectionRpcState,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        match method {
            "cowork/workspace/document/open" => {
                let mut p: CanvasDocumentOpenRequest = parse_strict_required(method, raw_params)?;
                p.path = require_non_empty_trimmed(method, "path", &p.path)?;
                p.document_id = require_non_empty_trimmed(method, "documentId", &p.document_id)?;
                if let Some(mb) = p.max_bytes
                    && (mb == 0 || mb > CANVAS_DOCUMENT_MAX_BYTES)
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!(
                            "{method}: maxBytes must be between 1 and {CANVAS_DOCUMENT_MAX_BYTES}"
                        ),
                    ));
                }
                let cwd = self.canvas_workspace_root(method)?;
                let res = self.canvas_documents.open(&cwd, p).await;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/document/revision" => {
                let mut p: CanvasDocumentSessionRef = parse_strict_required(method, raw_params)?;
                p.document_id = require_non_empty_trimmed(method, "documentId", &p.document_id)?;
                let cwd = self.canvas_workspace_root(method)?;
                let res = self.canvas_documents.revision(&cwd, p).await;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/document/save" => {
                let mut p: CanvasDocumentSaveRequest = parse_strict_required(method, raw_params)?;
                p.document_id = require_non_empty_trimmed(method, "documentId", &p.document_id)?;
                if p.content.len() > CANVAS_DOCUMENT_MAX_BYTES {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!(
                            "{method}: content exceeds maximum {CANVAS_DOCUMENT_MAX_BYTES} bytes"
                        ),
                    ));
                }
                let cwd = self.canvas_workspace_root(method)?;
                let res = self.canvas_documents.save(&cwd, p).await;
                if let CanvasDocumentSaveResult::Ok {
                    ok: true,
                    ref path,
                    ref revision,
                    ref status,
                    ..
                } = res
                    && status == "saved"
                {
                    defer_workspace_file_changed(conn, &cwd, Path::new(path), revision.clone());
                }
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/document/saveAs" => {
                let mut p: CanvasDocumentSaveAsRequest = parse_strict_required(method, raw_params)?;
                p.document_id = require_non_empty_trimmed(method, "documentId", &p.document_id)?;
                p.path = require_non_empty_trimmed(method, "path", &p.path)?;
                if p.content.len() > CANVAS_DOCUMENT_MAX_BYTES {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!(
                            "{method}: content exceeds maximum {CANVAS_DOCUMENT_MAX_BYTES} bytes"
                        ),
                    ));
                }
                let cwd = self.canvas_workspace_root(method)?;
                let res = self.canvas_documents.save_as(&cwd, p).await;
                if let CanvasDocumentSaveResult::Ok {
                    ok: true,
                    ref path,
                    ref revision,
                    ref status,
                    ..
                } = res
                    && status == "saved"
                {
                    defer_workspace_file_changed(conn, &cwd, Path::new(path), revision.clone());
                }
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/document/close" => {
                let mut p: CanvasDocumentSessionRef = parse_strict_required(method, raw_params)?;
                p.document_id = require_non_empty_trimmed(method, "documentId", &p.document_id)?;
                let cwd = self.canvas_workspace_root(method)?;
                let res = self
                    .canvas_documents
                    .close(&cwd, p)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/spreadsheet/workbook" => {
                let p: SpreadsheetWorkbookParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let file_path = require_non_empty_trimmed(method, "path", &p.path)?;
                let sheet_name =
                    validate_optional_non_empty_trimmed(method, "sheetName", &p.sheet_name)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                let res = tokio::task::spawn_blocking(move || {
                    read_spreadsheet_workbook_snapshot(&SpreadsheetWorkbookRequest {
                        cwd,
                        file_path,
                        sheet_name,
                    })
                })
                .await
                .map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })?;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/spreadsheet/version" => {
                let p: SpreadsheetVersionParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let file_path = require_non_empty_trimmed(method, "path", &p.path)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                let res = tokio::task::spawn_blocking(move || {
                    read_spreadsheet_file_version(&cwd, &file_path)
                })
                .await
                .map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })?;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/spreadsheet/patch" => {
                let p: SpreadsheetPatchParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let file_path = require_non_empty_trimmed(method, "path", &p.path)?;
                if p.operations.len() > MAX_BATCH_PATCH_OPERATIONS {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!(
                            "{method}: operations cannot exceed {MAX_BATCH_PATCH_OPERATIONS} items"
                        ),
                    ));
                }
                validate_spreadsheet_patch_ops(method, &p.operations)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                let cowork_home = get_ai_coworker_paths(Some(&self.homedir), &self.env).root_dir;
                let cwd_for_patch = cwd.clone();
                let path_for_patch = file_path.clone();
                let ops = p.operations;
                let expected = p.expected_file_version;
                let res = tokio::task::spawn_blocking(move || {
                    patch_spreadsheet_batch(&SpreadsheetBatchPatchRequest {
                        cwd: cwd_for_patch,
                        cowork_home,
                        file_path: path_for_patch,
                        operations: ops,
                        expected_file_version: expected,
                    })
                })
                .await
                .map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })?;

                if matches!(res, SpreadsheetEditResult::Ok { ok: true })
                    && let SpreadsheetFileVersionResult::Ok { ok: true, version } =
                        read_spreadsheet_file_version(&cwd, &file_path)
                    && let Ok(resolved_file) = resolve_workspace_file_path(&cwd, &file_path)
                {
                    defer_workspace_file_changed(conn, &cwd, &resolved_file, version);
                }

                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/workspace/presentation/preview" => {
                let p: PresentationPreviewParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let file_path = require_non_empty_trimmed(method, "path", &p.path)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                let res = preview_presentation_file(PresentationPreviewRequest {
                    cwd: &cwd,
                    file_path: &file_path,
                    soffice_runner: Some(&self.soffice_runner),
                    env: &self.env,
                    timeout_ms: None,
                })
                .await;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // -------------------------------------------------------------------------
    // 2. Opt-in Workspace Backups (`cowork/backups/workspace/*`, `VAL-EXT-006`)
    // -------------------------------------------------------------------------

    fn collect_backup_session_lookup(&self, cwd: &Path) -> HashMap<String, SessionLookupMetadata> {
        let cwd_str = cwd.to_string_lossy().into_owned();
        let mut map = HashMap::new();
        if let Ok(records) = self.session_db.list_sessions(Some(&cwd_str)) {
            for rec in records {
                map.insert(
                    rec.session_id,
                    SessionLookupMetadata {
                        lifecycle: BackupLifecycle::Closed,
                        title: Some(rec.title),
                        provider: Some(rec.provider.as_str().to_owned()),
                        model: Some(rec.model),
                        busy: false,
                    },
                );
            }
        }
        for entry in self.sessions.iter() {
            let live = entry.value().lock();
            if live.cwd == cwd_str {
                let busy = live.busy || self.active_turns.contains_key(&live.id);
                map.insert(
                    live.id.clone(),
                    SessionLookupMetadata {
                        lifecycle: BackupLifecycle::Active,
                        title: Some(live.title.clone()),
                        provider: Some(live.provider.as_str().to_owned()),
                        model: Some(live.model.clone()),
                        busy,
                    },
                );
            }
        }
        map
    }

    fn ensure_target_session_not_busy(
        &self,
        target_session_id: &str,
    ) -> Result<(), JsonRpcLiteError> {
        if self.active_turns.contains_key(target_session_id) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "Session is busy",
            ));
        }
        if let Some(live_arc) = self.get_live_thread(target_session_id)
            && live_arc.lock().busy
        {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "Session is busy",
            ));
        }
        Ok(())
    }

    pub async fn handle_workspace_backups_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        match method {
            "cowork/backups/workspace/read" => {
                let p: WorkspaceBackupsReadParams = parse_strict_optional(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                if !cfg.backups_enabled {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        BACKUPS_DISABLED_MESSAGE,
                    ));
                }
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let lookup = self.collect_backup_session_lookup(&cwd);
                let bm = Arc::clone(&self.backup_manager);
                let evt = tokio::task::spawn_blocking(move || {
                    bm.read_workspace_backups(&cwd, Some(session_id), |sid| {
                        lookup.get(sid).cloned().unwrap_or(SessionLookupMetadata {
                            lifecycle: BackupLifecycle::Deleted,
                            title: None,
                            provider: None,
                            model: None,
                            busy: false,
                        })
                    })
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                .map_err(|m| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        format!("Failed to list workspace backups: {m}"),
                    )
                })?;
                Ok(json!({ "event": evt }))
            }

            "cowork/backups/workspace/delta/read" => {
                let p: WorkspaceBackupsDeltaReadParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let target_sid =
                    require_non_empty_trimmed(method, "targetSessionId", &p.target_session_id)?;
                let cp_id = require_non_empty_trimmed(method, "checkpointId", &p.checkpoint_id)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                if !cfg.backups_enabled {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        BACKUPS_DISABLED_MESSAGE,
                    ));
                }
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let bm = Arc::clone(&self.backup_manager);
                let evt = tokio::task::spawn_blocking(move || {
                    bm.read_workspace_backup_delta(&cwd, &target_sid, &cp_id, Some(session_id))
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                .map_err(|m| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        format!("Failed to inspect workspace backup delta: {m}"),
                    )
                })?;
                Ok(json!({ "event": evt }))
            }

            "cowork/backups/workspace/checkpoint" => {
                let p: WorkspaceBackupsCheckpointParams =
                    parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let target_sid =
                    require_non_empty_trimmed(method, "targetSessionId", &p.target_session_id)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                if !cfg.backups_enabled {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        BACKUPS_DISABLED_MESSAGE,
                    ));
                }
                self.ensure_target_session_not_busy(&target_sid)?;
                let lookup = self.collect_backup_session_lookup(&cwd);
                let meta_hint = lookup.get(&target_sid).cloned();
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let bm = Arc::clone(&self.backup_manager);
                let cwd_for_op = cwd.clone();
                let target_for_op = target_sid.clone();
                let (evt, maybe_state) =
                    tokio::task::spawn_blocking(move || -> Result<_, String> {
                        let state_opt = bm.create_checkpoint(
                            &target_for_op,
                            &cwd_for_op,
                            BackupTrigger::Manual,
                            meta_hint.as_ref().and_then(|m| m.title.clone()),
                            meta_hint.as_ref().and_then(|m| m.provider.clone()),
                            meta_hint.as_ref().and_then(|m| m.model.clone()),
                        )?;
                        let evt =
                            bm.read_workspace_backups(&cwd_for_op, Some(session_id), |sid| {
                                lookup.get(sid).cloned().unwrap_or(SessionLookupMetadata {
                                    lifecycle: BackupLifecycle::Deleted,
                                    title: None,
                                    provider: None,
                                    model: None,
                                    busy: false,
                                })
                            })?;
                        Ok((evt, state_opt))
                    })
                    .await
                    .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                    .map_err(|m| {
                        JsonRpcLiteError::new(
                            error_codes::INVALID_REQUEST,
                            format!("Failed to create workspace checkpoint: {m}"),
                        )
                    })?;

                if let Some(ref state) = maybe_state
                    && self.get_live_thread(&target_sid).is_some()
                {
                    self.emit_session_backup_state(&target_sid, None, "manual_checkpoint", state);
                }
                Ok(json!({ "event": evt }))
            }

            "cowork/backups/workspace/restore" => {
                let p: WorkspaceBackupsRestoreParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let target_sid =
                    require_non_empty_trimmed(method, "targetSessionId", &p.target_session_id)?;
                let cp_id = p
                    .checkpoint_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                if !cfg.backups_enabled {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        BACKUPS_DISABLED_MESSAGE,
                    ));
                }
                self.ensure_target_session_not_busy(&target_sid)?;
                let lookup = self.collect_backup_session_lookup(&cwd);
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let bm = Arc::clone(&self.backup_manager);
                let cwd_for_op = cwd.clone();
                let target_for_op = target_sid.clone();
                let (evt, state) = tokio::task::spawn_blocking(move || {
                    bm.restore_workspace_backup(
                        &cwd_for_op,
                        &target_for_op,
                        cp_id.as_deref(),
                        Some(session_id),
                        |sid| {
                            lookup.get(sid).cloned().unwrap_or(SessionLookupMetadata {
                                lifecycle: BackupLifecycle::Deleted,
                                title: None,
                                provider: None,
                                model: None,
                                busy: false,
                            })
                        },
                    )
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                .map_err(|m| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        format!("Failed to restore workspace backup: {m}"),
                    )
                })?;

                if self.get_live_thread(&target_sid).is_some() {
                    self.emit_session_backup_state(&target_sid, None, "restore", &state);
                }
                Ok(json!({ "event": evt }))
            }

            "cowork/backups/workspace/deleteCheckpoint" => {
                let p: WorkspaceBackupsDeleteCheckpointParams =
                    parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let target_sid =
                    require_non_empty_trimmed(method, "targetSessionId", &p.target_session_id)?;
                let cp_id = require_non_empty_trimmed(method, "checkpointId", &p.checkpoint_id)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                if !cfg.backups_enabled {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        BACKUPS_DISABLED_MESSAGE,
                    ));
                }
                self.ensure_target_session_not_busy(&target_sid)?;
                let lookup = self.collect_backup_session_lookup(&cwd);
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let bm = Arc::clone(&self.backup_manager);
                let cwd_for_op = cwd.clone();
                let target_for_op = target_sid.clone();
                let (evt, state) = tokio::task::spawn_blocking(move || {
                    bm.delete_checkpoint(
                        &cwd_for_op,
                        &target_for_op,
                        &cp_id,
                        Some(session_id),
                        |sid| {
                            lookup.get(sid).cloned().unwrap_or(SessionLookupMetadata {
                                lifecycle: BackupLifecycle::Deleted,
                                title: None,
                                provider: None,
                                model: None,
                                busy: false,
                            })
                        },
                    )
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                .map_err(|m| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        format!("Failed to delete workspace checkpoint: {m}"),
                    )
                })?;

                if self.get_live_thread(&target_sid).is_some() {
                    self.emit_session_backup_state(&target_sid, None, "delete", &state);
                }
                Ok(json!({ "event": evt }))
            }

            "cowork/backups/workspace/deleteEntry" => {
                let p: WorkspaceBackupsDeleteEntryParams =
                    parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let target_sid =
                    require_non_empty_trimmed(method, "targetSessionId", &p.target_session_id)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                if !cfg.backups_enabled {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        BACKUPS_DISABLED_MESSAGE,
                    ));
                }
                self.ensure_target_session_not_busy(&target_sid)?;
                let lookup = self.collect_backup_session_lookup(&cwd);
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let bm = Arc::clone(&self.backup_manager);
                let cwd_for_op = cwd.clone();
                let target_for_op = target_sid.clone();
                let evt = tokio::task::spawn_blocking(move || {
                    bm.delete_entry(&cwd_for_op, &target_for_op, Some(session_id), |sid| {
                        lookup.get(sid).cloned().unwrap_or(SessionLookupMetadata {
                            lifecycle: BackupLifecycle::Deleted,
                            title: None,
                            provider: None,
                            model: None,
                            busy: false,
                        })
                    })
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                .map_err(|m| {
                    JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        format!("Failed to delete workspace backup: {m}"),
                    )
                })?;

                if let Some(live_arc) = self.get_live_thread(&target_sid) {
                    {
                        let mut live = live_arc.lock();
                        live.config_overrides
                            .insert("backupsEnabled".to_owned(), Value::Bool(false));
                    }
                    let _ = self
                        .persist_live_session(&live_arc, "backup_entry_deleted")
                        .await;
                    let disabled_state =
                        self.backup_manager
                            .read_session_backup_state(&target_sid, &cwd, false);
                    self.emit_session_backup_state(&target_sid, None, "delete", &disabled_state);
                }
                Ok(json!({ "event": evt }))
            }

            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // -------------------------------------------------------------------------
    // 3. External Skill & Plugin Importers (`cowork/import/*`, `VAL-EXT-006`)
    // -------------------------------------------------------------------------

    pub async fn handle_external_extension_import_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        match method {
            "cowork/import/list" => {
                let p: ImportListParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control(connection_id, &cwd);
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let ext = ExtensionManager::new(self.env.clone());
                let source = p.source;
                let kind = p.kind;
                let evt = tokio::task::spawn_blocking(move || {
                    list_importable(&ext, &cfg, source, kind, Some(session_id), None)
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
                Ok(json!({ "event": evt }))
            }

            "cowork/import/plugin" => {
                let p: ImportPluginParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let source_path = require_non_empty_trimmed(method, "sourcePath", &p.source_path)?;
                if p.target_scope != "workspace" && p.target_scope != "user" {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: targetScope must be 'workspace' or 'user'"),
                    ));
                }
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control(connection_id, &cwd);
                if let Some(reason) = self.workspace_mutation_block_reason(&cwd) {
                    return Err(JsonRpcLiteError::new(error_codes::INVALID_REQUEST, reason));
                }
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let ext = ExtensionManager::new(self.env.clone());
                let _ = p.source;

                import_external_plugin(
                    &ext,
                    &cfg,
                    Path::new(&source_path),
                    p.conversion_required,
                    &p.target_scope,
                )
                .await
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;

                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                if p.target_scope == "user" {
                    self.mcp_tool_cache.invalidate_all().await;
                } else {
                    self.mcp_tool_cache
                        .invalidate_workspace(&cfg_after.working_directory)
                        .await;
                }
                if let Some(bus) = self.ensure_skill_mutation_bus() {
                    let _ = bus.publish_mutation();
                }

                let (pcat, p_partial) = ext
                    .read_plugins_catalog_with_meta(&cfg_after)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;
                let mut plugins_evt = json!({
                    "type": "plugins_catalog",
                    "sessionId": session_id,
                    "catalog": pcat,
                });
                if p_partial {
                    plugins_evt["availablePluginsPartial"] = Value::Bool(true);
                }

                let skills_cat_evt = self
                    .build_skills_catalog_event(&ext, &cfg_after, &cwd, &session_id)
                    .await?;
                let skills_list_evt = json!({
                    "type": "skills_list",
                    "sessionId": session_id,
                    "skills": ext.list_effective_skills(&cfg_after),
                });
                let mcp_snap = read_mcp_servers_snapshot(&cfg_after)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, m))?;
                let mcp_evt =
                    build_mcp_servers_event(&session_id, mcp_snap, cfg_after.trust_workspace_mcp);

                let events = vec![plugins_evt, skills_cat_evt, skills_list_evt, mcp_evt];
                for evt in &events {
                    self.broadcast_control_event(&cwd, evt);
                }

                let mut props = BTreeMap::new();
                props.insert("scope".to_owned(), Value::String(p.target_scope));
                props.insert(
                    "source".to_owned(),
                    Value::String(p.source.as_str().to_owned()),
                );
                self.observability
                    .capture_product_event("plugin_installed", &props);

                Ok(json!({ "events": events }))
            }

            "cowork/import/skill" => {
                let p: ImportSkillParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let source_path = require_non_empty_trimmed(method, "sourcePath", &p.source_path)?;
                if p.target_scope != "workspace" && p.target_scope != "user" {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: targetScope must be 'workspace' or 'user'"),
                    ));
                }
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control(connection_id, &cwd);
                if let Some(reason) = self.workspace_mutation_block_reason(&cwd) {
                    return Err(JsonRpcLiteError::new(error_codes::INVALID_REQUEST, reason));
                }
                let cfg = self.load_workspace_config(&cwd).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                })?;
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let ext = ExtensionManager::new(self.env.clone());
                let _ = p.source;

                import_external_skill(&ext, &cfg, Path::new(&source_path), &p.target_scope)
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;

                let cfg_after = self.load_workspace_config(&cwd).unwrap_or(cfg);
                if let Some(bus) = self.ensure_skill_mutation_bus() {
                    let _ = bus.publish_mutation();
                }

                let evt = self
                    .build_skills_catalog_event(&ext, &cfg_after, &cwd, &session_id)
                    .await?;
                self.broadcast_control_event(&cwd, &evt);

                let mut props = BTreeMap::new();
                props.insert("scope".to_owned(), Value::String(p.target_scope));
                props.insert(
                    "source".to_owned(),
                    Value::String(p.source.as_str().to_owned()),
                );
                self.observability
                    .capture_product_event("skill_installed", &props);

                Ok(json!({ "event": evt }))
            }

            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // -------------------------------------------------------------------------
    // 4. External Conversation Importers (`cowork/conversationImport/*`)
    // -------------------------------------------------------------------------

    fn build_conversation_import_service(&self) -> ConversationImportService {
        ConversationImportService::new(
            Arc::clone(&self.session_db),
            self.homedir.clone(),
            Some(self.model_registry().clone()),
        )
    }

    fn known_workspaces_for_import(&self) -> Vec<KnownWorkspaceEntry> {
        let (summaries, _) = build_workspace_summaries(
            &self.working_directory,
            &self.homedir,
            self.desktop_service.as_deref(),
        );
        summaries
            .into_iter()
            .map(|w| KnownWorkspaceEntry {
                id: w.id,
                name: w.name,
                path: w.path,
            })
            .collect()
    }

    pub async fn handle_conversation_import_rpc(
        self: &Arc<Self>,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        match method {
            "cowork/conversationImport/sources/list" => {
                let p: ConversationImportSourcesListParams =
                    parse_strict_optional(method, raw_params)?;
                let selection = ConversationSourceSelectionOptions {
                    sources: p.sources,
                    include_codex: p.include_codex,
                    include_claude_code: p.include_claude_code,
                    include_cowork: p.include_cowork,
                    explicit_paths: p.explicit_paths,
                };
                validate_selection_non_empty(method, &selection)?;
                let svc = self.build_conversation_import_service();
                let sources = tokio::task::spawn_blocking(move || svc.discover_sources(&selection))
                    .await
                    .map_err(|e| {
                        JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                    })?;
                Ok(json!({ "sources": sources }))
            }

            "cowork/conversationImport/preview" => {
                let p: ConversationImportPreviewParams = parse_strict_optional(method, raw_params)?;
                if let Some(lim) = p.limit
                    && (lim == 0 || lim > 1000)
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: limit must be between 1 and 1000"),
                    ));
                }
                let selection = ConversationSourceSelectionOptions {
                    sources: p.sources,
                    include_codex: p.include_codex,
                    include_claude_code: p.include_claude_code,
                    include_cowork: p.include_cowork,
                    explicit_paths: p.explicit_paths,
                };
                validate_selection_non_empty(method, &selection)?;
                let include_archived = p.include_archived.unwrap_or(false);
                let limit = p.limit;
                let workspaces = self.known_workspaces_for_import();
                let svc = self.build_conversation_import_service();
                let res = tokio::task::spawn_blocking(move || {
                    svc.preview(&selection, limit, include_archived, &workspaces)
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/conversationImport/workspaceMappings/validate" => {
                let p: ConversationImportValidateMappingsParams =
                    parse_strict_required(method, raw_params)?;
                for m in p.mappings.values() {
                    validate_workspace_mapping_input_fields(method, m)?;
                }
                let workspaces = self.known_workspaces_for_import();
                let svc = self.build_conversation_import_service();
                let mappings = p.mappings;
                let res = tokio::task::spawn_blocking(move || {
                    svc.validate_workspace_mappings(&mappings, &workspaces)
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            "cowork/conversationImport/import" => {
                let p: ConversationImportRunParams = parse_strict_required(method, raw_params)?;
                if p.selected.is_empty() {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: selected must include at least 1 conversation"),
                    ));
                }
                for sel in &p.selected {
                    if sel.fingerprint.trim().is_empty() {
                        return Err(JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            format!("{method}: selected fingerprint must be non-empty"),
                        ));
                    }
                }
                if let Some(ref mode) = p.mode
                    && mode != "skip-existing"
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: invalid mode '{mode}'"),
                    ));
                }
                if let Some(ref mappings) = p.mappings {
                    for m in mappings.values() {
                        validate_workspace_mapping_input_fields(method, m)?;
                    }
                }
                let provider = parse_optional_provider(method, "provider", &p.provider)?;
                let default_provider =
                    parse_optional_provider(method, "defaultProvider", &p.default_provider)?;
                let model = validate_optional_non_empty_trimmed(method, "model", &p.model)?;
                let default_model =
                    validate_optional_non_empty_trimmed(method, "defaultModel", &p.default_model)?;

                let selection = ConversationSourceSelectionOptions {
                    sources: p.sources,
                    include_codex: p.include_codex,
                    include_claude_code: p.include_claude_code,
                    include_cowork: p.include_cowork,
                    explicit_paths: p.explicit_paths,
                };
                validate_selection_non_empty(method, &selection)?;

                let cfg = self
                    .load_workspace_config(&self.working_directory)
                    .map_err(|e| {
                        JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                    })?;
                let workspaces = self.known_workspaces_for_import();
                let svc = self.build_conversation_import_service();
                let desktop = self.desktop_service.clone();
                let fallback_wd = self.working_directory.clone();

                let res = svc
                    .import_selected(
                        &cfg,
                        ConversationImportRunInput {
                            selection,
                            selected: p.selected,
                            mappings: p.mappings,
                            provider,
                            model,
                            default_provider,
                            default_model,
                            include_archived: p.include_archived,
                        },
                        &workspaces,
                        |target_path, preferred_name| {
                            let target = Path::new(target_path);
                            std::fs::create_dir_all(target)
                                .map_err(|e| format!("Failed creating workspace directory: {e}"))?;
                            if let Some(ref ds) = desktop {
                                ds.ensure_workspace_for_import(target, preferred_name, &fallback_wd)
                            } else {
                                let canon = canonicalize_sync(target);
                                let canon_str = canon.to_string_lossy().into_owned();
                                let name = preferred_name
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned)
                                    .or_else(|| {
                                        canon
                                            .file_name()
                                            .map(|s| s.to_string_lossy().into_owned())
                                            .filter(|s| !s.is_empty())
                                    })
                                    .unwrap_or_else(|| canon_str.clone());
                                Ok(cowork_harness::importers::EnsuredWorkspaceOutcome {
                                    workspace_id: None,
                                    workspace_path: canon_str,
                                    name,
                                    created: false,
                                })
                            }
                        },
                    )
                    .await;

                if !res.imported.is_empty() || !res.created_workspaces.is_empty() {
                    self.broadcast_workspace_list_changed();
                }

                serde_json::to_value(res).map_err(|e| {
                    JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, format!("{method}: {e}"))
                })
            }

            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }

    // -------------------------------------------------------------------------
    // 5. Skill Improvement (`cowork/skills/improvement/*`, `VAL-EXT-006`)
    // -------------------------------------------------------------------------

    pub async fn handle_skill_improvement_rpc(
        self: &Arc<Self>,
        connection_id: &str,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        let svc = self.ensure_skill_improvement_service();
        match method {
            "cowork/skills/improvement/status" => {
                let p: SkillImprovementStatusParams = parse_strict_optional(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let evt = tokio::task::spawn_blocking(move || {
                    svc.get_status(Some(session_id), Some(&cwd))
                })
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?
                .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({ "event": evt }))
            }

            "cowork/skills/improvement/run" => {
                let p: SkillImprovementRunParams = parse_strict_optional(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let skill_name =
                    validate_optional_non_empty_trimmed(method, "skillName", &p.skill_name)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                svc.run_now(skill_name.as_deref(), Some(&cwd))
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let evt = svc
                    .get_status(Some(session_id), Some(&cwd))
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({ "event": evt }))
            }

            "cowork/skills/improvement/restore" => {
                let p: SkillImprovementRestoreParams = parse_strict_required(method, raw_params)?;
                let cwd_raw = validate_optional_non_empty_trimmed(method, "cwd", &p.cwd)?;
                let skill_name = require_non_empty_trimmed(method, "skillName", &p.skill_name)?;
                let cwd = self
                    .resolve_workspace_path(cwd_raw.as_deref(), method)
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
                self.subscribe_workspace_control_bg(connection_id, &cwd);
                svc.restore(&skill_name, Some(&cwd))
                    .await
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                let session_id = self.get_or_create_workspace_state_id(&cwd);
                let evt = svc
                    .get_status(Some(session_id), Some(&cwd))
                    .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
                Ok(json!({ "event": evt }))
            }

            _ => Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            )),
        }
    }
}

fn validate_spreadsheet_patch_ops(
    method: &str,
    ops: &[SpreadsheetBatchPatchOperation],
) -> Result<(), JsonRpcLiteError> {
    for op in ops {
        match op {
            SpreadsheetBatchPatchOperation::Cell {
                sheet_name,
                address,
                ..
            } => {
                if address.trim().is_empty() {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: cell address must be non-empty"),
                    ));
                }
                if let Some(sn) = sheet_name
                    && sn.trim().is_empty()
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: sheetName must be non-empty"),
                    ));
                }
            }
            SpreadsheetBatchPatchOperation::Format {
                sheet_name,
                range,
                style,
            } => {
                if range.trim().is_empty() {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: format range must be non-empty"),
                    ));
                }
                if let Some(sn) = sheet_name
                    && sn.trim().is_empty()
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: sheetName must be non-empty"),
                    ));
                }
                style.validate().map_err(|m| {
                    JsonRpcLiteError::new(error_codes::INVALID_PARAMS, format!("{method}: {m}"))
                })?;
            }
            SpreadsheetBatchPatchOperation::Merge {
                sheet_name, range, ..
            } => {
                if range.trim().is_empty() {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: merge range must be non-empty"),
                    ));
                }
                if let Some(sn) = sheet_name
                    && sn.trim().is_empty()
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: sheetName must be non-empty"),
                    ));
                }
            }
            SpreadsheetBatchPatchOperation::ColumnWidth {
                sheet_name,
                width_px,
                ..
            } => {
                if let Some(sn) = sheet_name
                    && sn.trim().is_empty()
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: sheetName must be non-empty"),
                    ));
                }
                if let Some(w) = width_px
                    && (!w.is_finite() || *w <= 0.0)
                {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        format!("{method}: widthPx must be positive"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_workspace_mapping_input_fields(
    method: &str,
    mapping: &ConversationWorkspaceMappingInput,
) -> Result<(), JsonRpcLiteError> {
    match mapping {
        ConversationWorkspaceMappingInput::Existing { workspace_id }
        | ConversationWorkspaceMappingInput::Fallback { workspace_id } => {
            if workspace_id.trim().is_empty() {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("{method}: workspaceId must be non-empty"),
                ));
            }
        }
        ConversationWorkspaceMappingInput::Create { path, name } => {
            if path.trim().is_empty() {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("{method}: path must be non-empty"),
                ));
            }
            if let Some(n) = name
                && n.trim().is_empty()
            {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("{method}: name must be non-empty when provided"),
                ));
            }
        }
    }
    Ok(())
}

fn parse_optional_provider(
    method: &str,
    field: &str,
    raw: &Option<String>,
) -> Result<Option<ProviderName>, JsonRpcLiteError> {
    let Some(s) = raw else {
        return Ok(None);
    };
    ProviderName::parse(s.trim())
        .ok_or_else(|| {
            JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("{method}: invalid {field} '{s}'"),
            )
        })
        .map(Some)
}
