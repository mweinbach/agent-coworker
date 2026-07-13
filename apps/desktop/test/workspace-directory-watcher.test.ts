import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { WorkspaceFileChangeEvent } from "../../../src/filesystem/workspaceFileEvents";
import {
  WorkspaceDirectoryWatcher,
  type WorkspaceDirectoryWatchScope,
} from "../electron/services/workspaceDirectoryWatcher";

type WatchCallback = (eventType: "rename" | "change", filename: string | Buffer | null) => void;

function settleWatcher(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("WorkspaceDirectoryWatcher", () => {
  test("shares one physical watcher for subscribers in the same scope", () => {
    const callbacks: WatchCallback[] = [];
    let closes = 0;
    const watcher = new WorkspaceDirectoryWatcher({
      watch: (_rootPath, listener) => {
        callbacks.push(listener);
        return {
          close() {
            closes += 1;
          },
        };
      },
    });
    const scope: WorkspaceDirectoryWatchScope = {
      workspaceId: "workspace-a",
      rootPath: "/repo",
    };

    expect(watcher.watch(scope, "renderer-1", () => {})).toBe(true);
    expect(watcher.watch(scope, "renderer-2", () => {})).toBe(true);
    expect(callbacks).toHaveLength(1);

    watcher.unwatch(scope, "renderer-1");
    expect(closes).toBe(0);
    watcher.unwatch(scope, "renderer-2");
    expect(closes).toBe(1);
  });

  test("keeps identical roots isolated by workspace scope", () => {
    let watches = 0;
    const watcher = new WorkspaceDirectoryWatcher({
      watch: () => {
        watches += 1;
        return { close() {} };
      },
    });

    watcher.watch({ workspaceId: "workspace-a", rootPath: "/repo" }, "renderer", () => {});
    watcher.watch({ workspaceId: "workspace-b", rootPath: "/repo" }, "renderer", () => {});

    expect(watches).toBe(2);
    watcher.dispose();
  });

  test("debounces change notifications into a targeted modify event", async () => {
    let callback: WatchCallback | null = null;
    const events: WorkspaceFileChangeEvent[] = [];
    const watcher = new WorkspaceDirectoryWatcher({
      debounceMs: 0,
      watch: (_rootPath, listener) => {
        callback = listener;
        return { close() {} };
      },
    });
    watcher.watch({ workspaceId: "workspace-a", rootPath: "/repo" }, "renderer", (event) => {
      events.push(event);
    });

    callback?.("change", "src/index.ts");
    callback?.("change", "../outside.ts");
    await settleWatcher();

    expect(events).toEqual([
      {
        workspaceId: "workspace-a",
        rootPath: path.resolve("/repo").replace(/\\/g, "/"),
        kind: "modify",
        changedPaths: [path.resolve("/repo/src/index.ts").replace(/\\/g, "/")],
        affectedDirectoryPaths: [path.resolve("/repo/src").replace(/\\/g, "/")],
        invalidatedSubtreePaths: [],
      },
    ]);
    watcher.dispose();
  });

  test("pairs removed and added rename paths within one debounce window", async () => {
    let callback: WatchCallback | null = null;
    const events: WorkspaceFileChangeEvent[] = [];
    const watcher = new WorkspaceDirectoryWatcher({
      debounceMs: 0,
      pathExists: async (candidatePath) => path.basename(candidatePath) === "new",
      watch: (_rootPath, listener) => {
        callback = listener;
        return { close() {} };
      },
    });
    watcher.watch({ workspaceId: "workspace-a", rootPath: "/repo" }, "renderer", (event) => {
      events.push(event);
    });

    callback?.("rename", "src/old");
    callback?.("rename", "packages/new");
    await settleWatcher();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: "workspace-a",
      kind: "rename",
      changedPaths: [
        path.resolve("/repo/src/old").replace(/\\/g, "/"),
        path.resolve("/repo/packages/new").replace(/\\/g, "/"),
      ],
      affectedDirectoryPaths: [
        path.resolve("/repo/src").replace(/\\/g, "/"),
        path.resolve("/repo/packages").replace(/\\/g, "/"),
      ],
    });
    watcher.dispose();
  });

  test("stops delivering queued work after the last subscriber leaves", async () => {
    let callback: WatchCallback | null = null;
    const events: WorkspaceFileChangeEvent[] = [];
    const scope = { workspaceId: "workspace-a", rootPath: "/repo" };
    const watcher = new WorkspaceDirectoryWatcher({
      debounceMs: 0,
      watch: (_rootPath, listener) => {
        callback = listener;
        return { close() {} };
      },
    });
    watcher.watch(scope, "renderer", (event) => {
      events.push(event);
    });

    callback?.("change", "src/index.ts");
    watcher.unwatch(scope, "renderer");
    await settleWatcher();

    expect(events).toEqual([]);
  });
});
