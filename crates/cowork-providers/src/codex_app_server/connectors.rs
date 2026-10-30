use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::Duration;

use cowork_config::{CachedModelDiscoveryModel, CachedModelReasoning};
use cowork_inference::ProviderTransportError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::codex_app_server::client::{CodexAppServerClient, CodexNotification};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatGptLoginChallenge {
    pub login_id: String,
    pub auth_url: String,
}

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

pub fn parse_codex_chatgpt_login_challenge(
    started: &Value,
) -> Result<CodexChatGptLoginChallenge, ProviderTransportError> {
    let auth_url = started
        .get("authUrl")
        .or_else(|| started.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ProviderTransportError::protocol("codex app-server did not return a ChatGPT login URL.")
        })?
        .to_string();
    let login_id = started
        .get("loginId")
        .or_else(|| started.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ProviderTransportError::protocol("codex app-server did not return a ChatGPT loginId.")
        })?
        .to_string();
    Ok(CodexChatGptLoginChallenge { login_id, auth_url })
}

pub async fn await_codex_chatgpt_login_completion(
    client: &CodexAppServerClient,
    codex_home: &Path,
    login_id: &str,
    notif_rx: &mut mpsc::UnboundedReceiver<CodexNotification>,
    timeout: Duration,
) -> Result<CodexAccountInfo, ProviderTransportError> {
    let wait_login = async {
        while let Some(notif) = notif_rx.recv().await {
            if notif.method != "account/login/completed" {
                continue;
            }
            if notif.params.get("loginId").and_then(Value::as_str) != Some(login_id) {
                continue;
            }
            if notif.params.get("success").and_then(Value::as_bool) != Some(true) {
                let err_msg = notif
                    .params
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Codex app-server login failed.");
                return Err(ProviderTransportError::protocol(err_msg.to_string()));
            }
            return Ok(());
        }
        Err(ProviderTransportError::protocol(
            "Codex client exited during authentication.",
        ))
    };

    match tokio::time::timeout(timeout, wait_login).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(ProviderTransportError::timeout(
                "Timed out waiting for Codex login completion.",
            ));
        }
    }

    let acct = read_codex_account(codex_home, Some(client), true).await?;
    if !acct.authenticated {
        return Err(ProviderTransportError::protocol(
            "Codex app-server login completed, but account/read reported unauthenticated.",
        ));
    }
    Ok(acct)
}

fn is_unknown_codex_method_error(err: &ProviderTransportError, method: &str) -> bool {
    let lower = err.message.to_ascii_lowercase();
    let method_lower = method.to_ascii_lowercase();
    lower.contains(&format!("unknown method: {method_lower}"))
        || lower.contains(&format!("method not found: {method_lower}"))
        || (lower.contains(&method_lower) && lower.contains("not found"))
        || (lower.contains(&method_lower) && lower.contains("unsupported"))
}

pub async fn logout_codex_account(
    codex_home: &Path,
    client: Option<&CodexAppServerClient>,
) -> Result<(), ProviderTransportError> {
    if let Some(c) = client
        && let Err(err) = c.request("account/logout", Some(json!({}))).await
        && is_unknown_codex_method_error(&err, "account/logout")
    {
        let _ = c.request("auth/revoke", Some(json!({}))).await;
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

    let explicit_app_enabled = |id: &str| -> Option<bool> {
        apps_cfg
            .and_then(|apps| apps.get(id))
            .and_then(|entry| entry.get("enabled"))
            .and_then(Value::as_bool)
    };
    let is_app_enabled = |id: &str| -> bool { explicit_app_enabled(id).unwrap_or(true) };

    let mut connectors_by_id: BTreeMap<String, OpenAiNativeConnectorInfo> = BTreeMap::new();

    let mut mcp_cursor: Option<String> = None;
    for _ in 0..20 {
        let params = match &mcp_cursor {
            Some(cur) => json!({ "cursor": cur }),
            None => json!({}),
        };
        let Ok(mcp_res) = client.request("mcpServerStatus/list", Some(params)).await else {
            break;
        };
        if let Some(servers) = mcp_res.get("data").and_then(Value::as_array) {
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
        mcp_cursor = mcp_res
            .get("nextCursor")
            .or_else(|| mcp_res.get("next_cursor"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        if mcp_cursor.is_none() {
            break;
        }
    }

    if connectors_by_id.is_empty() {
        let mut app_cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &app_cursor {
                Some(cur) => json!({ "forceRefetch": force_refetch, "cursor": cur }),
                None => json!({ "forceRefetch": force_refetch }),
            };
            let Ok(app_res) = client.request("app/list", Some(params)).await else {
                break;
            };
            if let Some(apps) = app_res.get("data").and_then(Value::as_array) {
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
                            is_enabled: explicit_app_enabled(cid)
                                .or_else(|| app.get("isEnabled").and_then(Value::as_bool))
                                .unwrap_or(true),
                            auth_status: None,
                        },
                    );
                }
            }
            app_cursor = app_res
                .get("nextCursor")
                .or_else(|| app_res.get("next_cursor"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            if app_cursor.is_none() {
                break;
            }
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
                "mergeStrategy": "upsert"
            })),
        )
        .await?;

    read_openai_native_connectors(session_id, codex_home, Some(client), true).await
}

