import { mock } from "bun:test";

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
