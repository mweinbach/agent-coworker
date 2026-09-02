import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";
import type { CoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/jsonRpcClient";
import type { WorkspaceSummary } from "../apps/mobile/src/features/cowork/protocolTypes";
import { setActiveCoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/runtimeClient";
import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
} from "../apps/mobile/src/features/cowork/threadHomeModel";
import {
  type MobileThreadSummary,
  useThreadStore,
} from "../apps/mobile/src/features/cowork/threadStore";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

function mockLocalModule(alias: string, relativePath: string, factory: () => any) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

function normalizeStyle(style: any): any {
  return Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
}

const actualReactNative = require("react-native");
mockLocalModule("react-native", "apps/mobile/node_modules/react-native", () => ({
  ...actualReactNative,
  ActivityIndicator: () => null,
  RefreshControl: ({ refreshing, onRefresh }: any) =>
    createElement("button", {
      "aria-label": "Refresh home",
      disabled: refreshing,
      onClick: onRefresh,
    }),
  SectionList: ({
    ListEmptyComponent,
    ListHeaderComponent,
    refreshControl,
    renderItem,
    renderSectionHeader,
    sections,
  }: any) =>
    createElement(
      "div",
      { "data-testid": "thread-home-list" },
      refreshControl,
      ListHeaderComponent,
      sections.length === 0 ? ListEmptyComponent : null,
      ...sections.flatMap((section: any) => [
        renderSectionHeader({ section }),
        ...section.data.map((item: any, index: number) => renderItem({ item, index, section })),
      ]),
    ),
  Text: ({ children, selectable: _selectable, style, ...props }: any) =>
    createElement("span", { ...props, style: normalizeStyle(style) }, children),
  View: ({ children, style, ...props }: any) =>
    createElement("div", { ...props, style: normalizeStyle(style) }, children),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole: _accessibilityRole,
    accessibilityState: _accessibilityState,
    children,
    disabled,
    onPress,
    style,
    ...props
  }: any) =>
    createElement(
      "button",
      {
        ...props,
        "aria-label": accessibilityLabel,
        disabled,
        onClick: onPress,
        style: normalizeStyle(typeof style === "function" ? style({ pressed: false }) : style),
      },
      children,
    ),
}));

const mockRouterPush = mock((_href: string) => {});
const toolbarMock = Object.assign(
  ({ children }: { children?: any }) => createElement("div", null, children),
  {
    Menu: ({ children }: { children?: any }) => createElement("div", null, children),
    MenuAction: ({ children, onPress }: { children?: any; onPress?: () => void }) =>
      createElement("button", { onClick: onPress }, children),
    Button: () => null,
  },
);
const expoRouterMock = () => ({
  useRouter: () => ({ push: mockRouterPush }),
  Stack: {
    Screen: () => null,
    Toolbar: toolbarMock,
  },
});
mock.module("expo-router", expoRouterMock);
mock.module(path.resolve("apps/mobile/node_modules/expo-router"), expoRouterMock);

mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => 48,
    runAccessibleLayoutAnimation: () => {},
    useAccessibilityAnnouncement: () => undefined,
    useReducedMotionEnabled: () => false,
  }),
);
mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: () => null,
}));
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    backgroundMuted: "#111",
    borderMuted: "#222",
    danger: "#f33",
    dangerMuted: "#fbb",
    primary: "#36f",
    primaryMuted: "#cef",
    surface: "#fff",
    surfaceMuted: "#eee",
    text: "#111",
    textSecondary: "#555",
    textTertiary: "#777",
    warning: "#d80",
    warningMuted: "#ffe",
  }),
}));

const actualPairingStore = require("../apps/mobile/src/features/pairing/pairingStore");
const realUsePairingStore = actualPairingStore.usePairingStore;
let mockConnectionState: {
  status: "idle" | "pairing" | "connecting" | "reconnecting" | "connected" | "error";
  transportMode: "native";
  lastError: string | null;
} = {
  status: "connected",
  transportMode: "native",
  lastError: null,
};
let mockTrustedMacs: Array<{ macDeviceId: string; displayName: string }> = [];
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (selector: any) =>
      selector({
        connectionState: mockConnectionState,
        trustedMacs: mockTrustedMacs,
      }),
  }),
);

