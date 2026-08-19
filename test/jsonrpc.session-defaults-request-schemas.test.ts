import { describe, expect, test } from "bun:test";

import { jsonRpcControlRequestSchemas as mobileJsonRpcControlRequestSchemas } from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import { jsonRpcSessionRequestSchemas } from "../src/server/jsonrpc/schema.session";
import { jsonRpcSkillImprovementRequestSchemas } from "../src/server/jsonrpc/schema.skillImprovement";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const applySchema = jsonRpcSessionRequestSchemas["cowork/session/defaults/apply"];
const restoreSchema = jsonRpcSkillImprovementRequestSchemas["cowork/skills/improvement/restore"];

describe("session defaults and skill-improvement request schemas", () => {
  test("accepts a valid defaults/apply payload on server, shared, and mobile schemas", () => {
    const request = {
      cwd: "/tmp/project",
      threadId: "thread-1",
      provider: "openai",
      model: "gpt-5.2",
      config: {
        childModelRoutingMode: "same-provider",
        skillImprovementScope: "user",
        providerOptions: {
          openai: {
            reasoningEffort: "high",
          },
        },
      },
    };

    expect(applySchema.parse(request)).toEqual(request);
    expect(jsonRpcControlRequestSchemas["cowork/session/defaults/apply"].parse(request)).toEqual(
      request,
    );
    expect(
      mobileJsonRpcControlRequestSchemas["cowork/session/defaults/apply"].parse(request),
    ).toEqual(request);
  });

  test("rejects unknown child-model routing modes before they reach session state", () => {
    expect(
      applySchema.safeParse({
        config: { childModelRoutingMode: "bogus" },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown skill-improvement scopes", () => {
    expect(
      applySchema.safeParse({
        config: { skillImprovementScope: "workspace" },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown OpenAI reasoning-effort values", () => {
    expect(
      applySchema.safeParse({
        config: {
          providerOptions: {
            openai: { reasoningEffort: "ultra" },
          },
        },
      }).success,
    ).toBe(false);
  });

  test("rejects blank thread ids and unknown top-level fields", () => {
    expect(applySchema.safeParse({ threadId: "   " }).success).toBe(false);
    expect(
      applySchema.safeParse({
        cwd: "/tmp/project",
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  test("rejects non-integer overflow limits", () => {
    expect(
      applySchema.safeParse({
        config: { toolOutputOverflowChars: 1.5 },
      }).success,
    ).toBe(false);
  });

  test("skill improvement restore requires a non-empty skill name and is strict", () => {
    expect(restoreSchema.safeParse({}).success).toBe(false);
    expect(restoreSchema.safeParse({ skillName: "   " }).success).toBe(false);
    expect(
      restoreSchema.safeParse({
        skillName: "code-review",
        extra: true,
      }).success,
    ).toBe(false);
    expect(restoreSchema.parse({ skillName: "code-review" })).toEqual({
      skillName: "code-review",
    });
  });
});
