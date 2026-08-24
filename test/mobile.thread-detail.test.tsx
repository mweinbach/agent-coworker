import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { act, createElement, forwardRef } from "react";
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
const actualProviderStore = require("../apps/mobile/src/features/cowork/providerStore");
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

const actualReactNative = require("react-native");
const testFlatList = forwardRef(function TestFlatList(props: any, _ref) {
  const Header = props.ListHeaderComponent;
  const Empty = props.ListEmptyComponent;
  const items = Array.isArray(props.data) ? props.data : [];
  return createElement(
    "div",
    { "data-testid": "flat-list" },
    Header ? createElement(Header) : null,
    items.length === 0 && Empty ? createElement(Empty) : null,
    ...items.map((item: any, index: number) => props.renderItem({ item, index, separators: {} })),
  );
});
mockLocalModule("react-native", "apps/mobile/node_modules/react-native", () => ({
  ...actualReactNative,
  FlatList: testFlatList,
  KeyboardAvoidingView: ({ behavior: _behavior, children, ...props }: any) =>
    createElement("div", props, children),
  Text: ({ children, selectable: _selectable, ...props }: any) =>
    createElement("span", props, children),
  View: ({ children, pointerEvents: _pointerEvents, testID, ...props }: any) =>
    createElement("div", { ...props, "data-testid": testID }, children),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole: _accessibilityRole,
    children,
    onPress,
    style,
    ...props
  }: any) =>
    createElement(
      "button",
      {
        ...props,
        "aria-label": accessibilityLabel,
        onClick: onPress,
        style: typeof style === "function" ? style({ pressed: false }) : style,
      },
      children,
    ),
}));

