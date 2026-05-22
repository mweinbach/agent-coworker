import { afterEach, mock } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";

import "./helpers/mock-react-native";

const desktopRequire = createRequire(path.resolve("apps/desktop/package.json"));

function namespaceForMock<T extends Record<string, unknown>>(mod: T): T & { default: T } {
  return { ...mod, default: mod };
}

const desktopReact = namespaceForMock(desktopRequire("react") as Record<string, unknown>);
const desktopJsxDevRuntime = namespaceForMock(
  desktopRequire("react/jsx-dev-runtime") as Record<string, unknown>,
);
const desktopJsxRuntime = namespaceForMock(
  desktopRequire("react/jsx-runtime") as Record<string, unknown>,
);
const desktopReactDom = namespaceForMock(desktopRequire("react-dom") as Record<string, unknown>);
const desktopReactDomClient = namespaceForMock(
  desktopRequire("react-dom/client") as Record<string, unknown>,
);
const desktopReactDomServer = namespaceForMock(
  desktopRequire("react-dom/server") as Record<string, unknown>,
);

// Bun's bare-module test resolver can load one React copy through repo-root
// transitive dependencies (for example `radix-ui`) and another through the
// desktop workspace's ReactDOM. Keep React singleton modules aligned with the
// desktop renderer, matching electron-vite's `resolve.dedupe` behavior.
mock.module("react", () => desktopReact);
mock.module("react/jsx-dev-runtime", () => desktopJsxDevRuntime);
mock.module("react/jsx-runtime", () => desktopJsxRuntime);
mock.module("react-dom", () => desktopReactDom);
mock.module("react-dom/client", () => desktopReactDomClient);
mock.module("react-dom/server", () => desktopReactDomServer);

try {
  const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
  const mobileReactPath = mobileRequire.resolve("react");
  const mobileReactJsxRuntimePath = mobileRequire.resolve("react/jsx-runtime");
  const mobileReactJsxDevRuntimePath = mobileRequire.resolve("react/jsx-dev-runtime");
  const mobileReactDomPath = mobileRequire.resolve("react-dom");
  const mobileReactDomClientPath = mobileRequire.resolve("react-dom/client");
  const mobileReactDomServerPath = mobileRequire.resolve("react-dom/server");

  mock.module(mobileReactPath, () => desktopReact);
  mock.module(mobileReactJsxRuntimePath, () => desktopJsxRuntime);
  mock.module(mobileReactJsxDevRuntimePath, () => desktopJsxDevRuntime);
  mock.module(mobileReactDomPath, () => desktopReactDom);
  mock.module(mobileReactDomClientPath, () => desktopReactDomClient);
  mock.module(mobileReactDomServerPath, () => desktopReactDomServer);
} catch {
  // Mobile workspace deps are not installed in every CI job.
}

afterEach(() => {
  try {
    const storePath = require.resolve("../apps/desktop/src/app/store");
    if (require.cache[storePath]) {
      const { useAppStore } = require.cache[storePath]!.exports;
      if (useAppStore && typeof (useAppStore as any).clearAllListeners === "function") {
        (useAppStore as any).clearAllListeners();
      }
    }
  } catch {}
});
