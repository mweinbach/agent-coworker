import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { binaryName } from "../src/platform/exec";

type JsonRpcSmokeMessage = {
  id?: string | number;
  method?: string;
  result?: {
    thread?: {
      id?: string;
    };
    threads?: unknown[];
  };
  error?: {
    code: number;
    message: string;
  };
};

function resolveServerBin(repoRoot: string): string {
  const exe = binaryName("cowork-server");
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(repoRoot, "target", profile, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Compiled ${exe} not found. Run \`cargo build -p cowork-server\` first.`);
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const serverBin = resolveServerBin(repoRoot);
  const child = spawn(
    serverBin,
    ["--dir", process.cwd(), "--host", "127.0.0.1", "--port", "0", "--json"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COWORK_DESKTOP_PARENT_MANAGED: "1",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP:
          process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );

  const url = await new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim().startsWith("{")) return;
      const evt = JSON.parse(line) as { type?: string; url?: string; wsUrl?: string };
      const wsUrl = evt.wsUrl ?? evt.url;
      if (evt.type === "server_listening" && wsUrl) {
        rl.close();
        resolve(wsUrl);
      }
    });
    child.once("exit", (code) => reject(new Error(`cowork-server exited early (${String(code)})`)));
  });

  const ws = new WebSocket(url, "cowork.jsonrpc.v1");
  let nextId = 0;

  const sendRequest = (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return id;
  };

  const shutdown = (code: number) => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    child.stdin.end();
    process.exit(code);
  };

  ws.onopen = () => {
    sendRequest("initialize", {
      clientInfo: {
        name: "ws-jsonrpc-smoke",
        version: "1.0.0",
      },
    });
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(
      typeof event.data === "string" ? event.data : "",
    ) as JsonRpcSmokeMessage;
    console.log(JSON.stringify(message));

    if (message.error) {
      shutdown(1);
      return;
    }

    if (message.id === 1) {
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
      sendRequest("thread/start", { cwd: process.cwd() });
      return;
    }

    if (message.id === 2) {
      const threadId = message.result?.thread?.id ?? "";
      if (!threadId) {
        shutdown(1);
        return;
      }
      sendRequest("thread/list", { cwd: process.cwd() });
      return;
    }

    if (message.id === 3) {
      shutdown(0);
    }
  };

  ws.onerror = () => {
    shutdown(1);
  };
}

void main();
