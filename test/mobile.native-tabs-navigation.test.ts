import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  MOBILE_DEEP_LINKS,
  MOBILE_TABS,
  pendingInputBadgeValue,
} from "../apps/mobile/src/features/navigation/mobile-navigation";

const appRoot = path.resolve(import.meta.dir, "../apps/mobile/src/app/(app)/(tabs)");
const tabsLayoutSource = readFileSync(path.join(appRoot, "_layout.tsx"), "utf8");

describe("mobile native tab navigation", () => {
  test("exposes every primary destination through the native tab shell", () => {
    expect(MOBILE_TABS.map(({ label, rootPath, route }) => ({ label, rootPath, route }))).toEqual([
      { label: "Chats", rootPath: "/threads", route: "(chats)" },
      { label: "Workspace", rootPath: "/workspace", route: "(workspace)" },
      { label: "Skills", rootPath: "/skills", route: "(skills)" },
      { label: "Settings", rootPath: "/settings", route: "(settings)" },
    ]);
    expect(tabsLayoutSource).toContain('from "expo-router/unstable-native-tabs"');
    expect(tabsLayoutSource).toContain('backBehavior="history"');
  });

  test("provides native selected and unselected symbols on iOS and Android", () => {
    for (const tab of MOBILE_TABS) {
      expect(tab.iosIcon.default.length).toBeGreaterThan(0);
      expect(tab.iosIcon.selected.length).toBeGreaterThan(0);
      expect(tab.androidIcon.default.length).toBeGreaterThan(0);
      expect(tab.androidIcon.selected.length).toBeGreaterThan(0);
    }
    expect(tabsLayoutSource).toContain("sf={chatsTab.iosIcon}");
    expect(tabsLayoutSource).toContain("md={chatsTab.androidIcon}");
  });

  test("keeps each tab in an independent stack with a stable root", () => {
    const expectedRoots = {
      "(chats)": "threads/index",
      "(workspace)": "workspace/index",
      "(skills)": "skills/index",
      "(settings)": "settings/index",
    } as const;

    for (const [group, initialRouteName] of Object.entries(expectedRoots)) {
      const source = readFileSync(path.join(appRoot, group, "_layout.tsx"), "utf8");
      expect(source).toContain('from "expo-router/stack"');
      expect(source).toContain(`initialRouteName: "${initialRouteName}"`);
      expect(source).toContain(`name="${initialRouteName}"`);
      expect(source).toContain('headerBackButtonDisplayMode: "minimal"');
    }
  });

  test("resolves public deep links to files in the owning tab stack", () => {
    const routeFiles = {
      [MOBILE_DEEP_LINKS.chats]: "(chats)/threads/index.tsx",
      [MOBILE_DEEP_LINKS.thread]: "(chats)/thread/[id].tsx",
      [MOBILE_DEEP_LINKS.workspace]: "(workspace)/workspace/index.tsx",
      [MOBILE_DEEP_LINKS.workspaceGeneral]: "(workspace)/workspace/general.tsx",
      [MOBILE_DEEP_LINKS.workspaceMemory]: "(workspace)/workspace/memory.tsx",
      [MOBILE_DEEP_LINKS.workspaceBackups]: "(workspace)/workspace/backups.tsx",
      [MOBILE_DEEP_LINKS.skills]: "(skills)/skills/index.tsx",
      [MOBILE_DEEP_LINKS.settings]: "(settings)/settings/index.tsx",
      [MOBILE_DEEP_LINKS.settingsProviders]: "(settings)/settings/providers.tsx",
      [MOBILE_DEEP_LINKS.settingsMcp]: "(settings)/settings/mcp.tsx",
      [MOBILE_DEEP_LINKS.settingsUsage]: "(settings)/settings/usage.tsx",
    } as const;

    for (const [deepLink, routeFile] of Object.entries(routeFiles)) {
      expect(deepLink.startsWith("/")).toBe(true);
      expect(existsSync(path.join(appRoot, routeFile))).toBe(true);
    }
  });

  test("shows a bounded Chats badge for pending approvals and questions", () => {
    expect(pendingInputBadgeValue({})).toBeUndefined();
    expect(pendingInputBadgeValue({ ask: { kind: "ask" }, empty: null })).toBe("1");
    expect(
      pendingInputBadgeValue(
        Object.fromEntries(Array.from({ length: 105 }, (_, index) => [String(index), {}])),
      ),
    ).toBe("99+");
    expect(tabsLayoutSource).toContain("<NativeTabs.Trigger.Badge");
  });
});
