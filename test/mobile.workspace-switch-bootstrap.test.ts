import { describe, expect, mock, test } from "bun:test";

import { bootstrapWorkspaceSwitchSession } from "../apps/mobile/src/features/cowork/workspaceSwitchBootstrap";

describe("mobile workspace switch bootstrap", () => {
  test("clears stale threads before rehydrating the new workspace session", async () => {
    const clearThreads = mock(() => {});
    const hydrateThreads = mock(() => {});
    const refreshWorkspaceBoundStores = mock(async () => {});
    const initialize = mock(async () => {});
    const requestThreadList = mock(async () => ({
      threads: [
        {
          id: "thread-1",
          title: "Thread One",
          preview: "",
          modelProvider: "openai",
          model: "gpt-5",
          cwd: "/tmp/workspace-two",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          messageCount: 0,
          lastEventSeq: 3,
          status: { type: "idle" as const },
        },
      ],
    }));

    await bootstrapWorkspaceSwitchSession({
      client: { initialize, requestThreadList },
      clearThreads,
      hydrateThreads,
      refreshWorkspaceBoundStores,
    });

    expect(clearThreads).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(requestThreadList).toHaveBeenCalledTimes(1);
    expect(hydrateThreads).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceBoundStores).toHaveBeenCalledTimes(1);
  });

  test("rethrows bootstrap failures after clearing stale threads", async () => {
    const clearThreads = mock(() => {});
    const hydrateThreads = mock(() => {});
    const refreshWorkspaceBoundStores = mock(async () => {});
    const initialize = mock(async () => {
      throw new Error("Not initialized");
    });
    const requestThreadList = mock(async () => ({ threads: [] }));

    await expect(
      bootstrapWorkspaceSwitchSession({
        client: { initialize, requestThreadList },
        clearThreads,
        hydrateThreads,
        refreshWorkspaceBoundStores,
      }),
    ).rejects.toThrow("Not initialized");

    expect(clearThreads).toHaveBeenCalledTimes(1);
    expect(requestThreadList).not.toHaveBeenCalled();
    expect(hydrateThreads).not.toHaveBeenCalled();
    expect(refreshWorkspaceBoundStores).not.toHaveBeenCalled();
  });
});
