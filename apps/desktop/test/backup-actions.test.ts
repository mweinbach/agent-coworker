import { beforeEach, describe, expect, test } from "bun:test";

import { createWorkspaceBackupActions } from "../src/app/store.actions/backup";
import { operationKey } from "../src/app/store.helpers/operations";
import { defaultThreadRuntime } from "../src/app/store.helpers/runtimeState";
import type { OperationState } from "../src/app/types";
import {
  createState,
  createStoreHarness,
  defaultWorkspaceRuntime,
  RUNTIME,
  resetSkillPluginActionRuntime,
  workspaceId,
} from "./skill-plugin-actions.harness";

function createBackupHarness() {
  const state = Object.assign(createState(), {
    operationsByKey: {} as Record<string, OperationState>,
    threads: [{ id: "backup-thread", workspaceId }],
    threadRuntimeById: {
      "backup-thread": {
        ...defaultThreadRuntime(),
        sessionId: "backup-session",
        sessionConfig: { backupsEnabled: false, maxSteps: 10 },
      },
    },
  });
  state.workspaceRuntimeById[workspaceId] = {
    ...defaultWorkspaceRuntime(),
    serverUrl: "ws://mock",
    controlSessionId: "control-session",
  };
  const { get, set } = createStoreHarness(state);
  return { state, actions: createWorkspaceBackupActions(set, get) };
}

describe("backup store actions", () => {
  beforeEach(resetSkillPluginActionRuntime);

  test("session backup changes wait for acknowledgment and preserve unrelated config on failure", async () => {
    const { state, actions } = createBackupHarness();
    const gate = Promise.withResolvers<Record<string, unknown>>();
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: () => gate.promise,
      respond: () => true,
      close: () => {},
    } as never);

    const result = actions.setWorkspaceBackupSessionEnabled(workspaceId, "backup-session", true);
    const key = operationKey("backup", "session-enabled", workspaceId, "backup-session");
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.operationsByKey[key]).toMatchObject({ status: "pending" });
      expect(state.threadRuntimeById["backup-thread"].sessionConfig.backupsEnabled).toBe(true);
      state.threadRuntimeById["backup-thread"].sessionConfig.maxSteps = 25;
    } finally {
      gate.reject(new Error("The session rejected its backup setting."));
    }

    expect(await result).toMatchObject({
      ok: false,
      error: { message: "The session rejected its backup setting." },
    });
    expect(state.threadRuntimeById["backup-thread"].sessionConfig).toEqual({
      backupsEnabled: false,
      maxSteps: 25,
    });
  });

  test("session backup success requires a matching session config acknowledgment", async () => {
    const { state, actions } = createBackupHarness();
    const requests: Array<{ method: string; params: unknown }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          event: {
            type: "session_config",
            sessionId: "backup-session",
            config: { backupsEnabled: true },
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as never);

    expect(
      await actions.setWorkspaceBackupSessionEnabled(workspaceId, "backup-session", true),
    ).toMatchObject({ ok: true });
    expect(requests).toEqual([
      {
        method: "cowork/session/config/set",
        params: { threadId: "backup-session", config: { backupsEnabled: true } },
      },
    ]);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionConfig).toBeNull();
  });
});
