import { describe, expect, mock, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskSummary, ThreadRecord, WorkspaceRecord } from "../src/app/types";
import type { SidebarSearchOverlayProps } from "../src/ui/sidebar/SidebarSearchOverlay";
import { setupJsdom } from "./jsdomHarness";

const { SidebarSearchOverlay } = await import("../src/ui/sidebar/SidebarSearchOverlay");

type SearchProps = Omit<SidebarSearchOverlayProps, "open" | "onOpenChange">;

function workspace(id: string, name: string, path: string): WorkspaceRecord {
  return {
    id,
    name,
    path,
    workspaceKind: "project",
    createdAt: "2026-03-24T00:00:00.000Z",
    lastOpenedAt: "2026-03-24T00:00:00.000Z",
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
  };
}

function thread(id: string, workspaceId: string, title: string): ThreadRecord {
  return {
    id,
    workspaceId,
    title,
    createdAt: "2026-03-24T00:00:00.000Z",
    lastMessageAt: "",
    status: "active",
    sessionId: null,
    messageCount: 0,
    lastEventSeq: 0,
  };
}

function task(id: string, title: string): TaskSummary {
  return {
    id,
    workspacePath: "/repos/alpha",
    title,
    objective: "Close the books",
    status: "draft",
    revision: 1,
    reviewRequired: false,
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    threadCount: 1,
    completedWorkItemCount: 0,
    totalWorkItemCount: 1,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
  };
}

function SearchHost({ host, ...props }: SearchProps & { host: { reopen: () => void } }) {
  const [open, setOpen] = useState(true);
  host.reopen = () => setOpen(true);
  return createElement(SidebarSearchOverlay, {
    ...props,
    open,
    onOpenChange: setOpen,
  });
}

function optionNodes(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll<HTMLButtonElement>('[data-search-overlay-item="true"]')];
}

function optionTitle(option: HTMLElement): string {
  const title = [...option.querySelectorAll("span.truncate")].find(
    (span) => span.children.length === 0,
  );
  return title?.textContent ?? "";
}

function optionTitles(doc: Document): string[] {
  return optionNodes(doc).map(optionTitle);
}

function optionByTitle(doc: Document, title: string): HTMLButtonElement | undefined {
  return optionNodes(doc).find((option) => optionTitle(option) === title);
}

function activeTitle(doc: Document): string {
  const active = doc.querySelector<HTMLElement>(
    '[data-search-overlay-item="true"][data-active="true"]',
  );
  return active ? optionTitle(active) : "";
}

function heading(doc: Document, name: string): HTMLElement | undefined {
  return [...doc.querySelectorAll<HTMLElement>("button, span")].find(
    (element) =>
      element.getAttribute("role") !== "option" &&
      element.classList.contains("font-semibold") &&
      element.textContent === name,
  );
}

async function renderSearch(props: SearchProps) {
  const harness = setupJsdom();
  const host = { reopen: () => {} };
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SearchHost, { host, ...props }));
  });
  const doc = harness.dom.window.document;
  return {
    doc,
    host,
    harness,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    },
    async rerender(next: SearchProps) {
      await act(async () => {
        root.render(createElement(SearchHost, { host, ...next }));
      });
    },
    async reopen() {
      await act(async () => {
        host.reopen();
      });
    },
    async setQuery(value: string) {
      const input = doc.querySelector<HTMLInputElement>('[data-slot="command-input"]');
      if (!input) throw new Error("missing search input");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          harness.dom.window.HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!setter) throw new Error("missing input value setter");
        input.focus();
        setter.call(input, value);
        input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new harness.dom.window.KeyboardEvent("keyup", { bubbles: true }));
      });
    },
    async press(init: KeyboardEventInit & { keyCode?: number }) {
      const input = doc.querySelector<HTMLInputElement>('[data-slot="command-input"]');
      if (!input) throw new Error("missing search input");
      await act(async () => {
        const event = new harness.dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: init.key,
          altKey: init.altKey,
          ctrlKey: init.ctrlKey,
          metaKey: init.metaKey,
          shiftKey: init.shiftKey,
        });
        if (init.keyCode !== undefined) {
          Object.defineProperty(event, "keyCode", { value: init.keyCode });
        }
        input.dispatchEvent(event);
      });
    },
  };
}

