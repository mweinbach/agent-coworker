export type MobileTabDefinition = {
  route: "(chats)" | "(workspace)" | "(skills)" | "(settings)";
  label: "Chats" | "Workspace" | "Skills" | "Settings";
  rootPath: "/threads" | "/workspace" | "/skills" | "/settings";
  iosIcon: {
    default: string;
    selected: string;
  };
  androidIcon: {
    default: string;
    selected: string;
  };
};

export const MOBILE_TABS = [
  {
    route: "(chats)",
    label: "Chats",
    rootPath: "/threads",
    iosIcon: {
      default: "bubble.left.and.bubble.right",
      selected: "bubble.left.and.bubble.right.fill",
    },
    androidIcon: {
      default: "forum",
      selected: "forum",
    },
  },
  {
    route: "(workspace)",
    label: "Workspace",
    rootPath: "/workspace",
    iosIcon: {
      default: "folder",
      selected: "folder.fill",
    },
    androidIcon: {
      default: "folder",
      selected: "folder",
    },
  },
  {
    route: "(skills)",
    label: "Skills",
    rootPath: "/skills",
    iosIcon: {
      default: "sparkles",
      selected: "sparkles",
    },
    androidIcon: {
      default: "auto_awesome",
      selected: "auto_awesome",
    },
  },
  {
    route: "(settings)",
    label: "Settings",
    rootPath: "/settings",
    iosIcon: {
      default: "gearshape",
      selected: "gearshape.fill",
    },
    androidIcon: {
      default: "settings",
      selected: "settings",
    },
  },
] as const satisfies readonly MobileTabDefinition[];

export const MOBILE_DEEP_LINKS = {
  chats: "/threads",
  thread: "/thread/[id]",
  workspace: "/workspace",
  workspaceGeneral: "/workspace/general",
  workspaceMemory: "/workspace/memory",
  workspaceBackups: "/workspace/backups",
  skills: "/skills",
  settings: "/settings",
  settingsProviders: "/settings/providers",
  settingsMcp: "/settings/mcp",
  settingsUsage: "/settings/usage",
} as const;

export function pendingInputBadgeValue(
  pendingRequests: Readonly<Record<string, unknown | null | undefined>>,
): string | undefined {
  const pendingCount = Object.values(pendingRequests).filter(
    (request) => request !== null && request !== undefined,
  ).length;
  if (pendingCount === 0) {
    return undefined;
  }
  return pendingCount > 99 ? "99+" : String(pendingCount);
}
