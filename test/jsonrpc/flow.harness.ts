import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { jsonRpcThreadTurnRequestSchemas } from "../../src/server/jsonrpc/schema.threadTurn";
import { startAgentServer } from "../../src/server/startServer";
import {
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../src/shared/attachments";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";

export type JsonRpcConnection = {
  ws: WebSocket;
  sendRequest: (method: string, params?: unknown) => Promise<any>;
  sendResponse: (id: string | number, result: unknown) => void;
  waitFor: (predicate: (message: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => void;
};

export const JSONRPC_REPLAY_TEST_TIMEOUT_MS = 45_000;
export const JSONRPC_REPLAY_WAIT_TIMEOUT_MS = 30_000;

export async function connectJsonRpc(
  url: string,
  opts?: {
    optOutNotificationMethods?: string[];
  },
): Promise<JsonRpcConnection> {
  const ws = new WebSocket(url, "cowork.jsonrpc.v1");

  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const resolveWaiters = (message: any) => {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return true;
    }
    return false;
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    if (!resolveWaiters(message)) {
      queue.push(message);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      5_000,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });

  const waitFor = async (predicate: (message: any) => boolean, timeoutMs = 5_000): Promise<any> => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      return queue.splice(existingIndex, 1)[0];
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for JSON-RPC message"));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  };

  let nextId = 0;
  const sendRequest = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id);
  };

  const sendResponse = (id: string | number, result: unknown) => {
    ws.send(JSON.stringify({ id, result }));
  };

  const initializeResponse = await sendRequest("initialize", {
    clientInfo: {
      name: "test-jsonrpc-client",
      version: "1.0.0",
    },
    ...(opts?.optOutNotificationMethods?.length
      ? {
          capabilities: {
            optOutNotificationMethods: opts.optOutNotificationMethods,
          },
        }
      : {}),
  });
  expect(initializeResponse.result.protocolVersion).toBe("0.1");
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    ws,
    sendRequest,
    sendResponse,
    waitFor,
    close: () => ws.close(),
  };
}
