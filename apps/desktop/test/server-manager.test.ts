import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

mock.module("electron", () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

const { __internal } = await import("../electron/services/serverManager");

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("desktop server manager startup parsing", () => {
  test("waitForServerListening ignores non-JSON lines and resolves on server_listening", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write("warming up\n");
    child.stdout.write(JSON.stringify({ type: "status", phase: "boot" }) + "\n");
    child.stdout.write(
      JSON.stringify({ type: "server_listening", url: "ws://127.0.0.1:1234/ws", port: 1234, cwd: "C:\\tmp" }) + "\n"
    );

    const payload = await waitPromise;
    expect(payload.url).toBe("ws://127.0.0.1:1234/ws");
    expect(payload.port).toBe(1234);
  });

  test("waitForServerListening includes recent stdout lines when process exits early", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write("warming up\n");
    child.emit("exit", 1, null);

    try {
      await waitPromise;
      throw new Error("expected startup to reject when child exits early");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("Server exited before startup JSON");
      expect(message).toContain("output=warming up");
    }
  });
});

describe("desktop server manager startup mode", () => {
  test("resolveSourceStartup does not resolve repo root when source mode is disabled", () => {
    const startup = __internal.resolveSourceStartup(false, () => {
      throw new Error("resolveRepoRoot should not be called");
    });

    expect(startup).toEqual({
      repoRoot: null,
      sourceEntry: null,
    });
  });

  test("resolveSourceStartup resolves source entry when source mode is enabled", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-repo-"));
    const sourceEntry = path.join(repoRoot, "src", "server", "index.ts");

    try {
      await fs.mkdir(path.dirname(sourceEntry), { recursive: true });
      await fs.writeFile(sourceEntry, 'console.log("ok");\n', "utf-8");

      const startup = __internal.resolveSourceStartup(true, () => repoRoot);
      expect(startup.repoRoot).toBe(repoRoot);
      expect(startup.sourceEntry).toBe(sourceEntry);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("desktop server manager bun crash detection", () => {
  test("detects bun panic output", () => {
    expect(__internal.isLikelyBunSegfault("panic(main thread): Segmentation fault at address 0x1")).toBe(true);
    expect(__internal.isLikelyBunSegfault("oh no: Bun has crashed.")).toBe(true);
    expect(__internal.isLikelyBunSegfault("normal stderr line")).toBe(false);
  });
});
