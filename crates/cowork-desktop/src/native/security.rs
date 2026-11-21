//! Workspace root authorization, URL allowlisting, and upload-source identity verification
//! matching `apps/desktop/electron/services/ipcSecurity.ts`,
//! `apps/desktop/electron/ipc/workspaceRoots.ts`, and `apps/desktop/electron/ipc/files.ts`.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail};
use cowork_config::{canonical_key, canonicalize_sync, host_platform};
use url::Url;

use super::validation::assert_safe_id;

pub const MAX_ATTACHMENT_UPLOAD_BYTE_SIZE: u64 = 100 * 1024 * 1024;
const DEFAULT_UPLOAD_AUTHORIZATION_TTL: Duration = Duration::from_secs(15 * 60);

/// Validates an external URL and allows only `http:`, `https:`, and `mailto:` schemes.
pub fn assert_allowed_external_url(raw_url: &str) -> Result<Url> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        bail!("External URL must not be empty");
    }
    let parsed =
        Url::parse(trimmed).map_err(|err| anyhow::anyhow!("Invalid external URL: {err}"))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => Ok(parsed),
        other => bail!("Blocked unsupported external URL scheme: {other}"),
    }
}

/// Returns true when an I/O error reflects a temporarily unavailable drive, permissions check,
/// or disconnected network share rather than an invalid record format.
pub fn is_temporarily_unavailable_fs_error(err: &std::io::Error) -> bool {
    if matches!(
        err.kind(),
        ErrorKind::NotFound | ErrorKind::PermissionDenied
    ) {
        return true;
    }
    #[cfg(unix)]
    if let Some(code) = err.raw_os_error() {
        return matches!(
            code,
            libc::EACCES
                | libc::EIO
                | libc::ENODEV
                | libc::ENOENT
                | libc::ENXIO
                | libc::EPERM
                | libc::ESTALE
        );
    }
    #[cfg(windows)]
    if let Some(code) = err.raw_os_error() {
        // ERROR_ACCESS_DENIED (5), ERROR_NOT_READY (21), ERROR_BAD_NETPATH (53),
        // ERROR_DEV_NOT_EXIST (55), ERROR_NETNAME_DELETED (64), ERROR_BAD_NET_NAME (67)
        return matches!(code, 2 | 3 | 5 | 21 | 53 | 55 | 64 | 67);
    }
    false
}

#[derive(Clone, Debug)]
struct RootEntry {
    canonical_path: PathBuf,
    persisted: bool,
}

/// Authorization key for a canonical workspace root: case-insensitive only on Windows so
/// case-sensitive macOS/Linux volumes never conflate roots differing only by case.
fn workspace_root_auth_key(canonical: &Path) -> String {
    let platform = host_platform();
    if platform == "win32" {
        canonical_key(canonical, "win32")
    } else {
        canonical_key(canonical, "linux")
    }
}

/// Authorizes filesystem access per workspace against persisted or explicitly approved roots.
#[derive(Clone, Debug, Default)]
pub struct WorkspaceRootsController {
    approved_roots_by_key: HashMap<String, RootEntry>,
    persisted_by_workspace_id: HashMap<String, PathBuf>,
    unpersisted_by_workspace_id: HashMap<String, PathBuf>,
    picked_root_keys: HashSet<String>,
}

impl WorkspaceRootsController {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn approve_root(&mut self, root_path: &Path, persisted: bool) -> PathBuf {
        let canonical = canonicalize_sync(root_path);
        let key = workspace_root_auth_key(&canonical);
        if !persisted {
            self.picked_root_keys.insert(key.clone());
        }
        self.approved_roots_by_key
            .entry(key)
            .and_modify(|entry| {
                entry.persisted |= persisted;
            })
            .or_insert_with(|| RootEntry {
                canonical_path: canonical.clone(),
                persisted,
            });
        canonical
    }

