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
const { McpServersPage, mcpCredentialDraftKey } = await import(
  "../src/ui/settings/pages/McpServersPage"
);

const defaultActions = {
  requestWorkspaceMcpServers: useAppStore.getState().requestWorkspaceMcpServers,
  upsertWorkspaceMcpServer: useAppStore.getState().upsertWorkspaceMcpServer,
  deleteWorkspaceMcpServer: useAppStore.getState().deleteWorkspaceMcpServer,
  setWorkspaceMcpServerEnabled: useAppStore.getState().setWorkspaceMcpServerEnabled,
  validateWorkspaceMcpServer: useAppStore.getState().validateWorkspaceMcpServer,
  authorizeWorkspaceMcpServerAuth: useAppStore.getState().authorizeWorkspaceMcpServerAuth,
  callbackWorkspaceMcpServerAuth: useAppStore.getState().callbackWorkspaceMcpServerAuth,
  setWorkspaceMcpServerApiKey: useAppStore.getState().setWorkspaceMcpServerApiKey,
};

type InputChangeProps = {
  onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
};

function setInputValue(
  harness: ReturnType<typeof setupJsdom>,
  input: HTMLInputElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    harness.dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  // The Bun preload imports React before jsdom exists, so direct DOM events
  // alone do not reliably drive controlled fields; call the React prop too.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? ((input as unknown as Record<string, unknown>)[propsKey] as InputChangeProps)
    : {};
  props.onChange?.({ target: input, currentTarget: input });
  input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
}

