import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  __internal,
  CODEX_APP_SERVER_MANAGED_VERSION,
  updateManagedCodexAppServer,
} from "../../src/providers/codexAppServerResolver";

const homeDir = process.argv[2];
if (!homeDir || !process.send) throw new Error("Expected a test home and IPC channel");
const mode = process.argv[3];
const target = { platform: "win32" as const, arch: "x64" };
const versioned = __internal.managedExecutablePath(
  homeDir,
  CODEX_APP_SERVER_MANAGED_VERSION,
  target,
);
const versionedDir = path.dirname(versioned);
const send = (message: object) => process.send?.(message);
let releaseCopy!: () => void;
let startInstall!: () => void;
const startGate = new Promise<void>((resolve) => {
  startInstall = resolve;
});
const copyGate = new Promise<void>((resolve) => {
  releaseCopy = resolve;
});
process.on("message", (message) => {
  if (message === "start") startInstall();
  if (message === "release") releaseCopy();
});

// Observe real SQLite contention, rather than relying on a sleep to infer that
// another OS process was excluded from the activation critical section.
const exec = DatabaseSync.prototype.exec;
let reportedContention = false;
DatabaseSync.prototype.exec = function (sql) {
  try {
    return exec.call(this, sql);
  } catch (error) {
    if (sql === "BEGIN IMMEDIATE" && !reportedContention) {
      const code = (error as { code?: string; errcode?: number }).code ?? "";
      const native = (error as { errcode?: number }).errcode ?? 0;
      if (
        code.startsWith("SQLITE_BUSY") ||
        code.startsWith("SQLITE_LOCKED") ||
        (code === "ERR_SQLITE_ERROR" && ((native & 0xff) === 5 || (native & 0xff) === 6))
      ) {
        reportedContention = true;
        send({ type: "contended" });
      }
    }
    throw error;
  }
};

const copyFile = fs.copyFile;
fs.copyFile = async (source, destination, mode) => {
  await copyFile(source, destination, mode);
  const dest = String(destination);
  if (
    path.dirname(dest) === versionedDir &&
    path.basename(dest).startsWith("codex-code-mode-host.exe.tmp")
  ) {
    send({ type: "copied", temporaryPath: dest });
    await copyGate;
  }
};
const rename = fs.rename;
fs.rename = async (source, destination) => {
  await rename(source, destination);
  if (String(destination) === `${versioned}.version`) send({ type: "activated" });
};

const bytes = new Map(
  [
    ["codex-app-server", "managed app-server"],
    ["codex-code-mode-host", "managed code-mode host"],
    ["codex-command-runner", "managed command runner"],
    ["codex-windows-sandbox-setup", "managed sandbox setup"],
  ].map(([basename, content]) => [`${basename}-x86_64-pc-windows-msvc.exe`, content!] as const),
);

try {
  if (mode === "fail-before-ready") throw new Error("Injected Codex worker startup failure");
  if (mode === "exit-before-ready") process.exit(0);
  // Readiness includes imports and instrumentation, but no installation or
  // lock acquisition. Both processes can warm up before either holds a lock.
  send({ type: "ready" });
  await startGate;
  await updateManagedCodexAppServer(
    { force: true },
    {
      homeDir,
      ...target,
      expectedChecksums: Object.fromEntries(
        [...bytes].map(([name, content]) => [
          name,
          createHash("sha256").update(content).digest("hex"),
        ]),
      ),
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.includes("/releases/"))
          return Response.json({
            tag_name: `rust-v${CODEX_APP_SERVER_MANAGED_VERSION}`,
            assets: [...bytes.keys()].map((name) => ({
              name,
              browser_download_url: `https://example.test/${name}`,
            })),
          });
        const content = bytes.get(new URL(url).pathname.slice(1));
        if (!content) throw new Error(`Unexpected test asset: ${url}`);
        return new Response(content);
      }) as typeof fetch,
    },
  );
} catch (error) {
  // Preserve diagnostics independently of the IPC channel being tested.
  console.error(error);
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
