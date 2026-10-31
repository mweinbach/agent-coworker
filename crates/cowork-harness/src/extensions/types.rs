use cowork_tools::SkillInterfaceMetadata;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOriginMetadata {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallManifest {
    pub version: u32,
    pub installation_id: String,
    pub installed_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<SkillOriginMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPluginOwnerWire {
    pub plugin_id: String,
    pub name: String,
    pub display_name: String,
    pub scope: String,
    pub discovery_kind: String,
    pub root_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScopeDescriptor {
    pub scope: String,
    pub skills_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_skills_dir: Option<String>,
    pub writable: bool,
    pub readable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallationDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallationEntry {
    pub installation_id: String,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub enabled: bool,
    pub writable: bool,
    pub managed: bool,
    pub effective: bool,
    pub state: String,
    pub root_dir: String,
    pub skill_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    pub path: String,
    pub triggers: Vec<String>,
    pub description_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<SkillInterfaceMetadata>,
    pub diagnostics: Vec<SkillInstallationDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<SkillOriginMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<SkillInstallManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_by_installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_by_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<SkillPluginOwnerWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_check_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceMetadataWire {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authentication_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkillCatalogEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub scope: String,
    pub discovery_kind: String,
    pub installed: bool,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<SkillInterfaceMetadata>,
    pub marketplace: MarketplaceMetadataWire,
    pub install_source: String,
    pub warnings: Vec<String>,
}

/// Strict snapshot matching `skillCatalogSnapshotSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogSnapshot {
    pub scopes: Vec<SkillScopeDescriptor>,
    pub effective_skills: Vec<SkillInstallationEntry>,
    pub installations: Vec<SkillInstallationEntry>,
    pub available_skills: Vec<MarketplaceSkillCatalogEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSourceDescriptor {
    pub kind: String,
    pub raw: String,
    pub display_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_skill_name: Option<String>,
}

/// Strict candidate matching `skillInstallPreviewCandidateSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallPreviewCandidate {
    pub name: String,
    pub description: String,
    pub relative_root_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts_with_installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts_with_scope: Option<String>,
    pub would_be_effective: bool,
    pub shadowed_installation_ids: Vec<String>,
    pub diagnostics: Vec<SkillInstallationDiagnostic>,
}

/// Strict preview matching `skillInstallPreviewSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallPreview {
    pub source: ExtensionSourceDescriptor,
    pub target_scope: String,
    pub candidates: Vec<SkillInstallPreviewCandidate>,
    pub warnings: Vec<String>,
}

/// Strict update check matching `skillUpdateCheckResultSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateCheckResult {
    pub installation_id: String,
    pub can_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<SkillInstallPreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_source_hash: Option<String>,
}

/// Wire entry for `skills_list` / `skill_content` (`skillEntrySchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntryWire {
    pub name: String,
    pub path: String,
    pub source: String,
    pub enabled: bool,
    pub triggers: Vec<String>,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<SkillInterfaceMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<SkillPluginOwnerWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInterfaceWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_prompt: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composer_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkillSummaryWire {
    pub name: String,
    pub raw_name: String,
    pub description: String,
    pub enabled: bool,
    pub root_dir: String,
    pub skill_path: String,
    pub triggers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<SkillInterfaceMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallManifest {
    pub version: u32,
    pub installed_at: String,
    pub updated_at: String,
    pub source: SkillOriginMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<MarketplaceMetadataWire>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginCatalogEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub scope: String,
    pub discovery_kind: String,
    pub installed: bool,
    pub enabled: bool,
    pub root_dir: String,
    pub manifest_path: String,
    pub skills_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<PluginInterfaceWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<MarketplaceMetadataWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_check_reason: Option<String>,
    pub skills: Vec<PluginSkillSummaryWire>,
    pub mcp_servers: Vec<String>,
    pub apps: Vec<Value>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePluginCatalogEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub scope: String,
    pub discovery_kind: String,
    pub installed: bool,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<PluginInterfaceWire>,
    pub marketplace: MarketplaceMetadataWire,
    pub install_source: String,
    pub warnings: Vec<String>,
}

/// Strict snapshot matching `pluginCatalogSnapshotSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogSnapshot {
    pub plugins: Vec<InstalledPluginCatalogEntry>,
    pub available_plugins: Vec<MarketplacePluginCatalogEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallPreviewCandidate {
    pub plugin_id: String,
    pub display_name: String,
    pub description: String,
    pub relative_root_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts_with_plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts_with_scope: Option<String>,
    pub would_be_primary: bool,
    pub diagnostics: Vec<SkillInstallationDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallPreview {
    pub source: ExtensionSourceDescriptor,
    pub target_scope: String,
    pub candidates: Vec<PluginInstallPreviewCandidate>,
    pub warnings: Vec<String>,
}

/// Strict update check matching `pluginUpdateCheckResultSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateCheckResult {
    pub plugin_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub can_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<PluginInstallPreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_source_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSourceInput {
    pub source: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCatalogEntry {
    pub id: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub url: String,
    pub marketplace_path: String,
    pub built_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDetailPluginEntry {
    pub name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_source: Option<String>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDetailSkillEntry {
    pub name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDetail {
    pub source: MarketplaceCatalogEntry,
    pub plugins: Vec<MarketplaceDetailPluginEntry>,
    pub skills: Vec<MarketplaceDetailSkillEntry>,
    pub connectors: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMutationSignal {
    pub revision: String,
    pub pid: u32,
    pub at: String,
}
