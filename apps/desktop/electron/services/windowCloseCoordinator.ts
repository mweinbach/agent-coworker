import { randomUUID } from "node:crypto";

import { DESKTOP_EVENT_CHANNELS, type WindowCloseResponseInput } from "../../src/lib/desktopApi";

type NativeCloseEvent = {
  preventDefault(): void;
};

export type NativeCloseWebContents = {
  id: number;
  send(channel: string, payload: unknown): void;
};

export type NativeCloseWindow = {
  webContents: NativeCloseWebContents;
  isDestroyed(): boolean;
  on(event: "close" | "closed", listener: (event?: NativeCloseEvent) => void): void;
  off(event: "close" | "closed", listener: (event?: NativeCloseEvent) => void): void;
  close(): void;
  destroy(): void;
};

type NativeWindowCloseCoordinatorOptions = {
  createRequestId?: () => string;
  responseTimeoutMs?: number;
  confirmUnresponsiveClose?: (window: NativeCloseWindow) => boolean | Promise<boolean>;
};

type CloseRequest = {
  id: string;
  closeAfterApproval: boolean;
  promise: Promise<boolean>;
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

type TrackedWindow = {
  window: NativeCloseWindow;
  pendingRequest: CloseRequest | null;
  allowNextClose: boolean;
  closeListener: (event?: NativeCloseEvent) => void;
  closedListener: () => void;
};

export class NativeWindowCloseCoordinator {
  private readonly trackedByWebContentsId = new Map<number, TrackedWindow>();
  private readonly createRequestId: () => string;
  private readonly responseTimeoutMs: number;
  private readonly confirmUnresponsiveClose?: NativeWindowCloseCoordinatorOptions["confirmUnresponsiveClose"];
  private preparingQuit = false;
  private quitApproved = false;
  private pendingQuit: Promise<boolean> | null = null;
  private quitAttempt = 0;

  constructor(options: NativeWindowCloseCoordinatorOptions = {}) {
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 15_000;
    this.confirmUnresponsiveClose = options.confirmUnresponsiveClose;
  }

  track(window: NativeCloseWindow): () => void {
    const webContentsId = window.webContents.id;
    this.untrack(webContentsId);
    const tracked: TrackedWindow = {
      window,
      pendingRequest: null,
      allowNextClose: false,
      closeListener: (event) => {
        if (!event) {
          return;
        }
        if (this.quitApproved || tracked.allowNextClose) {
          tracked.allowNextClose = false;
          return;
        }
        event.preventDefault();
        if (window.isDestroyed()) {
          return;
        }
        void this.requestApproval(tracked, true);
      },
      closedListener: () => {
        this.untrack(webContentsId);
      },
    };
    this.trackedByWebContentsId.set(webContentsId, tracked);
    window.on("close", tracked.closeListener);
    window.on("closed", tracked.closedListener);
    return () => {
      if (this.trackedByWebContentsId.get(webContentsId) === tracked) this.untrack(webContentsId);
    };
  }

  /** Flush every window without destroying editor state; any veto keeps services live. */
  prepareToQuit(): Promise<boolean> {
    if (this.quitApproved) return Promise.resolve(true);
    if (this.pendingQuit) return this.pendingQuit;
    this.preparingQuit = true;
    const approval = this.collectQuitApprovals(++this.quitAttempt).finally(() => {
      if (this.pendingQuit === approval) {
        this.preparingQuit = false;
        this.pendingQuit = null;
      }
    });
    this.pendingQuit = approval;
    return approval;
  }

  cancelQuit(): void {
    this.quitAttempt += 1;
    this.quitApproved = false;
    this.preparingQuit = false;
    this.pendingQuit = null;
    for (const tracked of this.trackedByWebContentsId.values()) {
      if (tracked.pendingRequest) this.finishRequest(tracked, tracked.pendingRequest, false);
    }
  }

  private async collectQuitApprovals(attempt: number): Promise<boolean> {
    const approved = new Set<TrackedWindow>();
    while (true) {
      if (attempt !== this.quitAttempt) return false;
      const remaining = [...this.trackedByWebContentsId.values()].filter(
        (tracked) => !tracked.window.isDestroyed() && !approved.has(tracked),
      );
      if (remaining.length === 0) {
        this.quitApproved = true;
        return true;
      }
      const decisions = await Promise.all(
        remaining.map(async (tracked) => {
          const allowed = await this.requestApproval(tracked);
          if (!allowed && attempt === this.quitAttempt) this.cancelQuit();
          return allowed;
        }),
      );
      if (attempt !== this.quitAttempt || decisions.some((allowed) => !allowed)) return false;
      for (const tracked of remaining) approved.add(tracked);
    }
  }

  resolve(sender: NativeCloseWebContents, response: WindowCloseResponseInput): void {
    const tracked = this.trackedByWebContentsId.get(sender.id);
    if (
      !tracked ||
      tracked.window.webContents !== sender ||
      tracked.pendingRequest?.id !== response.requestId
    ) {
      return;
    }
    this.finishRequest(tracked, tracked.pendingRequest, response.canClose);
  }

  private requestApproval(tracked: TrackedWindow, closeAfterApproval = false): Promise<boolean> {
    if (tracked.pendingRequest) {
      tracked.pendingRequest.closeAfterApproval ||= closeAfterApproval;
      return tracked.pendingRequest.promise;
    }
    let resolve!: (approved: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const request: CloseRequest = {
      id: this.createRequestId(),
      closeAfterApproval,
      promise,
      resolve,
      timeout: null,
    };
    tracked.pendingRequest = request;
    request.timeout = setTimeout(() => {
      void this.recoverUnresponsiveWindow(tracked, request);
    }, this.responseTimeoutMs);
    request.timeout.unref?.();
    try {
      tracked.window.webContents.send(DESKTOP_EVENT_CHANNELS.windowCloseRequested, {
        requestId: request.id,
      });
    } catch {
      clearTimeout(request.timeout);
      request.timeout = null;
      void this.recoverUnresponsiveWindow(tracked, request);
    }
    return promise;
  }

  private async recoverUnresponsiveWindow(
    tracked: TrackedWindow,
    request: CloseRequest,
  ): Promise<void> {
    if (tracked.pendingRequest !== request) return;
    let approved = false;
    try {
      approved = (await this.confirmUnresponsiveClose?.(tracked.window)) === true;
    } catch {
      // Recovery defaults to keeping unsaved work open, never to discarding it.
    }
    this.finishRequest(tracked, request, approved, approved);
  }

  private finishRequest(
    tracked: TrackedWindow,
    request: CloseRequest,
    approved: boolean,
    discard = false,
  ): void {
    if (tracked.pendingRequest !== request) return;
    if (request.timeout) clearTimeout(request.timeout);
    tracked.pendingRequest = null;
    if (discard && !tracked.window.isDestroyed()) {
      // Only the explicit native recovery choice for this still-current request
      // authorizes bypassing a dirty or unresponsive renderer's beforeunload veto.
      try {
        tracked.window.destroy();
      } catch {
        approved = false;
      }
    }
    request.resolve(approved);
    if (
      approved &&
      request.closeAfterApproval &&
      !this.preparingQuit &&
      !this.quitApproved &&
      !tracked.window.isDestroyed()
    ) {
      tracked.allowNextClose = true;
      tracked.window.close();
    }
  }

  private untrack(webContentsId: number): void {
    const tracked = this.trackedByWebContentsId.get(webContentsId);
    if (!tracked) {
      return;
    }
    this.trackedByWebContentsId.delete(webContentsId);
    if (tracked.pendingRequest) {
      tracked.pendingRequest.closeAfterApproval = false;
      this.finishRequest(tracked, tracked.pendingRequest, true);
    }
    tracked.window.off("close", tracked.closeListener);
    tracked.window.off("closed", tracked.closedListener);
  }
}
