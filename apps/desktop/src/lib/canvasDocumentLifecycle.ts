export type CanvasDocumentTransitionHandler = (nextPath: string | null) => Promise<boolean>;

let activeHandler: CanvasDocumentTransitionHandler | null = null;
let transitionChain: Promise<boolean> = Promise.resolve(true);

export function registerCanvasDocumentTransitionHandler(
  handler: CanvasDocumentTransitionHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = null;
    }
  };
}

export function requestCanvasDocumentTransition(nextPath: string | null): Promise<boolean> {
  const handler = activeHandler;
  if (!handler) return Promise.resolve(true);
  const request = transitionChain.then(
    () => handler(nextPath),
    () => handler(nextPath),
  );
  transitionChain = request.catch(() => false);
  return request;
}
