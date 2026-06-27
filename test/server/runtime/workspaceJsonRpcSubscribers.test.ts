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

  test("buffers task notifications until commit and discards them on rollback", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const pending = socket("pending");
    const committed = socket("committed");
    const workspace = path.join(os.tmpdir(), "task-subscriber-buffered");

    const rolledBack = subscribers.beginBufferedRegistration(pending, workspace);
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-rolled-back" },
    });
    rolledBack?.rollback();
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-after-rollback" },
    });
    expect(sent).toEqual([]);

    const buffered = subscribers.beginBufferedRegistration(committed, workspace);
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-buffered" },
    });
    expect(sent).toEqual([]);
    buffered?.commit();
    expect(sent).toEqual([
      {
        connectionId: "committed",
        payload: {
          method: "task/created",
          params: { cwd: workspace, task: { id: "task-buffered" } },
        },
      },
    ]);

    sent.length = 0;
    subscribers.notify(workspace, "task/updated", {
      cwd: workspace,
      task: { id: "task-future" },
    });
    expect(sent).toEqual([
      {
        connectionId: "committed",
        payload: {
          method: "task/updated",
          params: { cwd: workspace, task: { id: "task-future" } },
        },
      },
    ]);
  });

  test("shares overlapping buffered registrations for the same connection and workspace", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const client = socket("client");
    const workspace = path.join(os.tmpdir(), "task-subscriber-overlap");

    const first = subscribers.beginBufferedRegistration(client, workspace);
    const second = subscribers.beginBufferedRegistration(client, workspace);
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-buffered-once" },
    });

    first?.commit();
    second?.commit();
    expect(sent).toEqual([
      {
        connectionId: "client",
        payload: {
          method: "task/created",
          params: { cwd: workspace, task: { id: "task-buffered-once" } },
        },
      },
    ]);

    sent.length = 0;
    subscribers.notify(workspace, "task/updated", {
      cwd: workspace,
      task: { id: "task-live-once" },
    });
    expect(sent).toEqual([
      {
        connectionId: "client",
        payload: {
          method: "task/updated",
          params: { cwd: workspace, task: { id: "task-live-once" } },
        },
      },
    ]);
  });

  test("keeps a committed overlapping buffer when a sibling request rolls back", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const client = socket("client");
    const workspace = path.join(os.tmpdir(), "task-subscriber-overlap-rollback");

    const first = subscribers.beginBufferedRegistration(client, workspace);
    const second = subscribers.beginBufferedRegistration(client, workspace);
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-buffered-once" },
    });

    first?.rollback();
    second?.commit();
    expect(sent).toEqual([
      {
        connectionId: "client",
        payload: {
          method: "task/created",
          params: { cwd: workspace, task: { id: "task-buffered-once" } },
        },
      },
    ]);

    sent.length = 0;
    subscribers.notify(workspace, "task/updated", {
      cwd: workspace,
      task: { id: "task-after-sibling-rollback" },
    });
    expect(sent).toHaveLength(1);
  });

  test("invalidates buffered registrations on disconnect before late commit", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const client = socket("client");
    const workspace = path.join(os.tmpdir(), "task-subscriber-disconnect-buffer");

    const buffered = subscribers.beginBufferedRegistration(client, workspace);
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-before-disconnect" },
    });
    subscribers.remove(client);
    buffered?.commit();
    subscribers.notify(workspace, "task/updated", {
      cwd: workspace,
      task: { id: "task-after-disconnect" },
    });

    expect(sent).toEqual([]);
  });

  test("clear invalidates buffered registrations before late commit", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const client = socket("client");
    const workspace = path.join(os.tmpdir(), "task-subscriber-clear-buffer");

    const buffered = subscribers.beginBufferedRegistration(client, workspace);
    subscribers.notify(workspace, "task/created", {
      cwd: workspace,
      task: { id: "task-before-clear" },
    });
    subscribers.clear();
    buffered?.commit();
    subscribers.notify(workspace, "task/updated", {
      cwd: workspace,
      task: { id: "task-after-clear" },
    });

    expect(sent).toEqual([]);
  });

  test("keeps a connection subscribed to every requested task workspace idempotently", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const subscribers = new WorkspaceJsonRpcSubscribers({
      shouldSendNotification: () => true,
      send: (ws: StartServerSocket, payload: unknown) => {
        sent.push({ connectionId: ws.data.connectionId, payload });
        return true;
      },
    } as never);
    const client = socket("client");
    const firstWorkspace = path.join(os.tmpdir(), "task-subscriber-additive-one");
    const secondWorkspace = path.join(os.tmpdir(), "task-subscriber-additive-two");

    subscribers.register(client, firstWorkspace);
    subscribers.register(client, secondWorkspace);
    subscribers.register(client, secondWorkspace);

    subscribers.notify(firstWorkspace, "task/created", {
      cwd: firstWorkspace,
      task: { id: "task-1" },
    });
    subscribers.notify(secondWorkspace, "task/updated", {
      cwd: secondWorkspace,
      task: { id: "task-2" },
    });
    subscribers.notify(path.join(os.tmpdir(), "task-subscriber-additive-three"), "task/created", {
      task: { id: "task-3" },
    });

    expect(sent).toEqual([
      {
        connectionId: "client",
        payload: {
          method: "task/created",
          params: { cwd: firstWorkspace, task: { id: "task-1" } },
        },
      },
      {
        connectionId: "client",
        payload: {
          method: "task/updated",
          params: { cwd: secondWorkspace, task: { id: "task-2" } },
        },
      },
    ]);

    sent.length = 0;
    subscribers.remove(client);
    subscribers.notify(firstWorkspace, "task/created", {
      cwd: firstWorkspace,
      task: { id: "task-4" },
    });
    subscribers.notify(secondWorkspace, "task/updated", {
      cwd: secondWorkspace,
      task: { id: "task-5" },
    });
    expect(sent).toEqual([]);
  });
});
