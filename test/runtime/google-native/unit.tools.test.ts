import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Interactions } from "@google/genai";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import {
  __internal as googleNativeInternal,
  runGoogleNativeInteractionStep,
} from "../../../src/runtime/googleNativeInteractions";
import type { RuntimeRunTurnParams } from "../../../src/runtime/types";
import { __internal as citationMetadataInternal } from "../../../src/server/citationMetadata";
import { googleSseResponse, liveGoogleTest, makeConfig, makeParams } from "./fixtures";

describe("google native interactions request building", () => {
  test("convertToolsToInteractionsTools maps to function type", () => {
    const tools = googleNativeInternal.convertToolsToInteractionsTools([
      {
        name: "readFile",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);

    expect(tools.length).toBe(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("readFile");
    expect(tools[0].description).toBe("Read a file");
  });

  test("processStreamEvent handles SDK v2 step events and arguments deltas", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.start",
        index: 0,
        step: { type: "function_call", id: "call_v2", name: "bash", arguments: {} },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: '{"command":"pwd"}' },
      },
      blocks,
    );

    expect(blocks.get(0)).toEqual({
      type: "toolCall",
      id: "call_v2",
      name: "bash",
      arguments: { command: "pwd" },
    });
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "step.stop", index: 0 },
        blocks,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "call_v2" },
      { type: "tool-call", toolCallId: "call_v2", toolName: "bash", input: { command: "pwd" } },
    ]);
  });
});
