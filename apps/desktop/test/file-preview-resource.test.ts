import { describe, expect, mock, test } from "bun:test";

import type { FileChangeVersion } from "../../../src/shared/fileVersion";
import {
  BlobResourceStore,
  FileChangeEventStore,
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