function catalog(tasksEnabled: boolean): SearchProps {
  return {
    projectWorkspaces: [
      workspace("ws-alpha", "Alpha", "/repos/alpha"),
      workspace("ws-beta", "Beta", "/repos/beta"),
    ],
    threadsByWorkspaceId: new Map([
      [
        "ws-alpha",
        [thread("t-invoice", "ws-alpha", "Invoice export"), thread("t-blank", "ws-alpha", "")],
      ],
    ]),
    oneOffChatThreads: [thread("t-personal", "ws-chat", "Personal note")],
    taskSummariesByWorkspaceId: {
      "ws-alpha": [task("task-close", "Close books")],
    },
    tasksEnabled,
    selectedThreadId: "t-invoice",
    selectedTaskId: null,
    selectedWorkspaceId: "ws-beta",
    onSelectThread: mock((_threadId: string) => {}),
    onSelectTask: mock((_taskId: string) => {}),
    onSelectWorkspace: mock((_workspaceId: string) => {}),
  };
}

describe.serial("SidebarSearchOverlay", () => {
  test("matches a project by path or title without leaking siblings, tasks, or one-off chats", async () => {
    const props = catalog(true);
    const view = await renderSearch(props);
    try {
      expect(optionTitles(view.doc)).toEqual([
        "Invoice export",
        "New chat",
        "Close books",
        "Beta",
        "Personal note",
      ]);
      expect(optionByTitle(view.doc, "Invoice export")?.textContent).toContain("/repos/alpha");
      expect(optionByTitle(view.doc, "Invoice export")?.textContent).toContain("(current)");
      expect(optionByTitle(view.doc, "Close books")?.textContent).toContain("Task · /repos/alpha");
      expect(optionByTitle(view.doc, "Beta")?.textContent).toContain("/repos/beta");
      expect(optionByTitle(view.doc, "Beta")?.textContent).not.toContain("(current)");
      expect(optionByTitle(view.doc, "Personal note")?.textContent).toContain("Chats");
      expect(heading(view.doc, "Alpha")?.tagName).toBe("BUTTON");
      expect(heading(view.doc, "Chats")?.tagName).toBe("SPAN");
      expect(view.doc.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(
        "Search chats, projects, and tasks",
      );

      await view.rerender({ ...props, selectedThreadId: null });
      expect(optionByTitle(view.doc, "Beta")?.textContent).toContain("(current)");
      expect(optionByTitle(view.doc, "Invoice export")?.textContent).not.toContain("(current)");

      await view.setQuery("   ");
      expect(optionTitles(view.doc)).toEqual([
        "Invoice export",
        "New chat",
        "Close books",
        "Beta",
        "Personal note",
      ]);
      expect(view.doc.querySelector('[aria-label="Clear search"]')).toBeNull();

      await view.setQuery("  /REPOS/ALPHA  ");
      expect(optionTitles(view.doc)).toEqual(["Invoice export", "New chat", "Close books"]);

      await view.setQuery("inv");
      expect(optionTitles(view.doc)).toEqual(["Invoice export"]);

      await view.setQuery("new chat");
      expect(optionTitles(view.doc)).toEqual(["New chat"]);

      await view.setQuery("beta");
      expect(optionTitles(view.doc)).toEqual(["Beta"]);
      await act(async () => {
        optionByTitle(view.doc, "Beta")?.click();
      });
      expect(props.onSelectWorkspace).toHaveBeenCalledTimes(1);
      expect(props.onSelectWorkspace).toHaveBeenCalledWith("ws-beta");
      expect(props.onSelectThread).not.toHaveBeenCalled();
      expect(props.onSelectTask).not.toHaveBeenCalled();
      expect(view.doc.querySelector('[data-sidebar-search-overlay="true"]')).toBeNull();

      await view.reopen();
      await view.setQuery("invoice");
      const clear = view.doc.querySelector<HTMLButtonElement>('[aria-label="Clear search"]');
      expect(clear).not.toBeNull();
      await act(async () => {
        clear?.click();
      });
      expect(optionTitles(view.doc)).toContain("Personal note");
      expect(view.doc.querySelector('[aria-label="Clear search"]')).toBeNull();

      await act(async () => {
        heading(view.doc, "Alpha")?.click();
      });
      expect(props.onSelectWorkspace).toHaveBeenCalledTimes(2);
      expect(props.onSelectWorkspace).toHaveBeenLastCalledWith("ws-alpha");
      expect(props.onSelectThread).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  test("hides tasks when the feature is off and reports an empty catalog or a trimmed miss", async () => {
    const disabled = catalog(false);
    const view = await renderSearch(disabled);
    try {
      expect(view.doc.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(
        "Search chats and projects",
      );
      expect(
        view.doc.querySelector('[data-slot="command-input"]')?.getAttribute("placeholder"),
      ).toBe("Search chats and projects…");
      expect(optionTitles(view.doc)).not.toContain("Close books");

      await view.setQuery("close");
      expect(view.doc.querySelector('[role="status"]')?.textContent).toBe("No matches for “close”");
      expect(disabled.onSelectThread).not.toHaveBeenCalled();
      expect(disabled.onSelectTask).not.toHaveBeenCalled();
      expect(disabled.onSelectWorkspace).not.toHaveBeenCalled();

      await view.setQuery("  Alpha Beta  ");
      expect(view.doc.querySelector('[role="status"]')?.textContent).toBe(
        "No matches for “Alpha Beta”",
      );

      await view.setQuery("alpha");
      expect(optionTitles(view.doc)).toEqual(["Invoice export", "New chat"]);
    } finally {
      await view.cleanup();
    }

    const emptyProps = {
      ...catalog(false),
      projectWorkspaces: [],
      threadsByWorkspaceId: new Map(),
      oneOffChatThreads: [],
      taskSummariesByWorkspaceId: {},
    };
    const empty = await renderSearch(emptyProps);
    try {
      expect(empty.doc.querySelector('[role="status"]')?.textContent).toBe(
        "No chats or projects yet",
      );
      await empty.press({ key: "Enter" });
      await empty.press({ key: "ArrowDown" });
      expect(empty.doc.querySelector('[data-sidebar-search-overlay="true"]')).not.toBeNull();
      expect(emptyProps.onSelectThread).not.toHaveBeenCalled();
      expect(emptyProps.onSelectTask).not.toHaveBeenCalled();
      expect(emptyProps.onSelectWorkspace).not.toHaveBeenCalled();
    } finally {
      await empty.cleanup();
    }
  });

  test("moves the highlight, jumps to a row, and drops a stale highlight when the query changes", async () => {
    const onSelectThread = mock((_threadId: string) => {});
    const onSelectTask = mock((_taskId: string) => {});
    const onSelectWorkspace = mock((_workspaceId: string) => {});
    const props: SearchProps = {
      projectWorkspaces: [workspace("ws-notes", "Ledger", "/repos/ledger")],
      threadsByWorkspaceId: new Map([["ws-notes", [thread("t-alpha", "ws-notes", "Alpha note")]]]),
      oneOffChatThreads: [thread("t-gamma", "ws-chat", "Gamma note")],
      taskSummariesByWorkspaceId: { "ws-notes": [task("task-close", "Close books")] },
      tasksEnabled: true,
      selectedThreadId: null,
      selectedTaskId: null,
      selectedWorkspaceId: null,
      onSelectThread,
      onSelectTask,
      onSelectWorkspace,
    };
    const view = await renderSearch(props);
    try {
      expect(optionTitles(view.doc)).toEqual(["Alpha note", "Close books", "Gamma note"]);
      expect(activeTitle(view.doc)).toBe("Alpha note");

      await view.press({ key: "ArrowUp" });
      expect(activeTitle(view.doc)).toBe("Gamma note");
      await view.press({ key: "ArrowDown" });
      expect(activeTitle(view.doc)).toBe("Alpha note");
      await view.press({ key: "ArrowDown" });
      await view.press({ key: "ArrowDown" });
      expect(activeTitle(view.doc)).toBe("Gamma note");

      await view.press({ key: "ArrowDown", keyCode: 229 });
      expect(activeTitle(view.doc)).toBe("Gamma note");
      await view.press({ key: "1" });
      await view.press({ key: "1", ctrlKey: true, altKey: true });
      await view.press({ key: "1", ctrlKey: true, shiftKey: true });
      await view.press({ key: "9", ctrlKey: true });
      expect(activeTitle(view.doc)).toBe("Gamma note");
      expect(onSelectThread).not.toHaveBeenCalled();
      expect(onSelectTask).not.toHaveBeenCalled();
      expect(onSelectWorkspace).not.toHaveBeenCalled();

      await view.press({ key: "2", ctrlKey: true });
      expect(onSelectTask.mock.calls).toEqual([["task-close"]]);
      expect(onSelectThread).not.toHaveBeenCalled();
      expect(view.doc.querySelector('[data-sidebar-search-overlay="true"]')).toBeNull();

      await view.reopen();
      await view.press({ key: "ArrowDown" });
      await view.press({ key: "ArrowDown" });
      expect(activeTitle(view.doc)).toBe("Gamma note");
      await view.setQuery("note");
      expect(optionTitles(view.doc)).toEqual(["Alpha note", "Gamma note"]);
      expect(activeTitle(view.doc)).toBe("Alpha note");
      await view.press({ key: "Enter" });
      expect(onSelectThread.mock.calls).toEqual([["t-alpha"]]);
      expect(onSelectTask).toHaveBeenCalledTimes(1);

      await view.reopen();
      await view.setQuery("gamma");
      await view.press({ key: "Escape" });
      expect(view.doc.querySelector('[data-sidebar-search-overlay="true"]')).toBeNull();
      await view.reopen();
      const input = view.doc.querySelector<HTMLInputElement>('[data-slot="command-input"]');
      expect(input?.value).toBe("");
      expect(optionTitles(view.doc)).toEqual(["Alpha note", "Close books", "Gamma note"]);

      await view.press({ key: "1", metaKey: true });
      expect(onSelectThread.mock.calls).toEqual([["t-alpha"], ["t-alpha"]]);
      expect(onSelectWorkspace).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  test("offers a jump shortcut only for the first nine rows", async () => {
    const threads = Array.from({ length: 10 }, (_, index) =>
      thread(`t-${index + 1}`, "ws-notes", `Thread ${index + 1}`),
    );
    const onSelectThread = mock((_threadId: string) => {});
    const view = await renderSearch({
      projectWorkspaces: [workspace("ws-notes", "Notes", "/repos/notes")],
      threadsByWorkspaceId: new Map([["ws-notes", threads]]),
      oneOffChatThreads: [],
      taskSummariesByWorkspaceId: {},
      tasksEnabled: false,
      selectedThreadId: null,
      selectedTaskId: null,
      selectedWorkspaceId: null,
      onSelectThread,
      onSelectTask: mock((_taskId: string) => {}),
      onSelectWorkspace: mock((_workspaceId: string) => {}),
    });
    try {
      const options = optionNodes(view.doc);
      expect(options).toHaveLength(10);
      expect(options[8]?.querySelector("span.tabular-nums")?.textContent).toMatch(
        /^(?:Ctrl\+|⌘)9$/,
      );
      expect(options[9]?.querySelector("span.tabular-nums")).toBeNull();

      await view.press({ key: "9", ctrlKey: true });
      expect(onSelectThread.mock.calls).toEqual([["t-9"]]);
    } finally {
      await view.cleanup();
    }
  });
});
