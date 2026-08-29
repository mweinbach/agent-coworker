import { describe, expect, test } from "bun:test";

import {
  isTerminalProjectedToolState,
  stripWhitespaceForTranscriptDedupe,
} from "../../src/shared/projectionPolicy";

describe("projectionPolicy", () => {
  test("stripWhitespaceForTranscriptDedupe ignores paragraph-only differences", () => {
    expect(stripWhitespaceForTranscriptDedupe("Hello,\n\nworld.")).toBe("Hello,world.");
    expect(stripWhitespaceForTranscriptDedupe("Hello, world.")).toBe("Hello,world.");
    expect(stripWhitespaceForTranscriptDedupe(" \tA\r\n B ")).toBe("AB");
  });

  test("isTerminalProjectedToolState only treats completed tool states as terminal", () => {
    expect(isTerminalProjectedToolState("output-available")).toBe(true);
    expect(isTerminalProjectedToolState("output-error")).toBe(true);
    expect(isTerminalProjectedToolState("output-denied")).toBe(true);
    expect(isTerminalProjectedToolState("input-streaming")).toBe(false);
    expect(isTerminalProjectedToolState("input-available")).toBe(false);
    expect(isTerminalProjectedToolState("approval-requested")).toBe(false);
  });
});
