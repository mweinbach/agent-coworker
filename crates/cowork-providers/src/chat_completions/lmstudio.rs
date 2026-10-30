use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::Utc;
use cowork_inference::ProviderTransportError;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::sse::build_http_client;

pub const DEFAULT_LM_STUDIO_BASE_URL: &str = "http://localhost:1234";
const MODEL_LIST_TIMEOUT_MS: u64 = 2_000;
const MODEL_MUTATION_TIMEOUT_MS: u64 = 120_000;
const START_DEFAULT_TIMEOUT_MS: u64 = 20_000;
const START_MAX_TIMEOUT_MS: u64 = 60_000;
const START_POLL_INTERVAL_MS: u64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LmStudioOptions {
    pub base_url: String,
    pub inference_base_url: String,
    pub api_base_url: String,
    pub api_key: Option<String>,
    pub context_length: Option<u64>,
    pub auto_load: bool,
    pub reload_on_context_mismatch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LmStudioLoadedInstance {
    pub id: String,
    #[serde(default)]
    pub config: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LmStudioCapabilities {
    #[serde(default)]
    pub vision: Option<bool>,
    #[serde(default)]
    pub trained_for_tool_use: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LmStudioModelInfo {
    #[serde(default)]
    pub key: String,
    #[serde(rename = "type", default)]
    pub model_type: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub max_context_length: Option<u64>,
    #[serde(default)]
    pub loaded_instances: Vec<LmStudioLoadedInstance>,
    #[serde(default)]
    pub vision: Option<bool>,
    #[serde(default)]
    pub capabilities: Option<LmStudioCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LmStudioLoadResult {
    #[serde(rename = "type", default)]
    pub model_type: Option<String>,
    pub instance_id: String,
    #[serde(default)]
    pub load_time_seconds: Option<f64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub load_config: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct LmStudioModelsEnvelope {
    #[serde(default)]
    models: Vec<LmStudioModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LmStudioLocalStatus {
    pub installed: bool,
    pub running: bool,
    pub base_url: String,
    pub can_auto_start: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LmStudioLocalStartResult {
    pub ok: bool,
    pub installed: bool,
    pub running: bool,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn normalize_lmstudio_base_url(raw: Option<&str>) -> String {
    let trimmed = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_LM_STUDIO_BASE_URL);
    let mut normalized = trimmed.trim_end_matches('/').to_string();
    if let Some(stripped) = normalized.strip_suffix("/api/v1") {
        normalized = stripped.to_string();
    } else if let Some(stripped) = normalized.strip_suffix("/v1") {
        normalized = stripped.to_string();
    }
    if normalized.is_empty() {
        DEFAULT_LM_STUDIO_BASE_URL.to_string()
    } else {
        normalized
    }
}

pub fn is_loopback_lmstudio_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

fn parse_bool_str(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

fn parse_positive_u64_val(val: Option<&Value>) -> Option<u64> {
    let v = val?;
    if let Some(n) = v.as_u64() {
        return (n > 0).then_some(n);
    }
    if let Some(f) = v.as_f64()
        && f.is_finite()
        && f >= 1.0
    {
        return Some(f.floor() as u64);
    }
    if let Some(s) = v.as_str()
        && let Ok(n) = s.trim().parse::<u64>()
    {
        return (n > 0).then_some(n);
    }
    None
}

fn parse_bool_val(val: Option<&Value>) -> Option<bool> {
    let v = val?;
    v.as_bool().or_else(|| v.as_str().and_then(parse_bool_str))
}

pub fn resolve_lmstudio_options(
    env: &HashMap<String, String>,
    provider_options: Option<&Map<String, Value>>,
    saved_api_key: Option<&str>,
) -> LmStudioOptions {
    let section = provider_options
        .and_then(|root| root.get("lmstudio"))
        .and_then(Value::as_object)
        .or(provider_options);

    let env_non_empty = |key: &str| -> Option<&str> {
        env.get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };

    let raw_base = env_non_empty("LM_STUDIO_BASE_URL").or_else(|| {
        section
            .and_then(|s| s.get("baseUrl"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    });
    let base_url = normalize_lmstudio_base_url(raw_base);

    let api_key = saved_api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| env_non_empty("LM_STUDIO_API_KEY"))
        .or_else(|| env_non_empty("LM_STUDIO_API_TOKEN"))
        .map(ToOwned::to_owned);

    let context_length = env_non_empty("LM_STUDIO_CONTEXT_LENGTH")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .or_else(|| parse_positive_u64_val(section.and_then(|s| s.get("contextLength"))));

    let auto_load = env_non_empty("LM_STUDIO_AUTO_LOAD")
        .and_then(parse_bool_str)
        .or_else(|| parse_bool_val(section.and_then(|s| s.get("autoLoad"))))
        .unwrap_or(true);

    let reload_on_context_mismatch = env_non_empty("LM_STUDIO_RELOAD_ON_CONTEXT_MISMATCH")
        .and_then(parse_bool_str)
        .or_else(|| parse_bool_val(section.and_then(|s| s.get("reloadOnContextMismatch"))))
        .unwrap_or(true);

    LmStudioOptions {
        inference_base_url: format!("{base_url}/v1"),
        api_base_url: format!("{base_url}/api/v1"),
        base_url,
        api_key,
        context_length,
        auto_load,
        reload_on_context_mismatch,
    }
}

#[derive(Debug, Clone)]
pub struct LmStudioControlClient {
    pub options: LmStudioOptions,
    client: reqwest::Client,
}

impl LmStudioControlClient {
    pub fn new(options: LmStudioOptions) -> Self {
        Self {
            options,
            client: build_http_client().expect("rustls HTTP client"),
        }
    }

    fn build_headers(&self) -> Result<HeaderMap, ProviderTransportError> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(token) = self
            .options
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let hv = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| {
                ProviderTransportError::protocol(format!("Invalid LM Studio API token: {e}"))
            })?;
            headers.insert(AUTHORIZATION, hv);
        }
        Ok(headers)
    }

    pub async fn list_native_models(
        &self,
    ) -> Result<Vec<LmStudioModelInfo>, ProviderTransportError> {
        let url = format!("{}/models", self.options.api_base_url);
        let resp = self
            .client
            .get(&url)
            .headers(self.build_headers()?)
            .timeout(Duration::from_millis(MODEL_LIST_TIMEOUT_MS))
            .send()
            .await
            .map_err(|err| {
                ProviderTransportError::network(format!(
                    "LM Studio server is unreachable at {}: {err}",
                    self.options.base_url
                ))
            })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderTransportError::http(
                status.as_u16(),
                format!(
                    "LM Studio request failed at {url} ({}): {}",
                    status.as_u16(),
                    body.trim()
                ),
                HashMap::new(),
            ));
        }

        let parsed: LmStudioModelsEnvelope = resp.json().await.map_err(|err| {
            ProviderTransportError::protocol(format!(
                "LM Studio returned invalid JSON from {url}: {err}"
            ))
        })?;

        let mut llms: Vec<LmStudioModelInfo> = parsed
            .models
            .into_iter()
            .filter(|m| m.model_type == "llm")
            .map(|mut m| {
                if m.vision.is_none() {
                    m.vision = m.capabilities.as_ref().and_then(|c| c.vision);
                }
                m
            })
            .collect();
        llms.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(llms)
    }

    pub async fn load_model(
        &self,
        model: &str,
        context_length: Option<u64>,
    ) -> Result<LmStudioLoadResult, ProviderTransportError> {
        let url = format!("{}/models/load", self.options.api_base_url);
        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(model.to_string()));
        if let Some(ctx) = context_length {
            body.insert("context_length".to_string(), json!(ctx));
        }
        body.insert("echo_load_config".to_string(), Value::Bool(true));

        let resp = self
            .client
            .post(&url)
            .headers(self.build_headers()?)
            .timeout(Duration::from_millis(MODEL_MUTATION_TIMEOUT_MS))
            .json(&Value::Object(body))
            .send()
            .await
            .map_err(|err| {
                ProviderTransportError::network(format!(
                    "LM Studio load failed at {}: {err}",
                    self.options.base_url
                ))
            })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderTransportError::http(
                status.as_u16(),
                format!(
                    "LM Studio model load failed ({}): {}",
                    status.as_u16(),
                    text.trim()
                ),
                HashMap::new(),
            ));
        }

        resp.json::<LmStudioLoadResult>().await.map_err(|err| {
            ProviderTransportError::protocol(format!("Invalid LM Studio load response: {err}"))
        })
    }

    pub async fn unload_instance(&self, instance_id: &str) -> Result<(), ProviderTransportError> {
        let url = format!("{}/models/unload", self.options.api_base_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.build_headers()?)
            .timeout(Duration::from_millis(MODEL_MUTATION_TIMEOUT_MS))
            .json(&json!({ "instance_id": instance_id }))
            .send()
            .await
            .map_err(|err| {
                ProviderTransportError::network(format!(
                    "LM Studio unload failed at {}: {err}",
                    self.options.base_url
                ))
            })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderTransportError::http(
                status.as_u16(),
                format!(
                    "LM Studio model unload failed ({}): {}",
                    status.as_u16(),
                    text.trim()
                ),
                HashMap::new(),
            ));
        }
        Ok(())
    }

    pub async fn prepare_model_for_inference(
        &self,
        model_key: &str,
    ) -> Result<LmStudioModelInfo, ProviderTransportError> {
        let trimmed = model_key.trim();
        let models = self.list_native_models().await?;
        let mut model = models
            .into_iter()
            .find(|m| m.key == trimmed)
            .ok_or_else(|| {
                ProviderTransportError::protocol(format!(
                    "LM Studio model \"{trimmed}\" is not available at {}.",
                    self.options.base_url
                ))
            })?;

        if model.loaded_instances.is_empty() {
            if self.options.auto_load {
                let loaded = self
                    .load_model(trimmed, self.options.context_length)
                    .await?;
                model.loaded_instances = vec![LmStudioLoadedInstance {
                    id: loaded.instance_id,
                    config: loaded.load_config,
                }];
            }
            return Ok(model);
        }

        if self.options.reload_on_context_mismatch
            && let Some(desired_ctx) = self.options.context_length
        {
            let mut sorted_instances = model.loaded_instances.clone();
            sorted_instances.sort_by(|a, b| a.id.cmp(&b.id));
            let active_ctx = sorted_instances
                .first()
                .and_then(|inst| inst.config.as_ref())
                .and_then(|cfg| cfg.get("context_length"))
                .and_then(Value::as_u64);
            if active_ctx != Some(desired_ctx) {
                for inst in &model.loaded_instances {
                    self.unload_instance(&inst.id).await?;
                }
                let loaded = self.load_model(trimmed, Some(desired_ctx)).await?;
                model.loaded_instances = vec![LmStudioLoadedInstance {
                    id: loaded.instance_id,
                    config: loaded.load_config,
                }];
            }
        }

        Ok(model)
    }
}

