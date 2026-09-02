import { describe, expect, test } from "bun:test";

import { raceWithAbort } from "../src/utils/abortSignal";

describe("raceWithAbort", () => {
  test("preserves a completed operation when cancellation has not fired", async () => {
    const controller = new AbortController();
    await expect(raceWithAbort(Promise.resolve("complete"), controller.signal)).resolves.toBe(
      "complete",
    );
  });

  test("observes dependency rejections even when cancellation has already fired", async () => {
    // Isolate process-level unhandled rejection reporting from the test runner.
    const helperUrl = new URL("../src/utils/abortSignal.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        [
          `import { raceWithAbort } from ${JSON.stringify(helperUrl)};`,
          "const unhandled = [];",
          "process.on('unhandledRejection', error => unhandled.push(error.message));",
          "const controller = new AbortController();",
          "controller.abort();",
          "let rejectOperation;",
          "const operation = new Promise((_, reject) => { rejectOperation = reject; });",
          "const cancellation = await raceWithAbort(operation, controller.signal, 'cancelled').catch(error => error.message);",
          "rejectOperation(new Error('dependency failed'));",
          "await new Promise(resolve => setTimeout(resolve, 0));",
          "console.log(JSON.stringify({ cancellation, unhandled }));",
        ].join("\n"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ cancellation: "cancelled", unhandled: [] });
  });
});
