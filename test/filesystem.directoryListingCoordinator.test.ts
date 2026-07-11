import { describe, expect, test } from "bun:test";

import {
  DirectoryListingCoordinator,
  StaleDirectoryRequestError,
} from "../src/filesystem/directoryListingCoordinator";
import { createWorkspaceFileChangeEvent } from "../src/filesystem/workspaceFileEvents";

type Entry = {
  path: string;
  size: number;
};

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function entriesEqual(left: Entry, right: Entry): boolean {
  return left.path === right.path && left.size === right.size;
}

describe("DirectoryListingCoordinator", () => {
  test("deduplicates concurrent callers for one workspace path", async () => {
    const pending = deferred<Entry[]>();
    let reads = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      isEntryEqual: entriesEqual,
      readDirectory: async () => {
        reads += 1;
        return await pending.promise;
      },
    });

    const first = coordinator.read({
      workspaceId: "workspace-a",
      path: "/repo/src",
      includeHidden: false,
    });
    const second = coordinator.read({
      workspaceId: "workspace-a",
      path: "/repo/src/",
      includeHidden: false,
    });

    expect(reads).toBe(1);
    pending.resolve([{ path: "/repo/src/index.ts", size: 10 }]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    expect(coordinator.getDiagnostics()).toMatchObject({
      reads: 1,
      deduplicatedRequests: 1,
      maxConcurrentReads: 1,
    });
  });

  test("keeps request deduplication scoped by workspace", async () => {
    const pendingByWorkspace = new Map<string, ReturnType<typeof deferred<Entry[]>>>();
    let activeReads = 0;
    let maxActiveReads = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      isEntryEqual: entriesEqual,
      readDirectory: async ({ workspaceId }) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        const pending = deferred<Entry[]>();
        pendingByWorkspace.set(workspaceId, pending);
        try {
          return await pending.promise;
        } finally {
          activeReads -= 1;
        }
      },
    });

    const first = coordinator.read({
      workspaceId: "workspace-a",
      path: "/shared/path",
      includeHidden: false,
    });
    const second = coordinator.read({
      workspaceId: "workspace-b",
      path: "/shared/path",
      includeHidden: false,
    });

    expect(maxActiveReads).toBe(2);
    pendingByWorkspace.get("workspace-a")?.resolve([]);
    pendingByWorkspace.get("workspace-b")?.resolve([]);
    await Promise.all([first, second]);
  });

  test("rejects a stale generation before starting the queued replacement", async () => {
    const requests: Array<ReturnType<typeof deferred<Entry[]>>> = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      isEntryEqual: entriesEqual,
      readDirectory: async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        const pending = deferred<Entry[]>();
        requests.push(pending);
        try {
          return await pending.promise;
        } finally {
          activeReads -= 1;
        }
      },
    });
    const input = {
      workspaceId: "workspace-a",
      path: "/repo",
      includeHidden: false,
    };

    const stale = coordinator.read(input);
    coordinator.invalidate({ workspaceId: input.workspaceId, path: input.path });
    const latest = coordinator.read(input);
    expect(requests).toHaveLength(1);

    requests[0]?.resolve([{ path: "/repo/old.ts", size: 1 }]);
    await expect(stale).rejects.toBeInstanceOf(StaleDirectoryRequestError);
    await Promise.resolve();
    expect(requests).toHaveLength(2);

    requests[1]?.resolve([{ path: "/repo/latest.ts", size: 2 }]);
    await expect(latest).resolves.toEqual([{ path: "/repo/latest.ts", size: 2 }]);
    expect(maxActiveReads).toBe(1);
    expect(coordinator.getDiagnostics()).toMatchObject({
      invalidations: 1,
      staleResults: 1,
      reads: 2,
    });
  });

  test("preserves unchanged cached entry identities across an invalidation", async () => {
    let revision = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      isEntryEqual: entriesEqual,
      readDirectory: async () => [
        { path: "/repo/stable.ts", size: 10 },
        { path: "/repo/changed.ts", size: revision },
      ],
    });
    const input = {
      workspaceId: "workspace-a",
      path: "/repo",
      includeHidden: false,
    };

    const first = await coordinator.read(input);
    revision = 1;
    coordinator.invalidate({ workspaceId: input.workspaceId, path: input.path });
    const second = await coordinator.read(input);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect((await coordinator.read(input))[0]).toBe(first[0]);
    expect(coordinator.getDiagnostics().cacheHits).toBe(1);
  });

  test("preserves new ordering while reusing unchanged entries", async () => {
    let reversed = false;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      isEntryEqual: entriesEqual,
      readDirectory: async () => {
        const entries = [
          { path: "/repo/a.ts", size: 1 },
          { path: "/repo/b.ts", size: 2 },
        ];
        return reversed ? entries.reverse() : entries;
      },
    });
    const input = {
      workspaceId: "workspace-a",
      path: "/repo",
      includeHidden: false,
    };

    const first = await coordinator.read(input);
    reversed = true;
    coordinator.invalidate({ workspaceId: input.workspaceId, path: input.path });
    const second = await coordinator.read(input);

    expect(second.map((entry) => entry.path)).toEqual(["/repo/b.ts", "/repo/a.ts"]);
    expect(second[0]).toBe(first[1]);
    expect(second[1]).toBe(first[0]);
  });

  test("can deduplicate physical reads without caching completed results", async () => {
    let reads = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      cacheResults: false,
      readDirectory: async () => {
        reads += 1;
        return [];
      },
    });
    const input = {
      workspaceId: "workspace-a",
      path: "/repo",
      includeHidden: false,
    };

    await coordinator.read(input);
    await coordinator.read(input);

    expect(reads).toBe(2);
    expect(coordinator.getDiagnostics().cacheHits).toBe(0);
  });

  test("recursive invalidation leaves sibling directory caches intact", async () => {
    let reads = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      readDirectory: async ({ path }) => {
        reads += 1;
        return [{ path: `${path}/file.ts`, size: reads }];
      },
    });

    await coordinator.read({
      workspaceId: "workspace-a",
      path: "/repo/src/nested",
      includeHidden: false,
    });
    const sibling = await coordinator.read({
      workspaceId: "workspace-a",
      path: "/repo/packages",
      includeHidden: false,
    });
    coordinator.invalidate({
      workspaceId: "workspace-a",
      path: "/repo/src",
      recursive: true,
    });

    await coordinator.read({
      workspaceId: "workspace-a",
      path: "/repo/src/nested",
      includeHidden: false,
    });
    expect(
      await coordinator.read({
        workspaceId: "workspace-a",
        path: "/repo/packages",
        includeHidden: false,
      }),
    ).toBe(sibling);
    expect(reads).toBe(3);
  });

  test("clears one workspace subtree without retaining stale entry identities", async () => {
    let reads = 0;
    const coordinator = new DirectoryListingCoordinator<Entry>({
      isEntryEqual: entriesEqual,
      readDirectory: async ({ path }) => {
        reads += 1;
        return [{ path: `${path}/file.ts`, size: reads }];
      },
    });
    const scopedInput = {
      workspaceId: "workspace-a",
      path: "/repo/src",
      includeHidden: false,
    };
    const siblingInput = {
      workspaceId: "workspace-a",
      path: "/repo/packages",
      includeHidden: false,
    };
    const otherWorkspaceInput = {
      workspaceId: "workspace-b",
      path: "/repo/src",
      includeHidden: false,
    };

    const firstScoped = await coordinator.read(scopedInput);
    const sibling = await coordinator.read(siblingInput);
    const otherWorkspace = await coordinator.read(otherWorkspaceInput);
    coordinator.clearScope({
      workspaceId: scopedInput.workspaceId,
      path: scopedInput.path,
      recursive: true,
    });

    const revalidatedScoped = await coordinator.read(scopedInput);
    expect(revalidatedScoped).not.toBe(firstScoped);
    expect(await coordinator.read(siblingInput)).toBe(sibling);
    expect(await coordinator.read(otherWorkspaceInput)).toBe(otherWorkspace);
    expect(reads).toBe(4);
  });

  test("rejects an active read when its scope is cleared and serializes revalidation", async () => {
    const requests: Array<ReturnType<typeof deferred<Entry[]>>> = [];
    const coordinator = new DirectoryListingCoordinator<Entry>({
      readDirectory: async () => {
        const pending = deferred<Entry[]>();
        requests.push(pending);
        return await pending.promise;
      },
    });
    const input = {
      workspaceId: "workspace-a",
      path: "/repo",
      includeHidden: false,
    };

    const stale = coordinator.read(input);
    coordinator.clearScope({ workspaceId: input.workspaceId, path: input.path });
    const latest = coordinator.read(input);
    expect(requests).toHaveLength(1);

    requests[0]?.resolve([{ path: "/repo/stale.ts", size: 1 }]);
    await expect(stale).rejects.toBeInstanceOf(StaleDirectoryRequestError);
    await Promise.resolve();
    expect(requests).toHaveLength(2);

    requests[1]?.resolve([{ path: "/repo/current.ts", size: 2 }]);
    await expect(latest).resolves.toEqual([{ path: "/repo/current.ts", size: 2 }]);
    expect(coordinator.getDiagnostics().maxConcurrentReads).toBe(1);
  });
});

