import type { StartServerSocket } from "../startServer/types";

const SEND_QUEUE_MAX = 500;

export class SocketSendQueue {
  private readonly pendingSends = new Map<string, string[]>();

  sendJsonRpc(ws: StartServerSocket, payload: unknown): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return;
    }

    try {
      const status = ws.send(serialized);
      if (status === 0 || status === -1) {
        const connectionId = ws.data.connectionId;
        if (!connectionId) return;
        const queue = this.pendingSends.get(connectionId) ?? [];
        if (queue.length >= SEND_QUEUE_MAX) {
          evictLeastCriticalSend(queue);
        }
        queue.push(serialized);
        this.pendingSends.set(connectionId, queue);
      }
    } catch {
      // Socket closed or send failed; drop the message.
    }
  }

  flush(ws: StartServerSocket): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const queue = this.pendingSends.get(connectionId);
    if (!queue) return;
    while (queue.length > 0) {
      try {
        const status = ws.send(queue[0]);
        if (status === -1) {
          break;
        }
        queue.shift();
      } catch {
        queue.shift();
      }
    }
    if (queue.length === 0) {
      this.pendingSends.delete(connectionId);
    }
  }

  delete(connectionId: string | undefined): void {
    if (!connectionId) return;
    this.pendingSends.delete(connectionId);
  }
}

function evictLeastCriticalSend(queue: string[]): void {
  for (let i = 0; i < queue.length; i++) {
    try {
      const parsed = JSON.parse(queue[i]) as {
        method?: string;
        params?: { type?: string };
      };
      if (parsed.method === "model_stream_chunk" || parsed.params?.type === "agentMessage/delta") {
        queue.splice(i, 1);
        return;
      }
    } catch {
      // Ignore malformed JSON.
    }
  }
  queue.shift();
}
