use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::{
    ConnectionMode, FileLockOptions, ModelPreferenceUpdate, ProviderName, StoredConnection,
    ToolApiKeys, delete_custom_model, file_lock_root_for_cowork_home, get_ai_coworker_paths,
    read_connection_store, read_connection_store_sync, remove_provider_connection,
    reset_model_preferences, save_provider_connection, set_model_preferences, upsert_custom_model,
    with_file_lock, write_connection_store,
};
use cowork_protocol::{
    ConnectorsOpenAiNativeSetEnabledParams, JsonRpcLiteError, ProviderAuthAuthorizeParams,
    ProviderAuthCallbackParams, ProviderAuthCopyApiKeyParams, ProviderAuthLogoutParams,
    ProviderAuthSetApiKeyParams, ProviderAuthSetConfigParams, ProviderCatalogReadParams,
    ProviderCodexAppServerStatusParams, ProviderCodexAppServerUpdateParams,
    ProviderCustomModelAddParams, ProviderCustomModelDeleteParams,
    ProviderLmStudioLocalStartParams, ProviderLmStudioLocalStatusParams,
    ProviderModelResetEnabledParams, ProviderModelSetEnabledParams, ProviderStatusRefreshParams,
    error_codes,
};
use cowork_providers::CatalogBuildOptions;
use cowork_providers::chat_completions::lmstudio::{
    LmStudioLocalService, is_loopback_lmstudio_url, resolve_lmstudio_options,
};
use cowork_providers::codex_app_server::{
    CodexAppServerClient, CodexNotification, await_codex_chatgpt_login_completion,
    logout_codex_account, parse_codex_chatgpt_login_challenge, read_openai_native_connectors,
    resolve_codex_app_server_status, resolve_codex_home, set_openai_native_connector_enabled,
    start_codex_chatgpt_login,
};
use cowork_providers::oauth::{OAuthMode, PkceOAuthConfig};
use serde_json::{Map, Value, json};

use crate::registry::ServerRuntimeState;

pub(crate) struct PendingCodexLogin {
    pub client: Arc<CodexAppServerClient>,
    pub login_id: String,
    pub codex_home: PathBuf,
    pub notif_rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<CodexNotification>>,
}

fn is_opencode_sibling_pair(target: ProviderName, source: ProviderName) -> bool {
    matches!(
        (target, source),
        (ProviderName::OpencodeGo, ProviderName::OpencodeZen)
            | (ProviderName::OpencodeZen, ProviderName::OpencodeGo)
    )
}

fn parse_provider_param(raw: &str) -> Result<ProviderName, JsonRpcLiteError> {
    ProviderName::parse(raw.trim()).ok_or_else(|| {
        JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("Invalid provider: {raw}"),
        )
    })
}