fn resolve_lms_cli_path(homedir: &Path) -> PathBuf {
    let bin_name = if cfg!(windows) { "lms.exe" } else { "lms" };
    homedir.join(".lmstudio").join("bin").join(bin_name)
}

fn extract_port_str(base_url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(base_url) {
        if let Some(port) = parsed.port() {
            return port.to_string();
        }
        if parsed.scheme() == "https" {
            return "443".to_string();
        }
    }
    "1234".to_string()
}

#[derive(Debug, Clone, Default)]
pub struct LmStudioLocalService;

impl LmStudioLocalService {
    pub fn new() -> Self {
        Self
    }

    async fn probe_running(&self, opts: &LmStudioOptions) -> (bool, Option<String>) {
        let client = LmStudioControlClient::new(opts.clone());
        let url = format!("{}/models", opts.inference_base_url);
        let headers = match client.build_headers() {
            Ok(h) => h,
            Err(err) => return (false, Some(err.message)),
        };
        match client
            .client
            .get(&url)
            .headers(headers)
            .timeout(Duration::from_millis(MODEL_LIST_TIMEOUT_MS))
            .send()
            .await
        {
            Ok(_) => (true, None),
            Err(err) => (
                false,
                Some(format!(
                    "LM Studio server is unreachable at {}: {err}",
                    opts.base_url
                )),
            ),
        }
    }

