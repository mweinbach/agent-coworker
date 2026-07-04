import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { subscribeLines } from "../src/utils/subprocess";

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

async function collectLines(stream: ReadableStream<Uint8Array>): Promise<string[]> {
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
      streamFromChunks([encoder.encode("alpha\r\nbr"), encoder.encode("avo\ncharlie")]),
    );

    expect(lines).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("preserves UTF-8 characters split across chunk boundaries", async () => {
    const bytes = encoder.encode("snowman: \u2603\n");
    const lines = await collectLines(streamFromChunks([bytes.slice(0, 10), bytes.slice(10)]));

    expect(lines).toEqual(["snowman: \u2603"]);
  });

  test("close stops callbacks and resolves the subscription", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
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
  test("preserves child process streaming behavior outside the repo preload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-subprocess-"));
    const childTestPath = path.join(tempDir, "subprocess.child.test.ts");
    const fixtureUrl = pathToFileURL(
      path.join(import.meta.dir, "fixtures", "subprocessChild.ts"),
    ).href;

    await fs.writeFile(childTestPath, `import ${JSON.stringify(fixtureUrl)};\n`);

    try {
      const proc = Bun.spawn([process.execPath, "test", childTestPath], {
        cwd: os.tmpdir(),
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      });
      expect(await proc.exited).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