impl ServerRuntimeState {
    pub(crate) fn catalog_build_options(&self, cwd: &Path, refresh: bool) -> CatalogBuildOptions {
        let provider_options = self
            .load_workspace_config(cwd)
            .ok()
            .and_then(|cfg| cfg.provider_options);
        let mut base_url_overrides = HashMap::new();
        for &provider in &ProviderName::ALL {
            let env_key = match provider {
                ProviderName::Google => "GEMINI_BASE_URL".to_owned(),
                ProviderName::Bedrock => "AWS_BEDROCK_ENDPOINT_URL".to_owned(),
                ProviderName::Lmstudio => "LM_STUDIO_BASE_URL".to_owned(),
                other => format!(
                    "{}_BASE_URL",
                    other.as_str().to_ascii_uppercase().replace('-', "_")
                ),
            };
            if let Some(po_url) = provider_options
                .as_ref()
                .and_then(|po| po.get(provider.as_str()))
                .and_then(Value::as_object)
                .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                base_url_overrides.insert(provider, po_url.to_owned());
            } else if let Some(env_url) = self
                .env
                .get(&env_key)
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                base_url_overrides.insert(provider, env_url.to_owned());
            }
        }
        CatalogBuildOptions {
            homedir: self.homedir.clone(),
            env: self.env.clone(),
            provider_options,
            refresh,
            discovery_timeout_ms: None,
            base_url_overrides,
        }
    }

    pub async fn read_provider_catalog(&self, cwd: &Path, refresh: bool) -> Value {
        let opts = self.catalog_build_options(cwd, refresh);
        let payload = cowork_providers::build_provider_catalog(&opts).await;
        let mut defaults: Map<String, Value> = payload
            .default
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();

        // Keep workspace-configured model as default ONLY if it remains enabled in the catalog.
        if let Ok(cfg) = self.load_workspace_config(cwd)
            && let Some(entry) = payload.all.iter().find(|e| e.id == cfg.provider)
        {
            let model_enabled = entry
                .models
                .iter()
                .any(|m| m.id == cfg.model && m.enabled != Some(false));
            if model_enabled {
                defaults.insert(cfg.provider.as_str().to_owned(), Value::String(cfg.model));
            }
        }

        let session_id = self.get_or_create_workspace_state_id(cwd);
        json!({
            "type": "provider_catalog",
            "sessionId": session_id,
            "all": payload.all,
            "default": defaults,
            "connected": payload.connected,
        })
    }

    pub async fn handle_provider_catalog_read(
        &self,
        params: &ProviderCatalogReadParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/catalog/read")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let event = self
            .read_provider_catalog(&cwd, params.refresh.unwrap_or(false))
            .await;
        Ok(json!({ "event": event }))
    }

    pub fn handle_provider_auth_methods_read(
        &self,
        cwd_raw: Option<&str>,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(cwd_raw, "cowork/provider/authMethods/read")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let methods = cowork_providers::default_provider_auth_methods();
        Ok(json!({
            "event": {
                "type": "provider_auth_methods",
                "sessionId": session_id,
                "methods": methods,
            }
        }))
    }

    pub async fn handle_provider_status_refresh(
        &self,
        params: &ProviderStatusRefreshParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/status/refresh")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let opts = self.catalog_build_options(&cwd, false);
        let providers = cowork_providers::build_provider_statuses(
            &opts,
            params.refresh_bedrock_discovery.unwrap_or(false),
        )
        .await;
        let session_id = self.get_or_create_workspace_state_id(&cwd);
        Ok(json!({
            "event": {
                "type": "provider_status",
                "sessionId": session_id,
                "providers": providers,
            }
        }))
    }

    pub fn handle_codex_app_server_status(
        &self,
        params: &ProviderCodexAppServerStatusParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let _cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/provider/codexAppServer/status",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let status = resolve_codex_app_server_status(&paths.root_dir, &self.env);
        Ok(json!({ "status": status }))
    }

    pub async fn handle_codex_app_server_update(
        &self,
        params: &ProviderCodexAppServerUpdateParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let _cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/provider/codexAppServer/update",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let codex_home = resolve_codex_home(&paths.root_dir);
        self.codex_pool.close_for_home(&codex_home).await;
        let mut status = resolve_codex_app_server_status(&paths.root_dir, &self.env);
        if status.message.trim().is_empty() {
            status.message = "Codex runtime status checked.".to_owned();
        }
        Ok(json!({ "status": status }))
    }

    pub async fn handle_lmstudio_local_status(
        &self,
        params: &ProviderLmStudioLocalStatusParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/provider/lmstudio/local/status",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let opts = self.catalog_build_options(&cwd, false);
        let svc = LmStudioLocalService::new();
        let status = svc
            .get_status(
                &self.homedir,
                &self.env,
                opts.provider_options.as_ref(),
                params.base_url.as_deref(),
            )
            .await;
        Ok(json!({ "status": status }))
    }

    pub async fn handle_lmstudio_local_start(
        &self,
        params: &ProviderLmStudioLocalStartParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/provider/lmstudio/local/start",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        if let Some(timeout_ms) = params.timeout_ms
            && (timeout_ms == 0 || timeout_ms > 60_000)
        {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "timeoutMs must be between 1 and 60000",
            ));
        }

        let opts = self.catalog_build_options(&cwd, false);
        let resolved_lms =
            resolve_lmstudio_options(&self.env, opts.provider_options.as_ref(), None);
        let target_base_url = params
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&resolved_lms.base_url);

        if !is_loopback_lmstudio_url(target_base_url) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Only loopback LM Studio URLs may be auto-started: {target_base_url}"),
            ));
        }

        let svc = LmStudioLocalService::new();
        let status = svc
            .start_local(
                &self.homedir,
                &self.env,
                Some(target_base_url),
                params.timeout_ms,
            )
            .await
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;
        Ok(json!({ "status": status }))
    }

    fn resolve_oauth_config_from_env(&self, provider: ProviderName) -> Option<PkceOAuthConfig> {
        let p_upper = provider.as_str().to_ascii_uppercase().replace('-', "_");
        let auth_url = self
            .env
            .get(&format!("COWORK_OAUTH_{p_upper}_AUTHORIZE_URL"))
            .or_else(|| self.env.get("COWORK_OAUTH_AUTHORIZE_URL"))?
            .trim()
            .to_owned();
        let token_url = self
            .env
            .get(&format!("COWORK_OAUTH_{p_upper}_TOKEN_URL"))
            .or_else(|| self.env.get("COWORK_OAUTH_TOKEN_URL"))?
            .trim()
            .to_owned();
        if auth_url.is_empty() || token_url.is_empty() {
            return None;
        }
        let client_id = self
            .env
            .get(&format!("COWORK_OAUTH_{p_upper}_CLIENT_ID"))
            .or_else(|| self.env.get("COWORK_OAUTH_CLIENT_ID"))
            .cloned()
            .unwrap_or_else(|| "cowork-desktop".to_owned());
        let redirect_host = self
            .env
            .get("COWORK_OAUTH_REDIRECT_HOST")
            .cloned()
            .unwrap_or_else(|| "localhost".to_owned());

        Some(PkceOAuthConfig {
            client_id,
            authorize_url: auth_url,
            token_url,
            scopes: vec![
                "openid".to_owned(),
                "profile".to_owned(),
                "offline_access".to_owned(),
            ],
            advertised_redirect_host: redirect_host,
            callback_path: "/oauth/callback".to_owned(),
            mode: OAuthMode::Auto,
            resource: None,
        })
    }

    pub async fn handle_provider_auth_authorize(
        &self,
        params: &ProviderAuthAuthorizeParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/auth/authorize")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        let method_id = params.method_id.trim();
        if method_id.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "methodId must not be empty",
            ));
        }

        let Some(method_spec) = cowork_providers::resolve_provider_auth_method(provider, method_id)
        else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "Unsupported auth method \"{method_id}\" for {}.",
                    provider.as_str()
                ),
            ));
        };
        if method_spec.method_type != "oauth" {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "Auth method \"{method_id}\" for {} does not use OAuth.",
                    provider.as_str()
                ),
            ));
        }

        let session_id = self.get_or_create_workspace_state_id(&cwd);

        if let Some(oauth_cfg) = self.resolve_oauth_config_from_env(provider) {
            let ch = self
                .oauth_manager
                .start_challenge(oauth_cfg)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.message))?;
            self.oauth_challenges_by_provider
                .insert((provider, method_id.to_owned()), ch.challenge_id.clone());
            return Ok(json!({
                "event": {
                    "type": "provider_auth_challenge",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "challenge": {
                        "method": "auto",
                        "url": ch.authorize_url,
                        "instructions": "Complete sign-in in your browser."
                    }
                }
            }));
        }

        if provider == ProviderName::CodexCli && method_id == "oauth_cli" {
            let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
            let codex_home = resolve_codex_home(&paths.root_dir);
            let client = self
                .codex_pool
                .get_or_spawn(&cwd, &paths.root_dir, &self.env)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.message))?;

            // Subscribe BEFORE issuing `account/login/start` so rapid `account/login/completed` notifications cannot race.
            let notif_rx = client.subscribe_notifications();
            let started = start_codex_chatgpt_login(&client)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.message))?;
            let login_challenge = parse_codex_chatgpt_login_challenge(&started)
                .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.message))?;
            let auth_url = login_challenge.auth_url.clone();

            self.pending_codex_logins.insert(
                (provider, method_id.to_owned()),
                PendingCodexLogin {
                    client,
                    login_id: login_challenge.login_id,
                    codex_home,
                    notif_rx: tokio::sync::Mutex::new(notif_rx),
                },
            );

            return Ok(json!({
                "event": {
                    "type": "provider_auth_challenge",
                    "sessionId": session_id,
                    "provider": "codex-cli",
                    "methodId": "oauth_cli",
                    "challenge": {
                        "method": "auto",
                        "url": auth_url,
                        "instructions": "Continue to browser-based ChatGPT sign-in. Codex app-server owns the official login and local credential storage."
                    }
                }
            }));
        }

        Err(JsonRpcLiteError::new(
            error_codes::INVALID_REQUEST,
            format!("OAuth is not configured for {}.", provider.as_str()),
        ))
    }

    pub async fn handle_provider_auth_callback(
        &self,
        params: &ProviderAuthCallbackParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/auth/callback")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        let method_id = params.method_id.trim();
        if method_id.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "methodId must not be empty",
            ));
        }

        let Some(method_spec) = cowork_providers::resolve_provider_auth_method(provider, method_id)
        else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "Unsupported auth method \"{method_id}\" for {}.",
                    provider.as_str()
                ),
            ));
        };

        let session_id = self.get_or_create_workspace_state_id(&cwd);

        if method_spec.oauth_mode.as_deref() == Some("auto")
            && params.code.as_deref().is_some_and(|c| !c.trim().is_empty())
        {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "ok": false,
                    "message": format!("Method \"{method_id}\" manages OAuth in-app and does not accept a pasted authorization code."),
                }
            }));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        if let Some((_, challenge_id)) = self
            .oauth_challenges_by_provider
            .remove(&(provider, method_id.to_owned()))
        {
            let creds_file = paths
                .auth_dir
                .join(format!("oauth-{}.json", provider.as_str()));
            match self
                .oauth_manager
                .complete_challenge(&challenge_id, params.code.as_deref(), Some(&creds_file))
                .await
            {
                Ok(creds) => {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    save_provider_connection(
                        &paths,
                        StoredConnection {
                            service: provider,
                            mode: ConnectionMode::Oauth,
                            method_id: Some(method_id.to_owned()),
                            api_key: Some(creds.access_token),
                            values: None,
                            updated_at: now,
                        },
                    )
                    .await
                    .map_err(|e| {
                        JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string())
                    })?;
                    return Ok(json!({
                        "event": {
                            "type": "provider_auth_result",
                            "sessionId": session_id,
                            "provider": provider.as_str(),
                            "methodId": method_id,
                            "ok": true,
                            "mode": "oauth",
                            "message": "OAuth connected.",
                        }
                    }));
                }
                Err(err) => {
                    return Ok(json!({
                        "event": {
                            "type": "provider_auth_result",
                            "sessionId": session_id,
                            "provider": provider.as_str(),
                            "methodId": method_id,
                            "ok": false,
                            "message": err.message,
                        }
                    }));
                }
            }
        }

        if let Some((_, pending)) = self
            .pending_codex_logins
            .remove(&(provider, method_id.to_owned()))
        {
            let mut rx = pending.notif_rx.lock().await;
            match await_codex_chatgpt_login_completion(
                &pending.client,
                &pending.codex_home,
                &pending.login_id,
                &mut rx,
                Duration::from_secs(300),
            )
            .await
            {
                Ok(acct) => {
                    let message = match acct.email.as_deref() {
                        Some(email) => {
                            format!("Codex app-server ChatGPT sign-in completed for {email}.")
                        }
                        None => "Codex app-server ChatGPT sign-in completed.".to_owned(),
                    };
                    return Ok(json!({
                        "event": {
                            "type": "provider_auth_result",
                            "sessionId": session_id,
                            "provider": provider.as_str(),
                            "methodId": method_id,
                            "ok": true,
                            "mode": "oauth",
                            "message": message,
                        }
                    }));
                }
                Err(err) => {
                    return Ok(json!({
                        "event": {
                            "type": "provider_auth_result",
                            "sessionId": session_id,
                            "provider": provider.as_str(),
                            "methodId": method_id,
                            "ok": false,
                            "message": err.message,
                        }
                    }));
                }
            }
        }

        Ok(json!({
            "event": {
                "type": "provider_auth_result",
                "sessionId": session_id,
                "provider": provider.as_str(),
                "methodId": method_id,
                "ok": false,
                "message": "No active OAuth challenge found. Call cowork/provider/auth/authorize first.",
            }
        }))
    }

    pub async fn handle_provider_auth_logout(
        &self,
        params: &ProviderAuthLogoutParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/auth/logout")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        if paths.connections_file.is_file() {
            remove_provider_connection(&paths, provider)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;
        }

        if provider == ProviderName::CodexCli {
            self.pending_codex_logins.retain(|(p, _), _| *p != provider);
            let codex_home = resolve_codex_home(&paths.root_dir);
            let active_client = match self.codex_pool.first_active_for_home(&codex_home).await {
                Some(client) => Some(client),
                None if codex_home.join("auth.json").is_file() => self
                    .codex_pool
                    .get_or_spawn(&cwd, &paths.root_dir, &self.env)
                    .await
                    .ok(),
                None => None,
            };
            let _ = logout_codex_account(&codex_home, active_client.as_deref()).await;
            self.codex_pool.close_for_home(&codex_home).await;
        }

        let session_id = self.get_or_create_workspace_state_id(&cwd);
        Ok(json!({
            "event": {
                "type": "provider_auth_result",
                "sessionId": session_id,
                "provider": provider.as_str(),
                "methodId": "logout",
                "ok": true,
                "message": format!("Disconnected {}.", cowork_providers::provider_display_label(provider)),
            }
        }))
    }

    pub async fn handle_provider_auth_set_api_key(
        &self,
        params: &ProviderAuthSetApiKeyParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/auth/setApiKey")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        if params.api_key.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "apiKey must have length >= 1",
            ));
        }

        let method_id = match params.method_id.as_deref() {
            None => "api_key",
            Some(raw) => {
                let t = raw.trim();
                if t.is_empty() {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_PARAMS,
                        "methodId must not be empty",
                    ));
                }
                t
            }
        };

        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let trimmed_key = params.api_key.trim();
        if trimmed_key.is_empty() {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "ok": false,
                    "message": "API key is required.",
                }
            }));
        }

        let Some(method_spec) = cowork_providers::resolve_provider_auth_method(provider, method_id)
        else {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "ok": false,
                    "message": format!("Unsupported auth method \"{method_id}\"."),
                }
            }));
        };

        if method_spec.method_type != "api"
            || method_spec.fields.as_deref().is_some_and(|f| !f.is_empty())
        {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "ok": false,
                    "message": format!("Method \"{method_id}\" requires structured credentials via setConfig."),
                }
            }));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);

        if provider == ProviderName::Google
            && (method_id == "exa_api_key" || method_id == "parallel_api_key")
        {
            let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);
            let paths_clone = paths.clone();
            let method_owned = method_id.to_owned();
            let key_owned = trimmed_key.to_owned();
            with_file_lock(
                &paths.connections_file,
                || async move {
                    let mut store = read_connection_store_sync(&paths_clone)?;
                    let mut tool_keys = store.tool_api_keys.unwrap_or(ToolApiKeys {
                        exa: None,
                        parallel: None,
                    });
                    if method_owned == "exa_api_key" {
                        tool_keys.exa = Some(key_owned.clone());
                    } else {
                        tool_keys.parallel = Some(key_owned.clone());
                    }
                    store.tool_api_keys = Some(tool_keys);
                    store.updated_at =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    write_connection_store(&paths_clone, &store).await?;
                    Ok::<(), cowork_config::ConfigError>(())
                },
                FileLockOptions {
                    lock_root: Some(lock_root),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;

            let msg = if method_id == "exa_api_key" {
                "Exa API key saved for web search."
            } else {
                "Parallel API key saved for web search."
            };
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "ok": true,
                    "mode": "api_key",
                    "message": msg,
                }
            }));
        }

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        save_provider_connection(
            &paths,
            StoredConnection {
                service: provider,
                mode: ConnectionMode::ApiKey,
                method_id: Some(method_id.to_owned()),
                api_key: Some(trimmed_key.to_owned()),
                values: None,
                updated_at: now,
            },
        )
        .await
        .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;

        Ok(json!({
            "event": {
                "type": "provider_auth_result",
                "sessionId": session_id,
                "provider": provider.as_str(),
                "methodId": method_id,
                "ok": true,
                "mode": "api_key",
                "message": "Provider key saved.",
            }
        }))
    }

    pub async fn handle_provider_auth_set_config(
        &self,
        params: &ProviderAuthSetConfigParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/auth/setConfig")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        let method_id = params.method_id.trim();
        if method_id.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "methodId must not be empty",
            ));
        }

        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let Some(method_spec) = cowork_providers::resolve_provider_auth_method(provider, method_id)
        else {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": method_id,
                    "ok": false,
                    "message": format!("Unsupported auth method \"{method_id}\"."),
                }
            }));
        };

        let validated = match cowork_providers::validate_structured_provider_config(
            provider,
            &method_spec,
            &params.values,
        ) {
            Ok(v) => v,
            Err(message) => {
                return Ok(json!({
                    "event": {
                        "type": "provider_auth_result",
                        "sessionId": session_id,
                        "provider": provider.as_str(),
                        "methodId": method_id,
                        "ok": false,
                        "message": message,
                    }
                }));
            }
        };

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        save_provider_connection(
            &paths,
            StoredConnection {
                service: provider,
                mode: ConnectionMode::Credentials,
                method_id: Some(method_id.to_owned()),
                api_key: None,
                values: Some(validated),
                updated_at: now,
            },
        )
        .await
        .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;

        Ok(json!({
            "event": {
                "type": "provider_auth_result",
                "sessionId": session_id,
                "provider": provider.as_str(),
                "methodId": method_id,
                "ok": true,
                "mode": "credentials",
                "message": "Provider credentials saved.",
            }
        }))
    }

    pub async fn handle_provider_auth_copy_api_key(
        &self,
        params: &ProviderAuthCopyApiKeyParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/auth/copyApiKey")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        let source_provider = parse_provider_param(&params.source_provider)?;

        if !is_opencode_sibling_pair(provider, source_provider) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "provider_auth_copy_api_key only supports copying between OpenCode Go and OpenCode Zen.",
            ));
        }

        let session_id = self.get_or_create_workspace_state_id(&cwd);
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let store = read_connection_store(&paths)
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;

        if store
            .services
            .get(&provider)
            .and_then(|c| c.api_key.as_deref())
            .is_some_and(|k| !k.trim().is_empty())
        {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": "api_key",
                    "ok": false,
                    "message": format!("{} already has a saved API key.", provider.as_str()),
                }
            }));
        }

        let Some(src_key) = store
            .services
            .get(&source_provider)
            .and_then(|c| c.api_key.as_deref())
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned)
        else {
            return Ok(json!({
                "event": {
                    "type": "provider_auth_result",
                    "sessionId": session_id,
                    "provider": provider.as_str(),
                    "methodId": "api_key",
                    "ok": false,
                    "message": format!("No saved API key found for {}.", source_provider.as_str()),
                }
            }));
        };

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        save_provider_connection(
            &paths,
            StoredConnection {
                service: provider,
                mode: ConnectionMode::ApiKey,
                method_id: Some("api_key".to_owned()),
                api_key: Some(src_key),
                values: None,
                updated_at: now,
            },
        )
        .await
        .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.to_string()))?;

        Ok(json!({
            "event": {
                "type": "provider_auth_result",
                "sessionId": session_id,
                "provider": provider.as_str(),
                "methodId": "api_key",
                "ok": true,
                "mode": "api_key",
                "message": format!("Copied API key from {} to {}.", source_provider.as_str(), provider.as_str()),
            }
        }))
    }

    pub async fn handle_provider_custom_model_add(
        &self,
        params: &ProviderCustomModelAddParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/customModel/add")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        if params.model_id.trim().is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "modelId must not be empty",
            ));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        upsert_custom_model(&paths, provider, &params.model_id)
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.to_string()))?;

        let event = self.read_provider_catalog(&cwd, false).await;
        Ok(json!({ "event": event }))
    }

    pub async fn handle_provider_custom_model_delete(
        &self,
        params: &ProviderCustomModelDeleteParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/customModel/delete")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        if params.model_id.trim().is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "modelId must not be empty",
            ));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        delete_custom_model(&paths, provider, &params.model_id)
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.to_string()))?;

        let event = self.read_provider_catalog(&cwd, false).await;
        Ok(json!({ "event": event }))
    }

    pub async fn handle_provider_model_set_enabled(
        &self,
        params: &ProviderModelSetEnabledParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/model/setEnabled")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        if params.models.is_empty() || params.models.iter().any(|m| m.id.trim().is_empty()) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "models must be a non-empty array with non-empty model IDs",
            ));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let patches: Vec<ModelPreferenceUpdate> = params
            .models
            .iter()
            .map(|m| ModelPreferenceUpdate {
                id: m.id.clone(),
                enabled: m.enabled,
            })
            .collect();
        set_model_preferences(&paths, provider, &patches)
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.to_string()))?;

        let event = self.read_provider_catalog(&cwd, false).await;
        Ok(json!({ "event": event }))
    }

    pub async fn handle_provider_model_reset_enabled(
        &self,
        params: &ProviderModelResetEnabledParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/provider/model/resetEnabled")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let provider = parse_provider_param(&params.provider)?;
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        reset_model_preferences(&paths, provider)
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, e.to_string()))?;

        let event = self.read_provider_catalog(&cwd, false).await;
        Ok(json!({ "event": event }))
    }

    fn is_openai_native_connectors_enabled(&self, cwd: &Path) -> bool {
        if let Some(flag) = self.env.get("COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS") {
            let norm = flag.trim().to_ascii_lowercase();
            if matches!(norm.as_str(), "1" | "true" | "yes" | "on") {
                return true;
            }
            if matches!(norm.as_str(), "0" | "false" | "no" | "off") {
                return false;
            }
        }
        self.load_workspace_config(cwd)
            .ok()
            .and_then(|cfg| serde_json::to_value(cfg.experimental_features).ok())
            .and_then(|v| v.get("openAiNativeConnectors").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    pub async fn handle_connectors_openai_native_list(
        &self,
        cwd_raw: Option<&str>,
        force_refetch: bool,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(cwd_raw, "cowork/connectors/openai-native/list")
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let session_id = self.get_or_create_workspace_state_id(&cwd);

        if !self.is_openai_native_connectors_enabled(&cwd) {
            return Ok(json!({
                "event": {
                    "type": "openai_native_connectors",
                    "sessionId": session_id,
                    "authenticated": false,
                    "connectors": [],
                    "enabledConnectorIds": [],
                    "message": "OpenAI native connectors are disabled.",
                }
            }));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let codex_home = resolve_codex_home(&paths.root_dir);
        let status = resolve_codex_app_server_status(&paths.root_dir, &self.env);
        let event = if status.available {
            let client = self
                .codex_pool
                .get_or_spawn(&cwd, &paths.root_dir, &self.env)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.message))?;
            read_openai_native_connectors(&session_id, &codex_home, Some(&client), force_refetch)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.message))?
        } else {
            read_openai_native_connectors(&session_id, &codex_home, None, force_refetch)
                .await
                .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.message))?
        };

        Ok(json!({ "event": event }))
    }

    pub async fn handle_connectors_openai_native_set_enabled(
        &self,
        params: &ConnectorsOpenAiNativeSetEnabledParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let cwd = self
            .resolve_workspace_path(
                params.cwd.as_deref(),
                "cowork/connectors/openai-native/setEnabled",
            )
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let connector_id = params.connector_id.trim();
        if connector_id.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "connectorId must not be empty",
            ));
        }

        let session_id = self.get_or_create_workspace_state_id(&cwd);
        if !self.is_openai_native_connectors_enabled(&cwd) {
            return Ok(json!({
                "event": {
                    "type": "openai_native_connectors",
                    "sessionId": session_id,
                    "authenticated": false,
                    "connectors": [],
                    "enabledConnectorIds": [],
                    "message": "OpenAI native connectors are disabled.",
                }
            }));
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let codex_home = resolve_codex_home(&paths.root_dir);
        let client = self
            .codex_pool
            .get_or_spawn(&cwd, &paths.root_dir, &self.env)
            .await
            .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.message))?;
        let event = set_openai_native_connector_enabled(
            &session_id,
            &codex_home,
            &client,
            connector_id,
            params.enabled,
        )
        .await
        .map_err(|e| JsonRpcLiteError::new(error_codes::INTERNAL_ERROR, e.message))?;

        Ok(json!({ "event": event }))
    }
}
