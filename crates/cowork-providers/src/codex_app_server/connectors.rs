use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use cowork_inference::ProviderTransportError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::codex_app_server::client::CodexAppServerClient;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountInfo {
    pub authenticated: bool,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiNativeConnectorInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url_dark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution_channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
    pub is_accessible: bool,
    pub is_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiNativeConnectorsEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    pub authenticated: bool,
    pub connectors: Vec<OpenAiNativeConnectorInfo>,
    pub enabled_connector_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Reads Codex authentication status. Fast-paths without spawning `codex app-server` when
/// `<codex_home>/auth.json` is absent and no live client is passed.
pub async fn read_codex_account(
    codex_home: &Path,
    client: Option<&CodexAppServerClient>,
    refresh_token: bool,
) -> Result<CodexAccountInfo, ProviderTransportError> {
    let auth_file = codex_home.join("auth.json");
    let Some(client) = client else {
        if !auth_file.is_file() {
            return Ok(CodexAccountInfo {
                authenticated: false,
                email: None,
                plan_type: None,
                requires_openai_auth: true,
            });
        }
        // Parse local auth.json optimistically without blocking on child spawn
        let raw = std::fs::read_to_string(&auth_file).unwrap_or_default();
        let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let has_tokens = parsed.get("access_token").is_some()
            || parsed.get("tokens").is_some()
            || parsed.get("OPENAI_API_KEY").is_some();
        let email = parsed
            .get("email")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let plan_type = parsed
            .get("plan_type")
            .or_else(|| parsed.get("planType"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        return Ok(CodexAccountInfo {
            authenticated: has_tokens,
            email,
            plan_type,
            requires_openai_auth: !has_tokens,
        });
    };

    let res = client
        .request(
            "account/read",
            Some(json!({ "refreshToken": refresh_token })),
        )
        .await?;

    let account_obj = res.get("account").and_then(Value::as_object);
    let authenticated = account_obj.is_some();
    let email = account_obj
        .and_then(|a| a.get("email"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let plan_type = account_obj
        .and_then(|a| a.get("planType").or_else(|| a.get("plan_type")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let requires_openai_auth = res
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool)
        .unwrap_or(!authenticated);

    Ok(CodexAccountInfo {
        authenticated,
        email,
        plan_type,
        requires_openai_auth,
    })
}

pub async fn start_codex_chatgpt_login(
    client: &CodexAppServerClient,
) -> Result<Value, ProviderTransportError> {
    client
        .request("account/login/start", Some(json!({ "type": "chatgpt" })))
        .await
}

pub async fn logout_codex_account(
    codex_home: &Path,
    client: Option<&CodexAppServerClient>,
) -> Result<(), ProviderTransportError> {
    if let Some(c) = client {
        let _ = c.request("account/logout", Some(json!({}))).await;
    }
    let auth_file = codex_home.join("auth.json");
    if auth_file.exists() {
        let _ = std::fs::remove_file(auth_file);
    }
    Ok(())
}

pub async fn read_openai_native_connectors(
    session_id: &str,
    codex_home: &Path,
    client: Option<&CodexAppServerClient>,
    force_refetch: bool,
) -> Result<OpenAiNativeConnectorsEvent, ProviderTransportError> {
    let acct = read_codex_account(codex_home, client, false).await?;
    let Some(client) = client else {
        return Ok(OpenAiNativeConnectorsEvent {
            event_type: "openai_native_connectors".to_string(),
            session_id: session_id.to_string(),
            authenticated: acct.authenticated,
            connectors: Vec::new(),
            enabled_connector_ids: Vec::new(),
            message: (!acct.authenticated)
                .then(|| "Sign in with ChatGPT to load OpenAI native connectors.".to_string()),
        });
    };

    if !acct.authenticated {
        return Ok(OpenAiNativeConnectorsEvent {
            event_type: "openai_native_connectors".to_string(),
            session_id: session_id.to_string(),
            authenticated: false,
            connectors: Vec::new(),
            enabled_connector_ids: Vec::new(),
            message: Some("Sign in with ChatGPT to load OpenAI native connectors.".to_string()),
        });
    }

    let cfg_res = client
        .request("config/read", Some(json!({ "includeLayers": false })))
        .await
        .unwrap_or(Value::Null);
    let apps_cfg = cfg_res
        .get("config")
        .and_then(|c| c.get("apps"))
        .and_then(Value::as_object);

    let is_app_enabled = |id: &str| -> bool {
        apps_cfg
            .and_then(|apps| apps.get(id))
            .and_then(|entry| entry.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };

    let mut connectors_by_id: BTreeMap<String, OpenAiNativeConnectorInfo> = BTreeMap::new();

    if let Ok(mcp_res) = client
        .request("mcpServerStatus/list", Some(json!({})))
        .await
        && let Some(servers) = mcp_res.get("data").and_then(Value::as_array)
    {
        for srv in servers {
            let auth_status = srv
                .get("authStatus")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if let Some(tools_obj) = srv.get("tools").and_then(Value::as_object) {
                for tool_val in tools_obj.values() {
                    let meta = tool_val
                        .get("_meta")
                        .or_else(|| tool_val.get("meta"))
                        .and_then(Value::as_object);
                    let Some(meta) = meta else { continue };
                    let Some(cid) = meta
                        .get("connector_id")
                        .or_else(|| meta.get("connectorId"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let cname = meta
                        .get("connector_name")
                        .or_else(|| meta.get("connectorName"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(cid);
                    let cdesc = meta
                        .get("connector_description")
                        .or_else(|| meta.get("connectorDescription"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(ToOwned::to_owned);

                    connectors_by_id.entry(cid.to_string()).or_insert_with(|| {
                        OpenAiNativeConnectorInfo {
                            id: cid.to_string(),
                            name: cname.to_string(),
                            description: cdesc,
                            logo_url: None,
                            logo_url_dark: None,
                            distribution_channel: None,
                            install_url: None,
                            is_accessible: true,
                            is_enabled: is_app_enabled(cid),
                            auth_status: auth_status.clone(),
                        }
                    });
                }
            }
        }
    }

    if connectors_by_id.is_empty()
        && let Ok(app_res) = client
            .request("app/list", Some(json!({ "forceRefetch": force_refetch })))
            .await
        && let Some(apps) = app_res.get("data").and_then(Value::as_array)
    {
        for app in apps {
            let Some(cid) = app
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let cname = app
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(cid);
            connectors_by_id.insert(
                cid.to_string(),
                OpenAiNativeConnectorInfo {
                    id: cid.to_string(),
                    name: cname.to_string(),
                    description: app
                        .get("description")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    logo_url: app
                        .get("logoUrl")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    logo_url_dark: app
                        .get("logoUrlDark")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    distribution_channel: app
                        .get("distributionChannel")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    install_url: app
                        .get("installUrl")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    is_accessible: app
                        .get("isAccessible")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    is_enabled: app
                        .get("isEnabled")
                        .and_then(Value::as_bool)
                        .unwrap_or_else(|| is_app_enabled(cid)),
                    auth_status: None,
                },
            );
        }
    }

    let connectors: Vec<OpenAiNativeConnectorInfo> = connectors_by_id.into_values().collect();
    let enabled_set: HashSet<String> = connectors
        .iter()
        .filter(|c| c.is_enabled)
        .map(|c| c.id.clone())
        .collect();
    let mut enabled_connector_ids: Vec<String> = enabled_set.into_iter().collect();
    enabled_connector_ids.sort();

    Ok(OpenAiNativeConnectorsEvent {
        event_type: "openai_native_connectors".to_string(),
        session_id: session_id.to_string(),
        authenticated: true,
        connectors,
        enabled_connector_ids,
        message: None,
    })
}

pub async fn set_openai_native_connector_enabled(
    session_id: &str,
    codex_home: &Path,
    client: &CodexAppServerClient,
    connector_id: &str,
    enabled: bool,
) -> Result<OpenAiNativeConnectorsEvent, ProviderTransportError> {
    let trimmed = connector_id.trim();
    if trimmed.is_empty() {
        return Err(ProviderTransportError::protocol(
            "connectorId is required.".to_string(),
        ));
    }

    client
        .request(
            "config/value/write",
            Some(json!({
                "keyPath": format!("apps.{trimmed}.enabled"),
                "value": enabled,
                "mergeStrategy": "replace"
            })),
        )
        .await?;

    read_openai_native_connectors(session_id, codex_home, Some(client), true).await
}
