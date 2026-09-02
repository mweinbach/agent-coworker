import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import { replaceFileAtomic } from "../platform/fs";
import { raceWithAbort } from "../utils/abortSignal";
import {
  assertRuntimeVersion,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  runtimeReleaseTag,
} from "./platform";
import type { CoworkRuntimeBootstrapProgress, RuntimeAssetId, RuntimeHost } from "./types";

const DOWNLOAD_PROGRESS_INTERVAL_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;
const ARCHIVE_IDLE_TIMEOUT_MS = 60_000;
const MAX_CHECKSUM_BYTES = 16 * 1024;

type DownloadTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const defaultTimers: DownloadTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function createDownloadLifetime(callerSignal: AbortSignal | undefined, timers: DownloadTimers) {
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  let timer: unknown;
  const clear = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal,
    arm(timeoutMs: number, stage: string) {
      clear();
      if (signal.aborted) return;
      timer = timers.setTimeout(() => {
        controller.abort(
          new Error(`Cowork runtime download timed out waiting for ${stage} after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
    },
    clear,
  };
}

type DownloadLifetime = ReturnType<typeof createDownloadLifetime>;

async function fetchResponse(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const pending = fetchImpl(url, { redirect: "follow", signal }).then((response) => {
    if (signal.aborted || !response.ok) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
      throw new Error(`GET ${url} failed with status ${response.status}.`);
    }
    return response;
  });
  return await raceWithAbort(pending, signal);
}

async function readChecksumResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await raceWithAbort(reader.read(), signal);
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_CHECKSUM_BYTES) {
        throw new Error(`Runtime checksum response exceeds ${MAX_CHECKSUM_BYTES} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type DownloadTransferProgress = {
  transferredBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`GitHub repository must use owner/name syntax: ${repository}`);
  }
}

async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  destination: string,
  lifetime: DownloadLifetime,
  onProgress?: (progress: DownloadTransferProgress) => void,
): Promise<DownloadTransferProgress> {
  lifetime.arm(RESPONSE_TIMEOUT_MS, "archive response headers");
  const response = await fetchResponse(fetchImpl, url, lifetime.signal);
  if (!response.body) throw new Error(`GET ${url} returned no archive body.`);
  const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);

  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes =
    Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
  let transferredBytes = 0;
  let lastReportedBytes = 0;
  let output: ReturnType<typeof createWriteStream> | undefined;
  let outputClosed: Promise<void> | undefined;

  const report = (force = false): DownloadTransferProgress => {
    const percent =
      totalBytes === null ? null : Math.min(100, (transferredBytes / totalBytes) * 100);
    const progress = { transferredBytes, totalBytes, percent };
    if (
      force ||
      transferredBytes === 0 ||
      transferredBytes - lastReportedBytes >= DOWNLOAD_PROGRESS_INTERVAL_BYTES
    ) {
      lastReportedBytes = transferredBytes;
      onProgress?.(progress);
    }
    return progress;
  };

  try {
    // Large archives have no fixed total deadline: actual byte progress renews
    // the idle deadline, independently of the throttled UI progress reports.
    lifetime.arm(ARCHIVE_IDLE_TIMEOUT_MS, "archive data (idle)");
    report(true);
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          transferredBytes += chunk.byteLength;
          if (chunk.byteLength > 0) lifetime.arm(ARCHIVE_IDLE_TIMEOUT_MS, "archive data (idle)");
          report();
          callback(null, chunk);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const writer = createWriteStream(destination, { flags: "wx" });
    output = writer;
    outputClosed = new Promise<void>((resolve) => writer.once("close", resolve));
    await raceWithAbort(
      pipeline(source, meter, writer, { signal: lifetime.signal }),
      lifetime.signal,
    );
    return report(true);
  } finally {
    // A web stream may never finish cancel(). Do not await its destruction, but
    // do close our own file before the caller removes the partial download.
    source.destroy();
    output?.destroy();
    await outputClosed;
  }
}

export function checksumFromText(raw: string, expectedFileName: string): string {
  const line = raw.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/);
  if (!match?.[1]) throw new Error("Release checksum asset is not valid SHA-256 text.");
  const namedFile = match[2]?.trim();
  if (namedFile && namedFile !== expectedFileName) {
    throw new Error(`Checksum asset names ${namedFile}, expected ${expectedFileName}.`);
  }
  return match[1].toLowerCase();
}

function githubReleaseAssetUrl(opts: {
  repository: string;
  tag: string;
  fileName: string;
}): string {
  assertRepository(opts.repository);
  const repository = opts.repository.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(opts.tag)}/${encodeURIComponent(opts.fileName)}`;
}

export async function downloadRuntimeRelease(opts: {
  repository: string;
  version: string;
  tag?: string;
  asset?: RuntimeAssetId;
  host?: RuntimeHost;
  fetchImpl?: typeof fetch;
  downloadDir?: string;
  signal?: AbortSignal;
  timers?: DownloadTimers;
  log?: (line: string) => void;
  onProgress?: (progress: CoworkRuntimeBootstrapProgress) => void;
}): Promise<{
  archivePath: string;
  expectedSha256: string;
  downloadedBytes: number;
  totalBytes: number | null;
  cleanup: () => Promise<void>;
}> {
  opts.signal?.throwIfAborted();
  assertRuntimeVersion(opts.version);
  const asset = opts.asset ?? resolveRuntimeAssetForHost(opts.host ?? process);
  const fileName = runtimeAssetFileName(asset);
  const tag = opts.tag ?? runtimeReleaseTag(opts.version);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const checksumUrl = githubReleaseAssetUrl({
    repository: opts.repository,
    tag,
    fileName: `${fileName}.sha256`,
  });
  const archiveUrl = githubReleaseAssetUrl({ repository: opts.repository, tag, fileName });
  const temporary = opts.downloadDir
    ? path.resolve(opts.downloadDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-download-"));
  const archivePath = path.join(temporary, fileName);
  const partialPath = path.join(temporary, `.${fileName}.${crypto.randomUUID()}.partial`);
  const lifetime = createDownloadLifetime(opts.signal, opts.timers ?? defaultTimers);
  try {
    await fs.mkdir(temporary, { recursive: true });
    opts.log?.(`Downloading ${archiveUrl}`);
    opts.onProgress?.({
      phase: "downloading",
      version: opts.version,
      transferredBytes: 0,
      totalBytes: null,
      percent: null,
    });
    lifetime.arm(RESPONSE_TIMEOUT_MS, "the checksum response");
    const checksumResponse = await fetchResponse(fetchImpl, checksumUrl, lifetime.signal);
    const expectedSha256 = checksumFromText(
      await readChecksumResponse(checksumResponse, lifetime.signal),
      fileName,
    );
    const transfer = await downloadToFile(
      fetchImpl,
      archiveUrl,
      partialPath,
      lifetime,
      (progress) => {
        opts.onProgress?.({ phase: "downloading", version: opts.version, ...progress });
      },
    );
    lifetime.signal.throwIfAborted();
    await replaceFileAtomic(partialPath, archivePath);
    return {
      archivePath,
      expectedSha256,
      downloadedBytes: transfer.transferredBytes,
      totalBytes: transfer.totalBytes,
      cleanup: async () => {
        if (!opts.downloadDir) await fs.rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    if (!opts.downloadDir) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    lifetime.signal.throwIfAborted();
    throw error;
  } finally {
    lifetime.clear();
  }
}
