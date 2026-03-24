import { JSDOM } from "jsdom";

type JsdomGlobalKey =
  | "window"
  | "document"
  | "navigator"
  | "HTMLElement"
  | "HTMLButtonElement"
  | "HTMLInputElement"
  | "HTMLTextAreaElement"
  | "HTMLSelectElement"
  | "Image"
  | "MutationObserver"
  | "SVGElement"
  | "Node"
  | "getComputedStyle"
  | "requestAnimationFrame"
  | "cancelAnimationFrame";

type SavedGlobalDescriptor = {
  key: JsdomGlobalKey | "IS_REACT_ACT_ENVIRONMENT" | (string & {});
  descriptor?: PropertyDescriptor;
};

export type JsdomHarness = {
  dom: JSDOM;
  restore: () => void;
};

export type SetupJsdomOptions = {
  includeAnimationFrame?:
    | boolean
    | {
        requestAnimationFrame?: (callback: FrameRequestCallback) => number;
        cancelAnimationFrame?: (handle: number) => void;
      };
  extraGlobals?: Record<string, unknown>;
  setupWindow?: (dom: JSDOM) => void;
};

function setGlobalProperty(key: SavedGlobalDescriptor["key"], value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobalProperty({ key, descriptor }: SavedGlobalDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

export function setupJsdom(options: SetupJsdomOptions = {}): JsdomHarness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const saved: SavedGlobalDescriptor[] = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Image",
    "MutationObserver",
    "SVGElement",
    "Node",
    "getComputedStyle",
    "IS_REACT_ACT_ENVIRONMENT",
  ].map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  }));

  setGlobalProperty("window", dom.window);
  setGlobalProperty("document", dom.window.document);
  setGlobalProperty("navigator", dom.window.navigator);
  setGlobalProperty("HTMLElement", dom.window.HTMLElement);
  setGlobalProperty("HTMLButtonElement", dom.window.HTMLButtonElement);
  setGlobalProperty("HTMLInputElement", dom.window.HTMLInputElement);
  setGlobalProperty("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  setGlobalProperty("HTMLSelectElement", dom.window.HTMLSelectElement);
  setGlobalProperty("Image", dom.window.Image);
  setGlobalProperty("MutationObserver", dom.window.MutationObserver);
  setGlobalProperty("SVGElement", dom.window.SVGElement);
  setGlobalProperty("Node", dom.window.Node);
  setGlobalProperty("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));

  if (options.includeAnimationFrame) {
    const requestAnimationFrame =
      typeof options.includeAnimationFrame === "object" && options.includeAnimationFrame.requestAnimationFrame
        ? options.includeAnimationFrame.requestAnimationFrame
        : dom.window.requestAnimationFrame?.bind(dom.window) ??
          ((callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0));
    const cancelAnimationFrame =
      typeof options.includeAnimationFrame === "object" && options.includeAnimationFrame.cancelAnimationFrame
        ? options.includeAnimationFrame.cancelAnimationFrame
        : dom.window.cancelAnimationFrame?.bind(dom.window) ??
          ((handle: number) => dom.window.clearTimeout(handle));

    saved.push(
      {
        key: "requestAnimationFrame",
        descriptor: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
      },
      {
        key: "cancelAnimationFrame",
        descriptor: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
      },
    );

    setGlobalProperty("requestAnimationFrame", requestAnimationFrame);
    setGlobalProperty("cancelAnimationFrame", cancelAnimationFrame);
    dom.window.requestAnimationFrame = requestAnimationFrame;
    dom.window.cancelAnimationFrame = cancelAnimationFrame;
  }

  if (options.extraGlobals) {
    for (const [key, value] of Object.entries(options.extraGlobals)) {
      saved.push({
        key,
        descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
      });
      setGlobalProperty(key, value);
    }
  }

  setGlobalProperty("IS_REACT_ACT_ENVIRONMENT", true);
  options.setupWindow?.(dom);

  return {
    dom,
    restore: () => {
      for (const entry of saved.reverse()) {
        restoreGlobalProperty(entry);
      }
      dom.window.close();
    },
  };
}
