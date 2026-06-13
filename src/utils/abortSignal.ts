/**
 * Compose a caller-supplied abort signal with a per-request timeout. The returned
 * signal aborts when either the caller cancels or the timeout elapses, so a hung
 * endpoint cannot stall the whole turn (the turn-level abort only fires on
 * user/system cancellation, not on a hang).
 */
export function withRequestTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
