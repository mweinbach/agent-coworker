import { describe, expect, test } from "bun:test";

import { type ModelStreamChunkEvent, mapModelStreamChunk } from "../src/shared/modelStream";

const digest = {
  algorithm: "sha256" as const,
  value: "a".repeat(64),
  canonicalBytes: 12,
};

function chunk(
  part: Record<string, unknown>,
  overrides: Partial<Pick<ModelStreamChunkEvent, "turnId" | "index">> = {},
): ModelStreamChunkEvent {
  return {
    type: "model_stream_chunk",
    sessionId: "session-1",
    turnId: overrides.turnId ?? "turn-1",
    index: overrides.index ?? 3,
    provider: "google",
    model: "gemini-2.5-flash",
    partType: "tool_call",
    part,
  };
}

describe("mapModelStreamChunk tool_call retry metadata", () => {
  test("propagates a valid digest and retryOf onto the tool_call update", () => {
    const update = mapModelStreamChunk(
      chunk({
        toolCallId: "call-9",
        toolName: "bash",
        input: { command: "bun test" },
        retryOf: "failed-tool",
        inputDigest: digest,
      }),
    );

    expect(update).toMatchObject({
      kind: "tool_call",
      turnId: "turn-1",
      key: "call-9",
      name: "bash",
      args: { command: "bun test" },
      retryOf: "failed-tool",
      inputDigest: digest,
    });
  });

  test("drops empty retryOf and invalid digests instead of inventing lineage", () => {
    const emptyRetry = mapModelStreamChunk(
      chunk({
        id: "call-1",
        retryOf: "",
        inputDigest: digest,
      }),
    );
    expect(emptyRetry).toMatchObject({ kind: "tool_call", inputDigest: digest });
    expect(emptyRetry).not.toHaveProperty("retryOf");

    const uppercaseDigest = mapModelStreamChunk(
      chunk({
        id: "call-2",
        retryOf: "failed-tool",
        inputDigest: { ...digest, value: "A".repeat(64) },
      }),
    );
    expect(uppercaseDigest).toMatchObject({ kind: "tool_call", retryOf: "failed-tool" });
    expect(uppercaseDigest).not.toHaveProperty("inputDigest");

    const extraDigestKeys = mapModelStreamChunk(
      chunk({
        id: "call-3",
        inputDigest: { ...digest, extra: true },
      }),
    );
    expect(extraDigestKeys).not.toHaveProperty("inputDigest");
    expect(extraDigestKeys).not.toHaveProperty("retryOf");
  });

  test("falls back to a stable tool key when ids are blank", () => {
    const update = mapModelStreamChunk(
      chunk(
        {
          toolCallId: "   ",
          id: "",
          toolName: "bash",
        },
        { turnId: "turn-9", index: 4 },
      ),
    );

    expect(update).toMatchObject({
      kind: "tool_call",
      key: "tool:turn-9:4",
      name: "bash",
    });
  });
});
