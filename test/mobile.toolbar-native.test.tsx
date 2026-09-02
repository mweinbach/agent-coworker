import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { act, createContext, createElement, useContext, useState } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";
import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
} from "../apps/mobile/src/features/cowork/threadHomeModel";

const originalPlatform = process.env.EXPO_OS;
const sdk = path.resolve("apps/mobile/node_modules/expo-router/build");
const toolbar = path.join(sdk, "layouts/stack-utils/toolbar");
const restores: Array<() => void> = [];
const toolbarAssetNames = ["more", "compose", "stop", "remote-access", "chat", "folder"];

// Metro resolves bundled XML vectors to native image sources; Bun parses XML as data.
for (const name of toolbarAssetNames) {
  mock.module(path.resolve(`apps/mobile/assets/toolbar/${name}.xml`), () => ({
    uri: `asset:/toolbar/${name}.xml`,
  }));
}

function mockLocal(alias: string, relativePath: string, factory: () => any) {
  const resolved = path.resolve(relativePath);
  mock.module(alias, factory);
  mock.module(resolved, factory);
  for (const extension of [".ts", ".tsx", ".js"]) mock.module(resolved + extension, factory);
}

function mockStore(alias: string, relativePath: string, factory: () => any) {
  const actual = require(path.resolve(relativePath));
  mockLocal(alias, relativePath, factory);
  restores.push(() => mockLocal(alias, relativePath, () => actual));
}

mock.module(path.resolve("apps/mobile/node_modules/react"), () => React);
const actualReactNative = require("react-native");
mockLocal("react-native", "apps/mobile/node_modules/react-native", () => ({
  ...actualReactNative,
  View: ({ children }: any) => <div>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
  KeyboardAvoidingView: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, accessibilityLabel, disabled }: any) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  SectionList: () => null,
  FlatList: () => null,
}));

const Expanded = createContext(false);
const DropdownMenu = Object.assign(
  ({ expanded, children }: any) => <Expanded value={expanded}>{children}</Expanded>,
  {
    Trigger: ({ children }: any) => <div>{children}</div>,
    Items: ({ children }: any) => (useContext(Expanded) ? <div role="menu">{children}</div> : null),
  },
);
const DropdownMenuItem = Object.assign(
  ({ children, onClick, enabled }: any) => (
    <button type="button" role="menuitem" disabled={!enabled} onClick={onClick}>
      {children}
    </button>
  ),
  {
    Text: ({ children }: any) => <span>{children}</span>,
    LeadingIcon: ({ children }: any) => <span>{children}</span>,
    TrailingIcon: ({ children }: any) => <span>{children}</span>,
  },
);
mockLocal("@expo/ui/jetpack-compose", "apps/mobile/node_modules/@expo/ui/jetpack-compose", () => ({
  IconButton: ({ children, onClick, enabled }: any) => (
    <button type="button" disabled={!enabled} onClick={onClick}>
      {children}
    </button>
  ),
  Icon: ({ source, contentDescription }: any) => (
    <span role="img" aria-label={contentDescription} data-image-source={JSON.stringify(source)} />
  ),
  Text: ({ children }: any) => <span>{children}</span>,
  HorizontalDivider: () => <hr />,
  DropdownMenu,
  DropdownMenuItem,
}));
mockLocal(
  "@expo/ui/jetpack-compose/modifiers",
  "apps/mobile/node_modules/@expo/ui/jetpack-compose/modifiers",
  () => ({ background: () => ({}), alpha: () => ({}) }),
);

