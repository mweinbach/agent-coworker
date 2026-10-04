import { describe, expect, test } from "bun:test";
import {
  buildAgentProfileRef,
  normalizeAgentProfileDefinition,
  parseAgentProfileRef,
} from "../src/shared/agentProfiles";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const s = jsonRpcControlRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("agent profile definition and refs", () => {
  test("normalize fills defaults, dedupes allowlists, and rejects invalid definitions", () => {
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

    for (const invalid of [
      { id: "QA-Reviewer", displayName: "QA" },
      { id: "-dash", displayName: "QA" },
      { id: "a".repeat(81), displayName: "QA" },
      { id: "qa", displayName: "QA", baseRole: "admin" },
      { id: "qa", displayName: "QA", extra: true },
      { id: "qa", displayName: "QA", reasoningEffort: "dynamic" },
      { id: "qa", displayName: "QA", defaultTaskType: "chat" },
      { id: "qa", displayName: "QA", allowedBuiltInTools: [""] },
    ]) {
      expect(() => normalizeAgentProfileDefinition(invalid)).toThrow();
    }
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
    for (const bad of [
      "workspace:",
      "workspace:QA-Reviewer",
      "Workspace:qa-reviewer",
      "user:qa-reviewer",
    ]) {
      expect(() => parseAgentProfileRef(bad)).toThrow();
    }
  });
});

describe("agent profile request schema rejects", () => {
  test("upsert, copy, and availability reject blank refs, unknown scopes, and extras", () => {
    const upsert = s["cowork/agentProfiles/upsert"];
    expect(
      upsert.parse({ profile: { scope: "workspace", id: " qa-reviewer ", displayName: " QA " } }),
    ).toMatchObject({ profile: { scope: "workspace", id: "qa-reviewer", displayName: "QA" } });
    rejectsAll(upsert, [
      { profile: { id: "qa-reviewer", displayName: "QA" } },
      { profile: { scope: "project", id: "qa-reviewer", displayName: "QA" } },
      { profile: { scope: "workspace", id: "QA-Reviewer", displayName: "QA" } },
      {
        cwd: "/tmp/project",
        profile: { scope: "workspace", id: "qa-reviewer", displayName: "QA" },
        extra: true,
      },
    ]);

    const copy = s["cowork/agentProfiles/copy"];
    expect(
      copy.parse({ copy: { sourceRef: " workspace:qa-reviewer ", targetScope: "global" } }),
    ).toEqual({ copy: { sourceRef: "workspace:qa-reviewer", targetScope: "global" } });
    rejectsAll(copy, [
      { copy: { sourceRef: " ", targetScope: "global" } },
      { copy: { sourceRef: "workspace:qa-reviewer", targetScope: "user" } },
      { copy: { sourceRef: "workspace:qa-reviewer", targetScope: "global", targetId: "QA" } },
      { copy: { sourceRef: "workspace:qa-reviewer", targetScope: "global", extra: true } },
    ]);

    rejectsAll(s["cowork/agentProfiles/workspaceAvailability/set"], [
      { id: " ", disabled: true },
      { id: "research", disabled: "yes" },
      { id: "research", disabled: true, extra: true },
    ]);
  });
});
