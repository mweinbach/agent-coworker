import type { SessionContext } from "../SessionContext";

const activeOperations = new WeakSet<SessionContext>();

/** MCP management serializes independently of model turns and provider setup. */
export function acquireMcpOperation(
  context: SessionContext,
  opts?: { silent?: boolean },
): (() => void) | null {
  if (activeOperations.has(context)) {
    if (!opts?.silent) {
      context.emitError("busy", "session", "MCP connection flow already running");
    }
    return null;
  }

  activeOperations.add(context);
  return () => {
    activeOperations.delete(context);
  };
}
