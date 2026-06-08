import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());
mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { McpServersPage } = await import("../src/ui/settings/pages/McpServersPage");

const defaultActions = {
  requestWorkspaceMcpServers: useAppStore.getState().requestWorkspaceMcpServers,
  setWorkspaceMcpServerEnabled: useAppStore.getState().setWorkspaceMcpServerEnabled,
};

describe("MCP servers settings page", () => {
  beforeEach(() => {
    useAppStore.setState(defaultActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultActions);
  });

  test("renders per-server switches and toggles without expanding the row", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const setEnabled = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace",
              path: "/tmp/workspace",
              createdAt: "2026-04-28T00:00:00.000Z",
              lastOpenedAt: "2026-04-28T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.5",
              defaultPreferredChildModel: "gpt-5.5",
              defaultEnableMcp: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          workspaceRuntimeById: {
            "ws-1": {
              ...useAppStore.getState().workspaceRuntimeById["ws-1"],
              serverUrl: "ws://mock",
              starting: false,
              error: null,
              controlSessionId: "control",
              mcpServers: [
                {
                  name: "grep",
                  transport: { type: "http", url: "https://mcp.grep.app" },
                  enabled: false,
                  source: "user",
                  inherited: true,
                  authMode: "none",
                  authScope: "user",
                  authMessage: "",
                },
                {
                  name: "builtin",
                  transport: { type: "stdio", command: "builtin" },
                  enabled: false,
                  source: "system",
                  inherited: true,
                  authMode: "none",
                  authScope: "user",
                  authMessage: "",
                },
              ],
              mcpFiles: [],
              mcpWarnings: [],
              mcpValidationByName: {},
            },
          },
          requestWorkspaceMcpServers: mock(async () => {}),
          setWorkspaceMcpServerEnabled: setEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      expect(container.textContent).toContain("grep");
      expect(container.textContent).toContain("Disabled");

      const grepSwitch = container.querySelector('[aria-label="Enable grep"]');
      expect(grepSwitch).not.toBeNull();
      await act(async () => {
        grepSwitch?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setEnabled).toHaveBeenCalledWith("ws-1", {
        name: "grep",
        source: "user",
        enabled: true,
      });
      expect(container.textContent).not.toContain("Command");

      expect(container.textContent).not.toContain("builtin");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("edit icon opens the server editor without expanding inline details", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: true,
      setupWindow: (dom) => {
        (dom.window.HTMLElement.prototype as { attachEvent?: () => void }).attachEvent = () => {};
        (dom.window.HTMLElement.prototype as { detachEvent?: () => void }).detachEvent = () => {};
      },
    });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace",
              path: "/tmp/workspace",
              createdAt: "2026-04-28T00:00:00.000Z",
              lastOpenedAt: "2026-04-28T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.5",
              defaultPreferredChildModel: "gpt-5.5",
              defaultEnableMcp: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          workspaceRuntimeById: {
            "ws-1": {
              ...useAppStore.getState().workspaceRuntimeById["ws-1"],
              serverUrl: "ws://mock",
              starting: false,
              error: null,
              controlSessionId: "control",
              mcpServers: [
                {
                  name: "grep",
                  transport: { type: "http", url: "https://mcp.grep.app" },
                  enabled: true,
                  source: "user",
                  inherited: true,
                  authMode: "none",
                  authScope: "user",
                  authMessage: "",
                },
              ],
              mcpFiles: [],
              mcpWarnings: [],
              mcpValidationByName: {},
            },
          },
          requestWorkspaceMcpServers: mock(async () => {}),
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      const editButton = container.querySelector('[aria-label="Edit grep"]');
      expect(editButton).not.toBeNull();

      expect(container.textContent).not.toContain("Command");
      expect(editButton).not.toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });
});
