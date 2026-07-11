import type { SessionFeedItem } from "./protocolTypes";

const TOOL_RETRY_TURN_ANNOTATION_TYPE = "cowork.toolRetryTurn";

export const HIDDEN_RETRY_TURN_PROMPT =
  "Continue from where the previous turn stopped. Retry the failed step only if it is still necessary, then finish the user's request.";

export function isHiddenRetryTurnMessage(item: SessionFeedItem): boolean {
  return (
    item.kind === "message" &&
    item.role === "user" &&
    item.annotations?.some(
      (annotation) =>
        annotation.type === TOOL_RETRY_TURN_ANNOTATION_TYPE && annotation.version === 1,
    ) === true
  );
}
