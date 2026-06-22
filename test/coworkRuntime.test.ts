import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config";
import {
  buildRuntimeEnv,
  ensureCoworkRuntimeReady,
  installRuntimeArchive,
  invalidateRuntimeTrust,
  listInstalledRuntimes,
  releaseAllRuntimeTrust,
  resolveCurrentRuntime,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  sha256File,
} from "../src/coworkRuntime";
import { buildPluginCatalogSnapshot } from "../src/plugins";
import { S_IFREG, writeZip } from "./fixtures/zipBuilder";

const temporaryRoots: string[] = [];
const TEST_RUNTIME_KEY_ID = "cowork-runtime-test";
const TEST_RUNTIME_KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const trustedKeys = { [TEST_RUNTIME_KEY_ID]: TEST_RUNTIME_KEY_PAIR.publicKey };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cowork-unified-runtime-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function writeFile(filePath: string, content = "fixture"): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
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
    compatibleHosts: [`${process.platform}-${process.arch}`],
    source: {
      kind: "codex-primary-runtime",
      bundleVersion: "fixture.1",
      targetPlatform: process.platform,
      targetArch: process.arch,
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
    .sort((left, right) => left.path.localeCompare(right.path));
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

describe("Cowork unified runtime", () => {
  test("activates a verified local release while marketplace plugins remain independently owned", async () => {
    const root = await tempRoot("cutover");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    await writeFile(path.join(home, ".cache", "cowork", "artifact-runtime", "legacy.txt"));
    await writeFile(path.join(home, ".cache", "cowork", "libreoffice", "legacy.txt"));
    await writeFile(path.join(home, ".cowork", "config", "artifact-runtime.json"), "{}\n");
    await writeFile(path.join(home, ".cowork", "config", "codex-primary-runtime.json"), "{}\n");
    await writeFile(
      path.join(home, ".cowork", "plugins", "workspace-tools", ".cowork-plugin", "install.json"),
      `${JSON.stringify({ bootstrap: { name: "codex-primary-runtime", pluginId: "workspace-tools" } })}\n`,
    );
    await writeFile(
      path.join(home, ".cowork", "skills", "documents", ".cowork-skill.json"),
      `${JSON.stringify({
        version: 1,
        installationId: "bootstrap-codex-primary-runtime-documents",
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        origin: { kind: "bootstrap" },
      })}\n`,
    );
    await writeFile(
      path.join(home, ".cowork", "skills", "pdf", ".cowork-skill.json"),
      `${JSON.stringify({
        version: 1,
        installationId: "bootstrap-codex-primary-runtime-pdf",
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        origin: { kind: "bootstrap" },
      })}\n`,
    );
    await writeFile(path.join(home, ".cowork", "plugins", "keep-me", "user.txt"));
    await writeFile(
      path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "keep.txt"),
    );
    await fs.mkdir(workspace, { recursive: true });

    const result = await ensureCoworkRuntimeReady({
      homedir: home,
      env: {},
      version: "2026-06-21",
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      execute: false,
      trustedKeys,
    });

    expect(result?.runtimeDir).toBe(path.join(home, ".cowork", "runtime", "2026-06-21"));
    expect(result?.runtimeEnv.COWORK_RUNTIME_NODE_MODULES).toContain(
      path.join("dependencies", "node", "node_modules"),
    );
    expect(result?.runtimeEnv.NODE_PATH).toContain(
      path.join("node_modules", ".pnpm", "node_modules"),
    );
    expect(result?.runtimeEnv.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(result?.runtimeEnv.COWORK_RUNTIME_SOFFICE).toContain("soffice");
    expect(result?.runtimeEnv).not.toHaveProperty("COWORK_RUNTIME_PLUGINS_DIR");
    await expect(
      fs.stat(path.join(home, ".cache", "cowork", "artifact-runtime")),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(home, ".cache", "cowork", "libreoffice"))).rejects.toThrow();
    await fs.access(path.join(home, ".cowork", "plugins", "workspace-tools"));
    await fs.access(path.join(home, ".cowork", "skills", "documents"));
    await fs.access(path.join(home, ".cowork", "skills", "pdf"));
    await fs.access(path.join(home, ".cowork", "plugins", "keep-me", "user.txt"));
    await fs.access(
      path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "keep.txt"),
    );

    const marketplacePluginRoot = path.join(home, ".cowork", "plugins", "workspace-tools");
    await writeFile(
      path.join(marketplacePluginRoot, ".cowork-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "workspace-tools",
        version: "1.0.0",
        description: "Marketplace workspace tools",
        skills: "./skills",
      })}\n`,
    );
    await writeFile(
      path.join(marketplacePluginRoot, ".cowork-plugin", "install.json"),
      `${JSON.stringify({
        marketplace: {
          name: "cowork-personal",
          sourceInput:
            "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/workspace-tools",
        },
      })}\n`,
    );
    await writeFile(
      path.join(marketplacePluginRoot, "skills", "documents", "SKILL.md"),
      "---\nname: documents\ndescription: Marketplace documents fixture\n---\n",
    );

    const config = await loadConfig({
      cwd: workspace,
      homedir: home,
      builtInDir: path.resolve(import.meta.dir, ".."),
      env: result?.runtimeEnv,
    });
    const catalog = await buildPluginCatalogSnapshot(config);
    expect(catalog.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace-tools",
          scope: "user",
          marketplace: expect.objectContaining({ name: "cowork-personal" }),
        }),
      ]),
    );
    expect(catalog.plugins.flatMap((plugin) => plugin.skills)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawName: "documents",
          description: "Marketplace documents fixture",
        }),
      ]),
    );
    await expect(fs.stat(path.join(result!.runtimeDir, "plugins"))).rejects.toThrow();
  });

  test("keeps only the current runtime and one fallback", async () => {
    const root = await tempRoot("retention");
    const home = path.join(root, "home");
    for (const version of ["2026-06-19", "2026-06-20", "2026-06-21"]) {
      const archive = await runtimeArchive(path.join(root, "archives"), version);
      await installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: archive.sha256,
        expectedVersion: version,
        home,
        execute: false,
        trustedKeys,
      });
    }
    expect((await listInstalledRuntimes(home)).map((runtime) => runtime.version)).toEqual([
      "2026-06-21",
      "2026-06-20",
    ]);
    expect(await resolveCurrentRuntime(home)).toBe(
      path.join(home, ".cowork", "runtime", "2026-06-21"),
    );
  });

  test("uses the confirmed current version when a replacement cannot be installed", async () => {
    const root = await tempRoot("fallback");
    const home = path.join(root, "home");
    const currentArchive = await runtimeArchive(path.join(root, "archives"), "2026-06-20");
    await installRuntimeArchive({
      archivePath: currentArchive.archivePath,
      expectedSha256: currentArchive.sha256,
      home,
      execute: false,
      trustedKeys,
    });

    const brokenArchive = await runtimeArchive(path.join(root, "broken"), "2026-06-21");
    const result = await ensureCoworkRuntimeReady({
      homedir: home,
      env: {},
      version: "2026-06-21",
      archivePath: brokenArchive.archivePath,
      expectedSha256: "0".repeat(64),
      execute: false,
      trustedKeys,
    });
    expect(result?.source).toBe("fallback");
    expect(result?.manifest.version).toBe("2026-06-20");
  });

  test("rechecks entrypoints on every call and invalidates recursive dependency trust", async () => {
    const root = await tempRoot("tamper");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });

    await buildRuntimeEnv(installed.runtimeDir, {}, process.platform, trustedKeys);
    const manifest = JSON.parse(
      await fs.readFile(path.join(installed.runtimeDir, "runtime.json"), "utf8"),
    );
    await fs.writeFile(
      path.join(installed.runtimeDir, ...manifest.paths.node.split("/")),
      "replaced node",
    );
    await expect(
      buildRuntimeEnv(installed.runtimeDir, {}, process.platform, trustedKeys),
    ).rejects.toThrow(/runtime file (size|SHA-256) mismatch/i);

    releaseAllRuntimeTrust();
    await fs.rm(installed.runtimeDir, { recursive: true, force: true });
    const restored = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      force: true,
      execute: false,
      trustedKeys,
    });
    await buildRuntimeEnv(restored.runtimeDir, {}, process.platform, trustedKeys);
    await fs.writeFile(
      path.join(restored.runtimeDir, "dependencies", "libreoffice", "program", "filter.dll"),
      "mutated filter dll",
    );
    await Bun.sleep(75);
    await expect(
      buildRuntimeEnv(restored.runtimeDir, {}, process.platform, trustedKeys),
    ).rejects.toThrow(/runtime file (size|SHA-256) mismatch/i);
  });

  test("blocks signature tampering and unexpected files before managed execution", async () => {
    const root = await tempRoot("integrity-boundary");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });

    invalidateRuntimeTrust(installed.runtimeDir, false);
    await fs.writeFile(path.join(installed.runtimeDir, "unexpected.exe"), "surprise");
    await expect(
      buildRuntimeEnv(installed.runtimeDir, {}, process.platform, trustedKeys),
    ).rejects.toThrow("Unexpected runtime file");

    await fs.rm(path.join(installed.runtimeDir, "unexpected.exe"));
    const signaturePath = path.join(installed.runtimeDir, "runtime-integrity.sig");
    const envelope = JSON.parse(await fs.readFile(signaturePath, "utf8"));
    envelope.signature = Buffer.alloc(64).toString("base64");
    await fs.writeFile(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`);
    await expect(
      buildRuntimeEnv(installed.runtimeDir, {}, process.platform, trustedKeys),
    ).rejects.toThrow("signature is invalid");
  });
});
