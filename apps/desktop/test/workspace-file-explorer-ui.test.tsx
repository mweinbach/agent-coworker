import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
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

let rootEntries = [makeFileEntry("README.md", 1700000000000)];
let listDirectoryImpl = async ({ path }: { path: string }) => {
  if (path === rootPath) return rootEntries;
  return [];
};

const listDirectoryMock = mock(async (args: { path: string }) => listDirectoryImpl(args));

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    listDirectory: listDirectoryMock,
  }),
);

const { useAppStore } = await import("../src/app/store");
const { WorkspaceFileExplorer } = await import("../src/ui/file-explorer/WorkspaceFileExplorer");

function resetAppStore() {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    ready: true,
    bootstrapPending: false,
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

describe("workspace file explorer UI", () => {
  beforeEach(() => {
    rootEntries = [makeFileEntry("README.md", 1700000000000)];
    listDirectoryImpl = async ({ path }: { path: string }) => {
      if (path === rootPath) return rootEntries;
      return [];
    };
    listDirectoryMock.mockClear();
    resetAppStore();
  });

  test.serial("refreshes the rendered tree when the workspace refresh signal changes", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: true,
      extraGlobals: { ResizeObserver: MockResizeObserver },
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(WorkspaceFileExplorer, { workspaceId }));
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

      await act(async () => {
        root.unmount();
      });
    } finally {
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

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const root = createRoot(container);

        await act(async () => {
          root.render(createElement(WorkspaceFileExplorer, { workspaceId }));
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

        await act(async () => {
          root.unmount();
        });
      } finally {
        harness.restore();
      }
    },
  );
});
