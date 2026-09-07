import { describe, expect, test } from "bun:test";

import {
  assertCodeModeProcessPlatform,
  type CodeModeProcessSpawner,
  codeModeBunCommand,
  codeModeCgroupLimits,
  codeModeCgroupParent,
  requireCodeModeSandbox,
} from "../src/platform/codeModeProcess";
import { hostPlatform } from "../src/platform/host";
import { isAlive } from "../src/platform/proc";
import type { SandboxTransformResult } from "../src/platform/sandbox";
import { type CodeModeCallEvent, createCodeModeTool } from "../src/runtime/codeMode";
import { CodeModeFrameDecoder, encodeCodeModeFrame } from "../src/runtime/codeModeTransport";
import { spawnTrustedCodeModeFixture } from "./helpers/codeModeProcess";

const catalog = {
  search: () => ({ tools: [] }),
  call: () => ({ content: [{ type: "text", text: "ok" }], sources: [{ id: "fixture" }] }),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function observerDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("observer blocked settlement")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fixtureDependencies = { spawnProcess: spawnTrustedCodeModeFixture };

describe("code mode process policy", () => {
  test("macOS, Windows and unknown platforms fail closed, not heap/RSS-limit fallback", () => {
    for (const platform of ["darwin", "win32", "freebsd"] as const) {
      expect(() => assertCodeModeProcessPlatform(platform)).toThrow("no enforced process-memory");
    }
    expect(() => assertCodeModeProcessPlatform("linux")).not.toThrow();
  });

  test("the real unsupported host refuses before catalog dispatch", async () => {
    if (hostPlatform() === "linux") return;
    let calls = 0;
    const tool = createCodeModeTool({
      catalog: { ...catalog, call: () => calls++ },
    });
    await expect(tool.execute({ code: 'return await tools.call("never", {});' })).rejects.toThrow(
      "no enforced process-memory",
    );
    expect(calls).toBe(0);
  });

  test("hard cgroup settings include native memory, forbid swap and group OOM survivors", () => {
    expect(codeModeCgroupLimits(256 * 1024 * 1024)).toEqual({
      "memory.max": "268435456",
      "memory.swap.max": "0",
      "memory.oom.group": "1",
      "pids.max": "64",
    });
    expect(() => codeModeCgroupLimits(Number.NaN)).toThrow();
    expect(() => codeModeCgroupLimits(0)).toThrow();
    expect(codeModeCgroupParent("0::/user.slice/session.scope\n")).toBe(
      "/sys/fs/cgroup/user.slice/session.scope",
    );
    expect(codeModeCgroupParent("0::/\n")).toBe("/sys/fs/cgroup/");
    for (const membership of ["1:memory:/legacy", "0::/../../escape", "0::relative"]) {
      expect(() => codeModeCgroupParent(membership)).toThrow();
    }
    expect(codeModeCgroupParent("0::/occupied", "/sys/fs/cgroup/delegated/")).toBe(
      "/sys/fs/cgroup/delegated/",
    );
    for (const root of ["/tmp/fake", "/sys/fs/cgroup/../escape", "relative"]) {
      expect(() => codeModeCgroupParent("0::/occupied", root)).toThrow();
    }
  });

  test("refuses missing sandbox dimensions even if a backend advertises success", () => {
    const enforced: SandboxTransformResult = {
      file: "/usr/bin/bwrap",
      args: [],
      env: {},
      sandbox: "linux-bwrap",
      unsandboxed: false,
      enforcement: { filesystem: true, network: true, process: true, integrity: true },
    };
    expect(() => requireCodeModeSandbox(enforced)).not.toThrow();
    for (const dimension of ["filesystem", "network", "process", "integrity"] as const) {
      expect(() =>
        requireCodeModeSandbox({
          ...enforced,
          enforcement: { ...enforced.enforcement, [dimension]: false },
        }),
      ).toThrow("requires OS sandbox");
    }
    expect(() => requireCodeModeSandbox({ ...enforced, unsandboxed: true })).toThrow();
    expect(() => requireCodeModeSandbox({ ...enforced, sandbox: "none" })).toThrow();
  });

  test("Bun reentry uses the current executable and a replacement environment", () => {
    const command = codeModeBunCommand("trusted-bootstrap");
    expect(command.file).toBe(process.execPath);
    expect(command.args).toContain("--no-env-file");
    expect(command.args).toContain("--no-install");
    expect(command.args.at(-1)).toBe("trusted-bootstrap");
    expect(command.env.BUN_BE_BUN).toBe("1");
    expect(command.env).not.toHaveProperty("NODE_OPTIONS");
    expect(command.env).not.toHaveProperty("BUN_OPTIONS");
    expect(command.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(command.env).not.toHaveProperty("LD_PRELOAD");
    expect(codeModeBunCommand("trusted", "win32").args).toContain("--config=NUL");
    expect(codeModeBunCommand("trusted", "darwin").args).toContain("--config=/dev/null");
  });

  test("rejects limits that could turn bounded transport into unbounded allocation", () => {
    for (const limits of [
      { maxMemoryBytes: 2 ** 40 },
      { maxCalls: 1_000_000 },
      { maxOutputBytes: 2 ** 32 },
      { maxTransportBytes: 2 ** 32 },
      { maxConcurrency: 1000 },
    ]) {
      expect(() => createCodeModeTool({ catalog, limits })).toThrow("must not exceed");
    }
  });
});

describe("code mode bounded framing", () => {
  test("handles fragmented multibyte UTF-8 and multiple messages per chunk", () => {
    const values: unknown[] = [];
    const decoder = new CodeModeFrameDecoder(128);
    const bytes = Buffer.from('{"text":"é😀"}\n{"n":2}\n');
    for (const byte of bytes) decoder.push(Uint8Array.of(byte), (value) => values.push(value));
    decoder.end();
    expect(values).toEqual([{ text: "é😀" }, { n: 2 }]);
    decoder.push(Buffer.from("1\n2\n"), (value) => values.push(value));
    expect(values.slice(2)).toEqual([1, 2]);
  });

  test("caps unterminated frames before JSON parsing and rejects invalid UTF-8", () => {
    const decoder = new CodeModeFrameDecoder(8);
    decoder.push(Buffer.from("12345678"), () => {});
    expect(() => decoder.push(Buffer.from("9"), () => {})).toThrow("frame exceeds");
    expect(() => new CodeModeFrameDecoder(8).push(Uint8Array.of(0xff, 10), () => {})).toThrow();
    const incomplete = new CodeModeFrameDecoder(8);
    incomplete.push(Buffer.from('"abc"'), () => {});
    expect(() => incomplete.end()).toThrow("incomplete");
    expect(() => encodeCodeModeFrame({ text: "éé" }, 8)).toThrow("frame exceeds");
  });

  test("caps cumulative IPC even when every individual result fits its frame", async () => {
    const tool = createCodeModeTool(
      {
        catalog: { ...catalog, call: () => "x".repeat(200) },
        limits: { maxOutputBytes: 1024, maxTransportBytes: 1200 },
      },
      fixtureDependencies,
    );
    await expect(
      tool.execute({
        code: 'for (let i=0; i<20; i++) await tools.call("data", {}); return "done";',
      }),
    ).rejects.toThrow("maxTransportBytes");
  });

  test("large structured host responses survive real pipe fragmentation and backpressure", async () => {
    const value = { text: "é😀".repeat(40_000), sources: [{ id: "fixture" }] };
    const tool = createCodeModeTool(
      { catalog: { ...catalog, call: () => value } },
      fixtureDependencies,
    );
    expect(await tool.execute({ code: 'return await tools.call("large", {});' })).toEqual(value);
  });

  for (const [source, expectedError] of [
    ['process.stdout.write("x".repeat(9000)); setInterval(()=>{},1000);', "frame exceeds"],
    ['process.stdout.write(JSON.stringify({t:"done",payload:"7"})+"\\n");', "did not become ready"],
    ['process.stderr.write("x".repeat(17000)); setInterval(()=>{},1000);', "stderr exceeds"],
    ["process.exit(0);", "process exited without a result"],
  ]) {
    test(`invalid executor transport fails closed: ${expectedError}`, async () => {
      let called = false;
      let pid = 0;
      const tool = createCodeModeTool(
        {
          catalog: {
            ...catalog,
            call: () => {
              called = true;
            },
          },
          limits: { maxSourceBytes: 64, maxArgumentBytes: 64, maxOutputBytes: 64 },
        },
        {
          spawnProcess(input) {
            const executor = spawnTrustedCodeModeFixture({ ...input, source });
            pid = executor.child.pid;
            return executor;
          },
        },
      );
      await expect(tool.execute({ code: "return 7;" })).rejects.toThrow(expectedError);
      expect(called).toBe(false);
      expect(isAlive(pid)).toBe(false);
    });
  }

  test("kills and reaps the separate executor on success and failure", async () => {
    for (const code of ["return 7;", "while(true){}"]) {
      let pid = 0;
      const spawnProcess: CodeModeProcessSpawner = (input) => {
        const executor = spawnTrustedCodeModeFixture(input);
        pid = executor.child.pid;
        return executor;
      };
      const tool = createCodeModeTool({ catalog, limits: { timeoutMs: 100 } }, { spawnProcess });
      if (code.startsWith("return")) expect(await tool.execute({ code })).toBe(7);
      else await expect(tool.execute({ code })).rejects.toThrow("timed out");
      expect(pid).not.toBe(process.pid);
      expect(isAlive(pid)).toBe(false);
    }
  });
});

describe("code mode nested lifecycle", () => {
  for (const phase of ["start", "end"] as const) {
    for (const termination of ["abort", "timeout"] as const) {
      test(`${termination} releases a stalled ${phase} observer and consumes its late rejection`, async () => {
        const events: CodeModeCallEvent[] = [];
        const observerSignals: (AbortSignal | undefined)[] = [];
        const entered = deferred();
        const release = deferred();
        const controller = new AbortController();
        let calls = 0;
        let pid = 0;
        const tool = createCodeModeTool(
          {
            catalog: { ...catalog, call: () => ++calls },
            abortSignal: controller.signal,
            limits: { timeoutMs: termination === "timeout" ? 200 : 2000 },
            async onCallEvent(event, executionOptions) {
              events.push(event);
              observerSignals.push(executionOptions?.abortSignal);
              if (event.phase === phase) {
                entered.resolve();
                await release.promise;
                throw new Error("late observer rejection");
              }
            },
          },
          {
            spawnProcess(input) {
              const executor = spawnTrustedCodeModeFixture(input);
              pid = executor.child.pid;
              return executor;
            },
          },
        );
        const run = Promise.resolve(tool.execute({ code: 'return await tools.call("wait", {});' }));
        void run.catch(() => {});
        try {
          await observerDeadline(entered.promise);
          if (termination === "abort") controller.abort();
          await expect(observerDeadline(run)).rejects.toThrow(
            termination === "abort" ? "cancelled" : "timed out",
          );
          expect(calls).toBe(phase === "start" ? 0 : 1);
          expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
          expect(events[1]).toMatchObject({
            status: phase === "start" ? "cancelled" : "succeeded",
          });
          expect(observerSignals.every((signal) => signal?.aborted === true)).toBe(true);
          expect(isAlive(pid)).toBe(false);
        } finally {
          release.resolve();
          await run.catch(() => {});
        }
        // Let the abandoned observer reject after execute has settled. An
        // unobserved rejection would fail the test runner.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  test("successful terminal IPC releases an end observer even after clearing the deadline", async () => {
    const release = deferred();
    const events: CodeModeCallEvent[] = [];
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const send = (message: unknown) =>
      output.enqueue(Buffer.from(encodeCodeModeFrame(message, 4096)));
    // A bounded transport peer sends done during end delivery, exercising
    // successful finish independently of the production realm's RPC drain.
    const spawnProcess: CodeModeProcessSpawner = () => ({
      child: {
        pid: 0,
        exitCode: null,
        signalCode: null,
        exited: Promise.resolve({ reason: "exited", code: 0 }),
        stdout: new ReadableStream({
          start(controller) {
            output = controller;
            send({ t: "ready" });
          },
        }),
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        writeStdin() {
          send({
            t: "request",
            id: 0,
            operation: "call",
            payload: JSON.stringify({ name: "fixture", arguments: {} }),
          });
        },
        kill() {},
        async killTree() {},
      },
      // The runtime cancels its in-memory readers; there is no OS child.
      async dispose() {},
    });
    const tool = createCodeModeTool(
      {
        catalog,
        async onCallEvent(event) {
          events.push(event);
          if (event.phase === "end") {
            send({ t: "done", payload: "7" });
            await release.promise;
            throw new Error("late successful observer rejection");
          }
        },
      },
      { spawnProcess },
    );
    try {
      expect(await observerDeadline(Promise.resolve(tool.execute({ code: "return 7;" })))).toBe(7);
      expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
      expect(events[1]).toMatchObject({ status: "succeeded", output: catalog.call() });
    } finally {
      release.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("observers cannot mutate admitted inputs or script-visible results", async () => {
    const tool = createCodeModeTool(
      {
        catalog: {
          ...catalog,
          call: ({ arguments: input }) => {
            expect(input).toEqual({ id: 7 });
            return { id: 7 };
          },
        },
        onCallEvent(event) {
          if (event.phase === "start") {
            (event.input as { arguments: unknown }).arguments = "observer mutation";
          } else if (event.output) {
            (event.output as { id: number }).id = 999;
          }
        },
      },
      fixtureDependencies,
    );
    expect(await tool.execute({ code: 'return await tools.call("echo", {id:7});' })).toEqual({
      id: 7,
    });
  });

  test("correlates repeated nested calls and search, retaining structured output", async () => {
    const events: CodeModeCallEvent[] = [];
    const tool = createCodeModeTool(
      { catalog, onCallEvent: (event) => void events.push(event) },
      fixtureDependencies,
    );
    expect(
      await tool.execute({
        code: 'await tools.search("fixture"); return await Promise.all([1,2].map(i=>tools.call("read",{i})));',
      }),
    ).toEqual([catalog.call(), catalog.call()]);
    const starts = events.filter((event) => event.phase === "start");
    const ends = events.filter((event) => event.phase === "end");
    expect(starts.map((event) => event.name)).toEqual(["toolSearch", "read", "read"]);
    expect(new Set(starts.map((event) => event.callId)).size).toBe(3);
    expect(new Set(events.map((event) => event.executionId)).size).toBe(1);
    expect(ends).toHaveLength(3);
    for (const start of starts) {
      const end = ends.find((event) => event.callId === start.callId);
      expect(end?.status).toBe("succeeded");
      expect(end?.durationMs).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(end!)).toBeGreaterThan(events.indexOf(start));
    }
    expect(ends.find((event) => event.name === "read")?.output).toEqual(catalog.call());
  });

  test("failure and observer rejection do not suppress terminal lifecycle", async () => {
    const events: CodeModeCallEvent[] = [];
    const tool = createCodeModeTool(
      {
        catalog: {
          ...catalog,
          call: () => {
            throw new Error("fixture failure");
          },
        },
        async onCallEvent(event) {
          events.push(event);
          throw new Error("observer failure");
        },
      },
      fixtureDependencies,
    );
    await expect(tool.execute({ code: 'return await tools.call("fail",{});' })).rejects.toThrow(
      "fixture failure",
    );
    expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(events[1]).toMatchObject({ status: "failed", error: "fixture failure" });
  });

  test("observer rejections do not change successful catalog outcomes", async () => {
    const events: CodeModeCallEvent[] = [];
    const tool = createCodeModeTool(
      {
        catalog,
        async onCallEvent(event) {
          events.push(event);
          throw new Error("telemetry only");
        },
      },
      fixtureDependencies,
    );
    expect(await tool.execute({ code: 'return await tools.call("ok", {});' })).toEqual(
      catalog.call(),
    );
    expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(events[1]).toMatchObject({ status: "succeeded", output: catalog.call() });
  });

  test("cancelled host calls retain terminal events and ownership until actual settlement", async () => {
    const events: CodeModeCallEvent[] = [];
    const started = deferred();
    const release = deferred();
    const observerRelease = deferred();
    const controller = new AbortController();
    let settled = false;
    const tool = createCodeModeTool(
      {
        catalog: {
          ...catalog,
          async call() {
            started.resolve();
            await release.promise;
            return { completedDespiteAbort: true };
          },
        },
        abortSignal: controller.signal,
        limits: { maxConcurrency: 1 },
        async onCallEvent(event) {
          events.push(event);
          if (event.phase === "end") await observerRelease.promise;
        },
      },
      fixtureDependencies,
    );
    const run = Promise.resolve(
      tool.execute({ code: 'return await Promise.all([1,2].map(i=>tools.call("wait",{i})));' }),
    );
    void run.catch(() => {
      settled = true;
    });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(events.map((event) => event.phase)).toEqual(["start"]);
    release.resolve();
    try {
      await expect(observerDeadline(run)).rejects.toThrow("cancelled");
    } finally {
      observerRelease.resolve();
    }
    expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(events[1]).toMatchObject({
      status: "cancelled",
      output: { completedDespiteAbort: true },
    });
  });
});