    pub fn set_persisted_workspaces<'a, I>(&mut self, workspaces: I)
    where
        I: IntoIterator<Item = (&'a str, &'a Path)>,
    {
        self.persisted_by_workspace_id.clear();
        self.picked_root_keys.clear();
        self.approved_roots_by_key.retain(|_, v| !v.persisted);
        let retained_unpersisted: HashSet<String> = self
            .unpersisted_by_workspace_id
            .values()
            .map(|p| workspace_root_auth_key(p))
            .collect();
        self.approved_roots_by_key
            .retain(|k, v| v.persisted || retained_unpersisted.contains(k));

        for (id, path) in workspaces {
            if assert_safe_id(id, "workspaceId").is_err() {
                continue;
            }
            let canonical = canonicalize_sync(path);
            self.persisted_by_workspace_id
                .insert(id.to_string(), canonical.clone());
            self.approve_root(&canonical, true);
        }
    }

    pub fn register_workspace(&mut self, workspace_id: &str, root_path: &Path) -> Result<PathBuf> {
        assert_safe_id(workspace_id, "workspaceId")?;
        let canonical = canonicalize_sync(root_path);
        let key = workspace_root_auth_key(&canonical);
        self.approved_roots_by_key
            .entry(key)
            .or_insert_with(|| RootEntry {
                canonical_path: canonical.clone(),
                persisted: false,
            });
        self.unpersisted_by_workspace_id
            .insert(workspace_id.to_string(), canonical.clone());
        Ok(canonical)
    }

    /// Creates and approves a new one-off chat workspace directory strictly inside `one_off_chats_root`.
    pub fn approve_one_off_chat_workspace(
        &mut self,
        workspace_id: &str,
        root_path: &Path,
        one_off_chats_root: &Path,
    ) -> Result<PathBuf> {
        assert_safe_id(workspace_id, "workspaceId")?;
        let lexical = cowork_config::normalize_lexical_path(root_path);
        let chats_lexical = cowork_config::normalize_lexical_path(one_off_chats_root);
        let canonical_chats = canonicalize_sync(one_off_chats_root);
        if !cowork_config::is_inside(&chats_lexical, &lexical) || lexical == chats_lexical {
            bail!("One-off chat workspace path must be inside the one-off chats root");
        }
        cowork_config::ensure_private_dir_sync(&lexical)
            .map_err(|err| anyhow::anyhow!("Unable to prepare one-off chat directory: {err}"))?;
        let canonical = canonicalize_sync(&lexical);
        if !cowork_config::is_inside(&canonical_chats, &canonical) || canonical == canonical_chats {
            bail!("One-off chat workspace resolves outside the one-off chats root");
        }
        self.register_workspace(workspace_id, &canonical)
    }

    pub fn unregister_workspace(&mut self, workspace_id: &str) {
        self.unpersisted_by_workspace_id.remove(workspace_id);
        self.persisted_by_workspace_id.remove(workspace_id);

        let referenced: HashSet<String> = self
            .persisted_by_workspace_id
            .values()
            .chain(self.unpersisted_by_workspace_id.values())
            .map(|p| workspace_root_auth_key(p))
            .collect();
        self.approved_roots_by_key
            .retain(|key, _| referenced.contains(key) || self.picked_root_keys.contains(key));
    }

    pub fn approved_roots(&self) -> Vec<PathBuf> {
        let mut seen = HashSet::new();
        let mut out = Vec::with_capacity(self.approved_roots_by_key.len());
        for (key, entry) in &self.approved_roots_by_key {
            if seen.insert(key.clone()) {
                out.push(entry.canonical_path.clone());
            }
        }
        out
    }

