import { z } from "zod";

import type {
  CoworkItemDeltaNotification,
  CoworkItemNotification,
  CoworkReasoningDeltaNotification,
  CoworkThreadListResult,
  CoworkThreadReadResult,
  CoworkTurnCompletedNotification,
  CoworkTurnStartedNotification,
} from "./protocolTypes";
import {
  coworkItemDeltaNotificationSchema,
  coworkItemNotificationSchema,
  coworkReasoningDeltaNotificationSchema,
  coworkThreadListResultSchema,
  coworkThreadReadResultSchema,
  coworkTurnCompletedNotificationSchema,
  coworkTurnStartedNotificationSchema,
} from "./protocolTypes";

const jsonRpcIdSchema = z.union([z.string(), z.number().finite()]);

const jsonRpcRequestSchema = z.object({
  id: jsonRpcIdSchema,
  method: z.string().trim().min(1),
  params: z.unknown().optional(),
}).strict();

const jsonRpcNotificationSchema = z.object({
  method: z.string().trim().min(1),
  params: z.unknown().optional(),
}).strict();

const jsonRpcResponseSchema = z.object({
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
}).strict().refine((value) => value.result !== undefined || value.error !== undefined, {
  message: "Response must include result or error.",
});

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

type JsonRpcRequestMessage = z.infer<typeof jsonRpcRequestSchema>;
type JsonRpcNotificationMessage = z.infer<typeof jsonRpcNotificationSchema>;
type JsonRpcResponseMessage = z.infer<typeof jsonRpcResponseSchema>;

export type JsonRpcServerRequest =
  | {
      method: "item/tool/requestUserInput";
      id: JsonRpcId;
      params: {
        threadId: string;
        turnId?: string | null;
        requestId: string;
        itemId: string;
        question: string;
        options?: string[];
      };
    }
  | {
      method: "item/commandExecution/requestApproval";
      id: JsonRpcId;
      params: {
        threadId: string;
        turnId?: string | null;
        requestId: string;
        itemId: string;
        command: string;
        dangerous: boolean;
        reason: string;
      };
    };

export type JsonRpcNotification =
  | { method: "thread/started"; params: { thread: CoworkThreadListResult["threads"][number] } }
  | { method: "turn/started"; params: CoworkTurnStartedNotification }
  | { method: "item/started"; params: CoworkItemNotification }
  | { method: "item/completed"; params: CoworkItemNotification }
  | { method: "item/agentMessage/delta"; params: CoworkItemDeltaNotification }
  | { method: "item/reasoning/delta"; params: CoworkReasoningDeltaNotification }
  | { method: "turn/completed"; params: CoworkTurnCompletedNotification }
  | { method: "serverRequest/resolved"; params: { threadId: string; requestId: string } };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type JsonRpcClientOptions = {
  clientInfo: {
    name: string;
    version: string;
  };
  send: (text: string) => Promise<void> | void;
  onNotification?: (notification: JsonRpcNotification) => void;
  onServerRequest?: (request: JsonRpcServerRequest) => void;
  requestTimeoutMs?: number;
};

function parseJsonMessage(raw: string): JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage {
  const parsed = JSON.parse(raw) as unknown;
  const requestResult = jsonRpcRequestSchema.safeParse(parsed);
  if (requestResult.success) {
    return requestResult.data;
  }
  const responseResult = jsonRpcResponseSchema.safeParse(parsed);
  if (responseResult.success) {
    return responseResult.data;
  }
  return jsonRpcNotificationSchema.parse(parsed);
}

function normalizeNotification(message: JsonRpcNotificationMessage): JsonRpcNotification | null {
  switch (message.method) {
    case "thread/started":
      return {
        method: "thread/started",
        params: z.object({
          thread: coworkThreadListResultSchema.shape.threads.element,
        }).strict().parse(message.params),
      };
    case "turn/started":
      return {
        method: "turn/started",
        params: coworkTurnStartedNotificationSchema.parse(message.params),
      };
    case "item/started":
      return {
        method: "item/started",
        params: coworkItemNotificationSchema.parse(message.params),
      };
    case "item/completed":
      return {
        method: "item/completed",
        params: coworkItemNotificationSchema.parse(message.params),
      };
    case "item/agentMessage/delta":
      return {
        method: "item/agentMessage/delta",
        params: coworkItemDeltaNotificationSchema.parse(message.params),
      };
    case "item/reasoning/delta":
      return {
        method: "item/reasoning/delta",
        params: coworkReasoningDeltaNotificationSchema.parse(message.params),
      };
    case "turn/completed":
      return {
        method: "turn/completed",
        params: coworkTurnCompletedNotificationSchema.parse(message.params),
      };
    case "serverRequest/resolved":
      return {
        method: "serverRequest/resolved",
        params: z.object({
          threadId: z.string().trim().min(1),
          requestId: z.string().trim().min(1),
        }).strict().parse(message.params),
      };
    default:
      return null;
  }
}

