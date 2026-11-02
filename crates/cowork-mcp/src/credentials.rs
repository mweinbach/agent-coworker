use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, FileLockOptions, ensure_private_dir_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, with_file_lock_sync, write_text_file_atomic,
};
use serde::{Deserialize, Deserializer, Serialize};

use crate::types::{
    McpAuthMode, McpAuthScope, McpAuthStatus, McpConfigSource, McpServerAuthConfig,
    McpServerAuthState,
};

/// API-key credential record.
///
/// Reads both the Rust shape (`apiKey` + epoch-ms `updatedAt`) and the legacy
/// TypeScript v1 shape (`value` + ISO-8601 `updatedAt`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredApiKeyCredential {
    #[serde(alias = "value")]
    pub api_key: String,
    /// The server's `auth.keyId` at the time the key was stored (TS `apiKey.keyId`).
    /// Metadata only: records are always keyed by server name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_timestamp_ms")]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOAuthClientInfo {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint_auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uris: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOAuthTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_opt_timestamp_ms"
    )]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPendingOAuthFlow {
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    /// The authorization server's `token_endpoint_auth_methods_supported` at challenge time, used
    /// to pick the client authentication for the code exchange (absent on flows started before
    /// it was recorded, which then fall back to the registered method / RFC 8414 default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint_auth_methods_supported: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(deserialize_with = "deserialize_timestamp_ms")]
    pub expires_at: u64,
}

/// OAuth credential record.
///
/// Deserialization goes through [`StoredOAuthCredentialWire`] so the legacy
/// TypeScript v1 shape also loads: `clientInformation` is accepted for
/// `clientInfo`, the OAuth-level `updatedAt` is optional (falling back to the
/// newest nested `tokens`/`clientInformation` `updatedAt`, else 0), and a
/// pending flow that lacks fields the Rust flow needs is dropped instead of
/// failing the whole credential store.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "StoredOAuthCredentialWire")]
pub struct StoredOAuthCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_info: Option<StoredOAuthClientInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<StoredOAuthTokens>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<StoredPendingOAuthFlow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_issuer: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredServerCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<StoredApiKeyCredential>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<StoredOAuthCredential>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCredentialsFile {
    pub version: u32,
    #[serde(default)]
    pub servers: BTreeMap<String, StoredServerCredential>,
}

impl Default for McpCredentialsFile {
    fn default() -> Self {
        Self {
            version: 1,
            servers: BTreeMap::new(),
        }
    }
}

/// Wire timestamp accepted when reading credential stores: epoch milliseconds
/// (Rust writer) or an ISO-8601 / RFC 3339 string (TypeScript v1 writer).
#[derive(Deserialize)]
#[serde(untagged)]
enum WireTimestamp {
    Unsigned(u64),
    Signed(i64),
    Float(f64),
    Text(String),
}

impl WireTimestamp {
    fn into_epoch_ms(self) -> Result<u64, String> {
        match self {
            Self::Unsigned(ms) => Ok(ms),
            Self::Signed(ms) => Ok(u64::try_from(ms).unwrap_or(0)),
            Self::Float(ms) if ms.is_finite() && ms > 0.0 => Ok(ms as u64),
            Self::Float(_) => Ok(0),
            Self::Text(text) => {
                let trimmed = text.trim();
                if let Ok(ms) = trimmed.parse::<u64>() {
                    return Ok(ms);
                }
                chrono::DateTime::parse_from_rfc3339(trimmed)
                    .map(|dt| u64::try_from(dt.timestamp_millis()).unwrap_or(0))
                    .map_err(|e| format!("invalid timestamp {trimmed:?}: {e}"))
            }
        }
    }
}

fn deserialize_timestamp_ms<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    WireTimestamp::deserialize(d)?
        .into_epoch_ms()
        .map_err(serde::de::Error::custom)
}

fn deserialize_opt_timestamp_ms<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Option::<WireTimestamp>::deserialize(d)?
        .map(WireTimestamp::into_epoch_ms)
        .transpose()
        .map_err(serde::de::Error::custom)
}

