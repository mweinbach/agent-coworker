import { describe, expect, test } from "bun:test";

import {
  creationKindSchema,
  creationPreflightParamsSchema,
  creationPreflightResultSchema,
  creationReadinessCheckSchema,
  creationRepairActionSchema,
} from "../src/shared/creationReadiness";

function expectReject(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("creation readiness schemas", () => {
  test("accepts the three creation kinds and a minimal preflight request", () => {
    expect(creationKindSchema.parse("chat")).toBe("chat");
    expect(creationKindSchema.parse("research")).toBe("research");
    expect(creationKindSchema.parse("task")).toBe("task");
    expect(creationPreflightParamsSchema.parse({ kind: "chat" })).toEqual({ kind: "chat" });
    expect(
      creationPreflightParamsSchema.parse({
        kind: "task",
        cwd: " /workspace/project ",
        provider: "openai",
        model: " gpt-5.4 ",
      }),
    ).toEqual({
      kind: "task",
      cwd: "/workspace/project",
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  test("preflight params reject unknown kinds, providers, blanks, and extras", () => {
    expectReject(creationPreflightParamsSchema, { kind: "plan" });
    expectReject(creationPreflightParamsSchema, { kind: "chat", provider: "chatgpt" });
    expectReject(creationPreflightParamsSchema, { kind: "chat", cwd: "   " });
    expectReject(creationPreflightParamsSchema, { kind: "chat", model: "" });
    expectReject(creationPreflightParamsSchema, { kind: "chat", extra: true });
    expectReject(creationPreflightParamsSchema, {});
  });

  test("repair actions are a strict discriminated union", () => {
    expect(
      creationRepairActionSchema.parse({ type: "connectProvider", provider: "google" }),
    ).toEqual({
      type: "connectProvider",
      provider: "google",
    });
    expect(creationRepairActionSchema.parse({ type: "installCodexRuntime" })).toEqual({
      type: "installCodexRuntime",
    });
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

    expectReject(creationRepairActionSchema, { type: "connectProvider", provider: "chatgpt" });
    expectReject(creationRepairActionSchema, {
      type: "connectProvider",
      provider: "google",
      extra: true,
    });
    expectReject(creationRepairActionSchema, { type: "openProviderSettings" });
    expectReject(creationRepairActionSchema, {
      type: "startLmStudio",
      baseUrl: "not-a-url",
      canAutoStart: true,
    });
    expectReject(creationRepairActionSchema, {
      type: "startLmStudio",
      baseUrl: "http://127.0.0.1:1234",
    });
    expectReject(creationRepairActionSchema, { type: "installCodexRuntime", extra: true });
    expectReject(creationRepairActionSchema, { type: "openSettings" });
  });

  test("readiness checks and preflight results reject unknown ids, statuses, and extras", () => {
    const okCheck = {
      id: "provider_connected" as const,
      status: "ok" as const,
      message: "Provider is connected.",
      repairAction: { type: "openProviderSettings" as const, provider: "google" as const },
    };
    expect(creationReadinessCheckSchema.parse(okCheck)).toEqual(okCheck);
    expect(
      creationPreflightResultSchema.parse({
        ready: false,
        checks: [okCheck],
      }),
    ).toEqual({ ready: false, checks: [okCheck] });

    expectReject(creationReadinessCheckSchema, {
      id: "sandbox_ready",
      status: "ok",
      message: "ok",
    });
    expectReject(creationReadinessCheckSchema, {
      id: "runtime_ready",
      status: "error",
      message: "failed",
    });
    expectReject(creationReadinessCheckSchema, {
      id: "credentials",
      status: "blocked",
      message: "   ",
    });
    expectReject(creationReadinessCheckSchema, {
      id: "model_available",
      status: "pending",
      message: "Waiting",
      extra: true,
    });
    expectReject(creationPreflightResultSchema, { ready: true, checks: [], extra: true });
    expectReject(creationPreflightResultSchema, {
      ready: true,
      checks: [{ id: "project_access", status: "ok" }],
    });
  });
});
