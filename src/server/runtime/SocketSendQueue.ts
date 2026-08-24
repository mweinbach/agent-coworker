import type { StartServerSocket } from "../startServer/types";

const DEFAULT_SEND_QUEUE_MAX = 500;

export type SocketSendQueueStats = {
  queuedSends: number;
  droppedDeltas: number;
  droppedImportant: number;
  serializationFailures: number;
  sendFailures: number;
  externalSinkFailures: number;
  maxQueueDepth: number;
  queueDepthByConnection: Record<string, number>;
};

export type QueuedSendItem = {
  payload: string;
  isDelta: boolean;
};

function evictLeastCriticalSend(queue: QueuedSendItem[]): "delta" | "important" | "none" {
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].isDelta) {
      queue.splice(i, 1);
      return "delta";
    }
  }
  return queue.shift() === undefined ? "none" : "important";
}

export class SocketSendQueue {
  private readonly pendingSends = new Map<string, QueuedSendItem[]>();
  private readonly externalSinks = new Map<string, (serialized: string) => boolean>();
  private readonly stats: Omit<SocketSendQueueStats, "queueDepthByConnection"> = {
    queuedSends: 0,
    droppedDeltas: 0,
    droppedImportant: 0,
    serializationFailures: 0,
    sendFailures: 0,
    externalSinkFailures: 0,
    maxQueueDepth: 0,
  };

  constructor(private readonly maxQueuedSends = DEFAULT_SEND_QUEUE_MAX) {}

  send(ws: StartServerSocket, payload: unknown): void {
    const method =
      typeof payload === "object" && payload !== null
        ? (payload as { method?: string }).method
        : undefined;
    const isDelta =
      typeof payload === "object" &&
      payload !== null &&
      (method === "model_stream_chunk" ||
        method === "item/agentMessage/delta" ||
        method === "item/reasoning/delta" ||
        (payload as { params?: { type?: string } }).params?.type === "agentMessage/delta");

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      this.stats.serializationFailures += 1;
      return;
    }

    const connectionId = ws.data.connectionId;
    if (connectionId && this.pendingSends.has(connectionId)) {
      this.enqueue(connectionId, { payload: serialized, isDelta });
      return;
    }

    const externalSink = connectionId ? this.externalSinks.get(connectionId) : undefined;
    if (externalSink) {
      try {
        if (externalSink(serialized)) {
          return;
        }
      } catch {
        this.stats.externalSinkFailures += 1;
        return;
      }
    }

    try {
      const status = ws.send(serialized);
      if (status === 0 || status === -1) {
        if (!connectionId) return;
        this.enqueue(connectionId, { payload: serialized, isDelta });
      }
    } catch {
      this.stats.sendFailures += 1;
      // Socket closed or send failed; drop the message.
    }
  }

  private enqueue(connectionId: string, item: QueuedSendItem): void {
    const queue = this.pendingSends.get(connectionId) ?? [];
    this.stats.queuedSends += 1;
    if (queue.length >= this.maxQueuedSends) {
      if (item.isDelta && !queue.some((queued) => queued.isDelta)) {
        this.stats.droppedDeltas += 1;
        return;
      }
      const evicted = evictLeastCriticalSend(queue);
      if (evicted === "delta") {
        this.stats.droppedDeltas += 1;
      } else if (evicted === "important") {
        this.stats.droppedImportant += 1;
      }
    }
    queue.push(item);
    this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, queue.length);
    this.pendingSends.set(connectionId, queue);
  }

  flush(ws: StartServerSocket): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const queue = this.pendingSends.get(connectionId);
    if (!queue) return;
    while (queue.length > 0) {
      try {
        const status = ws.send(queue[0].payload);
        if (status <= 0) {
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

  deleteConnection(connectionId: string | undefined): void {
    if (!connectionId) return;
    this.pendingSends.delete(connectionId);
    this.externalSinks.delete(connectionId);
  }

  getStats(): SocketSendQueueStats {
    return {
      ...this.stats,
      queueDepthByConnection: Object.fromEntries(
        [...this.pendingSends.entries()].map(([connectionId, queue]) => [
          connectionId,
          queue.length,
        ]),
      ),
    };
  }

  shouldSendNotification(ws: StartServerSocket, method: string): boolean {
    return !ws.data.rpc?.capabilities.optOutNotificationMethods.includes(method);
  }

  setExternalSink(connectionId: string, sink: ((serialized: string) => boolean) | null): void {
    if (sink) {
      this.externalSinks.set(connectionId, sink);
      return;
    }
    this.externalSinks.delete(connectionId);
  }
}
