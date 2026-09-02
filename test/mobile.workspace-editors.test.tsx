import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(resolved + ".ts", factory);
  mock.module(resolved + ".tsx", factory);
}

let platform: "ios" | "android" = "ios";
const Container = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
mockLocalModule("react-native", "apps/mobile/node_modules/react-native", () => ({
  Alert: { alert: mock(() => {}) },
  StyleSheet: { hairlineWidth: 1 },
  get Platform() {
    return { OS: platform };
  },
  ActivityIndicator: () => createElement("span", null, "Loading"),
  View: Container,
  ScrollView: Container,
  KeyboardAvoidingView: Container,
  Modal: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
    visible ? createElement("dialog", { open: true }, children) : null,
  Text: Container,
  Switch: ({ accessibilityLabel, value, onValueChange }: any) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      onChange: () => onValueChange(!value),
    }),
  TextInput: ({ accessibilityLabel, editable, multiline, onChangeText, value }: any) =>
    createElement(multiline ? "textarea" : "input", {
      "aria-label": accessibilityLabel,
      disabled: editable === false,
      value,
      onInput: (event: { currentTarget: { value: string } }) =>
        onChangeText(event.currentTarget.value),
    }),
  Pressable: ({ accessibilityLabel, accessibilityState, children, disabled, onPress }: any) =>
    createElement(
      "button",
      {
        "aria-label": accessibilityLabel,
        "aria-busy": accessibilityState?.busy,
        disabled,
        onClick: onPress,
      },
      children,
    ),
}));
mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => 48,
    useAccessibilityAnnouncement: () => {},
    useReducedMotionEnabled: () => true,
  }),
);
mockLocalModule("@/components/ui/screen", "apps/mobile/src/components/ui/screen", () => ({
  Screen: Container,
}));
mockLocalModule("@/components/ui/app-button", "apps/mobile/src/components/ui/app-button", () => ({
  AppButton: ({ children, onPress, accessibilityLabel }: any) =>
    createElement("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
}));
mockLocalModule(
  "@/components/pairing/grouped-list",
  "apps/mobile/src/components/pairing/grouped-list",
  () => ({
    GroupedScreen: Container,
    GroupedSection: ({ children, footer, title }: any) =>
      createElement("section", null, title, children, footer),
  }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    border: "#ddd",
    primary: "#36f",
    text: "#111",
    textSecondary: "#555",
    danger: "#a00",
  }),
}));
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (selector: any) =>
      selector({ connectionState: { status: "connected", transportMode: "native" } }),
  }),
);

const { useMcpStore } = await import("../apps/mobile/src/features/cowork/mcpStore");
const { useBackupStore } = await import("../apps/mobile/src/features/cowork/backupStore");
const { useMemoryStore } = await import("../apps/mobile/src/features/cowork/memoryStore");
const { setOfflineCacheDesktop } = await import(
  "../apps/mobile/src/features/cowork/offlineCacheStorage"
);
const { useProviderStore } = await import("../apps/mobile/src/features/cowork/providerStore");
const { useSkillsStore } = await import("../apps/mobile/src/features/cowork/skillsStore");
const { useThreadStore } = await import("../apps/mobile/src/features/cowork/threadStore");
const { useWorkspaceStore } = await import("../apps/mobile/src/features/cowork/workspaceStore");
const MemoryScreen = (
  await import("../apps/mobile/src/app/(app)/(tabs)/(workspace)/workspace/memory")
).default;
const McpScreen = (await import("../apps/mobile/src/app/(app)/(tabs)/(settings)/settings/mcp"))
  .default;
const SkillsScreen = (await import("../apps/mobile/src/app/(app)/(tabs)/(skills)/skills/index"))
  .default;
const GeneralScreen = (
  await import("../apps/mobile/src/app/(app)/(tabs)/(workspace)/workspace/general")
).default;
const UsageScreen = (await import("../apps/mobile/src/app/(app)/(tabs)/(settings)/settings/usage"))
  .default;
