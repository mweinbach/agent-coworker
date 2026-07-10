import type {
  CanvasDocumentCloseResult,
  CanvasDocumentOpenResult,
  CanvasDocumentRevisionResult,
  CanvasDocumentSaveResult,
  CanvasDocumentSnapshot,
} from "../../../../src/shared/canvasDocument";

export type CanvasDocumentSaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export type CanvasDocumentProblem = {
  source: "load" | "poll" | "save";
  message: string;
};

export type CanvasDocumentControllerState = {
  phase: "idle" | "loading" | "ready" | "error";
  requestedPath: string | null;
  document: CanvasDocumentSnapshot | null;
  content: string;
  saveStatus: CanvasDocumentSaveStatus;
  problem: CanvasDocumentProblem | null;
};

export type CanvasDocumentClient = {
  open(
    workspaceId: string,
    input: {
      path: string;
      documentId: string;
      generation: number;
      maxBytes?: number;
    },
  ): Promise<CanvasDocumentOpenResult>;
  revision(
    workspaceId: string,
    input: { documentId: string; generation: number },
  ): Promise<CanvasDocumentRevisionResult>;
  save(
    workspaceId: string,
    input: {
      documentId: string;
      generation: number;
      editRevision: number;
      content: string;
    },
  ): Promise<CanvasDocumentSaveResult>;
  saveAs(
    workspaceId: string,
    input: {
      documentId: string;
      generation: number;
      editRevision: number;
      content: string;
      path: string;
    },
  ): Promise<CanvasDocumentSaveResult>;
  close(
    workspaceId: string,
    input: { documentId: string; generation: number },
  ): Promise<CanvasDocumentCloseResult>;
};

