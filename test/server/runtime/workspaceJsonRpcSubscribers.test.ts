import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { WorkspaceJsonRpcSubscribers } from "../../../src/server/runtime/WorkspaceJsonRpcSubscribers";
import type { StartServerSocket } from "../../../src/server/startServer/types";

function socket(connectionId: string): StartServerSocket {
  return {
    data: {
      connectionId,
      rpc: {
        initializeRequestReceived: true,
        initializedNotificationReceived: true,
        pendingRequestCount: 0,
        maxPendingRequests: 128,
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        pendingServerRequests: new Map(),
      },
    },
  } as StartServerSocket;
}

describe("WorkspaceJsonRpcSubscribers", () => {
  test("sends task updates only to clients registered for the matching workspace", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const first = socket("first");
    const second = socket("second");
    const firstWorkspace = path.join(os.tmpdir(), "task-subscriber-one");
    const secondWorkspace = path.join(os.tmpdir(), "task-subscriber-two");
    subscribers.register(first, firstWorkspace);
    subscribers.register(second, secondWorkspace);

    subscribers.notify(path.join(firstWorkspace, "."), "task/updated", {
      task: { id: "task-1" },
    });

    expect(sent).toEqual([
      {
        connectionId: "first",
        payload: { method: "task/updated", params: { task: { id: "task-1" } } },
      },
    ]);
  });

  test("filters task notifications for sockets without task read permission", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const allowed = socket("allowed");
    const denied = socket("denied");
    denied.data.taskReadAllowed = false;
    const workspace = path.join(os.tmpdir(), "task-subscriber-authz");
    subscribers.register(allowed, workspace);
    subscribers.register(denied, workspace);

    subscribers.notify(workspace, "task/created", {
      task: { id: "task-1", title: "Secret task" },
    });

    expect(sent).toEqual([
      {
        connectionId: "allowed",
        payload: {
          method: "task/created",
          params: { task: { id: "task-1", title: "Secret task" } },
        },
      },
    ]);
  });
});
