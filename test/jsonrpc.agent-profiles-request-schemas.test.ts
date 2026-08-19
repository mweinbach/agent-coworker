import { describe, expect, test } from "bun:test";

import { jsonRpcAgentProfilesRequestSchemas } from "../src/server/jsonrpc/schema.agentProfiles";

const upsertSchema = jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/upsert"];
const deleteSchema = jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/delete"];
const copySchema = jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/copy"];
const availabilitySchema =
  jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/workspaceAvailability/set"];

const validProfile = {
  version: 1 as const,
  scope: "workspace" as const,
  id: "qa-reviewer",
  displayName: "QA Reviewer",
  description: "Checks completed work.",
  enabled: true,
  baseRole: "reviewer" as const,
  prompt: "Report concrete defects only.",
  allowedBuiltInTools: ["read", "grep"],
  allowedMcpServers: ["github"],
  skillNames: ["code-review"],
};

describe("agent profile request schemas", () => {
  test("accepts a valid upsert payload", () => {
    expect(upsertSchema.parse({ cwd: "/tmp/project", profile: validProfile })).toEqual({
      cwd: "/tmp/project",
      profile: validProfile,
    });
  });

  test("rejects profile ids that do not match the lowercase slug contract", () => {
    expect(
      upsertSchema.safeParse({
        profile: { ...validProfile, id: "QA Reviewer" },
      }).success,
    ).toBe(false);
    expect(
      upsertSchema.safeParse({
        profile: { ...validProfile, id: "" },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown scopes and extra profile fields", () => {
    expect(
      upsertSchema.safeParse({
        profile: { ...validProfile, scope: "team" },
      }).success,
    ).toBe(false);
    expect(
      upsertSchema.safeParse({
        profile: { ...validProfile, unexpected: true },
      }).success,
    ).toBe(false);
  });

  test("rejects delete and copy payloads that omit required identity fields", () => {
    expect(deleteSchema.safeParse({ scope: "workspace" }).success).toBe(false);
    expect(deleteSchema.safeParse({ id: "qa-reviewer" }).success).toBe(false);
    expect(
      copySchema.safeParse({
        copy: { targetScope: "global" },
      }).success,
    ).toBe(false);
    expect(
      copySchema.safeParse({
        copy: {
          sourceRef: "workspace:qa-reviewer",
          targetScope: "team",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects workspace-availability updates missing disabled or a blank id", () => {
    expect(availabilitySchema.safeParse({ id: "qa-reviewer" }).success).toBe(false);
    expect(availabilitySchema.safeParse({ id: "   ", disabled: true }).success).toBe(false);
    expect(
      availabilitySchema.parse({
        id: "qa-reviewer",
        disabled: true,
      }),
    ).toEqual({
      id: "qa-reviewer",
      disabled: true,
    });
  });
});
