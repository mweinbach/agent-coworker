const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

function toMetroChangeEvent(changeEvent) {
  const modifiedFiles = new Map();

  for (const event of changeEvent.eventsQueue ?? []) {
    if (!event || typeof event.filePath !== "string") {
      continue;
    }

    const relativePath = path.relative(projectRoot, event.filePath).split(path.sep).join("/");
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      continue;
    }

    modifiedFiles.set(relativePath, {
      isSymlink: false,
      modifiedTime:
        typeof event.metadata?.modifiedTime === "number" ? event.metadata.modifiedTime : Date.now(),
    });
  }

  return {
    changes: {
      addedFiles: new Map(),
      modifiedFiles,
      removedFiles: new Map(),
    },
    logger: null,
    rootDir: projectRoot,
  };
}

function patchNativewindCssWatcher(metroServer) {
  const bundler = metroServer.getBundler().getBundler();
  const watcher = bundler.getWatcher?.();

  if (!watcher || watcher.__coworkNativewindCssWatcherPatch) {
    return;
  }

  const emit = watcher.emit.bind(watcher);

  watcher.emit = (eventName, payload, ...args) => {
    if (
      eventName === "change" &&
      payload &&
      Array.isArray(payload.eventsQueue) &&
      !payload.changes
    ) {
      return emit(eventName, toMetroChangeEvent(payload));
    }

    return emit(eventName, payload, ...args);
  };

  Object.defineProperty(watcher, "__coworkNativewindCssWatcherPatch", {
    value: true,
  });
}

const nativewindConfig = withNativewind(config, {
  // inline variables break PlatformColor in CSS variables
  inlineVariables: false,
  // We add className support manually
  globalClassNamePolyfill: false,
});

const nativewindEnhanceMiddleware = nativewindConfig.server?.enhanceMiddleware;

nativewindConfig.server = {
  ...nativewindConfig.server,
  enhanceMiddleware(middleware, metroServer) {
    patchNativewindCssWatcher(metroServer);

    return nativewindEnhanceMiddleware
      ? nativewindEnhanceMiddleware(middleware, metroServer)
      : middleware;
  },
};

module.exports = nativewindConfig;
