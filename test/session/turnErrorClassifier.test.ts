import { describe, expect, test } from "bun:test";
import type { SessionContext } from "../../src/server/session/SessionContext";
import { createTurnErrorClassifier } from "../../src/server/session/turnExecution/userMessageAttachments";
import type { ServerErrorCode, ServerErrorSource } from "../../src/types";

function classify(err: unknown) {
  const context = {
    formatError: (value: unknown) => (value instanceof Error ? value.message : String(value)),
  } as SessionContext;
  return createTurnErrorClassifier(context)(err);
}

describe("createTurnErrorClassifier", () => {
  test("passes through structured server errors and defaults missing sources", () => {
    expect(classify({ code: "permission_denied", source: "permissions", extra: true })).toEqual({
      code: "permission_denied",
      source: "permissions",
    });
    expect(classify({ code: "busy" })).toEqual({ code: "busy", source: "session" });
    expect(classify({ code: "provider_error" })).toEqual({
      code: "provider_error",
      source: "provider",
    });
    expect(classify({ code: "unknown_session" })).toEqual({
      code: "unknown_session",
      source: "session",
    });
  });

  test("ignores invalid structured codes or sources and falls through to heuristics", () => {
    expect(classify({ code: "not_a_code", source: "permissions" })).toEqual({
      code: "internal_error",
      source: "session",
    });
    expect(classify({ code: "permission_denied", source: "not_a_source" })).toEqual({
      code: "permission_denied",
      source: "permissions",
    });
    expect(classify("plain string")).toEqual({ code: "internal_error", source: "session" });
  });

  test.each([
    ["blocked: path is outside the workspace", "permission_denied", "permissions"],
    ["blocked: canonical target resolves outside root", "permission_denied", "permissions"],
    ["path is outside allowed directories", "permission_denied", "permissions"],
    ["path is outside allowed roots", "permission_denied", "permissions"],
    ["blocked private/internal host 10.0.0.1", "permission_denied", "permissions"],
    ["blocked url protocol javascript:", "permission_denied", "permissions"],
    ["blocked url credentials in request", "permission_denied", "permissions"],
    ["glob blocked: **/.git/**", "permission_denied", "permissions"],
    ["TraceQL query failed", "observability_error", "observability"],
    ["PromQL evaluation timed out", "observability_error", "observability"],
    ["LogQL parser rejected the query", "observability_error", "observability"],
    ["OAuth token refresh failed", "provider_error", "provider"],
    ["missing API key for openai", "provider_error", "provider"],
    ["unsupported provider", "provider_error", "provider"],
    ["generated response exceeds the limit", "provider_error", "provider"],
    ["generated response exceeded the limit", "provider_error", "provider"],
    ["maximum allowed size limit", "provider_error", "provider"],
    ["provider size limit reached", "provider_error", "provider"],
    ["unknown checkpoint id ckpt-1", "validation_failed", "session"],
    ["failed to write checkpoint", "backup_error", "backup"],
    ["session backup prune failed", "backup_error", "backup"],
    ["model is required", "validation_failed", "session"],
    ["invalid payload", "validation_failed", "session"],
  ] as const)("maps %s to %s/%s", (message, code, source) => {
    expect(classify(new Error(message))).toEqual({
      code: code as ServerErrorCode,
      source: source as ServerErrorSource,
    });
  });

  test("prefers structured codes over heuristic message text", () => {
    expect(
      classify({
        code: "internal_error",
        source: "session",
        message: "blocked: path is outside",
      }),
    ).toEqual({ code: "internal_error", source: "session" });
  });
});
