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
};

type NativeWindowCloseCoordinatorOptions = {
  createRequestId?: () => string;
};

type TrackedWindow = {
  window: NativeCloseWindow;
  pendingRequestId: string | null;
  allowNextClose: boolean;
  closeListener: (event?: NativeCloseEvent) => void;
  closedListener: () => void;
};

export class NativeWindowCloseCoordinator {
  private readonly trackedByWebContentsId = new Map<number, TrackedWindow>();
  private readonly createRequestId: () => string;

  constructor(options: NativeWindowCloseCoordinatorOptions = {}) {
    this.createRequestId = options.createRequestId ?? randomUUID;
  }

  track(window: NativeCloseWindow): () => void {
    const webContentsId = window.webContents.id;
    this.untrack(webContentsId);
    const tracked: TrackedWindow = {
      window,
      pendingRequestId: null,
      allowNextClose: false,
      closeListener: (event) => {
        if (!event) {
          return;
        }
        if (tracked.allowNextClose) {
          tracked.allowNextClose = false;
          return;
        }
        event.preventDefault();
        if (tracked.pendingRequestId || window.isDestroyed()) {
          return;
        }
        const requestId = this.createRequestId();
        tracked.pendingRequestId = requestId;
        window.webContents.send(DESKTOP_EVENT_CHANNELS.windowCloseRequested, { requestId });
      },
      closedListener: () => {
        this.untrack(webContentsId);
      },
    };
    this.trackedByWebContentsId.set(webContentsId, tracked);
    window.on("close", tracked.closeListener);
    window.on("closed", tracked.closedListener);
    return () => this.untrack(webContentsId);
  }

  resolve(sender: NativeCloseWebContents, response: WindowCloseResponseInput): void {
    const tracked = this.trackedByWebContentsId.get(sender.id);
    if (
      !tracked ||
      tracked.window.webContents !== sender ||
      tracked.pendingRequestId !== response.requestId
    ) {
      return;
    }
    tracked.pendingRequestId = null;
    if (!response.canClose || tracked.window.isDestroyed()) {
      return;
    }
    tracked.allowNextClose = true;
    tracked.window.close();
  }

  private untrack(webContentsId: number): void {
    const tracked = this.trackedByWebContentsId.get(webContentsId);
    if (!tracked) {
      return;
    }
    this.trackedByWebContentsId.delete(webContentsId);
    tracked.window.off("close", tracked.closeListener);
    tracked.window.off("closed", tracked.closedListener);
  }
}
