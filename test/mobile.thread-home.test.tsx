import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";
import type { WorkspaceSummary } from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
} from "../apps/mobile/src/features/cowork/threadHomeModel";
import type { MobileThreadSummary } from "../apps/mobile/src/features/cowork/threadStore";

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
  RefreshControl: () => null,
  SectionList: ({
    ListEmptyComponent,
    ListHeaderComponent,
    renderItem,
    renderSectionHeader,
    sections,
  }: any) =>
    createElement(
      "div",
      { "data-testid": "thread-home-list" },
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
    MenuAction: ({ children }: { children?: any }) => createElement("div", null, children),
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
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (selector: any) =>
      selector({
        connectionState: { status: "connected", lastError: null },
        trustedMacs: [],
      }),
  }),
);

const actualThreadHome = require("../apps/mobile/src/features/cowork/useThreadHome");
const realUseThreadHome = actualThreadHome.useThreadHome;
let mockThreads: MobileThreadSummary[] = [];
let mockWorkspaces: WorkspaceSummary[] = [];
const mockThreadHomeAction = () => {};
mockLocalModule(
  "@/features/cowork/useThreadHome",
  "apps/mobile/src/features/cowork/useThreadHome",
  () => ({
    useThreadHome: () => ({
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
    }),
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
    mockThreads = [];
    mockWorkspaces = [];
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
});
