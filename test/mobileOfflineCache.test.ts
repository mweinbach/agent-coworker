import { describe, expect, mock, test } from "bun:test";

import path from "node:path";

import {
  clearAllOfflineWorkspaceCache,
  loadAllOfflineWorkspaceCache,
  loadFromOfflineCache,
  saveToOfflineCache,
} from "../apps/mobile/src/features/cowork/offlineCache";
import { useProviderStore } from "../apps/mobile/src/features/cowork/providerStore";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

describe("mobile offline cache", () => {
  test("saves and loads items from cache", async () => {
    await saveToOfflineCache("test-key", { hello: "world" });
    const loaded = await loadFromOfflineCache<any>("test-key");
    expect(loaded).toEqual({ hello: "world" });
  });

  test("loads all offline workspace cache into Zustand stores", async () => {
    // Seed some data into the mock secure store
    await saveToOfflineCache("workspaces", [{ id: "w1", name: "Workspace 1", path: "/path/1" }]);
    await saveToOfflineCache("activeWorkspaceId", "w1");
    await saveToOfflineCache("activeWorkspaceCwd", "/path/1");
    await saveToOfflineCache("providerCatalog", [{ id: "p1", name: "Provider 1" }]);

    // Run hydration
    await loadAllOfflineWorkspaceCache();

    // Verify Zustand state
    expect(useWorkspaceStore.getState().workspaces).toEqual([
      { id: "w1", name: "Workspace 1", path: "/path/1" } as any,
    ]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("w1");
    expect(useWorkspaceStore.getState().activeWorkspaceCwd).toBe("/path/1");
    expect(useProviderStore.getState().catalog).toEqual([{ id: "p1", name: "Provider 1" } as any]);
  });

  test("clears all offline workspace cache", async () => {
    await saveToOfflineCache("workspaces", [{ id: "w1" }]);
    await clearAllOfflineWorkspaceCache();
    const loaded = await loadFromOfflineCache("workspaces");
    expect(loaded).toBeNull();
  });
});
