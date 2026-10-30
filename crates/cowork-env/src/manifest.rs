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

/// Supported Cowork runtime target asset identifiers.
pub const SUPPORTED_RUNTIME_ASSETS: [&str; 6] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "win32-x64",
    "win32-arm64",
];

/// Resolves the Cowork runtime asset identifier for a `(platform, arch)` pair.
pub fn resolve_asset_for_platform(platform: &str, arch: &str) -> Result<String> {
    let candidate = format!("{platform}-{arch}");
    if SUPPORTED_RUNTIME_ASSETS.contains(&candidate.as_str()) {
        Ok(candidate)
    } else {
        Err(EnvError::UnsupportedHost {
            platform: platform.to_owned(),
            arch: arch.to_owned(),
        })
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,
    pub node_modules: String,
    pub node_resolver: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poppler_bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdftoppm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdfinfo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub libreoffice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soffice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub libreoffice_binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheelhouse: Option<String>,
}

/// Top-level `runtime.json` manifest inside an extracted Cowork runtime root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub asset: String,
    pub created_at: String,
    #[serde(default)]
    pub installed_packs: Vec<String>,
    #[serde(default)]
    pub components: BTreeMap<String, String>,
    pub paths: RuntimeManifestPaths,
    #[serde(default)]
    pub python_packages: Vec<String>,
    #[serde(default)]
    pub node_packages: Vec<String>,
    #[serde(default)]
    pub system_tools: Vec<String>,
    #[serde(default)]
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
    pub components: BTreeMap<String, String>,
    #[serde(default)]
    pub entrypoints: BTreeMap<String, String>,
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
    pub platform: String,
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

/// Active runtime pointer stored at `<homedir>/.cowork/runtime/current.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntimePointer {
    pub version: String,
    pub asset: String,
    pub installed_at: String,
    pub runtime_dir: String,
    #[serde(default)]
    pub installed_packs: Vec<String>,
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
