import type { PresentationPreviewResult } from "../../../../src/server/presentationPreview";
import type {
  FileChangeVersion,
  WorkspaceFileChangeEvent,
} from "../../../../src/shared/fileVersion";
import { fileChangeVersionsEqual } from "../../../../src/shared/fileVersion";
import type { ReadFileForPreviewOutput } from "./desktopApi";
import { readFileForPreview } from "./desktopCommands";

export type VersionedResource<T> = {
  cacheable?: boolean;
  path: string;
  relatedPaths?: readonly string[];
  value: T;
  version: FileChangeVersion;
};

type ResourceLoader<T> = () => Promise<VersionedResource<T>>;

type CacheLoadOptions<T> = {
  cacheKey: string;
  path: string;
  loader: ResourceLoader<T>;
  force?: boolean;
  signal?: AbortSignal;
};

type CacheEntry<T> = {
  resource: VersionedResource<T>;
  requestedPath: string;
  unlinkRelatedPaths: () => void;
};

type InFlightEntry<T> = {
  generation: number;
  promise: Promise<VersionedResource<T>>;
  requestedPath: string;
};

type FileChangeListener = (event: WorkspaceFileChangeEvent) => void;

export function normalizePreviewResourcePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized)
    ? `${normalized.slice(0, 1).toLowerCase()}${normalized.slice(1)}`
    : normalized;
}

export class FileChangeEventStore {
  private readonly listeners = new Set<FileChangeListener>();
  private readonly relatedPathLinks = new Map<string, Map<string, number>>();
  private readonly revisions = new Map<string, number>();
  private readonly versions = new Map<string, FileChangeVersion | null>();

  subscribe = (listener: FileChangeListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRevision(filePath: string): number {
    return this.revisions.get(normalizePreviewResourcePath(filePath)) ?? 0;
  }

  linkPaths(filePaths: readonly string[]): () => void {
    const normalizedPaths = [...new Set(filePaths.map(normalizePreviewResourcePath))].filter(
      Boolean,
    );
    if (normalizedPaths.length < 2) {
      return () => {};
    }
    const anchor = normalizedPaths[0];
    if (!anchor) {
      return () => {};
    }
    for (const filePath of normalizedPaths.slice(1)) {
      this.incrementPathLink(anchor, filePath);
      this.incrementPathLink(filePath, anchor);
    }
    let linked = true;
    return () => {
      if (!linked) {
        return;
      }
      linked = false;
      for (const filePath of normalizedPaths.slice(1)) {
        this.decrementPathLink(anchor, filePath);
        this.decrementPathLink(filePath, anchor);
      }
    };
  }

  remember(filePath: string, version: FileChangeVersion): void {
    const normalizedPath = normalizePreviewResourcePath(filePath);
    const relatedPaths = this.collectRelatedPaths(normalizedPath);
    for (const relatedPath of relatedPaths) {
      this.versions.set(relatedPath, version);
    }
  }

  publish(event: WorkspaceFileChangeEvent): void {
    const normalizedPath = normalizePreviewResourcePath(event.path);
    const relatedPaths = this.collectRelatedPaths(normalizedPath);
    if (
      event.kind === "changed" &&
      [...relatedPaths].every((filePath) =>
        fileChangeVersionsEqual(this.versions.get(filePath), event.version),
      )
    ) {
      return;
    }
    if (
      event.kind === "deleted" &&
      [...relatedPaths].every((filePath) => this.versions.get(filePath) === null)
    ) {
      return;
    }

    for (const filePath of relatedPaths) {
      this.versions.set(filePath, event.version);
      this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
    }
    for (const filePath of relatedPaths) {
      const normalizedEvent = { ...event, path: filePath };
      for (const listener of this.listeners) {
        listener(normalizedEvent);
      }
    }
  }

  reset(): void {
    this.relatedPathLinks.clear();
    this.revisions.clear();
    this.versions.clear();
  }

  private collectRelatedPaths(filePath: string): Set<string> {
    const collected = new Set([filePath]);
    const pending = [filePath];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      for (const relatedPath of this.relatedPathLinks.get(current)?.keys() ?? []) {
        if (collected.has(relatedPath)) continue;
        collected.add(relatedPath);
        pending.push(relatedPath);
      }
    }
    return collected;
  }

