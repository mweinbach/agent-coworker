import { canonicalWorkspacePath } from "../../utils/workspacePath";
import type { StartServerSocket } from "../startServer/types";
import type { SocketSendQueue } from "./SocketSendQueue";

type BufferedRegistration = {
  activeHandles: number;
  committed: boolean;
  invalidated: boolean;
  ws: StartServerSocket;
  messages: Array<{ method: string; params: unknown }>;
};

export class WorkspaceJsonRpcSubscribers {
  private readonly subscribers = new Map<string, Map<string, StartServerSocket>>();
  private readonly bufferedSubscribers = new Map<string, Map<string, BufferedRegistration>>();

  constructor(private readonly sendQueue: SocketSendQueue) {}

  register(ws: StartServerSocket, cwd: string): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const workspacePath = canonicalWorkspacePath(cwd);
    const subscribers = this.subscribers.get(workspacePath) ?? new Map<string, StartServerSocket>();
    subscribers.set(connectionId, ws);
    this.subscribers.set(workspacePath, subscribers);
  }

  beginBufferedRegistration(
    ws: StartServerSocket,
    cwd: string,
  ): { commit: () => void; rollback: () => void } | undefined {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return undefined;
    const workspacePath = canonicalWorkspacePath(cwd);
    if (this.subscribers.get(workspacePath)?.has(connectionId)) {
      return { commit: () => {}, rollback: () => {} };
    }
    const buffers = this.bufferedSubscribers.get(workspacePath) ?? new Map();
    const buffer =
      buffers.get(connectionId) ??
      ({
        activeHandles: 0,
        committed: false,
        invalidated: false,
        ws,
        messages: [],
      } satisfies BufferedRegistration);
    buffer.activeHandles += 1;
    buffer.ws = ws;
    buffers.set(connectionId, buffer);
    this.bufferedSubscribers.set(workspacePath, buffers);
    const removeBuffer = () => {
      buffers.delete(connectionId);
      if (buffers.size === 0) this.bufferedSubscribers.delete(workspacePath);
    };
    let active = true;
    return {
      commit: () => {
        if (!active) return;
        active = false;
        buffer.activeHandles = Math.max(0, buffer.activeHandles - 1);
        if (buffer.invalidated || buffer.committed) return;
        buffer.committed = true;
        removeBuffer();
        this.register(ws, workspacePath);
        for (const message of buffer.messages) {
          this.sendQueue.send(ws, { method: message.method, params: message.params });
        }
      },
      rollback: () => {
        if (!active) return;
        active = false;
        buffer.activeHandles = Math.max(0, buffer.activeHandles - 1);
        if (buffer.invalidated || buffer.committed) return;
        if (buffer.activeHandles === 0) removeBuffer();
      },
    };
  }

  private invalidateBufferedRegistrations(connectionId: string): void {
    for (const [workspacePath, buffers] of this.bufferedSubscribers) {
      const buffer = buffers.get(connectionId);
      if (!buffer) continue;
      buffer.invalidated = true;
      buffers.delete(connectionId);
      if (buffers.size === 0) this.bufferedSubscribers.delete(workspacePath);
    }
  }

  remove(ws: StartServerSocket): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    this.invalidateBufferedRegistrations(connectionId);
    for (const [workspacePath, subscribers] of this.subscribers) {
      subscribers.delete(connectionId);
      if (subscribers.size === 0) this.subscribers.delete(workspacePath);
    }
  }

  notify(cwd: string, method: string, params: unknown): void {
    const workspacePath = canonicalWorkspacePath(cwd);
    const subscribers = this.subscribers.get(workspacePath);
    for (const ws of subscribers?.values() ?? []) {
      if (ws.data.taskReadAllowed === false) continue;
      if (!this.sendQueue.shouldSendNotification(ws, method)) continue;
      this.sendQueue.send(ws, { method, params });
    }
    const buffers = this.bufferedSubscribers.get(workspacePath);
    if (!buffers) return;
    for (const [connectionId, buffer] of buffers) {
      if (subscribers?.has(connectionId)) continue;
      if (buffer.ws.data.taskReadAllowed === false) continue;
      if (!this.sendQueue.shouldSendNotification(buffer.ws, method)) continue;
      buffer.messages.push({ method, params });
    }
  }

  clear(): void {
    for (const buffers of this.bufferedSubscribers.values()) {
      for (const buffer of buffers.values()) {
        buffer.invalidated = true;
      }
    }
    this.subscribers.clear();
    this.bufferedSubscribers.clear();
  }
}
