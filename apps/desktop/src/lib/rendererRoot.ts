import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export type RendererHotModule = {
  data: Record<string, unknown>;
  dispose: (callback: (data: Record<string, unknown>) => void) => void;
};

export function renderRendererRoot(
  container: HTMLElement | null,
  element: ReactNode,
  hot?: RendererHotModule,
): Root {
  if (!container) {
    throw new Error("The Cowork renderer root element is missing.");
  }

  const cachedRoot = hot?.data.rendererRoot as Root | undefined;
  const cachedContainer = hot?.data.rendererRootContainer;
  if (cachedRoot && cachedContainer !== container) {
    cachedRoot.unmount();
  }
  const root = cachedRoot && cachedContainer === container ? cachedRoot : createRoot(container);
  if (hot) {
    hot.data.rendererRoot = root;
    hot.data.rendererRootContainer = container;
    hot.dispose((data) => {
      data.rendererRoot = root;
      data.rendererRootContainer = container;
    });
  }
  root.render(element);
  return root;
}
