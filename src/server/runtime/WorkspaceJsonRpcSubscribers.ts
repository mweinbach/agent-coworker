import { canonicalWorkspacePath } from "../../utils/workspacePath";
import type { StartServerSocket } from "../startServer/types";
import type { SocketSendQueue } from "./SocketSendQueue";

export class WorkspaceJsonRpcSubscribers {
  private readonly subscribers = new Map<string, Map<string, StartServerSocket>>();

  constructor(private readonly sendQueue: SocketSendQueue) {}

  register(ws: StartServerSocket, cwd: string): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const workspacePath = canonicalWorkspacePath(cwd);
    const subscribers = this.subscribers.get(workspacePath) ?? new Map<string, StartServerSocket>();
    subscribers.set(connectionId, ws);
    this.subscribers.set(workspacePath, subscribers);
  }

  remove(ws: StartServerSocket): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    for (const [workspacePath, subscribers] of this.subscribers) {
      subscribers.delete(connectionId);
      if (subscribers.size === 0) this.subscribers.delete(workspacePath);
    }
  }

  notify(cwd: string, method: string, params: unknown): void {
    const subscribers = this.subscribers.get(canonicalWorkspacePath(cwd));
    if (!subscribers) return;
    for (const ws of subscribers.values()) {
      if (ws.data.taskReadAllowed === false) continue;
      if (!this.sendQueue.shouldSendNotification(ws, method)) continue;
      this.sendQueue.send(ws, { method, params });
    }
  }

  clear(): void {
    this.subscribers.clear();
  }
}
