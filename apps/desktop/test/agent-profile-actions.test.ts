import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentProfileUpsertInput } from "../../../src/shared/agentProfiles";
import type { JsonRpcSocket } from "../src/lib/agentSocket";
import {
  createState,
  createStoreHarness,
  RUNTIME,
  resetSkillPluginActionRuntime,
  workspaceId,
} from "./skill-plugin-actions.harness";

const { createAgentProfileActions } = await import("../src/app/store.actions/agentProfiles");

function profileInput(): AgentProfileUpsertInput {
  return {
    version: 1,
    scope: "workspace",
    id: "qa-reviewer",
    displayName: "QA Reviewer",
    description: "",
    enabled: true,
    baseRole: "reviewer",
    prompt: "Review regressions carefully.",
    allowedBuiltInTools: ["read"],
    allowedMcpServers: [],
    skillNames: [],
  };
}

describe("agent profile store actions", () => {
  beforeEach(() => {
    resetSkillPluginActionRuntime();
  });

  test("profile mutations fall back when the selected workspace id is stale", async () => {
    const state = createState();
    state.selectedWorkspaceId = "missing-workspace";
    state.workspaces = [{ id: workspaceId, path: "/tmp/profile-workspace" }];
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://profiles";
    const { get, set } = createStoreHarness(state);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return Promise.resolve({});
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const actions = createAgentProfileActions(set, get);

    const saved = await actions.upsertAgentProfile(profileInput());
    await actions.deleteAgentProfile("workspace", "qa-reviewer");
    await actions.copyAgentProfile({
      sourceRef: "workspace:qa-reviewer",
      targetScope: "global",
      targetId: "qa-reviewer-copy",
    });

    expect(saved).toBe(true);
    expect(calls.map((call) => call.method)).toEqual([
      "cowork/agentProfiles/upsert",
      "cowork/agentProfiles/delete",
      "cowork/agentProfiles/copy",
    ]);
    expect(calls.map((call) => call.params.cwd)).toEqual([
      "/tmp/profile-workspace",
      "/tmp/profile-workspace",
      "/tmp/profile-workspace",
    ]);
    expect(state.workspaceRuntimeById["missing-workspace"]).toBeUndefined();
    expect(state.notifications).toHaveLength(0);
  });
});
