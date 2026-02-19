import { describe, expect, test } from "bun:test";

import { normalizeModelStreamPart } from "../src/server/modelStream";

describe("server model stream normalization", () => {
  test("keeps stepNumber on start-step and finish-step parts", () => {
    const start = normalizeModelStreamPart(
      { type: "start-step", stepNumber: 3, request: { id: "rq-1" }, warnings: ["slow"] },
      { provider: "google" }
    );
    expect(start).toEqual({
      partType: "start_step",
      part: {
        stepNumber: 3,
        request: { id: "rq-1" },
        warnings: ["slow"],
      },
    });

    const finish = normalizeModelStreamPart(
      {
        type: "finish-step",
        stepNumber: 3,
        response: { id: "rs-1" },
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "tool-calls",
      },
      { provider: "google" }
    );
    expect(finish).toEqual({
      partType: "finish_step",
      part: {
        stepNumber: 3,
        response: { id: "rs-1" },
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "tool-calls",
      },
    });
  });
});
