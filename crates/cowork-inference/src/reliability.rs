use std::collections::HashMap;
use std::future::Future;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use rand::Rng;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use cowork_config::ProviderName;

use crate::error::InferenceError;
use crate::stream::StreamEvent;

/// Per-HTTP-attempt timeout in seconds (pi `timeoutMs`). Like the provider SDKs pi passes it to,
/// it bounds only connect + response headers; it never caps the streamed response body, which is
/// bounded solely by the step budget (`requestBudget.ts` parity).
pub const DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS: u64 = 120;

/// Overall single model-step wall-clock budget in seconds (pi `stepTimeoutMs`), shared by every
/// attempt, the whole streamed response, and retry backoff.
pub const DEFAULT_MODEL_STEP_BUDGET_SECS: u64 = 300;

/// Default total attempts per model step (initial attempt + 3 retries).
pub const RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS: usize = 4;

/// Default initial backoff delay in milliseconds before equal jitter.
pub const RATE_LIMIT_RETRY_BASE_DELAY_MS: u64 = 2_000;

/// Upper bound on any single retry backoff sleep in milliseconds.
pub const RATE_LIMIT_RETRY_MAX_DELAY_MS: u64 = 60_000;

/// Request & retry budget policy (`requestBudget.ts` + `rateLimitRetry.ts` parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPolicy {
    pub timeout_ms: u64,
    pub step_timeout_ms: u64,
    pub max_attempts: usize,
    pub base_delay_ms: u64,
    pub max_retry_delay_ms: u64,
}

impl Default for RequestPolicy {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS * 1_000,
            step_timeout_ms: DEFAULT_MODEL_STEP_BUDGET_SECS * 1_000,
            max_attempts: RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS,
            base_delay_ms: RATE_LIMIT_RETRY_BASE_DELAY_MS,
            max_retry_delay_ms: RATE_LIMIT_RETRY_MAX_DELAY_MS,
        }
    }
}

impl RequestPolicy {
    /// Resolves a policy from a provider options section, defaulting to `RequestPolicy::default()`.
    pub fn from_options(options: &Map<String, Value>) -> Result<Self, InferenceError> {
        Self::from_options_with_fallback(options, &Self::default())
    }

    /// `resolvePiRequestPolicy` parity: explicit values are validated and fail closed (durations
    /// cannot disable deadlines; `maxRetries` must be exactly `0` because Cowork owns retries and
    /// SDK-level retries must not multiply its attempt count). Absent values use `fallback`.
    /// Bounds: `timeoutMs` 1..=600000, `stepTimeoutMs` 1..=1800000, `maxRetryDelayMs` 0..=60000.
    /// The resolved `timeout_ms` never exceeds `step_timeout_ms`.
    pub fn from_options_with_fallback(
        options: &Map<String, Value>,
        fallback: &Self,
    ) -> Result<Self, InferenceError> {
        let timeout_ms = bounded_u64(
            "timeoutMs",
            options.get("timeoutMs"),
            fallback.timeout_ms,
            1,
            600_000,
        )?;
        let step_timeout_ms = bounded_u64(
            "stepTimeoutMs",
            options.get("stepTimeoutMs"),
            fallback.step_timeout_ms,
            1,
            1_800_000,
        )?;
        let max_retry_delay_ms = bounded_u64(
            "maxRetryDelayMs",
            options.get("maxRetryDelayMs"),
            fallback.max_retry_delay_ms,
            0,
            60_000,
        )?;
        bounded_u64("maxRetries", options.get("maxRetries"), 0, 0, 0)?;

        Ok(Self {
            timeout_ms: timeout_ms.min(step_timeout_ms),
            step_timeout_ms,
            max_attempts: fallback.max_attempts,
            base_delay_ms: fallback.base_delay_ms,
            max_retry_delay_ms,
        })
    }

