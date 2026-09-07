import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config";
import {
  activateInstalledRuntime,
  buildRuntimeEnv,
  ensureCoworkRuntimeReady,
  installRuntimeArchive,
  invalidateRuntimeTrust,
  listInstalledRuntimes,
  prepareCoworkRuntimeToolEnv,
  pruneInstalledRuntimes,
  releaseAllRuntimeTrust,
  resolveCurrentRuntime,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  runtimeAttestationPath,
  __internal as runtimeIntegrityInternal,
  sha256File,
  verifyRuntime,
} from "../src/coworkRuntime";
import { withCoworkRuntimeBootstrapLock } from "../src/coworkRuntime/bootstrapLock";
import { consumerLeaseTesting } from "../src/coworkRuntime/consumerLease";
import { hostPlatform } from "../src/platform/host";
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
  consumerLeaseTesting.releaseAll();
  runtimeIntegrityInternal.setTrustVerifiedRuntimeTreeHookForTests(null);
  releaseAllRuntimeTrust();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Cowork unified runtime", () => {
  test.each(["installed startup", "activation", "pruning", "installation"] as const)(
    "holds %s mutations behind the runtime lifecycle lock",
    async (operation) => {
      const root = await tempRoot("lifecycle-lock");
      const home = path.join(root, "home");
      const version = "2026-06-21";
      const archive = await runtimeArchive(path.join(root, "archives"), version);
      await installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: archive.sha256,
        home,
        execute: false,
        trustedKeys,
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const owner = withCoworkRuntimeBootstrapLock({ home, version }, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let settled = false;
      const pending = (
        operation === "installed startup"
          ? ensureCoworkRuntimeReady({
              homedir: home,
              version,
              env: {},
              execute: false,
              trustedKeys,
            })
          : operation === "activation"
            ? activateInstalledRuntime(version, home, true)
            : operation === "pruning"
              ? pruneInstalledRuntimes(home)
              : installRuntimeArchive({
                  archivePath: archive.archivePath,
                  expectedSha256: archive.sha256,
                  home,
                  force: true,
                  execute: false,
                  trustedKeys,
                })
      ).finally(() => {
        settled = true;
      });
      void pending.catch(() => {});
      try {
        await Bun.sleep(100);
        expect(settled).toBe(false);
      } finally {
        release.resolve();
        await owner;
        await pending;
      }
      expect(await resolveCurrentRuntime(home)).toBe(
        path.join(home, ".cowork", "runtime", version),
      );
    },
  );

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

  test.each(
    (["ensure", "prepare"] as const).flatMap((mode) =>
      (["same-home", "alias-consumer", "alias-mutator", "both-alias"] as const).map(
        (aliasUse) => [mode, aliasUse] as const,
      ),
    ),
  )("%s environments remain usable across multiple releases with %s", async (mode, aliasUse) => {
    const root = await tempRoot(`consumer-${mode}`);
    const home = path.join(root, "home");
    const firstVersion = "2026-06-18";
    const archive = await runtimeArchive(path.join(root, "archives"), firstVersion);
    const first = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });
    const aliasHome = path.join(root, "alias");
    await fs.mkdir(path.join(aliasHome, ".cowork"), { recursive: true });
    await fs.symlink(
      path.join(home, ".cowork", "runtime"),
      path.join(aliasHome, ".cowork", "runtime"),
      hostPlatform() === "win32" ? "junction" : "dir",
    );
    const consumerHome =
      aliasUse === "alias-consumer" || aliasUse === "both-alias" ? aliasHome : home;
    const mutationHome =
      aliasUse === "alias-mutator" || aliasUse === "both-alias" ? aliasHome : home;
    const consumer = Bun.spawn({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, "fixtures", "runtime-consumer-worker.ts"),
        consumerHome,
        firstVersion,
        mode,
        JSON.stringify(trustedKeys),
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = consumer.stdout.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      } finally {
        reader.releaseLock();
      }
      for (const version of ["2026-06-19", "2026-06-20", "2026-06-21"]) {
        const update = await runtimeArchive(path.join(root, "archives"), version);
        await installRuntimeArchive({
          archivePath: update.archivePath,
          expectedSha256: update.sha256,
          home: mutationHome,
          execute: false,
          trustedKeys,
        });
      }
      expect((await listInstalledRuntimes(home)).map((runtime) => runtime.version)).toEqual([
        "2026-06-21",
        "2026-06-20",
        firstVersion,
      ]);
      const before = await fs.stat(first.runtimeDir);
      await expect(
        installRuntimeArchive({
          archivePath: archive.archivePath,
          expectedSha256: archive.sha256,
          home: mutationHome,
          force: true,
          execute: false,
          trustedKeys,
        }),
      ).rejects.toThrow(/in use by a live Cowork process/);
      expect((await fs.stat(first.runtimeDir)).ino).toBe(before.ino);
      expect(
        (await fs.readdir(path.dirname(first.runtimeDir))).some((entry) =>
          entry.includes(".replaced-"),
        ),
      ).toBe(false);
      consumer.stdin.end();
      const output = consumer.stdout.getReader();
      try {
        expect(new TextDecoder().decode((await output.read()).value)).toContain("node");
      } finally {
        output.releaseLock();
      }
      expect(await consumer.exited).toBe(0);
      expect(
        (await pruneInstalledRuntimes(mutationHome)).map((runtime) => runtime.version),
      ).toEqual([firstVersion]);
    } finally {
      consumer.kill("SIGKILL");
      await consumer.exited;
    }
  });

  test("clears fingerprint attestations when a runtime is pruned or replaced", async () => {
    // `<runtime-dir>.verified.json` is a trust cache. Leaving it beside a
    // pruned/replaced tree would let a later install at the same path skip
    // re-hashing against a stale fingerprint until full verify caught up.
    const root = await tempRoot("attestation-prune");
    const home = path.join(root, "home");
    const firstArchive = await runtimeArchive(path.join(root, "archives"), "2026-06-19");
    const first = await installRuntimeArchive({
      archivePath: firstArchive.archivePath,
      expectedSha256: firstArchive.sha256,
      expectedVersion: "2026-06-19",
      home,
      execute: false,
      trustedKeys,
    });
    const prunedAttestation = runtimeAttestationPath(first.runtimeDir);
    expect(JSON.parse(await fs.readFile(prunedAttestation, "utf8"))).toMatchObject({
      runtimeVersion: "2026-06-19",
    });

    for (const version of ["2026-06-20", "2026-06-21"] as const) {
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
    await expect(fs.stat(prunedAttestation)).rejects.toThrow();
    expect((await listInstalledRuntimes(home)).map((runtime) => runtime.version)).toEqual([
      "2026-06-21",
      "2026-06-20",
    ]);

    const currentDir = path.join(home, ".cowork", "runtime", "2026-06-21");
    const currentAttestation = runtimeAttestationPath(currentDir);
    await fs.writeFile(
      currentAttestation,
      `${JSON.stringify({ schemaVersion: 1, runtimeVersion: "stale-marker" }, null, 2)}\n`,
    );
    // Same version destination: install clears the old attestation, then writes a fresh one.
    const replacement = await runtimeArchive(path.join(root, "archives-replace"), "2026-06-21");
    const replaced = await installRuntimeArchive({
      archivePath: replacement.archivePath,
      expectedSha256: replacement.sha256,
      expectedVersion: "2026-06-21",
      home,
      execute: false,
      force: true,
      trustedKeys,
    });
    expect(replaced.runtimeDir).toBe(currentDir);
    const afterReplace = JSON.parse(await fs.readFile(currentAttestation, "utf8")) as {
      runtimeVersion?: string;
    };
    expect(afterReplace.runtimeVersion).toBe("2026-06-21");
  });

  test("keeps the activated runtime when pruning an older version fails", async () => {
    const root = await tempRoot("retention-failure");
    const home = path.join(root, "home");
    for (const version of ["2026-06-19", "2026-06-20"]) {
      const archive = await runtimeArchive(path.join(root, "archives"), version);
      await installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: archive.sha256,
        home,
        execute: false,
        trustedKeys,
      });
    }
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const expiredDir = path.join(home, ".cowork", "runtime", "2026-06-19");
    const originalRm = fs.rm.bind(fs);
    const remove = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === expiredDir) throw new Error("expired runtime is in use");
      await originalRm(target, options);
    });
    try {
      const installed = await installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: archive.sha256,
        home,
        execute: false,
        trustedKeys,
      });
      expect(await resolveCurrentRuntime(home)).toBe(installed.runtimeDir);
      expect((await verifyRuntime({ runtimeDir: installed.runtimeDir, trustedKeys })).ok).toBe(
        true,
      );
    } finally {
      remove.mockRestore();
    }
  });

  test.each(["rejected", "disabled"] as const)(
    "removes %s runtime executable wiring without changing unrelated tool options",
    async (runtimeState) => {
      const root = await tempRoot("rejected-tool-env");
      const home = path.join(root, "home");
      const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
      const installed = await installRuntimeArchive({
        archivePath: archive.archivePath,
        expectedSha256: archive.sha256,
        home,
        execute: false,
        trustedKeys,
      });
      const baseEnv = {
        PATH: path.join(root, "host-bin"),
        NODE_PATH: path.join(root, "host-modules"),
        NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, "host-loader.mjs")).href} --trace-warnings`,
      };
      const wired = await buildRuntimeEnv(
        installed.runtimeDir,
        baseEnv,
        hostPlatform(),
        trustedKeys,
      );
      if (runtimeState === "rejected") await fs.rm(path.join(installed.runtimeDir, "runtime.json"));

      const env = await prepareCoworkRuntimeToolEnv({
        homedir: home,
        env: {
          ...wired,
          ...(runtimeState === "disabled" ? { COWORK_DISABLE_RUNTIME: "1" } : {}),
        },
      });

      expect(env.PATH).toBe(baseEnv.PATH);
      expect(env.NODE_PATH).toBe(baseEnv.NODE_PATH);
      expect(env.NODE_OPTIONS).toBe(baseEnv.NODE_OPTIONS);
      expect(Object.keys(env).some((key) => key.startsWith("COWORK_RUNTIME_"))).toBe(false);
    },
  );

  test("serializes concurrent runtime bootstrap attempts", async () => {
    const root = await tempRoot("concurrent-bootstrap");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const logs: string[] = [];

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        ensureCoworkRuntimeReady({
          homedir: home,
          env: {},
          version: "2026-06-21",
          archivePath: archive.archivePath,
          expectedSha256: archive.sha256,
          execute: false,
          trustedKeys,
          log: (line) => logs.push(line),
        }),
      ),
    );

    expect(results.filter((result) => result?.source === "downloaded")).toHaveLength(1);
    expect(results.filter((result) => result?.source === "installed")).toHaveLength(2);
    expect(new Set(results.map((result) => result?.runtimeDir))).toEqual(
      new Set([path.join(home, ".cowork", "runtime", "2026-06-21")]),
    );
    expect(logs.some((line) => line.includes("Waiting for Cowork runtime"))).toBe(true);
    await expect(
      fs.stat(path.join(home, ".cowork", "runtime", ".bootstrap.lock")),
    ).rejects.toThrow();
    const runtimeRootEntries = await fs.readdir(path.join(home, ".cowork", "runtime"));
    expect(runtimeRootEntries.some((entry) => entry.startsWith(".staging-"))).toBe(false);
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

  test("detects runtime tampering once trust is invalidated", async () => {
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
    // Repeat uses in a process trust the earlier verification; a watcher event
    // (simulated here) clears that trust and the mutation is caught.
    invalidateRuntimeTrust(installed.runtimeDir, false);
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
    invalidateRuntimeTrust(restored.runtimeDir, false);
    await expect(
      buildRuntimeEnv(restored.runtimeDir, {}, process.platform, trustedKeys),
    ).rejects.toThrow(/runtime file (size|SHA-256) mismatch/i);
  });

  test("reuses a stored attestation instead of re-hashing an unchanged tree", async () => {
    const root = await tempRoot("attestation");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });

    const attestationPath = runtimeAttestationPath(installed.runtimeDir);
    expect(JSON.parse(await fs.readFile(attestationPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      runtimeVersion: "2026-06-21",
    });

    const filterDll = path.join(
      installed.runtimeDir,
      "dependencies",
      "libreoffice",
      "program",
      "filter.dll",
    );
    const original = await fs.readFile(filterDll, "utf8");
    // Pin an exact whole-second timestamp so the fingerprint is reproducible
    // across the rewrite below, then re-attest against it.
    const pinned = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(filterDll, pinned, pinned);
    await fs.rm(attestationPath, { force: true });
    releaseAllRuntimeTrust();
    expect(
      (await verifyRuntime({ runtimeDir: installed.runtimeDir, execute: false, trustedKeys })).ok,
    ).toBe(true);

    // Same length, same mtime: the stat fingerprint is unchanged, so the stored
    // attestation stands in for re-hashing the whole tree on every launch. This
    // is the documented limit of the fast path.
    await fs.writeFile(filterDll, "TRUSTED FILTER DLL".slice(0, original.length));
    await fs.utimes(filterDll, pinned, pinned);

    releaseAllRuntimeTrust();
    const cached = await verifyRuntime({
      runtimeDir: installed.runtimeDir,
      execute: false,
      trustedKeys,
    });
    expect(cached.ok).toBe(true);

    // The escape hatch always re-hashes, and catches it.
    releaseAllRuntimeTrust();
    const forced = await verifyRuntime({
      runtimeDir: installed.runtimeDir,
      execute: false,
      trustedKeys,
      env: { COWORK_RUNTIME_FULL_VERIFY: "1" },
    });
    expect(forced.ok).toBe(false);
    expect(forced.errors.join("\n")).toMatch(/SHA-256 mismatch/i);
  });

  test("re-collects the tree fingerprint once trust is invalidated", async () => {
    const root = await tempRoot("per-use-fingerprint");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });

    await buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys);

    // A watcher event invalidates trust; the next use then re-collects the
    // fingerprint before the cached verification is honoured, and the full
    // hash catches the mutation.
    invalidateRuntimeTrust(installed.runtimeDir, false);
    await fs.writeFile(
      path.join(installed.runtimeDir, "dependencies", "bin", "runtime-tool"),
      "a longer replacement tool",
    );
    await expect(
      buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys),
    ).rejects.toThrow(/mismatch/i);
  });

  test("rechecks runtime files on every use when the integrity watcher is unavailable", async () => {
    const root = await tempRoot("process-trust");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });
    const installedManifest = JSON.parse(
      await fs.readFile(path.join(installed.runtimeDir, "runtime.json"), "utf8"),
    );
    const nodePath = path.join(
      installed.runtimeDir,
      ...(installedManifest.paths.node as string).split("/"),
    );

    await buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys);
    // Disable the watcher so the test drives invalidation explicitly; the next
    // use re-verifies via the persisted attestation without restarting it.
    invalidateRuntimeTrust(installed.runtimeDir, false);
    await buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys);

    // Without a functioning watcher, no future event can invalidate the memo.
    // Every use must check the fingerprint even after a successful verification.
    await fs.writeFile(nodePath, "replaced node");
    await expect(
      buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys),
    ).rejects.toThrow(/runtime file (size|SHA-256) mismatch/i);
  });

  test("full-verify escape hatch bypasses the in-process verification memo", async () => {
    const root = await tempRoot("memo-full-verify");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });
    const installedManifest = JSON.parse(
      await fs.readFile(path.join(installed.runtimeDir, "runtime.json"), "utf8"),
    );
    const nodePath = path.join(
      installed.runtimeDir,
      ...(installedManifest.paths.node as string).split("/"),
    );

    await buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys);
    invalidateRuntimeTrust(installed.runtimeDir, false);
    await buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys);

    // Same length, same mtime: neither the in-process memo nor the stat
    // fingerprint can see this edit; only re-hashing the tree catches it.
    const original = await fs.readFile(nodePath, "utf8");
    const stat = await fs.stat(nodePath);
    await fs.writeFile(nodePath, "X".repeat(original.length));
    await fs.utimes(nodePath, stat.atime, stat.mtime);

    process.env.COWORK_RUNTIME_FULL_VERIFY = "1";
    try {
      await expect(
        buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys),
      ).rejects.toThrow(/SHA-256 mismatch/i);
    } finally {
      delete process.env.COWORK_RUNTIME_FULL_VERIFY;
    }
  });

  test("re-verifies when the tree fingerprint or signed manifest moves", async () => {
    const root = await tempRoot("attestation-invalidation");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });
    const installedManifest = JSON.parse(
      await fs.readFile(path.join(installed.runtimeDir, "runtime.json"), "utf8"),
    );
    const nodePath = path.join(
      installed.runtimeDir,
      ...(installedManifest.paths.node as string).split("/"),
    );

    // A different size changes the fingerprint, so the full hash runs and fails.
    await fs.writeFile(nodePath, "a much longer replacement for node");
    releaseAllRuntimeTrust();
    const resized = await verifyRuntime({
      runtimeDir: installed.runtimeDir,
      execute: false,
      trustedKeys,
    });
    expect(resized.ok).toBe(false);
    expect(resized.errors.join("\n")).toMatch(/mismatch/i);

    // An unexpected file is not in the fingerprint's path set either.
    await fs.writeFile(nodePath, "node");
    await fs.rm(runtimeAttestationPath(installed.runtimeDir), { force: true });
    releaseAllRuntimeTrust();
    expect(
      (await verifyRuntime({ runtimeDir: installed.runtimeDir, execute: false, trustedKeys })).ok,
    ).toBe(true);
    await fs.writeFile(path.join(installed.runtimeDir, "planted.dll"), "surprise");
    releaseAllRuntimeTrust();
    const planted = await verifyRuntime({
      runtimeDir: installed.runtimeDir,
      execute: false,
      trustedKeys,
    });
    expect(planted.ok).toBe(false);
    expect(planted.errors.join("\n")).toMatch(/Unexpected runtime file/i);
  });

  test("fails closed when trust is invalidated mid-entrypoint verification", async () => {
    const root = await tempRoot("mid-verify-race");
    const home = path.join(root, "home");
    const archive = await runtimeArchive(path.join(root, "archives"), "2026-06-21");
    const installed = await installRuntimeArchive({
      archivePath: archive.archivePath,
      expectedSha256: archive.sha256,
      home,
      execute: false,
      trustedKeys,
    });
    releaseAllRuntimeTrust();

    const gate = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    })();
    let verificationStarted = false;
    runtimeIntegrityInternal.setTrustVerifiedRuntimeTreeHookForTests(async (run) => {
      verificationStarted = true;
      await gate.promise;
      return run();
    });

    const verifyPromise = buildRuntimeEnv(installed.runtimeDir, {}, hostPlatform(), trustedKeys);
    const deadline = Date.now() + 2_000;
    while (!verificationStarted) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for mid-verify hook");
      }
      await Bun.sleep(5);
    }

    invalidateRuntimeTrust(installed.runtimeDir, false);
    gate.resolve();
    await expect(verifyPromise).rejects.toThrow(
      "Runtime changed while an entrypoint was being verified.",
    );
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
