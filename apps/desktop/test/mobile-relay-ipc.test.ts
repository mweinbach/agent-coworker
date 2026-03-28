import { afterEach, describe, expect, mock, test } from "bun:test";

const getAllWindowsMock = mock(() => []);

mock.module("electron", () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getName: () => "Cowork Test",
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
}));

const { registerMobileRelayIpc } = await import("../electron/ipc/mobileRelay");

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("mobile relay IPC", () => {
  afterEach(() => {
    getAllWindowsMock.mockClear();
  });

  test("logs workspace cache refresh failures instead of swallowing them", async () => {
    let workspaceListProvider: (() => unknown[]) | null = null;
    const loadState = mock(async () => {
      throw new Error("disk offline");
    });
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      registerMobileRelayIpc({
        deps: {
          persistence: { loadState } as never,
          mobileRelayBridge: {
            setWorkspaceListProvider(provider: () => unknown[]) {
              workspaceListProvider = provider;
            },
            on() {},
            start: async () => ({}),
            stop: async () => ({}),
            getSnapshot: () => ({}),
            rotateSession: async () => ({}),
            forgetTrustedPhone: async () => ({}),
          } as never,
        } as never,
        workspaceRoots: {} as never,
        handleDesktopInvoke() {},
        parseWithSchema(_schema, value) {
          return value as never;
        },
      });

      await flushMicrotasks();

      expect(loadState).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[desktop] Failed to refresh mobile relay workspace cache during initial load: disk offline",
      );
      expect(workspaceListProvider?.()).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
