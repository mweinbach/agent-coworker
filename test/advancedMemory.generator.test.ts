import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryGenerator, serializeTurnDelta } from "../src/advancedMemory/MemoryGenerator";
import { AdvancedMemoryStore } from "../src/advancedMemory/store";
import type { AgentConfig, ModelMessage } from "../src/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adv-mem-gen-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function baseConfig(): AgentConfig {
  return {
    provider: "google",
    model: "gemini-x",
    memoriesDir: tmpDir,
    workingDirectory: "/tmp/proj",
    projectCoworkDir: "/tmp/proj/.cowork",
  } as unknown as AgentConfig;
}

describe("serializeTurnDelta", () => {
  test("renders user/assistant text, tool calls, and truncates tool results", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool-call", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolName: "bash", output: { value: "x".repeat(5000) } }],
      },
    ] as unknown as ModelMessage[];
    const out = serializeTurnDelta(messages);
    expect(out).toContain("USER: do the thing");
    expect(out).toContain("ASSISTANT: working");
    expect(out).toContain("ASSISTANT → bash(");
    expect(out).toContain("TOOL[bash]:");
    // Tool result truncated well below its raw 5000 chars.
    expect(out.length).toBeLessThan(2000);
  });
});

describe("MemoryGenerator", () => {
  test("runs the headless agent, which can write a memory via tools", async () => {
    let captured: { tools: Record<string, any>; system: string } | null = null;
    const fakeCreateRuntime = (() => ({
      name: "fake" as const,
      runTurn: async (params: any) => {
        captured = { tools: params.tools, system: params.system };
        // Simulate the model calling write_memory then finish.
        await params.tools.write_memory.execute({
          name: "remembered rule",
          description: "a durable rule",
          type: "feedback",
          body: "always do X",
        });
        await params.tools.finish.execute({});
        return { text: "", responseMessages: [] };
      },
    })) as unknown as typeof import("../src/runtime").createRuntime;

    const generator = new MemoryGenerator({
      createRuntime: fakeCreateRuntime,
      loadGeneratorPrompt: async () => "GENERATOR PROMPT",
    });

    const result = await generator.run({
      config: baseConfig(),
      sessionId: "sess-42",
      deltaMessages: [{ role: "user", content: "remember to do X" }] as ModelMessage[],
      folder: "proj",
    });

    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(captured?.system).toBe("GENERATOR PROMPT");

    const store = new AdvancedMemoryStore(tmpDir);
    const memories = await store.listMemories("proj");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.name).toBe("remembered rule");
    expect(memories[0]?.originSessionId).toBe("sess-42");
  });

  test("skips generation when the delta has no user/assistant content", async () => {
    let called = false;
    const generator = new MemoryGenerator({
      createRuntime: (() => {
        called = true;
        return { name: "fake", runTurn: async () => ({ text: "", responseMessages: [] }) };
      }) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    const result = await generator.run({
      config: baseConfig(),
      sessionId: "s",
      deltaMessages: [
        { role: "tool", content: [{ type: "tool-result", toolName: "x", output: {} }] },
      ] as unknown as ModelMessage[],
      folder: "proj",
    });
    expect(result.ran).toBe(false);
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });

  test("swallows runtime errors and never throws", async () => {
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async () => {
          throw new Error("boom");
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    const result = await generator.run({
      config: baseConfig(),
      sessionId: "s",
      deltaMessages: [{ role: "user", content: "hi" }] as ModelMessage[],
      folder: "proj",
    });
    expect(result.ran).toBe(false);
    expect(result.ok).toBe(false);
  });
});