    /// Resolves the policy for `provider` from the full `providerOptions` map, reading only that
    /// provider's section (`providerSectionForPi` parity: `google` falls back to `vertex`).
    pub fn for_provider(
        provider: ProviderName,
        provider_options: &Map<String, Value>,
        fallback: &Self,
    ) -> Result<Self, InferenceError> {
        let section = match provider {
            ProviderName::Google => provider_options
                .get("google")
                .and_then(Value::as_object)
                .or_else(|| provider_options.get("vertex").and_then(Value::as_object)),
            other => provider_options
                .get(other.as_str())
                .and_then(Value::as_object),
        };
        match section {
            Some(section) => Self::from_options_with_fallback(section, fallback),
            None => Self::from_options_with_fallback(&Map::new(), fallback),
        }
    }
}

fn bounded_u64(
    name: &str,
    raw: Option<&Value>,
    fallback: u64,
    min: u64,
    max: u64,
) -> Result<u64, InferenceError> {
    let Some(val) = raw else {
        return Ok(fallback);
    };
    let Some(num) = val.as_u64() else {
        return Err(InferenceError::InvalidPolicy(format!(
            "{name} must be an integer between {min} and {max}."
        )));
    };
    if num < min || num > max {
        return Err(InferenceError::InvalidPolicy(format!(
            "{name} must be an integer between {min} and {max}."
        )));
    }
    Ok(num)
}

/// Transport-level error structured for retry classification, `Retry-After` inspection, and
/// provider fallback logic.
#[derive(Debug, Error, Clone)]
#[error("{message}")]
pub struct ProviderTransportError {
    pub status: Option<u16>,
    pub message: String,
    pub code: Option<String>,
    pub headers: HashMap<String, String>,
    pub is_network_transient: bool,
    pub is_timeout: bool,
    pub is_abort: bool,
}

impl ProviderTransportError {
    pub fn http(status: u16, message: impl Into<String>, headers: HashMap<String, String>) -> Self {
        let normalized_headers = headers
            .into_iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v))
            .collect();
        Self {
            status: Some(status),
            message: message.into(),
            code: None,
            headers: normalized_headers,
            is_network_transient: false,
            is_timeout: status == 408 || status == 504,
            is_abort: false,
        }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            code: None,
            headers: HashMap::new(),
            is_network_transient: true,
            is_timeout: false,
            is_abort: false,
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            code: Some("ETIMEDOUT".to_string()),
            headers: HashMap::new(),
            is_network_transient: true,
            is_timeout: true,
            is_abort: false,
        }
    }

    pub fn aborted(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            code: Some("ABORT_ERR".to_string()),
            headers: HashMap::new(),
            is_network_transient: false,
            is_timeout: false,
            is_abort: true,
        }
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            code: None,
            headers: HashMap::new(),
            is_network_transient: false,
            is_timeout: false,
            is_abort: false,
        }
    }

    /// Classifies whether this failure is eligible for pre-first-visible-token retry.
    pub fn is_retryable(&self) -> bool {
        if self.is_abort {
            return false;
        }
        if let Some(flag) = self.header_ci("x-should-retry") {
            if flag.eq_ignore_ascii_case("true") {
                return true;
            }
            if flag.eq_ignore_ascii_case("false") {
                return false;
            }
        }
        if let Some(status) = self.status {
            return status == 408
                || status == 409
                || status == 429
                || ((500..600).contains(&status) && status != 501);
        }
        if self.is_network_transient || self.is_timeout {
            return true;
        }
        is_rate_limit_or_transient_message(&self.message)
    }

    fn header_ci(&self, name: &str) -> Option<&str> {
        let lower = name.to_ascii_lowercase();
        self.headers
            .get(&lower)
            .or_else(|| {
                self.headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v)
            })
            .map(String::as_str)
    }
}

fn is_rate_limit_or_transient_message(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)resource[\s_-]?exhausted|rate[\s_-]?limit|too many requests|request limit|socket hang up|connection reset|network error|gateway timeout|service unavailable|temporarily unavailable|econnreset|etimedout|\b(?:408|429|500|502|503|504)\b",
        )
        .expect("valid retry regex")
    });
    re.is_match(text)
}

