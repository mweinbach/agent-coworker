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

const realUseWorkspaceStore = actualWorkspaceStore.useWorkspaceStore;
const realUseThreadStore = actualThreadStore.useThreadStore;
const realGetActiveCoworkJsonRpcClient = actualRuntimeClient.getActiveCoworkJsonRpcClient;
const realUsePairingStore = actualPairingStore.usePairingStore;

// Helper to register mock for alias and resolved path with extensions
function mockLocalModule(alias: string, relativePath: string, factory: () => any) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(resolved + ".ts", factory);
  mock.module(resolved + ".tsx", factory);
}

// Mock expo-router
const toolbarMock = Object.assign(
  ({ children }: { children?: any }) => createElement("div", null, children),
  {
    Button: () => null,
  },
);
const expoRouterMock = () => ({
  useLocalSearchParams: () => ({ id: "test-thread-123" }),
  Stack: {
    Screen: () => null,
    Toolbar: toolbarMock,
  },
});
mock.module("expo-router", expoRouterMock);
mock.module(path.resolve("apps/mobile/node_modules/expo-router"), expoRouterMock);

// Mock safe area insets
mockLocalModule(
  "react-native-safe-area-context",
  "apps/mobile/node_modules/react-native-safe-area-context",
  () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }),
);

// Mock theme
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    border: "#111",
    borderMuted: "#222",
    primary: "#333",
    primaryText: "#fff",
    surface: "#444",
    surfaceMuted: "#555",
    text: "#666",
    textSecondary: "#777",
    danger: "#800",
    dangerMuted: "#fcc",
    shadow: "none",
  }),
}));

// Mock pairingStore
let mockConnectionState = {
  status: "connected",
  transportMode: "native",
};
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (fn: any) => fn({ connectionState: mockConnectionState }),
  }),
);

// Mock threadStore hydrate method and State
const mockHydrate = mock((snapshot: any) => {});
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
        getPendingRequest: () => null,
        getActiveTurnStartedAt: () => null,
        setComposerDraft: () => {},
        submitComposer: () => {},
        interruptThread: () => {},
        clearPendingRequest: () => {},
      };
      return fn(state);
    },
    {
      getState: () => ({
        hydrate: mockHydrate,
      }),
    },
  ),
});
mockLocalModule(
  "@/features/cowork/threadStore",
  "apps/mobile/src/features/cowork/threadStore",
  threadStoreMock,
);

// Mock workspaceStore
mockLocalModule(
  "@/features/cowork/workspaceStore",
  "apps/mobile/src/features/cowork/workspaceStore",
  () => ({
    useWorkspaceStore: (fn: any) => fn({ controlSnapshot: null }),
  }),
);

// Mock runtimeClient with readThread mock
const mockResumeThread = mock(async (threadId: string) => ({
  thread: { id: threadId },
}));
const mockReadThread = mock(async (threadId: string) => ({
  coworkSnapshot: { sessionId: "test-thread-123", feed: [{ id: "msg-1" }] },
}));
mockLocalModule(
  "@/features/cowork/runtimeClient",
  "apps/mobile/src/features/cowork/runtimeClient",
  () => ({
    getActiveCoworkJsonRpcClient: () => ({
      resumeThread: mockResumeThread,
      readThread: mockReadThread,
    }),
  }),
);

// Mock components
let latestComposerProps: any = null;
mockLocalModule("@/components/ComposerBar", "apps/mobile/src/components/ComposerBar", () => ({
  ComposerBar: (props: any) => {
    latestComposerProps = props;
    return null;
  },
}));
mockLocalModule(
  "@/components/thread/thread-render-item",
  "apps/mobile/src/components/thread/thread-render-item",
  () => ({
    ThreadRenderItem: () => null,
  }),
);
mockLocalModule(
  "@/components/thread/pending-request-card",
  "apps/mobile/src/components/thread/pending-request-card",
  () => ({ PendingRequestCard: () => null }),
);
mockLocalModule(
  "@/components/thread/a2ui-surface-card",
  "apps/mobile/src/components/thread/a2ui-surface-card",
  () => ({ A2uiSurfaceCard: () => null }),
);
mockLocalModule(
  "@/components/thread/markdown-text",
  "apps/mobile/src/components/thread/markdown-text",
  () => ({ MarkdownText: () => null }),
);
mockLocalModule(
  "@/components/thread/tool-call-card",
  "apps/mobile/src/components/thread/tool-call-card",
  () => ({ ToolCallCard: () => null }),
);
mockLocalModule(
  "@/components/thread/reasoning-card",
  "apps/mobile/src/components/thread/reasoning-card",
  () => ({ ReasoningCard: () => null }),
);
mockLocalModule(
  "@/components/thread/todo-card",
  "apps/mobile/src/components/thread/todo-card",
  () => ({
    TodoCard: () => null,
  }),
);
mockLocalModule("@/components/ui/screen", "apps/mobile/src/components/ui/screen", () => ({
  Screen: () => null,
}));
mockLocalModule(
  "@/components/ui/header-glass-button",
  "apps/mobile/src/components/ui/header-glass-button",
  () => ({
    HeaderGlassButton: () => null,
  }),
);
mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: () => null,
}));
mockLocalModule("@/components/ui/status-pill", "apps/mobile/src/components/ui/status-pill", () => ({
  StatusPill: () => null,
}));

// Import component under test
const ThreadDetailScreen = (await import("../apps/mobile/src/app/(app)/thread/[id]")).default;

describe("mobile ThreadDetailScreen", () => {
  beforeEach(() => {
    mockConnectionState = {
      status: "connected",
      transportMode: "native",
    };
    mockThread.feed = [];
    mockThread.composerDraft = "";
    latestComposerProps = null;
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
  });

  test("resumes, reads, and hydrates the store on navigation when connected", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);

      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });

      // Allow async function inside useEffect to run
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockResumeThread).toHaveBeenCalledWith("test-thread-123");
      expect(mockReadThread).toHaveBeenCalledWith("test-thread-123");
      expect(mockHydrate).toHaveBeenCalled();
      expect(mockHydrate.mock.calls[0]?.[0]).toEqual({
        sessionId: "test-thread-123",
        feed: [{ id: "msg-1" }],
      });
      expect(latestComposerProps?.disabled).toBe(true);
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });

  test("uses cached thread data as read-only while disconnected", async () => {
    mockConnectionState = {
      status: "error",
      transportMode: "native",
    };
    mockThread.feed = [
      {
        id: "cached-msg-1",
        kind: "message",
        role: "assistant",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Cached answer",
      },
    ];
    mockThread.composerDraft = "should not send";
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);

      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockResumeThread).not.toHaveBeenCalled();
      expect(mockReadThread).not.toHaveBeenCalled();
      expect(mockHydrate).not.toHaveBeenCalled();
      expect(latestComposerProps?.disabled).toBe(true);
      expect(latestComposerProps?.helperText).toContain("Showing cached messages");
      await latestComposerProps?.onSubmit();
      expect(mockResumeThread).not.toHaveBeenCalled();
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });
});
