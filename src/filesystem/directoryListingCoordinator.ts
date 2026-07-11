export type DirectoryListingInput = {
  workspaceId: string;
  path: string;
  includeHidden: boolean;
};

export type DirectoryListingInvalidation = {
  workspaceId: string;
  path: string;
  recursive?: boolean;
};

export type DirectoryListingDiagnostics = {
  reads: number;
  cacheHits: number;
  deduplicatedRequests: number;
  invalidations: number;
  staleResults: number;
  concurrentReads: number;
  maxConcurrentReads: number;
};

type DirectoryListingCoordinatorOptions<Entry> = {
  readDirectory(input: DirectoryListingInput): Promise<Entry[]>;
  cacheResults?: boolean;
  entryKey?: (entry: Entry, index: number) => string;
  isEntryEqual?: (left: Entry, right: Entry) => boolean;
};

type CachedListing<Entry> = {
  entries: Entry[];
  generation: number;
  includeHidden: boolean;
};

type ActiveListing<Entry> = {
  generation: number;
  includeHidden: boolean;
  promise: Promise<Entry[]>;
};

type DirectorySlot<Entry> = {
  active?: ActiveListing<Entry>;
  cached?: CachedListing<Entry>;
  generation: number;
  lastEntries?: Entry[];
  queuedByRequest: Map<string, Promise<Entry[]>>;
  queueTail?: Promise<void>;
};

function defaultDiagnostics(): DirectoryListingDiagnostics {
  return {
    reads: 0,
    cacheHits: 0,
    deduplicatedRequests: 0,
    invalidations: 0,
    staleResults: 0,
    concurrentReads: 0,
    maxConcurrentReads: 0,
  };
}

