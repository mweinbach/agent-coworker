import { describe, expect, test } from "bun:test";
import path from "node:path";
import { z } from "zod";
import { createRunTurn } from "../src/agent";
import { executeToolCall } from "../src/runtime/pi/tools";
import { createToolExposure as createProductionToolExposure } from "../src/runtime/toolExposure";
import type { RuntimeRunTurnParams, RuntimeToolMap } from "../src/runtime/types";
import type { AgentConfig } from "../src/types";
import { spawnTrustedCodeModeFixture } from "./helpers/codeModeProcess";
import { makeConfig } from "./runtime/codex-app-server/helpers";

// These tests verify composition and authority, not OS memory enforcement.
const createToolExposure: typeof createProductionToolExposure = (options) =>
  createProductionToolExposure(options, { spawnProcess: spawnTrustedCodeModeFixture });

const readResult = {
  text: "file contents",
  sources: [{ url: "https://example.com/source", title: "Source" }],
};

function tools(): RuntimeToolMap {
  return {
    read: {
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
      execute: () => readResult,
    },
    write: {
      description: "Write a file",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: () => ({ ok: true }),
    },
    skill: {
      description: "Read skill instructions",
      inputSchema: z.object({}),
      execute: () => "skill instructions",
    },
  };
}

describe("optional tool exposure", () => {
  test("keeps default direct tools unchanged and composes independent opt-ins", async () => {
    const original = tools();
    for (const codeMode of [false, true]) {
      for (const deferredToolSearch of [false, true]) {
        const exposure = createToolExposure({
          tools: original,
          config: { codeMode, deferredToolSearch },
          withTools: async (operation) => operation(original, []),
        });
        expect(Object.hasOwn(exposure.tools, "codeMode")).toBe(codeMode);
        expect(Object.hasOwn(exposure.tools, "read")).toBe(!deferredToolSearch);
        expect(Object.hasOwn(exposure.tools, "toolCall")).toBe(deferredToolSearch);
        if (!codeMode && !deferredToolSearch) {
          expect(exposure.tools).toBe(original);
          expect(exposure.instructions).toBe("");
        }
        if (codeMode) {
          expect(
            await exposure.tools.codeMode.execute({
              code: 'return await tools.call("read", {path:"file.txt"});',
            }),
          ).toEqual(readResult);
        }
      }
    }
  });

  for (const provider of ["anthropic", "codex-cli"] as const) {
    test(`filters ${provider} authority before deferred discovery and code mode`, async () => {
      const config: AgentConfig = {
        ...makeConfig(process.cwd()),
        provider,
        toolCalling: { codeMode: true, deferredToolSearch: true },
      };
      let inspected = false;
      const runTurn = createRunTurn({
        createToolExposure,
        createTools: () => tools(),
        createRuntime: () => ({
          name: "pi",
          runTurn: async (params) => {
            inspected = true;
            expect(params.sessionId).toBe("exposure-session");
            expect(Object.keys(params.tools).sort()).toEqual([
              "codeMode",
              "toolCall",
              "toolSearch",
            ]);
            const search = (await params.tools.toolSearch.execute({ query: "*" })) as {
              tools: Array<{ name: string }>;
            };
            const names = search.tools.map((tool) => tool.name);
            expect(names).not.toContain("write");
            expect(names.includes("read")).toBe(provider !== "codex-cli");
            await expect(
              params.tools.toolCall.execute({
                name: "write",
                arguments: { path: "escape.txt", content: "no" },
              }),
            ).rejects.toThrow("not available");
            expect(
              await params.tools.codeMode.execute({
                code: 'return (await tools.search("*")).tools.map(tool => tool.name);',
              }),
            ).toEqual(names);
            expect(names).not.toContain("skill");
            return { text: "done", responseMessages: [] };
          },
        }),
      });
      await runTurn({
        config,
        system: "Inspect only",
        messages: [{ role: "user", content: "Inspect" }],
        agentRole: "explorer",
        sessionId: "exposure-session",
        toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
        log: () => {},
        askUser: async () => "no",
        approveCommand: async () => false,
      });
      expect(inspected).toBe(true);
    });
  }

  test("deferred read results retain the full inline contract", async () => {
    const text = "source code\n".repeat(3000);
    const original: RuntimeToolMap = {
      read: { inputSchema: z.object({}), execute: () => text },
    };
    const exposure = createToolExposure({
      tools: original,
      config: { deferredToolSearch: true },
      withTools: async (operation) => operation(original, []),
    });
    const params: RuntimeRunTurnParams = {
      config: {
        ...makeConfig(path.resolve("tool-exposure-read-only")),
        sandbox: { mode: "read-only" },
        toolOutputOverflowChars: 1000,
      },
      tools: exposure.tools,
      system: "",
      messages: [],
      maxSteps: 1,
    };
    const result = await executeToolCall(
      { id: "nested-read", name: "toolCall", arguments: { name: "read", arguments: {} } },
      params,
      async () => {},
    );
    expect(result.content).toEqual([{ type: "text", text }]);
  });

  test("nested discovery preserves activation, citations, and occurrence-level tracing", async () => {
    const original = tools();
    const events: Array<{ callId: string; phase: string; name: string }> = [];
    const exposure = createToolExposure({
      tools: original,
      config: { codeMode: true, deferredToolSearch: true },
      withTools: async (operation) => operation(original, []),
      onCodeModeCallEvent: (event) => {
        events.push({ callId: event.callId, phase: event.phase, name: event.name });
      },
    });
    const result = await executeToolCall(
      {
        id: "nested-discovery",
        name: "codeMode",
        arguments: {
          code: 'await tools.search("read"); return await tools.call("read", {path:"file.txt"});',
        },
      },
      {
        config: makeConfig(process.cwd()),
        tools: exposure.tools,
        deferredToolCatalog: exposure.deferredToolCatalog,
        system: "",
        messages: [],
        maxSteps: 1,
      },
      async () => {},
    );
    expect(result.isError).toBe(false);
    expect(result.addedToolNames).toContain("read");
    expect(result.details).toEqual(readResult);
    expect(events.map(({ phase }) => phase)).toEqual(["start", "end", "start", "end"]);
    expect(events[0].callId).toBe(events[1].callId);
    expect(events[2].callId).toBe(events[3].callId);
    expect(events[0].callId).not.toBe(events[2].callId);
  });

  test("isolates nested cancellation in execution options and captured tool context", async () => {
    const turn = new AbortController();
    const calls = [new AbortController(), new AbortController()];
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const received: AbortSignal[] = [];
    const runTurn = createRunTurn({
      createToolExposure,
      createTools: (ctx) => ({
        wait: {
          inputSchema: z.object({ index: z.number() }),
          execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
            const { index } = input as { index: number };
            const signal = ctx.abortSignal;
            if (!signal) throw new Error("Missing nested cancellation signal");
            received[index] = signal;
            expect(options?.abortSignal).toBe(signal);
            await Promise.resolve();
            expect(ctx.abortSignal).toBe(signal);
            const aborted = () => releases[index].resolve();
            signal.addEventListener("abort", aborted, { once: true });
            entered[index].resolve();
            try {
              await releases[index].promise;
              return "settled";
            } finally {
              signal.removeEventListener("abort", aborted);
            }
          },
        },
      }),
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          const first = Promise.resolve(
            params.tools.codeMode.execute(
              { code: 'return await tools.call("wait", {index:0});' },
              { abortSignal: calls[0].signal },
            ),
          );
          const second = Promise.resolve(
            params.tools.codeMode.execute(
              { code: 'return await tools.call("wait", {index:1});' },
              { abortSignal: calls[1].signal },
            ),
          );
          const firstResult = first.catch((error: unknown) => error);
          try {
            await Promise.all(entered.map((entry) => entry.promise));
            calls[0].abort();
            expect(received[0].aborted).toBe(true);
            expect(received[1].aborted).toBe(false);
            expect(turn.signal.aborted).toBe(false);
            releases[1].resolve();
            expect(await firstResult).toBeInstanceOf(Error);
            expect(await second).toBe("settled");
          } finally {
            for (const release of releases) release.resolve();
            await Promise.allSettled([first, second]);
          }
          return { text: "done", responseMessages: [] };
        },
      }),
    });
    await runTurn({
      config: {
        ...makeConfig(process.cwd()),
        provider: "anthropic",
        toolCalling: { codeMode: true },
      },
      system: "Test cancellation",
      messages: [],
      abortSignal: turn.signal,
      assertCanMutate: async () => {},
      toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
      log: () => {},
      askUser: async () => "no",
      approveCommand: async () => false,
    });
  });
});
