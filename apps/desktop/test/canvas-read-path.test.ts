import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { CanvasDocumentOpenRequest } from "../../../src/shared/canvasDocument";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const { Canvas } = await import("../src/ui/Canvas");

type AppStoreState = ReturnType<typeof useAppStore.getState>;

const DOCUMENT_TEXT = "# Session notes\n\nCapped document read.\n";
const defaultStoreState = useAppStore.getState();

const openCanvasDocumentMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentOpenRequest, "cwd">) => ({
    ok: true as const,
    document: {
      documentId: input.documentId,
      generation: input.generation,
      path: input.path,
      content: DOCUMENT_TEXT,
      truncated: false,
      revision: {
        modifiedAtMs: 1,
        changeTimeMs: 1,
        size: DOCUMENT_TEXT.length,
        fingerprint: `sha256:${DOCUMENT_TEXT}`,
      },
    },
  }),
);
const readCanvasDocumentRevisionMock = mock(async () => {
  throw new Error("revision polling should not run in this test");
});
const saveCanvasDocumentMock = mock(async () => {
  throw new Error("save should not run in this test");
});
const closeCanvasDocumentMock = mock(
  async (_workspaceId: string, input: { documentId: string; generation: number }) => ({
    ok: true as const,
    documentId: input.documentId,
    generation: input.generation,
  }),
);

// Whole-file IPC reads must not be used for Canvas document kinds; track both
// preview and plain read entry points through the sanctioned DesktopApi seam.
const readFileForPreviewMock = mock(async () => {
  throw new Error("readFileForPreview must not be used for Canvas document reads");
});
const readFileMock = mock(async () => {
  throw new Error("readFile must not be used for Canvas document reads");
});

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("Canvas file reads", () => {
  beforeEach(() => {
    openCanvasDocumentMock.mockClear();
    readCanvasDocumentRevisionMock.mockClear();
    saveCanvasDocumentMock.mockClear();
    closeCanvasDocumentMock.mockClear();
    readFileForPreviewMock.mockClear();
    readFileMock.mockClear();
    useAppStore.setState({
      ...defaultStoreState,
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          path: "/Users/mweinbach/Projects/preview-workspace",
          createdAt: "2026-05-16T00:00:00.000Z",
          lastOpenedAt: "2026-05-16T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "thread-1",
      canvasActiveTab: "preview",
      openCanvasDocument: openCanvasDocumentMock,
      readCanvasDocumentRevision: readCanvasDocumentRevisionMock,
      saveCanvasDocument: saveCanvasDocumentMock,
      closeCanvasDocument: closeCanvasDocumentMock,
    } as Partial<AppStoreState> as AppStoreState);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test.serial(
    "opens document kinds through a capped document session, not full-file IPC",
    async () => {
      const desktopApi = createDesktopApiMock({
        readFileForPreview: readFileForPreviewMock,
        readFile: readFileMock,
      });
      const harness = setupJsdom({
        includeAnimationFrame: true,
        extraGlobals: { [DESKTOP_API_OVERRIDE_KEY]: desktopApi },
      });
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root?.render(
            createElement(Canvas, {
              path: "/Users/mweinbach/Projects/preview-workspace/notes.md",
            }),
          );
          await flushUi();
          await flushUi();
        });

        // The document session is the only read path, and it must carry the
        // 256 KiB preview cap so oversized files load a bounded prefix.
        expect(openCanvasDocumentMock).toHaveBeenCalledTimes(1);
        const [workspaceId, openInput] = openCanvasDocumentMock.mock.calls[0] ?? [];
        expect(workspaceId).toBe("ws-1");
        expect(openInput?.path).toBe("/Users/mweinbach/Projects/preview-workspace/notes.md");
        expect(openInput?.maxBytes).toBe(256 * 1024);

        // The capped session result is what actually renders.
        expect(harness.dom.window.document.body.textContent).toContain("Session notes");

        // Document kinds never fall back to whole-file IPC reads.
        expect(readFileForPreviewMock).not.toHaveBeenCalled();
        expect(readFileMock).not.toHaveBeenCalled();
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        harness.restore();
      }
    },
  );
});