    /// Resolves and verifies that a requested workspace root matches an exact approved root
    /// and any recorded root for `workspace_id`.
    pub fn resolve_authorized_workspace_root(
        &self,
        workspace_id: &str,
        candidate_root: Option<&Path>,
    ) -> Result<PathBuf> {
        assert_safe_id(workspace_id, "workspaceId")?;

        let registered = self
            .persisted_by_workspace_id
            .get(workspace_id)
            .or_else(|| self.unpersisted_by_workspace_id.get(workspace_id));

        let requested = match (candidate_root, registered) {
            (Some(c), _) => canonicalize_sync(c),
            (None, Some(r)) => r.clone(),
            (None, None) => bail!("Unknown workspace root for {workspace_id}"),
        };

        if let Some(known) = registered
            && known != &requested
        {
            bail!("Workspace root mismatch for {workspace_id}");
        }

        let key = workspace_root_auth_key(&requested);
        if !self.approved_roots_by_key.contains_key(&key) {
            bail!(
                "Workspace root is not approved. Select the folder with the desktop picker before starting."
            );
        }

        Ok(requested)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadSourceIdentity {
    pub size: u64,
    pub modified_nanos: Option<u128>,
    #[cfg(unix)]
    pub dev: u64,
    #[cfg(unix)]
    pub ino: u64,
}

impl UploadSourceIdentity {
    pub fn from_metadata(meta: &fs::Metadata) -> Self {
        let modified_nanos = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                size: meta.len(),
                modified_nanos,
                dev: meta.dev(),
                ino: meta.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                size: meta.len(),
                modified_nanos,
            }
        }
    }
}

#[derive(Clone, Debug)]
struct AuthorizedUploadSource {
    canonical_path: PathBuf,
    identity: UploadSourceIdentity,
    expires_at: SystemTime,
}

/// One-time token/identity store binding a user-picked file to an upload operation.
#[derive(Debug, Default)]
pub struct AuthorizedUploadRegistry {
    by_token: HashMap<String, AuthorizedUploadSource>,
}

impl AuthorizedUploadRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a regular, non-symlink file picked by the user and returns an authorization token.
    pub fn authorize_file(&mut self, source_path: &Path) -> Result<String> {
        self.prune_expired();
        let meta = fs::symlink_metadata(source_path)?;
        if meta.file_type().is_symlink() {
            bail!("Upload source path must not be a symbolic link.");
        }
        if !meta.is_file() {
            bail!("Source path is not a file");
        }
        if meta.len() > MAX_ATTACHMENT_UPLOAD_BYTE_SIZE {
            bail!("File too large to upload (max 100MB)");
        }
        let canonical = canonicalize_sync(source_path);
        let token = uuid::Uuid::new_v4().to_string();
        self.by_token.insert(
            token.clone(),
            AuthorizedUploadSource {
                canonical_path: canonical,
                identity: UploadSourceIdentity::from_metadata(&meta),
                expires_at: SystemTime::now() + DEFAULT_UPLOAD_AUTHORIZATION_TTL,
            },
        );
        Ok(token)
    }

    /// Consumes a one-time authorization token and opens the file with symlink/race protection.
    pub fn consume_and_open(&mut self, token: &str, expected_path: &Path) -> Result<File> {
        self.prune_expired();
        let entry = self.by_token.remove(token).ok_or_else(|| {
            anyhow::anyhow!(
                "Upload source path is not authorized. Select the file through the desktop file picker."
            )
        })?;
        if SystemTime::now() > entry.expires_at {
            bail!("Upload authorization expired. Select the file again.");
        }
        let canonical_expected = canonicalize_sync(expected_path);
        if canonical_expected != entry.canonical_path {
            bail!("Upload source path does not match authorized file.");
        }

        let lstat_meta = fs::symlink_metadata(expected_path)?;
        if lstat_meta.file_type().is_symlink() {
            bail!("Upload source path must not be a symbolic link.");
        }
        if !lstat_meta.is_file() {
            bail!("Source path is not a file");
        }
        if UploadSourceIdentity::from_metadata(&lstat_meta) != entry.identity {
            bail!("Upload source file changed after authorization. Select the file again.");
        }

        let mut opts = OpenOptions::new();
        opts.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.custom_flags(libc::O_NOFOLLOW);
        }
        let file = opts.open(expected_path)?;
        let opened_meta = file.metadata()?;
        if !opened_meta.is_file() {
            bail!("Source path is not a file");
        }
        if UploadSourceIdentity::from_metadata(&opened_meta) != entry.identity {
            bail!("Upload source file changed after authorization. Select the file again.");
        }
        if opened_meta.len() > MAX_ATTACHMENT_UPLOAD_BYTE_SIZE {
            bail!("File too large to upload (max 100MB)");
        }
        Ok(file)
    }

    fn prune_expired(&mut self) {
        let now = SystemTime::now();
        self.by_token.retain(|_, v| v.expires_at > now);
    }
}

