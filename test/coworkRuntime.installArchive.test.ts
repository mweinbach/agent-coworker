import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  installRuntimeArchive,
  releaseAllRuntimeTrust,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  sha256File,
} from "../src/coworkRuntime";
import { hostArch, hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox";
import { S_IFREG, writeZip } from "./fixtures/zipBuilder";

const temporaryRoots: string[] = [];
const TEST_RUNTIME_KEY_ID = "cowork-runtime-install-archive-test";
const TEST_RUNTIME_KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const trustedKeys = { [TEST_RUNTIME_KEY_ID]: TEST_RUNTIME_KEY_PAIR.publicKey };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", `cowork-install-archive-${label}-`),
  );
  temporaryRoots.push(root);
  return root;
}

async function runtimeArchive(
  root: string,
  version: string,
): Promise<{
  archivePath: string;
  sha256: string;
}> {
  const asset = resolveRuntimeAssetForHost(process);
  const windows = asset === "win-x86";
  const nodePath = windows ? "dependencies/node/bin/node.exe" : "dependencies/node/bin/node";
  const pythonPath = windows ? "dependencies/python/python.exe" : "dependencies/python/bin/python3";
  const sofficePath = windows ? "dependencies/bin/soffice.exe" : "dependencies/bin/soffice";
  const libreOfficeBinary = asset.startsWith("macos-")
    ? "dependencies/libreoffice/LibreOffice.app/Contents/MacOS/soffice"
    : windows
      ? "dependencies/libreoffice/program/soffice.com"
      : "dependencies/libreoffice/program/soffice";
  const files: Record<string, string> = {
    [nodePath]: "node",
    [pythonPath]: "python",
    "dependencies/node/node_modules/@oai/artifact-tool/package.json":
      '{"name":"@oai/artifact-tool","version":"fixture"}\n',
    "dependencies/node/node_modules/fixture.txt": "modules",
    "dependencies/bin/runtime-tool": "tool",
    "cowork/node-resolver/register.mjs": "export {};\n",
    [sofficePath]: "managed soffice launcher",
    [libreOfficeBinary]: "private libreoffice executable",
    "dependencies/libreoffice/program/filter.dll": "trusted filter dll",
    "dependencies/libreoffice/cowork-libreoffice.json": '{"schemaVersion":1,"version":"26.2.3"}\n',
  };
  const unpackedBytes = Object.values(files).reduce(
    (total, content) => total + Buffer.byteLength(content),
    0,
  );
  const manifest = {
    schemaVersion: 2,
    version,
    createdAt: `${version}T00:00:00.000Z`,
    asset,
    assetFileName: runtimeAssetFileName(asset),
    compatibleHosts: [`${hostPlatform()}-${hostArch()}`],
    source: {
      kind: "codex-primary-runtime",
      bundleVersion: "fixture.1",
      targetPlatform: hostPlatform(),
      targetArch: hostArch(),
    },
    components: [],
    versions: { node: "fixture", python: "fixture", libreOffice: "26.2.3" },
    paths: {
      bin: "dependencies/bin",
      node: nodePath,
      python: pythonPath,
      nodeModules: "dependencies/node/node_modules",
      nodeResolver: "cowork/node-resolver/register.mjs",
      artifactToolPackage: "dependencies/node/node_modules/@oai/artifact-tool",
      soffice: sofficePath,
      libreOffice: "dependencies/libreoffice",
      libreOfficeBinary,
    },
    payload: { fileCount: Object.keys(files).length, unpackedBytes },
    integrity: {
      algorithm: "Ed25519",
      keyId: TEST_RUNTIME_KEY_ID,
      manifest: "runtime-integrity.json",
      signature: "runtime-integrity.sig",
    },
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const integrityFiles = [...Object.entries(files), ["runtime.json", manifestJson] as const]
    .map(([filePath, content]) => ({
      path: filePath,
      kind: "file" as const,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const closureForPath = (candidate: string): string[] => {
    const prefix = `${candidate}/`;
    return integrityFiles
      .filter((entry) => entry.path === candidate || entry.path.startsWith(prefix))
      .map((entry) => entry.path);
  };
  const integrity = {
    schemaVersion: 2,
    algorithm: "Ed25519",
    keyId: TEST_RUNTIME_KEY_ID,
    runtimeVersion: version,
    asset,
    files: integrityFiles,
    components: {},
    entrypoints: Object.fromEntries(
      Object.entries(manifest.paths).map(([name, candidate]) => [name, closureForPath(candidate)]),
    ),
  };
  const integrityJson = `${JSON.stringify(integrity, null, 2)}\n`;
  const signatureJson = `${JSON.stringify(
    {
      schemaVersion: 1,
      algorithm: "Ed25519",
      keyId: TEST_RUNTIME_KEY_ID,
      signature: sign(null, Buffer.from(integrityJson), TEST_RUNTIME_KEY_PAIR.privateKey).toString(
        "base64",
      ),
    },
    null,
    2,
  )}\n`;
  const archiveDir = path.join(root, version);
  await fs.mkdir(archiveDir, { recursive: true });
  const archivePath = await writeZip(archiveDir, [
    ...Object.entries(files).map(([name, data]) => ({ name, data, unixMode: S_IFREG | 0o755 })),
    { name: "runtime.json", data: manifestJson },
    { name: "runtime-integrity.json", data: integrityJson },
    { name: "runtime-integrity.sig", data: signatureJson },
  ]);
  return { archivePath, sha256: await sha256File(archivePath) };
}

afterEach(async () => {
  releaseAllRuntimeTrust();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("installRuntimeArchive fail-closed gates", () => {
  test("rejects malformed expected SHA-256 before extraction", async () => {
    const root = await tempRoot("bad-sha");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-08-12");

    await expect(
      installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: "not-a-hash",
        home,
        trustedKeys,
        execute: false,
      }),
    ).rejects.toThrow("Expected SHA-256 must be 64 hex characters.");
  });

  test("rejects checksum mismatches without installing", async () => {
    const root = await tempRoot("mismatch");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-08-12");
    const wrongSha = "0".repeat(64);

    await expect(
      installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: wrongSha,
        home,
        trustedKeys,
        execute: false,
      }),
    ).rejects.toThrow(
      `Runtime archive checksum mismatch (expected ${wrongSha}, got ${archive.sha256}).`,
    );

    await expect(
      fs.stat(path.join(home, ".cowork", "runtime", "2026-08-12")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refuses to overwrite an already-installed version without force", async () => {
    const root = await tempRoot("already-installed");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-08-12");

    await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      expectedVersion: "2026-08-12",
      home,
      trustedKeys,
      execute: false,
    });

    await expect(
      installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: archive.sha256,
        expectedVersion: "2026-08-12",
        home,
        trustedKeys,
        execute: false,
      }),
    ).rejects.toThrow(/Runtime 2026-08-12 is already installed at /);
  });
});
