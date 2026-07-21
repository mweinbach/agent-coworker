import { JSDOM } from "jsdom";

type JsdomGlobalKey =
  | "window"
  | "document"
  | "navigator"
  | "CSS"
  | "HTMLElement"
  | "Element"
  | "HTMLButtonElement"
  | "HTMLFormElement"
  | "HTMLInputElement"
  | "HTMLTextAreaElement"
  | "HTMLSelectElement"
  | "Image"
  | "MutationObserver"
  | "ResizeObserver"
  | "NodeFilter"
  | "SVGElement"
  | "Node"
  | "DocumentFragment"
  | "Event"
  | "CustomEvent"
  | "KeyboardEvent"
  | "MouseEvent"
  | "PointerEvent"
  | "getComputedStyle"
  | "setTimeout"
  | "clearTimeout"
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
  if (key === "window") {
    delete (globalThis as any).window;
    return;
  }
  if (key === "requestAnimationFrame") {
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      globalThis.setTimeout(() => cb(Date.now()), 0) as any;
    return;
  }
  if (key === "cancelAnimationFrame") {
    (globalThis as any).cancelAnimationFrame = (handle: number) =>
      globalThis.clearTimeout(handle as any);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

function cssEscape(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

export function setupJsdom(options: SetupJsdomOptions = {}): JsdomHarness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const cssShim = { escape: cssEscape };
  const saved: SavedGlobalDescriptor[] = [
    "window",
    "document",
    "navigator",
    "CSS",
    "HTMLElement",
    "Element",
    "HTMLButtonElement",
    "HTMLFormElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Image",
    "MutationObserver",
    "ResizeObserver",
    "NodeFilter",
    "SVGElement",
    "Node",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "getComputedStyle",
    "setTimeout",
    "clearTimeout",
    "localStorage",
    "sessionStorage",
    "IS_REACT_ACT_ENVIRONMENT",
  ].map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  }));

  setGlobalProperty("window", dom.window);
  setGlobalProperty("document", dom.window.document);
  setGlobalProperty("navigator", dom.window.navigator);
  setGlobalProperty("localStorage", dom.window.localStorage);
  setGlobalProperty("sessionStorage", dom.window.sessionStorage);
  if (typeof dom.window.HTMLElement.prototype.attachEvent !== "function") {
    Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
  if (typeof dom.window.HTMLElement.prototype.detachEvent !== "function") {
    Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
  if (typeof dom.window.HTMLElement.prototype.hasPointerCapture !== "function") {
    Object.defineProperty(dom.window.HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      writable: true,
      value: () => false,
    });
  }
  if (typeof dom.window.HTMLElement.prototype.setPointerCapture !== "function") {
    Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
  if (typeof dom.window.HTMLElement.prototype.releasePointerCapture !== "function") {
    Object.defineProperty(dom.window.HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
  if (typeof dom.window.HTMLElement.prototype.scrollIntoView !== "function") {
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }

  setGlobalProperty("HTMLElement", dom.window.HTMLElement);
  setGlobalProperty("Element", dom.window.Element);
  setGlobalProperty("HTMLButtonElement", dom.window.HTMLButtonElement);
  setGlobalProperty("HTMLFormElement", dom.window.HTMLFormElement);
  setGlobalProperty("HTMLInputElement", dom.window.HTMLInputElement);
  setGlobalProperty("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  setGlobalProperty("HTMLSelectElement", dom.window.HTMLSelectElement);
  setGlobalProperty("Image", dom.window.Image);
  setGlobalProperty("MutationObserver", dom.window.MutationObserver);
  setGlobalProperty(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(dom.window, "CSS", {
    configurable: true,
    writable: true,
    value: dom.window.CSS ?? cssShim,
  });
  setGlobalProperty("CSS", dom.window.CSS ?? cssShim);
  setGlobalProperty("NodeFilter", dom.window.NodeFilter);
  setGlobalProperty("SVGElement", dom.window.SVGElement);
  setGlobalProperty("Node", dom.window.Node);
  setGlobalProperty("DocumentFragment", dom.window.DocumentFragment);
  setGlobalProperty("Event", dom.window.Event);
  setGlobalProperty("CustomEvent", dom.window.CustomEvent);
  setGlobalProperty("KeyboardEvent", dom.window.KeyboardEvent);
  setGlobalProperty("MouseEvent", dom.window.MouseEvent);
  setGlobalProperty("PointerEvent", dom.window.PointerEvent);
  setGlobalProperty("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));

  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const activeTimeouts = new Set<ReturnType<typeof globalThis.setTimeout>>();
  const activeAnimationFrames = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
  let nextAnimationFrameId = 1;

  const runWithCurrentDomGlobals = (callback: () => void) => {
    const previous = {
      window: Object.getOwnPropertyDescriptor(globalThis, "window"),
      document: Object.getOwnPropertyDescriptor(globalThis, "document"),
      Event: Object.getOwnPropertyDescriptor(globalThis, "Event"),
      CustomEvent: Object.getOwnPropertyDescriptor(globalThis, "CustomEvent"),
    };
    setGlobalProperty("window", dom.window);
    setGlobalProperty("document", dom.window.document);
    setGlobalProperty("Event", dom.window.Event);
    setGlobalProperty("CustomEvent", dom.window.CustomEvent);
    try {
      callback();
    } finally {
      restoreGlobalProperty({ key: "window", descriptor: previous.window });
      restoreGlobalProperty({ key: "document", descriptor: previous.document });
      restoreGlobalProperty({ key: "Event", descriptor: previous.Event });
      restoreGlobalProperty({ key: "CustomEvent", descriptor: previous.CustomEvent });
    }
  };

  const customSetTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timeoutId = nativeSetTimeout(() => {
      activeTimeouts.delete(timeoutId);
      if (typeof handler === "function") {
        runWithCurrentDomGlobals(() => handler(...args));
        return;
      }
      nativeSetTimeout(handler, 0);
    }, timeout);
    activeTimeouts.add(timeoutId);
    return timeoutId;
  };
  const customClearTimeout = (timeoutId: ReturnType<typeof globalThis.setTimeout>) => {
    activeTimeouts.delete(timeoutId);
    nativeClearTimeout(timeoutId);
  };

  setGlobalProperty("setTimeout", customSetTimeout);
  setGlobalProperty("clearTimeout", customClearTimeout);
  dom.window.setTimeout = customSetTimeout as any;
  dom.window.clearTimeout = customClearTimeout as any;

  const requestAnimationFrame =
    typeof options.includeAnimationFrame === "object" &&
    options.includeAnimationFrame.requestAnimationFrame
      ? options.includeAnimationFrame.requestAnimationFrame
      : (dom.window.requestAnimationFrame?.bind(dom.window) ??
        ((callback: FrameRequestCallback) => {
          const id = nextAnimationFrameId++;
          const timer = nativeSetTimeout(() => {
            activeAnimationFrames.delete(id);
            runWithCurrentDomGlobals(() => callback(Date.now()));
          }, 0);
          activeAnimationFrames.set(id, timer);
          return id;
        }));
  const cancelAnimationFrame =
    typeof options.includeAnimationFrame === "object" &&
    options.includeAnimationFrame.cancelAnimationFrame
      ? options.includeAnimationFrame.cancelAnimationFrame
      : (dom.window.cancelAnimationFrame?.bind(dom.window) ??
        ((handle: number) => {
          const timer = activeAnimationFrames.get(handle);
          if (timer !== undefined) {
            activeAnimationFrames.delete(handle);
            nativeClearTimeout(timer);
          }
        }));

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
      for (const timeoutId of activeTimeouts) {
        nativeClearTimeout(timeoutId);
      }
      activeTimeouts.clear();
      for (const timer of activeAnimationFrames.values()) {
        nativeClearTimeout(timer);
      }
      activeAnimationFrames.clear();
      for (const entry of saved.reverse()) {
        restoreGlobalProperty(entry);
      }
      dom.window.close();
    },
  };
}
