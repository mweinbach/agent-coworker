use std::collections::HashMap;
use std::time::Duration;

use cowork_config::CachedModelDiscoveryModel;
use cowork_inference::ProviderTransportError;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::bedrock::auth::{BedrockAuthConfig, BedrockAuthMethod, sign_bedrock_request};

const DISCOVERY_TIMEOUT_SECS: u64 = 10;

pub fn compute_bedrock_auth_fingerprint(auth: &BedrockAuthConfig) -> String {
    let mut hasher = Sha256::new();
    hasher.update(auth.method_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(auth.source.as_bytes());
    hasher.update(b"\n");
    hasher.update(auth.region.as_bytes());
    hasher.update(b"\n");
    match &auth.auth {
        BedrockAuthMethod::BearerToken { token } => {
            hasher.update(b"bearer\n");
            hasher.update(token.as_bytes());
            hasher.update(b"\n");
        }
        BedrockAuthMethod::SigV4 {
            access_key_id,
            session_token,
            ..
        } => {
            hasher.update(access_key_id.as_bytes());
            hasher.update(b"\n");
            hasher.update(if session_token.is_some() {
                &b"session\n"[..]
            } else {
                &b"nosession\n"[..]
            });
        }
    }
    hex::encode(hasher.finalize())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundationModelsResponse {
    #[serde(default)]
    model_summaries: Vec<FoundationModelSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundationModelSummary {
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    model_arn: Option<String>,
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    response_streaming_supported: Option<bool>,
    #[serde(default)]
    input_modalities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceProfilesResponse {
    #[serde(default)]
    inference_profile_summaries: Vec<InferenceProfileSummary>,
    #[serde(default)]
    next_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceProfileModelRef {
    #[serde(default)]
    model_arn: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceProfileSummary {
    #[serde(default)]
    inference_profile_id: Option<String>,
    #[serde(default)]
    inference_profile_name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    models: Vec<InferenceProfileModelRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomDeploymentsResponse {
    #[serde(default)]
    model_deployment_summaries: Vec<CustomDeploymentSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomDeploymentSummary {
    #[serde(default)]
    custom_model_deployment_arn: Option<String>,
    #[serde(default)]
    custom_model_deployment_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionedModelsResponse {
    #[serde(default)]
    provisioned_model_summaries: Vec<ProvisionedModelSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionedModelSummary {
    #[serde(default)]
    provisioned_model_arn: Option<String>,
    #[serde(default)]
    provisioned_model_name: Option<String>,
    #[serde(default)]
    foundation_model_arn: Option<String>,
    #[serde(default)]
    model_arn: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedModelsResponse {
    #[serde(default)]
    model_summaries: Vec<ImportedModelSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedModelSummary {
    #[serde(default)]
    model_arn: Option<String>,
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    instruct_supported: Option<bool>,
}

fn foundation_id_from_arn(arn: &str) -> Option<&str> {
    let marker = ":foundation-model/";
    let idx = arn.find(marker)?;
    Some(&arn[idx + marker.len()..])
}

async fn signed_get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    auth: &BedrockAuthConfig,
) -> Result<T, ProviderTransportError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    sign_bedrock_request("GET", url, &mut headers, &[], auth)?;

    let resp = client
        .get(url)
        .headers(headers)
        .timeout(Duration::from_secs(DISCOVERY_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|err| {
            ProviderTransportError::network(format!(
                "Bedrock control-plane GET {url} failed: {err}"
            ))
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderTransportError::http(
            status.as_u16(),
            format!(
                "Bedrock discovery HTTP {}: {}",
                status.as_u16(),
                body.trim()
            ),
            HashMap::new(),
        ));
    }

    resp.json::<T>().await.map_err(|err| {
        ProviderTransportError::protocol(format!(
            "Invalid Bedrock control-plane JSON from {url}: {err}"
        ))
    })
}

pub async fn discover_bedrock_models(
    client: &reqwest::Client,
    auth: &BedrockAuthConfig,
    control_plane_endpoint_override: Option<&str>,
) -> Result<Vec<CachedModelDiscoveryModel>, ProviderTransportError> {
    let base = control_plane_endpoint_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| format!("https://bedrock.{}.amazonaws.com", auth.region));

    let fm_resp: FoundationModelsResponse =
        signed_get_json(client, &format!("{base}/foundation-models"), auth).await?;

    let mut foundation_models = Vec::new();
    let mut lookup: HashMap<String, CachedModelDiscoveryModel> = HashMap::new();

    for summary in fm_resp.model_summaries {
        if summary.response_streaming_supported == Some(false) {
            continue;
        }
        let Some(id) = summary
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let display_name = summary
            .model_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&id)
            .to_string();
        let supports_image = summary
            .input_modalities
            .iter()
            .any(|m| m.eq_ignore_ascii_case("IMAGE"));

        let entry = CachedModelDiscoveryModel {
            id: id.clone(),
            model: None,
            display_name,
            description: None,
            knowledge_cutoff: Some("Unknown".to_string()),
            supports_image_input: Some(supports_image),
            is_default: None,
            reasoning: None,
            runtime_options: None,
            runtime_overrides: None,
        };
        lookup.insert(id, entry.clone());
        if let Some(arn) = summary
            .model_arn
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            lookup.insert(arn.to_string(), entry.clone());
        }
        foundation_models.push(entry);
    }

    let mut all_models = foundation_models;

    // Inference profiles (paginated up to 20 pages)
    let mut next_tok: Option<String> = None;
    for _ in 0..20 {
        let url = match &next_tok {
            Some(tok) => format!(
                "{base}/inference-profiles?maxResults=1000&nextToken={}",
                url::form_urlencoded::byte_serialize(tok.as_bytes()).collect::<String>()
            ),
            None => format!("{base}/inference-profiles?maxResults=1000"),
        };
        let Ok(resp) = signed_get_json::<InferenceProfilesResponse>(client, &url, auth).await
        else {
            break;
        };
        for prof in resp.inference_profile_summaries {
            if prof.status.as_deref() != Some("ACTIVE") {
                continue;
            }
            let Some(id) = prof
                .inference_profile_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let referenced: Vec<&CachedModelDiscoveryModel> = prof
                .models
                .iter()
                .filter_map(|m| {
                    let arn = m.model_arn.as_deref()?;
                    lookup
                        .get(arn)
                        .or_else(|| foundation_id_from_arn(arn).and_then(|fid| lookup.get(fid)))
                })
                .collect();
            if referenced.is_empty() {
                continue;
            }
            let supports_image = referenced
                .iter()
                .any(|e| e.supports_image_input == Some(true));
            let display_name = prof
                .inference_profile_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id)
                .to_string();
            all_models.push(CachedModelDiscoveryModel {
                id: id.to_string(),
                model: None,
                display_name,
                description: None,
                knowledge_cutoff: Some("Unknown".to_string()),
                supports_image_input: Some(supports_image),
                is_default: None,
                reasoning: None,
                runtime_options: None,
                runtime_overrides: None,
            });
        }
        next_tok = resp.next_token.filter(|s| !s.is_empty());
        if next_tok.is_none() {
            break;
        }
    }

    // Custom deployments (best-effort)
    if let Ok(cd_resp) = signed_get_json::<CustomDeploymentsResponse>(
        client,
        &format!("{base}/model-customization/custom-model-deployments?maxResults=1000&statusEquals=Active"),
        auth,
    )
    .await
    {
        for cd in cd_resp.model_deployment_summaries {
            if let Some(arn) = cd
                .custom_model_deployment_arn
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let name = cd
                    .custom_model_deployment_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(arn)
                    .to_string();
                all_models.push(CachedModelDiscoveryModel {
                    id: arn.to_string(),
                    model: None,
                    display_name: name,
                    description: None,
                    knowledge_cutoff: Some("Unknown".to_string()),
                    supports_image_input: Some(false),
                    is_default: None,
                    reasoning: None,
                    runtime_options: None,
                    runtime_overrides: None,
                });
            }
        }
    }

    // Provisioned model throughputs (best-effort)
    if let Ok(pm_resp) = signed_get_json::<ProvisionedModelsResponse>(
        client,
        &format!("{base}/provisioned-model-throughputs?maxResults=1000"),
        auth,
    )
    .await
    {
        for pm in pm_resp.provisioned_model_summaries {
            if pm.status.as_deref() != Some("InService") {
                continue;
            }
            let Some(arn) = pm
                .provisioned_model_arn
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let ref_entry = pm
                .foundation_model_arn
                .as_deref()
                .or(pm.model_arn.as_deref())
                .and_then(|f_arn| {
                    lookup
                        .get(f_arn)
                        .or_else(|| foundation_id_from_arn(f_arn).and_then(|fid| lookup.get(fid)))
                });
            let Some(ref_model) = ref_entry else {
                continue;
            };
            let name = pm
                .provisioned_model_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(arn)
                .to_string();
            all_models.push(CachedModelDiscoveryModel {
                id: arn.to_string(),
                model: None,
                display_name: name,
                description: None,
                knowledge_cutoff: Some("Unknown".to_string()),
                supports_image_input: ref_model.supports_image_input,
                is_default: None,
                reasoning: None,
                runtime_options: None,
                runtime_overrides: None,
            });
        }
    }

    // Imported models (best-effort)
    if let Ok(im_resp) = signed_get_json::<ImportedModelsResponse>(
        client,
        &format!("{base}/imported-models?maxResults=1000"),
        auth,
    )
    .await
    {
        for im in im_resp.model_summaries {
            if im.instruct_supported == Some(false) {
                continue;
            }
            if let Some(arn) = im
                .model_arn
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let name = im
                    .model_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(arn)
                    .to_string();
                all_models.push(CachedModelDiscoveryModel {
                    id: arn.to_string(),
                    model: None,
                    display_name: name,
                    description: None,
                    knowledge_cutoff: Some("Unknown".to_string()),
                    supports_image_input: Some(false),
                    is_default: None,
                    reasoning: None,
                    runtime_options: None,
                    runtime_overrides: None,
                });
            }
        }
    }

    let mut deduped: HashMap<String, CachedModelDiscoveryModel> = HashMap::new();
    for model in all_models {
        deduped.insert(model.id.clone(), model);
    }
    let mut sorted: Vec<CachedModelDiscoveryModel> = deduped.into_values().collect();
    sorted.sort_by(|a, b| {
        a.display_name
            .cmp(&b.display_name)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(sorted)
}
