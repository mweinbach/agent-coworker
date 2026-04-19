import { spawn } from "bun";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");

const STARTUP_TIMEOUT_MS = 15_000;

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
  onNonJsonLine: (line: string) => void = () => {},
): {
  ready: Promise<string>;
  drained: Promise<void>;
} {
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

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
        resolveReady(parsed.url);
      }
    } catch {
      onNonJsonLine(line);
    }
  };

  const drained = (async () => {
    try {
      while (true) {
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
        rejectReady(new Error("Server exited before reporting readiness. Check the log above for cause."));
      }
    } catch (error) {
      if (!readySeen) {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  })();

  void drained.catch(() => {});

  return { ready, drained };
}

export function normalizeProcessExitCode(code: number | null | undefined): number {
  return typeof code === "number" ? code : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const dirArg = parseDirArg(argv);

  const serverArgs = ["src/server/index.ts"];
  if (dirArg) {
    serverArgs.push("--dir", dirArg);
  }
  serverArgs.push("--json");

  const serverProc = spawn({
    cmd: ["bun", ...serverArgs],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "inherit",
    // Server doesn't need stdin; keeping it "ignore" avoids fighting Vite for the TTY.
    stdin: "ignore",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      COWORK_WEB_DESKTOP_SERVICE: "1",
    },
  });

  const { ready: serverReady, drained: serverStdoutDrained } = createServerStdoutMonitor(
    serverProc.stdout,
    (line) => {
      process.stdout.write(line + "\n");
    },
  );
  const timeoutPromise = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error(`Server did not report ready within ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS),
  );

  let serverUrl: string;
  try {
    serverUrl = await Promise.race([serverReady, timeoutPromise]);
  } catch (err) {
    console.error((err as Error).message);
    try {
      serverProc.kill();
    } catch {}
    process.exit(1);
  }

  const webDevPort = process.env.COWORK_WEB_DEV_PORT?.trim() || "8281";

  const viteArgs = [
    path.join(desktopDir, "node_modules", "vite", "bin", "vite.js"),
    "--config",
    path.join(desktopDir, "vite.config.web.ts"),
  ];

  const viteProc = spawn({
    cmd: ["bun", ...viteArgs],
    cwd: desktopDir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      // Lets the Vite config proxy /ws and /cowork to the server it actually started.
      COWORK_SERVER_URL: serverUrl,
    },
  });

  void serverStdoutDrained.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });

  console.log("");
  console.log("  Cowork Web Dev Mode");
  console.log(`  Server:  ${serverUrl}`);
  if (dirArg) {
    console.log(`  Dir:     ${dirArg}`);
  }
  console.log(`  Web UI:  http://localhost:${webDevPort}`);
  console.log("");
  console.log("  Open the Web UI — the browser uses the server URL above for WebSocket traffic,");
  console.log("  and Vite proxies /cowork HTTP routes for the browser-shell workspace actions.");
  console.log("");

  let exiting = false;
  const cleanup = (exitCode = 0) => {
    if (exiting) {
      return;
    }
    exiting = true;
    try {
      serverProc.kill();
    } catch {}
    try {
      viteProc.kill();
    } catch {}
    process.exit(exitCode);
  };

  process.on("SIGINT", () => cleanup(130));
  process.on("SIGTERM", () => cleanup(143));

  const exitCodes = await Promise.race([
    serverProc.exited.then((code) => ({ which: "server" as const, code })),
    viteProc.exited.then((code) => ({ which: "vite" as const, code })),
  ]);

  console.log(`${exitCodes.which} exited with code ${exitCodes.code}`);
  cleanup(normalizeProcessExitCode(exitCodes.code));
}

if (import.meta.main) {
  await main();
}