// Mock expo-router
const toolbarMock = Object.assign(
  ({ children }: { children?: any }) => createElement("div", null, children),
  {
    Button: () => null,
  },
);
let mockRouteThreadId = "test-thread-123";
const mockRouterReplace = mock((_href: string) => {});
const expoRouterMock = () => ({
  useLocalSearchParams: () => ({ id: mockRouteThreadId }),
  useRouter: () => ({ back: () => {}, replace: mockRouterReplace }),
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

mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => 48,
    useAccessibilityAnnouncement: () => undefined,
    useReducedMotionEnabled: () => false,
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
const mockSetComposerDraft = mock((_threadId: string, _text: string) => {});
const mockSubmitComposer = mock((_threadId: string) => {});
const mockAppendOptimisticUserMessage = mock(
  (_threadId: string, _text: string, _clientMessageId: string) => {},
);
const mockRemoveOptimisticUserMessage = mock((_threadId: string, _clientMessageId: string) => {});
const mockFailComposerSubmission = mock(
  (_threadId: string, _clientMessageId: string, _error: string) => {},
);
const mockCancelComposerSubmission = mock((_threadId: string, _clientMessageId: string) => true);
const mockAcceptComposerSubmission = mock((_threadId: string, _clientMessageId: string) => {});
const mockClearPendingRequest = mock((_threadId: string, _requestFingerprint?: string) => {});
const mockPromoteDraftThread = mock((_draftThreadId: string, remoteThread: { id: string }) => {
  mockThread.id = remoteThread.id;
});
const mockMarkTurnStarted = mock((_threadId: string, _startedAt: string) => {});
const mockMarkTurnCompleted = mock((_threadId: string) => {});
let mockActiveTurnStartedAt: string | null = null;
let mockPendingRequest: any = null;
let mockSnapshots: Record<string, { lastEventSeq: number; provider?: string; model?: string }> = {};
const mockThread = {
  id: "test-thread-123",
  title: "Test Thread",
  feed: [],
  composerDraft: "",
  composerAttachments: [],
  composerSubmission: null as any,
};
const mockBeginComposerSubmission = mock((_threadId: string, clientMessageId: string) => ({
  clientMessageId,
  text: mockThread.composerDraft,
  attachments: [...mockThread.composerAttachments],
  status: "submitting" as const,
  error: null,
}));
const mockRetryComposerSubmission = mock((_threadId: string) => mockThread.composerSubmission);
const threadStoreMock = () => ({
  useThreadStore: Object.assign(
    (fn: any) => {
      const state = {
        snapshots: mockSnapshots,
        getThread: () => mockThread,
        getPendingRequest: () => mockPendingRequest,
        getActiveTurnStartedAt: () => mockActiveTurnStartedAt,
        markTurnStarted: mockMarkTurnStarted,
        markTurnCompleted: mockMarkTurnCompleted,
        setComposerDraft: mockSetComposerDraft,
        submitComposer: mockSubmitComposer,
        promoteDraftThread: mockPromoteDraftThread,
        beginComposerSubmission: mockBeginComposerSubmission,
        retryComposerSubmission: mockRetryComposerSubmission,
        failComposerSubmission: mockFailComposerSubmission,
        cancelComposerSubmission: mockCancelComposerSubmission,
        acceptComposerSubmission: mockAcceptComposerSubmission,
        appendOptimisticUserMessage: mockAppendOptimisticUserMessage,
        removeOptimisticUserMessage: mockRemoveOptimisticUserMessage,
        interruptThread: () => {},
        clearPendingRequest: mockClearPendingRequest,
      };
      return fn(state);
    },
    {
      getState: () => ({
        snapshots: mockSnapshots,
        hydrate: mockHydrate,
        getPendingRequest: () => mockPendingRequest,
        getActiveTurnStartedAt: () => mockActiveTurnStartedAt,
        markTurnStarted: mockMarkTurnStarted,
        markTurnCompleted: mockMarkTurnCompleted,
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
    useWorkspaceStore: (fn: any) => fn({ activeWorkspaceCwd: "/workspace", controlSnapshot: null }),
  }),
);

// Mock runtimeClient with readThread mock
const mockResumeThread = mock(async (threadId: string) => ({
  thread: { id: threadId },
}));
const mockReadThread = mock(async (threadId: string) => ({
  thread: { id: threadId, turns: [] },
  coworkSnapshot: { sessionId: "test-thread-123", feed: [{ id: "msg-1" }] },
}));
const mockStartTurn = mock(
  async (_threadId: string, _input: unknown, _clientMessageId: string) => {},
);
const mockStartThread = mock(async (_options: { cwd?: string; clientThreadId: string }) => ({
  thread: {
    id: "remote-promoted",
    title: "Remote conversation",
    preview: "",
    modelProvider: "opencode",
    model: "gpt-5",
    cwd: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    status: { type: "idle" },
  },
}));
const mockInterruptTurn = mock(async (_threadId: string) => {});
const mockRespondServerRequest = mock(async (_requestId: string | number, _result: unknown) => {});
const mockRuntimeClient = {
  resumeThread: mockResumeThread,
  readThread: mockReadThread,
  startThread: mockStartThread,
  startTurn: mockStartTurn,
  interruptTurn: mockInterruptTurn,
  respondServerRequest: mockRespondServerRequest,
};
mockLocalModule(
  "@/features/cowork/runtimeClient",
  "apps/mobile/src/features/cowork/runtimeClient",
  () => ({
    getActiveCoworkJsonRpcClient: () => mockRuntimeClient,
  }),
);

// Mock components
let latestComposerProps: any = null;
let latestPendingRequestProps: any = null;
mockLocalModule("@/components/ComposerBar", "apps/mobile/src/components/ComposerBar", () => ({
  ComposerBar: (props: any) => {
    latestComposerProps = props;
    return createElement("div", { "data-testid": "composer-bar" });
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
  () => ({
    PendingRequestCard: (props: any) => {
      latestPendingRequestProps = props;
      return null;
    },
  }),
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
const ThreadDetailScreen = (await import("../apps/mobile/src/app/(app)/(tabs)/(chats)/thread/[id]"))
  .default;

describe("mobile ThreadDetailScreen", () => {
  beforeEach(() => {
    mockRouteThreadId = "test-thread-123";
    mockConnectionState = {
      status: "connected",
      transportMode: "native",
    };
    mockThread.id = "test-thread-123";
    mockThread.feed = [];
    mockThread.composerDraft = "";
    mockThread.composerAttachments = [];
    mockThread.composerSubmission = null;
    mockActiveTurnStartedAt = null;
    mockPendingRequest = null;
    mockSnapshots = {};
    actualProviderStore.useProviderStore.setState({ catalog: [], statusByProvider: {} });
    latestComposerProps = null;
    latestPendingRequestProps = null;
    mockResumeThread.mockClear();
    mockReadThread.mockClear();
    mockReadThread.mockImplementation(async (threadId: string) => ({
      thread: { id: threadId, turns: [] },
      coworkSnapshot: { sessionId: "test-thread-123", feed: [{ id: "msg-1" }] },
    }));
    mockStartTurn.mockClear();
    mockStartTurn.mockImplementation(async () => {});
    mockStartThread.mockClear();
    mockPromoteDraftThread.mockClear();
    mockRouterReplace.mockClear();
    mockHydrate.mockClear();
    mockSetComposerDraft.mockClear();
    mockSubmitComposer.mockClear();
    mockBeginComposerSubmission.mockClear();
    mockRetryComposerSubmission.mockClear();
    mockFailComposerSubmission.mockClear();
    mockCancelComposerSubmission.mockClear();
    mockAcceptComposerSubmission.mockClear();
    mockMarkTurnStarted.mockClear();
    mockMarkTurnCompleted.mockClear();
    mockClearPendingRequest.mockClear();
    mockAppendOptimisticUserMessage.mockClear();
    mockRemoveOptimisticUserMessage.mockClear();
    mockInterruptTurn.mockClear();
    mockRespondServerRequest.mockClear();
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
    mockSnapshots = { "test-thread-123": { lastEventSeq: 23 } };
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

      expect(mockResumeThread).toHaveBeenCalledWith("test-thread-123", { afterSeq: 23 });
      expect(mockResumeThread).toHaveBeenCalledTimes(1);
      expect(mockReadThread).toHaveBeenCalledWith("test-thread-123", { includeTurns: true });
      expect(mockReadThread).toHaveBeenCalledTimes(1);
      expect(mockHydrate).toHaveBeenCalled();
      expect(mockHydrate.mock.calls[0]?.[0]).toEqual({
        sessionId: "test-thread-123",
        feed: [{ id: "msg-1" }],
      });
      expect(latestComposerProps?.canEdit).toBe(true);
      expect(latestComposerProps?.canSubmit).toBe(false);
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

  test("recovers an active turn from thread/read after reconnect", async () => {
    mockReadThread.mockImplementation(async (threadId: string) => ({
      thread: {
        id: threadId,
        turns: [{ id: "turn-live", status: "inProgress", items: [] }],
      },
      coworkSnapshot: { sessionId: threadId, feed: [] },
    }));
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockMarkTurnStarted).toHaveBeenCalledWith("test-thread-123", expect.any(String));
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("creates and sends a connected mobile draft as one real idempotent conversation", async () => {
    mockRouteThreadId = "draft-mobile-1";
    mockThread.id = "draft-mobile-1";
    mockThread.composerDraft = "Send this to the desktop agent";
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });

      expect(latestComposerProps?.submitLabel).toBe("Send");
      await act(async () => {
        await latestComposerProps?.onSubmit();
      });

      expect(mockStartThread).toHaveBeenCalledWith({
        cwd: "/workspace",
        clientThreadId: "draft-mobile-1",
      });
      expect(mockPromoteDraftThread).toHaveBeenCalledWith(
        "draft-mobile-1",
        expect.objectContaining({ id: "remote-promoted" }),
      );
      expect(mockStartTurn).toHaveBeenCalledTimes(1);
      expect(mockStartTurn.mock.calls[0]).toEqual([
        "remote-promoted",
        [{ type: "text", text: "Send this to the desktop agent" }],
        expect.any(String),
      ]);
      expect(mockAcceptComposerSubmission).toHaveBeenCalledWith(
        "remote-promoted",
        mockStartTurn.mock.calls[0]?.[2],
      );
      expect(mockRouterReplace).toHaveBeenCalledWith("/thread/remote-promoted");
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test.each([
    { platform: "android", authorized: false, catalogState: "ready", canSubmit: false },
    { platform: "ios", authorized: false, catalogState: "ready", canSubmit: false },
    { platform: "android", authorized: true, catalogState: "unreachable", canSubmit: true },
    { platform: "ios", authorized: true, catalogState: "unreachable", canSubmit: true },
  ] as const)(
    "$platform respects explicit provider authorization without trusting stale discovery",
    async ({ authorized, catalogState, canSubmit }) => {
      mockThread.composerDraft = "Keep this message ready to send";
      mockSnapshots = {
        "test-thread-123": { lastEventSeq: 4, provider: "openai", model: "gpt-5" },
      };
      actualProviderStore.useProviderStore.setState({
        catalog: [
          {
            id: "openai",
            name: "OpenAI",
            defaultModel: "gpt-5",
            state: catalogState,
            models: [
              {
                id: "gpt-5",
                displayName: "GPT 5",
                knowledgeCutoff: "2025-01",
                supportsImageInput: false,
              },
            ],
          },
        ],
        statusByProvider: {
          openai: {
            provider: "openai",
            authorized,
            verified: authorized,
            mode: authorized ? "api_key" : "missing",
            account: null,
            message: authorized
              ? "Provider credentials are valid."
              : "Add an OpenAI API key in Settings > Providers.",
            checkedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);
        await act(async () => {
          root!.render(createElement(ThreadDetailScreen));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(latestComposerProps?.canEdit).toBe(true);
        expect(latestComposerProps?.canSubmit).toBe(canSubmit);
        if (!authorized) {
          expect(latestComposerProps?.helperText).toContain(
            "Add an OpenAI API key in Settings > Providers.",
          );
          await latestComposerProps?.onSubmit();
          expect(mockStartTurn).not.toHaveBeenCalled();
          expect(mockBeginComposerSubmission).not.toHaveBeenCalled();
        }
      } finally {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test("rolls back a rejected optimistic send without clearing its exact draft", async () => {
    mockThread.composerDraft = "  Retry this message\n";
    mockStartTurn.mockImplementation(async () => {
      throw new Error("send rejected");
    });
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        latestComposerProps?.onSubmit();
        await Promise.resolve();
        await Promise.resolve();
      });

      const optimisticCall = mockAppendOptimisticUserMessage.mock.calls[0];
      expect(optimisticCall?.slice(0, 2)).toEqual(["test-thread-123", "  Retry this message\n"]);
      expect(mockRemoveOptimisticUserMessage).toHaveBeenCalledWith(
        "test-thread-123",
        optimisticCall?.[2],
      );
      expect(mockFailComposerSubmission).toHaveBeenCalledWith(
        "test-thread-123",
        optimisticCall?.[2],
        "send rejected",
      );
      expect(mockSetComposerDraft).not.toHaveBeenCalled();
      const recovery = container.querySelector(
        '[data-testid="composer-recovery"], [testid="composer-recovery"]',
      );
      const composer = container.querySelector('[data-testid="composer-bar"]');
      expect(recovery).not.toBeNull();
      expect(recovery?.parentElement).toBe(composer?.parentElement);
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("retries a failed draft promotion with the original thread and message identities", async () => {
    mockRouteThreadId = "draft-retry-1";
    mockThread.id = "draft-retry-1";
    mockThread.composerDraft = "Retry exactly once";
    mockStartThread.mockImplementationOnce(async () => {
      throw new Error("Desktop connection interrupted");
    });
    mockBeginComposerSubmission.mockImplementationOnce((_threadId, clientMessageId) => {
      const submission = {
        clientMessageId,
        text: mockThread.composerDraft,
        attachments: [],
        status: "submitting" as const,
        error: null,
      };
      mockThread.composerSubmission = submission;
      return submission;
    });
    mockFailComposerSubmission.mockImplementationOnce((_threadId, _clientMessageId, error) => {
      mockThread.composerSubmission = {
        ...mockThread.composerSubmission,
        status: "failed",
        error,
      };
    });
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });

      await act(async () => {
        await latestComposerProps?.onSubmit();
      });
      const originalClientMessageId = mockBeginComposerSubmission.mock.calls[0]?.[1];
      const retryButton = container.querySelector('[aria-label="Retry send"]');
      if (!(retryButton instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing failed draft retry button");
      }

      await act(async () => {
        retryButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockStartThread).toHaveBeenCalledTimes(2);
      expect(mockStartThread.mock.calls).toEqual([
        [{ cwd: "/workspace", clientThreadId: "draft-retry-1" }],
        [{ cwd: "/workspace", clientThreadId: "draft-retry-1" }],
      ]);
      expect(mockStartTurn).toHaveBeenCalledWith(
        "remote-promoted",
        [{ type: "text", text: "Retry exactly once" }],
        originalClientMessageId,
      );
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("surfaces a restart-recovered failed submission with an actionable retry", async () => {
    mockThread.composerDraft = "Recover this message";
    mockThread.composerSubmission = {
      clientMessageId: "recovered-message-1",
      text: "Recover this message",
      attachments: [],
      status: "failed",
      error: "Sending was interrupted. Retry to continue.",
    };
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });

      const recovery = container.querySelector('[data-testid="composer-recovery"]');
      expect(recovery?.textContent).toContain("Sending was interrupted. Retry to continue.");
      expect(container.querySelector('[aria-label="Retry send"]')).not.toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("ignores a thread read that completes after the screen unmounts", async () => {
    let resolveRead:
      | ((value: { coworkSnapshot: { sessionId: string; feed: Array<{ id: string }> } }) => void)
      | undefined;
    mockReadThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockReadThread).toHaveBeenCalledWith("test-thread-123", { includeTurns: true });

      await act(async () => {
        root!.unmount();
      });
      root = null;
      resolveRead?.({
        coworkSnapshot: {
          sessionId: "test-thread-123",
          feed: [{ id: "stale-message" }],
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockHydrate).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("keeps cached conversations editable without implying offline delivery", async () => {
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
      expect(latestComposerProps?.canEdit).toBe(true);
      expect(latestComposerProps?.canSubmit).toBe(false);
      expect(latestComposerProps?.helperText).toContain("Showing cached messages");
      expect(latestComposerProps?.helperText).toContain("saved");
      expect(latestComposerProps?.helperText).toContain("reconnect");
      latestComposerProps?.onChangeText("  Preserve this offline draft\n");
      expect(mockSetComposerDraft).toHaveBeenCalledWith(
        "test-thread-123",
        "  Preserve this offline draft\n",
      );
      await latestComposerProps?.onSubmit();
      expect(mockResumeThread).not.toHaveBeenCalled();
      expect(mockBeginComposerSubmission).not.toHaveBeenCalled();
      expect(mockStartTurn).not.toHaveBeenCalled();
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

  test.each(["android", "ios"] as const)(
    "%s never clears or fake-sends an offline local conversation draft",
    async (_platform) => {
      mockRouteThreadId = "draft-offline-1";
      mockConnectionState = {
        status: "reconnecting",
        transportMode: "native",
      };
      mockThread.id = "draft-offline-1";
      mockThread.composerDraft = "  Keep my unsent message\n";
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);

        await act(async () => {
          root!.render(createElement(ThreadDetailScreen));
        });

        expect(latestComposerProps?.canEdit).toBe(true);
        expect(latestComposerProps?.canSubmit).toBe(false);
        expect(latestComposerProps?.value).toBe("  Keep my unsent message\n");
        expect(latestComposerProps?.helperText).toContain("saved");
        expect(latestComposerProps?.helperText).toContain("connect");
        await latestComposerProps?.onSubmit();

        expect(mockSubmitComposer).not.toHaveBeenCalled();
        expect(mockBeginComposerSubmission).not.toHaveBeenCalled();
        expect(mockStartThread).not.toHaveBeenCalled();
        expect(mockStartTurn).not.toHaveBeenCalled();
        expect(mockThread.composerDraft).toBe("  Keep my unsent message\n");
      } finally {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test("never redirects a failed response retry to a newer server request", async () => {
    mockPendingRequest = {
      kind: "ask",
      method: "item/tool/requestUserInput",
      threadId: "test-thread-123",
      itemId: "ask-item-1",
      requestId: "ask-rpc-1",
      requestFingerprint: "ask-request-1",
      question: "Choose one",
      options: ["a", "b"],
    };
    mockRespondServerRequest.mockImplementationOnce(async () => {
      throw new Error("response failed");
    });
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        latestPendingRequestProps?.onAnswerOption("a");
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRespondServerRequest).toHaveBeenCalledWith("ask-rpc-1", { answer: "a" });

      mockPendingRequest = {
        kind: "approval",
        method: "item/commandExecution/requestApproval",
        threadId: "test-thread-123",
        itemId: "approval-item-2",
        requestId: "approval-rpc-2",
        requestFingerprint: "approval-request-2",
        command: "rm temp.txt",
        reason: "cleanup",
        dangerous: true,
      };
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });

      const retryButton = container.querySelector(
        '[aria-label="Retry respond"], [accessibilitylabel="Retry respond"]',
      );
      if (!(retryButton instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing response retry button");
      }
      await act(async () => {
        retryButton.click();
        await Promise.resolve();
      });

      expect(mockRespondServerRequest).toHaveBeenCalledTimes(1);
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("keeps an answered interaction visible until its canonical server receipt arrives", async () => {
    mockPendingRequest = {
      kind: "ask",
      method: "item/tool/requestUserInput",
      threadId: "test-thread-123",
      itemId: "ask-item-1",
      requestId: 7,
      requestFingerprint: "ask-request-1",
      question: "Continue?",
      options: ["yes"],
    };
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
      });

      await act(async () => {
        latestPendingRequestProps?.onAnswerOption("yes");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRespondServerRequest).toHaveBeenCalledWith(7, { answer: "yes" });
      expect(mockClearPendingRequest).not.toHaveBeenCalled();
      expect(latestPendingRequestProps?.responsePending).toBe(true);
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test("sends one interrupt while Stop is already in flight", async () => {
    mockActiveTurnStartedAt = "2026-07-10T00:00:00.000Z";
    let resolveInterrupt: (() => void) | undefined;
    mockInterruptTurn.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInterrupt = resolve;
        }),
    );
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(latestComposerProps?.isBusy).toBe(true);
      await act(async () => {
        latestComposerProps?.onStop();
        latestComposerProps?.onStop();
        await Promise.resolve();
      });

      expect(mockInterruptTurn).toHaveBeenCalledTimes(1);
      expect(latestComposerProps?.isStopping).toBe(true);

      await act(async () => {
        resolveInterrupt?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(latestComposerProps?.isStopping).toBe(true);

      mockActiveTurnStartedAt = null;
      await act(async () => {
        root!.render(createElement(ThreadDetailScreen));
        await Promise.resolve();
      });
      expect(latestComposerProps?.isStopping).toBe(false);
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });
});