describe("MCP servers settings page", () => {
  beforeEach(() => {
    useAppStore.setState(defaultActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultActions);
  });

  test("keys credential drafts by workspace, source, and name", () => {
    expect(mcpCredentialDraftKey("ws-1", { name: "grep", source: "user" })).toBe("ws-1::user:grep");
    expect(mcpCredentialDraftKey("ws-1", { name: "grep", source: "plugin" })).toBe(
      "ws-1::plugin:grep",
    );
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
      expect(container.textContent).not.toContain("Connection");

      // All config layers are listed now, including system servers.
      expect(container.textContent).toContain("builtin");
      expect(container.textContent).toContain("Built-in");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("filterQuery narrows connector rows and shows a no-matches state", async () => {
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
                  name: "linear",
                  transport: { type: "http", url: "https://mcp.linear.app/mcp" },
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
        root.render(createElement(McpServersPage, { filterQuery: "Grep" }));
      });

      expect(container.textContent).toContain("grep");
      expect(container.textContent).not.toContain("linear");

      await act(async () => {
        root.render(createElement(McpServersPage, { filterQuery: "zzz" }));
      });

      expect(container.textContent).not.toContain("grep");
      expect(container.textContent).not.toContain("linear");
      expect(container.textContent).toContain("No matches for “zzz”");
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

      expect(container.textContent).not.toContain("Connection");
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

      expect(container.textContent?.match(/Connection/g) ?? []).toHaveLength(1);
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
        button.textContent?.includes("Test connection"),
      );
      expect(validateButtons).toHaveLength(2);
      await act(async () => {
        validateButtons[1]?.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(validateMcpServer).toHaveBeenCalledWith("ws-1", "grep", "plugin");

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

      expect(container.textContent?.match(/Last check/g) ?? []).toHaveLength(1);
      expect(container.textContent?.match(/Passed/g) ?? []).toHaveLength(1);
      expect(container.textContent).toContain("2 tools available");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("sends duplicate server credential actions with row source", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const setApiKey = mock(async () => {});
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
                  transport: { type: "http", url: "https://user.example.test" },
                  enabled: true,
                  source: "user",
                  inherited: true,
                  authMode: "missing",
                  authScope: "user",
                  authMessage: "API key required.",
                  auth: { type: "api_key" },
                },
                {
                  name: "grep",
                  transport: { type: "http", url: "https://plugin.example.test" },
                  enabled: true,
                  source: "plugin",
                  inherited: true,
                  authMode: "missing",
                  authScope: "user",
                  authMessage: "API key required.",
                  auth: { type: "api_key" },
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
          setWorkspaceMcpServerApiKey: setApiKey,
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

      const setKeyButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("Save key"),
      );
      expect(setKeyButtons).toHaveLength(2);
      await act(async () => {
        setKeyButtons[0]?.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(setApiKey).toHaveBeenCalledWith("ws-1", "grep", "", "user");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("adds a personal connector when only one-off chat workspaces exist", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const requestMcpServers = mock(async () => {});
    const upsertServer = mock(async () => {});
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
          ],
          selectedWorkspaceId: "chat-1",
          workspaceRuntimeById: {
            "chat-1": {
              ...useAppStore.getState().workspaceRuntimeById["chat-1"],
              serverUrl: "ws://mock",
              starting: false,
              error: null,
              controlSessionId: "control",
              mcpServers: [],
              mcpFiles: [],
              mcpWarnings: [],
              mcpValidationByName: {},
            },
          },
          requestWorkspaceMcpServers: requestMcpServers,
          upsertWorkspaceMcpServer: upsertServer,
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      expect(requestMcpServers).toHaveBeenCalledWith("chat-1");

      const doc = harness.dom.window.document;
      const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Add connector"),
      );
      expect(addButton).toBeDefined();

      await act(async () => {
        addButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const dialog = doc.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain("Add connector");
      expect(dialog?.textContent).not.toContain("Where should this be available?");

      const nameInput = doc.getElementById("mcp-connector-name");
      const urlInput = doc.getElementById("mcp-server-url");
      if (!nameInput || !urlInput) throw new Error("missing connector editor inputs");

      await act(async () => {
        setInputValue(harness, nameInput as HTMLInputElement, "Linear");
        setInputValue(harness, urlInput as HTMLInputElement, "https://mcp.linear.app/mcp");
      });

      const submitButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Add connector",
      );
      expect(submitButton).toBeDefined();

      await act(async () => {
        submitButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(upsertServer).toHaveBeenCalledWith(
        "chat-1",
        {
          name: "Linear",
          transport: { type: "http", url: "https://mcp.linear.app/mcp" },
          auth: { type: "none" },
        },
        undefined,
        "user",
      );
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("adds a project connector when Only this project is selected", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const upsertServer = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
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
          selectedWorkspaceId: "project-1",
          workspaceRuntimeById: {
            "project-1": {
              ...useAppStore.getState().workspaceRuntimeById["project-1"],
              serverUrl: "ws://mock",
              starting: false,
              error: null,
              controlSessionId: "control",
              mcpServers: [],
              mcpFiles: [],
              mcpWarnings: [],
              mcpValidationByName: {},
            },
          },
          requestWorkspaceMcpServers: mock(async () => {}),
          upsertWorkspaceMcpServer: upsertServer,
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      const doc = harness.dom.window.document;
      const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Add connector"),
      );
      expect(addButton).toBeDefined();

      await act(async () => {
        addButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const dialog = doc.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain("Where should this be available?");

      const allProjectsRadio = doc.getElementById("mcp-location-user");
      const onlyProjectRadio = doc.getElementById("mcp-location-workspace");
      expect(allProjectsRadio?.getAttribute("aria-checked")).toBe("true");
      expect(onlyProjectRadio).not.toBeNull();

      await act(async () => {
        onlyProjectRadio?.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(onlyProjectRadio?.getAttribute("aria-checked")).toBe("true");

      const nameInput = doc.getElementById("mcp-connector-name");
      const urlInput = doc.getElementById("mcp-server-url");
      if (!nameInput || !urlInput) throw new Error("missing connector editor inputs");

      await act(async () => {
        setInputValue(harness, nameInput as HTMLInputElement, "Notion");
        setInputValue(harness, urlInput as HTMLInputElement, "https://mcp.notion.com/mcp");
      });

      const submitButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Add connector",
      );
      expect(submitButton).toBeDefined();

      await act(async () => {
        submitButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(upsertServer).toHaveBeenCalledWith(
        "project-1",
        {
          name: "Notion",
          transport: { type: "http", url: "https://mcp.notion.com/mcp" },
          auth: { type: "none" },
        },
        undefined,
        "workspace",
      );
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("workspace-source rows are editable and removed with their own source", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const deleteServer = mock(async () => {});
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
                  name: "project-tool",
                  transport: { type: "http", url: "https://project.example.test" },
                  enabled: true,
                  source: "workspace",
                  inherited: false,
                  authMode: "none",
                  authScope: "workspace",
                  authMessage: "",
                },
              ],
              mcpFiles: [],
              mcpWarnings: [],
              mcpValidationByName: {},
            },
          },
          requestWorkspaceMcpServers: mock(async () => {}),
          deleteWorkspaceMcpServer: deleteServer,
        });
      });

      await act(async () => {
        root.render(createElement(McpServersPage));
      });

      expect(container.textContent).toContain("Project");
      expect(container.querySelector('[aria-label="Edit project-tool"]')).not.toBeNull();

      const rowButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("project-tool"),
      );
      expect(rowButton).toBeDefined();
      await act(async () => {
        rowButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const removeButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Remove",
      );
      expect(removeButton).toBeDefined();
      await act(async () => {
        removeButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(deleteServer).toHaveBeenCalledWith("ws-1", "project-tool", "workspace");
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
