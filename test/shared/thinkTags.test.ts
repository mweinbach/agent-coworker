import { describe, expect, test } from "bun:test";

import {
  createThinkTagStripState,
  flushThinkTagSplitState,
  flushThinkTagStripState,
  splitThinkTaggedText,
  splitThinkTaggedTextChunk,
  stripThinkTaggedText,
  stripThinkTaggedTextChunk,
} from "../../src/shared/thinkTags";

describe("think tag stripping", () => {
  test("strips complete think blocks from full text", () => {
    expect(stripThinkTaggedText("<think>\nplan\n</think>\n\nVisible")).toBe("\n\nVisible");
    expect(splitThinkTaggedText("<think>\nplan\n</think>\n\nVisible")).toEqual({
      thinkingText: "\nplan\n",
      visibleText: "\n\nVisible",
    });
  });

  test("strips attribute-bearing think blocks from full text", () => {
    expect(stripThinkTaggedText('A <think data-provider="minimax">hidden</think> B')).toBe("A  B");
  });

  test("strips think blocks split across streaming chunks", () => {
    const state = createThinkTagStripState();
    const first = splitThinkTaggedTextChunk("Visible <thi", state);
    const second = splitThinkTaggedTextChunk("nk>\nhidden", state);
    const third = splitThinkTaggedTextChunk("\n</thi", state);
    const fourth = splitThinkTaggedTextChunk("nk> answer", state);
    const flushed = flushThinkTagSplitState(state);
    const visible = [first, second, third, fourth, flushed]
      .map((part) => part.visibleText)
      .join("");
    const thinking = [first, second, third, fourth, flushed]
      .map((part) => part.thinkingText)
      .join("");

    expect(visible).toBe("Visible  answer");
    expect(thinking).toBe("\nhidden\n");
  });

  test("strips attribute-bearing think tags split across chunks", () => {
    const state = createThinkTagStripState();
    const visible = [
      stripThinkTaggedTextChunk("A <think data-provider", state),
      stripThinkTaggedTextChunk('="minimax">hidden</think> B', state),
      flushThinkTagStripState(state),
    ].join("");

    expect(visible).toBe("A  B");
  });

  test("preserves incomplete visible prefix when no think tag completes", () => {
    const state = createThinkTagStripState();
    const visible = [
      stripThinkTaggedTextChunk("Use <thi", state),
      flushThinkTagStripState(state),
    ].join("");

    expect(visible).toBe("Use <thi");
  });

  test("does not treat longer tag names as think blocks", () => {
    expect(stripThinkTaggedText("Use <thinker>visible</thinker> text")).toBe(
      "Use <thinker>visible</thinker> text",
    );
  });
});