const ProvidersScreen = (
  await import("../apps/mobile/src/app/(app)/(tabs)/(settings)/settings/providers")
).default;
const BackupsScreen = (
  await import("../apps/mobile/src/app/(app)/(tabs)/(workspace)/workspace/backups")
).default;

const saveMemory = mock(async (..._args: any[]) => false);
const saveMcp = mock(async (..._args: any[]) => false);
const saveApiKey = mock(async (..._args: any[]) => false);
const completeOauth = mock(async (..._args: any[]) => false);
const installSkill = mock(async (..._args: any[]) => false);
const fetchMemories = mock(async () => {});
const fetchServers = mock(async () => {});
const fetchSkills = mock(async () => {});
const fetchBackups = mock(async () => {});
const refreshProviders = mock(async () => {});
const applyDefaults = mock(async (..._args: any[]) => false);
const configuredMemory = {
  id: "hot",
  scope: "workspace" as const,
  content: "Existing memory remains unchanged",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const configuredMcp = {
  name: "docs",
  transport: {
    type: "stdio" as const,
    command: "node",
    args: ["/tmp/My Project/server.js", "", "--label", "three words"],
    env: { FIXTURE_MODE: "test" },
    cwd: "/tmp/My Project",
  },
  required: true,
  enabled: false,
  retries: 3,
  icon: "docs-icon",
  auth: {
    type: "api_key" as const,
    headerName: "X-API-Key",
    prefix: "Bearer ",
    keyId: "saved-key-id",
  },
};

beforeEach(() => {
  platform = "ios";
  setOfflineCacheDesktop("desktop-a");
  for (const fn of [saveMemory, saveMcp, saveApiKey, completeOauth, installSkill, applyDefaults]) {
    fn.mockReset();
    fn.mockImplementation(async () => false);
  }
  for (const fn of [fetchMemories, fetchServers, fetchSkills, fetchBackups, refreshProviders])
    fn.mockClear();
  useWorkspaceStore.getState().clear();
  useWorkspaceStore.setState({
    activeWorkspaceCwd: "/workspace",
    activeWorkspaceName: "Workspace",
    applyWorkspaceDefaults: applyDefaults as never,
  });
  useMemoryStore.getState().clear();
  useMemoryStore.setState({ fetchMemories, upsertMemory: saveMemory });
  useMcpStore.getState().clear();
  useMcpStore.setState({
    fetchServers,
    upsertServer: saveMcp,
    setServerApiKey: saveApiKey,
    callbackServer: completeOauth,
    servers: [
      {
        ...configuredMcp,
        source: "workspace",
        inherited: false,
        authMode: "api_key",
        authScope: "workspace",
        authMessage: "Ready",
      },
    ],
  });
  useSkillsStore.getState().clear();
  useSkillsStore.setState({ fetchSkills, installSkill });
  useProviderStore.getState().clear();
  useProviderStore.setState({ refresh: refreshProviders });
  useBackupStore.getState().clear();
  useBackupStore.setState({ fetchBackups });
  useThreadStore.getState().clearAll();
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(() => mock.restore());

async function mount(Screen: () => ReactNode) {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    harness.restore();
  };
  await act(async () => root.render(createElement(Screen)));
  return {
    container,
    async press(label: string) {
      const button = container.querySelector('[aria-label="' + label + '"]');
      if (!(button instanceof harness.dom.window.HTMLButtonElement))
        throw new Error("Missing button: " + label);
      await act(async () => button.click());
    },
    input(label: string) {
      const input = container.querySelector('[aria-label="' + label + '"]');
      if (
        !(input instanceof harness.dom.window.HTMLInputElement) &&
        !(input instanceof harness.dom.window.HTMLTextAreaElement)
      )
        throw new Error("Missing input: " + label);
      return input;
    },
    async change(label: string, value: string) {
      const input = container.querySelector('[aria-label="' + label + '"]')!;
      const prototype =
        input.tagName === "TEXTAREA"
          ? harness.dom.window.HTMLTextAreaElement.prototype
          : harness.dom.window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
        input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
      });
    },
  };
}

