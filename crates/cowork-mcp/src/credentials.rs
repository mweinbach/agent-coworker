use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, FileLockOptions, ensure_private_dir_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, with_file_lock_sync, write_text_file_atomic,
};
use serde::{Deserialize, Serialize};

use crate::types::{
    McpAuthMode, McpAuthScope, McpAuthStatus, McpConfigSource, McpServerAuthConfig,
    McpServerAuthState,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredApiKeyCredential {
    pub api_key: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

pub fn credential_key_for_server(server_name: &str, auth: Option<&McpServerAuthConfig>) -> String {
    if let Some(McpServerAuthConfig::ApiKey {
        key_id: Some(kid), ..
    }) = auth
    {
        let trimmed = kid.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    server_name.to_owned()
}

pub fn read_credentials_file(path: &Path) -> McpCredentialsFile {
    let Ok(raw) = fs::read_to_string(path) else {
        return McpCredentialsFile::default();
    };
    harden_private_file_sync(path);
    serde_json::from_str::<McpCredentialsFile>(&raw).unwrap_or_default()
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
            let mut store = read_credentials_file(credentials_path);
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

    let key = credential_key_for_server(server_name, Some(auth_cfg));
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