/// Pending OAuth flows are short-lived; TS-written ones lack the endpoints the
/// Rust flow needs. Drop an unusable pending flow rather than rejecting the
/// whole credential store (which would hide the stored tokens/keys).
fn deserialize_lenient_pending<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<StoredPendingOAuthFlow>, D::Error> {
    let raw = Option::<serde_json::Value>::deserialize(d)?;
    Ok(raw.and_then(|value| match serde_json::from_value(value) {
        Ok(pending) => Some(pending),
        Err(error) => {
            tracing::warn!(%error, "dropping unreadable pending MCP OAuth flow");
            None
        }
    }))
}

/// Nested record plus its optional `updatedAt`, used to derive the
/// OAuth-level `updatedAt` for TypeScript v1 records that lack it.
#[derive(Deserialize)]
struct WithUpdatedAt<T> {
    #[serde(flatten)]
    inner: T,
    #[serde(
        default,
        rename = "updatedAt",
        deserialize_with = "deserialize_opt_timestamp_ms"
    )]
    updated_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOAuthCredentialWire {
    #[serde(default, alias = "clientInformation")]
    client_info: Option<WithUpdatedAt<StoredOAuthClientInfo>>,
    #[serde(default)]
    tokens: Option<WithUpdatedAt<StoredOAuthTokens>>,
    #[serde(default, deserialize_with = "deserialize_lenient_pending")]
    pending: Option<StoredPendingOAuthFlow>,
    #[serde(default)]
    discovery_issuer: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_timestamp_ms")]
    updated_at: Option<u64>,
}

impl From<StoredOAuthCredentialWire> for StoredOAuthCredential {
    fn from(wire: StoredOAuthCredentialWire) -> Self {
        let nested_updated_at = [
            wire.client_info.as_ref().and_then(|c| c.updated_at),
            wire.tokens.as_ref().and_then(|t| t.updated_at),
        ]
        .into_iter()
        .flatten()
        .max();
        Self {
            client_info: wire.client_info.map(|c| c.inner),
            tokens: wire.tokens.map(|t| t.inner),
            pending: wire.pending,
            discovery_issuer: wire.discovery_issuer,
            updated_at: wire.updated_at.or(nested_updated_at).unwrap_or(0),
        }
    }
}

pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Masks a secret for UI display (`first4...last4` for length > 8, else `****`).
pub fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 8 {
        return "****".to_owned();
    }
    let first4: String = chars[..4].iter().collect();
    let last4: String = chars[chars.len() - 4..].iter().collect();
    format!("{first4}...{last4}")
}

/// Strict credential scope mapping:
/// - `workspace` servers and `workspace`-scoped plugins use `<workspace>/.cowork/auth/mcp-credentials.json`
/// - `user`, `system`, and `user`-scoped plugins use `<userCoworkDir>/auth/mcp-credentials.json`
pub fn auth_scope_for_source(source: McpConfigSource, plugin_scope: Option<&str>) -> McpAuthScope {
    match source {
        McpConfigSource::Workspace => McpAuthScope::Workspace,
        McpConfigSource::Plugin if plugin_scope == Some("workspace") => McpAuthScope::Workspace,
        _ => McpAuthScope::User,
    }
}

pub fn credentials_path_for_scope(config: &AgentConfig, scope: McpAuthScope) -> PathBuf {
    match scope {
        McpAuthScope::Workspace => config
            .project_cowork_dir
            .join("auth")
            .join("mcp-credentials.json"),
        McpAuthScope::User => config
            .user_cowork_dir
            .join("auth")
            .join("mcp-credentials.json"),
    }
}

/// The credential-store record key for a server: its (trimmed) name.
///
/// Matches TS `setMCPServerApiKeyCredential` / `selectCredentialRecord`, which read and write
/// `servers[server.name]`; an `api_key` `keyId` is stored only as `apiKey.keyId` metadata and
/// never changes the lookup key.
pub fn credential_key_for_server(server_name: &str) -> String {
    server_name.trim().to_owned()
}

/// Reads and decodes a credential store.
///
/// A missing file is an empty store. Any other read failure, or a file that
/// does not decode (Rust or legacy TypeScript v1 shape), is an error so that
/// callers which write the store back never clobber credentials they could
/// not read.
pub fn try_read_credentials_file(path: &Path) -> Result<McpCredentialsFile, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(McpCredentialsFile::default());
        }
        Err(error) => {
            return Err(format!(
                "Failed to read MCP credential store at {}: {error}",
                path.display()
            ));
        }
    };
    harden_private_file_sync(path);
    serde_json::from_str::<McpCredentialsFile>(&raw).map_err(|error| {
        format!(
            "Invalid MCP credential store at {}: {error}. Fix or remove the file to continue.",
            path.display()
        )
    })
}

