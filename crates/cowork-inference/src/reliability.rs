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

use crate::error::InferenceError;
use crate::stream::StreamEvent;

/// Per-HTTP-attempt connection/first-byte/idle timeout in seconds.
pub const DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS: u64 = 120;

/// Overall single model-step wall-clock budget in seconds.
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
    pub fn from_options(options: &Map<String, Value>) -> Result<Self, InferenceError> {
        let timeout_ms = bounded_u64(
            "timeoutMs",
            options.get("timeoutMs"),
            DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS * 1_000,
            1,
            600_000,
        )?;
        let step_timeout_ms = bounded_u64(
            "stepTimeoutMs",
            options.get("stepTimeoutMs"),
            DEFAULT_MODEL_STEP_BUDGET_SECS * 1_000,
            1,
            1_800_000,
        )?;
        let max_retry_delay_ms = bounded_u64(
            "maxRetryDelayMs",
            options.get("maxRetryDelayMs"),
            RATE_LIMIT_RETRY_MAX_DELAY_MS,
            0,
            60_000,
        )?;
        let max_attempts = match options.get("maxRetries") {
            None => RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS,
            Some(v) => {
                let retries = v.as_u64().ok_or_else(|| {
                    InferenceError::InvalidPolicy(
                        "maxRetries must be a non-negative integer.".into(),
                    )
                })?;
                1 + (retries as usize).min(RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS - 1)
            }
        };

        Ok(Self {
            timeout_ms: timeout_ms.min(step_timeout_ms),
            step_timeout_ms,
            max_attempts,
            base_delay_ms: RATE_LIMIT_RETRY_BASE_DELAY_MS,
            max_retry_delay_ms,
        })
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

/// Shared wall-clock budget for a single model step across all HTTP attempts and backoff sleeps.
/// Never resets between retries (`requestBudget.ts` parity).
#[derive(Debug, Clone)]
pub struct StepBudget {
    deadline: Instant,
    step_timeout_ms: u64,
    cancel_token: CancellationToken,
}

impl StepBudget {
    pub fn new(step_timeout_ms: u64, caller_cancel: Option<CancellationToken>) -> Self {
        let bounded_ms = step_timeout_ms.clamp(1, 1_800_000);
        let cancel_token = caller_cancel.unwrap_or_default();
        Self {
            deadline: Instant::now() + Duration::from_millis(bounded_ms),
            step_timeout_ms: bounded_ms,
            cancel_token,
        }
    }

    pub fn cancellation_token(&self) -> &CancellationToken {
        &self.cancel_token
    }

    pub fn remaining(&self) -> Option<Duration> {
        self.deadline.checked_duration_since(Instant::now())
    }

    /// Computes the effective timeout for a single HTTP attempt (`min(http_timeout_ms, remaining)`).
    pub fn attempt_timeout(
        &self,
        http_timeout_ms: u64,
    ) -> Result<Duration, ProviderTransportError> {
        if self.cancel_token.is_cancelled() {
            return Err(ProviderTransportError::aborted("Model turn aborted."));
        }
        let Some(remaining) = self.remaining() else {
            return Err(ProviderTransportError::timeout(format!(
                "Model step exceeded {}ms budget.",
                self.step_timeout_ms
            )));
        };
        if remaining.is_zero() {
            return Err(ProviderTransportError::timeout(format!(
                "Model step exceeded {}ms budget.",
                self.step_timeout_ms
            )));
        }
        Ok(remaining.min(Duration::from_millis(http_timeout_ms.max(1))))
    }

    /// Runs `fut` bounded by both the per-attempt timeout, overall step deadline, and caller cancellation.
    pub async fn run_attempt<T, F>(
        &self,
        http_timeout_ms: u64,
        fut: F,
    ) -> Result<T, ProviderTransportError>
    where
        F: Future<Output = Result<T, ProviderTransportError>>,
    {
        let timeout_dur = self.attempt_timeout(http_timeout_ms)?;
        let step_ms = self.step_timeout_ms;
        tokio::select! {
            biased;
            () = self.cancel_token.cancelled() => {
                Err(ProviderTransportError::aborted("Model turn aborted."))
            }
            res = tokio::time::timeout(timeout_dur, fut) => {
                match res {
                    Ok(inner) => inner,
                    Err(_) => {
                        if self.remaining().is_none_or(|d| d.is_zero()) {
                            Err(ProviderTransportError::timeout(format!(
                                "Model step exceeded {step_ms}ms budget."
                            )))
                        } else {
                            Err(ProviderTransportError::timeout(format!(
                                "HTTP attempt exceeded {}ms timeout.",
                                http_timeout_ms
                            )))
                        }
                    }
                }
            }
        }
    }

    /// Sleeps for `delay` bounded by the step deadline and caller `CancellationToken`.
    pub async fn sleep(&self, delay: Duration) -> Result<(), ProviderTransportError> {
        if self.cancel_token.is_cancelled() {
            return Err(ProviderTransportError::aborted("Model turn aborted."));
        }
        let Some(remaining) = self.remaining() else {
            return Err(ProviderTransportError::timeout(format!(
                "Model step exceeded {}ms budget.",
                self.step_timeout_ms
            )));
        };
        if delay > remaining {
            // Wait only until deadline or cancellation, then fail with step timeout.
            tokio::select! {
                biased;
                () = self.cancel_token.cancelled() => {
                    return Err(ProviderTransportError::aborted("Model turn aborted."));
                }
                () = tokio::time::sleep(remaining) => {
                    return Err(ProviderTransportError::timeout(format!(
                        "Model step exceeded {}ms budget.",
                        self.step_timeout_ms
                    )));
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

/// Executes a streaming model step with `120s` HTTP / `300s` step budgets and jittered
/// `Retry-After` backoff strictly **before** any visible assistant output or tool side effect
/// has been emitted.
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

        let mut attempt_fut =
            std::pin::pin!(budget.run_attempt(policy.timeout_ms, attempt_fn(attempt_no, emit_cb)));
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
