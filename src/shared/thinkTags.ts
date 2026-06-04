export type ThinkTagStripState = {
  inThink: boolean;
  pending: string;
};

export type ThinkTaggedText = {
  visibleText: string;
  thinkingText: string;
};

const THINK_OPEN_PREFIX = "<think";
const THINK_CLOSE_TAG = "</think>";

export function createThinkTagStripState(): ThinkTagStripState {
  return { inThink: false, pending: "" };
}

function partialTagSuffixLength(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len -= 1) {
    if (tag.startsWith(lower.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
}

function isThinkOpenBoundary(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9_]/i.test(char);
}

function findThinkOpenTag(
  text: string,
  startIndex: number,
): { index: number; endIndex: number } | { index: number; pending: true } | null {
  const lower = text.toLowerCase();
  let searchIndex = startIndex;

  while (searchIndex < text.length) {
    const index = lower.indexOf(THINK_OPEN_PREFIX, searchIndex);
    if (index < 0) return null;

    const nextChar = text[index + THINK_OPEN_PREFIX.length];
    if (!isThinkOpenBoundary(nextChar)) {
      searchIndex = index + THINK_OPEN_PREFIX.length;
      continue;
    }

    const endIndex = text.indexOf(">", index + THINK_OPEN_PREFIX.length);
    if (endIndex < 0) {
      return { index, pending: true };
    }

    return { index, endIndex: endIndex + 1 };
  }

  return null;
}

export function splitThinkTaggedTextChunk(
  text: string,
  state: ThinkTagStripState,
): ThinkTaggedText {
  const input = `${state.pending}${text}`;
  state.pending = "";

  const lower = input.toLowerCase();
  let visibleText = "";
  let thinkingText = "";
  let index = 0;

  while (index < input.length) {
    if (state.inThink) {
      const closeIndex = lower.indexOf(THINK_CLOSE_TAG, index);
      if (closeIndex < 0) {
        const pendingLength = partialTagSuffixLength(input.slice(index), THINK_CLOSE_TAG);
        const safeEndIndex = input.length - pendingLength;
        thinkingText += input.slice(index, safeEndIndex);
        if (pendingLength > 0) {
          state.pending = input.slice(safeEndIndex);
        }
        return { visibleText, thinkingText };
      }
      thinkingText += input.slice(index, closeIndex);
      index = closeIndex + THINK_CLOSE_TAG.length;
      state.inThink = false;
      continue;
    }

    const open = findThinkOpenTag(input, index);
    if (!open) {
      const rest = input.slice(index);
      const pendingLength = partialTagSuffixLength(rest, THINK_OPEN_PREFIX);
      if (pendingLength > 0) {
        visibleText += rest.slice(0, rest.length - pendingLength);
        state.pending = rest.slice(rest.length - pendingLength);
      } else {
        visibleText += rest;
      }
      return { visibleText, thinkingText };
    }

    visibleText += input.slice(index, open.index);
    if ("pending" in open) {
      state.pending = input.slice(open.index);
      return { visibleText, thinkingText };
    }

    index = open.endIndex;
    state.inThink = true;
  }

  return { visibleText, thinkingText };
}

export function flushThinkTagSplitState(state: ThinkTagStripState): ThinkTaggedText {
  if (!state.pending) return { visibleText: "", thinkingText: "" };
  const pending = state.pending;
  state.pending = "";
  return state.inThink
    ? { visibleText: "", thinkingText: pending }
    : { visibleText: pending, thinkingText: "" };
}

export function stripThinkTaggedTextChunk(text: string, state: ThinkTagStripState): string {
  return splitThinkTaggedTextChunk(text, state).visibleText;
}

export function flushThinkTagStripState(state: ThinkTagStripState): string {
  return flushThinkTagSplitState(state).visibleText;
}

export function splitThinkTaggedText(text: string): ThinkTaggedText {
  const state = createThinkTagStripState();
  const chunk = splitThinkTaggedTextChunk(text, state);
  const pending = flushThinkTagSplitState(state);
  return {
    visibleText: `${chunk.visibleText}${pending.visibleText}`,
    thinkingText: `${chunk.thinkingText}${pending.thinkingText}`,
  };
}

export function stripThinkTaggedText(text: string): string {
  return splitThinkTaggedText(text).visibleText;
}
