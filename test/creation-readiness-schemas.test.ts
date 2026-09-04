import { describe, expect, test } from "bun:test";

import {
  creationKindSchema,
  creationPreflightParamsSchema,
  creationPreflightResultSchema,
  creationReadinessCheckSchema,
  creationRepairActionSchema,
} from "../src/shared/creationReadiness";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("creation readiness schemas", () => {
  test("accepts chat and task kinds and rejects retired or unknown kinds", () => {
    expect(creationKindSchema.parse("chat")).toBe("chat");
    expect(creationKindSchema.parse("task")).toBe("task");
    rejects(creationKindSchema, "research");
    rejects(creationKindSchema, "plan");
    rejects(creationKindSchema, "chatgpt");
  });

  test("preflight params reject blank cwd/model, unknown providers, and extras", () => {
    expect(
      creationPreflightParamsSchema.parse({
        kind: "chat",
        cwd: "  /workspace  ",
        provider: "google",
        model: "  gemini-2.5-flash  ",
      }),
    ).toEqual({
      kind: "chat",
      cwd: "/workspace",
      provider: "google",
      model: "gemini-2.5-flash",
    });
    rejects(creationPreflightParamsSchema, { kind: "plan" });
    rejects(creationPreflightParamsSchema, { kind: "chat", cwd: "   " });
    rejects(creationPreflightParamsSchema, { kind: "chat", model: "   " });
    rejects(creationPreflightParamsSchema, { kind: "chat", provider: "chatgpt" });
    rejects(creationPreflightParamsSchema, { kind: "chat", extra: true });
  });

  test("repair actions require their discriminant fields and reject extras", () => {
    expect(
      creationRepairActionSchema.parse({
        type: "startLmStudio",
        baseUrl: "http://127.0.0.1:1234",
        canAutoStart: true,
      }),
    ).toEqual({
      type: "startLmStudio",
      baseUrl: "http://127.0.0.1:1234",
      canAutoStart: true,
    });
    rejects(creationRepairActionSchema, {
      type: "startLmStudio",
      canAutoStart: true,
    });
    rejects(creationRepairActionSchema, {
      type: "startLmStudio",
      baseUrl: "not-a-url",
      canAutoStart: true,
    });
    rejects(creationRepairActionSchema, {
      type: "connectProvider",
      provider: "google",
      extra: true,
    });
    rejects(creationRepairActionSchema, {
      type: "installCodexRuntime",
      extra: true,
    });
    rejects(creationRepairActionSchema, {
      type: "openProviderSettings",
    });
  });

  test("checks reject unknown ids/statuses, blank messages, and extras", () => {
    expect(
      creationReadinessCheckSchema.parse({
        id: "provider_connected",
        status: "ok",
        message: "Ready",
      }),
    ).toEqual({
      id: "provider_connected",
      status: "ok",
      message: "Ready",
    });
    rejects(creationReadinessCheckSchema, {
      id: "unknown_check",
      status: "ok",
      message: "Ready",
    });
    rejects(creationReadinessCheckSchema, {
      id: "provider_connected",
      status: "error",
      message: "Ready",
    });
    rejects(creationReadinessCheckSchema, {
      id: "provider_connected",
      status: "ok",
      message: "   ",
    });
    rejects(creationReadinessCheckSchema, {
      id: "provider_connected",
      status: "ok",
      message: "Ready",
      extra: true,
    });
    rejects(creationPreflightResultSchema, {
      ready: true,
      checks: [
        {
          id: "provider_connected",
          status: "ok",
          message: "Ready",
          extra: true,
        },
      ],
    });
  });
});
