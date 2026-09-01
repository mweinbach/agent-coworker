// Approval handlers flush persistence only. Navigation or native close can still
// be canceled after they succeed, so they must not dispose or reset the editor.
export type CanvasDocumentTransitionHandler = (nextPath: string | null) => Promise<boolean>;

const activeParticipants = new Set<{ handler: CanvasDocumentTransitionHandler }>();
let transitionChain: Promise<boolean> = Promise.resolve(true);

export function registerCanvasDocumentTransitionHandler(
  handler: CanvasDocumentTransitionHandler,
): () => void {
  const participant = { handler };
  activeParticipants.add(participant);
  return () => {
    activeParticipants.delete(participant);
  };
}

export function requestCanvasDocumentTransition(nextPath: string | null): Promise<boolean> {
  const request = transitionChain.then(async () => {
    try {
      // Resolve participants when this request runs, not when it is queued.
      for (const { handler } of activeParticipants) {
        if (!(await handler(nextPath))) return false;
      }
      return true;
    } catch {
      return false;
    }
  });
  transitionChain = request;
  return request;
}

export function requestCanvasDocumentCloseApproval(): Promise<boolean> {
  return requestCanvasDocumentTransition(null);
}
