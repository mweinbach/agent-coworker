import { beforeEach, describe, expect, test } from "bun:test";
import { createHashHistory, createMemoryHistory } from "@tanstack/react-router";
import { JSDOM } from "jsdom";
import { appNavigation, createNavigation } from "../src/app/navigation";
import {
  __internalOperationIntent,
  beginCreationOperationIntent,
  isCreationNavigationIntentCurrent,
} from "../src/app/store.helpers/operationIntent";

beforeEach(() => __internalOperationIntent.reset());

describe("screen navigation", () => {
  test("restores canonical saved navigation once", () => {
    const navigation = createNavigation(createMemoryHistory({ initialEntries: ["/chat"] }));
    navigation.initialize({
      view: "settings",
      settingsPage: "providers",
      lastNonSettingsView: "task",
    });
    expect(navigation.history.location.pathname).toBe("/settings/models");
    expect(navigation.getSnapshot().lastNonSettingsView).toBe("task");
    navigation.update({ settingsPage: "updates" });
    navigation.initialize({ view: "chat" });
    expect(navigation.history.location.pathname).toBe("/settings/updates");
  });

  test("explicit initial links beat saved navigation and normalize aliases", () => {
    const navigation = createNavigation(
      createMemoryHistory({ initialEntries: ["/settings/mcp"] }),
      true,
    );
    navigation.initialize({ view: "task", settingsPage: "updates" });
    expect(navigation.history.location.pathname).toBe("/settings/toolAccess");
    expect(navigation.getSnapshot().lastNonSettingsView).toBe("chat");
    expect(navigation.history.length).toBe(1);
  });

  test("settings page changes preserve task return context independently of back and forward", () => {
    const navigation = createNavigation(createMemoryHistory({ initialEntries: ["/task"] }));
    navigation.initialize(null);
    navigation.update({ view: "settings", settingsPage: "updates" });
    navigation.update({ settingsPage: "usage" });
    expect(navigation.getSnapshot().lastNonSettingsView).toBe("task");
    navigation.history.back();
    expect(navigation.history.location.pathname).toBe("/settings/updates");
    navigation.history.forward();
    expect(navigation.history.location.pathname).toBe("/settings/usage");
    navigation.update({ view: navigation.getSnapshot().lastNonSettingsView });
    expect(navigation.history.location.pathname).toBe("/task");
  });

  test("remembering a settings page does not open settings or add a history entry", () => {
    const navigation = createNavigation(createMemoryHistory({ initialEntries: ["/chat"] }));
    navigation.update({ settingsPage: "usage" });
    expect(navigation.history.location.pathname).toBe("/chat");
    expect(navigation.history.length).toBe(1);
    navigation.update({ view: "settings" });
    expect(navigation.history.location.pathname).toBe("/settings/usage");
  });

  test("programmatic result navigation preserves intent while browser history revokes it", () => {
    const navigation = createNavigation(createMemoryHistory({ initialEntries: ["/chat"] }));
    const intent = beginCreationOperationIntent();
    navigation.update({ view: "task" });
    expect(isCreationNavigationIntentCurrent(intent)).toBe(true);
    navigation.history.back();
    expect(isCreationNavigationIntentCurrent(intent)).toBe(false);
    navigation.history.forward();
    expect(navigation.getSnapshot().view).toBe("task");
    expect(isCreationNavigationIntentCurrent(intent)).toBe(false);
  });

  test("identical commands do not publish or grow history", () => {
    const navigation = createNavigation(createMemoryHistory({ initialEntries: ["/chat"] }));
    let publications = 0;
    const unsubscribe = navigation.subscribe(() => {
      publications += 1;
    });
    navigation.initialize({
      view: undefined,
      settingsPage: undefined,
      lastNonSettingsView: undefined,
    });
    navigation.update({ view: "chat" });
    navigation.update({});
    expect(publications).toBe(0);
    expect(navigation.history.length).toBe(1);
    unsubscribe();
  });

  test("unknown settings destinations cannot become arbitrary paths", () => {
    const navigation = createNavigation(
      createMemoryHistory({ initialEntries: ["/settings/not-a-page"] }),
      true,
    );
    navigation.initialize(null);
    expect(navigation.history.location.pathname).toBe("/settings/models");
  });

  test("hash navigation keeps native-window and connection query parameters intact", () => {
    const dom = new JSDOM("", {
      url: "https://cowork.example/index.html?window=main&threadId=thread-1#/chat",
    });
    const history = createHashHistory({ window: dom.window });
    try {
      const navigation = createNavigation(history, true);
      navigation.update({ view: "settings", settingsPage: "updates" });
      history.flush();
      expect(dom.window.location.search).toBe("?window=main&threadId=thread-1");
      expect(dom.window.location.hash).toBe("#/settings/updates");
    } finally {
      history.destroy();
      dom.window.close();
    }
  });

  test("navigation never becomes writable Zustand data or changes selected entities", async () => {
    const { useAppStore } = await import("../src/app/store");
    const previous = useAppStore.getState();
    const navigation = appNavigation.getSnapshot();
    try {
      useAppStore.getState().openSettings("updates");
      const current = useAppStore.getState();
      expect(current).not.toHaveProperty("view");
      expect(current).not.toHaveProperty("settingsPage");
      expect(current).not.toHaveProperty("lastNonSettingsView");
      expect(current).not.toHaveProperty("navigation");
      expect(current.selectedThreadId).toBe(previous.selectedThreadId);
      expect(current.selectedWorkspaceId).toBe(previous.selectedWorkspaceId);
      expect(current.threadRuntimeById).toBe(previous.threadRuntimeById);
      expect(current.composerDraftsByKey).toBe(previous.composerDraftsByKey);
    } finally {
      appNavigation.update(navigation, true);
    }
  });
});