  private incrementPathLink(fromPath: string, toPath: string): void {
    const links = this.relatedPathLinks.get(fromPath) ?? new Map<string, number>();
    links.set(toPath, (links.get(toPath) ?? 0) + 1);
    this.relatedPathLinks.set(fromPath, links);
  }

  private decrementPathLink(fromPath: string, toPath: string): void {
    const links = this.relatedPathLinks.get(fromPath);
    const count = links?.get(toPath);
    if (!links || count === undefined) {
      return;
    }
    if (count > 1) {
      links.set(toPath, count - 1);
      return;
    }
    links.delete(toPath);
    if (links.size === 0) {
      this.relatedPathLinks.delete(fromPath);
    }
  }
}

function createAbortError(): Error {
  const error = new Error("The preview resource request was aborted.");
  error.name = "AbortError";
  return error;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class VersionedResourceCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly generations = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlightEntry<T>>();
  private readonly changes: FileChangeEventStore;
  private readonly maxEntries: number;
  private readonly unsubscribeChanges: () => void;

  constructor(options: { changes: FileChangeEventStore; maxEntries?: number }) {
    this.changes = options.changes;
    this.maxEntries = options.maxEntries ?? 64;
    this.unsubscribeChanges = this.changes.subscribe((event) => {
      this.invalidate(event);
    });
  }

  load(options: CacheLoadOptions<T>): Promise<VersionedResource<T>> {
    if (!options.force) {
      const cached = this.entries.get(options.cacheKey);
      if (cached) {
        this.entries.delete(options.cacheKey);
        this.entries.set(options.cacheKey, cached);
        return awaitWithSignal(Promise.resolve(cached.resource), options.signal);
      }

      const activeLoad = this.inFlight.get(options.cacheKey);
      if (activeLoad) {
        return awaitWithSignal(activeLoad.promise, options.signal);
      }
    } else {
      this.deleteEntry(options.cacheKey);
    }

    const generation = (this.generations.get(options.cacheKey) ?? 0) + 1;
    this.generations.set(options.cacheKey, generation);
    const promise = Promise.resolve()
      .then(options.loader)
      .then((resource) => {
        if (resource.cacheable !== false && this.generations.get(options.cacheKey) === generation) {
          this.deleteEntry(options.cacheKey);
          const unlinkRelatedPaths = this.changes.linkPaths([
            options.path,
            resource.path,
            ...(resource.relatedPaths ?? []),
          ]);
          this.entries.set(options.cacheKey, {
            requestedPath: normalizePreviewResourcePath(options.path),
            resource,
            unlinkRelatedPaths,
          });
          this.changes.remember(options.path, resource.version);
          this.evictOverflow();
        }
        return resource;
      })
      .finally(() => {
        const current = this.inFlight.get(options.cacheKey);
        if (current?.generation === generation) {
          this.inFlight.delete(options.cacheKey);
        }
      });

    this.inFlight.set(options.cacheKey, {
      generation,
      promise,
      requestedPath: normalizePreviewResourcePath(options.path),
    });
    return awaitWithSignal(promise, options.signal);
  }

  clear(): void {
    for (const cacheKey of this.inFlight.keys()) {
      this.bumpGeneration(cacheKey);
    }
    this.inFlight.clear();
    for (const entry of this.entries.values()) {
      entry.unlinkRelatedPaths();
    }
    this.entries.clear();
  }

  dispose(): void {
    this.clear();
    this.unsubscribeChanges();
  }

  private invalidate(event: WorkspaceFileChangeEvent): void {
    const eventPath = normalizePreviewResourcePath(event.path);
    for (const [cacheKey, entry] of this.entries) {
      const resourcePath = normalizePreviewResourcePath(entry.resource.path);
      if (entry.requestedPath !== eventPath && resourcePath !== eventPath) {
        continue;
      }
      if (
        event.kind === "changed" &&
        event.version &&
        fileChangeVersionsEqual(entry.resource.version, event.version)
      ) {
        continue;
      }
      this.deleteEntry(cacheKey);
      this.bumpGeneration(cacheKey);
    }

    for (const [cacheKey, entry] of this.inFlight) {
      if (entry.requestedPath === eventPath) {
        this.inFlight.delete(cacheKey);
        this.bumpGeneration(cacheKey);
      }
    }
  }

  private bumpGeneration(cacheKey: string): void {
    this.generations.set(cacheKey, (this.generations.get(cacheKey) ?? 0) + 1);
  }

  private deleteEntry(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return;
    }
    entry.unlinkRelatedPaths();
    this.entries.delete(cacheKey);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.deleteEntry(oldestKey);
    }
  }
}