type CanvasDocumentControllerOptions = {
  maxBytes: number;
  saveDelayMs?: number;
  createDocumentId?: () => string;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

type ActiveDocument = {
  workspaceId: string;
  snapshot: CanvasDocumentSnapshot;
};

const INITIAL_STATE: CanvasDocumentControllerState = {
  phase: "idle",
  requestedPath: null,
  document: null,
  content: "",
  saveStatus: "saved",
  problem: null,
};

function defaultDocumentId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export class CanvasDocumentController {
  private readonly documentId: string;
  private readonly saveDelayMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly scheduleTimeout: NonNullable<CanvasDocumentControllerOptions["setTimeout"]>;
  private readonly cancelTimeout: NonNullable<CanvasDocumentControllerOptions["clearTimeout"]>;
  private state: CanvasDocumentControllerState = INITIAL_STATE;
  private active: ActiveDocument | null = null;
  private generation = 0;
  private editRevision = 0;
  private transitionRequest = 0;
  private lastSavedContent = "";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<boolean> | null = null;
  private pollInFlight: Promise<void> | null = null;
  private pendingTarget: { workspaceId: string; path: string } | null = null;

  constructor(
    private readonly client: CanvasDocumentClient,
    private readonly options: CanvasDocumentControllerOptions,
  ) {
    this.documentId = options.createDocumentId?.() ?? defaultDocumentId();
    this.saveDelayMs = options.saveDelayMs ?? 500;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
  }

  getState = (): CanvasDocumentControllerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(workspaceId: string, path: string): Promise<boolean> {
    const request = ++this.transitionRequest;
    this.pendingTarget = { workspaceId, path };
    const active = this.active;
    if (active) {
      const saved = await this.flush();
      if (!saved || request !== this.transitionRequest) {
        return false;
      }
      await this.closeSession(active);
      if (request !== this.transitionRequest) {
        return false;
      }
      this.active = null;
    }

    const generation = ++this.generation;
    this.clearSaveTimer();
    this.setState({
      phase: "loading",
      requestedPath: path,
      document: null,
      content: "",
      saveStatus: "saved",
      problem: null,
    });

    let result: CanvasDocumentOpenResult;
    try {
      result = await this.client.open(workspaceId, {
        path,
        documentId: this.documentId,
        generation,
        maxBytes: this.options.maxBytes,
      });
    } catch (error) {
      if (generation !== this.generation || request !== this.transitionRequest) {
        return false;
      }
      this.setState({
        ...this.state,
        phase: "error",
        problem: {
          source: "load",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }

    if (generation !== this.generation || request !== this.transitionRequest) {
      if (result.ok) {
        void this.client.close(workspaceId, {
          documentId: result.document.documentId,
          generation: result.document.generation,
        });
      }
      return false;
    }
    if (!result.ok) {
      this.setState({
        ...this.state,
        phase: "error",
        problem: { source: "load", message: result.error.message },
      });
      return false;
    }
    if (
      result.document.documentId !== this.documentId ||
      result.document.generation !== generation
    ) {
      this.setState({
        ...this.state,
        phase: "error",
        problem: {
          source: "load",
          message: "Loaded document did not match the active Canvas generation.",
        },
      });
      return false;
    }

    this.active = { workspaceId, snapshot: result.document };
    this.editRevision = 0;
    this.lastSavedContent = result.document.content;
    this.pendingTarget = null;
    this.setState({
      phase: "ready",
      requestedPath: path,
      document: result.document,
      content: result.document.content,
      saveStatus: "saved",
      problem: null,
    });
    return true;
  }

  edit(content: string): void {
    if (!this.active || this.active.snapshot.truncated) {
      return;
    }
    this.editRevision += 1;
    this.setState({
      ...this.state,
      content,
      saveStatus: content === this.lastSavedContent ? "saved" : "dirty",
      problem: null,
    });
    this.clearSaveTimer();
    if (content !== this.lastSavedContent) {
      this.saveTimer = this.scheduleTimeout(() => {
        this.saveTimer = null;
        void this.flush();
      }, this.saveDelayMs);
    }
  }

  async flush(): Promise<boolean> {
    this.clearSaveTimer();
    while (this.active && this.state.content !== this.lastSavedContent) {
      if (this.state.saveStatus === "conflict") {
        return false;
      }
      const existing = this.saveInFlight;
      if (existing) {
        const saved = await existing;
        if (!saved) return false;
        continue;
      }
      const saved = await this.saveOnce();
      if (!saved) return false;
    }
    return true;
  }

  async poll(): Promise<void> {
    if (this.pollInFlight) {
      return await this.pollInFlight;
    }
    const active = this.active;
    if (!active) return;
    const poll = this.pollOnce(active);
    this.pollInFlight = poll;
    try {
      await poll;
    } finally {
      if (this.pollInFlight === poll) {
        this.pollInFlight = null;
      }
    }
  }

  async retry(): Promise<boolean> {
    const problem = this.state.problem;
    if (!problem) {
      return await this.flush();
    }
    if (problem.source === "load") {
      const target = this.pendingTarget;
      if (!target) return false;
      return await this.open(target.workspaceId, target.path);
    }
    if (problem.source === "poll") {
      await this.poll();
      return this.state.problem?.source !== "poll";
    }
    const saved = await this.flush();
    if (saved && this.pendingTarget) {
      const target = this.pendingTarget;
      return await this.open(target.workspaceId, target.path);
    }
    return saved;
  }

  async saveAs(path: string): Promise<string | null> {
    this.clearSaveTimer();
    if (this.saveInFlight) {
      await this.saveInFlight;
    }
    const active = this.active;
    if (!active) return null;
    const content = this.state.content;
    const editRevision = this.editRevision;
    this.setState({ ...this.state, saveStatus: "saving", problem: null });
    const saveAs = (async (): Promise<string | null> => {
      let result: CanvasDocumentSaveResult;
      try {
        result = await this.client.saveAs(active.workspaceId, {
          documentId: active.snapshot.documentId,
          generation: active.snapshot.generation,
          editRevision,
          content,
          path,
        });
      } catch (error) {
        if (this.isCurrent(active)) {
          this.setSaveProblem(error instanceof Error ? error.message : String(error));
        }
        return null;
      }
      if (!this.isCurrent(active)) return null;
      if (!result.ok) {
        this.setState({
          ...this.state,
          saveStatus: result.error.kind === "conflict" ? "conflict" : "error",
          problem: { source: "save", message: result.error.message },
        });
        return null;
      }
      if (result.status === "superseded") {
        this.setSaveProblem("Save As was superseded by a newer edit. Try again.");
        return null;
      }
      const snapshot = {
        ...active.snapshot,
        path: result.path,
        revision: result.revision,
        content,
      };
      active.snapshot = snapshot;
      this.lastSavedContent = content;
      this.setState({
        ...this.state,
        document: snapshot,
        saveStatus: this.state.content === content ? "saved" : "dirty",
        problem: null,
      });
      return result.path;
    })();
    const trackedSave = saveAs.then((savedPath) => savedPath !== null);
    this.saveInFlight = trackedSave;
    try {
      return await saveAs;
    } finally {
      if (this.saveInFlight === trackedSave) {
        this.saveInFlight = null;
      }
    }
  }

  async discardLocalChangesAndReload(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    this.clearSaveTimer();
    this.lastSavedContent = this.state.content;
    await this.closeSession(active);
    if (this.active === active) {
      this.active = null;
    }
    return await this.open(active.workspaceId, active.snapshot.path);
  }

  async prepareForTransition(nextPath: string | null): Promise<boolean> {
    const saved = await this.flush();
    if (!saved) return false;
    if (nextPath === null && this.active) {
      const active = this.active;
      await this.closeSession(active);
      if (this.active === active) {
        this.active = null;
        this.setState(INITIAL_STATE);
      }
    }
    return true;
  }

  dispose(): void {
    this.clearSaveTimer();
    this.transitionRequest += 1;
    this.pendingTarget = null;
    const active = this.active;
    if (active) {
      void this.flush().then((saved) => {
        if (saved) {
          return this.closeSession(active);
        }
      });
    } else {
      this.generation += 1;
    }
    this.listeners.clear();
  }

  private async saveOnce(): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    const content = this.state.content;
    const editRevision = this.editRevision;
    this.setState({ ...this.state, saveStatus: "saving", problem: null });
    const save = (async (): Promise<boolean> => {
      let result: CanvasDocumentSaveResult;
      try {
        result = await this.client.save(active.workspaceId, {
          documentId: active.snapshot.documentId,
          generation: active.snapshot.generation,
          editRevision,
          content,
        });
      } catch (error) {
        if (this.isCurrent(active)) {
          this.setSaveProblem(error instanceof Error ? error.message : String(error));
        }
        return false;
      }
      if (!this.isCurrent(active)) return true;
      if (!result.ok) {
        this.setState({
          ...this.state,
          saveStatus: result.error.kind === "conflict" ? "conflict" : "error",
          problem: { source: "save", message: result.error.message },
        });
        return false;
      }
      if (result.status === "superseded") {
        this.setSaveProblem("Save was superseded by a newer edit. Try again.");
        return false;
      }
      const snapshot = {
        ...active.snapshot,
        revision: result.revision,
        content,
      };
      active.snapshot = snapshot;
      this.lastSavedContent = content;
      this.setState({
        ...this.state,
        document: snapshot,
        saveStatus: this.state.content === content ? "saved" : "dirty",
        problem: null,
      });
      return true;
    })();
    this.saveInFlight = save;
    try {
      return await save;
    } finally {
      if (this.saveInFlight === save) {
        this.saveInFlight = null;
      }
    }
  }

  private async pollOnce(active: ActiveDocument): Promise<void> {
    let result: CanvasDocumentRevisionResult;
    try {
      result = await this.client.revision(active.workspaceId, {
        documentId: active.snapshot.documentId,
        generation: active.snapshot.generation,
      });
    } catch (error) {
      if (this.isCurrent(active)) {
        this.setState({
          ...this.state,
          problem: {
            source: "poll",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    if (!this.isCurrent(active)) return;
    if (!result.ok) {
      this.setState({
        ...this.state,
        problem: { source: "poll", message: result.error.message },
      });
      return;
    }
    if (result.revision.fingerprint === active.snapshot.revision.fingerprint) {
      if (this.state.problem?.source === "poll") {
        this.setState({ ...this.state, problem: null });
      }
      return;
    }
    if (this.state.content !== this.lastSavedContent || this.saveInFlight) {
      this.setState({
        ...this.state,
        saveStatus: "conflict",
        problem: {
          source: "save",
          message: "File changed on disk. Your unsaved changes are preserved.",
        },
      });
      return;
    }
    await this.open(active.workspaceId, active.snapshot.path);
  }

  private setSaveProblem(message: string): void {
    this.setState({
      ...this.state,
      saveStatus: "error",
      problem: { source: "save", message },
    });
  }

  private isCurrent(active: ActiveDocument): boolean {
    return (
      this.active === active &&
      this.generation === active.snapshot.generation &&
      this.documentId === active.snapshot.documentId
    );
  }

  private async closeSession(active: ActiveDocument): Promise<void> {
    try {
      await this.client.close(active.workspaceId, {
        documentId: active.snapshot.documentId,
        generation: active.snapshot.generation,
      });
    } catch {
      // Session cleanup is idempotent and must not turn a completed save into
      // user-visible data loss. The server also drops sessions on process exit.
    }
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) {
      this.cancelTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private setState(next: CanvasDocumentControllerState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
