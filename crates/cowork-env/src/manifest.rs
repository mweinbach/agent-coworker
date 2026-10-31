use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_sandbox::{host_arch, host_platform};
use data_encoding::BASE64;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

use crate::error::{EnvError, Result};

/// Official Ed25519 release key identifier (`src/coworkRuntime/trustedKeys.ts`).
pub const OFFICIAL_RUNTIME_KEY_ID: &str = "cowork-runtime-release-1";

/// Official Ed25519 release public key in RFC 8410 SubjectPublicKeyInfo PEM format.
pub const OFFICIAL_RUNTIME_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0qoRsFDknvXPqHt2sOibJTPThM7rh/1UyU8g9L+fwIw=\n-----END PUBLIC KEY-----";

/// ASN.1 DER SubjectPublicKeyInfo prefix for an Ed25519 32-byte public key (RFC 8410).
const ED25519_SPKI_DER_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Supported Cowork runtime target asset identifiers (`src/coworkRuntime/types.ts`).
pub const SUPPORTED_RUNTIME_ASSETS: [&str; 5] = [
    "macos-arm64",
    "macos-x86",
    "linux-x86",
    "linux-arm64",
    "win-x86",
];

/// Returns the host `(platform, arch)` keys compatible with a canonical `RuntimeAssetId`.
pub fn compatible_hosts_for_asset(asset: &str) -> &'static [&'static str] {
    match asset {
        "macos-arm64" => &["darwin-arm64"],
        "macos-x86" => &["darwin-x64"],
        "linux-x86" => &["linux-x64"],
        "linux-arm64" => &["linux-arm64"],
        "win-x86" => &["win32-x64", "win32-arm64"],
        _ => &[],
    }
}

/// Resolves the Cowork runtime asset identifier for a `(platform, arch)` pair.
pub fn resolve_asset_for_platform(platform: &str, arch: &str) -> Result<String> {
    let host_key = format!("{platform}-{arch}");
    for asset in SUPPORTED_RUNTIME_ASSETS {
        if compatible_hosts_for_asset(asset).contains(&host_key.as_str()) {
            return Ok(asset.to_owned());
        }
    }
    Err(EnvError::UnsupportedHost {
        platform: platform.to_owned(),
        arch: arch.to_owned(),
    })
}

/// Checks whether a manifest `asset` (and optional `compatibleHosts`) is runnable on `(platform, arch)`.
pub fn is_asset_compatible_with_host(
    asset: &str,
    platform: &str,
    arch: &str,
    compatible_hosts: &[String],
) -> bool {
    let host_key = format!("{platform}-{arch}");
    let asset_ok = compatible_hosts_for_asset(asset).contains(&host_key.as_str())
        || resolve_asset_for_platform(platform, arch).ok().as_deref() == Some(asset);
    if !asset_ok {
        return false;
    }
    if !compatible_hosts.is_empty() && !compatible_hosts.iter().any(|h| h == &host_key) {
        return false;
    }
    true
}

/// Canonical release archive filename for a v1 runtime asset (`cowork-runtime-<asset>.zip`).
pub fn runtime_asset_file_name(asset: &str) -> String {
    format!("cowork-runtime-{asset}.zip")
}

/// Canonical GitHub release tag for a `YYYY-MM-DD` runtime version (`runtime-<version>`).
pub fn runtime_release_tag(version: &str) -> Result<String> {
    validate_runtime_version(version)?;
    Ok(format!("runtime-{version}"))
}

/// Validates that a runtime version is a canonical `YYYY-MM-DD` calendar date without traversal characters.
pub fn validate_runtime_version(version: &str) -> Result<()> {
    let bytes = version.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !shape_ok || chrono::NaiveDate::parse_from_str(version, "%Y-%m-%d").is_err() {
        return Err(EnvError::Manifest(format!(
            "Runtime version must be a valid YYYY-MM-DD date, received {version:?}"
        )));
    }
    Ok(())
}

/// Resolves the Cowork runtime asset identifier for the current host.
pub fn resolve_host_asset() -> Result<String> {
    resolve_asset_for_platform(host_platform(), host_arch())
}

