export const DEFAULT_ELECTRON_REMOTE_DEBUG_PORT = "9222";

export function resolveElectronRemoteDebugConfig(options: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}): { enabled: boolean; port: string } {
  if (options.isPackaged) {
    return { enabled: false, port: DEFAULT_ELECTRON_REMOTE_DEBUG_PORT };
  }

  const remoteDebugFlag = options.env.COWORK_ELECTRON_REMOTE_DEBUG?.trim();
  if (remoteDebugFlag === "0") {
    return { enabled: false, port: DEFAULT_ELECTRON_REMOTE_DEBUG_PORT };
  }

  return {
    enabled: true,
    port:
      options.env.COWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() || DEFAULT_ELECTRON_REMOTE_DEBUG_PORT,
  };
}
