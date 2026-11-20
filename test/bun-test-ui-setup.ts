import { mock } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";

import "./helpers/mock-react-native";

const rootRequire = createRequire(path.resolve("package.json"));

// Install a DOM-aware requestAnimationFrame scheduler before any test module
// loads so frames run normally while jsdom is active and drop silently once a
// test tears down its document.
function hasLiveDocument(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== "undefined";
}
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (callback: (time: number) => void): number => {
    if (!hasLiveDocument()) return 0;
    return setTimeout(() => {
      if (hasLiveDocument()) callback(Date.now());
    }, 0) as unknown as number;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
});

function namespaceForMock<T extends Record<string, unknown>>(mod: T): T & { default: T } {
  return { ...mod, default: mod };
}

const sharedReact = namespaceForMock(rootRequire("react") as Record<string, unknown>);
const sharedJsxDevRuntime = namespaceForMock(
  rootRequire("react/jsx-dev-runtime") as Record<string, unknown>,
);
const sharedJsxRuntime = namespaceForMock(
  rootRequire("react/jsx-runtime") as Record<string, unknown>,
);
const sharedReactDom = namespaceForMock(rootRequire("react-dom") as Record<string, unknown>);
const sharedReactDomClient = namespaceForMock(
  rootRequire("react-dom/client") as Record<string, unknown>,
);
const sharedReactDomServer = namespaceForMock(
  rootRequire("react-dom/server") as Record<string, unknown>,
);

// Bun's bare-module test resolver can load one React copy through repo-root
// dependencies and another through workspace-local ReactDOM (apps/mobile).
// Keep React singleton modules aligned with the root React installation.
mock.module("react", () => sharedReact);
mock.module("react/jsx-dev-runtime", () => sharedJsxDevRuntime);
mock.module("react/jsx-runtime", () => sharedJsxRuntime);
mock.module("react-dom", () => sharedReactDom);
mock.module("react-dom/client", () => sharedReactDomClient);
mock.module("react-dom/server", () => sharedReactDomServer);

try {
  const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
  const mobileReactPath = mobileRequire.resolve("react");
  const mobileReactJsxRuntimePath = mobileRequire.resolve("react/jsx-runtime");
  const mobileReactJsxDevRuntimePath = mobileRequire.resolve("react/jsx-dev-runtime");
  const mobileReactDomPath = mobileRequire.resolve("react-dom");
  const mobileReactDomClientPath = mobileRequire.resolve("react-dom/client");
  const mobileReactDomServerPath = mobileRequire.resolve("react-dom/server");

  mock.module(mobileReactPath, () => sharedReact);
  mock.module(mobileReactJsxRuntimePath, () => sharedJsxRuntime);
  mock.module(mobileReactJsxDevRuntimePath, () => sharedJsxDevRuntime);
  mock.module(mobileReactDomPath, () => sharedReactDom);
  mock.module(mobileReactDomClientPath, () => sharedReactDomClient);
  mock.module(mobileReactDomServerPath, () => sharedReactDomServer);
} catch {
  // Mobile workspace deps are not installed in every CI job.
}
