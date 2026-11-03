import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  resolveDesktopTargetTriple,
  resolvePackagedSidecarFilename,
  SIDECAR_MANIFEST_NAME,
} from "../apps/desktop/electron/services/sidecar";
import {
  createServerStdoutMonitor,
  main,
  normalizeProcessExitCode,
  type WebDevDependencies,
} from "../apps/desktop/scripts/start_web_dev";
import { buildWorkspaceBinary, resolveWorkspaceServerBinary } from "../scripts/workspaceRustBinary";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";

const encoder = new TextEncoder();
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeFixtureFile(file: string, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createStdoutStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("createServerStdoutMonitor", () => {
  test("resolves readiness and keeps draining later stdout", async () => {
    const echoed: string[] = [];
    const monitor = createServerStdoutMonitor(
      createStdoutStream([
        '{"type":"server_',
        'listening","url":"ws://127.0.0.1:7337/ws"}\n',
        "server log after ready\n",
        `${JSON.stringify({ type: "status", phase: "logged" })}\n`,
      ]),
      (line) => echoed.push(line),
    );

    await expect(monitor.ready).resolves.toEqual({
      url: "ws://127.0.0.1:7337/ws",
      browserAccessToken: null,
    });
    await expect(monitor.drained).resolves.toBeUndefined();
    expect(echoed).toEqual([
      "server log after ready",
      JSON.stringify({ type: "status", phase: "logged" }),
    ]);
  });

  test("captures the browser access token from server readiness", async () => {
    const monitor = createServerStdoutMonitor(
      createStdoutStream([
        '{"type":"server_listening","url":"ws://127.0.0.1:7337/ws","browserAccessToken":"test-token"}\n',
      ]),
    );

    await expect(monitor.ready).resolves.toEqual({
      url: "ws://127.0.0.1:7337/ws",
      browserAccessToken: "test-token",
    });
  });

  test("rejects readiness when stdout closes before the ready event", async () => {
    const monitor = createServerStdoutMonitor(createStdoutStream(["booting up\n"]));

    await expect(monitor.ready).rejects.toThrow("Server exited before reporting readiness");
    await expect(monitor.drained).resolves.toBeUndefined();
  });
});

describe("normalizeProcessExitCode", () => {
  test("preserves explicit codes and treats missing codes as failure", () => {
    expect(normalizeProcessExitCode(0)).toBe(0);
    expect(normalizeProcessExitCode(17)).toBe(17);
    expect(normalizeProcessExitCode(null)).toBe(1);
    expect(normalizeProcessExitCode(undefined)).toBe(1);
  });
});

function createLauncherFixture({ staged = true, withVite = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratchRoots()[0], "cowork-web-launch-")));
  fixtureRoots.push(root);
  const stagedBinary = path.join(
    root,
    "apps",
    "desktop",
    "resources",
    "binaries",
    resolvePackagedSidecarFilename(),
  );
  if (staged) writeFixtureFile(stagedBinary);
  if (withVite) writeFixtureFile(path.join(root, "node_modules", "vite-plus", "bin", "vp"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TARGET_DIR: "cargo output",
    CARGO_NET_OFFLINE: "true",
    COWORK_REPO_ROOT: undefined,
  };
  delete env.COWORK_DESKTOP_SIDECAR_PATH;
  const signals = new EventEmitter();
  const errors: string[] = [];
  const serverExit = Promise.withResolvers<number>();
  const viteExit = Promise.withResolvers<number>();
  const serverSignals: NodeJS.Signals[] = [];
  const viteSignals: NodeJS.Signals[] = [];
  let serverOutput!: ReadableStreamDefaultController<Uint8Array>;
  let outputClosed = false;
  const server = {
    exited: serverExit.promise,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        serverOutput = controller;
      },
    }),
    kill(signal?: NodeJS.Signals) {
      serverSignals.push(signal ?? "SIGTERM");
      if (!outputClosed) {
        outputClosed = true;
        serverOutput.close();
      }
      serverExit.resolve(143);
    },
  };
  const vite = {
    exited: viteExit.promise,
    kill(signal?: NodeJS.Signals) {
      viteSignals.push(signal ?? "SIGTERM");
      viteExit.resolve(143);
    },
  };
  const dependencies: WebDevDependencies = {
    startServer: () => server,
    startVite: () => vite,
    repoRoot: root,
    env,
    signals,
    logger: { log: () => {}, error: (message: string) => errors.push(message) },
    startupTimeoutMs: 50,
  };
  return {
    root,
    env,
    stagedBinary,
    dependencies,
    errors,
    signals,
    serverSignals,
    viteSignals,
    serverExit,
    viteExit,
    ready() {
      serverOutput.enqueue(
        encoder.encode('{"type":"server_listening","url":"ws://127.0.0.1:7337/ws"}\n'),
      );
    },
  };
}

