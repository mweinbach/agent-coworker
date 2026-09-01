import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "../apps/desktop/test/jsdomHarness";
import type { CoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/jsonRpcClient";

const originalPlatform = process.env.EXPO_OS;
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));

function mockMobileModule(alias: string, factory: () => unknown) {
  mock.module(alias, factory);
  mock.module(mobileRequire.resolve(alias), factory);
}

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

type NativeProps = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { busy?: boolean; selected?: boolean };
  disabled?: boolean;
  onPress?: () => void;
};
const nativeHost =
  (tag: "div" | "span" | "button") =>
  ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
    onPress,
  }: NativeProps) =>
    createElement(
      tag,
      {
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-busy": accessibilityState?.busy,
        "aria-checked": accessibilityState?.selected,
        disabled,
        onClick: onPress,
      },
      children,
    );

mockMobileModule("react-native", () => ({
  ActivityIndicator: () => createElement("span", { "aria-busy": true }),
  Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement("section", { role: "dialog" }, children) : null,
  Pressable: nativeHost("button"),
  ScrollView: nativeHost("div"),
  Text: nativeHost("span"),
  View: nativeHost("div"),
}));
mockMobileModule("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => (process.env.EXPO_OS === "ios" ? 44 : 48),
    useAccessibilityAnnouncement: () => undefined,
    useReducedMotionEnabled: () => false,
  }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    background: "#fff",
    primary: "#060",
    surfaceMuted: "#eee",
    surfaceElevated: "#fff",
    text: "#111",
    textSecondary: "#555",
    textTertiary: "#777",
    danger: "#900",
    success: "#060",
    successMuted: "#ded",
  }),
}));
const clearWorkspaceDataStores = mock(() => undefined);
const refreshWorkspaceBoundStores = mock(async () => undefined);
mockLocalModule(
  "@/features/cowork/workspaceBootstrap",
  "apps/mobile/src/features/cowork/workspaceBootstrap",
  () => ({ clearWorkspaceDataStores, refreshWorkspaceBoundStores }),
);

const { setActiveCoworkJsonRpcClient } = await import(
  "../apps/mobile/src/features/cowork/runtimeClient"
);
const { useWorkspaceStore } = await import("../apps/mobile/src/features/cowork/workspaceStore");
const { useThreadStore } = await import("../apps/mobile/src/features/cowork/threadStore");
const { WorkspaceSwitcher } = await import(
  "../apps/mobile/src/components/workspace/workspace-switcher"
);

const workspaces = [
  { id: "alpha", name: "Alpha", path: "/workspace/alpha" },
  { id: "beta", name: "Beta", path: "/workspace/beta" },
  { id: "gamma", name: "Gamma", path: "/workspace/gamma" },
];
const initialize = mock(async () => undefined);
const requestThreadList = mock(async () => ({ threads: [] }));
const call = mock(async (_method: string, params: { workspaceId: string }) => {
  const workspace = workspaces.find((entry) => entry.id === params.workspaceId);
  if (!workspace) throw new Error("Unknown test workspace");
  return { workspaceId: workspace.id, name: workspace.name, path: workspace.path };
});
let transportSessionGeneration = 0;
const resetTransportSession = mock(() => {
  transportSessionGeneration += 1;
});
const client = {
  call,
  initialize,
  requestThreadList,
  resetTransportSession,
  get transportSessionGeneration() {
    return transportSessionGeneration;
  },
} as unknown as CoworkJsonRpcClient;

beforeEach(() => {
  useWorkspaceStore.getState().clear();
  useThreadStore.getState().clearAll();
  useWorkspaceStore.setState({
    workspaces,
    activeWorkspaceId: "alpha",
    activeWorkspaceName: "Alpha",
    activeWorkspaceCwd: "/workspace/alpha",
  });
  initialize.mockReset();
  initialize.mockImplementation(async () => undefined);
  requestThreadList.mockClear();
  call.mockClear();
  resetTransportSession.mockClear();
  clearWorkspaceDataStores.mockClear();
  refreshWorkspaceBoundStores.mockClear();
  transportSessionGeneration = 0;
  setActiveCoworkJsonRpcClient(client);
});