struct FeatureFlagSpec {
    id: &'static str,
    default_enabled: bool,
    env_override: Option<&'static str>,
    forced_off_when_packaged: bool,
}

const FEATURE_FLAG_SPECS: &[FeatureFlagSpec] = &[
    FeatureFlagSpec {
        id: "menuBar",
        default_enabled: true,
        env_override: None,
        forced_off_when_packaged: false,
    },
    FeatureFlagSpec {
        id: "remoteAccess",
        default_enabled: false,
        env_override: Some("COWORK_ENABLE_REMOTE_ACCESS"),
        forced_off_when_packaged: true,
    },
    FeatureFlagSpec {
        id: "workspacePicker",
        default_enabled: true,
        env_override: None,
        forced_off_when_packaged: false,
    },
    FeatureFlagSpec {
        id: "workspaceLifecycle",
        default_enabled: true,
        env_override: None,
        forced_off_when_packaged: false,
    },
    FeatureFlagSpec {
        id: "openAiNativeConnectors",
        default_enabled: false,
        env_override: None,
        forced_off_when_packaged: false,
    },
    FeatureFlagSpec {
        id: "canvas",
        default_enabled: false,
        env_override: None,
        forced_off_when_packaged: false,
    },
    FeatureFlagSpec {
        id: "tasks",
        default_enabled: false,
        env_override: Some("COWORK_ENABLE_TASKS"),
        forced_off_when_packaged: false,
    },
    FeatureFlagSpec {
        id: "workflows",
        default_enabled: false,
        env_override: Some("COWORK_ENABLE_WORKFLOWS"),
        forced_off_when_packaged: false,
    },
];

