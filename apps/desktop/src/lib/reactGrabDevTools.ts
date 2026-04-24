type ReactGrabDevLoaders = {
  loadReactGrab: () => Promise<unknown>;
  loadReactGrabMcpClient: () => Promise<unknown>;
};

const defaultReactGrabDevLoaders: ReactGrabDevLoaders = {
  loadReactGrab: async () => await import("react-grab"),
  loadReactGrabMcpClient: async () => await import("@react-grab/mcp/client"),
};

export function shouldLoadReactGrabDevTools(
  isDev = import.meta.env.DEV,
  userAgent = typeof navigator === "object" ? navigator.userAgent : "",
): boolean {
  if (!isDev) {
    return false;
  }

  return !(userAgent.includes("Electron") && userAgent.includes("Linux"));
}

export async function maybeLoadReactGrabDevTools(
  isDev = import.meta.env.DEV,
  loaders: ReactGrabDevLoaders = defaultReactGrabDevLoaders,
  userAgent = typeof navigator === "object" ? navigator.userAgent : "",
): Promise<void> {
  if (!shouldLoadReactGrabDevTools(isDev, userAgent)) return;

  await Promise.all([loaders.loadReactGrab(), loaders.loadReactGrabMcpClient()]);
}
