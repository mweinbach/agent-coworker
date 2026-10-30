use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{ConfigError, Result};
use crate::feature_flags::FeatureFlags;
use crate::file_lock::{FileLockOptions, file_lock_root_for_cowork_home, with_file_lock};
use crate::merge::{
    AgentConfig, ProjectConfigOverrides, deep_merge_objects, load_json_object_safe,
};
use crate::paths::write_text_file_atomic;
use crate::providers::{
    ChildModelRoutingMode, ProviderName, SkillImprovementScope, default_runtime_name_for_provider,
};

const EDITABLE_PROVIDER_OPTION_KEYS: [&str; 4] = ["openai", "codex-cli", "google", "lmstudio"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfilePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// Patch semantics matching `src/server/runtime/ConfigPatchStore.ts`, including
/// `Some(None)` (`null` disables overflow) vs `clear_*` sentinels (delete key & inherit parent).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectConfigPatch {
    pub provider: Option<ProviderName>,
    pub model: Option<String>,
    pub preferred_child_model: Option<String>,
    pub child_model_routing_mode: Option<ChildModelRoutingMode>,
    pub preferred_child_model_ref: Option<String>,
    pub allowed_child_model_refs: Option<Vec<String>>,
    pub enable_mcp: Option<bool>,
    pub enable_memory: Option<bool>,
    pub memory_require_approval: Option<bool>,
    pub advanced_memory: Option<bool>,
    pub memory_generation_model: Option<String>,
    pub skill_improvement_enabled: Option<bool>,
    pub skill_improvement_model: Option<String>,
    pub skill_improvement_scope: Option<SkillImprovementScope>,
    pub skill_improvement_excluded_skills: Option<Vec<String>>,
    pub observability_enabled: Option<bool>,
    pub backups_enabled: Option<bool>,
    /// `Some(Some(n))` sets explicit limit, `Some(None)` writes JSON `null` (disable truncation), `None` leaves unchanged.
    pub tool_output_overflow_chars: Option<Option<u64>>,
    pub user_name: Option<String>,
    pub feature_flags: Option<FeatureFlags>,
    pub user_profile: Option<UserProfilePatch>,
    pub clear_memory_generation_model: bool,
    pub clear_skill_improvement_model: bool,
    pub clear_tool_output_overflow_chars: bool,
    pub provider_options: Option<Map<String, Value>>,
}

