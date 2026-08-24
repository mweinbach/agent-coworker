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

/** Stop waiting immediately when cancellation wins, even if the dependency ignores its signal. */
export async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  message = "Model turn aborted.",
): Promise<T> {
  if (!signal) return await operation;
  if (signal.aborted) throw new Error(message);

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
