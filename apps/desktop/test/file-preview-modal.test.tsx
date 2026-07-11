import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

type PreviewResult = Awaited<
  ReturnType<typeof import("../src/lib/desktopCommands").readFileForPreview>
>;

const PREVIEW_VERSION = {
  modifiedAtMs: 1,
  changeTimeMs: 1,
  size: 0,
  fingerprint: "1:1:0",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let previewResult: PreviewResult = {
  path: "/preview",
  bytes: new Uint8Array(),
  byteLength: 0,
  truncated: false,
  version: PREVIEW_VERSION,
};

const readFileForPreviewMock = mock(async () => previewResult);
const getPreferredFileAppMock = mock(async (opts: { path: string }) =>
  opts.path.endsWith(".docx") ? "Word" : null,
);
const loadDocxPreviewLayoutMock = mock(async () => ({
  accentColor: "#EC6210",
  titleColor: "#1C1B19",
  bodyColor: "#1C1B19",
  mutedColor: "#666666",
  dividerColor: "#FBBA13",
  fontFamily: "Aptos",
  headerImageSrc: "data:image/png;base64,ZmFrZQ==",
  headerImageWidthPx: 180,
  footerText: "Creative Strategies | Intel Pro Day 2026 work document",
}));

mock.module("mammoth", () => ({
  default: {
    convertToHtml: async () => ({ value: "<h1>Docx title</h1><p>Docx body</p>" }),
  },
}));

mock.module("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    getPreferredFileApp: getPreferredFileAppMock,
    readFileForPreview: readFileForPreviewMock,
  }),
);

mock.module("../src/ui/LazyUniverSpreadsheetCanvas", () => ({
  LazyUniverSpreadsheetCanvas: ({ path }: { path: string }) =>
    createElement("div", { "data-cowork-univer-canvas": "true" }, path),
}));

const docxPreviewModule = await import("../src/lib/docxPreview");
spyOn(docxPreviewModule, "loadDocxPreviewLayout").mockImplementation(loadDocxPreviewLayoutMock);

const { useAppStore } = await import("../src/app/store");
const { reactivateWorkspaceJsonRpcSocketState } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");
const { __internalFilePreviewResources, workspaceFileChangeEvents } = await import(
  "../src/lib/filePreviewResource"
);
const { FilePreviewModal, __internalFilePreviewModal } = await import("../src/ui/FilePreviewModal");

function setupPreviewJsdom() {
  return setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: {
      DOMParser: undefined,
    },
    setupWindow: (dom) => {
      (globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;
    },
  });
}

