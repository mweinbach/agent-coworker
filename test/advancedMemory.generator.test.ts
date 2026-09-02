import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryGenerator, serializeTurnDelta } from "../src/advancedMemory/MemoryGenerator";
import { AdvancedMemoryStore } from "../src/advancedMemory/store";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";
import { pinHome } from "./helpers/platform";

let tmpDir: string;
let restoreHome: () => void;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adv-mem-gen-"));
  restoreHome = pinHome(tmpDir);
});

afterEach(async () => {
  restoreHome();
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
  test("batches long deltas without losing the earlier context or late user corrections", async () => {
    const transcripts: string[] = [];
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async (params: RuntimeRunTurnParams) => {
          const prompt = String(params.messages[0]?.content);
          transcripts.push(
            prompt.split("Conversation delta since memory was last updated:\n\n")[1] ?? "",
          );
          return { text: "", responseMessages: [] };
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    const messages: ModelMessage[] = [
      { role: "user", content: `original preference ${"a".repeat(16_000)}` },
      { role: "assistant", content: `working context ${"b".repeat(16_000)}` },
      { role: "user", content: "Correction: always use the newer preference." },
    ];
    const result = await generator.run({
      config: baseConfig(),
      sessionId: "s",
      deltaMessages: messages,
      folder: "proj",
    });
    expect(transcripts.length).toBeGreaterThan(1);
    expect(transcripts.every((transcript) => transcript.length <= 24_000)).toBe(true);
    expect(transcripts.join("\n")).toContain("original preference");
    expect(transcripts.join("\n")).toContain("Correction: always use the newer preference.");
    expect(result).toEqual({ ran: true, ok: true, processedMessageCount: messages.length });
  });

  test("splits one oversized message losslessly and does not checkpoint its incomplete fragments", async () => {
    const transcripts: string[] = [];
    const text = `early instruction ${"x".repeat(50_000)} late correction`;
    let failSecondBatch = true;
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async (params: RuntimeRunTurnParams) => {
          transcripts.push(
            String(params.messages[0]?.content).split(
              "Conversation delta since memory was last updated:\n\n",
            )[1] ?? "",
          );
          if (failSecondBatch && transcripts.length === 2) throw new Error("second batch failed");
          return { text: "", responseMessages: [] };
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    const opts = {
      config: baseConfig(),
      sessionId: "s",
      deltaMessages: [{ role: "user", content: text }] as ModelMessage[],
      folder: "proj",
    };
    const failed = await generator.run(opts);
    expect(failed).toEqual({ ran: true, ok: false, processedMessageCount: 0 });
    failSecondBatch = false;
    transcripts.length = 0;
    const retried = await generator.run(opts);
    expect(transcripts.join("")).toBe(`USER: ${text}`);
    expect(transcripts.every((transcript) => transcript.length <= 24_000)).toBe(true);
    expect(retried).toEqual({ ran: true, ok: true, processedMessageCount: 1 });
  });

  test("a failed later batch reports only complete messages from the persisted prefix", async () => {
    const store = new AdvancedMemoryStore(tmpDir);
    let calls = 0;
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async (params: RuntimeRunTurnParams) => {
          calls += 1;
          if (calls === 2) throw new Error("later batch failed");
          await params.tools.write_memory.execute({
            name: "saved prefix",
            description: "first batch",
            body: "keep first fact",
          });
          return { text: "", responseMessages: [] };
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    const messages: ModelMessage[] = [
      { role: "user", content: `first fact ${"a".repeat(20_000)}` },
      { role: "assistant", content: `second fact ${"b".repeat(20_000)}` },
      { role: "user", content: "late correction" },
    ];
    const result = await generator.run({
      config: baseConfig(),
      sessionId: "s",
      deltaMessages: messages,
      folder: "proj",
      store,
    });
    expect(result).toEqual({ ran: true, ok: false, processedMessageCount: 1 });
    expect((await store.readMemory("proj", "saved-prefix"))?.body).toBe("keep first fact");
  });

  test("cancellation during a batch leaves that batch outside the processed watermark", async () => {
    const controller = new AbortController();
    let calls = 0;
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async () => {
          calls += 1;
          if (calls === 2) controller.abort();
          return { text: "", responseMessages: [] };
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    const result = await generator.run({
      config: baseConfig(),
      sessionId: "s",
      folder: "proj",
      abortSignal: controller.signal,
      deltaMessages: [
        { role: "user", content: "a".repeat(20_000) },
        { role: "assistant", content: "b".repeat(20_000) },
      ],
    });
    expect(result).toEqual({ ran: true, ok: false, processedMessageCount: 1 });
  });

  test("provider-reported aborts do not advance the processed watermark", async () => {
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async (params: RuntimeRunTurnParams) => {
          await params.onModelAbort?.();
          return { text: "", responseMessages: [] };
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
    });
    expect(
      await generator.run({
        config: baseConfig(),
        sessionId: "s",
        folder: "proj",
        deltaMessages: [{ role: "user", content: "remember this" }],
      }),
    ).toEqual({ ran: false, ok: false, processedMessageCount: 0 });
  });

  test("prompt-loading failures are nonthrowing and leave all messages unprocessed", async () => {
    const generator = new MemoryGenerator({
      createRuntime: (() => {
        throw new Error("runtime should not start");
      }) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => {
        throw new Error("prompt unreadable");
      },
    });
    expect(
      await generator.run({
        config: baseConfig(),
        sessionId: "s",
        folder: "proj",
        deltaMessages: [{ role: "user", content: "remember this" }],
      }),
    ).toEqual({ ran: false, ok: false, processedMessageCount: 0 });
  });

  test.each(["listing", "index", "prompt"])(
    "consolidation setup failures during %s are nonthrowing",
    async (stage) => {
      const failure = new Error(`unavailable ${stage}`);
      const store = {
        listMemories: async () => {
          if (stage === "listing") throw failure;
          return [{ slug: "existing" }];
        },
        renderIndex: async () => {
          if (stage === "index") throw failure;
          return "existing index";
        },
      } as unknown as AdvancedMemoryStore;
      const generator = new MemoryGenerator({
        createRuntime: (() => {
          throw new Error("runtime should not start");
        }) as unknown as typeof import("../src/runtime").createRuntime,
        loadGeneratorPrompt: async () => "P",
        loadConsolidatorPrompt: async () => {
          throw failure;
        },
      });
      expect(
        await generator.consolidate({
          config: baseConfig(),
          sessionId: "s",
          folder: "proj",
          store,
        }),
      ).toEqual({ ran: false, ok: false });
    },
  );

  test("consolidation does not report success after a provider abort", async () => {
    const store = {
      listMemories: async () => [{ slug: "existing" }],
      renderIndex: async () => "existing index",
    } as unknown as AdvancedMemoryStore;
    const generator = new MemoryGenerator({
      createRuntime: (() => ({
        name: "fake",
        runTurn: async (params: RuntimeRunTurnParams) => {
          await params.onModelAbort?.();
          return { text: "", responseMessages: [] };
        },
      })) as unknown as typeof import("../src/runtime").createRuntime,
      loadGeneratorPrompt: async () => "P",
      loadConsolidatorPrompt: async () => "C",
    });
    expect(
      await generator.consolidate({ config: baseConfig(), sessionId: "s", folder: "proj", store }),
    ).toEqual({ ran: false, ok: false });
  });

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

  test("routes provider-qualified memory generation models independently of the agent model", async () => {
    let runtimeConfig: AgentConfig | null = null;
    const fakeCreateRuntime = ((config: AgentConfig) => {
      runtimeConfig = config;
      return {
        name: "fake" as const,
        runTurn: async (params: any) => {
          await params.tools.finish.execute({});
          return { text: "", responseMessages: [] };
        },
      };
    }) as unknown as typeof import("../src/runtime").createRuntime;

    const generator = new MemoryGenerator({
      createRuntime: fakeCreateRuntime,
      loadGeneratorPrompt: async () => "GENERATOR PROMPT",
    });

    const result = await generator.run({
      config: {
        ...baseConfig(),
        provider: "google",
        model: "gemini-3.1-pro-preview",
        memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
      },
      sessionId: "sess-42",
      deltaMessages: [{ role: "user", content: "remember to do X" }] as ModelMessage[],
      folder: "proj",
    });

    expect(result.ok).toBe(true);
    expect(runtimeConfig).toMatchObject({
      provider: "together",
      runtime: "pi",
      model: "moonshotai/Kimi-K2.5",
    });
  });

  test("falls back to the canonical preferred child model ref for generation", async () => {
    let runtimeConfig: AgentConfig | null = null;
    const fakeCreateRuntime = ((config: AgentConfig) => {
      runtimeConfig = config;
      return {
        name: "fake" as const,
        runTurn: async (params: any) => {
          await params.tools.finish.execute({});
          return { text: "", responseMessages: [] };
        },
      };
    }) as unknown as typeof import("../src/runtime").createRuntime;

    const generator = new MemoryGenerator({
      createRuntime: fakeCreateRuntime,
      loadGeneratorPrompt: async () => "GENERATOR PROMPT",
    });

    const result = await generator.run({
      config: {
        ...baseConfig(),
        provider: "openai",
        model: "gpt-5.4",
        preferredChildModel: "gpt-5.4",
        preferredChildModelRef: "anthropic:claude-opus-4-8",
        childModelRoutingMode: "cross-provider-allowlist",
        allowedChildModelRefs: ["anthropic:claude-opus-4-8"],
      },
      sessionId: "sess-42",
      deltaMessages: [{ role: "user", content: "remember to do X" }] as ModelMessage[],
      folder: "proj",
    });

    expect(result.ok).toBe(true);
    expect(runtimeConfig).toMatchObject({
      provider: "anthropic",
      runtime: "pi",
      model: "claude-opus-4-8",
    });
  });

  test("consolidates a memory folder with index reads and stale-memory deletion", async () => {
    let captured: { tools: Record<string, any>; system: string } | null = null;
    let runtimeConfig: AgentConfig | null = null;
    const store = new AdvancedMemoryStore(tmpDir);
    await store.writeMemory("proj", {
      name: "durable rule",
      description: "keep this",
      type: "feedback",
      body: "Keep the durable rule.",
    });
    await store.writeMemory("proj", {
      name: "stale task",
      description: "delete this stale task",
      type: "note",
      body: "This was a one-off task.",
    });

    const fakeCreateRuntime = ((config: AgentConfig) => {
      runtimeConfig = config;
      return {
        name: "fake" as const,
        runTurn: async (params: any) => {
          captured = { tools: params.tools, system: params.system };
          const index = await params.tools.read_index.execute({});
          expect(index).toContain("[durable rule](durable-rule.md)");
          expect(index).toContain("[stale task](stale-task.md)");
          const memories = await params.tools.list_memories.execute({});
          expect(memories.map((entry: { slug: string }) => entry.slug).sort()).toEqual([
            "durable-rule",
            "stale-task",
          ]);
          const stale = await params.tools.read_memory.execute({ slug: "stale-task" });
          expect(stale).toMatchObject({ found: true, name: "stale task" });
          expect(await params.tools.delete_memory.execute({ slug: "stale-task" })).toEqual({
            ok: true,
          });
          await params.tools.finish.execute({ note: "removed stale task" });
          return { text: "", responseMessages: [] };
        },
      };
    }) as unknown as typeof import("../src/runtime").createRuntime;

    const generator = new MemoryGenerator({
      createRuntime: fakeCreateRuntime,
      loadGeneratorPrompt: async () => "GENERATOR PROMPT",
      loadConsolidatorPrompt: async () => "CONSOLIDATOR PROMPT",
    });

    const result = await generator.consolidate({
      config: {
        ...baseConfig(),
        provider: "google",
        model: "gemini-3.1-pro-preview",
        memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
      },
      sessionId: "sess-42",
      folder: "proj",
    });

    expect(result).toEqual({ ran: true, ok: true });
    expect(captured?.system).toBe("CONSOLIDATOR PROMPT");
    expect(captured?.tools.read_index).toBeDefined();
    expect(captured?.tools.delete_memory).toBeDefined();
    expect(runtimeConfig).toMatchObject({
      provider: "together",
      runtime: "pi",
      model: "moonshotai/Kimi-K2.5",
    });
    expect(await store.readMemory("proj", "stale-task")).toBeNull();
    expect((await store.listMemories("proj")).map((memory) => memory.slug)).toEqual([
      "durable-rule",
    ]);
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