fn parse_boolean_flag(raw: Option<&String>) -> Option<bool> {
    let normalized = raw?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Resolves runtime desktop feature flags matching `src/shared/featureFlags.ts`:
/// applies defaults, then env overrides, then persisted overrides (dev only), and
/// enforces `packagedAvailability: "forced-off"` (such as `remoteAccess`) when packaged.
pub fn resolve_effective_feature_flags(
    persisted_overrides: &HashMap<String, bool>,
    env: &HashMap<String, String>,
    is_packaged: bool,
) -> HashMap<String, bool> {
    let mut resolved = HashMap::with_capacity(FEATURE_FLAG_SPECS.len());

    for spec in FEATURE_FLAG_SPECS {
        let mut enabled = spec.default_enabled;
        if let Some(env_key) = spec.env_override
            && let Some(parsed) = parse_boolean_flag(env.get(env_key))
        {
            enabled = parsed;
        }
        if !is_packaged && let Some(&override_val) = persisted_overrides.get(spec.id) {
            enabled = override_val;
        }
        if is_packaged && spec.forced_off_when_packaged {
            enabled = false;
        }
        resolved.insert(spec.id.to_string(), enabled);
    }

    resolved
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn external_url_allowlist_blocks_dangerous_schemes() {
        assert!(assert_allowed_external_url("https://example.com/docs").is_ok());
        assert!(assert_allowed_external_url("http://127.0.0.1:8080").is_ok());
        assert!(assert_allowed_external_url("mailto:team@example.com").is_ok());

        assert!(assert_allowed_external_url("file:///etc/passwd").is_err());
        assert!(assert_allowed_external_url("javascript:alert(1)").is_err());
        assert!(assert_allowed_external_url("smb://evil/share").is_err());
        assert!(assert_allowed_external_url("   ").is_err());
    }

    #[test]
    fn workspace_roots_controller_enforces_approved_roots() {
        let temp = tempfile::tempdir().unwrap();
        let ws = temp.path().join("repo");
        let sub = ws.join("nested");
        let outside = temp.path().join("other");
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let mut controller = WorkspaceRootsController::new();
        controller.set_persisted_workspaces([("ws-1", ws.as_path())]);

        assert!(
            controller
                .resolve_authorized_workspace_root("ws-1", Some(&ws))
                .is_ok()
        );
        // Subdirectory inside an approved workspace must not pass as an authorized root itself.
        assert!(
            controller
                .resolve_authorized_workspace_root("ws-2", Some(&sub))
                .is_err()
        );
        assert!(
            controller
                .resolve_authorized_workspace_root("ws-1", Some(&outside))
                .is_err()
        );
        assert!(
            controller
                .resolve_authorized_workspace_root("unknown", Some(&outside))
                .is_err()
        );

        controller.unregister_workspace("ws-1");
        assert!(controller.approved_roots().is_empty());

        let chats_root = temp.path().join("chats");
        let oneoff = chats_root.join("chat-99");
        assert!(
            controller
                .approve_one_off_chat_workspace("ws-chat", &oneoff, &chats_root)
                .is_ok()
        );
        assert!(
            controller
                .approve_one_off_chat_workspace("ws-root", &chats_root, &chats_root)
                .is_err()
        );
        assert!(
            controller
                .approve_one_off_chat_workspace("ws-esc", &outside, &chats_root)
                .is_err()
        );
    }

    #[test]
    fn upload_registry_is_one_time_and_detects_modifications() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("notes.txt");
        fs::write(&file, "initial").unwrap();

        let mut registry = AuthorizedUploadRegistry::new();
        let token = registry.authorize_file(&file).unwrap();

        let mut opened = registry.consume_and_open(&token, &file).unwrap();
        let mut contents = String::new();
        opened.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "initial");

        // Second use of the same one-time token fails.
        assert!(registry.consume_and_open(&token, &file).is_err());

        // Modifying the file after authorization invalidates the token.
        let token2 = registry.authorize_file(&file).unwrap();
        fs::write(&file, "tampered-longer").unwrap();
        assert!(registry.consume_and_open(&token2, &file).is_err());
    }

    #[test]
    fn resolves_effective_feature_flags_with_packaged_enforcement() {
        let mut persisted = HashMap::new();
        persisted.insert("remoteAccess".to_string(), true);
        persisted.insert("tasks".to_string(), true);
        persisted.insert("canvas".to_string(), true);
        persisted.insert("unknownFlag".to_string(), true);

        let mut env = HashMap::new();
        env.insert("COWORK_ENABLE_WORKFLOWS".to_string(), "YES".to_string());
        env.insert("COWORK_ENABLE_REMOTE_ACCESS".to_string(), "1".to_string());

        // Development builds honor env overrides and persisted overrides.
        let dev_flags = resolve_effective_feature_flags(&persisted, &env, false);
        assert_eq!(dev_flags.get("menuBar"), Some(&true));
        assert_eq!(dev_flags.get("remoteAccess"), Some(&true));
        assert_eq!(dev_flags.get("tasks"), Some(&true));
        assert_eq!(dev_flags.get("workflows"), Some(&true));
        assert_eq!(dev_flags.get("canvas"), Some(&true));
        assert!(!dev_flags.contains_key("unknownFlag"));

        // Packaged builds ignore persisted dev overrides and force remoteAccess off.
        let pkg_flags = resolve_effective_feature_flags(&persisted, &env, true);
        assert_eq!(pkg_flags.get("menuBar"), Some(&true));
        assert_eq!(pkg_flags.get("remoteAccess"), Some(&false));
        assert_eq!(pkg_flags.get("tasks"), Some(&false));
        assert_eq!(pkg_flags.get("canvas"), Some(&false));
        assert_eq!(pkg_flags.get("workflows"), Some(&true));
    }
}
