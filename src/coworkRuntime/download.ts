import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import {
  assertRuntimeVersion,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  runtimeReleaseTag,
} from "./platform";
import type { RuntimeAssetId, RuntimeHost } from "./types";

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`GitHub repository must use owner/name syntax: ${repository}`);
  }
}

async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  destination: string,
): Promise<void> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${url} failed with status ${response.status}: ${body.slice(0, 300)}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
    createWriteStream(destination, { flags: "wx" }),
  );
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
}): Promise<{ archivePath: string; expectedSha256: string; cleanup: () => Promise<void> }> {
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
    const checksumResponse = await fetchImpl(checksumUrl, { redirect: "follow" });
    if (!checksumResponse.ok) {
      throw new Error(`GET ${checksumUrl} failed with status ${checksumResponse.status}.`);
    }
    const expectedSha256 = checksumFromText(await checksumResponse.text(), fileName);
    await fs.rm(archivePath, { force: true });
    await downloadToFile(fetchImpl, archiveUrl, archivePath);
    return {
      archivePath,
      expectedSha256,
      cleanup: async () => {
        if (!opts.downloadDir) await fs.rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (!opts.downloadDir) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
