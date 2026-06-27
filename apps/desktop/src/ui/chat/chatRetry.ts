import type { FeedItem } from "../../app/types";

const HIDDEN_RETRY_TURN_MARKER = "[[cowork:hidden-retry-turn]]";

export const HIDDEN_RETRY_TURN_PROMPT = `${HIDDEN_RETRY_TURN_MARKER}
Continue from where the previous turn stopped. Retry the failed step only if it is still necessary, then finish the user's request.`;

export function isHiddenRetryTurnMessage(item: FeedItem): boolean {
  return (
    item.kind === "message" &&
    item.role === "user" &&
    item.text.startsWith(HIDDEN_RETRY_TURN_MARKER)
  );
}
