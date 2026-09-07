export type PiRequestPolicy = {
  /** PI transport timeout per SDK request, not the whole logical model step. */
  timeoutMs: number;
  /** Wall-clock budget shared by every Cowork attempt and retry backoff in one step. */
  stepTimeoutMs: number;
  /** Cowork owns retries; SDK retries must not multiply its attempt count. */
  maxRetries: 0;
  maxRetryDelayMs: number;
};

const DEFAULT_POLICY: Readonly<PiRequestPolicy> = Object.freeze({
  timeoutMs: 120_000,
  stepTimeoutMs: 300_000,
  maxRetries: 0,
  maxRetryDelayMs: 10_000,
});

function boundedInteger(
  name: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`PI ${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Read the selected providerOptions section. Invalid explicit values fail closed:
 * durations cannot disable deadlines, overflow timers, or permit SDK retry loops.
 * Bounds: timeoutMs 1..600000, stepTimeoutMs 1..1800000,
 * maxRetryDelayMs 0..60000, maxRetries exactly 0.
 */
export function resolvePiRequestPolicy(options: Record<string, unknown> = {}): PiRequestPolicy {
  const timeoutMs = boundedInteger(
    "timeoutMs",
    options.timeoutMs,
    DEFAULT_POLICY.timeoutMs,
    1,
    600_000,
  );
  const stepTimeoutMs = boundedInteger(
    "stepTimeoutMs",
    options.stepTimeoutMs,
    DEFAULT_POLICY.stepTimeoutMs,
    1,
    1_800_000,
  );
  boundedInteger("maxRetries", options.maxRetries, 0, 0, 0);
  return {
    timeoutMs: Math.min(timeoutMs, stepTimeoutMs),
    stepTimeoutMs,
    maxRetries: 0,
    maxRetryDelayMs: boundedInteger(
      "maxRetryDelayMs",
      options.maxRetryDelayMs,
      DEFAULT_POLICY.maxRetryDelayMs,
      0,
      60_000,
    ),
  };
}

export type PiRequestBudget = {
  /** Pass this composed signal to PI and backoff implementations instead of the caller signal. */
  signal: AbortSignal;
  /** Rejects on deadline/caller abort even when the operation ignores the signal. */
  run<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T>;
  /** Abortable backoff using the same deadline, with no orphaned sleep timer. */
  sleep(delayMs: number): Promise<void>;
  throwIfAborted(): void;
  /** Required in finally; idempotently releases timers/listeners and cancels outstanding work. */
  dispose(): void;
};

/**
 * Create ONCE per logical model step, outside Cowork's retry loop. The deadline
 * starts at creation and never resets between attempts/backoffs. Wrap each entire
 * stream consumption (including result()) in run(), and pass signal to PI.
 * Injected backoff implementations can be wrapped with run(signal => retrySleep(ms, signal)).
 * Always dispose() in finally before executing tools or starting the next step.
 *
 * Racing cannot stop arbitrary code that ignores abort: consumers must also check
 * signal before emitting late events or committing results from abandoned work.
 * This helper owns one deadline timer and one listener on the caller signal.
 */
export function createPiRequestBudget(
  options: { signal?: AbortSignal; stepTimeoutMs?: number } = {},
): PiRequestBudget {
  const stepTimeoutMs = boundedInteger(
    "stepTimeoutMs",
    options.stepTimeoutMs,
    DEFAULT_POLICY.stepTimeoutMs,
    1,
    1_800_000,
  );
  const controller = new AbortController();
  const signal = controller.signal;
  const callerSignal = options.signal;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };
  const abort = (reason: unknown) => {
    cleanup();
    if (!signal.aborted) controller.abort(reason);
  };
  const onCallerAbort = () => abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    deadlineTimer = setTimeout(
      () => abort(new DOMException(`PI model step exceeded ${stepTimeoutMs}ms.`, "TimeoutError")),
      stepTimeoutMs,
    );
  }

  const throwIfAborted = () => signal.throwIfAborted();
  const run = <T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        Promise.resolve(operation(signal)).then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) reject(signal.reason);
            else resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(signal.aborted ? signal.reason : error);
          },
        );
      } catch (error) {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? signal.reason : error);
      }
    });

  return {
    signal,
    run,
    throwIfAborted,
    sleep: async (delayMs) => {
      boundedInteger("backoff delayMs", delayMs, 0, 0, 1_800_000);
      let sleepTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await run(
          () =>
            new Promise<void>((resolve) => {
              sleepTimer = setTimeout(resolve, delayMs);
            }),
        );
      } finally {
        if (sleepTimer !== undefined) clearTimeout(sleepTimer);
      }
    },
    dispose: () => abort(new DOMException("PI request budget disposed.", "AbortError")),
  };
}
