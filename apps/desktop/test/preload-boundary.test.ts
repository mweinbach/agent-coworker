import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type DesktopApi,
} from "../src/lib/desktopApi";
import { createElectronMock } from "./helpers/mockElectron";

type IpcListener = (event: unknown, payload: unknown) => void;

let exposedApi: DesktopApi | undefined;
let invokeResult: unknown;
const listeners = new Map<string, IpcListener>();
const invoke = mock(async (_channel: string, _input?: unknown) => invokeResult);
const off = mock((channel: string, listener: IpcListener) => {
  if (listeners.get(channel) === listener) listeners.delete(channel);
});

mock.module("electron", () => ({
  ...createElectronMock(),
  contextBridge: {
    exposeInMainWorld(name: string, api: DesktopApi) {
      if (name !== "cowork") throw new Error(`Unexpected preload bridge: ${name}`);
      exposedApi = api;
    },
  },
  ipcRenderer: {
    invoke,
    on: (channel: string, listener: IpcListener) => listeners.set(channel, listener),
    off,
  },
  webUtils: { getPathForFile: () => "" },
}));

await import("../electron/preload");

function api(): DesktopApi {
  if (!exposedApi) throw new Error("Preload did not expose the desktop bridge");
  return exposedApi;
}

beforeEach(() => {
  invokeResult = undefined;
  invoke.mockClear();
  off.mockClear();
  listeners.clear();
});

describe("preload validation boundary", () => {
  test("forwards valid input and rejects invalid input before invoking IPC", async () => {
    const input = { workspaceId: "workspace-1", workspacePath: "/workspace", yolo: false };
    invokeResult = { url: "ws://127.0.0.1:7337/ws" };
    expect(Object.isFrozen(api())).toBe(true);
    await expect(api().startWorkspaceServer(input)).resolves.toEqual(invokeResult);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.startWorkspaceServer, input);

    expect(() => api().startWorkspaceServer({ ...input, workspaceId: "bad/id" })).toThrow(
      /^startWorkspaceServer options /,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("accepts valid status responses and rejects malformed responses", async () => {
    invokeResult = {
      workspaceId: "workspace-1",
      running: true,
      url: "ws://127.0.0.1:7337/ws",
      reason: "running",
    };
    await expect(api().getWorkspaceServerStatus({ workspaceId: "workspace-1" })).resolves.toEqual(
      invokeResult,
    );

    invokeResult = { workspaceId: "workspace-1", running: "yes" };
    await expect(api().getWorkspaceServerStatus({ workspaceId: "workspace-1" })).rejects.toThrow(
      /^workspace server status /,
    );
  });

  test("validates notifications before delivery and removes the subscribed listener", () => {
    const listener = mock(() => {});
    const unsubscribe = api().onWindowCloseRequested(listener);
    const wrapped = listeners.get(DESKTOP_EVENT_CHANNELS.windowCloseRequested);
    if (!wrapped) throw new Error("Preload did not subscribe to close requests");
    const request = { requestId: "close-1" };
    wrapped({}, request);
    expect(listener).toHaveBeenCalledWith(request);
    expect(() => wrapped({}, { requestId: "bad/id" })).toThrow(/^window close request /);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(off).toHaveBeenCalledWith(DESKTOP_EVENT_CHANNELS.windowCloseRequested, wrapped);
    expect(listeners.size).toBe(0);
  });
});