const primitives = await import(
  "../apps/mobile/node_modules/expo-router/build/primitives/elements.js"
);
mock.module(path.join(sdk, "primitives"), () => primitives);
mock.module(path.join(sdk, "primitives/index.js"), () => primitives);
const badge = await import(
  "../apps/mobile/node_modules/expo-router/build/layouts/stack-utils/toolbar/ToolbarItemBadge.android.js"
);
mock.module(path.join(toolbar, "ToolbarItemBadge"), () => badge);
mock.module(path.join(toolbar, "ToolbarItemBadge.js"), () => badge);
const nativeButton = await import(
  "../apps/mobile/node_modules/expo-router/build/layouts/stack-utils/toolbar/StackToolbarButton/native.android.js"
);
const nativeMenu = await import(
  "../apps/mobile/node_modules/expo-router/build/layouts/stack-utils/toolbar/StackToolbarMenu/native.android.js"
);
mock.module(path.join(toolbar, "StackToolbarButton/native"), () => nativeButton);
mock.module(path.join(toolbar, "StackToolbarButton/native.js"), () => nativeButton);
mock.module(path.join(toolbar, "StackToolbarMenu/native"), () => nativeMenu);
mock.module(path.join(toolbar, "StackToolbarMenu/native.js"), () => nativeMenu);
const buttons = await import(
  "../apps/mobile/node_modules/expo-router/build/layouts/stack-utils/toolbar/StackToolbarButton/index.js"
);
const menus = await import(
  "../apps/mobile/node_modules/expo-router/build/layouts/stack-utils/toolbar/StackToolbarMenu/index.js"
);
const { ToolbarPlacementContext } = await import(
  "../apps/mobile/node_modules/expo-router/build/layouts/stack-utils/toolbar/context.js"
);

const push = mock((_href: string) => {});
const iosHeaderItems: any[] = [];
function HeaderButton(props: any) {
  if (process.env.EXPO_OS !== "ios") return createElement(buttons.StackToolbarButton, props);
  const item = buttons.convertStackToolbarButtonPropsToRNHeaderItem(props)!;
  iosHeaderItems.push(item);
  return (
    <button
      type="button"
      aria-label={item.accessibilityLabel}
      disabled={item.disabled}
      onClick={item.onPress}
    />
  );
}
function HeaderMenu(props: any) {
  const [expanded, setExpanded] = useState(false);
  if (process.env.EXPO_OS !== "ios") return createElement(menus.StackToolbarMenu, props);
  const item = menus.convertStackToolbarMenuPropsToRNHeaderItem(props)!;
  iosHeaderItems.push(item);
  return (
    <>
      <button
        type="button"
        aria-label={item.accessibilityLabel}
        onClick={() => setExpanded(true)}
      />
      {expanded ? (
        <div role="menu">
          {item.menu.items.map((action: any) => (
            <button type="button" role="menuitem" key={action.label} onClick={action.onPress}>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
const Toolbar = Object.assign(
  ({ placement, children }: any) => (
    <ToolbarPlacementContext value={placement}>{children}</ToolbarPlacementContext>
  ),
  { Button: HeaderButton, Menu: HeaderMenu, MenuAction: menus.StackToolbarMenuAction },
);
const routerMock = () => ({
  Stack: { Screen: () => null, Toolbar },
  useRouter: () => ({ push, back: () => {} }),
  useLocalSearchParams: () => ({ id: "thread-1" }),
});
mock.module("expo-router", routerMock);
mock.module(path.resolve("apps/mobile/node_modules/expo-router"), routerMock);

mockLocal(
  "react-native-safe-area-context",
  "apps/mobile/node_modules/react-native-safe-area-context",
  () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }),
);
mockLocal(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => 48,
    runAccessibleLayoutAnimation: () => {},
    useAccessibilityAnnouncement: () => {},
    useReducedMotionEnabled: () => false,
  }),
);
mockLocal("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    background: "#fff",
    backgroundMuted: "#eee",
    text: "#111",
    primary: "#136",
    surface: "#fff",
    border: "#888",
  }),
}));
mockLocal("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: () => null,
}));
for (const [module, exported] of [
  ["ComposerBar", "ComposerBar"],
  ["thread/pending-request-card", "PendingRequestCard"],
  ["thread/subagent-bar", "SubagentBar"],
  ["thread/thread-render-item", "ThreadRenderItem"],
  ["ui/status-pill", "StatusPill"],
])
  mockLocal(`@/components/${module}`, `apps/mobile/src/components/${module}`, () => ({
    [exported]: () => null,
  }));
mockLocal("@/components/ui/screen", "apps/mobile/src/components/ui/screen", () => ({
  Screen: ({ children }: any) => <div>{children}</div>,
}));

