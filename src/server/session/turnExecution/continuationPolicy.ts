import { supportsOpenAiContinuation } from "../../../shared/openaiContinuation";
import { isInvalidGoogleContinuationError as isInvalidGoogleContinuationHandleError } from "../../../shared/providerContinuation";

export { isInvalidGoogleContinuationHandleError };

function isInvalidOpenAiContinuationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const mentionsPreviousResponse =
    normalized.includes("previous_response_id") ||
    normalized.includes("previous response") ||
    normalized.includes("response_id");
  if (!mentionsPreviousResponse) return false;

  return (
    normalized.includes("not found") ||
    normalized.includes("invalid") ||
    normalized.includes("expired") ||
    normalized.includes("unknown") ||
    normalized.includes("does not exist")
  );
}

export function isInvalidGoogleContinuationError(error: unknown): boolean {
  return isInvalidGoogleContinuationHandleError(error);
}

export function isInvalidCodexAppServerContinuationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const mentionsThreadId =
    normalized.includes("thread_id") ||
    normalized.includes("thread id") ||
    normalized.includes("threadid") ||
    normalized.includes("thread");
  if (!mentionsThreadId) return false;

  return (
    normalized.includes("not found") ||
    normalized.includes("invalid") ||
    normalized.includes("expired") ||
    normalized.includes("unknown") ||
    normalized.includes("does not exist")
  );
}

export function isInvalidProviderManagedContinuationError(
  provider: unknown,
  error: unknown,
): boolean {
  if (supportsOpenAiContinuation(provider)) {
    return isInvalidOpenAiContinuationError(error);
  }
  if (provider === "codex-cli") {
    return isInvalidCodexAppServerContinuationError(error);
  }
  if (provider === "google") {
    return isInvalidGoogleContinuationError(error);
  }
  return false;
}