const actualThreadHome = require("../apps/mobile/src/features/cowork/useThreadHome");
const realUseThreadHome = actualThreadHome.useThreadHome;
let useRealThreadHome = false;
let mockThreads: MobileThreadSummary[] = [];
let mockWorkspaces: WorkspaceSummary[] = [];
const mockThreadHomeAction = () => {};
mockLocalModule(
  "@/features/cowork/useThreadHome",
  "apps/mobile/src/features/cowork/useThreadHome",
  () => ({
    useThreadHome: () =>
      useRealThreadHome
        ? realUseThreadHome()
        : {
            viewModel: buildThreadHomeViewModel({
              threads: mockThreads,
              workspaces: mockWorkspaces,
              searchQuery: "",
              ui: {
                ...defaultThreadHomeUiState(),
                expandedWorkspaceIds: { "project-1": true },
              },
            }),
            setSearchQuery: mockThreadHomeAction,
            reorderSections: mockThreadHomeAction,
            refreshHome: async () => {},
            homeLoadPending: { chats: false, projects: {} },
            loadMoreChats: async () => {},
            loadMoreProject: async () => {},
            toggleShowAllChats: mockThreadHomeAction,
            toggleProjectThreadListExpanded: mockThreadHomeAction,
            toggleWorkspaceExpanded: mockThreadHomeAction,
            expandWorkspace: mockThreadHomeAction,
          },
  }),
);

const { SharedThreadHomeScreen } = await import(
  "../apps/mobile/src/components/thread-home/thread-home-screen.shared"
);

function makeThread(partial: Partial<MobileThreadSummary> & Pick<MobileThreadSummary, "id">) {
  return {
    title: partial.id,
    preview: "Latest desktop message",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: null,
    workspaceId: null,
    workspaceName: null,
    workspaceKind: "oneOffChat",
    feed: [],
    composerDraft: "",
    composerAttachments: [],
    composerSubmission: null,
    pendingPrompt: false,
    pendingServerRequest: null,
    ...partial,
  } satisfies MobileThreadSummary;
}

