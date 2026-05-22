import type { GoogleInteractionErrorKind } from "./types";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isGoogleGeneratedResponseSizeLimitError(error: unknown): boolean {
  const normalized = errorText(error).toLowerCase();
  return (
    (normalized.includes("generated response") &&
      (normalized.includes("exceeds") || normalized.includes("exceeded")) &&
      normalized.includes("size limit")) ||
    normalized.includes("maximum allowed size limit")
  );
}

export function makeGoogleGeneratedResponseSizeLimitError(): Error & {
  code: "provider_error";
  source: "provider";
} {
  return Object.assign(
    new Error(
      "Gemini generated response exceeded the provider size limit. For large transcripts or extracted documents, write the full output to a workspace file in bounded chunks and return only the file path plus a concise summary in chat.",
    ),
    {
      code: "provider_error" as const,
      source: "provider" as const,
    },
  );
}

export function classifyGoogleInteractionError(error: unknown): GoogleInteractionErrorKind {
  const text = errorText(error);
  const normalized = text.toLowerCase();
  if (normalized.includes("abort")) return "abort";
  if (
    normalized.includes("api key") ||
    normalized.includes("unauthorized") ||
    normalized.includes("permission_denied") ||
    normalized.includes("401") ||
    normalized.includes("403")
  ) {
    return "auth";
  }
  if (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("429")
  ) {
    return "quota";
  }
  if (
    (normalized.includes("previous_interaction") || normalized.includes("interaction_id")) &&
    (normalized.includes("not found") ||
      normalized.includes("invalid") ||
      normalized.includes("expired") ||
      normalized.includes("unknown"))
  ) {
    return "stale_continuation";
  }
  if (
    normalized.includes("schema") ||
    normalized.includes("invalid argument") ||
    normalized.includes("invalid_argument") ||
    normalized.includes("bad request") ||
    normalized.includes("400")
  ) {
    return "schema";
  }
  if (isGoogleGeneratedResponseSizeLimitError(error)) {
    return "output_size";
  }
  if (
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("unavailable") ||
    normalized.includes("internal") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504")
  ) {
    return "retryable";
  }
  return "unknown";
}

export function isRetryableGoogleInteractionError(error: unknown): boolean {
  const kind = classifyGoogleInteractionError(error);
  return kind === "retryable" || kind === "quota";
}
