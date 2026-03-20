type ReactGrabDevLoaders = {
  loadReactGrab: () => Promise<unknown>;
  loadReactGrabMcpClient: () => Promise<unknown>;
};

const defaultReactGrabDevLoaders: ReactGrabDevLoaders = {
  loadReactGrab: async () => {
    const moduleId = "react-grab";
    return await import(/* @vite-ignore */ moduleId);
  },
  loadReactGrabMcpClient: async () => {
    const moduleId = "@react-grab/mcp/client";
    return await import(/* @vite-ignore */ moduleId);
  },
};

export async function maybeLoadReactGrabDevTools(
  isDev = import.meta.env.DEV,
  loaders: ReactGrabDevLoaders = defaultReactGrabDevLoaders,
): Promise<void> {
  if (!isDev) return;

  try {
    await Promise.all([
      loaders.loadReactGrab(),
      loaders.loadReactGrabMcpClient(),
    ]);
  } catch (error) {
    console.warn("[desktop] React Grab devtools not loaded:", error);
  }
}