/// Parses an Ed25519 verifying key from SPKI PEM, 44-byte SPKI DER base64, raw 32-byte base64, or 64-char hex.
pub fn parse_ed25519_verifying_key(encoded: &str) -> Result<VerifyingKey> {
    let trimmed = encoded.trim();
    if trimmed.is_empty() {
        return Err(EnvError::Signature("Empty Ed25519 public key".to_owned()));
    }

    let body: String = if trimmed.contains("-----BEGIN PUBLIC KEY-----") {
        trimmed
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with("-----BEGIN ")
                    && !line.starts_with("-----END ")
            })
            .collect()
    } else {
        trimmed.chars().filter(|c| !c.is_whitespace()).collect()
    };

    let raw_bytes = if body.len() == 64 && body.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(&body)
            .map_err(|e| EnvError::Signature(format!("Invalid hex Ed25519 key: {e}")))?
    } else {
        BASE64
            .decode(body.as_bytes())
            .map_err(|e| EnvError::Signature(format!("Invalid base64/PEM Ed25519 key: {e}")))?
    };

    let key_bytes: [u8; 32] = if raw_bytes.len() == 32 {
        raw_bytes
            .try_into()
            .map_err(|_| EnvError::Signature("Invalid 32-byte Ed25519 key".to_owned()))?
    } else if raw_bytes.len() == 44 && raw_bytes.starts_with(&ED25519_SPKI_DER_PREFIX) {
        raw_bytes[12..44]
            .try_into()
            .map_err(|_| EnvError::Signature("Invalid SPKI Ed25519 key slice".to_owned()))?
    } else {
        return Err(EnvError::Signature(format!(
            "Unsupported Ed25519 public key byte length {} (expected 32 raw or 44 SPKI DER)",
            raw_bytes.len()
        )));
    };

    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| EnvError::Signature(format!("Malformed Ed25519 public key curve point: {e}")))
}

/// Key ring of trusted Ed25519 release public keys indexed by `keyId`.
#[derive(Debug, Clone, Default)]
pub struct TrustedKeyRing {
    keys: HashMap<String, VerifyingKey>,
}

impl TrustedKeyRing {
    pub fn empty() -> Self {
        Self {
            keys: HashMap::new(),
        }
    }

    /// Creates a key ring initialized with `TRUSTED_COWORK_RUNTIME_KEYS`.
    pub fn with_official_defaults() -> Self {
        let mut ring = Self::empty();
        if let Ok(vk) = parse_ed25519_verifying_key(OFFICIAL_RUNTIME_PUBLIC_KEY_PEM) {
            ring.insert_verifying_key(OFFICIAL_RUNTIME_KEY_ID, vk);
        }
        ring
    }

    pub fn insert_verifying_key(&mut self, key_id: impl Into<String>, key: VerifyingKey) {
        self.keys.insert(key_id.into(), key);
    }

    pub fn insert_pem_or_encoded(
        &mut self,
        key_id: impl Into<String>,
        encoded: &str,
    ) -> Result<()> {
        let vk = parse_ed25519_verifying_key(encoded)?;
        self.insert_verifying_key(key_id, vk);
        Ok(())
    }

    pub fn get(&self, key_id: &str) -> Option<&VerifyingKey> {
        self.keys.get(key_id)
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Modular v2 `.tar.zst` runtime pack identifiers (`core`, `python-wheels`, `libreoffice`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum RuntimePackId {
    #[serde(rename = "core")]
    Core,
    #[serde(rename = "python-wheels")]
    PythonWheels,
    #[serde(rename = "libreoffice")]
    LibreOffice,
}

impl RuntimePackId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::PythonWheels => "python-wheels",
            Self::LibreOffice => "libreoffice",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim() {
            "core" => Ok(Self::Core),
            "python-wheels" => Ok(Self::PythonWheels),
            "libreoffice" => Ok(Self::LibreOffice),
            other => Err(EnvError::Manifest(format!(
                "Unsupported runtime v2 pack id: {other:?}"
            ))),
        }
    }
}

impl std::fmt::Display for RuntimePackId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Phases emitted during runtime bootstrap (`waiting`, `downloading`, `installing`, `ready`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeBootstrapPhase {
    Waiting,
    Downloading,
    Installing,
    Ready,
}

impl RuntimeBootstrapPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Downloading => "downloading",
            Self::Installing => "installing",
            Self::Ready => "ready",
        }
    }
}

/// Wire-compatible runtime bootstrap progress payload (`schema.runtime.ts` parity).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeBootstrapProgress {
    pub phase: RuntimeBootstrapPhase,
    pub version: String,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
}

/// NDJSON startup event emitted on stdout when `--json` + `COWORK_DESKTOP_STARTUP_EVENTS=1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupProgressEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub component: String,
    pub progress: RuntimeBootstrapProgress,
}

impl StartupProgressEvent {
    pub fn new(progress: RuntimeBootstrapProgress) -> Self {
        Self {
            event_type: "server_startup_progress".to_owned(),
            component: "cowork-runtime".to_owned(),
            progress,
        }
    }

    pub fn waiting(version: impl Into<String>) -> Self {
        Self::new(RuntimeBootstrapProgress {
            phase: RuntimeBootstrapPhase::Waiting,
            version: version.into(),
            transferred_bytes: None,
            total_bytes: None,
            percent: None,
        })
    }

