import { asRecord } from "../../shared/recordParsing";
import type { AgentConfig } from "../../types";

/**
 * Rate-limit (HTTP 429 / ResourceExhausted) detection and bounded backoff
 * support for PI model calls. Hosted provider gateways (e.g. NVIDIA's) often
 * fail with a rate limit mid-stream, after the request was already accepted,
 * so request-level retry knobs cannot cover them. `runTurn.ts` restarts the
 * model call with backoff — but only while the failed attempt has not emitted
 * any assistant content or tool-call activity, so a retry never duplicates
 * visible output.
 */

/** Default total attempts per model step (initial call + 3 retries). */
export const RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS = 4;
/** First backoff delay in ms; doubles per retry (before jitter). */
export const RATE_LIMIT_RETRY_BASE_DELAY_MS = 2_000;
/** Upper bound for a single backoff delay in ms. */
export const RATE_LIMIT_RETRY_MAX_DELAY_MS = 60_000;

const RATE_LIMIT_MESSAGE_PATTERN =
  /resource[\s_-]?exhausted|rate[\s_-]?limit|too many requests|request limit|\b429\b/i;

function rateLimitStatusCode(record: Record<string, unknown>): number | undefined {
  for (const candidate of [record.statusCode, record.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  const response = asRecord(record.response);
  for (const candidate of [response?.status, response?.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function matchesRateLimitText(value: unknown): boolean {
  return typeof value === "string" && RATE_LIMIT_MESSAGE_PATTERN.test(value);
}

/**
 * True when `error` looks like a retryable provider rate limit: HTTP 429 in
 * common error shapes (AI SDK `statusCode`/`status`, fetch-style
 * `response.status`), or a `ResourceExhausted` / `rate_limit` /
 * `too many requests` / `request limit` message (case-insensitive). Walks
 * `cause` and AI SDK `RetryError.lastError` chains. Abort-shaped errors are
 * deliberately not matched; callers gate retries on `isAbortLikeError`.
 */
export function isRateLimitError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") return matchesRateLimitText(current);
    const record = asRecord(current);
    if (!record) return false;
    if (rateLimitStatusCode(record) === 429) return true;
    if (matchesRateLimitText(record.message)) return true;
    if (matchesRateLimitText(record.responseBody)) return true;
    current = record.cause ?? record.lastError;
    if (current === null || current === undefined) return false;
  }
  return false;
}

/**
 * Backoff delay for the Nth retry (1-based): `base * 2^(n-1)` capped at the
 * max, with equal jitter (`[delay/2, delay)`) so retries always wait a
 * meaningful minimum while concurrent retryers spread out.
 */
export function rateLimitBackoffDelayMs(
  retryNumber: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    RATE_LIMIT_RETRY_MAX_DELAY_MS,
    RATE_LIMIT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryNumber - 1),
  );
  const half = exponential / 2;
  return Math.floor(half + random() * half);
}

/**
 * Total model-call attempts allowed per step. Honors the AI SDK-style
 * `modelSettings.maxRetries` knob (retries after the initial attempt), clamped
 * to the bounded default budget so a turn cannot stall on a persistently
 * rate-limited provider.
 */
export function resolveRateLimitMaxAttempts(config: AgentConfig): number {
  const configured = config.modelSettings?.maxRetries;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS;
  }
  const retries = Math.min(
    Math.max(Math.floor(configured), 0),
    RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS - 1,
  );
  return 1 + retries;
}

/**
 * Sleeps for `ms`, rejecting with an abort-like error as soon as `signal`
 * fires so a backoff wait never outlives turn cancellation.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Model turn aborted."));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Model turn aborted."));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Raw stream part types that surface assistant content or tool-call activity
 * to clients. A model call may only be retried while none of these were
 * emitted — once content is visible, restarting the call would duplicate it.
 */
const VISIBLE_ASSISTANT_STREAM_PART_TYPES = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
]);

export function isVisibleAssistantStreamPart(part: unknown): boolean {
  const type = asRecord(part)?.type;
  return typeof type === "string" && VISIBLE_ASSISTANT_STREAM_PART_TYPES.has(type);
}
