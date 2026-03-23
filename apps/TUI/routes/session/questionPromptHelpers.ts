import { ASK_SKIP_TOKEN } from "../../../../src/shared/ask";
import {
  normalizeAskOptions as normalizeAskOptionsShared,
  normalizeAskQuestion as normalizeAskQuestionShared,
  shouldRenderAskOptions as shouldRenderAskOptionsShared,
} from "../../../../src/shared/askPrompt";

export const normalizeAskQuestion = normalizeAskQuestionShared;
export const normalizeAskOptions = normalizeAskOptionsShared;
export const shouldRenderAskOptions = shouldRenderAskOptionsShared;

export function resolveAskEscapeAnswer(): string {
  return ASK_SKIP_TOKEN;
}
