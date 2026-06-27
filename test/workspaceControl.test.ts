import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../src/server/protocol";
import { WorkspaceControl } from "../src/server/runtime/WorkspaceControl";
import type { StartServerSocket } from "../src/server/startServer/types";

function testSocket(data: StartServerSocket["data"]): StartServerSocket {
  return { data } as StartServerSocket;
}

describe("WorkspaceControl", () => {
  test("does not register H3 control-event subscribers without workspace settings access", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const control = new WorkspaceControl({
      env: {},
      fallbackWorkingDirectory: "/tmp",
      registry: {} as never,
      socketSendQueue: {
        shouldSendNotification() {
          return true;
        },
        send(ws: { data: { connectionId?: string } }, payload: unknown) {
          sent.push({ connectionId: ws.data.connectionId, payload });
        },
      } as never,
    });

    const deniedH3Socket = testSocket({
      connectionId: "denied-h3",
      protocolMode: "h3",
      workspaceControlEventsAllowed: false,
    });
    const allowedH3Socket = testSocket({
      connectionId: "allowed-h3",
      protocolMode: "h3",
      workspaceControlEventsAllowed: true,
    });
    const desktopSocket = testSocket({
      connectionId: "desktop",
      protocolMode: "jsonrpc",
    });

    control.registerSubscriber(deniedH3Socket, "/tmp");
    control.registerSubscriber(allowedH3Socket, "/tmp");
    control.registerSubscriber(desktopSocket, "/tmp");

    deniedH3Socket.data.workspaceControlEventsAllowed = true;

    (
      control as unknown as {
        notifySubscribers(cwd: string, event: Extract<SessionEvent, { type: "mcp_servers" }>): void;
      }
    ).notifySubscribers("/tmp", {
      type: "mcp_servers",
      sessionId: "session-1",
      servers: [],
    });

    expect(sent.map((entry) => entry.connectionId)).toEqual(["allowed-h3", "desktop"]);
  });

  test("keeps workspace-control subscriptions on the latest registered workspace only", () => {
    const sent: Array<{ connectionId: string | undefined; payload: unknown }> = [];
    const control = new WorkspaceControl({
      env: {},
      fallbackWorkingDirectory: "/tmp",
      registry: {} as never,
      socketSendQueue: {
        shouldSendNotification() {
          return true;
        },
        send(ws: { data: { connectionId?: string } }, payload: unknown) {
          sent.push({ connectionId: ws.data.connectionId, payload });
        },
      } as never,
    });
    const subscriber = testSocket({
      connectionId: "workspace-control-client",
      protocolMode: "jsonrpc",
    });

    control.registerSubscriber(subscriber, "/workspace-a");
    control.registerSubscriber(subscriber, "/workspace-b");

    (
      control as unknown as {
        notifySubscribers(cwd: string, event: Extract<SessionEvent, { type: "mcp_servers" }>): void;
      }
    ).notifySubscribers("/workspace-a", {
      type: "mcp_servers",
      sessionId: "workspace-a-control",
      servers: [],
    });
    (
      control as unknown as {
        notifySubscribers(cwd: string, event: Extract<SessionEvent, { type: "mcp_servers" }>): void;
      }
    ).notifySubscribers("/workspace-b", {
      type: "mcp_servers",
      sessionId: "workspace-b-control",
      servers: [],
    });

    expect(sent).toEqual([
      {
        connectionId: "workspace-control-client",
        payload: {
          method: "cowork/control/event",
          params: {
            cwd: "/workspace-b",
            type: "mcp_servers",
            sessionId: "workspace-b-control",
            servers: [],
          },
        },
      },
    ]);
  });
});
