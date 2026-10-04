import { describe, expect, test } from "bun:test";
import type { ProjectedToolState } from "../../src/shared/projectedItems";
import {
  isTerminalProjectedToolState,
  stripWhitespaceForTranscriptDedupe,
} from "../../src/shared/projectionPolicy";

const TERMINAL_STATES = ["output-available", "output-error", "output-denied"] as const;
const NON_TERMINAL_STATES = ["input-streaming", "input-available", "approval-requested"] as const;

describe("projectionPolicy", () => {
  test("stripWhitespaceForTranscriptDedupe collapses all whitespace", () => {
    expect(stripWhitespaceForTranscriptDedupe("a\n\n b")).toBe("ab");
    expect(stripWhitespaceForTranscriptDedupe("hello\tworld")).toBe("helloworld");
    expect(stripWhitespaceForTranscriptDedupe("a\u00a0b")).toBe("ab");
  });

  test("isTerminalProjectedToolState treats only completed, errored, and denied tools as terminal", () => {
    for (const s of TERMINAL_STATES) expect(isTerminalProjectedToolState(s)).toBe(true);
    for (const s of NON_TERMINAL_STATES) expect(isTerminalProjectedToolState(s)).toBe(false);
    const allStates: ProjectedToolState[] = [...TERMINAL_STATES, ...NON_TERMINAL_STATES];
    expect(allStates).toHaveLength(6);
  });
});
