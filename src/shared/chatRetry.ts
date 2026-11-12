const TOOL_RETRY_TURN_ANNOTATION_TYPE = "cowork.toolRetryTurn";

export const HIDDEN_RETRY_TURN_PROMPT =
  "Continue from where the previous turn stopped. Retry the failed step only if it is still necessary, then finish the user's request.";

/** Structural subset of desktop/mobile feed items needed to spot synthetic retry turns. */
type RetryTurnCandidate = {
  kind: string;
  role?: string;
  annotations?: ReadonlyArray<Record<string, unknown>>;
};

export function isHiddenRetryTurnMessage(item: RetryTurnCandidate): boolean {
  return (
    item.kind === "message" &&
    item.role === "user" &&
    item.annotations?.some(
      (annotation) =>
        annotation.type === TOOL_RETRY_TURN_ANNOTATION_TYPE && annotation.version === 1,
    ) === true
  );
}