export type BlobResourceLease = {
  url: string;
  release(): void;
};

type BlobResourceInput = {
  bytes: Uint8Array;
  mime: string;
  path: string;
  version: FileChangeVersion;
};

type BlobResourceEntry = {
  owners: number;
  url: string;
};

export class BlobResourceStore {
  private readonly entries = new Map<string, BlobResourceEntry>();
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;

  constructor(options?: {
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (url: string) => void;
  }) {
    this.createObjectUrl = options?.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options?.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  acquire(input: BlobResourceInput): BlobResourceLease {
    const cacheKey = [
      normalizePreviewResourcePath(input.path),
      input.version.fingerprint,
      input.mime,
    ].join("\0");
    let entry = this.entries.get(cacheKey);
    if (!entry) {
      const bytes = input.bytes.slice();
      entry = {
        owners: 0,
        url: this.createObjectUrl(new Blob([bytes.buffer], { type: input.mime })),
      };
      this.entries.set(cacheKey, entry);
    }
    entry.owners += 1;

    let released = false;
    return {
      url: entry.url,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const current = this.entries.get(cacheKey);
        if (!current) {
          return;
        }
        current.owners -= 1;
        if (current.owners > 0) {
          return;
        }
        this.entries.delete(cacheKey);
        this.revokeObjectUrl(current.url);
      },
    };
  }
}

export const workspaceFileChangeEvents = new FileChangeEventStore();
export const previewBlobResources = new BlobResourceStore();

const rawFilePreviewCache = new VersionedResourceCache<ReadFileForPreviewOutput>({
  changes: workspaceFileChangeEvents,
});
const presentationPreviewCache = new VersionedResourceCache<PresentationPreviewResult>({
  changes: workspaceFileChangeEvents,
});
const UNCACHEABLE_VERSION: FileChangeVersion = {
  modifiedAtMs: 0,
  changeTimeMs: 0,
  size: 0,
  fingerprint: "uncacheable",
};

export async function loadFilePreviewResource(options: {
  path: string;
  maxBytes?: number;
  force?: boolean;
  signal?: AbortSignal;
  reader?: (input: { path: string; maxBytes?: number }) => Promise<ReadFileForPreviewOutput>;
}): Promise<VersionedResource<ReadFileForPreviewOutput>> {
  const maxBytesKey = options.maxBytes ?? "default";
  return await rawFilePreviewCache.load({
    cacheKey: `${normalizePreviewResourcePath(options.path)}\0${maxBytesKey}`,
    path: options.path,
    force: options.force,
    signal: options.signal,
    loader: async () => {
      const result = await (options.reader ?? readFileForPreview)({
        path: options.path,
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      });
      return {
        path: result.path,
        value: result,
        version: result.version,
      };
    },
  });
}

export async function loadTextPreviewResource(options: {
  path: string;
  maxBytes?: number;
  force?: boolean;
  signal?: AbortSignal;
  reader?: (input: { path: string; maxBytes?: number }) => Promise<ReadFileForPreviewOutput>;
}): Promise<VersionedResource<string>> {
  const resource = await loadFilePreviewResource(options);
  return {
    path: resource.path,
    value: new TextDecoder("utf-8", { fatal: false }).decode(resource.value.bytes),
    version: resource.version,
  };
}

export async function loadPresentationPreviewResource(options: {
  path: string;
  workspaceId: string;
  force?: boolean;
  signal?: AbortSignal;
  loader: (path: string) => Promise<PresentationPreviewResult>;
}): Promise<VersionedResource<PresentationPreviewResult>> {
  return await presentationPreviewCache.load({
    cacheKey: `${options.workspaceId}\0${normalizePreviewResourcePath(options.path)}`,
    path: options.path,
    force: options.force,
    signal: options.signal,
    loader: async () => {
      const result = await options.loader(options.path);
      if (!result.ok) {
        return {
          cacheable: false,
          path: options.path,
          value: result,
          version: UNCACHEABLE_VERSION,
        };
      }
      return {
        path: result.path,
        relatedPaths: result.dependencies,
        value: result,
        version: result.version,
      };
    },
  });
}

export const __internalFilePreviewResources = {
  clear(): void {
    rawFilePreviewCache.clear();
    presentationPreviewCache.clear();
    workspaceFileChangeEvents.reset();
  },
};