describe("web dev process lifecycle", () => {
  test("launches the project-local Vite+ dev command through Bun and spawns the Rust sidecar", async () => {
    const fixture = createLauncherFixture();
    const startedServers: Array<Parameters<NonNullable<WebDevDependencies["startServer"]>>[0]> = [];
    const started: Array<Parameters<NonNullable<WebDevDependencies["startVite"]>>[0]> = [];
    const originalStartServer = fixture.dependencies.startServer!;
    const originalStartVite = fixture.dependencies.startVite!;
    let stdinEnded = false;
    fixture.dependencies.startServer = (options) => {
      startedServers.push(options);
      const child = originalStartServer(options);
      return Object.assign(child, {
        stdin: {
          end() {
            stdinEnded = true;
          },
        },
      });
    };
    fixture.dependencies.startVite = (options) => {
      started.push(options);
      return originalStartVite(options);
    };
    fixture.ready();
    fixture.viteExit.resolve(0);

    expect(await main(["--dir", "/private/tmp/web-dev-ws"], fixture.dependencies)).toBe(0);
    expect(startedServers).toHaveLength(1);
    expect(startedServers[0].cmd[0]).toBe(fixture.stagedBinary);
    expect(startedServers[0].cmd[0]).not.toBe(process.execPath);
    expect(startedServers[0].cmd).not.toContain("src/server/index.ts");
    expect(startedServers[0].cmd.slice(1)).toEqual(["--dir", "/private/tmp/web-dev-ws", "--json"]);
    expect(startedServers[0].env.COWORK_DESKTOP_PARENT_MANAGED).toBe("1");
    expect(startedServers[0].env.COWORK_REPO_ROOT).toBe(fixture.root);
    expect(stdinEnded).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0].cmd).toEqual([
      process.execPath,
      expect.stringContaining(path.join("node_modules", "vite-plus", "bin", "vp")),
      "dev",
      "--config",
      path.join(started[0].cwd, "vite.config.web.ts"),
    ]);
    expect(started[0].env.COWORK_SERVER_URL).toBe("ws://127.0.0.1:7337/ws");
  });

  test("builds only the server with Cargo even when a stale sidecar is staged", async () => {
    const fixture = createLauncherFixture({ staged: true });
    // A sidecar staged by an earlier desktop build (a non-runnable placeholder here) must not
    // shadow a fresh Cargo build of the checked-out sources.
    writeFixtureFile(
      path.join(fixture.root, "apps", "desktop", "resources", "binaries", SIDECAR_MANIFEST_NAME),
      JSON.stringify({
        filename: resolvePackagedSidecarFilename(),
        targetTriple: resolveDesktopTargetTriple(),
        platform: process.platform,
        arch: process.arch,
      }),
    );
    // A tiny offline crate exercises Cargo's real artifact/target-dir behavior without building Cowork.
    writeFixtureFile(
      path.join(fixture.root, "Cargo.toml"),
      '[package]\nname = "cowork-server"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    const readyUrl = "ws://127.0.0.1:12345/ws";
    writeFixtureFile(
      path.join(fixture.root, "src", "main.rs"),
      `fn main() { println!("{}", r#"{"type":"server_listening","url":"${readyUrl}"}"#); std::io::stdin().read_line(&mut String::new()).unwrap(); }`,
    );
    writeFixtureFile(
      path.join(fixture.root, "src", "bin", "unrelated.rs"),
      'compile_error!("unrelated binary was built");',
    );
    // A stale binary outside the selected target dir must not hide a missing build.
    const exe = hostPlatform() === "win32" ? "cowork-server.exe" : "cowork-server";
    writeFixtureFile(path.join(fixture.root, "target", "debug", exe));
    delete fixture.dependencies.startServer;
    fixture.dependencies.startupTimeoutMs = 1_000;
    let serverUrl: string | undefined;
    const originalStartVite = fixture.dependencies.startVite!;
    fixture.dependencies.startVite = (opts) => {
      serverUrl = opts.env.COWORK_SERVER_URL;
      return originalStartVite(opts);
    };
    fixture.viteExit.resolve(0);
    expect(await main([], fixture.dependencies)).toBe(0);
    expect(serverUrl).toBe(readyUrl);

    // The black-box test builder must refresh the same binary, not just check for its existence.
    writeFixtureFile(
      path.join(fixture.root, "src", "main.rs"),
      'fn main() { println!("updated source"); }',
    );
    const binary = buildWorkspaceBinary(fixture.root, "cowork-server", fixture.env);
    expect(path.relative(fixture.root, binary).split(path.sep)[0]).toBe("cargo output");
    expect(Bun.spawnSync([binary]).stdout.toString().trim()).toBe("updated source");
    // Two real (tiny) Cargo builds: allow for a cold toolchain on a loaded CI runner.
  }, 120_000);

  test("uses a host-triple build under an absolute CARGO_TARGET_DIR without compiling", () => {
    const fixture = createLauncherFixture({ staged: false });
    const targetDir = path.join(fixture.root, "absolute target");
    const exe = hostPlatform() === "win32" ? "cowork-server.exe" : "cowork-server";
    const candidate = path.join(targetDir, resolveDesktopTargetTriple(), "release", exe);
    writeFixtureFile(candidate);
    expect(resolveWorkspaceServerBinary(fixture.root, { CARGO_TARGET_DIR: targetDir })).toBe(
      candidate,
    );
  });

  test("reports a missing explicit override even when a staged sidecar exists", async () => {
    const fixture = createLauncherFixture();
    fixture.env.COWORK_DESKTOP_SIDECAR_PATH = path.join(fixture.root, "missing");
    expect(await main([], fixture.dependencies)).toBe(1);
    expect(fixture.errors).toContainEqual(
      expect.stringContaining("COWORK_DESKTOP_SIDECAR_PATH does not exist"),
    );
    expect(fixture.serverSignals).toEqual([]);
  });

  test("reports a failed Cargo build instead of spawning a nonexistent binary", async () => {
    const fixture = createLauncherFixture({ staged: false });
    expect(await main([], fixture.dependencies)).toBe(1);
    expect(fixture.errors).toContainEqual(
      expect.stringContaining("Failed to build cowork-server with cargo build -p cowork-server"),
    );
    expect(fixture.serverSignals).toEqual([]);
  });

  test("terminates the server when the Vite executable is missing", async () => {
    const fixture = createLauncherFixture({ withVite: false });
    fixture.ready();

    expect(await main([], fixture.dependencies)).toBe(1);

    expect(fixture.serverSignals).toEqual(["SIGTERM"]);
    expect(fixture.errors).toContainEqual(expect.stringContaining("Could not find Vite+ bin"));
  });

  test("terminates the server when spawning Vite fails", async () => {
    const fixture = createLauncherFixture();
    fixture.dependencies.startVite = () => {
      throw new Error("Vite spawn failed");
    };
    fixture.ready();

    await expect(main([], fixture.dependencies)).resolves.toBe(1);

    expect(fixture.serverSignals).toEqual(["SIGTERM"]);
    expect(fixture.errors).toEqual(["Vite spawn failed"]);
  });

  test("handles interruption while waiting for server readiness and removes listeners", async () => {
    const fixture = createLauncherFixture();
    const running = main([], fixture.dependencies);
    fixture.signals.emit("SIGINT");

    expect(await running).toBe(130);

    expect(fixture.serverSignals).toEqual(["SIGTERM"]);
    expect(fixture.viteSignals).toEqual([]);
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
  });

  test("stops both children and preserves the first child exit code", async () => {
    const fixture = createLauncherFixture();
    fixture.ready();
    fixture.viteExit.resolve(17);

    expect(await main([], fixture.dependencies)).toBe(17);

    expect(fixture.serverSignals).toEqual(["SIGTERM"]);
    expect(fixture.viteSignals).toEqual(["SIGTERM"]);
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
  });

  test("cleans up a server that never reports readiness", async () => {
    const fixture = createLauncherFixture();
    fixture.dependencies.startupTimeoutMs = 1;

    expect(await main([], fixture.dependencies)).toBe(1);

    expect(fixture.serverSignals).toEqual(["SIGTERM"]);
    expect(fixture.viteSignals).toEqual([]);
    expect(fixture.errors).toEqual(["Server did not report ready within 1ms"]);
  });

  test("waits for a real child process to exit after a startup failure", async () => {
    const children: Array<Pick<Bun.Subprocess, "kill" | "exited">> = [];
    const exits: number[] = [];
    const fixture = createLauncherFixture({ withVite: false });
    fixture.dependencies.startupTimeoutMs = 1_000;
    fixture.dependencies.startServer = () => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          'console.log(JSON.stringify({ type: "server_listening", url: "ws://127.0.0.1:7337/ws" })); setInterval(() => {}, 1000);',
        ],
        env: {},
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      children.push(child);
      void child.exited.then((code) => exits.push(code));
      return child;
    };

    try {
      expect(await main([], fixture.dependencies)).toBe(1);
      expect(children).toHaveLength(1);
      expect(exits).toHaveLength(1);
    } finally {
      for (const child of children) {
        child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited));
    }
  });
});