let projectsFirst = false;
let pendingRequest: any = null;
const reorderSections = mock((_from: number, _to: number) => {});
const seedThread = mock(() => {});
const thread = {
  id: "thread-1",
  title: "Conversation",
  feed: [],
  composerDraft: "",
  composerAttachments: [],
  composerSubmission: null,
};
const threadState = {
  getThread: () => thread,
  getPendingRequest: () => pendingRequest,
  getActiveTurnStartedAt: () => null,
  hydrate: () => {},
  markTurnStarted: () => {},
  markTurnCompleted: () => {},
  setComposerDraft: () => {},
  interruptThread: () => {},
  cancelComposerSubmission: () => false,
  seedThread,
  selectedThreadId: "draft-1",
};
mockStore("@/features/cowork/threadStore", "apps/mobile/src/features/cowork/threadStore", () => ({
  useThreadStore: Object.assign((selector: any) => selector(threadState), {
    getState: () => threadState,
  }),
}));
mockStore(
  "@/features/cowork/workspaceStore",
  "apps/mobile/src/features/cowork/workspaceStore",
  () => ({ useWorkspaceStore: (selector: any) => selector({ controlSnapshot: null }) }),
);
mockStore(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (selector: any) =>
      selector({
        connectionState: { status: "connected", transportMode: "native" },
        trustedMacs: [],
      }),
  }),
);
mockStore(
  "@/features/preferences/displayPreferencesStore",
  "apps/mobile/src/features/preferences/displayPreferencesStore",
  () => ({ useDisplayPreferencesStore: () => false }),
);
mockStore(
  "@/features/cowork/useThreadHome",
  "apps/mobile/src/features/cowork/useThreadHome",
  () => ({
    useThreadHome: () => ({
      viewModel: buildThreadHomeViewModel({
        threads: [],
        workspaces: [],
        searchQuery: "",
        ui: {
          ...defaultThreadHomeUiState(),
          sectionOrder: projectsFirst ? ["projects", "chats"] : ["chats", "projects"],
        },
      }),
      setSearchQuery: () => {},
      reorderSections,
      refreshHome: async () => {},
      homeLoadPending: { chats: false, projects: {} },
      loadMoreChats: async () => {},
      loadMoreProject: async () => {},
      toggleShowAllChats: () => {},
      toggleProjectThreadListExpanded: () => {},
      toggleWorkspaceExpanded: () => {},
      expandWorkspace: () => {},
    }),
  }),
);
let interruption = Promise.withResolvers<void>();
const interruptTurn = mock(async (_threadId: string) => await interruption.promise);
const runtimeClient = {
  resumeThread: async () => ({ thread: { id: "thread-1" } }),
  readThread: async () => ({ thread: { id: "thread-1", turns: [] }, coworkSnapshot: null }),
  interruptTurn,
};
mockStore(
  "@/features/cowork/runtimeClient",
  "apps/mobile/src/features/cowork/runtimeClient",
  () => ({
    getActiveCoworkJsonRpcClient: () => runtimeClient,
  }),
);

const { SharedThreadHomeScreen } = await import(
  "../apps/mobile/src/components/thread-home/thread-home-screen.shared"
);
const ThreadDetailScreen = (await import("../apps/mobile/src/app/(app)/(tabs)/(chats)/thread/[id]"))
  .default;