    pub async fn get_status(
        &self,
        homedir: &Path,
        env: &HashMap<String, String>,
        provider_options: Option<&Map<String, Value>>,
        explicit_base_url: Option<&str>,
    ) -> LmStudioLocalStatus {
        let mut opts = resolve_lmstudio_options(env, provider_options, None);
        if let Some(explicit) = explicit_base_url.filter(|s| !s.trim().is_empty()) {
            let base = normalize_lmstudio_base_url(Some(explicit));
            opts.inference_base_url = format!("{base}/v1");
            opts.api_base_url = format!("{base}/api/v1");
            opts.base_url = base;
        }

        let cli_path = resolve_lms_cli_path(homedir);
        let installed = cli_path.is_file();
        let (running, message) = self.probe_running(&opts).await;
        let can_auto_start = installed && is_loopback_lmstudio_url(&opts.base_url);

        LmStudioLocalStatus {
            installed,
            running,
            base_url: opts.base_url,
            can_auto_start,
            cli_path: installed.then(|| cli_path.to_string_lossy().into_owned()),
            message,
            checked_at: Utc::now().to_rfc3339(),
        }
    }

    pub async fn start_local(
        &self,
        homedir: &Path,
        env: &HashMap<String, String>,
        base_url: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> Result<LmStudioLocalStartResult, String> {
        let mut opts = resolve_lmstudio_options(env, None, None);
        if let Some(explicit) = base_url.filter(|s| !s.trim().is_empty()) {
            let normalized = normalize_lmstudio_base_url(Some(explicit));
            opts.inference_base_url = format!("{normalized}/v1");
            opts.api_base_url = format!("{normalized}/api/v1");
            opts.base_url = normalized;
        }

        if !is_loopback_lmstudio_url(&opts.base_url) {
            return Err(format!(
                "Cannot auto-start LM Studio for a non-local server ({}).",
                opts.base_url
            ));
        }

        let cli_path = resolve_lms_cli_path(homedir);
        let installed = cli_path.is_file();
        if !installed {
            return Ok(LmStudioLocalStartResult {
                ok: false,
                installed: false,
                running: false,
                base_url: opts.base_url,
                message: Some(format!(
                    "LM Studio CLI not found at {}. Install LM Studio from https://lmstudio.ai.",
                    cli_path.display()
                )),
            });
        }

        let (already_running, _) = self.probe_running(&opts).await;
        if already_running {
            return Ok(LmStudioLocalStartResult {
                ok: true,
                installed: true,
                running: true,
                base_url: opts.base_url,
                message: None,
            });
        }

        let bounded_timeout = timeout_ms
            .unwrap_or(START_DEFAULT_TIMEOUT_MS)
            .clamp(START_POLL_INTERVAL_MS, START_MAX_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(bounded_timeout);
        let port = extract_port_str(&opts.base_url);

        let mut cmd = tokio::process::Command::new(&cli_path);
        cmd.args(["server", "start", "--port", &port]);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.env_remove("COWORK_DESKTOP_PARENT_MANAGED");

        let mut child_opt = cmd.spawn().ok();

        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(START_POLL_INTERVAL_MS)).await;
            let (running, _) = self.probe_running(&opts).await;
            if running {
                return Ok(LmStudioLocalStartResult {
                    ok: true,
                    installed: true,
                    running: true,
                    base_url: opts.base_url,
                    message: None,
                });
            }
        }

        if let Some(mut child) = child_opt.take() {
            let _ = child.kill().await;
        }

        Ok(LmStudioLocalStartResult {
            ok: false,
            installed: true,
            running: false,
            base_url: opts.base_url.clone(),
            message: Some(format!(
                "LM Studio did not become reachable at {} within {}s.",
                opts.base_url,
                bounded_timeout.div_ceil(1000)
            )),
        })
    }
}
