import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { MemoryStore } from "../../src/memoryStore";
import { AgentControl } from "../../src/server/agents/AgentControl";
import { AgentSession } from "../../src/server/session/AgentSession";
import { startAgentServer } from "../../src/server/startServer";
import { WorkspaceBackupService } from "../../src/server/workspaceBackups";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";

export async function connectJsonRpc(url: string) {
  const ws = new WebSocket(url, "cowork.jsonrpc.v1");
  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
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

  const waitFor = async (predicate: (message: any) => boolean, timeoutMs = 5_000) => {
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
  const request = async (method: string, params?: unknown, timeoutMs = 5_000) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id, timeoutMs);
  };

  await request("initialize", {
    clientInfo: {
      name: "jsonrpc-control-test",
    },
  });
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    ws,
    request,
    waitFor,
    close: () => ws.close(),
  };
}

export async function enableProjectBackups(cwd: string): Promise<void> {
  await fs.mkdir(path.join(cwd, ".cowork"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".cowork", "config.json"),
    `${JSON.stringify({ backupsEnabled: true })}\n`,
  );
}
