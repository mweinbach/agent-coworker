import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { scratchRoots } from "../src/platform/sandbox";
import { createPiRuntime } from "../src/runtime/pi/runTurn";
import { resolveStepTools } from "../src/runtime/pi/stepState";
import { executeToolCall, executeToolCalls, toolMapToPiTools } from "../src/runtime/pi/tools";
import {
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "../src/runtime/piMessageBridge";
import { createToolExposure } from "../src/runtime/toolExposure";
import type { RuntimeRunTurnParams, RuntimeToolMap } from "../src/runtime/types";
import { createCompletedTurnProgressTracker } from "../src/server/session/turnExecution/completedTurnProgress";
import type { ToolContext } from "../src/tools/context";
import { createSkillTool } from "../src/tools/skill";
import type { AgentConfig } from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function params(tools: RuntimeToolMap = {}): RuntimeRunTurnParams {
  const root = scratchRoots()[0]!;
  return {
    config: {
      provider: "opencode-go",
      model: "glm-5",
      preferredChildModel: "glm-5",
      workingDirectory: root,
      outputDirectory: root,
      uploadsDirectory: root,
      projectCoworkDir: `${root}/.cowork`,
      userCoworkDir: `${root}/.cowork`,
      builtInDir: root,
      builtInConfigDir: root,
      skillsDirs: [],
      memoryDirs: [],
      configDirs: [],
      userName: "",
      knowledgeCutoff: "unknown",
    } as AgentConfig,
    system: "test",
    messages: [{ role: "user", content: "test" }],
    tools,
    maxSteps: 3,
  };
}

const call = (name: string, id = name, args: Record<string, unknown> = {}) => ({
  name,
  id,
  arguments: args,
});
const assistant = (calls: ReturnType<typeof call>[]) => ({
  role: "assistant",
  content: calls.length
    ? calls.map((value) => ({ type: "toolCall", ...value }))
    : [{ type: "text", text: "done" }],
  stopReason: calls.length ? "toolUse" : "stop",
});
const stream = (result: unknown) => ({
  async *[Symbol.asyncIterator]() {},
  result: async () => result,
});

function exposureHarness(initial: RuntimeToolMap) {
  let current = initial;
  let activeLeases = 0;
  const exposure = createToolExposure({
    tools: initial,
    config: { deferredToolSearch: true, codeMode: false },
    withTools: async (operation) => {
      activeLeases += 1;
      try {
        return await operation(current, []);
      } finally {
        activeLeases -= 1;
      }
    },
  });
  return {
    exposure,
    replace: (next: RuntimeToolMap) => {
      current = next;
    },
    leases: () => activeLeases,
  };
}

describe("PI live native deferred activation", () => {
  test("the production skill tool requests constrained sampling without changing its schema", () => {
    const skill = createSkillTool({ config: params().config } as ToolContext);
    const [mapped] = toolMapToPiTools({ skill }, "anthropic");
    expect(mapped?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(mapped?.parameters).toEqual(
      toolMapToPiTools({ skill: { ...skill, constrainedSampling: false } }, "anthropic")[0]
        ?.parameters,
    );
  });

  test("loads discovered schemas on the next step, preserves anchors, and calls with a fresh lease", async () => {
    const inputSchema = z.object({ text: z.string() }).strict();
    const execute = mock(async (input: unknown) => {
      expect(harness.leases()).toBe(1);
      return input;
    });
    const harness = exposureHarness({ echo: { inputSchema, execute } });
    const contexts: any[] = [];
    const responses = [
      assistant([call("toolSearch", "search", { query: "echo" })]),
      assistant([call("echo", "echo", { text: "hello" })]),
      assistant([]),
    ];
    const runtime = createPiRuntime({
      piStreamImpl: ((_model: unknown, context: unknown) => {
        contexts.push(context);
        return stream(responses.shift());
      }) as never,
    });
    const result = await runtime.runTurn({ ...params(), ...harness.exposure });
    expect(contexts.map((context) => context.tools.map((tool: any) => tool.name).sort())).toEqual([
      ["toolCall", "toolSearch"],
      ["echo", "toolCall", "toolSearch"],
      ["echo", "toolCall", "toolSearch"],
    ]);
    expect(
      contexts[1].messages.find((message: any) => message.role === "toolResult").addedToolNames,
    ).toEqual(["echo"]);
    const replay = modelMessagesToPiMessages(JSON.parse(JSON.stringify(result.responseMessages)));
    expect(replay.find((message) => message.role === "toolResult")).toMatchObject({
      addedToolNames: ["echo"],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.leases()).toBe(0);
  });

  test("resume intersects hints with live authority; pruning, errors, and revocation unload schemas", async () => {
    const harness = exposureHarness({ echo: { execute: async () => "hello" } });
    const p = { ...params(), ...harness.exposure };
    const persisted = piTurnMessagesToModelMessages([
      {
        role: "toolResult",
        toolName: "toolSearch",
        toolCallId: "s",
        content: [{ type: "text", text: "found" }],
        addedToolNames: ["echo", "forbidden", "__proto__", "echo"],
        isError: false,
      },
    ]);
    const replay = () =>
      modelMessagesToPiMessages(JSON.parse(JSON.stringify(persisted))) as unknown as Array<
        Record<string, unknown>
      >;
    const restored = replay();
    expect(Object.keys(await resolveStepTools(p, restored))).toContain("echo");
    expect(restored[0]?.addedToolNames).toEqual(["echo"]);
    expect(Object.keys(await resolveStepTools(p, []))).toEqual(["toolSearch", "toolCall"]);
    harness.replace({});
    const revoked = replay();
    expect(Object.keys(await resolveStepTools(p, revoked))).toEqual(["toolSearch", "toolCall"]);
    expect(revoked[0]?.addedToolNames).toBeUndefined();
    harness.replace({ echo: { execute: async () => "hello" } });
    const failed = replay();
    failed[0]!.isError = true;
    expect(Object.keys(await resolveStepTools(p, failed))).not.toContain("echo");
    const disabled = replay();
    expect(Object.keys(await resolveStepTools(params(), disabled))).toEqual([]);
    expect(disabled[0]?.addedToolNames).toBeUndefined();
  });

  test("prepareStep compaction removes native schemas rather than retaining stale turn state", async () => {
    const harness = exposureHarness({ echo: { execute: async () => "hello" } });
    const names: string[][] = [];
    let step = 0;
    const runtime = createPiRuntime({
      piStreamImpl: ((_model: unknown, context: any) => {
        names.push(context.tools.map((tool: any) => tool.name));
        return stream(
          step++ === 0 ? assistant([call("toolSearch", "s", { query: "echo" })]) : assistant([]),
        );
      }) as never,
    });
    await runtime.runTurn({
      ...params(),
      ...harness.exposure,
      prepareStep: async ({ stepNumber }) =>
        stepNumber === 2 ? { messages: [{ role: "user", content: "compacted" }] } : undefined,
    });
    expect(names).toEqual([
      ["toolSearch", "toolCall"],
      ["toolSearch", "toolCall"],
    ]);
  });

  test("a schema snapshot never grants stale execution or skips replacement validation", async () => {
    const old = mock(async () => "old");
    const next = mock(async (input: unknown) => input);
    const harness = exposureHarness({
      echo: { inputSchema: z.object({ text: z.string() }), execute: old },
    });
    const snapshot = await harness.exposure.deferredToolCatalog!.resolveTools(["echo"]);
    harness.replace({ echo: { inputSchema: z.object({ count: z.number() }), execute: next } });
    await expect(snapshot.echo!.execute({ text: "stale" })).rejects.toThrow();
    expect(await snapshot.echo!.execute({ count: 1 })).toEqual({ count: 1 });
    harness.replace({});
    await expect(snapshot.echo!.execute({ count: 1 })).rejects.toThrow("not available");
    expect(old).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(harness.leases()).toBe(0);
  });

  test("portable fallback remains callable and output-shaped activation metadata is ignored", async () => {
    const harness = exposureHarness({
      echo: { execute: async () => ({ addedToolNames: ["forbidden"] }) },
    });
    const portable = await harness.exposure.tools.toolCall!.execute({
      name: "echo",
      arguments: {},
    });
    expect(portable).toEqual({ addedToolNames: ["forbidden"] });
    const result = await executeToolCall(
      call("toolCall", "c", { name: "echo", arguments: {} }),
      { ...params(), ...harness.exposure },
      async () => {},
    );
    expect(result.addedToolNames).toBeUndefined();
  });
});

describe("PI constrained sampling", () => {
  test("opts in only for compatible schemas without changing optional/default semantics", () => {
    const constrainedSampling = { type: "json_schema", strict: "prefer" } as const;
    const execute = async () => null;
    const mapped = toolMapToPiTools({
      opted: { inputSchema: z.object({ text: z.string() }).strict(), constrainedSampling, execute },
      ordinary: { inputSchema: z.object({ text: z.string() }).strict(), execute },
      optional: {
        inputSchema: z.object({ text: z.string().optional() }).strict(),
        constrainedSampling,
        execute,
      },
      defaulted: {
        inputSchema: z.object({ count: z.number().default(5) }).strict(),
        constrainedSampling,
        execute,
      },
      open: {
        inputSchema: { type: "object", additionalProperties: true },
        constrainedSampling,
        execute,
      },
    });
    expect(mapped[0]?.constrainedSampling).toEqual(constrainedSampling);
    for (const tool of mapped.slice(1)) expect(tool.constrainedSampling).toBeUndefined();
    expect(mapped[2]?.parameters).not.toHaveProperty("required");
    expect(mapped[3]?.parameters).toMatchObject({ properties: { count: { default: 5 } } });
  });

  test("strict prefer never bypasses local input validation or the dispatch gate", async () => {
    const execute = mock(async () => "done");
    const gate = mock(() => {});
    const p = {
      ...params({
        echo: {
          execute,
          inputSchema: z.object({ text: z.string() }).strict(),
          constrainedSampling: { type: "json_schema", strict: "prefer" },
        },
      }),
      assertCanMutate: gate,
    };
    expect(await executeToolCall(call("echo", "c", { text: 2 }), p, async () => {})).toMatchObject({
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(
      await executeToolCall(call("echo", "c", { text: "ok" }), p, async () => {}),
    ).toMatchObject({ isError: false });
    expect(gate).toHaveBeenCalledWith("echo");
  });
});

describe("bounded independent direct reads", () => {
  test("caps a long run of independent reads at four in flight", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let peak = 0;
    let dispatched = 0;
    const p = params({
      readOnly: {
        executionPolicy: "parallel-read",
        execute: async () => {
          active += 1;
          dispatched += 1;
          peak = Math.max(peak, active);
          if (dispatched === 4) entered.resolve();
          await release.promise;
          active -= 1;
          return "read";
        },
      },
    });
    const pending = executeToolCalls(
      Array.from({ length: 9 }, (_, index) => call("readOnly", String(index))),
      p,
      async () => {},
      () => {},
    );
    await entered.promise;
    expect(dispatched).toBe(4);
    release.resolve();
    await pending;
    expect(dispatched).toBe(9);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  test("overlaps reads with immediate events, ordered history, and mutation barriers", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const entered = deferred<void>();
    const started: string[] = [];
    const results: string[] = [];
    const events: string[] = [];
    const p = params({
      a: {
        executionPolicy: "parallel-read",
        execute: async () => {
          started.push("a");
          await first.promise;
          return "a";
        },
      },
      b: {
        executionPolicy: "parallel-read",
        execute: async () => {
          started.push("b");
          entered.resolve();
          await second.promise;
          return "b";
        },
      },
      write: {
        execute: async () => {
          started.push("write");
          return "write";
        },
      },
      c: {
        executionPolicy: "parallel-read",
        execute: async () => {
          started.push("c");
          return "c";
        },
      },
    });
    const pending = executeToolCalls(
      ["a", "b", "write", "c"].map((name) => call(name)),
      p,
      async (part) => {
        events.push((part as any).toolName);
      },
      (tool) => {
        results.push(tool.name);
      },
    );
    await entered.promise;
    expect(started).toEqual(["a", "b"]);
    second.resolve();
    await Bun.sleep(0);
    expect(results).toEqual([]);
    expect(events).toEqual(["b"]);
    first.resolve();
    await pending;
    expect(started).toEqual(["a", "b", "write", "c"]);
    expect(results).toEqual(started);
    expect(events).toEqual(["b", "a", "write", "c"]);
  });

  test("unknown policies serialize and recheck the mutation gate before each dispatch", async () => {
    let locked = false;
    const second = mock(async () => "must not run");
    const p = params({
      first: {
        execute: async () => {
          locked = true;
          return "first";
        },
      },
      second: { execute: second },
    });
    p.assertCanMutate = () => {
      if (locked) throw new Error("ownership revoked");
    };
    const results: any[] = [];
    await executeToolCalls(
      [call("first"), call("second")],
      p,
      async () => {},
      (_call, result) => {
        results.push(result);
      },
    );
    expect(second).not.toHaveBeenCalled();
    expect(results[1]).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "ownership revoked" }],
    });
  });

  test.each(["abort", "failure"] as const)(
    "drains noncooperative siblings on %s before releasing the turn",
    async (kind) => {
      const controller = new AbortController();
      const started = deferred<void>();
      const finish = deferred<void>();
      const fail = deferred<void>();
      let finished = false;
      const results: string[] = [];
      const later = mock(async () => "later");
      const p = {
        ...params({
          a: {
            executionPolicy: "parallel-read" as const,
            execute: async () => {
              await fail.promise;
              throw new DOMException("stream failed", "AbortError");
            },
          },
          b: {
            executionPolicy: "parallel-read" as const,
            execute: async () => {
              started.resolve();
              await finish.promise;
              return "completed";
            },
          },
          later: { execute: later },
        }),
        abortSignal: controller.signal,
      };
      const pending = executeToolCalls(
        [call("a"), call("b"), call("later")],
        p,
        async () => {},
        (tool) => {
          results.push(tool.name);
        },
      ).finally(() => {
        finished = true;
      });
      const observed = pending.catch((error: unknown) => error);
      await started.promise;
      if (kind === "abort") controller.abort();
      fail.resolve();
      await Bun.sleep(0);
      expect(finished).toBe(false);
      finish.resolve();
      expect(await observed).toBeInstanceOf(Error);
      expect(results).toEqual([]);
      expect(later).not.toHaveBeenCalled();
    },
  );

  test.each(["a", "b"])(
    "persists pre-abort completion %s while draining its noncooperative sibling",
    async (completedName) => {
      const controller = new AbortController();
      const release = deferred<void>();
      const admitted = deferred<void>();
      const tracker = createCompletedTurnProgressTracker();
      const calls = [call("a"), call("b")];
      const messages = piTurnMessagesToModelMessages([assistant(calls)]);
      for (const tool of calls) {
        tracker.observe({
          type: "tool-call",
          toolCallId: tool.id,
          toolName: tool.name,
          input: tool.arguments,
        });
      }
      const tools: RuntimeToolMap = Object.fromEntries(
        calls.map(({ name }) => [
          name,
          {
            executionPolicy: "parallel-read",
            execute: async () => {
              if (name !== completedName) await release.promise;
              return name;
            },
          },
        ]),
      );
      let settled = false;
      const pending = executeToolCalls(
        calls,
        { ...params(tools), abortSignal: controller.signal },
        async (part) => {
          // Same admission gate as the production server invocation callback.
          if (controller.signal.aborted) return;
          tracker.observe(part);
          admitted.resolve();
        },
        (_tool, result) => {
          messages.push(...piTurnMessagesToModelMessages([result]));
        },
      ).finally(() => {
        settled = true;
      });
      const observed = pending.catch((error: unknown) => error);
      await admitted.promise;
      controller.abort();
      await Bun.sleep(0);
      expect(settled).toBe(false);
      release.resolve();
      expect(await observed).toBeInstanceOf(Error);
      const retained = tracker.retain(messages);
      expect(retained).toHaveLength(2);
      expect(retained[1]).toMatchObject({
        role: "tool",
        content: [{ toolName: completedName }],
      });
      expect(messages.filter((message) => message.role === "tool")).toHaveLength(1);
    },
  );
});
