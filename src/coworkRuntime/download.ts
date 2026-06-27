import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import {
  assertRuntimeVersion,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  runtimeReleaseTag,
} from "./platform";
import type { CoworkRuntimeBootstrapProgress, RuntimeAssetId, RuntimeHost } from "./types";

const DOWNLOAD_PROGRESS_INTERVAL_BYTES = 1024 * 1024;

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
  onProgress?: (progress: DownloadTransferProgress) => void,
): Promise<DownloadTransferProgress> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${url} failed with status ${response.status}: ${body.slice(0, 300)}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes =
    Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
  let transferredBytes = 0;
  let lastReportedBytes = 0;

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

  report(true);
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      report();
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
    meter,
    createWriteStream(destination, { flags: "wx" }),
  );
  return report(true);
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

export function githubReleaseAssetUrl(opts: {
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
  log?: (line: string) => void;
  onProgress?: (progress: CoworkRuntimeBootstrapProgress) => void;
}): Promise<{
  archivePath: string;
  expectedSha256: string;
  downloadedBytes: number;
  totalBytes: number | null;
  cleanup: () => Promise<void>;
}> {
  assertRuntimeVersion(opts.version);
  const asset = opts.asset ?? resolveRuntimeAssetForHost(opts.host ?? process);
  const fileName = runtimeAssetFileName(asset);
  const tag = opts.tag ?? runtimeReleaseTag(opts.version);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const temporary = opts.downloadDir
    ? path.resolve(opts.downloadDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-download-"));
  await fs.mkdir(temporary, { recursive: true });
  const archivePath = path.join(temporary, fileName);
  const checksumUrl = githubReleaseAssetUrl({
    repository: opts.repository,
    tag,
    fileName: `${fileName}.sha256`,
  });
  const archiveUrl = githubReleaseAssetUrl({ repository: opts.repository, tag, fileName });
  try {
    opts.log?.(`Downloading ${archiveUrl}`);
    opts.onProgress?.({
      phase: "downloading",
      version: opts.version,
      transferredBytes: 0,
      totalBytes: null,
      percent: null,
    });
    const checksumResponse = await fetchImpl(checksumUrl, { redirect: "follow" });
    if (!checksumResponse.ok) {
      throw new Error(`GET ${checksumUrl} failed with status ${checksumResponse.status}.`);
    }
    const expectedSha256 = checksumFromText(await checksumResponse.text(), fileName);
    await fs.rm(archivePath, { force: true });
    const transfer = await downloadToFile(fetchImpl, archiveUrl, archivePath, (progress) => {
      opts.onProgress?.({ phase: "downloading", version: opts.version, ...progress });
    });
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
    if (!opts.downloadDir) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