function resetAppStore() {
  const state = useAppStore.getState();
  reactivateWorkspaceJsonRpcSocketState("ws-1");
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.jsonRpcSockets.set("ws-1", {
    readyPromise: Promise.resolve(),
    connect: () => {},
    close: () => {},
    respond: () => true,
    request: async () => ({}),
  } as any);
  useAppStore.setState({
    ...state,
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
    workspaceRuntimeById: {
      ...state.workspaceRuntimeById,
      "ws-1": {
        ...state.workspaceRuntimeById["ws-1"],
        serverUrl: "ws://mock",
      },
    },
    filePreview: null,
  } as any);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function waitForUi(predicate: () => boolean) {
  for (let i = 0; i < 20; i++) {
    await flushUi();
    if (predicate()) return;
  }
  throw new Error("timed out waiting for UI update");
}

afterAll(() => {
  mock.restore();
});

describe("file preview modal", () => {
  beforeEach(() => {
    previewResult = {
      path: "/preview",
      bytes: new Uint8Array(),
      byteLength: 0,
      truncated: false,
      version: PREVIEW_VERSION,
    };
    readFileForPreviewMock.mockClear();
    readFileForPreviewMock.mockImplementation(async () => previewResult);
    getPreferredFileAppMock.mockClear();
    loadDocxPreviewLayoutMock.mockClear();
    __internalFilePreviewResources.clear();
    resetAppStore();
  });

  test.serial("shows the simplified header controls and a constrained markdown shell", async () => {
    const harness = setupPreviewJsdom();

    try {
      const path =
        "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.md";
      previewResult = {
        path,
        bytes: new TextEncoder().encode(
          "# Preview latency review\n\nThis markdown body should render in a narrower reading column.",
        ),
        byteLength: 84,
        truncated: false,
        version: { ...PREVIEW_VERSION, size: 84, fingerprint: "1:1:84" },
      };

      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });

      const doc = harness.dom.window.document;
      const markdownShell = doc.querySelector("[data-file-preview-markdown-shell='true']");
      const description = doc.querySelector("[data-slot='dialog-description']");

      expect(markdownShell?.className).toContain("max-w-[78ch]");
      expect(description?.className).toContain("sr-only");
      expect(description?.textContent).toBe("Markdown preview for preview_latency_review.md");
      expect(doc.body.textContent).toContain("Open");
      expect(doc.body.textContent).not.toContain(path);
      expect(doc.body.textContent).not.toContain("Copy path");
      expect(doc.body.textContent).not.toContain("Reveal");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("uses the preferred app label and renders the richer docx shell", async () => {
    const harness = setupPreviewJsdom();

    try {
      const path =
        "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.docx";
      previewResult = {
        path,
        bytes: new Uint8Array([1, 2, 3, 4]),
        byteLength: 4,
        truncated: false,
        version: { ...PREVIEW_VERSION, size: 4, fingerprint: "1:1:4" },
      };

      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      const footer = doc.querySelector("[data-file-preview-docx-footer='true']");
      const headerImage = doc.querySelector("img[alt='Document header']");
      const docxShell = doc.querySelector(".docx-preview");

      expect(doc.body.textContent).toContain("Open in Word");
      expect(doc.body.textContent).toContain("Docx title");
      expect(footer?.textContent).toContain("Creative Strategies");
      expect(headerImage).not.toBeNull();
      expect(docxShell?.className).toContain("bg-card");
      expect(loadDocxPreviewLayoutMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("keeps clicks inside the popup open and closes from the footer action", async () => {
    const harness = setupPreviewJsdom();

    try {
      const path =
        "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.docx";
      previewResult = {
        path,
        bytes: new Uint8Array([1, 2, 3, 4]),
        byteLength: 4,
        truncated: false,
        version: { ...PREVIEW_VERSION, size: 4, fingerprint: "1:1:4" },
      };

      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
        await flushUi();
      });

      const dialog = harness.dom.window.document.querySelector("[data-slot='dialog-content']");
      const overlay = harness.dom.window.document.querySelector("[data-slot='dialog-overlay']");
      if (!(dialog instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing dialog content shell");
      }
      if (!(overlay instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing dialog overlay");
      }

      await act(async () => {
        dialog.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).not.toBeNull();

      await act(async () => {
        useAppStore.getState().closeFilePreview();
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("opens spreadsheets with the embedded workbook canvas", async () => {
    const harness = setupPreviewJsdom();

    try {
      const path = "/Users/mweinbach/Projects/preview-workspace/model.xlsx";
      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });

      const doc = harness.dom.window.document;
      await waitForUi(() => doc.querySelector("[data-cowork-univer-canvas='true']") !== null);
      expect(readFileForPreviewMock).not.toHaveBeenCalled();
      expect(doc.body.textContent).toContain(path);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("never renders a stale A response under the selected B title", async () => {
    const harness = setupPreviewJsdom();

    try {
      const pathA = "/Users/mweinbach/Projects/preview-workspace/a.md";
      const pathB = "/Users/mweinbach/Projects/preview-workspace/b.md";
      const loadA = deferred<PreviewResult>();
      const loadB = deferred<PreviewResult>();
      readFileForPreviewMock.mockImplementation(async ({ path }) => {
        return await (path === pathA ? loadA.promise : loadB.promise);
      });

      useAppStore.setState({ filePreview: { path: pathA } });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });
      await waitForUi(() => readFileForPreviewMock.mock.calls.length === 1);
      await act(async () => {
        useAppStore.setState({ filePreview: { path: pathB } });
        await flushUi();
      });
      await waitForUi(() => readFileForPreviewMock.mock.calls.length === 2);

      await act(async () => {
        loadB.resolve({
          path: pathB,
          bytes: new TextEncoder().encode("# B content"),
          byteLength: 11,
          truncated: false,
          version: { ...PREVIEW_VERSION, size: 11, fingerprint: "b:11" },
        });
        await flushUi();
      });
      await waitForUi(
        () => harness.dom.window.document.body.textContent?.includes("B content") === true,
      );

      expect(harness.dom.window.document.body.textContent).toContain("b.md");
      expect(harness.dom.window.document.body.textContent).toContain("B content");

      await act(async () => {
        loadA.resolve({
          path: pathA,
          bytes: new TextEncoder().encode("# A stale content"),
          byteLength: 17,
          truncated: false,
          version: { ...PREVIEW_VERSION, size: 17, fingerprint: "a:17" },
        });
        await flushUi();
      });

      expect(harness.dom.window.document.body.textContent).toContain("b.md");
      expect(harness.dom.window.document.body.textContent).toContain("B content");
      expect(harness.dom.window.document.body.textContent).not.toContain("A stale content");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("rerenders a mounted alias when its canonical file changes", async () => {
    const harness = setupPreviewJsdom();

    try {
      const requestedPath = "/Users/mweinbach/Projects/preview-workspace/REPORT.md";
      const canonicalPath = "/Users/mweinbach/Projects/preview-workspace/report.md";
      let content = "# Old canonical content";
      let version = { ...PREVIEW_VERSION, size: content.length, fingerprint: "old" };
      readFileForPreviewMock.mockImplementation(async () => ({
        path: canonicalPath,
        bytes: new TextEncoder().encode(content),
        byteLength: content.length,
        truncated: false,
        version,
      }));
      useAppStore.setState({ filePreview: { path: requestedPath } });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });
      await waitForUi(
        () =>
          harness.dom.window.document.body.textContent?.includes("Old canonical content") === true,
      );
      const initialReadCount = readFileForPreviewMock.mock.calls.length;

      content = "# New canonical content";
      version = { ...PREVIEW_VERSION, modifiedAtMs: 2, size: content.length, fingerprint: "new" };
      await act(async () => {
        workspaceFileChangeEvents.publish({
          kind: "changed",
          path: canonicalPath,
          version,
        });
        await flushUi();
      });
      expect(workspaceFileChangeEvents.getRevision(requestedPath)).toBe(1);
      await waitForUi(() => readFileForPreviewMock.mock.calls.length === initialReadCount + 1);
      await waitForUi(
        () =>
          harness.dom.window.document.body.textContent?.includes("New canonical content") === true,
      );

      expect(readFileForPreviewMock).toHaveBeenCalledTimes(2);
      expect(harness.dom.window.document.body.textContent).not.toContain("Old canonical content");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("does not load a hidden modal preview when Canvas owns the path", async () => {
    const harness = setupPreviewJsdom();

    try {
      useAppStore.setState((state) => ({
        desktopFeatureFlags: { ...state.desktopFeatureFlags, canvas: true },
        filePreview: { path: "/Users/mweinbach/Projects/preview-workspace/canvas.md" },
      }));
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });

      expect(readFileForPreviewMock).not.toHaveBeenCalled();
      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});

describe("file preview Windows paths", () => {
  function localPathFromCoworkFileUrl(rawUrl: string): string | null {
    return new URL(rawUrl).searchParams.get("path");
  }

  test("resolves relative markdown links against Windows drive paths", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "C:\\Users\\Max\\Documents\\notes\\readme.md",
        "../assets/figure one.png",
      ),
    ).toBe("C:\\Users\\Max\\Documents\\assets\\figure one.png");
  });

  test("resolves parent segments without escaping a Windows drive root", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath("C:\\readme.md", "../../etc/config.txt"),
    ).toBe("C:\\etc\\config.txt");
  });

  test("resolves mixed separators and dot segments", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "C:/Users/Max/Documents/notes/readme.md",
        "..\\./assets//diagram.png",
      ),
    ).toBe("C:/Users/Max/Documents/assets/diagram.png");
  });

  test("keeps POSIX absolute paths stable", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath("/home/max/docs/readme.md", "../assets/a.png"),
    ).toBe("/home/max/assets/a.png");
  });

  test("resolves relative markdown links against UNC paths", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "\\\\server\\share\\docs\\readme.md",
        "images/diagram.png",
      ),
    ).toBe("\\\\server\\share\\docs\\images\\diagram.png");
  });

  test("normalizes forward-slash UNC paths to Windows UNC paths", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "//server/share/docs/readme.md",
        "images/diagram.png",
      ),
    ).toBe("\\\\server\\share\\docs\\images\\diagram.png");
  });

  test("extracts basenames from desktop paths", () => {
    expect(__internalFilePreviewModal.basenamePath("C:\\Users\\Max\\notes\\readme.md")).toBe(
      "readme.md",
    );
    expect(__internalFilePreviewModal.basenamePath("C:\\Users\\Max\\notes\\")).toBe("notes");
    expect(__internalFilePreviewModal.basenamePath("\\\\server\\share\\docs\\readme.md")).toBe(
      "readme.md",
    );
  });

  test("rewrites Windows and UNC file URLs without dropping the host or drive", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "link",
          url: "file:///C:/Users/Max/Documents/readme.md",
          children: [],
        },
        {
          type: "link",
          url: "file://server/share/docs/readme.md",
          children: [],
        },
      ],
    };

    __internalFilePreviewModal.createRemarkResolveRelativeLinks(
      "C:\\Users\\Max\\Documents\\preview.md",
    )()(tree);

    expect(localPathFromCoworkFileUrl(tree.children[0].url)).toBe(
      "C:\\Users\\Max\\Documents\\readme.md",
    );
    expect(localPathFromCoworkFileUrl(tree.children[1].url)).toBe(
      "\\\\server\\share\\docs\\readme.md",
    );
  });

  test("rewrites relative links with URL-special path characters", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "link",
          url: "assets/figure & 1.png",
          children: [],
        },
      ],
    };

    __internalFilePreviewModal.createRemarkResolveRelativeLinks("C:\\Users\\Max\\preview.md")()(
      tree,
    );

    expect(localPathFromCoworkFileUrl(tree.children[0].url)).toBe(
      "C:\\Users\\Max\\assets\\figure & 1.png",
    );
  });
});