fn is_valid_reasoning_effort(raw: &str) -> bool {
    matches!(
        raw,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn normalize_codex_efforts(val: Option<&Value>) -> Option<Vec<String>> {
    let arr = val?.as_array()?;
    let mut out = Vec::new();
    for entry in arr {
        let candidate = entry
            .as_str()
            .or_else(|| {
                entry.as_object().and_then(|o| {
                    o.get("reasoningEffort")
                        .or_else(|| o.get("reasoning_effort"))
                        .and_then(Value::as_str)
                })
            })
            .map(str::trim)
            .map(str::to_ascii_lowercase);
        if let Some(norm) = candidate
            && is_valid_reasoning_effort(&norm)
            && !out.contains(&norm)
        {
            out.push(norm);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn normalize_codex_single_effort(val: Option<&Value>) -> Option<String> {
    let norm = val?.as_str()?.trim().to_ascii_lowercase();
    is_valid_reasoning_effort(&norm).then_some(norm)
}

fn normalize_codex_model(val: &Value) -> Option<CachedModelDiscoveryModel> {
    let obj = val.as_object()?;
    let id_field = obj
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let model_field = obj
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let canonical_id = model_field.or(id_field)?;

    let display_name = obj
        .get("displayName")
        .or_else(|| obj.get("display_name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(canonical_id)
        .to_string();
    let description = obj
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let supports_image_input = obj
        .get("supportsImageInput")
        .or_else(|| obj.get("supports_image_input"))
        .and_then(Value::as_bool);
    let is_default = (obj.get("isDefault").and_then(Value::as_bool) == Some(true)).then_some(true);

    let reasoning_obj = obj.get("reasoning").and_then(Value::as_object);
    let available_efforts = normalize_codex_efforts(obj.get("reasoningEfforts"))
        .or_else(|| normalize_codex_efforts(obj.get("reasoning_efforts")))
        .or_else(|| normalize_codex_efforts(obj.get("availableEfforts")))
        .or_else(|| normalize_codex_efforts(obj.get("available_efforts")))
        .or_else(|| normalize_codex_efforts(obj.get("supportedReasoningEfforts")))
        .or_else(|| normalize_codex_efforts(obj.get("supported_reasoning_efforts")))
        .or_else(|| normalize_codex_efforts(reasoning_obj.and_then(|r| r.get("availableEfforts"))))
        .or_else(|| normalize_codex_efforts(reasoning_obj.and_then(|r| r.get("available_efforts"))))
        .or_else(|| normalize_codex_efforts(reasoning_obj.and_then(|r| r.get("efforts"))));

    let default_effort = normalize_codex_single_effort(obj.get("reasoningDefaultEffort"))
        .or_else(|| normalize_codex_single_effort(obj.get("reasoning_default_effort")))
        .or_else(|| normalize_codex_single_effort(obj.get("defaultReasoningEffort")))
        .or_else(|| normalize_codex_single_effort(obj.get("default_reasoning_effort")))
        .or_else(|| {
            normalize_codex_single_effort(reasoning_obj.and_then(|r| r.get("defaultEffort")))
        })
        .or_else(|| {
            normalize_codex_single_effort(reasoning_obj.and_then(|r| r.get("default_effort")))
        })
        .or_else(|| normalize_codex_single_effort(reasoning_obj.and_then(|r| r.get("default"))))
        .or_else(|| {
            available_efforts
                .as_ref()
                .and_then(|effs| effs.first().cloned())
        });

    let reasoning = if available_efforts.is_some() || default_effort.is_some() {
        Some(CachedModelReasoning {
            default_effort,
            available_efforts,
        })
    } else {
        None
    };

    let first_non_empty_map = |keys: &[&str]| -> Option<Map<String, Value>> {
        for &k in keys {
            if let Some(m) = obj.get(k).and_then(Value::as_object)
                && !m.is_empty()
            {
                return Some(m.clone());
            }
        }
        None
    };

    let runtime_options = first_non_empty_map(&[
        "runtimeOptions",
        "runtime_options",
        "codexOptions",
        "codex_options",
        "options",
    ]);
    let runtime_overrides = first_non_empty_map(&[
        "runtimeOverrides",
        "runtime_overrides",
        "codexOverrides",
        "codex_overrides",
        "overrides",
    ]);

    Some(CachedModelDiscoveryModel {
        id: canonical_id.to_string(),
        model: Some(model_field.unwrap_or(canonical_id).to_string()),
        display_name,
        description,
        knowledge_cutoff: None,
        supports_image_input,
        is_default,
        reasoning,
        runtime_options,
        runtime_overrides,
    })
}

pub async fn list_codex_models(
    client: &CodexAppServerClient,
    timeout: Duration,
) -> Result<Vec<CachedModelDiscoveryModel>, ProviderTransportError> {
    let mut out: Vec<CachedModelDiscoveryModel> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut cursor: Option<String> = None;

    for _ in 0..20 {
        let mut params = Map::new();
        params.insert("limit".into(), json!(100));
        if let Some(cur) = &cursor {
            params.insert("cursor".into(), Value::String(cur.clone()));
        }
        let res = client
            .request_with_timeout("model/list", Some(Value::Object(params)), timeout)
            .await?;
        let items = res
            .get("data")
            .or_else(|| res.get("items"))
            .and_then(Value::as_array);
        if let Some(arr) = items {
            for item in arr {
                if let Some(normalized) = normalize_codex_model(item)
                    && seen.insert(normalized.id.clone())
                {
                    out.push(normalized);
                }
            }
        }
        cursor = res
            .get("nextCursor")
            .or_else(|| res.get("next_cursor"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        if cursor.is_none() {
            break;
        }
    }

    Ok(out)
}
