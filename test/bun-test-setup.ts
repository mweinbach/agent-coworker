import { mock } from "bun:test";
import "./helpers/mock-react-native";
import path from "node:path";

import * as desktopReact from "../apps/desktop/node_modules/react";
import * as desktopJsxDevRuntime from "../apps/desktop/node_modules/react/jsx-dev-runtime";
import * as desktopJsxRuntime from "../apps/desktop/node_modules/react/jsx-runtime";
import * as desktopReactDom from "../apps/desktop/node_modules/react-dom";
import * as desktopReactDomClient from "../apps/desktop/node_modules/react-dom/client";
import * as desktopReactDomServer from "../apps/desktop/node_modules/react-dom/server";

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

// Also map workspace-local mobile React to the desktop copies to avoid duplicate React instances in tests.
const mobileReactPath = path.resolve("apps/mobile/node_modules/react");
const mobileReactJsxRuntimePath = path.resolve("apps/mobile/node_modules/react/jsx-runtime");
const mobileReactJsxDevRuntimePath = path.resolve("apps/mobile/node_modules/react/jsx-dev-runtime");
const mobileReactDomPath = path.resolve("apps/mobile/node_modules/react-dom");
const mobileReactDomClientPath = path.resolve("apps/mobile/node_modules/react-dom/client");
const mobileReactDomServerPath = path.resolve("apps/mobile/node_modules/react-dom/server");

mock.module(mobileReactPath, () => desktopReact);
mock.module(mobileReactJsxRuntimePath, () => desktopJsxRuntime);
mock.module(mobileReactJsxDevRuntimePath, () => desktopJsxDevRuntime);
mock.module(mobileReactDomPath, () => desktopReactDom);
mock.module(mobileReactDomClientPath, () => desktopReactDomClient);
mock.module(mobileReactDomServerPath, () => desktopReactDomServer);

import { afterEach } from "bun:test";

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