describe("workspace file change invalidation", () => {
  test("add invalidates only the containing directory", () => {
    expect(
      createWorkspaceFileChangeEvent({
        workspaceId: "workspace-a",
        rootPath: "/repo",
        kind: "add",
        changedPaths: ["/repo/src/new.ts"],
      }),
    ).toEqual({
      workspaceId: "workspace-a",
      rootPath: "/repo",
      kind: "add",
      changedPaths: ["/repo/src/new.ts"],
      affectedDirectoryPaths: ["/repo/src"],
      invalidatedSubtreePaths: [],
    });
  });

  test("remove invalidates the containing directory and removed subtree", () => {
    expect(
      createWorkspaceFileChangeEvent({
        workspaceId: "workspace-a",
        rootPath: "/repo",
        kind: "remove",
        changedPaths: ["/repo/src/removed"],
      }),
    ).toMatchObject({
      affectedDirectoryPaths: ["/repo/src"],
      invalidatedSubtreePaths: ["/repo/src/removed"],
    });
  });

  test("rename invalidates both parents and both cached subtree paths", () => {
    expect(
      createWorkspaceFileChangeEvent({
        workspaceId: "workspace-a",
        rootPath: "/repo",
        kind: "rename",
        changedPaths: ["/repo/src/old", "/repo/packages/new"],
      }),
    ).toMatchObject({
      affectedDirectoryPaths: ["/repo/src", "/repo/packages"],
      invalidatedSubtreePaths: ["/repo/src/old", "/repo/packages/new"],
    });
  });

  test("modify invalidates only the containing directory metadata", () => {
    expect(
      createWorkspaceFileChangeEvent({
        workspaceId: "workspace-a",
        rootPath: "/repo",
        kind: "modify",
        changedPaths: ["/repo/src/index.ts"],
      }),
    ).toMatchObject({
      affectedDirectoryPaths: ["/repo/src"],
      invalidatedSubtreePaths: [],
    });
  });

  test("root events remain scoped to the root path", () => {
    expect(
      createWorkspaceFileChangeEvent({
        workspaceId: "workspace-a",
        rootPath: "/",
        kind: "modify",
        changedPaths: ["/repo/index.ts"],
      }),
    ).toMatchObject({
      changedPaths: ["/repo/index.ts"],
      affectedDirectoryPaths: ["/repo"],
    });
  });
});
