import { describe, expect, test } from "bun:test";
import {
  buildAgentProfileRef,
  normalizeAgentProfileDefinition,
  parseAgentProfileRef,
} from "../src/shared/agentProfiles";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("agent profile definition and refs", () => {
  test("normalize fills defaults and dedupes allowlists", () => {
    expect(
      normalizeAgentProfileDefinition({
        id: " qa.reviewer_1 ",
        displayName: " QA Reviewer ",
        allowedBuiltInTools: ["read", " grep ", "read"],
        allowedMcpServers: ["github", " github ", "slack"],
        skillNames: ["code-review", "code-review"],
      }),
    ).toEqual({
      version: 1,
      id: "qa.reviewer_1",
      displayName: "QA Reviewer",
      description: "",
      enabled: true,
      baseRole: "default",
      prompt: "",
      allowedBuiltInTools: ["read", "grep"],
      allowedMcpServers: ["github", "slack"],
      skillNames: ["code-review"],
    });
  });

  test("normalize rejects invalid ids, unknown roles, extras, and overlong fields", () => {
    expect(() =>
      normalizeAgentProfileDefinition({ id: "QA-Reviewer", displayName: "QA" }),
    ).toThrow();
    expect(() => normalizeAgentProfileDefinition({ id: "-dash", displayName: "QA" })).toThrow();
    expect(() =>
      normalizeAgentProfileDefinition({ id: "a".repeat(81), displayName: "QA" }),
    ).toThrow();
    expect(() =>
      normalizeAgentProfileDefinition({ id: "qa", displayName: "QA", baseRole: "admin" }),
    ).toThrow();
    expect(() =>
      normalizeAgentProfileDefinition({
        id: "qa",
        displayName: "QA",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      normalizeAgentProfileDefinition({
        id: "qa",
        displayName: "QA",
        reasoningEffort: "dynamic",
      }),
    ).toThrow();
    expect(() =>
      normalizeAgentProfileDefinition({
        id: "qa",
        displayName: "QA",
        defaultTaskType: "chat",
      }),
    ).toThrow();
    expect(() =>
      normalizeAgentProfileDefinition({
        id: "qa",
        displayName: "QA",
        allowedBuiltInTools: [""],
      }),
    ).toThrow();
  });

  test("parseAgentProfileRef accepts bare and scoped ids and fail-closes the rest", () => {
    expect(parseAgentProfileRef(" qa-reviewer ")).toEqual({ kind: "bare", id: "qa-reviewer" });
    expect(parseAgentProfileRef("workspace:qa-reviewer")).toEqual({
      kind: "scoped",
      scope: "workspace",
      id: "qa-reviewer",
    });
    expect(parseAgentProfileRef("global:qa.reviewer_1")).toEqual({
      kind: "scoped",
      scope: "global",
      id: "qa.reviewer_1",
    });
    expect(buildAgentProfileRef("workspace", "qa-reviewer")).toBe("workspace:qa-reviewer");
    expect(() => parseAgentProfileRef("   ")).toThrow("profileRef must not be empty");
    expect(() => parseAgentProfileRef("workspace:")).toThrow();
    expect(() => parseAgentProfileRef("workspace:QA-Reviewer")).toThrow();
    expect(() => parseAgentProfileRef("Workspace:qa-reviewer")).toThrow();
    expect(() => parseAgentProfileRef("user:qa-reviewer")).toThrow();
  });
});

describe("agent profile request schema rejects", () => {
  test("upsert requires a valid scoped profile and rejects extras", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/agentProfiles/upsert"];
    expect(
      schema.parse({
        profile: {
          scope: "workspace",
          id: " qa-reviewer ",
          displayName: " QA ",
        },
      }),
    ).toMatchObject({
      profile: { scope: "workspace", id: "qa-reviewer", displayName: "QA" },
    });
    rejects(schema, { profile: { id: "qa-reviewer", displayName: "QA" } });
    rejects(schema, {
      profile: { scope: "project", id: "qa-reviewer", displayName: "QA" },
    });
    rejects(schema, {
      profile: { scope: "workspace", id: "QA-Reviewer", displayName: "QA" },
    });
    rejects(schema, {
      cwd: "/tmp/project",
      profile: { scope: "workspace", id: "qa-reviewer", displayName: "QA" },
      extra: true,
    });
  });

  test("copy and availability reject blank refs, unknown scopes, and extras", () => {
    const copy = jsonRpcControlRequestSchemas["cowork/agentProfiles/copy"];
    const availability =
      jsonRpcControlRequestSchemas["cowork/agentProfiles/workspaceAvailability/set"];
    expect(
      copy.parse({
        copy: { sourceRef: " workspace:qa-reviewer ", targetScope: "global" },
      }),
    ).toEqual({
      copy: { sourceRef: "workspace:qa-reviewer", targetScope: "global" },
    });
    rejects(copy, { copy: { sourceRef: " ", targetScope: "global" } });
    rejects(copy, {
      copy: { sourceRef: "workspace:qa-reviewer", targetScope: "user" },
    });
    rejects(copy, {
      copy: {
        sourceRef: "workspace:qa-reviewer",
        targetScope: "global",
        targetId: "QA",
      },
    });
    rejects(copy, {
      copy: { sourceRef: "workspace:qa-reviewer", targetScope: "global", extra: true },
    });
    rejects(availability, { id: " ", disabled: true });
    rejects(availability, { id: "research", disabled: "yes" });
    rejects(availability, { id: "research", disabled: true, extra: true });
  });
});