/// Parses `retry-after-ms` and `retry-after` (seconds or HTTP-date) headers, failing closed when
/// the server requests a delay exceeding `max_retry_delay_ms` (`provider-retry.js` parity).
pub fn parse_retry_after_ms(
    headers: &HashMap<String, String>,
    max_retry_delay_ms: u64,
) -> Result<Option<u64>, InferenceError> {
    let find_header = |target: &str| -> Option<&str> {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(target))
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    };

    if let Some(raw_ms) = find_header("retry-after-ms")
        && let Ok(parsed) = raw_ms.parse::<f64>()
        && parsed.is_finite()
    {
        let delay = parsed.max(0.0).ceil() as u64;
        return validate_server_retry_delay(delay, max_retry_delay_ms).map(Some);
    }

    if let Some(raw_ra) = find_header("retry-after") {
        if let Ok(seconds) = raw_ra.parse::<f64>()
            && seconds.is_finite()
        {
            let delay = (seconds.max(0.0) * 1_000.0).ceil() as u64;
            return validate_server_retry_delay(delay, max_retry_delay_ms).map(Some);
        }
        if let Ok(parsed_dt) = DateTime::parse_from_rfc2822(raw_ra) {
            let delta_ms = (parsed_dt.with_timezone(&Utc) - Utc::now()).num_milliseconds();
            let delay = delta_ms.max(0) as u64;
            return validate_server_retry_delay(delay, max_retry_delay_ms).map(Some);
        }
    }

    Ok(None)
}

fn validate_server_retry_delay(
    delay_ms: u64,
    max_retry_delay_ms: u64,
) -> Result<u64, InferenceError> {
    if max_retry_delay_ms > 0 && delay_ms > max_retry_delay_ms {
        return Err(InferenceError::RetryDelayExceeded(format!(
            "Server requested {}s retry delay (max: {}s).",
            delay_ms.div_ceil(1_000),
            max_retry_delay_ms.div_ceil(1_000)
        )));
    }
    Ok(delay_ms)
}

/// Computes retry sleep duration (`Retry-After` if present, else equal-jittered exponential
/// `[delay/2, delay)` capped at `max_delay_ms`).
pub fn compute_backoff_delay_ms(
    retry_number: usize,
    retry_after_ms: Option<u64>,
    base_delay_ms: u64,
    max_delay_ms: u64,
    random_unit: f64,
) -> u64 {
    if let Some(explicit) = retry_after_ms {
        return if max_delay_ms > 0 {
            explicit.min(max_delay_ms)
        } else {
            explicit
        };
    }
    let shift = retry_number.saturating_sub(1).min(20) as u32;
    let exp = base_delay_ms
        .saturating_mul(1u64 << shift)
        .min(max_delay_ms);
    let half = (exp as f64) / 2.0;
    let clamped_rand = random_unit.clamp(0.0, 0.999_999_999);
    (half + clamped_rand * half).floor() as u64
}

/// Shared wall-clock budget for a single model step across all HTTP attempts, the whole streamed
/// response, and backoff sleeps. Never resets between retries (`requestBudget.ts` parity).
///
/// An [`StepBudget::unbounded`] budget has no deadline and only observes caller cancellation; it is
/// for transports that run a whole agentic loop per step (the Codex app-server), which TS never
/// capped at the turn level.
#[derive(Debug, Clone)]
pub struct StepBudget {
    deadline: Option<Instant>,
    step_timeout_ms: u64,
    cancel_token: CancellationToken,
}

impl StepBudget {
    pub fn new(step_timeout_ms: u64, caller_cancel: Option<CancellationToken>) -> Self {
        let bounded_ms = step_timeout_ms.clamp(1, 1_800_000);
        let cancel_token = caller_cancel.unwrap_or_default();
        Self {
            deadline: Some(Instant::now() + Duration::from_millis(bounded_ms)),
            step_timeout_ms: bounded_ms,
            cancel_token,
        }
    }

    /// A budget with no deadline that only propagates caller cancellation.
    pub fn unbounded(caller_cancel: Option<CancellationToken>) -> Self {
        Self {
            deadline: None,
            step_timeout_ms: u64::MAX,
            cancel_token: caller_cancel.unwrap_or_default(),
        }
    }

    pub fn is_unbounded(&self) -> bool {
        self.deadline.is_none()
    }

    pub fn cancellation_token(&self) -> &CancellationToken {
        &self.cancel_token
    }

