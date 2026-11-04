use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::ast::CanonicalMessage;

/// Stored server-side continuation state (`previous_response_id`, `previous_interaction_id`, or
/// Codex CLI `thread_id`) guarded by a SHA-256 request fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "kebab-case")]
pub enum ProviderContinuationState {
    #[serde(rename = "openai")]
    OpenAi {
        model: String,
        #[serde(rename = "responseId")]
        response_id: String,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "requestFingerprint")]
        request_fingerprint: String,
    },
    #[serde(rename = "google")]
    Google {
        model: String,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "requestFingerprint")]
        request_fingerprint: String,
    },
    #[serde(rename = "codex-cli")]
    CodexCli {
        model: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "requestFingerprint")]
        request_fingerprint: Option<String>,
    },
}

impl ProviderContinuationState {
    pub fn provider_id(&self) -> &'static str {
        match self {
            Self::OpenAi { .. } => "openai",
            Self::Google { .. } => "google",
            Self::CodexCli { .. } => "codex-cli",
        }
    }

    pub fn model(&self) -> &str {
        match self {
            Self::OpenAi { model, .. }
            | Self::Google { model, .. }
            | Self::CodexCli { model, .. } => model.as_str(),
        }
    }

    pub fn request_fingerprint(&self) -> Option<&str> {
        match self {
            Self::OpenAi {
                request_fingerprint,
                ..
            }
            | Self::Google {
                request_fingerprint,
                ..
            } => Some(request_fingerprint.as_str()),
            Self::CodexCli {
                request_fingerprint,
                ..
            } => request_fingerprint.as_deref(),
        }
    }
}

/// Inputs covered by the deterministic SHA-256 continuation fingerprint.
#[derive(Debug, Clone)]
pub struct ContinuationFingerprintInput<'a> {
    pub provider: &'a str,
    pub model_id: &'a str,
    pub system_prompt: &'a str,
    pub tools: &'a [Value],
    pub authorized_tool_names: Option<&'a [String]>,
    pub canonical_prefix: &'a [CanonicalMessage],
    pub stream_options: &'a Map<String, Value>,
}

/// Computes a deterministic 64-char hex SHA-256 digest of the canonical request context,
/// excluding secrets (`apiKey`, `authorization`, `headers`) and transient signals (`signal`).
pub fn compute_continuation_fingerprint(input: &ContinuationFingerprintInput<'_>) -> String {
    let mut safe_options = Map::new();
    for (k, v) in input.stream_options {
        if matches!(
            k.as_str(),
            "apiKey" | "api_key" | "authorization" | "headers" | "signal" | "abortSignal"
        ) {
            continue;
        }
        safe_options.insert(k.clone(), v.clone());
    }

    let sorted_auth_tools = input.authorized_tool_names.map(|names| {
        let mut sorted: Vec<String> = names.to_vec();
        sorted.sort();
        sorted
    });

    let payload = json!({
        "provider": input.provider,
        "modelId": input.model_id,
        "system": input.system_prompt,
        "tools": input.tools,
        "authorizedToolNames": sorted_auth_tools,
        "canonicalPrefix": input.canonical_prefix,
        "streamOptions": safe_options,
    });

    let canonical_json = canonical_json_stringify(&payload);
    let digest = Sha256::digest(canonical_json.as_bytes());
    hex::encode(digest)
}

/// Validates whether a stored `ProviderContinuationState` may still be used for `(provider, model)`
/// and `current_fingerprint`. Any mismatch invalidates the server continuation token (`None`).
pub fn validate_continuation_state<'a>(
    state: Option<&'a ProviderContinuationState>,
    current_provider: &str,
    current_model: &str,
    current_fingerprint: &str,
) -> Option<&'a ProviderContinuationState> {
    let state = state?;
    if state.provider_id() != current_provider || state.model() != current_model {
        return None;
    }
    if let Some(stored_fp) = state.request_fingerprint()
        && stored_fp != current_fingerprint
    {
        return None;
    }
    Some(state)
}

fn canonical_json_stringify(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(canonical_json_stringify).collect();
            format!("[{}]", inner.join(","))
        }
        Value::Object(map) => {
            // `serde_json::Map` without `preserve_order` is already backed by `BTreeMap`,
            // and sorting keys explicitly guarantees stability regardless of feature flags.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let key_json = serde_json::to_string(k).unwrap_or_default();
                    let val_json = canonical_json_stringify(&map[k]);
                    format!("{key_json}:{val_json}")
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
    }
}