export function normalizeDirectoryListingPath(input: string): string {
  if (!input) return "";
  const normalized = input.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function isSameOrDescendantPath(path: string, ancestor: string): boolean {
  if (path === ancestor) {
    return true;
  }
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return path.startsWith(prefix);
}

function defaultEntryKey<Entry>(entry: Entry, index: number): string {
  if (
    typeof entry === "object" &&
    entry !== null &&
    "path" in entry &&
    typeof entry.path === "string"
  ) {
    return normalizeDirectoryListingPath(entry.path);
  }
  return String(index);
}

export class StaleDirectoryRequestError extends Error {
  readonly workspaceId: string;
  readonly path: string;
  readonly generation: number;

  constructor(input: DirectoryListingInput, generation: number) {
    super(`Directory request became stale: ${input.workspaceId}:${input.path}`);
    this.name = "StaleDirectoryRequestError";
    this.workspaceId = input.workspaceId;
    this.path = input.path;
    this.generation = generation;
  }
}

export function isStaleDirectoryRequestError(error: unknown): error is StaleDirectoryRequestError {
  return error instanceof StaleDirectoryRequestError;
}

export class DirectoryListingCoordinator<Entry> {
  private readonly cacheResults: boolean;
  private readonly readDirectory: (input: DirectoryListingInput) => Promise<Entry[]>;
  private readonly entryKey: (entry: Entry, index: number) => string;
  private readonly isEntryEqual: (left: Entry, right: Entry) => boolean;
  private readonly slots = new Map<string, DirectorySlot<Entry>>();
  private diagnostics = defaultDiagnostics();

  constructor(options: DirectoryListingCoordinatorOptions<Entry>) {
    this.cacheResults = options.cacheResults ?? true;
    this.readDirectory = options.readDirectory;
    this.entryKey = options.entryKey ?? defaultEntryKey;
    this.isEntryEqual = options.isEntryEqual ?? Object.is;
  }

  read(input: DirectoryListingInput): Promise<Entry[]> {
    const normalizedInput = {
      ...input,
      path: normalizeDirectoryListingPath(input.path),
    };
    const slot = this.getSlot(normalizedInput.workspaceId, normalizedInput.path);
    const cached = slot.cached;
    if (
      cached &&
      cached.generation === slot.generation &&
      cached.includeHidden === normalizedInput.includeHidden
    ) {
      this.diagnostics.cacheHits += 1;
      return Promise.resolve(cached.entries);
    }

    const active = slot.active;
    if (
      active &&
      active.generation === slot.generation &&
      active.includeHidden === normalizedInput.includeHidden
    ) {
      this.diagnostics.deduplicatedRequests += 1;
      return active.promise;
    }

    if (
      (active && active.generation === slot.generation) ||
      (cached &&
        cached.generation === slot.generation &&
        cached.includeHidden !== normalizedInput.includeHidden)
    ) {
      this.advanceGeneration(slot);
    }

    const generation = slot.generation;
    const requestKey = `${generation}:${normalizedInput.includeHidden ? "hidden" : "visible"}`;
    const queued = slot.queuedByRequest.get(requestKey);
    if (queued) {
      this.diagnostics.deduplicatedRequests += 1;
      return queued;
    }

    if (!slot.active && !slot.queueTail) {
      return this.startRead(slot, normalizedInput, generation);
    }

    const predecessor =
      slot.queueTail ??
      slot.active?.promise.then(
        () => undefined,
        () => undefined,
      );
    if (!predecessor) {
      return this.startRead(slot, normalizedInput, generation);
    }

    const request = predecessor.then(() => {
      if (slot.generation !== generation) {
        throw new StaleDirectoryRequestError(normalizedInput, generation);
      }
      const current = slot.active;
      if (
        current &&
        current.generation === generation &&
        current.includeHidden === normalizedInput.includeHidden
      ) {
        this.diagnostics.deduplicatedRequests += 1;
        return current.promise;
      }
      return this.startRead(slot, normalizedInput, generation);
    });
    const tail = request.then(
      () => undefined,
      () => undefined,
    );
    slot.queuedByRequest.set(requestKey, request);
    slot.queueTail = tail;
    void tail.then(() => {
      if (slot.queuedByRequest.get(requestKey) === request) {
        slot.queuedByRequest.delete(requestKey);
      }
      if (slot.queueTail === tail) {
        slot.queueTail = undefined;
      }
    });
    return request;
  }

  invalidate(input: DirectoryListingInvalidation): void {
    this.diagnostics.invalidations += 1;
    const normalizedPath = normalizeDirectoryListingPath(input.path);
    let matched = false;
    for (const [key, slot] of this.slots) {
      const separator = key.indexOf("\0");
      const workspaceId = key.slice(0, separator);
      const path = key.slice(separator + 1);
      const pathMatches =
        path === normalizedPath ||
        (input.recursive === true && isSameOrDescendantPath(path, normalizedPath));
      if (workspaceId !== input.workspaceId || !pathMatches) {
        continue;
      }
      matched = true;
      this.advanceGeneration(slot);
    }
    if (!matched) {
      this.advanceGeneration(this.getSlot(input.workspaceId, normalizedPath));
    }
  }

  invalidatePathAcrossWorkspaces(path: string, recursive = false): void {
    const normalizedPath = normalizeDirectoryListingPath(path);
    const workspaceIds = new Set<string>();
    for (const key of this.slots.keys()) {
      const separator = key.indexOf("\0");
      const workspaceId = key.slice(0, separator);
      const slotPath = key.slice(separator + 1);
      if (
        slotPath === normalizedPath ||
        (recursive && isSameOrDescendantPath(slotPath, normalizedPath))
      ) {
        workspaceIds.add(workspaceId);
      }
    }
    for (const workspaceId of workspaceIds) {
      this.invalidate({ workspaceId, path: normalizedPath, recursive });
    }
  }

  clearScope(input: DirectoryListingInvalidation): void {
    const normalizedPath = normalizeDirectoryListingPath(input.path);
    for (const [key, slot] of this.slots) {
      const separator = key.indexOf("\0");
      const workspaceId = key.slice(0, separator);
      const path = key.slice(separator + 1);
      const pathMatches =
        path === normalizedPath ||
        (input.recursive === true && isSameOrDescendantPath(path, normalizedPath));
      if (workspaceId !== input.workspaceId || !pathMatches) {
        continue;
      }
      this.advanceGeneration(slot);
      slot.lastEntries = undefined;
      if (!slot.active && !slot.queueTail) {
        this.slots.delete(key);
      }
    }
  }

  clearWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}\0`;
    for (const [key, slot] of this.slots) {
      if (key.startsWith(prefix)) {
        this.advanceGeneration(slot);
        slot.lastEntries = undefined;
        if (!slot.active && !slot.queueTail) {
          this.slots.delete(key);
        }
      }
    }
  }

  getDiagnostics(): DirectoryListingDiagnostics {
    return { ...this.diagnostics };
  }

  resetDiagnostics(): void {
    const concurrentReads = this.diagnostics.concurrentReads;
    this.diagnostics = {
      ...defaultDiagnostics(),
      concurrentReads,
      maxConcurrentReads: concurrentReads,
    };
  }

  clear(): void {
    this.slots.clear();
    this.diagnostics = defaultDiagnostics();
  }

  private advanceGeneration(slot: DirectorySlot<Entry>): void {
    slot.generation += 1;
    slot.cached = undefined;
  }

  private getSlot(workspaceId: string, path: string): DirectorySlot<Entry> {
    const key = `${workspaceId}\0${path}`;
    const existing = this.slots.get(key);
    if (existing) {
      return existing;
    }
    const slot: DirectorySlot<Entry> = {
      generation: 0,
      queuedByRequest: new Map(),
    };
    this.slots.set(key, slot);
    return slot;
  }

  private startRead(
    slot: DirectorySlot<Entry>,
    input: DirectoryListingInput,
    generation: number,
  ): Promise<Entry[]> {
    this.diagnostics.reads += 1;
    this.diagnostics.concurrentReads += 1;
    this.diagnostics.maxConcurrentReads = Math.max(
      this.diagnostics.maxConcurrentReads,
      this.diagnostics.concurrentReads,
    );

    let request: Promise<Entry[]>;
    request = this.readDirectory(input)
      .then((entries) => {
        if (slot.generation !== generation) {
          this.diagnostics.staleResults += 1;
          throw new StaleDirectoryRequestError(input, generation);
        }
        const stableEntries = this.stabilizeEntries(slot.lastEntries, entries);
        slot.lastEntries = stableEntries;
        slot.cached = this.cacheResults
          ? {
              entries: stableEntries,
              generation,
              includeHidden: input.includeHidden,
            }
          : undefined;
        return stableEntries;
      })
      .catch((error: unknown) => {
        if (slot.generation !== generation && !(error instanceof StaleDirectoryRequestError)) {
          this.diagnostics.staleResults += 1;
          throw new StaleDirectoryRequestError(input, generation);
        }
        throw error;
      })
      .finally(() => {
        this.diagnostics.concurrentReads -= 1;
        if (slot.active?.promise === request) {
          slot.active = undefined;
        }
      });
    slot.active = {
      generation,
      includeHidden: input.includeHidden,
      promise: request,
    };
    return request;
  }

  private stabilizeEntries(previous: Entry[] | undefined, next: Entry[]): Entry[] {
    if (!previous || previous.length === 0 || next.length === 0) {
      return next;
    }
    const previousByKey = new Map<string, Entry>();
    for (const [index, entry] of previous.entries()) {
      previousByKey.set(this.entryKey(entry, index), entry);
    }
    let everyEntryReusedInOrder = previous.length === next.length;
    const stable = next.map((entry, index) => {
      const prior = previousByKey.get(this.entryKey(entry, index));
      if (prior && this.isEntryEqual(prior, entry)) {
        if (previous[index] !== prior) {
          everyEntryReusedInOrder = false;
        }
        return prior;
      }
      everyEntryReusedInOrder = false;
      return entry;
    });
    return everyEntryReusedInOrder ? previous : stable;
  }
}
