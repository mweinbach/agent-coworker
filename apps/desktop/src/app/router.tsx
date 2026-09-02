import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { isPackagedDesktopApp } from "../lib/desktopCommands";
import { ChatView } from "../ui/ChatView";
import { ScreenLoading } from "../ui/layout/ScreenLoading";
import { appNavigation } from "./navigation";
import { useAppStore } from "./store";
import { normalizeSettingsPageId } from "./store.actions/bootstrap";

function PendingScreen() {
  return <ScreenLoading label="Loading view" />;
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <Navigate to="/chat" replace />,
  beforeLoad: () => {
    const state = useAppStore.getState();
    if (!state.ready) return;
    const navigation = appNavigation.getSnapshot();
    if (navigation.view === "task" && state.desktopFeatureFlags.tasks !== true) {
      throw redirect({ to: "/chat", replace: true });
    }
    const page = normalizeSettingsPageId(
      navigation.settingsPage,
      state.desktopFeatureFlags,
      state.updateState.packaged || isPackagedDesktopApp(),
    );
    if (navigation.view === "settings" && page !== navigation.settingsPage) {
      throw redirect({ to: "/settings/models", replace: true });
    }
  },
});

const chatLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "workspace",
  component: lazyRouteComponent(() => import("../ui/layout/ChatScreen"), "ChatScreen"),
});

const chatRoute = createRoute({
  getParentRoute: () => chatLayout,
  path: "chat",
  component: ChatView,
});

const taskRoute = createRoute({
  getParentRoute: () => chatLayout,
  path: "task",
  component: lazyRouteComponent(() => import("../ui/tasks/TaskView"), "TaskView"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: lazyRouteComponent(() => import("../ui/layout/SettingsScreen"), "SettingsScreen"),
});

const settingsPages = [
  {
    path: "models",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/SettingsIntentPages"),
      "ModelsSettingsPage",
    ),
  },
  {
    path: "subagents",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/SubagentsPage"),
      "SubagentsPage",
    ),
  },
  {
    path: "toolAccess",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/SettingsIntentPages"),
      "ToolAccessSettingsPage",
    ),
  },
  {
    path: "defaults",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/SettingsIntentPages"),
      "DefaultsSettingsPage",
    ),
  },
  {
    path: "profileMemory",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/SettingsIntentPages"),
      "ProfileMemorySettingsPage",
    ),
  },
  {
    path: "chats",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/SettingsIntentPages"),
      "ChatsSettingsPage",
    ),
  },
  {
    path: "experiments",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/FeatureFlagsPage"),
      "FeatureFlagsPage",
    ),
  },
  {
    path: "diagnostics",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/DeveloperPage"),
      "DeveloperPage",
    ),
  },
  {
    path: "privacyTelemetry",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/PrivacyTelemetryPage"),
      "PrivacyTelemetryPage",
    ),
  },
  {
    path: "desktop",
    component: lazyRouteComponent(() => import("../ui/settings/pages/DesktopPage"), "DesktopPage"),
  },
  {
    path: "usage",
    component: lazyRouteComponent(() => import("../ui/settings/pages/UsagePage"), "UsagePage"),
  },
  {
    path: "remoteAccess",
    component: lazyRouteComponent(
      () => import("../ui/settings/pages/RemoteAccessPage"),
      "RemoteAccessPage",
    ),
  },
  {
    path: "backup",
    component: lazyRouteComponent(() => import("../ui/settings/pages/BackupPage"), "BackupPage"),
  },
  {
    path: "updates",
    component: lazyRouteComponent(() => import("../ui/settings/pages/UpdatesPage"), "UpdatesPage"),
  },
] as const;

const settingsPageRoutes = settingsPages.map((page) =>
  createRoute({ getParentRoute: () => settingsRoute, ...page }),
);

const legacySettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "$page",
  beforeLoad: () => appNavigation.update({}, true),
  component: PendingScreen,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => appNavigation.update({}, true),
  component: PendingScreen,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat", replace: true });
  },
});

function createAppRouter() {
  return createRouter({
    isServer: false,
    routeTree: rootRoute.addChildren([
      indexRoute,
      chatLayout.addChildren([chatRoute, taskRoute]),
      settingsRoute.addChildren([...settingsPageRoutes, legacySettingsRoute, settingsIndexRoute]),
    ]),
    history: appNavigation.history,
    defaultPendingComponent: PendingScreen,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
}

let router: ReturnType<typeof createAppRouter> | undefined;

export function getAppRouter() {
  router ??= createAppRouter();
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
