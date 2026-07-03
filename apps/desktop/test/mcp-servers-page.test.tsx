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
  validateWorkspaceMcpServer: useAppStore.getState().validateWorkspaceMcpServer,
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

      // All config layers are listed now, including system servers.
      expect(container.textContent).toContain("builtin");
      expect(container.textContent).toContain("system");
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

  test("keeps duplicate server names expanded independently by source", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
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
                {
                  name: "grep",
                  transport: { type: "stdio", command: "plugin-grep" },
                  enabled: true,
                  source: "plugin",
                  inherited: true,
                  authMode: "none",
                  authScope: "user",
                  authMessage: "",
                  pluginId: "search-plugin",
                  pluginScope: "user",
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

      const rowButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("grep"),
      );
      expect(rowButtons).toHaveLength(2);

      await act(async () => {
        rowButtons[0]?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent?.match(/Command/g) ?? []).toHaveLength(1);
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("targets the project workspace when a one-off chat is selected", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const requestMcpServers = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "chat-1",
              name: "New chat",
              path: "/tmp/.cowork/chats/chat-1",
              workspaceKind: "oneOffChat",
              createdAt: "2026-04-28T00:00:00.000Z",
              lastOpenedAt: "2026-04-28T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.5",
              defaultPreferredChildModel: "gpt-5.5",
              defaultEnableMcp: true,
              yolo: false,
            },
            {
              id: "project-1",
              name: "Project",
              path: "/tmp/project",
              workspaceKind: "project",
              createdAt: "2026-04-28T00:00:00.000Z",
              lastOpenedAt: "2026-04-28T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.5",
              defaultPreferredChildModel: "gpt-5.5",
              defaultEnableMcp: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "chat-1",
          workspaceRuntimeById: {
            "chat-1": {
              ...useAppStore.getState().workspaceRuntimeById["chat-1"],
              mcpServers: [
                {
                  name: "chat-only",
                  transport: { type: "stdio", command: "chat" },
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
            "project-1": {
              ...useAppStore.getState().workspaceRuntimeById["project-1"],
              mcpServers: [
                {
                  name: "project-server",
                  transport: { type: "stdio", command: "project" },
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
          requestWorkspaceMcpServers: requestMcpServers,
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      expect(requestMcpServers).toHaveBeenCalledWith("project-1");
      expect(container.textContent).toContain("project-server");
      expect(container.textContent).not.toContain("chat-only");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("keeps duplicate server validation attached to the validated source", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const validateMcpServer = mock(async () => {});
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
                {
                  name: "grep",
                  transport: { type: "stdio", command: "plugin-grep" },
                  enabled: true,
                  source: "plugin",
                  inherited: true,
                  authMode: "none",
                  authScope: "user",
                  authMessage: "",
                  pluginId: "search-plugin",
                  pluginScope: "user",
                },
              ],
              mcpFiles: [],
              mcpWarnings: [],
              mcpValidationByName: {},
            },
          },
          requestWorkspaceMcpServers: mock(async () => {}),
          validateWorkspaceMcpServer: validateMcpServer,
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      const rowButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("grep"),
      );
      expect(rowButtons).toHaveLength(2);
      await act(async () => {
        rowButtons[0]?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        rowButtons[1]?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const validateButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("Validate Connection"),
      );
      expect(validateButtons).toHaveLength(2);
      await act(async () => {
        validateButtons[1]?.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(validateMcpServer).toHaveBeenCalledWith("ws-1", "grep");

      await act(async () => {
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            "ws-1": {
              ...state.workspaceRuntimeById["ws-1"],
              mcpValidationByName: {
                grep: {
                  type: "mcp_server_validation",
                  sessionId: "control",
                  name: "grep",
                  ok: true,
                  mode: "none",
                  message: "MCP server validation succeeded.",
                  toolCount: 2,
                  tools: [],
                  latencyMs: 5,
                },
              },
            },
          },
        }));
      });

      expect(container.textContent?.match(/Last Check/g) ?? []).toHaveLength(1);
      expect(container.textContent?.match(/Passed \(none\)/g) ?? []).toHaveLength(1);
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