    /// Time left before the step deadline; `None` once it has passed. Unbounded budgets report
    /// `Duration::MAX`.
    pub fn remaining(&self) -> Option<Duration> {
        match self.deadline {
            None => Some(Duration::MAX),
            Some(deadline) => deadline.checked_duration_since(Instant::now()),
        }
    }

    /// Whether the step deadline has passed (never true for unbounded budgets).
    pub fn is_expired(&self) -> bool {
        self.remaining().is_none_or(|d| d.is_zero())
    }

    fn step_exceeded(&self) -> ProviderTransportError {
        ProviderTransportError::timeout(format!(
            "Model step exceeded {}ms budget.",
            self.step_timeout_ms
        ))
    }

    fn check_live(&self) -> Result<(), ProviderTransportError> {
        if self.cancel_token.is_cancelled() {
            return Err(ProviderTransportError::aborted("Model turn aborted."));
        }
        if self.is_expired() {
            return Err(self.step_exceeded());
        }
        Ok(())
    }

    /// Effective response-header timeout for one HTTP attempt: `min(http_timeout_ms, remaining)`.
    /// Transports apply it to connect + response headers only (see `cowork_providers::sse`); the
    /// streamed body is bounded by [`StepBudget::run`].
    pub fn attempt_timeout(
        &self,
        http_timeout_ms: u64,
    ) -> Result<Duration, ProviderTransportError> {
        self.check_live()?;
        let remaining = self.remaining().unwrap_or_default();
        Ok(remaining.min(Duration::from_millis(http_timeout_ms.max(1))))
    }

    /// Runs `fut` bounded only by the step deadline and caller cancellation
    /// (`requestBudget.run` parity). This is how a whole streamed attempt is bounded.
    pub async fn run<T, F>(&self, fut: F) -> Result<T, ProviderTransportError>
    where
        F: Future<Output = Result<T, ProviderTransportError>>,
    {
        self.check_live()?;
        let Some(deadline) = self.deadline else {
            return tokio::select! {
                biased;
                () = self.cancel_token.cancelled() => {
                    Err(ProviderTransportError::aborted("Model turn aborted."))
                }
                res = fut => res,
            };
        };
        tokio::select! {
            biased;
            () = self.cancel_token.cancelled() => {
                Err(ProviderTransportError::aborted("Model turn aborted."))
            }
            res = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), fut) => {
                res.unwrap_or_else(|_| Err(self.step_exceeded()))
            }
        }
    }

    /// Runs `fut` hard-capped at `min(timeout_ms, remaining)` plus caller cancellation. Only for
    /// operations that must complete *entirely* within `timeout_ms` (e.g. unary RPCs); never wrap
    /// a streamed model response in it — use [`StepBudget::run`].
    pub async fn run_attempt<T, F>(
        &self,
        timeout_ms: u64,
        fut: F,
    ) -> Result<T, ProviderTransportError>
    where
        F: Future<Output = Result<T, ProviderTransportError>>,
    {
        let timeout_dur = self.attempt_timeout(timeout_ms)?;
        tokio::select! {
            biased;
            () = self.cancel_token.cancelled() => {
                Err(ProviderTransportError::aborted("Model turn aborted."))
            }
            res = tokio::time::timeout(timeout_dur, fut) => {
                match res {
                    Ok(inner) => inner,
                    Err(_) if self.is_expired() => Err(self.step_exceeded()),
                    Err(_) => Err(ProviderTransportError::timeout(format!(
                        "Operation exceeded {timeout_ms}ms timeout."
                    ))),
                }
            }
        }
    }

    /// Sleeps for `delay` bounded by the step deadline and caller `CancellationToken`.
    pub async fn sleep(&self, delay: Duration) -> Result<(), ProviderTransportError> {
        self.check_live()?;
        let remaining = self.remaining().unwrap_or_default();
        if delay > remaining {
            // Wait only until deadline or cancellation, then fail with step timeout.
            tokio::select! {
                biased;
                () = self.cancel_token.cancelled() => {
                    return Err(ProviderTransportError::aborted("Model turn aborted."));
                }
                () = tokio::time::sleep(remaining) => {
                    return Err(self.step_exceeded());
                }
            }
        }
        tokio::select! {
            biased;
            () = self.cancel_token.cancelled() => {
                Err(ProviderTransportError::aborted("Model turn aborted."))
            }
            () = tokio::time::sleep(delay) => Ok(()),
        }
    }
}

