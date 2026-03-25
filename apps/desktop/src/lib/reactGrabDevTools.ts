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

  try {
    await Promise.all([
      loaders.loadReactGrab(),
      loaders.loadReactGrabMcpClient(),
    ]);
  } catch (error) {
    console.warn("[desktop] React Grab devtools not loaded:", error);
  }
}