function normalizeServerRequest(message: JsonRpcRequestMessage): JsonRpcServerRequest | null {
  switch (message.method) {
    case "item/tool/requestUserInput":
      return {
        method: message.method,
        id: message.id,
        params: z.object({
          threadId: z.string().trim().min(1),
          turnId: z.string().trim().min(1).nullable().optional(),
          requestId: z.string().trim().min(1),
          itemId: z.string().trim().min(1),
          question: z.string(),
          options: z.array(z.string()).optional(),
        }).strict().parse(message.params),
      };
    case "item/commandExecution/requestApproval":
      return {
        method: message.method,
        id: message.id,
        params: z.object({
          threadId: z.string().trim().min(1),
          turnId: z.string().trim().min(1).nullable().optional(),
          requestId: z.string().trim().min(1),
          itemId: z.string().trim().min(1),
          command: z.string(),
          dangerous: z.boolean(),
          reason: z.string(),
        }).strict().parse(message.params),
      };
    default:
      return null;
  }
}

export class CoworkJsonRpcClient {
  private readonly requestTimeoutMs: number;
  private readonly sendTransport: (text: string) => Promise<void> | void;
  private readonly onNotification?: (notification: JsonRpcNotification) => void;
  private readonly onServerRequest?: (request: JsonRpcServerRequest) => void;
  private nextId = 0;
  private initialized = false;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly clientInfo: JsonRpcClientOptions["clientInfo"];

  constructor(options: JsonRpcClientOptions) {
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 15_000);
    this.sendTransport = options.send;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.clientInfo = options.clientInfo;
  }

  resetTransportSession(reason = "Transport disconnected."): void {
    this.initialized = false;
    this.rejectAllPending(reason);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: false,
      },
    });
    await this.notify("initialized", {});
    this.initialized = true;
  }

  async requestThreadList(): Promise<CoworkThreadListResult> {
    const result = await this.request("thread/list", {});
    return coworkThreadListResultSchema.parse(result);
  }

  async readThread(threadId: string): Promise<CoworkThreadReadResult> {
    const result = await this.request("thread/read", { threadId });
    return coworkThreadReadResultSchema.parse(result);
  }

  async startTurn(threadId: string, text: string): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId });
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const result = await this.request(method, params);
    return result as T;
  }

  async respondServerRequest(
    id: JsonRpcId,
    result: unknown,
  ): Promise<void> {
    await this.sendTransport(JSON.stringify({ id, result }));
  }

  async rejectServerRequest(id: JsonRpcId, message: string): Promise<void> {
    await this.sendTransport(JSON.stringify({
      id,
      error: {
        code: -32000,
        message,
      },
    }));
  }

  async handleIncoming(raw: string): Promise<void> {
    let message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;
    try {
      message = parseJsonMessage(raw);
    } catch {
      return;
    }
    if ("id" in message && "method" in message) {
      try {
        const serverRequest = normalizeServerRequest(message);
        if (serverRequest && this.onServerRequest) {
          this.onServerRequest(serverRequest);
        }
      } catch {
        return;
      }
      return;
    }
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeoutHandle);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if ("method" in message) {
      try {
        const notification = normalizeNotification(message as JsonRpcNotificationMessage);
        if (notification) {
          this.onNotification?.(notification);
        }
      } catch {
        return;
      }
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.sendTransport(JSON.stringify({
      method,
      ...(params !== undefined ? { params } : {}),
    }));
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeoutHandle });
    });
    try {
      await this.sendTransport(JSON.stringify({
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }));
    } catch (error) {
      this.rejectPending(id, error);
    }
    return await promise;
  }

  private rejectPending(id: JsonRpcId, error: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeoutHandle);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error(reason));
    }
  }
}
