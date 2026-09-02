import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadRuntimeRelease } from "../src/coworkRuntime/download";
import type { CoworkRuntimeBootstrapProgress } from "../src/coworkRuntime/types";
import { createManualTimers } from "./helpers/chaos";

const temporaryRoots: string[] = [];
const releaseStalledStreams: Array<() => void> = [];

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

function heldResponse(finalBytes: Uint8Array, initialBytes?: Uint8Array) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        if (initialBytes) next.enqueue(initialBytes);
      },
      cancel() {
        closed = true;
      },
    }),
  );
  return {
    response,
    release() {
      if (closed) return;
      closed = true;
      controller.enqueue(finalBytes);
      controller.close();
    },
  };
}

afterEach(async () => {
  for (const release of releaseStalledStreams.splice(0)) release();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Cowork runtime release download progress", () => {
  test.each(["checksum headers", "checksum body", "archive headers", "archive body"] as const)(
    "bounds stalled %s and removes only the failed attempt's files",
    async (phase) => {
      const root = await createTempRoot();
      const fileName = "cowork-runtime-macos-arm64.zip";
      const archivePath = path.join(root, fileName);
      await fs.writeFile(archivePath, "previous complete archive");
      await fs.writeFile(path.join(root, "keep.txt"), "unrelated file");
      const timers = createManualTimers();
      const stalled = Promise.withResolvers<void>();
      const checksum = new TextEncoder().encode(`${"a".repeat(64)}  ${fileName}\n`);
      const archive = new Uint8Array(1024 * 1024);
      let releaseStall = () => {};
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const isChecksum = String(input).endsWith(".sha256");
        const target = isChecksum ? "checksum" : "archive";
        const bytes = isChecksum ? checksum : archive;
        if (phase === `${target} headers`) {
          const delayed = Promise.withResolvers<Response>();
          releaseStall = () => delayed.resolve(streamingResponse([bytes]));
          stalled.resolve();
          return await delayed.promise;
        }
        if (phase === `${target} body`) {
          const held = heldResponse(bytes, isChecksum ? undefined : archive);
          releaseStall = held.release;
          if (isChecksum) stalled.resolve();
          return held.response;
        }
        return streamingResponse([bytes]);
      }) as typeof fetch;
      const pending = downloadRuntimeRelease({
        repository: "example/cowork-runtime",
        version: "2026-06-22",
        asset: "macos-arm64",
        downloadDir: root,
        fetchImpl,
        timers: timers.scheduler,
        onProgress: (progress) => {
          if (phase === "archive body" && (progress.transferredBytes ?? 0) >= archive.length) {
            stalled.resolve();
          }
        },
      });
      void pending.catch(() => {});
      try {
        await stalled.promise;
        expect(timers.timeoutCallbacks).toHaveLength(1);
        timers.timeoutCallbacks[0]?.();
        await expect(pending).rejects.toThrow(/timed out|idle/i);
        expect(await fs.readFile(archivePath, "utf8")).toBe("previous complete archive");
        expect((await fs.readdir(root)).sort()).toEqual([fileName, "keep.txt"]);
        expect(timers.timeoutCallbacks).toHaveLength(0);
      } finally {
        releaseStall();
        await pending.catch(() => {});
      }
    },
  );

  test.each([32, 1024 * 1024])(
    "renews the idle deadline for %i-byte chunks independently of UI progress",
    async (chunkBytes) => {
      const root = await createTempRoot();
      const timers = createManualTimers();
      const chunk = new Uint8Array(chunkBytes);
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let deadlineRenewed = () => {};
      const receiving = Promise.withResolvers<void>();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(next) {
            controller = next;
          },
        }),
        { headers: { "content-length": String(chunkBytes * 3) } },
      );
      const pending = downloadRuntimeRelease({
        repository: "example/cowork-runtime",
        version: "2026-06-22",
        asset: "macos-arm64",
        downloadDir: root,
        timers: {
          ...timers.scheduler,
          setTimeout(callback, delayMs) {
            const timer = timers.scheduler.setTimeout(callback, delayMs);
            deadlineRenewed();
            return timer;
          },
        },
        fetchImpl: (async (input: RequestInfo | URL) => {
          if (String(input).endsWith(".sha256")) return new Response(`${"a".repeat(64)}\n`);
          return response;
        }) as typeof fetch,
        onProgress: (progress) => {
          if (progress.totalBytes === chunkBytes * 3 && progress.transferredBytes === 0)
            receiving.resolve();
        },
      });
      try {
        await receiving.promise;
        let previousDeadline = timers.timeoutCallbacks[0];
        for (let index = 0; index < 3; index += 1) {
          const renewed = Promise.withResolvers<void>();
          deadlineRenewed = renewed.resolve;
          controller!.enqueue(chunk);
          await renewed.promise;
          expect(timers.timeoutCallbacks).toHaveLength(1);
          const deadline = timers.timeoutCallbacks[0];
          expect(deadline).not.toBe(previousDeadline);
          previousDeadline = deadline;
        }
        controller!.close();
        const result = await pending;
        expect(result.downloadedBytes).toBe(chunk.length * 3);
        expect(timers.timeoutCallbacks).toHaveLength(0);
      } finally {
        try {
          controller!.close();
        } catch {
          /* already closed */
        }
        await pending.catch(() => {});
      }
    },
  );

  test("cleans up its owned temporary directory when headers time out", async () => {
    const root = await createTempRoot();
    const ownedDirectory = path.join(root, "owned-download");
    const makeTemp = spyOn(fs, "mkdtemp").mockResolvedValue(ownedDirectory);
    const timers = createManualTimers();
    const requested = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<Response>();
    const pending = downloadRuntimeRelease({
      repository: "example/cowork-runtime",
      version: "2026-06-22",
      asset: "macos-arm64",
      timers: timers.scheduler,
      fetchImpl: (async () => {
        requested.resolve();
        return await delayed.promise;
      }) as typeof fetch,
    });
    void pending.catch(() => {});
    try {
      await requested.promise;
      timers.timeoutCallbacks[0]?.();
      await expect(pending).rejects.toThrow(/timed out/i);
      await expect(fs.stat(ownedDirectory)).rejects.toThrow();
      expect(timers.timeoutCallbacks).toHaveLength(0);
    } finally {
      delayed.resolve(new Response(`${"a".repeat(64)}\n`));
      await pending.catch(() => {});
      makeTemp.mockRestore();
    }
  });

  test("rejects an already-cancelled request without fetching or creating files", async () => {
    const root = await createTempRoot();
    const caller = new AbortController();
    caller.abort(new Error("stop before download"));
    let requests = 0;
    await expect(
      downloadRuntimeRelease({
        repository: "example/cowork-runtime",
        version: "2026-06-22",
        asset: "macos-arm64",
        downloadDir: root,
        signal: caller.signal,
        fetchImpl: (async () => {
          requests += 1;
          return new Response(`${"a".repeat(64)}\n`);
        }) as typeof fetch,
      }),
    ).rejects.toThrow("stop before download");
    expect(requests).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("rejects an HTTP error without waiting for its stalled response body", async () => {
    const root = await createTempRoot();
    const timers = createManualTimers();
    let cancelled = false;
    const errorResponse = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
    await expect(
      downloadRuntimeRelease({
        repository: "example/cowork-runtime",
        version: "2026-06-22",
        asset: "macos-arm64",
        downloadDir: root,
        timers: timers.scheduler,
        fetchImpl: (async (input: RequestInfo | URL) =>
          String(input).endsWith(".sha256")
            ? new Response(`${"a".repeat(64)}\n`)
            : errorResponse) as typeof fetch,
      }),
    ).rejects.toThrow("status 503");
    expect(cancelled).toBe(true);
    expect(timers.timeoutCallbacks).toHaveLength(0);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("limits checksum payload size before accumulating an unbounded body", async () => {
    const root = await createTempRoot();
    await expect(
      downloadRuntimeRelease({
        repository: "example/cowork-runtime",
        version: "2026-06-22",
        asset: "macos-arm64",
        downloadDir: root,
        fetchImpl: (async () => new Response("a".repeat(16 * 1024 + 1))) as typeof fetch,
      }),
    ).rejects.toThrow("checksum response exceeds");
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("cancels a partially received archive through the caller signal", async () => {
    const root = await createTempRoot();
    const timers = createManualTimers();
    const caller = new AbortController();
    const chunk = new Uint8Array(1024 * 1024);
    const held = heldResponse(chunk, chunk);
    const receiving = Promise.withResolvers<void>();
    let fetchSignal: AbortSignal | null = null;
    const pending = downloadRuntimeRelease({
      repository: "example/cowork-runtime",
      version: "2026-06-22",
      asset: "macos-arm64",
      downloadDir: root,
      signal: caller.signal,
      timers: timers.scheduler,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(".sha256")) return new Response(`${"a".repeat(64)}\n`);
        fetchSignal = init?.signal ?? null;
        return held.response;
      }) as typeof fetch,
      onProgress: (progress) => {
        if ((progress.transferredBytes ?? 0) >= chunk.length) receiving.resolve();
      },
    });
    void pending.catch(() => {});
    try {
      await receiving.promise;
      caller.abort(new Error("runtime setup cancelled"));
      expect(fetchSignal?.aborted).toBe(true);
      await expect(pending).rejects.toThrow("runtime setup cancelled");
      expect(await fs.readdir(root)).toEqual([]);
      expect(timers.timeoutCallbacks).toHaveLength(0);
    } finally {
      held.release();
      await pending.catch(() => {});
    }
  });

  test.each(["idle timeout", "caller abort"] as const)(
    "settles %s even when archive cancellation is noncooperative",
    async (cause) => {
      const root = await createTempRoot();
      const archivePath = path.join(root, "cowork-runtime-macos-arm64.zip");
      await fs.writeFile(archivePath, "previous complete archive");
      const timers = createManualTimers();
      const caller = new AbortController();
      const receiving = Promise.withResolvers<void>();
      const cancellationStarted = Promise.withResolvers<void>();
      const cancellation = Promise.withResolvers<void>();
      releaseStalledStreams.push(cancellation.resolve);
      const chunk = new Uint8Array(1024 * 1024);
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancellationStarted.resolve();
            // It stays pending throughout the assertion; test cleanup releases it
            // only so a failing regression does not strand the test process.
            return cancellation.promise;
          },
        }),
      );
      const pending = downloadRuntimeRelease({
        repository: "example/cowork-runtime",
        version: "2026-06-22",
        asset: "macos-arm64",
        downloadDir: root,
        signal: caller.signal,
        timers: timers.scheduler,
        fetchImpl: (async (input: RequestInfo | URL) =>
          String(input).endsWith(".sha256")
            ? new Response(`${"a".repeat(64)}\n`)
            : response) as typeof fetch,
        onProgress: (progress) => {
          if ((progress.transferredBytes ?? 0) >= chunk.length) receiving.resolve();
        },
      });
      void pending.catch(() => {});
      await receiving.promise;
      if (cause === "idle timeout") timers.timeoutCallbacks[0]?.();
      else caller.abort(new Error("runtime caller cancelled"));
      await cancellationStarted.promise;
      await expect(pending).rejects.toThrow(
        cause === "idle timeout" ? /timed out/i : /runtime caller cancelled/,
      );
      expect(await fs.readFile(archivePath, "utf8")).toBe("previous complete archive");
      expect(await fs.readdir(root)).toEqual(["cowork-runtime-macos-arm64.zip"]);
      expect(timers.timeoutCallbacks).toHaveLength(0);
    },
  );

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
