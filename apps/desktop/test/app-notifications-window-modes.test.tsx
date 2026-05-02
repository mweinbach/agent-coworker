import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const showNotification = mock(async () => true);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    showNotification,
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const App = (await import("../src/App")).default;
const { useAppStore } = await import("../src/app/store");

const defaultStoreState = useAppStore.getState();

function seedReadyState() {
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPending: false,
    startupError: null,
    workspaces: [],
    threads: [],
    notifications: [
      {
        id: "n-1",
        kind: "info",
        title: "Heads up",
        detail: "Popup test",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
    ],
  });
}

describe("app window-mode notification routing", () => {
  beforeEach(() => {
    showNotification.mockClear();
    useAppStore.setState(defaultStoreState);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test("only the main window forwards store notifications to OS notices", async () => {
    const harness = setupJsdom({
      setupWindow: (dom) => {
        dom.window.history.replaceState({}, "", "http://localhost/?window=quick-chat");
      },
    });

    try {
      seedReadyState();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      expect(showNotification).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("main window still forwards new notifications to the OS", async () => {
    const harness = setupJsdom();

    try {
      seedReadyState();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      expect(showNotification).toHaveBeenCalledWith({
        title: "Heads up",
        body: "Popup test",
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
