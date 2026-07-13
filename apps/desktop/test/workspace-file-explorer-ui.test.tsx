import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useAppStore } from "../src/app/store";
import {
  WorkspaceFileExplorer,
  type WorkspaceFileExplorerCommands,
} from "../src/ui/file-explorer/WorkspaceFileExplorer";
import { setupJsdom } from "./jsdomHarness";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const workspaceId = "ws-1";
const rootPath = "/workspace";

function makeFileEntry(name: string, modifiedAtMs: number, sizeBytes = 512) {
  return {
    name,
    path: `${rootPath}/${name}`,
    isDirectory: false,
    isHidden: false,
    sizeBytes,
    modifiedAtMs,
  };
}

function makeDirectoryEntry(name: string, modifiedAtMs: number) {
  return {
    name,
    path: `${rootPath}/${name}`,
    isDirectory: true,
    isHidden: false,
    sizeBytes: null,
    modifiedAtMs,
  };
}

let rootEntries = [makeFileEntry("README.md", 1700000000000)];
let listDirectoryImpl = async ({ path }: { path: string }) => {
  if (path === rootPath) return rootEntries;
  return [];
};

const listDirectoryMock = mock(async (args: { path: string }) => listDirectoryImpl(args));
const clearDirectoryListingScopeMock = mock(() => {});
const invalidateDirectoryListingMock = mock(() => {});
const isStaleDirectoryListingErrorMock = mock(() => false);
const watchWorkspaceDirectoryMock = mock(async () => true);
const unwatchWorkspaceDirectoryMock = mock(async () => {});
const onWorkspaceFileChangedMock = mock(() => () => {});
const showContextMenuMock = mock(async () => null);
const explorerCommands: WorkspaceFileExplorerCommands = {
  clearDirectoryListingScope: clearDirectoryListingScopeMock,
  invalidateDirectoryListing: invalidateDirectoryListingMock,
  isStaleDirectoryListingError: isStaleDirectoryListingErrorMock,
  listDirectory: listDirectoryMock,
  onWorkspaceFileChanged: onWorkspaceFileChangedMock,
  showContextMenu: showContextMenuMock,
  unwatchWorkspaceDirectory: unwatchWorkspaceDirectoryMock,
  watchWorkspaceDirectory: watchWorkspaceDirectoryMock,
};

function resetAppStore() {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    ready: true,
    bootstrapPhase: "ready",
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        path: rootPath,
        createdAt: "2026-04-16T00:00:00.000Z",
        lastOpenedAt: "2026-04-16T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    selectedWorkspaceId: workspaceId,
    workspaceExplorerById: {
      [workspaceId]: {
        rootPath,
        currentPath: rootPath,
        entries: [],
        selectedPath: null,
        loading: false,
        error: null,
        requestId: 0,
      },
    },
    workspaceExplorerRefreshById: {},
    showHiddenFiles: false,
    contextSidebarCollapsed: false,
  } as any);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function unmountExplorer(root: Root | null): Promise<void> {
  if (!root) return;
  await act(async () => {
    root.unmount();
  });
}

