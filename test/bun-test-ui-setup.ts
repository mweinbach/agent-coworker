import { afterEach, mock } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";

import "./helpers/mock-react-native";
import { setupJsdom } from "../apps/desktop/test/jsdomHarness";

const desktopRequire = createRequire(path.resolve("apps/desktop/package.json"));

// Animation libraries capture `requestAnimationFrame` once, when their module is
// first evaluated — which happens during a test file's top-level imports, before
// any jsdom exists. motion-dom then keeps its frameloop re-scheduling across
// unmounts, so a frame queued by one test file runs during the next one and
// throws `document is not defined` from inside a projection node. Install a
// DOM-aware scheduler before any test module loads: it animates normally while a
// jsdom is installed and drops frames when there is nothing to render into.
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

// framer-motion's layout animations (`layout`, `layoutId`) register projection
// nodes on a process-global document root whose frameloop keeps re-scheduling
// after a test unmounts. Under jsdom that root then measures a document which
// the next test file has already torn down, so an unrelated test fails with
// `document is not defined` depending only on cumulative timing. Nothing in the
// suite asserts animation behavior — the tests assert rendered DOM — so render
// motion elements as their plain intrinsic tags and keep the projection tree
// out of the process entirely.
const MOTION_ONLY_PROPS = new Set([
  "animate",
  "as",
  "axis",
  "custom",
  "drag",
  "dragConstraints",
  "dragControls",
  "dragElastic",
  "dragListener",
  "dragMomentum",
  "exit",
  "initial",
  "layout",
  "layoutDependency",
  "layoutId",
  "layoutRoot",
  "layoutScroll",
  "onAnimationComplete",
  "onDrag",
  "onDragEnd",
  "onDragStart",
  "onLayoutAnimationComplete",
  "onLayoutAnimationStart",
  "onReorder",
  "transition",
  "value",
  "values",
  "variants",
  "whileDrag",
  "whileFocus",
  "whileHover",
  "whileInView",
  "whileTap",
]);

function stripMotionProps(props: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!MOTION_ONLY_PROPS.has(key)) next[key] = value;
  }
  return next;
}

function createFramerMotionStub() {
  const react = desktopReact as unknown as typeof import("react");
  const forwardTag = (tag: string) =>
    react.forwardRef(function MotionStub(
      { children, ...props }: Record<string, unknown> & { children?: unknown },
      ref: unknown,
    ) {
      return react.createElement(
        tag,
        { ...stripMotionProps(props), ref } as never,
        children as never,
      );
    });
  const motionCache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get(_target, tag: string) {
        if (!motionCache.has(tag)) motionCache.set(tag, forwardTag(tag));
        return motionCache.get(tag);
      },
    },
  );
  // Reorder renders whatever `as` names (the sidebar uses `as="div"`), so the
  // stub has to honor it or it changes the DOM shape tests assert against.
  const forwardPolymorphic = (defaultTag: string) =>
    react.forwardRef(function ReorderStub(
      { children, ...props }: Record<string, unknown> & { children?: unknown },
      ref: unknown,
    ) {
      const tag = typeof props.as === "string" ? props.as : defaultTag;
      return react.createElement(
        tag,
        { ...stripMotionProps(props), ref } as never,
        children as never,
      );
    });
  const Reorder = {
    Group: forwardPolymorphic("ul"),
    Item: forwardPolymorphic("li"),
  };
  const namespace = {
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
    LayoutGroup: ({ children }: { children?: unknown }) => children ?? null,
    MotionConfig: ({ children }: { children?: unknown }) => children ?? null,
    Reorder,
    motion,
    useDragControls: () => ({ start: () => {} }),
    useReducedMotion: () => true,
  };
  return { ...namespace, default: namespace };
}

// The desktop workspace resolves framer-motion to its own copy, and the bare
// specifier alone does not intercept it. `require.resolve` is also the wrong
// key here: it returns the CJS entry (dist/cjs/index.js) while the components
// import the ESM one (dist/es/index.mjs), so the mock has to be keyed by the
// module-condition resolution Bun actually uses.
const desktopDir = path.resolve("apps/desktop");
mock.module("framer-motion", createFramerMotionStub);
for (const specifier of ["framer-motion", "motion/react"]) {
  for (const resolve of [
    () => Bun.resolveSync(specifier, desktopDir),
    () => desktopRequire.resolve(specifier),
  ]) {
    try {
      mock.module(resolve(), createFramerMotionStub);
    } catch {
      // Not every motion entry point is installed in every workspace.
    }
  }
}

// Radix selects its layout-effect implementation when its modules are first
// evaluated. The desktop suite otherwise imports Radix nondeterministically:
// whichever test reaches it first decides whether dialogs can mount portals
// for every later test in the same Bun process. Initialize it once with a DOM,
// matching the renderer environment, before test-file imports begin.
const radixImportHarness = setupJsdom();
try {
  await import("radix-ui");
} finally {
  radixImportHarness.restore();
}

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
