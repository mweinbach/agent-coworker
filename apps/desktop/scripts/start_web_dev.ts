import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "bun";
import { cargoAvailable, resolveWorkspaceServerBinary } from "../../../scripts/workspaceRustBinary";
import {
  findPackagedSidecarLaunchCommand,
  SIDECAR_MANIFEST_NAME,
} from "../electron/services/sidecar";

const defaultRepoRoot = path.resolve(import.meta.dir, "..", "..", "..");

const STARTUP_TIMEOUT_MS = 15_000;

export type WebDevProcess = {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  stdin?: { end(): unknown } | null;
};

type WebDevSpawnOptions = {
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type WebDevDependencies = {
  startServer?: (
    options: WebDevSpawnOptions,
  ) => WebDevProcess & { stdout: ReadableStream<Uint8Array> };
  startVite?: (options: WebDevSpawnOptions) => WebDevProcess;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  signals?: {
    on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
    off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  };
  logger?: Pick<Console, "log" | "error">;
  startupTimeoutMs?: number;
};

function parseDirArg(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return "";
}

export function createServerStdoutMonitor(
  stdout: ReadableStream<Uint8Array>,
  onNonJsonLine: (line: string) => void = () => undefined,
): {
  ready: Promise<{ url: string; browserAccessToken: string | null }>;
  drained: Promise<void>;
} {
  let resolveReady!: (value: { url: string; browserAccessToken: string | null }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ url: string; browserAccessToken: string | null }>(
    (resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    },
  );

  const decoder = new TextDecoder();
  const reader = stdout.getReader();
  let readySeen = false;
  let buf = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!readySeen && parsed?.type === "server_listening" && typeof parsed.url === "string") {
        readySeen = true;
        resolveReady({
          url: parsed.url,
          browserAccessToken:
            typeof parsed.browserAccessToken === "string" && parsed.browserAccessToken.trim()
              ? parsed.browserAccessToken.trim()
              : null,
        });
        return;
      }
    } catch {
      // Non-JSON lines are human-readable server logs. Keep them visible.
    }
    onNonJsonLine(line);
  };

  const drained = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      }

      buf += decoder.decode();
      if (buf) {
        handleLine(buf);
      }
      if (!readySeen) {
        rejectReady(
          new Error("Server exited before reporting readiness. Check the log above for cause."),
        );
      }
    } catch (error) {
      if (!readySeen) {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  })();

  void drained.catch(() => {
    // The caller receives `drained`; this observer only prevents an unhandled rejection before it does.
  });

  return { ready, drained };
}

export function normalizeProcessExitCode(code: number | null | undefined): number {
  return typeof code === "number" ? code : 1;
}

async function stopProcess(child: WebDevProcess): Promise<void> {
  const forceKill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The timeout races the normal process exit, which can make a late kill fail.
    }
  }, 1_000);
  try {
    try {
      child.stdin?.end();
    } catch {
      // Ignore closed stdin pipes during shutdown.
    }
    try {
      child.kill();
    } catch {
      // A process that exited between setup and cleanup no longer accepts a kill signal.
    }
    await child.exited;
  } finally {
    clearTimeout(forceKill);
  }
}