impl ProjectConfigPatch {
    fn to_json_entries(&self) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        if let Some(v) = self.provider {
            out.push((
                "provider".to_string(),
                Value::String(v.as_str().to_string()),
            ));
        }
        if let Some(v) = &self.model {
            out.push(("model".to_string(), Value::String(v.clone())));
        }
        if let Some(v) = &self.preferred_child_model {
            out.push(("preferredChildModel".to_string(), Value::String(v.clone())));
        }
        if let Some(v) = self.child_model_routing_mode {
            out.push((
                "childModelRoutingMode".to_string(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            ));
        }
        if let Some(v) = &self.preferred_child_model_ref {
            out.push((
                "preferredChildModelRef".to_string(),
                Value::String(v.clone()),
            ));
        }
        if let Some(v) = &self.allowed_child_model_refs {
            out.push((
                "allowedChildModelRefs".to_string(),
                serde_json::to_value(v).unwrap_or(Value::Array(vec![])),
            ));
        }
        if let Some(v) = self.enable_mcp {
            out.push(("enableMcp".to_string(), Value::Bool(v)));
        }
        if let Some(v) = self.enable_memory {
            out.push(("enableMemory".to_string(), Value::Bool(v)));
        }
        if let Some(v) = self.memory_require_approval {
            out.push(("memoryRequireApproval".to_string(), Value::Bool(v)));
        }
        if let Some(v) = self.advanced_memory {
            out.push(("advancedMemory".to_string(), Value::Bool(v)));
        }
        if let Some(v) = &self.memory_generation_model {
            out.push((
                "memoryGenerationModel".to_string(),
                Value::String(v.clone()),
            ));
        }
        if let Some(v) = self.skill_improvement_enabled {
            out.push(("skillImprovementEnabled".to_string(), Value::Bool(v)));
        }
        if let Some(v) = &self.skill_improvement_model {
            out.push((
                "skillImprovementModel".to_string(),
                Value::String(v.clone()),
            ));
        }
        if let Some(v) = self.skill_improvement_scope {
            out.push((
                "skillImprovementScope".to_string(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            ));
        }
        if let Some(v) = &self.skill_improvement_excluded_skills {
            out.push((
                "skillImprovementExcludedSkills".to_string(),
                serde_json::to_value(v).unwrap_or(Value::Array(vec![])),
            ));
        }
        if let Some(v) = self.observability_enabled {
            out.push(("observabilityEnabled".to_string(), Value::Bool(v)));
        }
        if let Some(v) = self.backups_enabled {
            out.push(("backupsEnabled".to_string(), Value::Bool(v)));
        }
        if let Some(v) = self.tool_output_overflow_chars {
            out.push((
                "toolOutputOverflowChars".to_string(),
                match v {
                    Some(n) => Value::Number(n.into()),
                    None => Value::Null,
                },
            ));
        }
        if let Some(v) = &self.user_name {
            out.push(("userName".to_string(), Value::String(v.clone())));
        }
        if let Some(v) = &self.feature_flags
            && let Ok(val) = serde_json::to_value(v)
        {
            out.push(("featureFlags".to_string(), val));
        }
        if let Some(v) = &self.user_profile
            && let Ok(val) = serde_json::to_value(v)
        {
            out.push(("userProfile".to_string(), val));
        }
        if let Some(v) = &self.provider_options {
            out.push(("providerOptions".to_string(), Value::Object(v.clone())));
        }
        out
    }
}

async fn persist_config_patch_file(
    config_dir: &Path,
    patch: &ProjectConfigPatch,
    runtime_provider_options: Option<&Map<String, Value>>,
    clear_observability_enabled: bool,
    lock_root: Option<PathBuf>,
) -> Result<()> {
    let entries = patch.to_json_entries();
    if entries.is_empty()
        && !patch.clear_memory_generation_model
        && !patch.clear_skill_improvement_model
        && !patch.clear_tool_output_overflow_chars
        && !clear_observability_enabled
    {
        return Ok(());
    }

    let config_path = config_dir.join("config.json");
    with_file_lock(
        &config_path,
        || async {
            let current = load_json_object_safe(&config_path)?;
            let mut next = current.clone();

            for (key, value) in entries {
                if key == "providerOptions" {
                    let mut current_po = current
                        .get("providerOptions")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Value::Object(patch_po) = &value {
                        for prov in EDITABLE_PROVIDER_OPTION_KEYS {
                            let Some(Value::Object(section_patch)) = patch_po.get(prov) else {
                                continue;
                            };
                            let runtime_sec = runtime_provider_options
                                .and_then(|m| m.get(prov))
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            let current_sec = current_po
                                .get(prov)
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            let merged = deep_merge_objects(
                                &deep_merge_objects(&runtime_sec, &current_sec),
                                section_patch,
                            );
                            current_po.insert(prov.to_string(), Value::Object(merged));
                        }
                    }
                    if current_po.is_empty() {
                        next.remove("providerOptions");
                    } else {
                        next.insert("providerOptions".to_string(), Value::Object(current_po));
                    }
                    continue;
                }
                if (key == "userProfile" || key == "featureFlags")
                    && let Value::Object(incoming) = value
                {
                    let existing = current
                        .get(&key)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    next.insert(key, Value::Object(deep_merge_objects(&existing, &incoming)));
                    continue;
                }
                next.insert(key, value);
            }

            if patch.clear_tool_output_overflow_chars {
                next.remove("toolOutputOverflowChars");
            }
            if patch.clear_memory_generation_model {
                next.remove("memoryGenerationModel");
            }
            if patch.clear_skill_improvement_model {
                next.remove("skillImprovementModel");
            }
            if clear_observability_enabled {
                next.remove("observabilityEnabled");
            }

            let payload = format!(
                "{}\n",
                serde_json::to_string_pretty(&Value::Object(next))
                    .map_err(|e| ConfigError::Validation(e.to_string()))?
            );
            write_text_file_atomic(&config_path, &payload, None)?;
            Ok(())
        },
        FileLockOptions {
            lock_root,
            ..Default::default()
        },
    )
    .await
}

/// Persists a `ProjectConfigPatch` across workspace and global config files (`ConfigPatchStore.ts` parity).
pub async fn persist_project_config_patch(
    project_cowork_dir: &Path,
    patch: &ProjectConfigPatch,
    runtime_provider_options: Option<&Map<String, Value>>,
    global_config_dir: Option<&Path>,
) -> Result<()> {
    let mut project_patch = patch.clone();
    let mut global_patch = ProjectConfigPatch::default();
    let has_observability_consent = patch.observability_enabled.is_some();

    if has_observability_consent && global_config_dir.is_none() {
        return Err(ConfigError::UntrustedObservabilityChange);
    }

    let lock_root = global_config_dir
        .and_then(|dir| dir.parent())
        .map(file_lock_root_for_cowork_home);

    if global_config_dir.is_some() {
        if has_observability_consent {
            global_patch.observability_enabled = project_patch.observability_enabled.take();
        }
        if project_patch.advanced_memory.is_some() {
            global_patch.advanced_memory = project_patch.advanced_memory.take();
        }
        if project_patch.memory_generation_model.is_some() {
            global_patch.memory_generation_model = project_patch.memory_generation_model.take();
        }
        if project_patch.clear_memory_generation_model {
            global_patch.clear_memory_generation_model = true;
            project_patch.clear_memory_generation_model = false;
        }
        if project_patch.skill_improvement_enabled.is_some() {
            global_patch.skill_improvement_enabled = project_patch.skill_improvement_enabled.take();
        }
        if project_patch.skill_improvement_model.is_some() {
            global_patch.skill_improvement_model = project_patch.skill_improvement_model.take();
        }
        if project_patch.clear_skill_improvement_model {
            global_patch.clear_skill_improvement_model = true;
            project_patch.clear_skill_improvement_model = false;
        }
        if project_patch.skill_improvement_scope.is_some() {
            global_patch.skill_improvement_scope = project_patch.skill_improvement_scope.take();
        }
        if project_patch.skill_improvement_excluded_skills.is_some() {
            global_patch.skill_improvement_excluded_skills =
                project_patch.skill_improvement_excluded_skills.take();
        }
    }

    if let Some(gdir) = global_config_dir
        && has_observability_consent
    {
        persist_config_patch_file(
            gdir,
            &global_patch,
            runtime_provider_options,
            false,
            lock_root.clone(),
        )
        .await?;
    }

    persist_config_patch_file(
        project_cowork_dir,
        &project_patch,
        runtime_provider_options,
        has_observability_consent,
        lock_root.clone(),
    )
    .await?;

    if let Some(gdir) = global_config_dir
        && !has_observability_consent
    {
        persist_config_patch_file(
            gdir,
            &global_patch,
            runtime_provider_options,
            false,
            lock_root,
        )
        .await?;
    }

    Ok(())
}

/// Applies `patch` in-memory to an existing `AgentConfig` (`mergeConfigPatch` parity).
pub fn merge_config_patch(config: &AgentConfig, patch: &ProjectConfigPatch) -> AgentConfig {
    let mut next = config.clone();

    if let Some(p) = patch.provider {
        if p != config.provider {
            next.runtime = default_runtime_name_for_provider(p);
        }
        next.provider = p;
    }
    if let Some(m) = &patch.model {
        next.model = m.clone();
    }
    if let Some(m) = &patch.preferred_child_model {
        next.preferred_child_model = m.clone();
    }
    if let Some(mode) = patch.child_model_routing_mode {
        next.child_model_routing_mode = mode;
    }
    if let Some(r) = &patch.preferred_child_model_ref {
        next.preferred_child_model_ref = r.clone();
    }
    if let Some(allowed) = &patch.allowed_child_model_refs {
        next.allowed_child_model_refs = allowed.clone();
    }
    if let Some(v) = patch.enable_mcp {
        next.enable_mcp = v;
    }
    if let Some(v) = patch.enable_memory {
        next.enable_memory = v;
    }
    if let Some(v) = patch.memory_require_approval {
        next.memory_require_approval = v;
    }
    if let Some(v) = patch.advanced_memory {
        next.advanced_memory = v;
    }
    if let Some(v) = &patch.memory_generation_model {
        next.memory_generation_model = Some(v.clone());
    }
    if patch.clear_memory_generation_model {
        next.memory_generation_model = None;
    }
    if let Some(v) = patch.skill_improvement_enabled {
        next.skill_improvement_enabled = v;
    }
    if let Some(v) = &patch.skill_improvement_model {
        next.skill_improvement_model = Some(v.clone());
    }
    if patch.clear_skill_improvement_model {
        next.skill_improvement_model = None;
    }
    if let Some(v) = patch.skill_improvement_scope {
        next.skill_improvement_scope = v;
    }
    if let Some(v) = &patch.skill_improvement_excluded_skills {
        next.skill_improvement_excluded_skills = v.clone();
    }
    if let Some(v) = patch.observability_enabled {
        next.observability_enabled = v;
    }
    if let Some(v) = patch.backups_enabled {
        next.backups_enabled = v;
    }
    if let Some(ov) = patch.tool_output_overflow_chars {
        next.tool_output_overflow_chars = ov;
        next.project_config_overrides = Some(ProjectConfigOverrides {
            tool_output_overflow_chars: ov,
        });
    }
    if patch.clear_tool_output_overflow_chars {
        next.tool_output_overflow_chars = config.inherited_tool_output_overflow_chars;
        next.project_config_overrides = None;
    }
    if let Some(u) = &patch.user_name {
        next.user_name = u.clone();
    }
    if let Some(ff) = patch.feature_flags {
        next.feature_flags = ff;
    }
    if let Some(up) = &patch.user_profile {
        if let Some(i) = &up.instructions {
            next.user_profile.instructions = i.clone();
        }
        if let Some(w) = &up.work {
            next.user_profile.work = w.clone();
        }
        if let Some(d) = &up.details {
            next.user_profile.details = d.clone();
        }
    }
    if let Some(po_patch) = &patch.provider_options {
        let mut base = next.provider_options.take().unwrap_or_default();
        for prov in EDITABLE_PROVIDER_OPTION_KEYS {
            if let Some(Value::Object(sec)) = po_patch.get(prov) {
                let cur = base
                    .get(prov)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                base.insert(
                    prov.to_string(),
                    Value::Object(deep_merge_objects(&cur, sec)),
                );
            }
        }
        next.provider_options = if base.is_empty() { None } else { Some(base) };
    }

    next
}
