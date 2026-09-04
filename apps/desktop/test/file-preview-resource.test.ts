import { describe, expect, mock, test } from "bun:test";

import type { FileChangeVersion } from "../../../src/shared/fileVersion";
import {
  __internalFilePreviewResources,
  BlobResourceStore,
  FileChangeEventStore,
  loadPresentationPreviewResource,
  VersionedResourceCache,
} from "../src/lib/filePreviewResource";

const VERSION_ONE: FileChangeVersion = {
  modifiedAtMs: 1,
  changeTimeMs: 1,
  size: 4,
  fingerprint: "1:1:4",
};

const VERSION_TWO: FileChangeVersion = {
  modifiedAtMs: 2,
  changeTimeMs: 2,
  size: 4,
  fingerprint: "2:2:4",
};

describe("presentation preview retention", () => {
  test("the production cache evicts older slide payloads under memory pressure", async () => {
    __internalFilePreviewResources.clear();
    const loads = new Map<string, number>();
    const image = "A".repeat(6 * 1024 * 1024);
    const load = (name: string) =>
      loadPresentationPreviewResource({
        workspaceId: "preview-budget",
        path: `/workspace/${name}.pptx`,
        loader: async (path) => {
          loads.set(name, (loads.get(name) ?? 0) + 1);
          return {
            ok: true,
            dependencies: [],
            path,
            version: VERSION_ONE,
            slides: [{ slideIndex: 0, pngBase64: image }],
          };
        },
      });
    try {
      await load("first");
      await load("second");
      await load("first");
      await load("third");
      await load("first");
      await load("third");
      await load("second");
      expect(Object.fromEntries(loads)).toEqual({ first: 1, second: 2, third: 1 });
    } finally {
      __internalFilePreviewResources.clear();
    }
  });

  test("an oversized deck is returned for display but not retained", async () => {
    __internalFilePreviewResources.clear();
    const image = "A".repeat(17 * 1024 * 1024);
    const loader = mock(async (path: string) => ({
      ok: true as const,
      dependencies: [],
      path,
      version: VERSION_ONE,
      slides: [{ slideIndex: 0, pngBase64: image }],
    }));
    try {
      const options = { workspaceId: "preview-budget", path: "/oversized.pptx", loader };
      const first = await loadPresentationPreviewResource(options);
      const second = await loadPresentationPreviewResource(options);
      expect(first.value).toEqual(second.value);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      __internalFilePreviewResources.clear();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("VersionedResourceCache", () => {
  test("coalesces concurrent loads and reuses the cached path version", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const pending = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const loader = mock(async () => await pending.promise);

    const first = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    const second = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });

    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve({ path: "/workspace/a.md", value: "alpha", version: VERSION_ONE });
    await expect(first).resolves.toMatchObject({ value: "alpha", version: VERSION_ONE });
    await expect(second).resolves.toMatchObject({ value: "alpha", version: VERSION_ONE });

    await expect(
      cache.load({
        cacheKey: "/workspace/a.md:text",
        path: "/workspace/a.md",
        loader,
      }),
    ).resolves.toMatchObject({ value: "alpha" });
    expect(loader).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  test("aborts one consumer without cancelling a shared in-flight load", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const pending = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const loader = mock(async () => await pending.promise);
    const controller = new AbortController();

    const cancelled = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
      signal: controller.signal,
    });
    const active = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    controller.abort();
    pending.resolve({ path: "/workspace/a.md", value: "alpha", version: VERSION_ONE });

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(active).resolves.toMatchObject({ value: "alpha" });
    expect(loader).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  test("evicts least-recently-used previews when their total bytes exceed the budget", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({
      changes,
      byteBudget: { maxBytes: 8, sizeOf: (value) => value.length },
    });
    const loadCounts = new Map<string, number>();
    const load = (name: string) =>
      cache.load({
        cacheKey: name,
        path: `/workspace/${name}`,
        loader: async () => {
          loadCounts.set(name, (loadCounts.get(name) ?? 0) + 1);
          return { path: `/workspace/${name}`, value: "data", version: VERSION_ONE };
        },
      });

    await load("a");
    await load("b");
    await load("a");
    await load("c");
    await load("a");
    await load("c");
    await load("b");

    expect(Object.fromEntries(loadCounts)).toEqual({ a: 1, b: 2, c: 1 });
    cache.dispose();
  });

  test("returns oversized previews without retaining them or evicting smaller previews", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({
      changes,
      byteBudget: { maxBytes: 4, sizeOf: (value) => value.length },
    });
    const smallLoader = mock(async () => ({
      path: "/workspace/small",
      value: "data",
      version: VERSION_ONE,
    }));
    const largeLoader = mock(async () => ({
      path: "/workspace/large",
      value: "oversized",
      version: VERSION_TWO,
    }));
    const loadSmall = () =>
      cache.load({ cacheKey: "small", path: "/workspace/small", loader: smallLoader });
    const loadLarge = () =>
      cache.load({ cacheKey: "large", path: "/workspace/large", loader: largeLoader });

    await loadSmall();
    expect((await loadLarge()).value).toBe("oversized");
    expect((await loadLarge()).value).toBe("oversized");
    await loadSmall();

    expect(largeLoader).toHaveBeenCalledTimes(2);
    expect(smallLoader).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  test("reclaims retained bytes when previews are invalidated, replaced, or cleared", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({
      changes,
      byteBudget: { maxBytes: 8, sizeOf: (value) => value.length },
    });
    const loadCounts = new Map<string, number>();
    const load = (name: string, value: string, force = false) =>
      cache.load({
        cacheKey: name,
        path: `/workspace/${name}`,
        force,
        loader: async () => {
          loadCounts.set(name, (loadCounts.get(name) ?? 0) + 1);
          return { path: `/workspace/${name}`, value, version: VERSION_ONE };
        },
      });

    await load("a", "1234");
    await load("b", "1234");
    changes.publish({ kind: "deleted", path: "/workspace/b", version: null });
    await load("c", "1234");
    await load("c", "12", true);
    await load("d", "12");
    await load("a", "1234");
    expect(loadCounts.get("a")).toBe(1);

    cache.clear();
    await load("e", "12345678");
    await load("e", "12345678");
    expect(loadCounts.get("e")).toBe(1);
    cache.dispose();
  });

  test("invalidates cached data and prevents an older in-flight result from being retained", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const oldLoad = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const newLoad = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const loader = mock()
      .mockImplementationOnce(async () => await oldLoad.promise)
      .mockImplementationOnce(async () => await newLoad.promise);

    const stale = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    changes.publish({ kind: "changed", path: "/workspace/a.md", version: VERSION_TWO });
    oldLoad.resolve({ path: "/workspace/a.md", value: "old", version: VERSION_ONE });
    await expect(stale).resolves.toMatchObject({ value: "old" });

    const fresh = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    newLoad.resolve({ path: "/workspace/a.md", value: "new", version: VERSION_TWO });
    await expect(fresh).resolves.toMatchObject({ value: "new" });
    expect(loader).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  test("starts a fresh load immediately when a change invalidates an in-flight request", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const oldLoad = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const newLoad = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const loader = mock()
      .mockImplementationOnce(async () => await oldLoad.promise)
      .mockImplementationOnce(async () => await newLoad.promise);

    const stale = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    await Promise.resolve();
    changes.publish({ kind: "changed", path: "/workspace/a.md", version: VERSION_TWO });
    const fresh = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    await Promise.resolve();

    expect(loader).toHaveBeenCalledTimes(2);
    newLoad.resolve({ path: "/workspace/a.md", value: "new", version: VERSION_TWO });
    await expect(fresh).resolves.toMatchObject({ value: "new" });
    oldLoad.resolve({ path: "/workspace/a.md", value: "old", version: VERSION_ONE });
    await expect(stale).resolves.toMatchObject({ value: "old" });

    await expect(
      cache.load({
        cacheKey: "/workspace/a.md:text",
        path: "/workspace/a.md",
        loader,
      }),
    ).resolves.toMatchObject({ value: "new" });
    expect(loader).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  test("starts a fresh load after clearing an unresolved request", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const oldLoad = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const newLoad = deferred<{
      path: string;
      value: string;
      version: FileChangeVersion;
    }>();
    const loader = mock()
      .mockImplementationOnce(async () => await oldLoad.promise)
      .mockImplementationOnce(async () => await newLoad.promise);

    const stale = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    await Promise.resolve();
    cache.clear();
    const fresh = cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader,
    });
    await Promise.resolve();

    expect(loader).toHaveBeenCalledTimes(2);
    newLoad.resolve({ path: "/workspace/a.md", value: "new", version: VERSION_TWO });
    await expect(fresh).resolves.toMatchObject({ value: "new" });
    oldLoad.resolve({ path: "/workspace/a.md", value: "old", version: VERSION_ONE });
    await expect(stale).resolves.toMatchObject({ value: "old" });

    await expect(
      cache.load({
        cacheKey: "/workspace/a.md:text",
        path: "/workspace/a.md",
        loader,
      }),
    ).resolves.toMatchObject({ value: "new" });
    cache.dispose();
  });

  test("does not publish another revision for an already-cached file version", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const listener = mock(() => {});
    changes.subscribe(listener);

    await cache.load({
      cacheKey: "/workspace/a.md:text",
      path: "/workspace/a.md",
      loader: async () => ({
        path: "/workspace/a.md",
        value: "alpha",
        version: VERSION_ONE,
      }),
    });
    changes.publish({ kind: "changed", path: "/workspace/a.md", version: VERSION_ONE });

    expect(listener).not.toHaveBeenCalled();
    expect(changes.getRevision("/workspace/a.md")).toBe(0);
    cache.dispose();
  });

  test("invalidates every requested, canonical, dependency, and case alias", async () => {
    const changes = new FileChangeEventStore();
    const cache = new VersionedResourceCache<string>({ changes });
    const requestedPath = "/workspace/Report.md";
    const caseAliasPath = "/workspace/report.md";
    const canonicalPath = "/workspace/source.md";
    const dependencyPath = "/workspace/preview/slide-1.png";
    const loader = mock(async () => ({
      path: canonicalPath,
      relatedPaths: [dependencyPath],
      value: "old",
      version: VERSION_ONE,
    }));

    await cache.load({
      cacheKey: `${requestedPath}:text`,
      path: requestedPath,
      loader,
    });
    await cache.load({
      cacheKey: `${caseAliasPath}:text`,
      path: caseAliasPath,
      loader,
    });
    changes.publish({
      kind: "changed",
      path: dependencyPath,
      version: VERSION_TWO,
    });

    expect(changes.getRevision(requestedPath)).toBe(1);
    expect(changes.getRevision(caseAliasPath)).toBe(1);
    expect(changes.getRevision(canonicalPath)).toBe(1);
    expect(changes.getRevision(dependencyPath)).toBe(1);

    await cache.load({
      cacheKey: `${requestedPath}:text`,
      path: requestedPath,
      loader,
    });
    expect(loader).toHaveBeenCalledTimes(3);
    cache.dispose();
  });
});

describe("BlobResourceStore", () => {
  test("shares one URL and revokes it only after the last owner releases", () => {
    const createObjectUrl = mock(() => "blob:preview");
    const revokeObjectUrl = mock(() => {});
    const blobs = new BlobResourceStore({ createObjectUrl, revokeObjectUrl });
    const input = {
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      path: "/workspace/image.png",
      version: VERSION_ONE,
    };

    const first = blobs.acquire(input);
    const second = blobs.acquire(input);
    expect(first.url).toBe("blob:preview");
    expect(second.url).toBe("blob:preview");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);

    first.release();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    second.release();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview");
  });
});