    pub fn downloading(
        version: impl Into<String>,
        transferred_bytes: Option<u64>,
        total_bytes: Option<u64>,
        percent: Option<u8>,
    ) -> Self {
        Self::new(RuntimeBootstrapProgress {
            phase: RuntimeBootstrapPhase::Downloading,
            version: version.into(),
            transferred_bytes,
            total_bytes,
            percent,
        })
    }

    pub fn installing(version: impl Into<String>) -> Self {
        Self::new(RuntimeBootstrapProgress {
            phase: RuntimeBootstrapPhase::Installing,
            version: version.into(),
            transferred_bytes: None,
            total_bytes: None,
            percent: None,
        })
    }

    pub fn ready(version: impl Into<String>) -> Self {
        Self::new(RuntimeBootstrapProgress {
            phase: RuntimeBootstrapPhase::Ready,
            version: version.into(),
            transferred_bytes: None,
            total_bytes: None,
            percent: Some(100),
        })
    }
}

/// Formats a `StartupProgressEvent` as a single NDJSON line (without trailing newline).
pub fn format_ndjson_progress_event(event: &StartupProgressEvent) -> String {
    serde_json::to_string(event).unwrap_or_else(|_| {
        "{\"type\":\"server_startup_progress\",\"component\":\"cowork-runtime\"}".to_owned()
    })
}

pub type RuntimeProgressCallback = Arc<dyn Fn(StartupProgressEvent) + Send + Sync>;

/// Relative POSIX paths declared inside `runtime.json` (`CoworkRuntimeManifest.paths`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestPaths {
    pub bin: String,
    pub node: String,
    pub python: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,
    pub node_modules: String,
    pub node_resolver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_tool_package: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pnpm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poppler_bin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdftoppm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdfinfo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heif_convert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jxr_dec_app: Option<String>,
    #[serde(
        default,
        rename = "libreOffice",
        alias = "libreoffice",
        skip_serializing_if = "Option::is_none"
    )]
    pub libreoffice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soffice: Option<String>,
    #[serde(
        default,
        rename = "libreOfficeBinary",
        alias = "libreofficeBinary",
        skip_serializing_if = "Option::is_none"
    )]
    pub libreoffice_binary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheelhouse: Option<String>,
}

/// Source provenance metadata in v1 `runtime.json` (`CoworkRuntimeManifest.source`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestSource {
    pub kind: String,
    pub bundle_version: String,
    pub target_platform: String,
    pub target_arch: String,
}

/// Component entry in v1 `runtime.json` (`CoworkRuntimeComponent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestComponent {
    pub id: String,
    pub strategy: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Dual-format `components` representation supporting v1 `Array<CoworkRuntimeComponent>` and v2 maps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeComponents {
    List(Vec<RuntimeManifestComponent>),
    Map(BTreeMap<String, String>),
}

impl Default for RuntimeComponents {
    fn default() -> Self {
        Self::List(Vec::new())
    }
}

/// Bundled tool version summary in v1 `runtime.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestVersions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pnpm: Option<String>,
    #[serde(
        default,
        rename = "libreOffice",
        alias = "libreoffice",
        skip_serializing_if = "Option::is_none"
    )]
    pub libreoffice: Option<String>,
}

/// Payload size metadata in v1 `runtime.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestPayload {
    pub file_count: u64,
    pub unpacked_bytes: u64,
}

/// Integrity pointer metadata in v1 `runtime.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestIntegrityRef {
    pub algorithm: String,
    pub key_id: String,
    pub manifest: String,
    pub signature: String,
}

/// Top-level `runtime.json` manifest inside an extracted Cowork runtime root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    pub asset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_file_name: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub compatible_hosts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeManifestSource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub installed_packs: Vec<String>,
    #[serde(default)]
    pub components: RuntimeComponents,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub versions: Option<RuntimeManifestVersions>,
    pub paths: RuntimeManifestPaths,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<RuntimeManifestPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<RuntimeManifestIntegrityRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub python_packages: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_packages: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub system_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trusted_symlinks: Vec<String>,
}

/// Entry kind inside a signed integrity manifest (`file` or `symlink`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntegrityEntryKind {
    File,
    Symlink,
}

/// Per-file cryptographic digest record inside `runtime-integrity.json` or `pack-integrity.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityFileEntry {
    pub path: String,
    pub kind: IntegrityEntryKind,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blake3: Option<String>,
}

/// Signed `runtime-integrity.json` manifest covering every file & symlink in a runtime root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIntegrityManifest {
    pub schema_version: u32,
    pub algorithm: String,
    pub key_id: String,
    pub runtime_version: String,
    pub asset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_id: Option<RuntimePackId>,
    pub files: Vec<IntegrityFileEntry>,
    #[serde(default)]
    pub components: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub entrypoints: BTreeMap<String, Vec<String>>,
}

