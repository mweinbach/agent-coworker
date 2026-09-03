import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";

import {
  createServerStdoutMonitor,
  main,
  normalizeProcessExitCode,
  type WebDevDependencies,
} from "../apps/desktop/scripts/start_web_dev";

const encoder = new TextEncoder();

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

function createLauncherFixture() {
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
    fileExists: () => true,
    signals,
    logger: { log: () => {}, error: (message: string) => errors.push(message) },
    startupTimeoutMs: 50,
  };
  return {
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
  test("launches the project-local Vite+ dev command through Bun", async () => {
    const fixture = createLauncherFixture();
    const started: Array<Parameters<NonNullable<WebDevDependencies["startVite"]>>[0]> = [];
    const originalStartVite = fixture.dependencies.startVite!;
    fixture.dependencies.fileExists = (candidate) =>
      String(candidate).endsWith(path.join("node_modules", "vite-plus", "bin", "vp"));
    fixture.dependencies.startVite = (options) => {
      started.push(options);
      return originalStartVite(options);
    };
    fixture.ready();
    fixture.viteExit.resolve(0);

    expect(await main([], fixture.dependencies)).toBe(0);
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

  test("terminates the server when the Vite executable is missing", async () => {
    const fixture = createLauncherFixture();
    fixture.dependencies.fileExists = () => false;
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
    const fixture = createLauncherFixture();
    fixture.dependencies.startupTimeoutMs = 1_000;
    fixture.dependencies.fileExists = () => false;
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
