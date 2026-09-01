import { describe, expect, test } from "bun:test";

import { type ModelStreamChunkEvent, mapModelStreamChunk } from "../src/shared/modelStream";
import type { ToolInputDigest } from "../src/shared/toolInputDigest";

const VALID_DIGEST: ToolInputDigest = {
  algorithm: "sha256",
  value: "ab".repeat(32),
  canonicalBytes: 12,
};

function chunk(
  part: Record<string, unknown>,
  extras: Partial<Pick<ModelStreamChunkEvent, "index" | "turnId">> = {},
): ModelStreamChunkEvent {
  return {
    type: "model_stream_chunk",
    sessionId: "s1",
    turnId: extras.turnId ?? "turn-1",
    index: extras.index ?? 3,
    provider: "anthropic",
    model: "claude-sonnet-4",
    partType: "tool_call",
    part,
  };
}

describe("model stream tool-call retry metadata", () => {
  test("propagates a valid digest and retryOf onto the tool_call update", () => {
    expect(
      mapModelStreamChunk(
        chunk({
          toolCallId: " call-9 ",
          toolName: "bash",
          input: { command: "bun test" },
          retryOf: "failure",
          inputDigest: VALID_DIGEST,
        }),
      ),
    ).toEqual({
      kind: "tool_call",
      turnId: "turn-1",
      key: "call-9",
      name: "bash",
      args: { command: "bun test" },
      retryOf: "failure",
      inputDigest: VALID_DIGEST,
    });
  });

  test("drops malformed digests and empty retryOf instead of inventing lineage", () => {
    expect(
      mapModelStreamChunk(
        chunk({
          id: "call-2",
          toolName: "bash",
          input: {},
          retryOf: "",
          inputDigest: {
            algorithm: "sha256",
            value: "AB".repeat(32),
            canonicalBytes: 12,
          },
        }),
      ),
    ).toEqual({
      kind: "tool_call",
      turnId: "turn-1",
      key: "call-2",
      name: "bash",
      args: {},
    });

    expect(
      mapModelStreamChunk(
        chunk({
          id: "call-3",
          retryOf: 12,
          inputDigest: {
            algorithm: "sha256",
            value: "ab".repeat(32),
            canonicalBytes: 12,
            extra: true,
          },
        }),
      ),
    ).toEqual({
      kind: "tool_call",
      turnId: "turn-1",
      key: "call-3",
      name: "tool",
      args: undefined,
    });
  });

  test("keys unnamed tool calls by turn and index when ids are blank", () => {
    expect(
      mapModelStreamChunk(
        chunk(
          {
            toolCallId: "   ",
            id: "",
            toolName: "   ",
          },
          { turnId: "turn-x", index: 7 },
        ),
      ),
    ).toEqual({
      kind: "tool_call",
      turnId: "turn-x",
      key: "tool:turn-x:7",
      name: "   ",
      args: undefined,
    });
  });
});