/// Read-only lookup of a credential store. An unreadable store is logged and
/// treated as empty for display/resolution purposes only; it is never written
/// back from here (see [`mutate_credentials_file`]).
pub fn read_credentials_file(path: &Path) -> McpCredentialsFile {
    try_read_credentials_file(path).unwrap_or_else(|error| {
        tracing::warn!(path = %path.display(), %error, "ignoring unreadable MCP credential store");
        McpCredentialsFile::default()
    })
}

pub fn mutate_credentials_file<F, R>(
    lock_root: &Path,
    credentials_path: &Path,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&mut McpCredentialsFile) -> R,
{
    if let Some(parent) = credentials_path.parent() {
        ensure_private_dir_sync(parent).map_err(|e| e.to_string())?;
    }
    with_file_lock_sync::<R, anyhow::Error, _>(
        credentials_path,
        || {
            // Refuse to mutate a store we cannot decode: writing back a
            // default store here would permanently drop the user's credentials.
            let mut store = try_read_credentials_file(credentials_path).map_err(|error| {
                tracing::warn!(
                    path = %credentials_path.display(),
                    %error,
                    "refusing to overwrite unreadable MCP credential store"
                );
                anyhow::anyhow!(error)
            })?;
            store.version = 1;
            let out = f(&mut store);
            let serialized = format!("{}\n", serde_json::to_string_pretty(&store)?);
            write_text_file_atomic(credentials_path, &serialized, Some(0o600))?;
            harden_private_file_sync(credentials_path);
            Ok(out)
        },
        FileLockOptions {
            lock_root: Some(lock_root.to_path_buf()),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

pub fn mutate_credentials_for_scope<F, R>(
    config: &AgentConfig,
    scope: McpAuthScope,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&mut McpCredentialsFile) -> R,
{
    let lock_root = file_lock_root_for_cowork_home(&config.user_cowork_dir);
    let cred_path = credentials_path_for_scope(config, scope);
    mutate_credentials_file(&lock_root, &cred_path, f)
}

pub fn compute_auth_state(
    server_name: &str,
    auth: Option<&McpServerAuthConfig>,
    creds: &McpCredentialsFile,
) -> McpServerAuthState {
    let Some(auth_cfg) = auth else {
        return McpServerAuthState {
            mode: McpAuthMode::None,
            status: McpAuthStatus::NotConfigured,
            message: "No authentication required.".to_owned(),
            has_stored_secret: false,
            masked_secret: None,
            expires_at: None,
            oauth_client_id: None,
        };
    };

    let key = credential_key_for_server(server_name);
    let stored = creds.servers.get(&key);

    match auth_cfg {
        McpServerAuthConfig::None => McpServerAuthState {
            mode: McpAuthMode::None,
            status: McpAuthStatus::NotConfigured,
            message: "No authentication required.".to_owned(),
            has_stored_secret: false,
            masked_secret: None,
            expires_at: None,
            oauth_client_id: None,
        },
        McpServerAuthConfig::ApiKey { .. } => {
            if let Some(api_cred) = stored.and_then(|s| s.api_key.as_ref())
                && !api_cred.api_key.is_empty()
            {
                let masked = mask_secret(&api_cred.api_key);
                McpServerAuthState {
                    mode: McpAuthMode::ApiKey,
                    status: McpAuthStatus::Configured,
                    message: format!("API key configured ({masked})."),
                    has_stored_secret: true,
                    masked_secret: Some(masked),
                    expires_at: None,
                    oauth_client_id: None,
                }
            } else {
                McpServerAuthState {
                    mode: McpAuthMode::Missing,
                    status: McpAuthStatus::NotConfigured,
                    message: "API key required.".to_owned(),
                    has_stored_secret: false,
                    masked_secret: None,
                    expires_at: None,
                    oauth_client_id: None,
                }
            }
        }
        McpServerAuthConfig::OAuth { .. } => {
            let oauth = stored.and_then(|s| s.oauth.as_ref());
            let client_id = oauth
                .and_then(|o| o.client_info.as_ref())
                .map(|c| c.client_id.clone());
            if let Some(tokens) = oauth.and_then(|o| o.tokens.as_ref())
                && !tokens.access_token.is_empty()
            {
                let now = now_epoch_ms();
                let is_expired = tokens
                    .expires_at
                    .is_some_and(|exp| exp <= now.saturating_add(30_000));
                if is_expired && tokens.refresh_token.is_none() {
                    McpServerAuthState {
                        mode: McpAuthMode::Missing,
                        status: McpAuthStatus::Expired,
                        message: "OAuth access token expired; sign in again.".to_owned(),
                        has_stored_secret: true,
                        masked_secret: Some(mask_secret(&tokens.access_token)),
                        expires_at: tokens.expires_at,
                        oauth_client_id: client_id,
                    }
                } else {
                    McpServerAuthState {
                        mode: McpAuthMode::OAuth,
                        status: McpAuthStatus::Configured,
                        message: "OAuth connected.".to_owned(),
                        has_stored_secret: true,
                        masked_secret: Some(mask_secret(&tokens.access_token)),
                        expires_at: tokens.expires_at,
                        oauth_client_id: client_id,
                    }
                }
            } else if oauth.and_then(|o| o.pending.as_ref()).is_some() {
                McpServerAuthState {
                    mode: McpAuthMode::OAuthPending,
                    status: McpAuthStatus::NeedsAuthorization,
                    message: "OAuth authorization pending.".to_owned(),
                    has_stored_secret: false,
                    masked_secret: None,
                    expires_at: None,
                    oauth_client_id: client_id,
                }
            } else {
                McpServerAuthState {
                    mode: McpAuthMode::Missing,
                    status: McpAuthStatus::NeedsAuthorization,
                    message: "OAuth authorization required.".to_owned(),
                    has_stored_secret: false,
                    masked_secret: None,
                    expires_at: None,
                    oauth_client_id: client_id,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Credential store exactly as the TypeScript v1 writer
    /// (`src/mcp/authStore/editor.ts` on origin/main) produced it.
    const TS_V1_FIXTURE: &str = r#"{
  "version": 1,
  "updatedAt": "2025-03-04T05:06:07.890Z",
  "servers": {
    "github": {
      "apiKey": {
        "value": "ghp_abcdefghijklmnopqrstuvwxyz",
        "keyId": "github",
        "updatedAt": "2025-03-04T05:06:07.890Z"
      }
    },
    "linear": {
      "oauth": {
        "tokens": {
          "accessToken": "lin_access_token_value",
          "tokenType": "Bearer",
          "refreshToken": "lin_refresh_token_value",
          "expiresAt": "2025-03-04T06:06:07.000Z",
          "scope": "read write",
          "resource": "https://mcp.linear.app/sse",
          "updatedAt": "2025-03-04T05:06:07.000Z"
        },
        "clientInformation": {
          "clientId": "client-123",
          "clientSecret": "secret-456",
          "tokenEndpointAuthMethod": "client_secret_post",
          "redirectUris": ["http://127.0.0.1:43123/oauth/callback"],
          "updatedAt": "2025-03-04T05:00:00.000Z"
        }
      }
    },
    "notion": {
      "oauth": {
        "pending": {
          "challengeId": "challenge-1",
          "state": "state-1",
          "codeVerifier": "verifier-1",
          "redirectUri": "http://127.0.0.1:43124/oauth/callback",
          "createdAt": "2025-03-04T05:00:00.000Z",
          "expiresAt": "2025-03-04T05:10:00.000Z",
          "authorizationServerUrl": "https://auth.notion.example"
        },
        "clientInformation": {
          "clientId": "notion-client",
          "updatedAt": "2025-03-04T05:00:00.000Z"
        }
      }
    }
  }
}
"#;

    fn iso_ms(iso: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis() as u64
    }

    #[test]
    fn decodes_typescript_v1_api_key_and_oauth_records() {
        let store: McpCredentialsFile = serde_json::from_str(TS_V1_FIXTURE).unwrap();
        assert_eq!(store.version, 1);

        let api_key = store.servers["github"].api_key.as_ref().unwrap();
        assert_eq!(api_key.api_key, "ghp_abcdefghijklmnopqrstuvwxyz");
        assert_eq!(api_key.updated_at, iso_ms("2025-03-04T05:06:07.890Z"));
        assert_eq!(api_key.key_id.as_deref(), Some("github"));

        let oauth = store.servers["linear"].oauth.as_ref().unwrap();
        let tokens = oauth.tokens.as_ref().unwrap();
        assert_eq!(tokens.access_token, "lin_access_token_value");
        assert_eq!(tokens.token_type.as_deref(), Some("Bearer"));
        assert_eq!(
            tokens.refresh_token.as_deref(),
            Some("lin_refresh_token_value")
        );
        assert_eq!(tokens.expires_at, Some(iso_ms("2025-03-04T06:06:07.000Z")));
        assert_eq!(tokens.scope.as_deref(), Some("read write"));
        let client = oauth.client_info.as_ref().unwrap();
        assert_eq!(client.client_id, "client-123");
        assert_eq!(client.client_secret.as_deref(), Some("secret-456"));
        assert_eq!(
            client.token_endpoint_auth_method.as_deref(),
            Some("client_secret_post")
        );
        // No OAuth-level updatedAt in TS v1: newest nested updatedAt wins.
        assert_eq!(oauth.updated_at, iso_ms("2025-03-04T05:06:07.000Z"));

        // TS pending flows lack the endpoints the Rust flow needs; they are
        // dropped while the rest of the record survives.
        let notion = store.servers["notion"].oauth.as_ref().unwrap();
        assert!(notion.pending.is_none());
        assert_eq!(
            notion.client_info.as_ref().unwrap().client_id,
            "notion-client"
        );
        assert_eq!(notion.updated_at, iso_ms("2025-03-04T05:00:00.000Z"));

        let auth = McpServerAuthConfig::ApiKey {
            header_name: None,
            prefix: None,
            key_id: None,
        };
        let state = compute_auth_state("github", Some(&auth), &store);
        assert!(state.has_stored_secret);
        assert_eq!(state.status, McpAuthStatus::Configured);
    }

    #[test]
    fn typescript_v1_store_survives_mutation_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth").join("mcp-credentials.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, TS_V1_FIXTURE).unwrap();

        mutate_credentials_file(&dir.path().join("locks"), &path, |store| {
            store.servers.entry("added".to_owned()).or_default().api_key =
                Some(StoredApiKeyCredential {
                    api_key: "new-key".to_owned(),
                    key_id: None,
                    updated_at: 42,
                });
        })
        .unwrap();

        let reread = try_read_credentials_file(&path).unwrap();
        assert_eq!(
            reread.servers["github"].api_key.as_ref().unwrap().api_key,
            "ghp_abcdefghijklmnopqrstuvwxyz"
        );
        let tokens = reread.servers["linear"]
            .oauth
            .as_ref()
            .unwrap()
            .tokens
            .as_ref()
            .unwrap();
        assert_eq!(tokens.access_token, "lin_access_token_value");
        assert_eq!(tokens.expires_at, Some(iso_ms("2025-03-04T06:06:07.000Z")));
        assert_eq!(
            reread.servers["added"].api_key.as_ref().unwrap().api_key,
            "new-key"
        );
    }

    #[test]
    fn unparseable_store_is_not_clobbered_by_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth").join("mcp-credentials.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let garbage = "{ \"version\": 1, \"servers\": { \"x\": { \"apiKey\": 7 } } }";
        fs::write(&path, garbage).unwrap();

        assert!(try_read_credentials_file(&path).is_err());
        // Read-only lookups degrade to empty without touching the file.
        assert!(read_credentials_file(&path).servers.is_empty());

        let mut called = false;
        let result = mutate_credentials_file(&dir.path().join("locks"), &path, |store| {
            called = true;
            store.servers.insert("y".to_owned(), Default::default());
        });
        let error = result.unwrap_err();
        assert!(error.contains("Invalid MCP credential store"), "{error}");
        assert!(
            !called,
            "mutation callback must not run on unreadable store"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), garbage);
    }

    #[test]
    fn missing_store_reads_as_empty_and_accepts_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth").join("mcp-credentials.json");
        assert!(try_read_credentials_file(&path).unwrap().servers.is_empty());
        mutate_credentials_file(&dir.path().join("locks"), &path, |store| {
            store.servers.insert("s".to_owned(), Default::default());
        })
        .unwrap();
        assert!(
            try_read_credentials_file(&path)
                .unwrap()
                .servers
                .contains_key("s")
        );
    }
}