function resolveWebDevSidecarCommand(
  root: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  const override = env.COWORK_DESKTOP_SIDECAR_PATH?.trim();
  if (override) {
    const explicitPath = path.resolve(override);
    if (!existsSync(explicitPath)) {
      throw new Error(`COWORK_DESKTOP_SIDECAR_PATH does not exist: ${explicitPath}`);
    }
    return findPackagedSidecarLaunchCommand([], { explicitPath });
  }

  // With a Rust toolchain, let Cargo build (or confirm freshness of) the server so a sidecar
  // staged by an earlier `build:desktop-resources` never shadows newer `crates/` sources.
  if (cargoAvailable(root, env)) {
    return {
      command: resolveWorkspaceServerBinary(root, env, { includeStaged: false }),
      args: [],
    };
  }

  const binariesDir = path.join(root, "apps", "desktop", "resources", "binaries");
  const hasManifest = existsSync(path.join(binariesDir, SIDECAR_MANIFEST_NAME));
  if (hasManifest) {
    try {
      return findPackagedSidecarLaunchCommand([binariesDir]);
    } catch (error) {
      // Cross-target packaging can leave another host's sidecar staged.
      console.warn(`Ignoring staged sidecar: ${error instanceof Error ? error.message : error}`);
    }
  }
  return {
    command: resolveWorkspaceServerBinary(root, env, { includeStaged: !hasManifest }),
    args: [],
  };
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: WebDevDependencies = {},
): Promise<number> {
  const startServer =
    dependencies.startServer ??
    ((options: WebDevSpawnOptions) =>
      spawn({ ...options, stdout: "pipe", stderr: "inherit", stdin: "pipe" }));
  const startVite =
    dependencies.startVite ??
    ((options: WebDevSpawnOptions) =>
      spawn({ ...options, stdout: "inherit", stderr: "inherit", stdin: "inherit" }));
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot;
  const desktopDir = path.join(repoRoot, "apps", "desktop");
  const env = dependencies.env ?? process.env;
  const signals = dependencies.signals ?? process;
  const logger = dependencies.logger ?? console;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const dirArg = parseDirArg(argv);

  const children: WebDevProcess[] = [];
  const interruption = Promise.withResolvers<number>();
  const onInterrupt = () => interruption.resolve(130);
  const onTerminate = () => interruption.resolve(143);
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  try {
    const sidecar = resolveWebDevSidecarCommand(repoRoot, env);
    const serverArgs = [...sidecar.args];
    if (dirArg) {
      serverArgs.push("--dir", dirArg);
    }
    serverArgs.push("--json");

    const serverProc = startServer({
      cmd: [sidecar.command, ...serverArgs],
      cwd: repoRoot,
      env: {
        ...env,
        FORCE_COLOR: "1",
        COWORK_REPO_ROOT: env.COWORK_REPO_ROOT?.trim() || repoRoot,
        COWORK_WEB_DESKTOP_SERVICE: "1",
        COWORK_DESKTOP_PARENT_MANAGED: "1",
      },
    });
    children.push(serverProc);

    const { ready: serverReady, drained: serverStdoutDrained } = createServerStdoutMonitor(
      serverProc.stdout,
      (line) => {
        process.stdout.write(`${line}\n`);
      },
    );
    void serverStdoutDrained.catch((error) => {
      logger.error(error instanceof Error ? error.message : String(error));
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error(`Server did not report ready within ${startupTimeoutMs}ms`)),
        startupTimeoutMs,
      );
    });
    const ready = await Promise.race([serverReady, timeoutPromise, interruption.promise]);
    clearTimeout(startupTimer);
    if (typeof ready === "number") return ready;
    const { url: serverUrl, browserAccessToken } = ready;
    const webDevPort = env.COWORK_WEB_DEV_PORT?.trim() || "8281";

    const viteBinCandidates = [
      path.join(desktopDir, "node_modules", "vite-plus", "bin", "vp"),
      path.join(repoRoot, "node_modules", "vite-plus", "bin", "vp"),
    ];
    const viteBin = viteBinCandidates.find((candidate) => existsSync(candidate));
    if (!viteBin) {
      throw new Error(`Could not find Vite+ bin; tried:\n${viteBinCandidates.join("\n")}`);
    }

    const viteProc = startVite({
      cmd: [
        process.execPath,
        viteBin,
        "dev",
        "--config",
        path.join(desktopDir, "vite.config.web.ts"),
      ],
      cwd: desktopDir,
      env: {
        ...env,
        FORCE_COLOR: "1",
        // Proxy HTTP and WebSocket traffic to the server owned by this launcher.
        COWORK_SERVER_URL: serverUrl,
        ...(browserAccessToken ? { COWORK_BROWSER_ACCESS_TOKEN: browserAccessToken } : {}),
      },
    });
    children.push(viteProc);

    logger.log("");
    logger.log("  Cowork Web Dev Mode");
    logger.log(`  Server:  ${serverUrl}`);
    if (dirArg) {
      logger.log(`  Dir:     ${dirArg}`);
    }
    logger.log(`  Web UI:  http://localhost:${webDevPort}`);
    logger.log("");
    logger.log("  Open the Web UI — the browser uses the server URL above for WebSocket traffic,");
    logger.log("  and Vite proxies /cowork HTTP routes for the browser-shell workspace actions.");
    logger.log("");

    const exit = await Promise.race([
      serverProc.exited.then((code) => ({ which: "server", code })),
      viteProc.exited.then((code) => ({ which: "vite", code })),
      interruption.promise.then((code) => ({ which: "signal", code })),
    ]);
    if (exit.which !== "signal") logger.log(`${exit.which} exited with code ${exit.code}`);
    return normalizeProcessExitCode(exit.code);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    clearTimeout(startupTimer);
    await Promise.allSettled(children.map(stopProcess));
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
