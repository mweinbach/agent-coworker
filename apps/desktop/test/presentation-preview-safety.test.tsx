import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { PresentationPreviewResult } from "../../../src/server/presentationPreview";
import { useAppStore } from "../src/app/store";
import {
  __internalFilePreviewResources,
  workspaceFileChangeEvents,
} from "../src/lib/filePreviewResource";
import { PptxPreview } from "../src/ui/PptxPreview";
import { SlidePreview } from "../src/ui/SlidePreview";
import { setupJsdom } from "./jsdomHarness";

class PresentationResizeObserver {
  static callbacks = new Set<ResizeObserverCallback>();
  static width = 480;
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    PresentationResizeObserver.callbacks.add(callback);
  }

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: PresentationResizeObserver.width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {
    PresentationResizeObserver.callbacks.delete(this.callback);
  }

  unobserve() {}

  static trigger(target: Element, width: number) {
    PresentationResizeObserver.width = width;
    for (const callback of PresentationResizeObserver.callbacks) {
      callback([{ target, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function presentation(
  path: string,
  title: string,
  pngBase64: string,
  dependencies: string[] = [path],
): PresentationPreviewResult {
  return {
    ok: true,
    dependencies,
    path,
    slides: [{ slideIndex: 0, title, pngBase64 }],
    version: {
      modifiedAtMs: title === "A" ? 1 : 2,
      changeTimeMs: title === "A" ? 1 : 2,
      size: 10,
      fingerprint: `${title}:10`,
    },
  };
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function waitForUi(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushUi();
    if (predicate()) return;
  }
  throw new Error("timed out waiting for presentation preview");
}

function configurePresentationStore(
  loader: (path: string) => Promise<PresentationPreviewResult>,
): void {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    selectedWorkspaceId: "workspace-1",
    workspaces: [
      {
        id: "workspace-1",
        name: "Workspace",
        path: "/workspace",
        createdAt: "2026-07-11T00:00:00.000Z",
        lastOpenedAt: "2026-07-11T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    loadPresentationPreview: loader,
  });
}

describe("presentation preview path safety", () => {
  test.serial("PptxPreview adapts to its container without losing the active slide", async () => {
    const harness = setupJsdom({
      extraGlobals: { ResizeObserver: PresentationResizeObserver },
    });
    __internalFilePreviewResources.clear();
    const deckPath = "/workspace/adaptive.pptx";
    const loader = mock(
      async (): Promise<PresentationPreviewResult> => ({
        ok: true,
        dependencies: [deckPath],
        path: deckPath,
        slides: [
          { slideIndex: 0, title: "First", pngBase64: "data:image/png;base64,QQ==" },
          { slideIndex: 1, title: "Second", pngBase64: "data:image/png;base64,Qg==" },
        ],
        version: {
          modifiedAtMs: 1,
          changeTimeMs: 1,
          size: 20,
          fingerprint: "adaptive:20",
        },
      }),
    );
    configurePresentationStore(loader);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(PptxPreview, { path: deckPath }));
        await flushUi();
      });
      await waitForUi(() => container.textContent?.includes("Second") === true);

      const preview = container.querySelector<HTMLElement>("[data-presentation-layout]");
      expect(preview?.dataset.presentationLayout).toBe("compact");
      expect(container.querySelector('button[aria-label="Refresh presentation"]')).not.toBeNull();

      const secondThumbnail = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Second"),
      );
      await act(async () => secondThumbnail?.click());
      expect(container.querySelector('img[alt="Second"]')).not.toBeNull();

      await act(async () => {
        if (preview) PresentationResizeObserver.trigger(preview, 700);
      });
      expect(preview?.dataset.presentationLayout).toBe("full");
      expect(container.querySelector('img[alt="Second"]')).not.toBeNull();

      await act(async () => root.unmount());
    } finally {
      PresentationResizeObserver.callbacks.clear();
      PresentationResizeObserver.width = 480;
      harness.restore();
    }
  });

  test.serial("SlidePreview ignores an A completion after switching to B", async () => {
    const harness = setupJsdom();
    __internalFilePreviewResources.clear();
    const pathA = "/workspace/a.mjs";
    const pathB = "/workspace/b.mjs";
    const loadA = deferred<PresentationPreviewResult>();
    const loadB = deferred<PresentationPreviewResult>();
    const loader = mock(
      async (path: string) => await (path === pathA ? loadA.promise : loadB.promise),
    );
    configurePresentationStore(loader);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(SlidePreview, { path: pathA }));
        await flushUi();
      });
      await waitForUi(() => loader.mock.calls.length === 1);
      await act(async () => {
        root.render(createElement(SlidePreview, { path: pathB }));
        await flushUi();
      });
      await waitForUi(() => loader.mock.calls.length === 2);

      await act(async () => {
        loadB.resolve(presentation(pathB, "B", "data:image/png;base64,Qg=="));
        await flushUi();
      });
      await waitForUi(
        () =>
          harness.dom.window.document
            .querySelector("img[alt='Slide preview']")
            ?.getAttribute("src") === "data:image/png;base64,Qg==",
      );
      await act(async () => {
        loadA.resolve(presentation(pathA, "A", "data:image/png;base64,QQ=="));
        await flushUi();
      });

      expect(
        harness.dom.window.document.querySelector("img[alt='Slide preview']")?.getAttribute("src"),
      ).toBe("data:image/png;base64,Qg==");
      expect(harness.dom.window.document.body.textContent).toContain("b.mjs");
      expect(harness.dom.window.document.body.textContent).not.toContain("a.mjs");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("PptxPreview ignores an A completion after switching to B", async () => {
    const harness = setupJsdom();
    __internalFilePreviewResources.clear();
    const pathA = "/workspace/a.pptx";
    const pathB = "/workspace/b.pptx";
    const loadA = deferred<PresentationPreviewResult>();
    const loadB = deferred<PresentationPreviewResult>();
    const loader = mock(
      async (path: string) => await (path === pathA ? loadA.promise : loadB.promise),
    );
    configurePresentationStore(loader);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(PptxPreview, { path: pathA }));
        await flushUi();
      });
      await waitForUi(() => loader.mock.calls.length === 1);
      await act(async () => {
        root.render(createElement(PptxPreview, { path: pathB }));
        await flushUi();
      });
      await waitForUi(() => loader.mock.calls.length === 2);

      await act(async () => {
        loadB.resolve(presentation(pathB, "B", "data:image/png;base64,Qg=="));
        await flushUi();
      });
      await waitForUi(() => harness.dom.window.document.querySelectorAll("img").length > 0);
      await act(async () => {
        loadA.resolve(presentation(pathA, "A", "data:image/png;base64,QQ=="));
        await flushUi();
      });

      const sources = [...harness.dom.window.document.querySelectorAll("img")].map((image) =>
        image.getAttribute("src"),
      );
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.every((source) => source === "data:image/png;base64,Qg==")).toBe(true);
      expect(harness.dom.window.document.body.textContent).toContain("b.pptx");
      expect(harness.dom.window.document.body.textContent).not.toContain("a.pptx");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("PptxPreview reloads when a rendered dependency changes", async () => {
    const harness = setupJsdom();
    __internalFilePreviewResources.clear();
    const deckPath = "/workspace/deck.pptx";
    const pngPath = "/workspace/preview/slide-1.png";
    let title = "First dependency";
    const loader = mock(async () =>
      presentation(deckPath, title, `data:image/png;base64,${title}`, [deckPath, pngPath]),
    );
    configurePresentationStore(loader);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(PptxPreview, { path: deckPath }));
        await flushUi();
      });
      await waitForUi(
        () => harness.dom.window.document.body.textContent?.includes("First dependency") === true,
      );

      title = "Updated dependency";
      await act(async () => {
        workspaceFileChangeEvents.publish({
          kind: "changed",
          path: pngPath,
          version: {
            modifiedAtMs: 3,
            changeTimeMs: 3,
            size: 20,
            fingerprint: "dependency:3",
          },
        });
        await flushUi();
      });
      await waitForUi(
        () => harness.dom.window.document.body.textContent?.includes("Updated dependency") === true,
      );

      expect(loader).toHaveBeenCalledTimes(2);
      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