/// Executes a streaming model step with jittered `Retry-After` backoff strictly **before** any
/// visible assistant output or tool side effect has been emitted. Each attempt (including its whole
/// streamed response) is bounded only by the shared step budget and caller cancellation; the
/// per-attempt `policy.timeout_ms` is a response-header timeout the transport applies itself.
pub async fn execute_step_with_pre_output_retry<T, F, Fut>(
    policy: &RequestPolicy,
    budget: &StepBudget,
    mut attempt_fn: F,
) -> Result<T, ProviderTransportError>
where
    F: FnMut(usize, Box<dyn FnMut(StreamEvent) + Send>) -> Fut,
    Fut: Future<Output = Result<T, ProviderTransportError>>,
{
    execute_step_with_sink(policy, budget, &mut |_| {}, &mut attempt_fn).await
}

/// Variant of `execute_step_with_pre_output_retry` forwarding emitted `StreamEvent`s to `sink`
/// in real time as frames arrive from the transport.
pub async fn execute_step_with_sink<T, S, F, Fut>(
    policy: &RequestPolicy,
    budget: &StepBudget,
    sink: &mut S,
    attempt_fn: &mut F,
) -> Result<T, ProviderTransportError>
where
    S: FnMut(StreamEvent) + ?Sized,
    F: FnMut(usize, Box<dyn FnMut(StreamEvent) + Send>) -> Fut,
    Fut: Future<Output = Result<T, ProviderTransportError>>,
{
    let max_attempts = policy.max_attempts.max(1);
    for attempt_no in 1..=max_attempts {
        let emitted_visible = std::sync::Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();

        let vis_flag = std::sync::Arc::clone(&emitted_visible);
        let emit_cb: Box<dyn FnMut(StreamEvent) + Send> = Box::new(move |ev: StreamEvent| {
            if ev.is_visible_output() {
                vis_flag.store(true, Ordering::SeqCst);
            }
            let _ = tx.send(ev);
        });

        let mut attempt_fut = std::pin::pin!(budget.run(attempt_fn(attempt_no, emit_cb)));
        let outcome = loop {
            tokio::select! {
                biased;
                Some(ev) = rx.recv() => {
                    sink(ev);
                }
                res = &mut attempt_fut => {
                    while let Ok(ev) = rx.try_recv() {
                        sink(ev);
                    }
                    break res;
                }
            }
        };

        match outcome {
            Ok(val) => return Ok(val),
            Err(err) => {
                let already_visible = emitted_visible.load(Ordering::SeqCst);
                if already_visible
                    || attempt_no >= max_attempts
                    || budget.cancellation_token().is_cancelled()
                    || budget.is_expired()
                    || !err.is_retryable()
                {
                    return Err(err);
                }

                let retry_after =
                    match parse_retry_after_ms(&err.headers, policy.max_retry_delay_ms) {
                        Ok(ms) => ms,
                        Err(exceeded) => {
                            return Err(ProviderTransportError::protocol(format!(
                                "{exceeded} {}",
                                err.message
                            )));
                        }
                    };
                let rand_unit: f64 = rand::rng().random_range(0.0..1.0);
                let sleep_ms = compute_backoff_delay_ms(
                    attempt_no,
                    retry_after,
                    policy.base_delay_ms,
                    policy.max_retry_delay_ms,
                    rand_unit,
                );
                budget.sleep(Duration::from_millis(sleep_ms)).await?;
            }
        }
    }

    Err(ProviderTransportError::protocol(
        "Model step exhausted all retry attempts.",
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn opts(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn for_provider_reads_only_the_provider_section_with_fallback_defaults() {
        let fallback = RequestPolicy {
            step_timeout_ms: 90_000,
            ..RequestPolicy::default()
        };
        let all = opts(json!({
            "openai": { "timeoutMs": 30_000, "stepTimeoutMs": 600_000 },
            "anthropic": { "maxRetryDelayMs": 5_000 },
            "vertex": { "stepTimeoutMs": 45_000 },
        }));

        let openai = RequestPolicy::for_provider(ProviderName::Openai, &all, &fallback).unwrap();
        assert_eq!(openai.timeout_ms, 30_000);
        assert_eq!(openai.step_timeout_ms, 600_000);
        assert_eq!(openai.max_attempts, RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS);

        // Absent keys fall back; the header timeout never exceeds the step budget.
        let anthropic =
            RequestPolicy::for_provider(ProviderName::Anthropic, &all, &fallback).unwrap();
        assert_eq!(anthropic.timeout_ms, 90_000);
        assert_eq!(anthropic.step_timeout_ms, 90_000);
        assert_eq!(anthropic.max_retry_delay_ms, 5_000);

        // `providerSectionForPi`: google falls back to the vertex section.
        let google = RequestPolicy::for_provider(ProviderName::Google, &all, &fallback).unwrap();
        assert_eq!(google.step_timeout_ms, 45_000);
        assert_eq!(google.timeout_ms, 45_000);

        let none = RequestPolicy::for_provider(ProviderName::Bedrock, &all, &fallback).unwrap();
        assert_eq!(
            none,
            RequestPolicy {
                timeout_ms: 90_000,
                ..fallback
            }
        );
        let defaults =
            RequestPolicy::for_provider(ProviderName::Bedrock, &all, &RequestPolicy::default())
                .unwrap();
        assert_eq!(defaults, RequestPolicy::default());
    }

    #[test]
    fn explicit_policy_values_fail_closed() {
        for bad in [
            json!({ "timeoutMs": 0 }),
            json!({ "timeoutMs": 600_001 }),
            json!({ "stepTimeoutMs": 1_800_001 }),
            json!({ "timeoutMs": "120000" }),
            json!({ "maxRetryDelayMs": 60_001 }),
            // Cowork owns retries: SDK-level retries must stay disabled.
            json!({ "maxRetries": 2 }),
        ] {
            assert!(
                RequestPolicy::from_options(&opts(bad.clone())).is_err(),
                "{bad}"
            );
        }
        assert!(RequestPolicy::from_options(&opts(json!({ "maxRetries": 0 }))).is_ok());
    }

    #[tokio::test]
    async fn run_bounds_only_by_the_step_deadline() {
        let budget = StepBudget::new(100, None);
        let err = budget
            .run(async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<_, ProviderTransportError>(())
            })
            .await
            .unwrap_err();
        assert!(err.is_timeout);
        assert!(err.message.contains("Model step exceeded 100ms budget"));
        assert!(budget.is_expired());
        // Once expired, nothing else starts.
        assert!(budget.attempt_timeout(1_000).is_err());
    }

    #[tokio::test]
    async fn unbounded_budget_never_times_out_but_observes_cancellation() {
        let cancel = CancellationToken::new();
        let budget = StepBudget::unbounded(Some(cancel.clone()));
        assert!(budget.is_unbounded());
        assert!(!budget.is_expired());
        // The response-header timeout still applies to individual HTTP attempts.
        assert_eq!(
            budget.attempt_timeout(250).unwrap(),
            Duration::from_millis(250)
        );
        let value = budget
            .run(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok::<_, ProviderTransportError>(7)
            })
            .await
            .unwrap();
        assert_eq!(value, 7);

        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            trigger.cancel();
        });
        let err = budget
            .run(std::future::pending::<Result<(), ProviderTransportError>>())
            .await
            .unwrap_err();
        assert!(err.is_abort);
    }

    #[tokio::test]
    async fn no_retry_once_the_step_budget_is_spent() {
        let policy = RequestPolicy {
            timeout_ms: 50,
            step_timeout_ms: 80,
            max_attempts: 4,
            base_delay_ms: 1,
            max_retry_delay_ms: 1,
        };
        let budget = StepBudget::new(policy.step_timeout_ms, None);
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&attempts);
        let err = execute_step_with_pre_output_retry(&policy, &budget, move |_n, _emit| {
            counter.fetch_add(1, Ordering::SeqCst);
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<_, ProviderTransportError>(())
            }
        })
        .await
        .unwrap_err();
        assert!(err.message.contains("Model step exceeded 80ms budget"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
