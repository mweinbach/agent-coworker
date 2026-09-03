import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
const showContextMenuMock = mock<WorkspaceFileExplorerCommands["showContextMenu"]>(
  async () => null,
);
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
const originalExplorerActions = {
  openFilePreview: useAppStore.getState().openFilePreview,
  openWorkspaceFile: useAppStore.getState().openWorkspaceFile,
  revealWorkspaceFile: useAppStore.getState().revealWorkspaceFile,
  copyWorkspaceFilePath: useAppStore.getState().copyWorkspaceFilePath,
};

function resetAppStore() {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    ...originalExplorerActions,
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
    notifications: [],
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

async function mountExplorerForInteraction() {
  const harness = setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: { ResizeObserver: MockResizeObserver },
  });
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);
  const cleanup = async () => {
    await unmountExplorer(root);
    harness.restore();
  };
  try {
    await act(async () => {
      root.render(
        createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId }),
      );
      await flushUi();
    });
    const clickEntry = async (name: string) => {
      const entry = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((row) =>
        row.textContent?.includes(name),
      );
      if (!entry) throw new Error(`missing explorer entry ${name}`);
      await act(async () => {
        entry.click();
        await flushUi();
      });
      return entry;
    };
    return { harness, container, root, clickEntry, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("workspace file explorer UI", () => {
  test("bounds inactive workspace listings while retaining the most recent workspace", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);
    const workspace = useAppStore.getState().workspaces[0];
    if (!workspace) throw new Error("missing workspace fixture");
    const ids = Array.from({ length: 10 }, (_, index) => `cache-workspace-${index}`);
    useAppStore.setState({
      workspaces: ids.map((id) => ({ ...workspace, id })),
    });
    const pending = createDeferred<ReturnType<typeof makeFileEntry>[]>();
    try {
      for (const id of ids) {
        listDirectoryImpl = async () => [makeFileEntry(`${id}.txt`, 1)];
        await act(async () => {
          root.render(
            createElement(WorkspaceFileExplorer, {
              key: id,
              commands: explorerCommands,
              workspaceId: id,
            }),
          );
          await flushUi();
        });
      }
      await act(async () => root.render(null));
      listDirectoryImpl = () => pending.promise;
      await act(async () => {
        root.render(
          createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId: ids[9] }),
        );
        await flushUi();
      });
      expect(container.textContent).toContain(`${ids[9]}.txt`);
      await act(async () => {
        root.render(
          createElement(WorkspaceFileExplorer, {
            key: ids[0],
            commands: explorerCommands,
            workspaceId: ids[0],
          }),
        );
        await flushUi();
      });
      expect(container.textContent).not.toContain(`${ids[0]}.txt`);
    } finally {
      pending.resolve([]);
      await unmountExplorer(root);
      harness.restore();
    }
  });

  test("retains mounted explorers while other workspace listings rotate out of the cache", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const container = harness.dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const workspace = useAppStore.getState().workspaces[0]!;
    const pinnedId = "pinned-cache-workspace";
    const ids = Array.from({ length: 10 }, (_, index) => `rotating-cache-workspace-${index}`);
    useAppStore.setState({ workspaces: [pinnedId, ...ids].map((id) => ({ ...workspace, id })) });
    const pending = createDeferred<ReturnType<typeof makeFileEntry>[]>();
    const renderExplorers = async (id: string | null, pinned = true, duplicatePinned = false) => {
      await act(async () => {
        root.render(
          createElement(
            "div",
            null,
            pinned
              ? createElement(WorkspaceFileExplorer, {
                  key: pinnedId,
                  commands: explorerCommands,
                  workspaceId: pinnedId,
                })
              : null,
            duplicatePinned
              ? createElement(WorkspaceFileExplorer, {
                  key: "duplicate-pinned",
                  commands: explorerCommands,
                  workspaceId: pinnedId,
                })
              : null,
            id
              ? createElement(WorkspaceFileExplorer, {
                  key: id,
                  commands: explorerCommands,
                  workspaceId: id,
                })
              : null,
          ),
        );
        await flushUi();
      });
    };
    try {
      listDirectoryImpl = async () => [makeFileEntry("pinned-file.txt", 1)];
      await renderExplorers(null, true, true);
      await renderExplorers(null);
      for (const id of ids) {
        listDirectoryImpl = async () => [makeFileEntry(`${id}.txt`, 1)];
        await renderExplorers(id);
        expect(container.textContent).toContain("pinned-file.txt");
      }
      await renderExplorers(ids[9]!, false);
      listDirectoryImpl = () => pending.promise;
      await renderExplorers(ids[9]!);
      expect(container.textContent).toContain("pinned-file.txt");
      expect(container.textContent).toContain(`${ids[9]}.txt`);
    } finally {
      pending.resolve([]);
      await unmountExplorer(root);
      harness.restore();
    }
  });

  test("ignores reads from an earlier visit after returning to the same workspace", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const container = harness.dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const workspace = useAppStore.getState().workspaces[0]!;
    const firstId = "revisited-cache-workspace";
    const secondId = "intermediate-cache-workspace";
    useAppStore.setState({ workspaces: [firstId, secondId].map((id) => ({ ...workspace, id })) });
    const earlierRead = createDeferred<ReturnType<typeof makeFileEntry>[]>();
    const queuedRead = createDeferred<ReturnType<typeof makeFileEntry>[]>();
    const renderExplorer = async (id: string) => {
      await act(async () => {
        root.render(
          createElement(WorkspaceFileExplorer, { commands: explorerCommands, workspaceId: id }),
        );
        await flushUi();
      });
    };
    try {
      listDirectoryImpl = () => earlierRead.promise;
      await renderExplorer(firstId);
      listDirectoryImpl = async () => [makeFileEntry("intermediate.txt", 1)];
      await renderExplorer(secondId);
      listDirectoryImpl = async () => [makeFileEntry("current.txt", 2)];
      await renderExplorer(firstId);
      expect(container.textContent).toContain("current.txt");
      listDirectoryImpl = () => queuedRead.promise;
      await act(async () => {
        earlierRead.resolve([makeFileEntry("stale.txt", 1)]);
        await flushUi();
      });
      expect(container.textContent).toContain("current.txt");
      expect(container.textContent).not.toContain("stale.txt");
    } finally {
      earlierRead.resolve([]);
      queuedRead.resolve([]);
      await unmountExplorer(root);
      harness.restore();
    }
  });

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

  afterEach(() => {
    useAppStore.setState(originalExplorerActions);
  });

  test.serial("keeps the open file selected when a preview transition is refused", async () => {
    const firstPath = `${rootPath}/README.md`;
    rootEntries.push(makeFileEntry("other.md", 1700000001000));
    useAppStore.setState({ openFilePreview: async () => false });
    const explorer = await mountExplorerForInteraction();
    try {
      await act(async () => {
        useAppStore.getState().selectWorkspaceFile(workspaceId, firstPath);
        useAppStore.setState({ filePreview: { path: firstPath } });
      });
      const target = await explorer.clickEntry("other.md");

      expect(useAppStore.getState().workspaceExplorerById[workspaceId]?.selectedPath).toBe(
        firstPath,
      );
      expect(useAppStore.getState().filePreview?.path).toBe(firstPath);
      expect(target.getAttribute("aria-selected")).toBe("false");
    } finally {
      await explorer.cleanup();
    }
  });

  test.serial("selects only the latest acknowledged preview request", async () => {
    const firstPath = `${rootPath}/README.md`;
    const second = createDeferred<boolean>();
    const third = createDeferred<boolean>();
    rootEntries.push(
      makeFileEntry("second.md", 1700000001000),
      makeFileEntry("third.md", 1700000002000),
    );
    useAppStore.setState({
      openFilePreview: async ({ path }) =>
        path.endsWith("second.md") ? await second.promise : await third.promise,
    });
    const explorer = await mountExplorerForInteraction();
    try {
      await act(async () => {
        useAppStore.getState().selectWorkspaceFile(workspaceId, firstPath);
      });
      await explorer.clickEntry("second.md");
      await explorer.clickEntry("third.md");
      expect(useAppStore.getState().workspaceExplorerById[workspaceId]?.selectedPath).toBe(
        firstPath,
      );

      await act(async () => {
        third.resolve(true);
        await flushUi();
      });
      expect(useAppStore.getState().workspaceExplorerById[workspaceId]?.selectedPath).toBe(
        `${rootPath}/third.md`,
      );
      await act(async () => {
        second.resolve(true);
        await flushUi();
      });
      expect(useAppStore.getState().workspaceExplorerById[workspaceId]?.selectedPath).toBe(
        `${rootPath}/third.md`,
      );
    } finally {
      second.resolve(false);
      third.resolve(false);
      await explorer.cleanup();
    }
  });

  test.serial("shows initial loading and lets a failed directory read be retried", async () => {
    const pendingListing = createDeferred<typeof rootEntries>();
    const slowPath = `${rootPath}/slow-listing`;
    listDirectoryImpl = async () => await pendingListing.promise;
    useAppStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => ({ ...workspace, path: slowPath })),
      workspaceExplorerById: {
        [workspaceId]: {
          ...state.workspaceExplorerById[workspaceId]!,
          rootPath: slowPath,
          currentPath: slowPath,
        },
      },
    }));
    const explorer = await mountExplorerForInteraction();
    try {
      expect(explorer.container.querySelector('[role="status"]')?.textContent).toContain(
        "Loading files",
      );
      await act(async () => {
        pendingListing.reject(new Error("Directory is temporarily unavailable"));
        await flushUi();
      });
      expect(explorer.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Directory is temporarily unavailable",
      );
      listDirectoryImpl = async () => rootEntries;
      const retry = explorer.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Retry loading workspace files"]',
      );
      expect(retry).not.toBeNull();
      await act(async () => {
        retry?.click();
        await flushUi();
      });

      expect(explorer.container.textContent).toContain("README.md");
      expect(explorer.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      pendingListing.resolve([]);
      await explorer.cleanup();
    }
  });

  for (const action of ["open", "reveal", "copy"] as const) {
    test.serial(`reports a failed ${action} action from the file menu`, async () => {
      showContextMenuMock.mockResolvedValueOnce(action);
      const fail = async () => {
        throw new Error("Filesystem action unavailable");
      };
      useAppStore.setState({
        openWorkspaceFile: fail,
        revealWorkspaceFile: fail,
        copyWorkspaceFilePath: fail,
      });
      const explorer = await mountExplorerForInteraction();
      try {
        await act(async () => {
          explorer.container
            .querySelector<HTMLButtonElement>('button[aria-label="More options for README.md"]')
            ?.click();
          await flushUi();
        });

        const notification = useAppStore.getState().notifications.at(-1);
        expect(notification?.kind).toBe("error");
        expect(notification?.detail).toContain("Filesystem action unavailable");
        expect(notification?.audience).toBe("foreground");
      } finally {
        await explorer.cleanup();
      }
    });
  }

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
