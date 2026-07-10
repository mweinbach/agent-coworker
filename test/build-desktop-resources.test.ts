import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import { FOUNDATION_MODELS_KOFFI_TRIPLET } from "../apps/desktop/electron/services/sidecar";
import { __internal } from "../scripts/build_desktop_resources";
import {
  computeSourceFingerprint,
  WIN_SANDBOX_PREBUILT_LOCK_NAME,
  type WinSandboxPrebuiltLock,
} from "../scripts/winSandboxPrebuilt";
import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HASH_MANIFEST_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "../src/platform/sandbox/windows";

describe("desktop resource build helpers", () => {
  test("refreshes cached Foundation Models SDK bundles missing Koffi runtime files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const dest = path.join(root, "apps", "desktop", "resources", "binaries", "tsfm-sdk");
    const sdkRoot = path.join(root, "node_modules", "tsfm-sdk");
    const koffiRoot = path.join(root, "node_modules", "koffi");
    const nativeKoffiPath = path.join(
      koffiRoot,
      "build",
      "koffi",
      FOUNDATION_MODELS_KOFFI_TRIPLET,
      "koffi.node",
    );

    try {
      await fs.mkdir(path.join(sdkRoot, "dist"), { recursive: true });
      await fs.mkdir(path.join(sdkRoot, "native"), { recursive: true });
      await fs.mkdir(path.dirname(nativeKoffiPath), { recursive: true });
      await fs.writeFile(path.join(sdkRoot, "package.json"), "{}");
      await fs.writeFile(path.join(sdkRoot, "dist", "index.js"), "export {};\n");
      await fs.writeFile(path.join(sdkRoot, "native", "libFoundationModels.dylib"), "");
      await fs.writeFile(path.join(koffiRoot, "index.js"), "module.exports = {};\n");
      await fs.writeFile(path.join(koffiRoot, "package.json"), '{"version":"test"}');
      await fs.writeFile(nativeKoffiPath, "");

      await fs.mkdir(
        path.join(dest, "node_modules", "koffi", "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET),
        { recursive: true },
      );
      await fs.mkdir(path.join(dest, "dist"), { recursive: true });
      await fs.mkdir(path.join(dest, "native"), { recursive: true });
      await fs.writeFile(path.join(dest, "dist", "index.js"), "");
      await fs.writeFile(path.join(dest, "native", "libFoundationModels.dylib"), "");
      await fs.writeFile(
        path.join(
          dest,
          "node_modules",
          "koffi",
          "build",
          "koffi",
          FOUNDATION_MODELS_KOFFI_TRIPLET,
          "koffi.node",
        ),
        "",
      );
      await fs.writeFile(path.join(dest, "stale.txt"), "stale");

      await __internal.syncFoundationModelsSdk({
        root,
        dest,
        previousFingerprint: "same",
        nextFingerprint: "same",
        platform: "darwin",
        arch: "arm64",
      });

      await expect(
        fs.stat(path.join(dest, "node_modules", "koffi", "index.js")),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(dest, "node_modules", "koffi", "package.json")),
      ).resolves.toBeDefined();
      await expect(fs.stat(path.join(dest, "stale.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("soft-disables optional Windows AI Electron packaging when the addon is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const dest = path.join(root, "apps", "desktop", "resources", "binaries", "windows-ai-electron");

    try {
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "stale.txt"), "stale");

      const inputs = await __internal.ensureWindowsAiElectronInputs(root, "win32", "x64");
      expect(inputs).toBeNull();

      await __internal.syncWindowsAiElectronPackage({
        root,
        dest,
        previousFingerprint: null,
        nextFingerprint: null,
        platform: "win32",
        arch: "x64",
      });

      await expect(fs.stat(dest)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("builds and copies the Windows sandbox helper for Windows targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const dest = path.join(
      root,
      "apps",
      "desktop",
      "resources",
      "binaries",
      WINDOWS_SANDBOX_HELPER_NAME,
    );
    const crateDir = path.join(root, "crates", "cowork-win-sandbox");
    const builtDir = path.join(crateDir, "target", "aarch64-pc-windows-msvc", "release");
    const commands: string[][] = [];

    try {
      await fs.mkdir(path.join(crateDir, "src"), { recursive: true });
      await fs.writeFile(path.join(crateDir, "Cargo.toml"), '[package]\nname = "test"\n');
      await fs.writeFile(path.join(crateDir, "Cargo.lock"), "");
      await fs.writeFile(path.join(crateDir, "src", "main.rs"), "fn main() {}\n");

      await __internal.syncWindowsSandboxHelper({
        root,
        dest,
        previousFingerprint: "old",
        nextFingerprint: "new",
        platform: "win32",
        arch: "arm64",
        commandRunner: async (command) => {
          commands.push(command);
          await fs.mkdir(builtDir, { recursive: true });
          await Promise.all([
            fs.writeFile(path.join(builtDir, WINDOWS_SANDBOX_HELPER_NAME), "helper-binary"),
            fs.writeFile(path.join(builtDir, WINDOWS_SANDBOX_SETUP_NAME), "setup-binary"),
            fs.writeFile(
              path.join(builtDir, WINDOWS_SANDBOX_COMMAND_RUNNER_NAME),
              "command-runner-binary",
            ),
          ]);
        },
      });

      expect(commands).toEqual([
        ["rustup", "target", "add", "aarch64-pc-windows-msvc"],
        [
          "cargo",
          "build",
          "--release",
          "--bins",
          "--manifest-path",
          path.join(crateDir, "Cargo.toml"),
          "--target",
          "aarch64-pc-windows-msvc",
        ],
      ]);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("helper-binary");
      await expect(
        fs.readFile(path.join(path.dirname(dest), WINDOWS_SANDBOX_SETUP_NAME), "utf8"),
      ).resolves.toBe("setup-binary");
      await expect(
        fs.readFile(path.join(path.dirname(dest), WINDOWS_SANDBOX_COMMAND_RUNNER_NAME), "utf8"),
      ).resolves.toBe("command-runner-binary");
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(dest), WINDOWS_SANDBOX_HASH_MANIFEST_NAME),
          "utf8",
        ),
      );
      expect(manifest.files).toEqual({
        [WINDOWS_SANDBOX_HELPER_NAME]: expect.stringMatching(/^[a-f0-9]{64}$/),
        [WINDOWS_SANDBOX_SETUP_NAME]: expect.stringMatching(/^[a-f0-9]{64}$/),
        [WINDOWS_SANDBOX_COMMAND_RUNNER_NAME]: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      commands.splice(0);
      await fs.writeFile(dest, "replaced-helper");
      await __internal.syncWindowsSandboxHelper({
        root,
        dest,
        previousFingerprint: "new",
        nextFingerprint: "new",
        platform: "win32",
        arch: "arm64",
        commandRunner: async (command) => {
          commands.push(command);
          await fs.mkdir(builtDir, { recursive: true });
          await Promise.all([
            fs.writeFile(path.join(builtDir, WINDOWS_SANDBOX_HELPER_NAME), "helper-binary"),
            fs.writeFile(path.join(builtDir, WINDOWS_SANDBOX_SETUP_NAME), "setup-binary"),
            fs.writeFile(
              path.join(builtDir, WINDOWS_SANDBOX_COMMAND_RUNNER_NAME),
              "command-runner-binary",
            ),
          ]);
        },
      });
      expect(commands).toHaveLength(2);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("helper-binary");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const PREBUILT_TAG = "win-sandbox-v0.0.0-test";
  const PREBUILT_ZIP_NAME = "win-sandbox-aarch64-pc-windows-msvc.zip";
  const PREBUILT_BINARIES = {
    [WINDOWS_SANDBOX_HELPER_NAME]: "prebuilt-helper",
    [WINDOWS_SANDBOX_SETUP_NAME]: "prebuilt-setup",
    [WINDOWS_SANDBOX_COMMAND_RUNNER_NAME]: "prebuilt-command-runner",
  } as const;

  // Keep one reusable in-process zip fixture so the prebuilt tests exercise real
  // archive extraction without depending on slow platform zip CLIs.
  const PREBUILT_TEST_TIMEOUT_MS = 60_000;
  let prebuiltZipBytesPromise: Promise<Buffer> | null = null;

  function sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }

  function getPrebuiltZipBytes(): Promise<Buffer> {
    prebuiltZipBytesPromise ??= (async () => {
      const zip = new JSZip();
      for (const [name, contents] of Object.entries(PREBUILT_BINARIES)) {
        zip.file(name, contents);
      }
      return Buffer.from(await zip.generateAsync({ compression: "STORE", type: "uint8array" }));
    })();
    return prebuiltZipBytesPromise;
  }

  async function setUpPrebuiltCrate(root: string): Promise<{
    crateDir: string;
    zipBytes: Buffer;
    lock: WinSandboxPrebuiltLock;
    writeLock: (lock: WinSandboxPrebuiltLock) => Promise<void>;
  }> {
    const crateDir = path.join(root, "crates", "cowork-win-sandbox");
    await fs.mkdir(path.join(crateDir, "src"), { recursive: true });
    await fs.writeFile(path.join(crateDir, "Cargo.toml"), '[package]\nname = "test"\n');
    await fs.writeFile(path.join(crateDir, "Cargo.lock"), "");
    await fs.writeFile(path.join(crateDir, "src", "main.rs"), "fn main() {}\n");

    const zipBytes = await getPrebuiltZipBytes();

    const lock: WinSandboxPrebuiltLock = {
      schemaVersion: 1,
      tag: PREBUILT_TAG,
      sourceFingerprint: await computeSourceFingerprint(crateDir),
      targets: {
        "aarch64-pc-windows-msvc": {
          zipName: PREBUILT_ZIP_NAME,
          zipSha256: sha256(zipBytes),
          files: Object.fromEntries(
            Object.entries(PREBUILT_BINARIES).map(([name, contents]) => [name, sha256(contents)]),
          ),
        },
      },
    };
    const writeLock = async (nextLock: WinSandboxPrebuiltLock) => {
      await fs.writeFile(
        path.join(crateDir, WIN_SANDBOX_PREBUILT_LOCK_NAME),
        JSON.stringify(nextLock, null, 2),
      );
    };
    await writeLock(lock);
    return { crateDir, zipBytes, lock, writeLock };
  }

  function prebuiltTest(name: string, fn: () => Promise<void>): void {
    test(name, fn, PREBUILT_TEST_TIMEOUT_MS);
  }

  function recordingFetch(responder: (url: string) => Response): {
    fetchImpl: typeof fetch;
    urls: string[];
  } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      return responder(url);
    }) as typeof fetch;
    return { fetchImpl, urls };
  }

  prebuiltTest(
    "downloads verified prebuilt Windows sandbox helpers instead of running cargo",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
      const dest = path.join(
        root,
        "apps",
        "desktop",
        "resources",
        "binaries",
        WINDOWS_SANDBOX_HELPER_NAME,
      );
      const commands: string[][] = [];

      try {
        const { zipBytes } = await setUpPrebuiltCrate(root);
        const { fetchImpl, urls } = recordingFetch(() => new Response(zipBytes));

        await __internal.syncWindowsSandboxHelper({
          root,
          dest,
          previousFingerprint: "old",
          nextFingerprint: "new",
          platform: "win32",
          arch: "arm64",
          commandRunner: async (command) => {
            commands.push(command);
          },
          fetchImpl,
          env: {},
        });

        expect(commands).toEqual([]);
        expect(urls).toEqual([
          `https://github.com/mweinbach/agent-coworker/releases/download/${PREBUILT_TAG}/${PREBUILT_ZIP_NAME}`,
        ]);
        for (const [name, contents] of Object.entries(PREBUILT_BINARIES)) {
          await expect(fs.readFile(path.join(path.dirname(dest), name), "utf8")).resolves.toBe(
            contents,
          );
        }
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(path.dirname(dest), WINDOWS_SANDBOX_HASH_MANIFEST_NAME),
            "utf8",
          ),
        );
        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.rustTarget).toBe("aarch64-pc-windows-msvc");
        expect(manifest.files).toEqual(
          Object.fromEntries(
            Object.entries(PREBUILT_BINARIES).map(([name, contents]) => [name, sha256(contents)]),
          ),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  prebuiltTest(
    "throws on a prebuilt helper hash mismatch instead of silently rebuilding",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
      const dest = path.join(
        root,
        "apps",
        "desktop",
        "resources",
        "binaries",
        WINDOWS_SANDBOX_HELPER_NAME,
      );
      const commands: string[][] = [];

      try {
        const { zipBytes, lock, writeLock } = await setUpPrebuiltCrate(root);
        const tamperedLock: WinSandboxPrebuiltLock = {
          ...lock,
          targets: {
            "aarch64-pc-windows-msvc": {
              ...lock.targets["aarch64-pc-windows-msvc"]!,
              files: {
                ...lock.targets["aarch64-pc-windows-msvc"]!.files,
                [WINDOWS_SANDBOX_HELPER_NAME]: sha256("some-other-binary"),
              },
            },
          },
        };
        await writeLock(tamperedLock);
        const { fetchImpl } = recordingFetch(() => new Response(zipBytes));

        await expect(
          __internal.syncWindowsSandboxHelper({
            root,
            dest,
            previousFingerprint: "old",
            nextFingerprint: "new",
            platform: "win32",
            arch: "arm64",
            commandRunner: async (command) => {
              commands.push(command);
            },
            fetchImpl,
            env: {},
          }),
        ).rejects.toThrow(/hash mismatch/);
        expect(commands).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  prebuiltTest(
    "throws on a prebuilt zip hash mismatch instead of silently rebuilding",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
      const dest = path.join(
        root,
        "apps",
        "desktop",
        "resources",
        "binaries",
        WINDOWS_SANDBOX_HELPER_NAME,
      );
      const commands: string[][] = [];

      try {
        const { zipBytes } = await setUpPrebuiltCrate(root);
        const tampered = Buffer.concat([zipBytes, Buffer.from("tamper")]);
        const { fetchImpl } = recordingFetch(() => new Response(tampered));

        await expect(
          __internal.syncWindowsSandboxHelper({
            root,
            dest,
            previousFingerprint: "old",
            nextFingerprint: "new",
            platform: "win32",
            arch: "arm64",
            commandRunner: async (command) => {
              commands.push(command);
            },
            fetchImpl,
            env: {},
          }),
        ).rejects.toThrow(/zip hash mismatch/);
        expect(commands).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  prebuiltTest(
    "falls back to cargo when the prebuilt lock fingerprint drifts from the crate source",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
      const dest = path.join(
        root,
        "apps",
        "desktop",
        "resources",
        "binaries",
        WINDOWS_SANDBOX_HELPER_NAME,
      );
      const crateDir = path.join(root, "crates", "cowork-win-sandbox");
      const builtDir = path.join(crateDir, "target", "aarch64-pc-windows-msvc", "release");
      const commands: string[][] = [];

      try {
        await setUpPrebuiltCrate(root);
        await fs.writeFile(path.join(crateDir, "src", "main.rs"), "fn main() { /* edited */ }\n");
        const { fetchImpl, urls } = recordingFetch(() => new Response("unused"));

        await __internal.syncWindowsSandboxHelper({
          root,
          dest,
          previousFingerprint: "old",
          nextFingerprint: "new",
          platform: "win32",
          arch: "arm64",
          commandRunner: async (command) => {
            commands.push(command);
            await fs.mkdir(builtDir, { recursive: true });
            await Promise.all(
              Object.keys(PREBUILT_BINARIES).map((name) =>
                fs.writeFile(path.join(builtDir, name), `built-${name}`),
              ),
            );
          },
          fetchImpl,
          env: {},
        });

        expect(urls).toEqual([]);
        expect(commands).toHaveLength(2);
        await expect(fs.readFile(dest, "utf8")).resolves.toBe(
          `built-${WINDOWS_SANDBOX_HELPER_NAME}`,
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  prebuiltTest(
    "skips prebuilt downloads when COWORK_WIN_SANDBOX_PREBUILT=0 or forceBuild is set",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
      const dest = path.join(
        root,
        "apps",
        "desktop",
        "resources",
        "binaries",
        WINDOWS_SANDBOX_HELPER_NAME,
      );
      const crateDir = path.join(root, "crates", "cowork-win-sandbox");
      const builtDir = path.join(crateDir, "target", "aarch64-pc-windows-msvc", "release");
      const commands: string[][] = [];
      const buildRunner = async (command: string[]) => {
        commands.push(command);
        await fs.mkdir(builtDir, { recursive: true });
        await Promise.all(
          Object.keys(PREBUILT_BINARIES).map((name) =>
            fs.writeFile(path.join(builtDir, name), `built-${name}`),
          ),
        );
      };

      try {
        await setUpPrebuiltCrate(root);
        const { fetchImpl, urls } = recordingFetch(() => new Response("unused"));

        await __internal.syncWindowsSandboxHelper({
          root,
          dest,
          previousFingerprint: "old",
          nextFingerprint: "new",
          platform: "win32",
          arch: "arm64",
          commandRunner: buildRunner,
          fetchImpl,
          env: { COWORK_WIN_SANDBOX_PREBUILT: "0" },
        });
        expect(urls).toEqual([]);
        expect(commands).toHaveLength(2);

        commands.splice(0);
        await __internal.syncWindowsSandboxHelper({
          root,
          dest,
          previousFingerprint: "old",
          nextFingerprint: "new",
          platform: "win32",
          arch: "arm64",
          commandRunner: buildRunner,
          forceBuild: true,
          fetchImpl,
          env: {},
        });
        expect(urls).toEqual([]);
        expect(commands).toHaveLength(2);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  prebuiltTest("falls back to cargo when the prebuilt release asset is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const dest = path.join(
      root,
      "apps",
      "desktop",
      "resources",
      "binaries",
      WINDOWS_SANDBOX_HELPER_NAME,
    );
    const crateDir = path.join(root, "crates", "cowork-win-sandbox");
    const builtDir = path.join(crateDir, "target", "aarch64-pc-windows-msvc", "release");
    const commands: string[][] = [];

    try {
      await setUpPrebuiltCrate(root);
      const { fetchImpl, urls } = recordingFetch(
        () => new Response("not found", { status: 404, statusText: "Not Found" }),
      );

      await __internal.syncWindowsSandboxHelper({
        root,
        dest,
        previousFingerprint: "old",
        nextFingerprint: "new",
        platform: "win32",
        arch: "arm64",
        commandRunner: async (command) => {
          commands.push(command);
          await fs.mkdir(builtDir, { recursive: true });
          await Promise.all(
            Object.keys(PREBUILT_BINARIES).map((name) =>
              fs.writeFile(path.join(builtDir, name), `built-${name}`),
            ),
          );
        },
        fetchImpl,
        env: {},
      });

      expect(urls).toHaveLength(1);
      expect(commands).toHaveLength(2);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe(`built-${WINDOWS_SANDBOX_HELPER_NAME}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prunes stale sourcemaps, tsbuildinfo files, and .DS_Store from desktop binaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const binariesDir = path.join(root, "apps", "desktop", "resources", "binaries");

    try {
      await fs.mkdir(path.join(binariesDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(binariesDir, "cowork-server-aarch64-apple-darwin"), "binary");
      await fs.writeFile(path.join(binariesDir, "index.js.map"), "sourcemap");
      await fs.writeFile(path.join(binariesDir, "index.js.map.json"), "sourcemap-json");
      await fs.writeFile(path.join(binariesDir, "tsconfig.tsbuildinfo"), "buildinfo");
      await fs.writeFile(path.join(binariesDir, ".DS_Store"), "junk");
      await fs.writeFile(path.join(binariesDir, "nested", "inner.map"), "nested sourcemap");
      await fs.writeFile(path.join(binariesDir, "nested", "keep.txt"), "keep me");

      await __internal.pruneStaleDesktopBinaryArtifacts(binariesDir);

      await expect(
        fs.stat(path.join(binariesDir, "cowork-server-aarch64-apple-darwin")),
      ).resolves.toBeDefined();
      await expect(fs.stat(path.join(binariesDir, "index.js.map"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "index.js.map.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "tsconfig.tsbuildinfo"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, ".DS_Store"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "nested", "inner.map"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "nested", "keep.txt"))).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prune is a no-op when the desktop binaries directory does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    try {
      await expect(
        __internal.pruneStaleDesktopBinaryArtifacts(
          path.join(root, "apps", "desktop", "resources", "binaries"),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
