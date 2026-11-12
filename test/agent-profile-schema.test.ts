import { describe, expect, test } from "bun:test";
import { buildAgentProfileRef } from "../src/shared/agentProfiles";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const s = jsonRpcControlRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

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