/// Detached Ed25519 signature envelope (`runtime-integrity.sig` / `pack-integrity.sig`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSignatureEnvelope {
    pub schema_version: u32,
    pub algorithm: String,
    pub key_id: String,
    pub signature: String,
}

/// Metadata inside a modular v2 `.tar.zst` pack (`pack.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePackManifest {
    pub schema_version: u32,
    pub pack_id: RuntimePackId,
    pub version: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub arch: String,
    pub asset: String,
    pub created_at: String,
    #[serde(default)]
    pub components: BTreeMap<String, String>,
    #[serde(default)]
    pub provided_paths: BTreeMap<String, String>,
    #[serde(default)]
    pub trusted_symlinks: Vec<String>,
}

fn default_pointer_schema_version() -> u32 {
    1
}

/// Active runtime pointer stored at `<homedir>/.cowork/runtime/current.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntimePointer {
    #[serde(default = "default_pointer_schema_version")]
    pub schema_version: u32,
    pub version: String,
    pub asset: String,
    pub installed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub installed_packs: Vec<String>,
}

impl InstalledRuntimePointer {
    /// Resolves the on-disk runtime directory for this pointer (`runtime_dir` override if set,
    /// else `<homedir>/.cowork/runtime/<version>`, with fallback to `versions/<version>/<asset>`).
    pub fn resolve_runtime_dir(&self, homedir: &Path) -> Result<PathBuf> {
        validate_runtime_version(&self.version)?;
        if let Some(explicit) = self
            .runtime_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Ok(PathBuf::from(explicit));
        }
        let rt_root = homedir.join(".cowork").join("runtime");
        let canonical_v1 = rt_root.join(&self.version);
        if canonical_v1.is_dir() {
            return Ok(canonical_v1);
        }
        let versioned_asset = rt_root
            .join("versions")
            .join(&self.version)
            .join(&self.asset);
        if versioned_asset.is_dir() {
            return Ok(versioned_asset);
        }
        Ok(canonical_v1)
    }
}

/// Resolved absolute runtime paths inside a verified Cowork runtime directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub bin: PathBuf,
    pub node: PathBuf,
    pub python: PathBuf,
    pub git: Option<PathBuf>,
    pub node_modules: PathBuf,
    pub node_resolver: PathBuf,
    pub poppler_bin: Option<PathBuf>,
    pub pdftoppm: Option<PathBuf>,
    pub libreoffice: Option<PathBuf>,
    pub soffice: Option<PathBuf>,
    pub libreoffice_binary: Option<PathBuf>,
    pub uv: Option<PathBuf>,
    pub wheelhouse: Option<PathBuf>,
}

impl RuntimePaths {
    pub fn from_manifest_paths(root_dir: &Path, rel: &RuntimeManifestPaths) -> Self {
        let resolve = |p: &str| root_dir.join(p);
        let bin = resolve(&rel.bin);
        let uv_from_manifest = rel.uv.as_deref().map(resolve).or_else(|| {
            let candidate = if cfg!(windows) {
                bin.join("uv.exe")
            } else {
                bin.join("uv")
            };
            candidate.is_file().then_some(candidate)
        });
        let wheelhouse_from_manifest = rel.wheelhouse.as_deref().map(resolve).or_else(|| {
            let candidate = root_dir.join("wheels");
            candidate.is_dir().then_some(candidate)
        });
        Self {
            bin,
            node: resolve(&rel.node),
            python: resolve(&rel.python),
            git: rel.git.as_deref().map(resolve),
            node_modules: resolve(&rel.node_modules),
            node_resolver: resolve(&rel.node_resolver),
            poppler_bin: rel.poppler_bin.as_deref().map(resolve),
            pdftoppm: rel.pdftoppm.as_deref().map(resolve),
            libreoffice: rel.libreoffice.as_deref().map(resolve),
            soffice: rel.soffice.as_deref().map(resolve),
            libreoffice_binary: rel.libreoffice_binary.as_deref().map(resolve),
            uv: uv_from_manifest,
            wheelhouse: wheelhouse_from_manifest,
        }
    }
}

/// Verified, ready-to-execute Cowork runtime descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRuntime {
    pub version: String,
    pub asset: String,
    pub root_dir: PathBuf,
    pub installed_packs: Vec<String>,
    pub paths: RuntimePaths,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_spki_pem_key_parses_into_ed25519_verifying_key() {
        let vk = parse_ed25519_verifying_key(OFFICIAL_RUNTIME_PUBLIC_KEY_PEM)
            .expect("parse official SPKI PEM");
        assert_eq!(vk.as_bytes().len(), 32);
        let ring = TrustedKeyRing::with_official_defaults();
        assert!(ring.get(OFFICIAL_RUNTIME_KEY_ID).is_some());
    }
}
