import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentProfileUpsertInput } from "../../../src/shared/agentProfiles";
import type { JsonRpcSocket } from "../src/lib/agentSocket";
import type { SessionEvent } from "../src/lib/wsProtocol";
import {
  createState,
  createStoreHarness,
  RUNTIME,
  resetSkillPluginActionRuntime,
  workspaceId,
} from "./skill-plugin-actions.harness";

const { createAgentProfileActions } = await import("../src/app/store.actions/agentProfiles");

type AgentProfilesCatalogEvent = Extract<SessionEvent, { type: "agent_profiles_catalog" }>;

function deferred<T>() {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  if (!resolveFn) throw new Error("deferred resolver was not initialized");
  return { promise, resolve: resolveFn };
}

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

function catalogEvent(displayName: string): AgentProfilesCatalogEvent {
  const profile = {
    ...profileInput(),
    displayName,
  };
  const entry: AgentProfilesCatalogEvent["catalog"]["profiles"][number] = {
    scope: "workspace",
    path: `/profiles/${profile.id}.json`,
    effective: true,
    shadowed: false,
    profile,
  };
  return {
    type: "agent_profiles_catalog",
    catalog: {
      profiles: [entry],
      effectiveProfiles: [entry],
      diagnostics: [],
      roots: {
        globalDir: "/tmp/global-profiles",
        workspaceDir: "/tmp/workspace-profiles",
      },
    },
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

  test("stale profile catalog reads do not overwrite mutation results", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://profiles";
    const { get, set } = createStoreHarness(state);
    const staleRead = deferred<Record<string, unknown>>();

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: (method: string) => {
        if (method === "cowork/agentProfiles/catalog/read") {
          return staleRead.promise;
        }
        if (method === "cowork/agentProfiles/upsert") {
          return Promise.resolve({ event: catalogEvent("Fresh Profile") });
        }
        return Promise.resolve({});
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const actions = createAgentProfileActions(set, get);
    const refreshPromise = actions.refreshAgentProfilesCatalog(workspaceId);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.workspaceRuntimeById[workspaceId].agentProfilesLoading).toBe(true);

    const saved = await actions.upsertAgentProfile(profileInput(), workspaceId);
    expect(saved).toBe(true);
    expect(
      state.workspaceRuntimeById[workspaceId].agentProfilesCatalog?.profiles[0]?.profile
        .displayName,
    ).toBe("Fresh Profile");

    staleRead.resolve({ event: catalogEvent("Stale Profile") });
    await refreshPromise;

    expect(
      state.workspaceRuntimeById[workspaceId].agentProfilesCatalog?.profiles[0]?.profile
        .displayName,
    ).toBe("Fresh Profile");
    expect(state.workspaceRuntimeById[workspaceId].agentProfilesLoading).toBe(false);
  });
});