describe("mobile thread-home attention and draft recovery", () => {
  beforeEach(() => {
    useRealThreadHome = false;
    mockThreads = [];
    mockWorkspaces = [];
    mockConnectionState = { status: "connected", transportMode: "native", lastError: null };
    mockTrustedMacs = [];
    mockRouterPush.mockClear();
  });

  afterAll(() => {
    mockLocalModule(
      "@/features/pairing/pairingStore",
      "apps/mobile/src/features/pairing/pairingStore",
      () => ({ usePairingStore: realUsePairingStore }),
    );
    mockLocalModule(
      "@/features/cowork/useThreadHome",
      "apps/mobile/src/features/cowork/useThreadHome",
      () => ({ useThreadHome: realUseThreadHome }),
    );
  });

  test.each(["android", "ios"] as const)(
    "%s refreshes through the real hook and preserves expansion, ordering, and pagination",
    async (platform) => {
      useRealThreadHome = true;
      useThreadStore.getState().clearAll();
      useThreadStore.setState({
        ...defaultThreadHomeUiState(),
        threads: Array.from({ length: 6 }, (_, index) =>
          makeThread({
            id: `draft-${index}`,
            title: `Saved draft ${index}`,
            composerDraft: `Unsent text ${index}`,
          }),
        ),
      });
      useWorkspaceStore.getState().clear();
      const workspaces: WorkspaceSummary[] = [
        {
          id: "project-1",
          name: "Refreshed project",
          path: "/refreshed-project",
          workspaceKind: "project",
        },
      ];
      let workspaceError: string | null = null;
      const call = mock(async (method: string) => {
        expect(method).toBe("workspace/list");
        if (workspaceError) throw new Error(workspaceError);
        return { workspaces, activeWorkspaceId: null };
      });
      const requestThreadList = mock(async (cwd: string, limit?: number, _offset?: number) => ({
        threads: Array.from({ length: Math.min(limit ?? 6, 6) }, (_, index) => ({
          id: `remote-${index}`,
          title: `Remote conversation ${index}`,
          preview: "Saved desktop history",
          modelProvider: "anthropic",
          model: "claude-sonnet-4",
          cwd,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          messageCount: 2,
          lastEventSeq: 4,
          status: { type: "idle" },
          hasPendingApproval: index === 0,
          hasPendingAsk: false,
        })),
        total: 6,
      }));
      const client = { call, requestThreadList } as unknown as CoworkJsonRpcClient;
      setActiveCoworkJsonRpcClient(client);
      const harness = setupJsdom();
      const container = harness.dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const click = async (label: string) => {
        const button = Array.from(container.querySelectorAll("button")).find(
          (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());
      };

      try {
        await act(async () => root.render(createElement(SharedThreadHomeScreen, { platform })));
        await click("Show 1 more");
        expect(useThreadStore.getState().showAllChats).toBe(true);
        expect(container.textContent).toContain("Saved draft 5");
        expect(requestThreadList).not.toHaveBeenCalled();

        await click("Refresh home");
        expect(call).toHaveBeenCalledTimes(1);
        expect(requestThreadList).toHaveBeenCalledWith("/refreshed-project", 5, undefined);
        expect(container.textContent).not.toContain("Remote conversation 0");
        await click("Expand project Refreshed project");
        expect(
          container.querySelector('[aria-label="Open chat Remote conversation 0, needs response"]'),
        ).not.toBeNull();
        expect(container.textContent).not.toContain("Remote conversation 5");
        await click("Load more");
        expect(requestThreadList).toHaveBeenLastCalledWith("/refreshed-project", 10, 0);
        expect(container.textContent).toContain("Remote conversation 5");
        expect(useThreadStore.getState().projectThreadFetchLimits).toEqual({ "project-1": 10 });
        expect(useThreadStore.getState().homeLoadPending).toEqual({ chats: false, projects: {} });

        await click("Show Projects first");
        expect(
          Array.from(container.querySelectorAll('[accessibilityrole="header"]')).map(
            (header) => header.textContent,
          ),
        ).toEqual(["Projects", "Chats"]);
        await click("Collapse project Refreshed project");
        expect(container.textContent).not.toContain("Remote conversation 0");
        await click("Expand project Refreshed project");
        await click("Refresh home");
        expect(requestThreadList).toHaveBeenLastCalledWith("/refreshed-project", 10, undefined);
        expect(useThreadStore.getState().expandedWorkspaceIds).toEqual({ "project-1": true });
        expect(useThreadStore.getState().sectionOrder).toEqual(["projects", "chats"]);

        workspaceError = "Workspace refresh failed";
        await click("Refresh home");
        expect(container.textContent).toContain(workspaceError);
        expect(requestThreadList).toHaveBeenCalledTimes(3);
        workspaceError = null;
        setActiveCoworkJsonRpcClient(null);
        await click("Refresh home");
        expect(container.textContent).toContain("Couldn't reach Cowork");
        expect(container.textContent).toContain("Saved draft 5");
        setActiveCoworkJsonRpcClient(client);
        await click("Refresh home");
        expect(container.textContent).not.toContain("Couldn't reach Cowork");
        await click("Open chat Saved draft 5, draft");
        expect(mockRouterPush).toHaveBeenCalledWith("/thread/draft-5");
        expect(useThreadStore.getState().getThread("draft-5")?.composerDraft).toBe("Unsent text 5");
      } finally {
        await act(async () => root.unmount());
        harness.restore();
        setActiveCoworkJsonRpcClient(null);
        useWorkspaceStore.getState().clear();
        useThreadStore.getState().clearAll();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "%s shows actionable chat/project state and reopens persisted local drafts",
    async (platform) => {
      mockWorkspaces = [
        {
          id: "project-1",
          name: "Desktop project",
          path: "/workspace/project",
          workspaceKind: "project",
        },
      ];
      mockThreads = [
        makeThread({
          id: "approval-chat",
          title: "Approval conversation",
          pendingPrompt: true,
          composerDraft: "this lower-priority draft must not hide approval",
        }),
        makeThread({
          id: "failed-chat",
          title: "Failed conversation",
          composerDraft: "retry this exact draft",
          composerSubmission: {
            clientMessageId: "stable-send-1",
            text: "retry this exact draft",
            attachments: [],
            status: "failed",
            error: "Desktop disconnected",
          },
        }),
        makeThread({
          id: "draft-persisted-1",
          title: "Saved offline draft",
          workspaceKind: null,
          composerDraft: "recover this after restart",
        }),
        makeThread({
          id: "project-approval",
          title: "Project conversation",
          workspaceId: "project-1",
          workspaceName: "Desktop project",
          workspaceKind: "project",
          pendingPrompt: true,
        }),
      ];
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);

        await act(async () => {
          root!.render(createElement(SharedThreadHomeScreen, { platform }));
        });

        const approval = container.querySelector(
          '[aria-label="Open chat Approval conversation, needs response"]',
        );
        const failed = container.querySelector(
          '[aria-label="Open chat Failed conversation, send failed"]',
        );
        const draft = container.querySelector(
          '[aria-label="Open chat Saved offline draft, draft"]',
        );
        const project = container.querySelector(
          '[aria-label="Open chat Project conversation, needs response"]',
        );
        expect(approval?.textContent).toContain("Needs response");
        expect(approval?.textContent).not.toContain("Draft");
        expect(failed?.textContent).toContain("Send failed");
        expect(draft?.textContent).toContain("Draft");
        expect(project?.textContent).toContain("Needs response");

        if (!(draft instanceof harness.dom.window.HTMLElement)) {
          throw new Error("missing actionable persisted draft row");
        }
        await act(async () => {
          draft.click();
        });
        expect(mockRouterPush).toHaveBeenCalledWith("/thread/draft-persisted-1");

        mockThreads = mockThreads.map((thread) =>
          thread.id === "failed-chat" ? { ...thread, composerSubmission: null } : thread,
        );
        await act(async () => {
          root!.render(createElement(SharedThreadHomeScreen, { platform }));
        });
        const recovered = container.querySelector(
          '[aria-label="Open chat Failed conversation, draft"]',
        );
        expect(recovered?.textContent).toContain("Draft");
        expect(recovered?.textContent).not.toContain("Send failed");
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

  test.each(["android", "ios"] as const)(
    "%s exposes an unsubscribed desktop approval from its canonical thread summary",
    async (platform) => {
      useThreadStore.setState({
        threads: [],
        snapshots: {},
        pendingRequests: {},
        pendingRequestQueues: {},
        selectedThreadId: null,
      });
      useThreadStore.getState().syncRemoteThreads([
        {
          id: "unsubscribed-approval",
          title: "Desktop is waiting",
          preview: "Approve the requested command",
          modelProvider: "anthropic",
          model: "claude-sonnet-4",
          cwd: "/workspace",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          messageCount: 4,
          lastEventSeq: 28,
          status: { type: "running" },
          hasPendingAsk: false,
          hasPendingApproval: true,
        },
      ]);
      mockThreads = useThreadStore.getState().threads;
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);
        await act(async () => {
          root!.render(createElement(SharedThreadHomeScreen, { platform }));
        });

        const approval = container.querySelector(
          '[aria-label="Open chat Desktop is waiting, needs response"]',
        );
        expect(approval?.textContent).toContain("Needs response");
        if (!(approval instanceof harness.dom.window.HTMLElement)) {
          throw new Error("missing pending desktop approval row");
        }
        await act(async () => {
          approval.click();
        });
        expect(mockRouterPush).toHaveBeenCalledWith("/thread/unsubscribed-approval");
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

  test.each([
    { platform: "android", status: "connecting", title: "Connecting to Cowork Desktop" },
    { platform: "ios", status: "connecting", title: "Connecting to Cowork Desktop" },
    { platform: "android", status: "reconnecting", title: "Reconnecting to Cowork Desktop" },
    { platform: "ios", status: "reconnecting", title: "Reconnecting to Cowork Desktop" },
    { platform: "android", status: "idle", title: "Cowork Desktop disconnected" },
    { platform: "ios", status: "idle", title: "Cowork Desktop disconnected" },
    { platform: "android", status: "error", title: "Desktop permission required" },
    { platform: "ios", status: "error", title: "Desktop permission required" },
  ] as const)(
    "$platform makes $status honest and routes recovery without demanding re-pairing",
    async ({ platform, status, title }) => {
      const permissionGuidance =
        "Enable Conversations for this phone in Cowork Desktop > Settings > Remote Access.";
      mockConnectionState = {
        status,
        transportMode: "native",
        lastError: status === "error" ? permissionGuidance : null,
      };
      mockTrustedMacs = [{ macDeviceId: "desktop-1", displayName: "Work Mac" }];
      mockThreads = [makeThread({ id: "cached-chat", title: "Saved conversation" })];
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);
        await act(async () => {
          root!.render(createElement(SharedThreadHomeScreen, { platform }));
        });

        const recovery = container.querySelector(
          '[aria-label="Open Remote access connection settings"]',
        );
        expect(recovery?.textContent).toContain(title);
        expect(recovery?.textContent?.toLowerCase()).toContain("draft");
        expect(recovery?.textContent).toContain("Remote access");
        expect(recovery?.textContent).not.toContain("Re-pair");
        if (status === "error") {
          expect(recovery?.textContent).toContain(permissionGuidance);
        }
        if (!(recovery instanceof harness.dom.window.HTMLElement)) {
          throw new Error("missing connection recovery action");
        }
        await act(async () => {
          recovery.click();
        });
        expect(mockRouterPush).toHaveBeenCalledWith("/(pairing)");
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
});
