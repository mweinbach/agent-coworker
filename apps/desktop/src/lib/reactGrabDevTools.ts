type ReactGrabDevLoaders = {
  loadReactGrab: () => Promise<unknown>;
  loadReactGrabMcpClient: () => Promise<unknown>;
};

const defaultReactGrabDevLoaders: ReactGrabDevLoaders = {
  loadReactGrab: async () => await import("react-grab"),
  loadReactGrabMcpClient: async () => await import("@react-grab/mcp/client"),
};

export async function maybeLoadReactGrabDevTools(
  isDev = import.meta.env.DEV,
  loaders: ReactGrabDevLoaders = defaultReactGrabDevLoaders,
): Promise<void> {
  if (!isDev) return;

  await Promise.all([
    loaders.loadReactGrab(),
    loaders.loadReactGrabMcpClient(),
  ]);
}
