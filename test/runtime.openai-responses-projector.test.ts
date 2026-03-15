import { describe, expect, test } from "bun:test";

import {
  createResponsesStreamProjector,
  projectResponsesStreamEvent,
} from "../src/runtime/openaiResponsesProjector";
import type { PiModel } from "../src/runtime/piRuntimeOptions";

describe("openai responses projector", () => {
  test("response.completed tolerates models without local cost metadata", () => {
    const output: Record<string, any> = {};
    const projector = createResponsesStreamProjector(output, {
      id: "nvidia/nemotron-3-super-120b-a12b",
      name: "Nemotron 3 Super 120B A12B",
      api: "openai-completions",
      provider: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 32_768,
    } satisfies PiModel);

    expect(() =>
      projectResponsesStreamEvent(
        projector,
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 80,
              output_tokens: 20,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 10 },
            },
          },
        },
        { push: () => {} },
      ),
    ).not.toThrow();

    expect(output.usage).toEqual({
      input: 70,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 110,
    });
  });

  test("response.completed reads local cost metadata once and projects cost when available", () => {
    let costReads = 0;
    const model: PiModel = {
      id: "gpt-5.2",
      name: "GPT-5.2",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      get cost() {
        costReads += 1;
        return {
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 0,
        };
      },
    };
    const output: Record<string, any> = {};
    const projector = createResponsesStreamProjector(output, model);

    projectResponsesStreamEvent(
      projector,
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 160,
            input_tokens_details: { cached_tokens: 10 },
          },
        },
      },
      { push: () => {} },
    );

    expect(costReads).toBe(1);
    expect(output.usage.cost.cacheWrite).toBe(0);
    expect(output.usage.cost.input).toBeCloseTo(0.00009, 12);
    expect(output.usage.cost.output).toBeCloseTo(0.0001, 12);
    expect(output.usage.cost.cacheRead).toBeCloseTo(0.000001, 12);
    expect(output.usage.cost.total).toBeCloseTo(0.000191, 12);
  });
});