async function render(element: React.ReactNode) {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    close: async () => {
      await act(async () => root.unmount());
      harness.restore();
    },
  };
}
function button(container: Element, label: string): HTMLButtonElement {
  const found = container.querySelector(`[aria-label="${label}"]`)?.closest("button");
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

function imageSources(container: Element) {
  return [...container.querySelectorAll("[data-image-source]")].map((icon) =>
    JSON.parse(icon.getAttribute("data-image-source")!),
  );
}

beforeEach(() => {
  projectsFirst = false;
  pendingRequest = null;
  push.mockClear();
  seedThread.mockClear();
  reorderSections.mockClear();
  interruptTurn.mockClear();
  iosHeaderItems.length = 0;
  interruption = Promise.withResolvers<void>();
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
  if (originalPlatform === undefined) delete process.env.EXPO_OS;
  else process.env.EXPO_OS = originalPlatform;
  mock.restore();
});

test.each(toolbarAssetNames)(
  "%s vector uses the native loader's supported filled paths",
  (name) => {
    const harness = setupJsdom();
    try {
      const xml = new harness.dom.window.DOMParser().parseFromString(
        readFileSync(path.resolve(`apps/mobile/assets/toolbar/${name}.xml`), "utf8"),
        "application/xml",
      );
      expect(xml.querySelector("parsererror")).toBeNull();
      const paths = [...xml.querySelectorAll("path")];
      expect(paths.length).toBeGreaterThan(0);
      for (const vectorPath of paths) {
        // Expo UI's VectorIconLoader ignores strokes, fillType, and opacity.
        expect([...vectorPath.attributes].map((attribute) => attribute.name).sort()).toEqual([
          "android:fillColor",
          "android:pathData",
        ]);
        expect(vectorPath.getAttribute("android:fillColor")).toBe("#FF000000");
        expect(vectorPath.getAttribute("android:pathData")?.length).toBeGreaterThan(0);
      }
    } finally {
      harness.restore();
    }
  },
);

describe.each(["android", "ios"] as const)("native toolbar on %s", (platform) => {
  beforeEach(() => {
    process.env.EXPO_OS = platform;
  });
  test.each([false, true])(
    "keeps compose and menu actions reachable with projectsFirst=%s",
    async (first) => {
      projectsFirst = first;
      const view = await render(<SharedThreadHomeScreen platform={platform} />);
      try {
        if (platform === "android") {
          expect(imageSources(view.container)).toEqual([
            { uri: "asset:/toolbar/more.xml" },
            { uri: "asset:/toolbar/compose.xml" },
          ]);
        }
        await act(async () => button(view.container, "New chat").click());
        expect(seedThread).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith("/thread/draft-1");
        await act(async () => button(view.container, "Open menu").click());
        const actions = [
          ...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        ];
        expect(actions.map((action) => action.textContent)).toEqual([
          "Remote access",
          first ? "Show Chats first" : "Show Projects first",
        ]);
        if (platform === "android") {
          expect(actions.map((action) => imageSources(action))).toEqual([
            [{ uri: "asset:/toolbar/remote-access.xml" }],
            [{ uri: `asset:/toolbar/${first ? "chat" : "folder"}.xml` }],
          ]);
        }
        await act(async () => actions[0].click());
        expect(push).toHaveBeenCalledWith("/(pairing)");
        await act(async () => button(view.container, "Open menu").click());
        await act(async () =>
          view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1].click(),
        );
        expect(reorderSections).toHaveBeenCalledWith(0, 2);
        if (platform === "ios") {
          expect(iosHeaderItems.some((item) => item.icon?.name === "square.and.pencil")).toBe(true);
          expect(iosHeaderItems.some((item) => item.icon?.name === "ellipsis")).toBe(true);
          expect(
            iosHeaderItems.find((item) => item.menu).menu.items.map((item: any) => item.icon.name),
          ).toEqual(["iphone.and.arrow.forward", first ? "bubble.left.fill" : "folder.fill"]);
        }
      } finally {
        await view.close();
      }
    },
  );
  test("omits stop when there is no active turn or pending request", async () => {
    const view = await render(<ThreadDetailScreen />);
    try {
      expect(view.container.querySelector('[aria-label="Stop turn"]')).toBeNull();
      expect(view.container.querySelector('[aria-label="Stopping turn"]')).toBeNull();
    } finally {
      await view.close();
    }
  });
  test("keeps stop reachable and disables repeated presses while interruption is pending", async () => {
    pendingRequest = {
      requestId: "approval-1",
      kind: "approval",
      threadId: "thread-1",
      itemId: "tool-1",
      command: "work",
      dangerous: false,
    };
    const view = await render(<ThreadDetailScreen />);
    try {
      if (platform === "android")
        expect(imageSources(view.container)).toEqual([{ uri: "asset:/toolbar/stop.xml" }]);
      await act(async () => button(view.container, "Stop turn").click());
      expect(interruptTurn).toHaveBeenCalledWith("thread-1");
      const stopping = button(view.container, "Stopping turn");
      expect(stopping.disabled).toBe(true);
      await act(async () => stopping.click());
      expect(interruptTurn).toHaveBeenCalledTimes(1);
      if (platform === "ios")
        expect(iosHeaderItems.every((item) => item.icon?.name === "xmark.circle.fill")).toBe(true);
    } finally {
      interruption.resolve();
      await view.close();
    }
  });
});
