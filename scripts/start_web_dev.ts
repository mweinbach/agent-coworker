import { spawn } from "bun";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");

const args = process.argv.slice(2);

let dirArg = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && i + 1 < args.length) {
    dirArg = args[i + 1];
    i++;
  }
}

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

let serverUrl: string | null = null;

const STARTUP_TIMEOUT_MS = 15_000;

async function readUntilListening(): Promise<void> {
  const reader = serverProc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === "server_listening") {
          serverUrl = parsed.url;
          return;
        }
      } catch {
        // Non-JSON log line; echo through.
        process.stdout.write(line + "\n");
      }
    }
  }
}

const timeoutPromise = new Promise<void>((_, reject) =>
  setTimeout(() => reject(new Error(`Server did not report ready within ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS),
);

try {
  await Promise.race([readUntilListening(), timeoutPromise]);
} catch (err) {
  console.error((err as Error).message);
  try {
    serverProc.kill();
  } catch {}
  process.exit(1);
}

if (!serverUrl) {
  console.error("Server exited before reporting readiness. Check the log above for cause.");
  process.exit(1);
}

console.log(`Server listening at ${serverUrl}`);

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

const cleanup = () => {
  try {
    serverProc.kill();
  } catch {}
  try {
    viteProc.kill();
  } catch {}
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const exitCodes = await Promise.race([
  serverProc.exited.then((code) => ({ which: "server" as const, code })),
  viteProc.exited.then((code) => ({ which: "vite" as const, code })),
]);

console.log(`${exitCodes.which} exited with code ${exitCodes.code}`);
cleanup();
