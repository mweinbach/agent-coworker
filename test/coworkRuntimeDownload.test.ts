import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadRuntimeRelease } from "../src/coworkRuntime/download";
import type { CoworkRuntimeBootstrapProgress } from "../src/coworkRuntime/types";

const temporaryRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-download-test-"));
  temporaryRoots.push(root);
  return root;
}

function streamingResponse(chunks: Uint8Array[], contentLength?: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    {
      status: 200,
      headers:
        contentLength === undefined ? undefined : { "content-length": String(contentLength) },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Cowork runtime release download progress", () => {
  test("reports determinate byte progress through the streamed archive", async () => {
    const root = await createTempRoot();
    const chunks = [
      new Uint8Array(1024 * 1024 + 8).fill(1),
      new Uint8Array(1024 * 1024 + 16).fill(2),
    ];
    const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const progress: CoworkRuntimeBootstrapProgress[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".sha256")) {
        return new Response(`${"a".repeat(64)}  cowork-runtime-macos-arm64.zip\n`);
      }
      return streamingResponse(chunks, totalBytes);
    }) as typeof fetch;

    const result = await downloadRuntimeRelease({
      repository: "example/cowork-runtime",
      version: "2026-06-22",
      asset: "macos-arm64",
      downloadDir: root,
      fetchImpl,
      onProgress: (next) => progress.push(next),
    });

    expect(result.downloadedBytes).toBe(totalBytes);
    expect(result.totalBytes).toBe(totalBytes);
    expect((await fs.stat(result.archivePath)).size).toBe(totalBytes);
    expect(progress[0]).toMatchObject({
      phase: "downloading",
      transferredBytes: 0,
      totalBytes: null,
      percent: null,
    });
    expect(progress.some((entry) => entry.transferredBytes === chunks[0]?.byteLength)).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      phase: "downloading",
      transferredBytes: totalBytes,
      totalBytes,
      percent: 100,
    });

    const reportedBytes = progress
      .map((entry) => entry.transferredBytes)
      .filter((value): value is number => value !== null);
    expect(reportedBytes).toEqual([...reportedBytes].sort((left, right) => left - right));
  });

  test("keeps progress indeterminate when Content-Length is unavailable", async () => {
    const root = await createTempRoot();
    const chunks = [new TextEncoder().encode("runtime archive bytes")];
    const progress: CoworkRuntimeBootstrapProgress[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".sha256")) {
        return new Response(`${"b".repeat(64)}\n`);
      }
      return streamingResponse(chunks);
    }) as typeof fetch;

    const result = await downloadRuntimeRelease({
      repository: "example/cowork-runtime",
      version: "2026-06-22",
      asset: "macos-arm64",
      downloadDir: root,
      fetchImpl,
      onProgress: (next) => progress.push(next),
    });

    expect(result.downloadedBytes).toBe(chunks[0]?.byteLength);
    expect(result.totalBytes).toBeNull();
    expect(progress.at(-1)).toMatchObject({
      transferredBytes: chunks[0]?.byteLength,
      totalBytes: null,
      percent: null,
    });
  });
});
