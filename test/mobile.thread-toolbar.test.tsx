import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "../apps/desktop/test/jsdomHarness";

if (typeof globalThis.requestAnimationFrame === "undefined") {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0);
}
if (typeof globalThis.cancelAnimationFrame === "undefined") {
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

const actualWorkspaceStore = require("../apps/mobile/src/features/cowork/workspaceStore");
const actualThreadStore = require("../apps/mobile/src/features/cowork/threadStore");
const actualRuntimeClient = require("../apps/mobile/src/features/cowork/runtimeClient");
const actualPairingStore = require("../apps/mobile/src/features/pairing/pairingStore");
const actualFeedDisplay = require("../apps/mobile/src/features/cowork/feedDisplay");
const actualDisplayPreferencesStore = require("../apps/mobile/src/features/preferences/displayPreferencesStore");
const actualActivityGroups = require("../apps/mobile/src/features/cowork/activityGroups");

const realUseWorkspaceStore = actualWorkspaceStore.useWorkspaceStore;
const realUseThreadStore = actualThreadStore.useThreadStore;
const realGetActiveCoworkJsonRpcClient = actualRuntimeClient.getActiveCoworkJsonRpcClient;
const realUsePairingStore = actualPairingStore.usePairingStore;
const realFilterFeedForDisplay = actualFeedDisplay.filterFeedForDisplay;
const realUseDisplayPreferencesStore = actualDisplayPreferencesStore.useDisplayPreferencesStore;

function mockLocalModule(alias: string, relativePath: string, factory: () => any) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(resolved + ".ts", factory);
  mock.module(resolved + ".tsx", factory);
}

// Capture rendered Stack.Toolbar.Button affordances so tests can assert which
// overflow/stop controls actually render for a given thread state.
const capturedToolbarButtons: Array<{ icon: string; accessibilityLabel: string }> = [];
const toolbarButton = (props: { icon?: string; accessibilityLabel?: string }) => {
  capturedToolbarButtons.push({
    icon: props.icon ?? "",
    accessibilityLabel: props.accessibilityLabel ?? "",
  });
  return null;
};

const expoRouterMock = () => ({
  useLocalSearchParams: () => ({ id: "test-thread-123" }),
  Stack: {
    Screen: () => null,
    Toolbar: Object.assign(
      ({ children }: { children?: any }) => createElement("div", null, children),
      { Button: toolbarButton },
    ),
  },
});
mock.module("expo-router", expoRouterMock);
mock.module(path.resolve("apps/mobile/node_modules/expo-router"), expoRouterMock);

mockLocalModule(
  "react-native-safe-area-context",
  "apps/mobile/node_modules/react-native-safe-area-context",
  () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }),
);

mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    border: "#111",
    borderMuted: "#222",
    primary: "#333",
    primaryText: "#fff",
    surface: "#444",
    surfaceMuted: "#555",
    surfaceElevated: "#556",
    text: "#666",
    textSecondary: "#777",
    danger: "#800",
    dangerMuted: "#fcc",
    shadow: "none",
    background: "#000",
  }),
}));

let mockConnectionState = { status: "connected", transportMode: "native" };
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (fn: any) => fn({ connectionState: mockConnectionState }),
  }),
);

const mockHydrate = mock((snapshot: any) => {});
let mockPendingRequest: any = null;
const mockThread = {
  id: "test-thread-123",
  title: "Test Thread",
  feed: [],
  composerDraft: "",
};
const threadStoreMock = () => ({
  useThreadStore: Object.assign(
    (fn: any) => {
      const state = {
        getThread: () => mockThread,
        getPendingRequest: () => mockPendingRequest,
        getActiveTurnStartedAt: () => null,
        setComposerDraft: () => {},
        submitComposer: () => {},
        interruptThread: () => {},
        clearPendingRequest: () => {},
        appendOptimisticUserMessage: () => {},
      };
      return fn(state);
    },
    {
      getState: () => ({ hydrate: mockHydrate }),
    },
  ),
});
mockLocalModule(
  "@/features/cowork/threadStore",
  "apps/mobile/src/features/cowork/threadStore",
  threadStoreMock,
);

mockLocalModule(
  "@/features/cowork/workspaceStore",
  "apps/mobile/src/features/cowork/workspaceStore",
  () => ({
    useWorkspaceStore: (fn: any) => fn({ controlSnapshot: null }),
  }),
);

const mockResumeThread = mock(async (threadId: string) => ({ thread: { id: threadId } }));
const mockReadThread = mock(async (threadId: string) => ({
  coworkSnapshot: { sessionId: threadId, feed: [] },
}));
mockLocalModule(
  "@/features/cowork/runtimeClient",
  "apps/mobile/src/features/cowork/runtimeClient",
  () => ({
    getActiveCoworkJsonRpcClient: () => ({
      resumeThread: mockResumeThread,
      readThread: mockReadThread,
      startTurn: async () => {},
      interruptTurn: async () => {},
      respondServerRequest: async () => {},
    }),
  }),
);

