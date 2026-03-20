import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StartAgentServerOptions } from "../../src/server/startServer";

export async function makeTmpProject(prefix = "agent-harness-ws-"): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

export function serverOpts(
  tmpDir: string,
  overrides?: Partial<StartAgentServerOptions>,
): StartAgentServerOptions {
  return {
    cwd: tmpDir,
    hostname: "127.0.0.1",
    port: 0,
    homedir: tmpDir,
    env: {
      AGENT_WORKING_DIR: tmpDir,
      AGENT_PROVIDER: "google",
      COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
    },
    ...overrides,
  };
}

export function withSession<T>(
  url: string,
  handler: (args: {
    ws: WebSocket;
    sessionId: string;
    message: any;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }) => void,
  options?: {
    resumeSessionId?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const settled = { value: false };
    let activeSessionId = options?.resumeSessionId ?? "";
    const endpoint = options?.resumeSessionId ? `${url}?resumeSessionId=${options.resumeSessionId}` : url;
    const ws = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      if (settled.value) return;
      settled.value = true;
      ws.close();
      reject(new Error("Timed out waiting for websocket flow"));
    }, options?.timeoutMs ?? 10_000);

    const finishResolve = (value: T) => {
      if (settled.value) return;
      settled.value = true;
      clearTimeout(timeout);
      ws.close();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled.value) return;
      settled.value = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "");

      if (message.type === "server_hello") {
        activeSessionId = message.sessionId;
      }
      if (!activeSessionId) return;

      handler({
        ws,
        sessionId: activeSessionId,
        message,
        resolve: finishResolve,
        reject: finishReject,
      });
    };

    ws.onerror = (event) => {
      finishReject(new Error(`WebSocket error: ${event}`));
    };
  });
}
