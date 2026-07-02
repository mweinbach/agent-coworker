import { describe, expect, test } from "bun:test";

import {
  spawnStreamingSubprocess,
  subscribeLines,
} from "../src/utils/subprocess";

const encoder = new TextEncoder();

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collectLines(
  stream: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const lines: string[] = [];
  const subscription = subscribeLines(stream, (line) => {
    lines.push(line);
  });
  await subscription.done;
  return lines;
}

async function waitForLineCount(lines: string[], expected: number): Promise<void> {
  const started = Date.now();
  while (lines.length < expected) {
    if (Date.now() - started > 1000) {
      throw new Error(`Timed out waiting for ${expected} lines`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("subscribeLines", () => {
  test("splits LF and CRLF lines across chunks and flushes trailing text", async () => {
    const lines = await collectLines(
      streamFromChunks([
        encoder.encode("alpha\r\nbr"),
        encoder.encode("avo\ncharlie"),
      ]),
    );

    expect(lines).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("preserves UTF-8 characters split across chunk boundaries", async () => {
    const bytes = encoder.encode("snowman: \u2603\n");
    const lines = await collectLines(
      streamFromChunks([bytes.slice(0, 10), bytes.slice(10)]),
    );

    expect(lines).toEqual(["snowman: \u2603"]);
  });

  test("close stops callbacks and resolves the subscription", async () => {
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const lines: string[] = [];
    const subscription = subscribeLines(stream, (line) => {
      lines.push(line);
    });

    streamController?.enqueue(encoder.encode("before\n"));
    await waitForLineCount(lines, 1);
    expect(lines).toEqual(["before"]);

    subscription.close();
    await subscription.done;

    expect(() => streamController?.enqueue(encoder.encode("after\n"))).toThrow();
    expect(lines).toEqual(["before"]);
  });
});

describe("spawnStreamingSubprocess", () => {
  test("exposes stdout and honors cwd and env", async () => {
    const child = spawnStreamingSubprocess(
      [
        process.execPath,
        "-e",
        "console.log(`${process.cwd()}|${process.env.SUBPROCESS_SENTINEL ?? ''}|${process.env.HOME ?? ''}`)",
      ],
      {
        cwd: "/tmp",
        env: {
          SUBPROCESS_SENTINEL: "present",
        },
      },
    );

    const stdout = await new Response(child.stdout).text();
    const exit = await child.exited;

    expect(exit.exitCode).toBe(0);
    expect(stdout.trim()).toBe("/tmp|present|");
  });

  test("supports piped stdin and idempotent stdin close", async () => {
    const child = spawnStreamingSubprocess(
      [
        process.execPath,
        "-e",
        "const input = await new Response(Bun.stdin.stream()).text(); console.log(`got:${input.trim()}`);",
      ],
      { stdin: "pipe" },
    );
    const lines: string[] = [];
    const subscription = subscribeLines(child.stdout, (line) => {
      lines.push(line);
    });

    child.writeStdin?.("hello\n");
    child.endStdin?.();
    child.endStdin?.();

    const exit = await child.exited;
    await subscription.done;

    expect(exit.exitCode).toBe(0);
    expect(lines).toEqual(["got:hello"]);
  });

  test("kill is safe before and after exit", async () => {
    const child = spawnStreamingSubprocess([
      process.execPath,
      "-e",
      "setTimeout(() => {}, 10000)",
    ]);

    child.kill("SIGTERM");
    const exit = await child.exited;

    expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    child.kill("SIGTERM");
  });

  test("throws when the executable cannot be spawned", () => {
    expect(() =>
      spawnStreamingSubprocess([
        "/definitely/not/a/real/binary/agent-coworker-subprocess-test",
      ]),
    ).toThrow();
  });
});