afterEach(() => setActiveCoworkJsonRpcClient(null));
afterAll(() => {
  if (originalPlatform === undefined) delete process.env.EXPO_OS;
  else process.env.EXPO_OS = originalPlatform;
  mock.restore();
});

async function withSwitcher(
  verify: (container: HTMLElement, onClose: ReturnType<typeof mock>) => Promise<void>,
) {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("Missing root container");
  const root = createRoot(container);
  const onClose = mock(() => undefined);
  try {
    await act(async () =>
      root.render(createElement(WorkspaceSwitcher, { visible: true, onClose })),
    );
    await verify(container, onClose);
  } finally {
    await act(async () => root.unmount());
    harness.restore();
  }
}

function workspaceButton(container: HTMLElement, name: "Beta" | "Gamma") {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label^="${name},"]`);
  if (!button) throw new Error(`Missing workspace button: ${name}`);
  return button;
}

function waitForWorkspaceState(
  predicate: (state: ReturnType<typeof useWorkspaceStore.getState>) => boolean,
): Promise<void> {
  if (predicate(useWorkspaceStore.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve();
    });
  });
}

describe.each(["ios", "android"] as const)("workspace switcher transactions on %s", (platform) => {
  test("keeps the sheet open with a visible error when switching fails", async () => {
    process.env.EXPO_OS = platform;
    call.mockRejectedValueOnce(new Error("The Mac rejected the workspace switch."));
    await withSwitcher(async (container, onClose) => {
      const failed = waitForWorkspaceState(
        (state) =>
          state.error === "The Mac rejected the workspace switch." &&
          state.switchingWorkspaceId === null,
      );
      await act(async () => {
        workspaceButton(container, "Beta").click();
        await failed;
      });

      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "The Mac rejected the workspace switch.",
      );
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("alpha");
      expect(initialize).not.toHaveBeenCalled();
    });
  });

  test("retries bootstrap for the selected workspace without switching it again", async () => {
    process.env.EXPO_OS = platform;
    initialize.mockRejectedValueOnce(new Error("Workspace session initialization failed."));
    await withSwitcher(async (container, onClose) => {
      const failed = waitForWorkspaceState(
        (state) => state.switchIncomplete && state.switchingWorkspaceId === null,
      );
      await act(async () => {
        workspaceButton(container, "Beta").click();
        await failed;
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("beta");
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Workspace session initialization failed.",
      );
      expect(container.textContent).toContain("Select this workspace again to retry.");

      await act(async () => {
        workspaceButton(container, "Beta").click();
        await waitForWorkspaceState(
          (state) => !state.switchIncomplete && state.switchingWorkspaceId === null,
        );
      });

      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith("workspace/switch", { workspaceId: "beta" });
      expect(initialize).toHaveBeenCalledTimes(2);
      expect(requestThreadList).toHaveBeenCalledTimes(1);
      expect(refreshWorkspaceBoundStores).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  test("keeps the whole bootstrap busy and does not interleave rapid selections", async () => {
    process.env.EXPO_OS = platform;
    const bootstrapping = Promise.withResolvers<void>();
    const finishBootstrap = Promise.withResolvers<void>();
    initialize.mockImplementationOnce(async () => {
      bootstrapping.resolve();
      await finishBootstrap.promise;
    });
    await withSwitcher(async (container, onClose) => {
      const beta = workspaceButton(container, "Beta");
      const gamma = workspaceButton(container, "Gamma");
      try {
        await act(async () => {
          beta.click();
          gamma.click();
          await bootstrapping.promise;
        });

        expect(call).toHaveBeenCalledTimes(1);
        expect(call).toHaveBeenCalledWith("workspace/switch", { workspaceId: "beta" });
        expect(initialize).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain("Switching workspace");
        expect(container.querySelector('button[role="radio"]')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          finishBootstrap.resolve();
          await waitForWorkspaceState((state) => state.switchingWorkspaceId === null);
        });
      }

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("beta");
      expect(refreshWorkspaceBoundStores).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