describe("workspace file explorer UI", () => {
  beforeEach(() => {
    rootEntries = [makeFileEntry("README.md", 1700000000000)];
    listDirectoryImpl = async ({ path }: { path: string }) => {
      if (path === rootPath) return rootEntries;
      return [];
    };
    clearDirectoryListingScopeMock.mockClear();
    invalidateDirectoryListingMock.mockClear();
    isStaleDirectoryListingErrorMock.mockClear();
    listDirectoryMock.mockClear();
    onWorkspaceFileChangedMock.mockClear();
    showContextMenuMock.mockClear();
    unwatchWorkspaceDirectoryMock.mockClear();
    watchWorkspaceDirectoryMock.mockClear();
    resetAppStore();
  });

  test.serial(
    "uses effective drawer visibility instead of the persisted context preference",
    async () => {
      const harness = setupJsdom({
        includeAnimationFrame: true,
        extraGlobals: { ResizeObserver: MockResizeObserver },
      });
      let root: Root | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);
        useAppStore.setState({ contextSidebarCollapsed: true });

        await act(async () => {
          root?.render(
            createElement(WorkspaceFileExplorer, {
              active: true,
              commands: explorerCommands,
              workspaceId,
            }),
          );
          await flushUi();
        });

        expect(container.textContent).toContain("README.md");
        expect(listDirectoryMock).toHaveBeenCalled();
        expect(watchWorkspaceDirectoryMock).toHaveBeenCalled();
      } finally {
        await unmountExplorer(root);
        harness.restore();
      }
    },
  );

  test.serial("shows row overflow control on group focus-within for keyboard users", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: true,
      extraGlobals: { ResizeObserver: MockResizeObserver },
    });
    let root: Root | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
        );
        await flushUi();
      });

      const moreButton = container.querySelector(
        "button[aria-label='More options for README.md']",
      ) as HTMLButtonElement | null;
      expect(moreButton).toBeTruthy();
      const className = moreButton?.getAttribute("class") ?? "";
      expect(className).toContain("group-hover:opacity-100");
      expect(className).toContain("group-focus-within:opacity-100");
      expect(className).toContain("focus-visible:opacity-100");
    } finally {
      await unmountExplorer(root);
      harness.restore();
    }
  });

  test.serial("uses one tree tab stop and supports standard tree navigation", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: true,
      extraGlobals: { ResizeObserver: MockResizeObserver },
    });
    let root: Root | null = null;
    rootEntries = [
      makeDirectoryEntry("docs", 1700000000000),
      makeFileEntry("README.md", 1700000001000),
    ];
    listDirectoryImpl = async ({ path }: { path: string }) => {
      if (path === rootPath) return rootEntries;
      if (path === `${rootPath}/docs`) {
        return [
          {
            ...makeFileEntry("guide.md", 1700000002000),
            path: `${rootPath}/docs/guide.md`,
          },
        ];
      }
      return [];
    };

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root.render(
          createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
        );
        await flushUi();
      });

      const tree = container.querySelector('[role="tree"]');
      if (!(tree instanceof harness.dom.window.HTMLElement)) throw new Error("missing tree");
      const initialRows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      expect(initialRows).toHaveLength(2);
      expect(initialRows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
      const docsRow = initialRows[0];
      if (!docsRow) throw new Error("missing docs row");
      await act(async () => {
        docsRow.focus();
      });

      const press = async (key: string, options: KeyboardEventInit = {}) => {
        await act(async () => {
          harness.dom.window.document.activeElement?.dispatchEvent(
            new harness.dom.window.KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key,
              ...options,
            }),
          );
          await flushUi();
        });
      };

      await press("ArrowRight");
      expect(docsRow.getAttribute("aria-expanded")).toBe("true");
      await press("ArrowRight");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("guide.md");
      await press("ArrowDown");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("README.md");
      await press("Home");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("docs");
      await press("End");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("README.md");
      await press("ArrowUp");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("guide.md");
      await press("ArrowLeft");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("docs");
      await press("r");
      expect(harness.dom.window.document.activeElement?.textContent).toContain("README.md");
      await press("F10", { shiftKey: true });
      expect(showContextMenuMock).toHaveBeenCalledTimes(1);
      expect(
        [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
          (row) => row.tabIndex === 0,
        ),
      ).toHaveLength(1);
    } finally {
      await unmountExplorer(root);
      harness.restore();
    }
  });

  test.serial("refreshes the rendered tree when the workspace refresh signal changes", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: true,
      extraGlobals: { ResizeObserver: MockResizeObserver },
    });
    let root: Root | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
        );
        await flushUi();
      });

      expect(container.textContent).toContain("README.md");
      expect(container.textContent).not.toContain("preview_latency_review.md");

      rootEntries = [
        ...rootEntries,
        makeFileEntry("preview_latency_review.md", 1700000001000, 2048),
      ];

      await act(async () => {
        useAppStore.setState((state) => ({
          workspaceExplorerRefreshById: {
            ...state.workspaceExplorerRefreshById,
            [workspaceId]: 1,
          },
        }));
        await flushUi();
      });

      expect(container.textContent).toContain("preview_latency_review.md");
      expect(listDirectoryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await unmountExplorer(root);
      harness.restore();
    }
  });

  test.serial(
    "queues another refresh when a workspace invalidation lands during an in-flight sync",
    async () => {
      const harness = setupJsdom({
        includeAnimationFrame: true,
        extraGlobals: { ResizeObserver: MockResizeObserver },
      });
      let root: Root | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root.render(
            createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
          );
          await flushUi();
        });

        expect(container.textContent).toContain("README.md");
        expect(container.textContent).not.toContain("preview_latency_review.md");

        const staleRootEntries = [...rootEntries];
        const inFlightRefresh = createDeferred<typeof staleRootEntries>();
        let refreshCallCount = 0;
        listDirectoryImpl = async ({ path }: { path: string }) => {
          if (path !== rootPath) return [];
          refreshCallCount += 1;
          if (refreshCallCount === 1) return inFlightRefresh.promise;
          return rootEntries;
        };

        await act(async () => {
          useAppStore.setState((state) => ({
            workspaceExplorerRefreshById: {
              ...state.workspaceExplorerRefreshById,
              [workspaceId]: 1,
            },
          }));
          await Promise.resolve();
        });

        rootEntries = [
          ...staleRootEntries,
          makeFileEntry("preview_latency_review.md", 1700000001000, 2048),
        ];

        await act(async () => {
          useAppStore.setState((state) => ({
            workspaceExplorerRefreshById: {
              ...state.workspaceExplorerRefreshById,
              [workspaceId]: 2,
            },
          }));
          await Promise.resolve();
        });

        await act(async () => {
          inFlightRefresh.resolve(staleRootEntries);
          await flushUi();
        });
        await act(async () => {
          await flushUi();
        });

        expect(container.textContent).toContain("preview_latency_review.md");
        expect(refreshCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        await unmountExplorer(root);
        harness.restore();
      }
    },
  );

  test.serial(
    "revalidates files changed while a collapsed explorer watcher is stopped",
    async () => {
      const harness = setupJsdom({
        includeAnimationFrame: true,
        extraGlobals: { ResizeObserver: MockResizeObserver },
      });
      let root: Root | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root.render(
            createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
          );
          await flushUi();
        });
        expect(container.textContent).toContain("README.md");
        expect(watchWorkspaceDirectoryMock).toHaveBeenCalledTimes(1);

        await act(async () => {
          useAppStore.setState({ contextSidebarCollapsed: true });
          await flushUi();
        });
        expect(unwatchWorkspaceDirectoryMock).toHaveBeenCalledTimes(1);
        expect(clearDirectoryListingScopeMock.mock.calls.length).toBeGreaterThanOrEqual(1);

        rootEntries = [
          ...rootEntries,
          makeFileEntry("changed_while_watcher_stopped.md", 1700000002000, 1024),
        ];
        await act(async () => {
          useAppStore.setState({ contextSidebarCollapsed: false });
          await flushUi();
        });

        expect(container.textContent).toContain("changed_while_watcher_stopped.md");
        expect(watchWorkspaceDirectoryMock).toHaveBeenCalledTimes(2);
        expect(listDirectoryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        await unmountExplorer(root);
        harness.restore();
      }
    },
  );

  test.serial(
    "focus revalidation keeps a successful watcher from becoming permanently stale",
    async () => {
      const harness = setupJsdom({
        includeAnimationFrame: true,
        extraGlobals: { ResizeObserver: MockResizeObserver },
      });
      let root: Root | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root.render(
            createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
          );
          await flushUi();
        });
        expect(watchWorkspaceDirectoryMock).toHaveBeenCalledTimes(1);

        rootEntries = [
          ...rootEntries,
          makeFileEntry("missed_watcher_event.md", 1700000003000, 1536),
        ];
        await act(async () => {
          harness.dom.window.dispatchEvent(new harness.dom.window.Event("focus"));
          await flushUi();
        });

        expect(container.textContent).toContain("missed_watcher_event.md");
        expect(listDirectoryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        await unmountExplorer(root);
        harness.restore();
      }
    },
  );
});
