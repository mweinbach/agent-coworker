import { describe, expect, test } from "bun:test";

import type { ProjectedToolState } from "../../src/shared/projectedItems";
import {
  isTerminalProjectedToolState,
  stripWhitespaceForTranscriptDedupe,
} from "../../src/shared/projectionPolicy";

const TERMINAL_STATES = ["output-available", "output-error", "output-denied"] as const;
const NON_TERMINAL_STATES = ["input-streaming", "input-available", "approval-requested"] as const;

describe("stripWhitespaceForTranscriptDedupe", () => {
  test("collapses all whitespace so paragraph-only differences match", () => {
    expect(stripWhitespaceForTranscriptDedupe("a\n\n b")).toBe("ab");
    expect(stripWhitespaceForTranscriptDedupe("hello\tworld")).toBe("helloworld");
    expect(stripWhitespaceForTranscriptDedupe("a\u00a0b")).toBe("ab");
  });
});

describe("isTerminalProjectedToolState", () => {
  test("treats only completed, errored, and denied tools as terminal", () => {
    for (const state of TERMINAL_STATES) {
      expect(isTerminalProjectedToolState(state)).toBe(true);
    }
    for (const state of NON_TERMINAL_STATES) {
      expect(isTerminalProjectedToolState(state)).toBe(false);
    }

    const allStates: ProjectedToolState[] = [...TERMINAL_STATES, ...NON_TERMINAL_STATES];
    expect(allStates).toHaveLength(6);
  });
});