mockLocalModule("@/components/ComposerBar", "apps/mobile/src/components/ComposerBar", () => ({
  ComposerBar: () => null,
}));
mockLocalModule(
  "@/components/thread/thread-render-item",
  "apps/mobile/src/components/thread/thread-render-item",
  () => ({ ThreadRenderItem: () => null }),
);
mockLocalModule(
  "@/components/thread/pending-request-card",
  "apps/mobile/src/components/thread/pending-request-card",
  () => ({ PendingRequestCard: () => null }),
);
mockLocalModule("@/components/ui/screen", "apps/mobile/src/components/ui/screen", () => ({
  Screen: ({ children }: any) => createElement("div", null, children),
}));
mockLocalModule("@/components/ui/status-pill", "apps/mobile/src/components/ui/status-pill", () => ({
  StatusPill: () => null,
}));
mockLocalModule(
  "@/features/cowork/activityGroups",
  "apps/mobile/src/features/cowork/activityGroups",
  () => ({ ...actualActivityGroups, buildChatRenderItems: () => [] }),
);
mockLocalModule(
  "@/features/cowork/feedDisplay",
  "apps/mobile/src/features/cowork/feedDisplay",
  () => ({ filterFeedForDisplay: () => [] }),
);
mockLocalModule(
  "@/features/preferences/displayPreferencesStore",
  "apps/mobile/src/features/preferences/displayPreferencesStore",
  () => ({ useDisplayPreferencesStore: () => false }),
);

const ThreadDetailScreen = (await import("../apps/mobile/src/app/(app)/thread/[id]")).default;

async function renderScreen() {
  const harness = setupJsdom();
  let root: ReturnType<typeof createRoot> | null = null;
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root container");
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ThreadDetailScreen));
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    unmount: async () => {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    },
  };
}

describe("mobile thread toolbar affordances", () => {
  beforeEach(() => {
    mockConnectionState = { status: "connected", transportMode: "native" };
    mockThread.feed = [];
    mockThread.composerDraft = "";
    mockPendingRequest = null;
    capturedToolbarButtons.length = 0;
    mockResumeThread.mockClear();
    mockReadThread.mockClear();
    mockHydrate.mockClear();
  });

  afterAll(() => {
    mock.module("@/features/pairing/pairingStore", () => ({
      usePairingStore: realUsePairingStore,
    }));
    mock.module(path.resolve("apps/mobile/src/features/pairing/pairingStore"), () => ({
      usePairingStore: realUsePairingStore,
    }));
    mock.module(path.resolve("apps/mobile/src/features/pairing/pairingStore.ts"), () => ({
      usePairingStore: realUsePairingStore,
    }));
    mock.module("@/features/cowork/threadStore", () => ({ useThreadStore: realUseThreadStore }));
    mock.module(path.resolve("apps/mobile/src/features/cowork/threadStore"), () => ({
      useThreadStore: realUseThreadStore,
    }));
    mock.module(path.resolve("apps/mobile/src/features/cowork/threadStore.ts"), () => ({
      useThreadStore: realUseThreadStore,
    }));
    mock.module("@/features/cowork/workspaceStore", () => ({
      useWorkspaceStore: realUseWorkspaceStore,
    }));
    mock.module(path.resolve("apps/mobile/src/features/cowork/workspaceStore"), () => ({
      useWorkspaceStore: realUseWorkspaceStore,
    }));
    mock.module(path.resolve("apps/mobile/src/features/cowork/workspaceStore.ts"), () => ({
      useWorkspaceStore: realUseWorkspaceStore,
    }));
    mock.module("@/features/cowork/runtimeClient", () => ({
      getActiveCoworkJsonRpcClient: realGetActiveCoworkJsonRpcClient,
    }));
    mock.module(path.resolve("apps/mobile/src/features/cowork/runtimeClient"), () => ({
      getActiveCoworkJsonRpcClient: realGetActiveCoworkJsonRpcClient,
    }));
    mock.module(path.resolve("apps/mobile/src/features/cowork/runtimeClient.ts"), () => ({
      getActiveCoworkJsonRpcClient: realGetActiveCoworkJsonRpcClient,
    }));
    mockLocalModule(
      "@/features/cowork/feedDisplay",
      "apps/mobile/src/features/cowork/feedDisplay",
      () => ({ filterFeedForDisplay: realFilterFeedForDisplay }),
    );
    mockLocalModule(
      "@/features/cowork/activityGroups",
      "apps/mobile/src/features/cowork/activityGroups",
      () => actualActivityGroups,
    );
    mockLocalModule(
      "@/features/preferences/displayPreferencesStore",
      "apps/mobile/src/features/preferences/displayPreferencesStore",
      () => ({ useDisplayPreferencesStore: realUseDisplayPreferencesStore }),
    );
  });

  test("renders no dead overflow button when there is no pending server request", async () => {
    const handle = await renderScreen();
    try {
      expect(capturedToolbarButtons).toEqual([]);
    } finally {
      await handle.unmount();
    }
  });

  test("renders the stop-turn button when a pending server request is active", async () => {
    mockPendingRequest = {
      requestId: "req-1",
      kind: "approval",
      threadId: "test-thread-123",
      itemId: "item-1",
      command: "rm -rf /",
      reason: "dangerous",
      dangerous: true,
    };
    const handle = await renderScreen();
    try {
      expect(capturedToolbarButtons).toHaveLength(1);
      expect(capturedToolbarButtons[0]?.accessibilityLabel).toBe("Stop turn");
      expect(capturedToolbarButtons[0]?.icon).toBe("xmark.circle.fill");
      expect(capturedToolbarButtons.some((b) => b.accessibilityLabel === "Thread options")).toBe(
        false,
      );
    } finally {
      await handle.unmount();
    }
  });
});
