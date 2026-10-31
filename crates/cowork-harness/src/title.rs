use std::collections::HashMap;
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use cowork_storage::SessionTitleSource;
use regex::Regex;
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 60;

/// Returns the fast dedicated title model for a provider (`TITLE_MODELS_BY_PROVIDER` parity),
/// or `None` for local single-slot providers (`lmstudio`, `ollama`) that should not contend
/// with active turns.
pub fn preferred_title_model_for_provider(provider: ProviderName) -> Option<&'static str> {
    match provider {
        ProviderName::Anthropic => Some("claude-haiku-4-5"),
        ProviderName::Baseten => Some("moonshotai/Kimi-K2.5"),
        ProviderName::CodexCli => Some("gpt-5.4-mini"),
        ProviderName::Google => Some("gemini-3-flash-preview"),
        ProviderName::Nvidia => Some("nvidia/nemotron-3-super-120b-a12b"),
        ProviderName::Openai => Some("gpt-5-mini"),
        ProviderName::Together => Some("moonshotai/Kimi-K2.5"),
        ProviderName::Fireworks => Some("accounts/fireworks/models/kimi-k2p6"),
        ProviderName::Firepass => Some("accounts/fireworks/routers/kimi-k2p6-turbo"),
        ProviderName::OpencodeGo | ProviderName::OpencodeZen => Some("glm-5"),
        _ => None,
    }
}

/// Produces an immediate clean 3..8 word session title from the first user prompt,
/// stripping code blocks, inline markdown, and leading filler phrases.
pub fn generate_heuristic_session_title(first_user_text: &str) -> String {
    static FENCE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let fence_re =
        FENCE_RE.get_or_init(|| Regex::new(r"(?s)```.*?```").expect("valid fence regex"));

    let without_fences = fence_re.replace_all(first_user_text, " ");
    let first_non_empty = without_fences
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("[Attached "))
        .unwrap_or("New conversation");

    let cleaned: String = first_non_empty
        .trim_start_matches(['#', '*', '-', '>', '`', ' '])
        .replace(['`', '*', '_'], "")
        .split_whitespace()
        .take(9)
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.is_empty() {
        return "New conversation".to_owned();
    }
    if cleaned.chars().count() <= MAX_TITLE_CHARS {
        cleaned
    } else {
        let mut s: String = cleaned.chars().take(MAX_TITLE_CHARS - 1).collect();
        s.push('…');
        s
    }
}

pub struct RemoteTitleOptions {
    pub transport: Arc<dyn ProviderTransport>,
    pub model_id: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

/// Generates a concise session title via a lightweight background model call when available,
/// strictly respecting `SessionTitleSource::Manual` and falling back to heuristic on any failure.
pub async fn generate_remote_session_title(
    current_source: SessionTitleSource,
    current_title: &str,
    first_user_text: &str,
    remote: Option<RemoteTitleOptions>,
) -> (String, SessionTitleSource) {
    if current_source == SessionTitleSource::Manual {
        return (current_title.to_owned(), SessionTitleSource::Manual);
    }

    let heuristic = generate_heuristic_session_title(first_user_text);
    let Some(opts) = remote else {
        return (heuristic, SessionTitleSource::Heuristic);
    };

    let prompt_snippet: String = first_user_text.chars().take(600).collect();
    let req = ProviderStepRequest {
        model_id: opts.model_id,
        base_url: opts.base_url,
        api_key: opts.api_key,
        extra_headers: HashMap::new(),
        system_prompt: "Generate a concise 3 to 6 word title summarizing the user's request. Return ONLY the plain title text without quotes or trailing punctuation.".to_owned(),
        messages: vec![CanonicalMessage {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: prompt_snippet,
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }],
            phase: None,
            provider: None,
            api: None,
            model: None,
            stop_reason: None,
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: chrono::Utc::now().to_rfc3339(),
        }],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: Default::default(),
        continuation: None,
        policy: RequestPolicy {
            max_attempts: 1,
            timeout_ms: 15_000,
            ..RequestPolicy::default()
        },
        turn_id: format!("title_{}", Uuid::new_v4()),
    };

    let budget = StepBudget::new(15_000, None);
    let mut noop = |_ev| {};
    if let Ok(res) = opts.transport.stream_step(req, &budget, &mut noop).await {
        let candidate = res
            .assistant
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        let sanitized = candidate
            .trim()
            .trim_matches(['"', '\'', '.'])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !sanitized.is_empty() {
            let bounded = if sanitized.chars().count() <= MAX_TITLE_CHARS {
                sanitized
            } else {
                sanitized.chars().take(MAX_TITLE_CHARS).collect()
            };
            return (bounded, SessionTitleSource::Model);
        }
    }

    (heuristic, SessionTitleSource::Heuristic)
}