describe("mobile workspace editor recovery", () => {
  test.each(["ios", "android"] as const)(
    "%s retains duplicate Add memory drafts and shows the server collision error",
    async (os) => {
      platform = os;
      const collision = 'Memory "hot" already exists. Edit it or use a different title.';
      useMemoryStore.setState({ entries: [configuredMemory] });
      saveMemory.mockImplementation(async () => {
        useMemoryStore.setState({ error: collision });
        return false;
      });
      const screen = await mount(MemoryScreen);
      await screen.press("Add memory entry");
      await screen.change("Memory entry ID", "  hot  ");
      await screen.change("Memory content", "  Keep this memory\n");
      await screen.press("Save memory entry");
      expect(saveMemory).toHaveBeenCalledTimes(1);
      expect(saveMemory).toHaveBeenCalledWith("workspace", "hot", "Keep this memory", "create");
      expect(screen.input("Memory entry ID").value).toBe("  hot  ");
      expect(screen.input("Memory content").value).toBe("  Keep this memory\n");
      expect(screen.container.textContent).toContain(collision);
      expect(screen.container.textContent).toContain(configuredMemory.content);
    },
  );

  test.each(["ios", "android"] as const)(
    "%s explicitly updates existing memory and resets the next Add to create-only",
    async (os) => {
      platform = os;
      useMemoryStore.setState({ entries: [configuredMemory] });
      saveMemory.mockImplementation(async () => true);
      const screen = await mount(MemoryScreen);
      await screen.press("Edit hot");
      await screen.change("Memory content", "Edited memory");
      await screen.press("Save memory entry");
      expect(saveMemory).toHaveBeenLastCalledWith("workspace", "hot", "Edited memory", "upsert");

      await screen.press("Add memory entry");
      await screen.change("Memory content", "New memory");
      await screen.press("Save memory entry");
      expect(saveMemory).toHaveBeenLastCalledWith("workspace", "hot", "New memory", "create");
    },
  );

  test("does not erase a newer memory edit when an earlier save succeeds", async () => {
    let resolveSave: (saved: boolean) => void = () => {};
    saveMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const screen = await mount(MemoryScreen);
    await screen.press("Add memory entry");
    await screen.change("Memory content", "First edit");
    await screen.press("Save memory entry");
    await screen.press("Save memory entry");
    await screen.change("Memory content", "Newer edit");
    await act(async () => resolveSave(true));
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(screen.input("Memory content").value).toBe("Newer edit");
  });

  test.each(["ios", "android"] as const)(
    "%s retains failed integration edits and credentials",
    async (os) => {
      platform = os;
      const screen = await mount(McpScreen);
      await screen.press("Edit docs");
      await screen.change("Integration name", "edited-docs");
      await screen.press("Save integration");
      expect(screen.input("Integration name").value).toBe("edited-docs");
      await screen.change("API key for docs", "fixture-secret");
      await screen.press("Save API key for docs");
      expect(screen.input("API key for docs").value).toBe("fixture-secret");
    },
  );

  test("editing an integration round-trips argument boundaries and hidden configuration", async () => {
    saveMcp.mockImplementation(async () => true);
    const screen = await mount(McpScreen);
    await screen.press("Edit docs");
    await screen.press("Save integration");
    expect(saveMcp.mock.calls[0]?.[0]).toEqual(configuredMcp);
  });

  test("preserves custom headers when editing an HTTP integration", async () => {
    const configuration = {
      ...configuredMcp,
      transport: {
        type: "http" as const,
        url: "https://example.com/mcp",
        headers: { "X-Workspace": "saved-value" },
      },
    };
    useMcpStore.setState({
      servers: [{ ...useMcpStore.getState().servers[0]!, ...configuration }],
    });
    const screen = await mount(McpScreen);
    await screen.press("Edit docs");
    await screen.press("Save integration");
    expect(saveMcp.mock.calls[0]?.[0]).toEqual(configuration);
  });

  test("keeps newer integration edits while a previous save is pending", async () => {
    let resolveSave: (saved: boolean) => void = () => {};
    saveMcp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const screen = await mount(McpScreen);
    await screen.press("Edit docs");
    await screen.press("Save integration");
    await screen.press("Save integration");
    await screen.change("Integration name", "newer-name");
    await act(async () => resolveSave(true));
    expect(saveMcp).toHaveBeenCalledTimes(1);
    expect(screen.input("Integration name").value).toBe("newer-name");
  });

  test("retains rejected OAuth codes and clears only acknowledged credentials", async () => {
    useMcpStore.setState({
      servers: [
        { ...useMcpStore.getState().servers[0]!, auth: { type: "oauth", oauthMode: "code" } },
      ],
      lastAuthChallenge: { name: "docs", instructions: "Enter the authorization code" },
    });
    const screen = await mount(McpScreen);
    await screen.change("OAuth code for docs", "fixture-code");
    await screen.press("Submit OAuth code for docs");
    expect(screen.input("OAuth code for docs").value).toBe("fixture-code");
    completeOauth.mockImplementationOnce(async () => true);
    await screen.press("Submit OAuth code for docs");
    expect(screen.input("OAuth code for docs").value).toBe("");
  });

  test("does not erase newer API-key text or resubmit while a credential save is pending", async () => {
    let resolveSave: (saved: boolean) => void = () => {};
    saveApiKey.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const screen = await mount(McpScreen);
    await screen.change("API key for docs", "first-key");
    await screen.press("Save API key for docs");
    await screen.press("Save API key for docs");
    await screen.change("API key for docs", "newer-key");
    await act(async () => resolveSave(true));
    expect(saveApiKey).toHaveBeenCalledTimes(1);
    expect(screen.input("API key for docs").value).toBe("newer-key");
  });

  test("keeps invalid argument JSON in the editor without sending a broken config", async () => {
    const screen = await mount(McpScreen);
    await screen.press("Edit docs");
    await screen.change("Integration command arguments", "[not valid JSON]");
    await screen.press("Save integration");
    expect(saveMcp).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain("Arguments must be a JSON array of strings");
  });

  test("retains the skill source after a failed installation", async () => {
    const screen = await mount(SkillsScreen);
    await screen.change("Skill source", "owner/repo");
    await screen.press("Install skill");
    expect(installSkill).toHaveBeenCalledWith("owner/repo", "project");
    expect(screen.input("Skill source").value).toBe("owner/repo");
  });

  test("retries a failed skill installation instead of merely reloading the catalog", async () => {
    installSkill.mockImplementation(async () => {
      useSkillsStore.setState({ error: "Install failed" });
      return false;
    });
    const screen = await mount(SkillsScreen);
    await screen.change("Skill source", "owner/repo");
    await screen.press("Install skill");
    await screen.press("Retry installation");
    expect(installSkill).toHaveBeenCalledTimes(2);
    expect(fetchSkills).toHaveBeenCalledTimes(1);
  });

  test.each([
    { name: "Memory", screen: MemoryScreen, fetch: fetchMemories },
    { name: "MCP", screen: McpScreen, fetch: fetchServers },
    { name: "Skills", screen: SkillsScreen, fetch: fetchSkills },
    { name: "General", screen: GeneralScreen, fetch: refreshProviders },
    { name: "Providers", screen: ProvidersScreen, fetch: refreshProviders },
    { name: "Backups", screen: BackupsScreen, fetch: fetchBackups },
  ])("$name waits for workspace hydration before loading", async ({ screen: Screen, fetch }) => {
    useWorkspaceStore.setState({ activeWorkspaceCwd: null, loading: true });
    await mount(Screen);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () =>
      useWorkspaceStore.setState({ activeWorkspaceCwd: "/ready", loading: false }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceCwd: "/another-workspace" }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each(["ios", "android"] as const)(
    "%s does not carry routing drafts between desktops with the same workspace path",
    async (os) => {
      platform = os;
      useWorkspaceStore.setState({
        controlSnapshot: {
          sessionConfig: {
            preferredChildModel: "a-saved",
            preferredChildModelRef: "a/model",
            allowedChildModelRefs: ["a/allowed"],
            childModelRoutingMode: "cross-provider-allowlist",
          },
        } as never,
      });
      const screen = await mount(GeneralScreen);
      await screen.change("Preferred child model", "a-dirty-edit");
      await screen.change("Preferred child model reference", "a/dirty-target");
      await screen.change("Allowed child model references", "a/dirty-allowed");

      await act(async () => {
        setOfflineCacheDesktop("desktop-b");
        useWorkspaceStore.getState().clear();
      });
      await act(async () =>
        useWorkspaceStore.setState({
          activeWorkspaceCwd: "/workspace",
          activeWorkspaceName: "Desktop B",
          controlSnapshot: {
            sessionConfig: {
              preferredChildModel: "b-saved",
              preferredChildModelRef: "b/model",
              allowedChildModelRefs: ["b/allowed"],
              childModelRoutingMode: "cross-provider-allowlist",
            },
          } as never,
        }),
      );

      expect(screen.input("Preferred child model").value).toBe("b-saved");
      expect(screen.input("Preferred child model reference").value).toBe("b/model");
      expect(screen.input("Allowed child model references").value).toBe("b/allowed");
      await screen.change("Preferred child model reference", "b/new-target");
      await screen.press("Save routing defaults");
      expect(applyDefaults).toHaveBeenCalledWith({
        config: {
          preferredChildModel: "b-saved",
          preferredChildModelRef: "b/new-target",
          allowedChildModelRefs: ["b/allowed"],
          childModelRoutingMode: "cross-provider-allowlist",
        },
      });
    },
  );

  test("keeps routing drafts across unrelated snapshot changes and shows save errors", async () => {
    useWorkspaceStore.setState({
      controlSnapshot: { sessionConfig: { preferredChildModel: "saved" } } as never,
    });
    const screen = await mount(GeneralScreen);
    await screen.change("Preferred child model", "unsaved edit");
    await act(async () =>
      useWorkspaceStore.setState({
        controlSnapshot: {
          sessionConfig: { preferredChildModel: "saved", backupsEnabled: true },
        } as never,
      }),
    );
    expect(screen.input("Preferred child model").value).toBe("unsaved edit");
    await act(async () => useWorkspaceStore.setState({ error: "Desktop rejected these defaults" }));
    expect(screen.container.textContent).toContain("Desktop rejected these defaults");
  });

  test("does not replace a newer routing edit after an earlier save is acknowledged", async () => {
    let resolveSave: (saved: boolean) => void = () => {};
    applyDefaults.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const screen = await mount(GeneralScreen);
    await screen.change("Preferred child model", "first-model");
    await screen.press("Save routing defaults");
    await screen.press("Save routing defaults");
    await screen.change("Preferred child model", "newer-model");
    await act(async () => {
      useWorkspaceStore.setState({
        controlSnapshot: { sessionConfig: { preferredChildModel: "first-model" } } as never,
      });
      resolveSave(true);
    });
    expect(applyDefaults).toHaveBeenCalledTimes(1);
    expect(screen.input("Preferred child model").value).toBe("newer-model");
  });

  test("usage reads canonical token/cost fields and identifies the loaded-chat scope", async () => {
    useThreadStore.setState({
      snapshots: {
        one: {
          sessionUsage: {
            totalPromptTokens: 1200,
            totalCompletionTokens: 340,
            estimatedTotalCostUsd: 0.25,
          },
        },
      } as never,
    });
    const screen = await mount(UsageScreen);
    expect(screen.container.textContent).toContain("1,200");
    expect(screen.container.textContent).toContain("340");
    expect(screen.container.textContent).toContain("$0.2500");
    expect(screen.container.textContent).toContain("loaded on this phone");
  });

  test("does not represent unknown usage cost as zero", async () => {
    useThreadStore.setState({
      snapshots: {
        one: {
          sessionUsage: {
            totalPromptTokens: 12,
            totalCompletionTokens: 34,
            estimatedTotalCostUsd: null,
          },
        },
      } as never,
    });
    const screen = await mount(UsageScreen);
    expect(screen.container.textContent).toContain("Estimated costUnavailable");
    expect(screen.container.textContent).not.toContain("$0.0000");
  });
});
