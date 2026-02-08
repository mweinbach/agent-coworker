import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mockConnectModelProvider = mock(async (_opts: any): Promise<any> => ({
  ok: true,
  provider: "openai",
  mode: "api_key",
  storageFile: "/tmp/mock/.ai-coworker/config/connections.json",
  message: "Provider key saved.",
  maskedApiKey: "sk-t...est",
}));

const mockGetAiCoworkerPaths = mock((_opts?: { homedir?: string }) => ({
  rootDir: "/tmp/mock/.ai-coworker",
  configDir: "/tmp/mock/.ai-coworker/config",
  sessionsDir: "/tmp/mock/.ai-coworker/sessions",
  logsDir: "/tmp/mock/.ai-coworker/logs",
  connectionsFile: "/tmp/mock/.ai-coworker/config/connections.json",
}));

const { startAgentServer } = await import("../src/server/startServer");

async function makeTmpProject(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-connect-test-"));
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

function sendConnectAndCollect(
  url: string,
  buildMsg: (sessionId: string) => object,
  responseCount: number,
  timeoutMs = 5000
): Promise<{ hello: any; responses: any[] }> {
  return new Promise((resolve, reject) => {
    const responses: any[] = [];
    let hello: any = null;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.close();
      reject(
        new Error(`Timed out waiting for ${responseCount} responses after connect request (got ${responses.length})`)
      );
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");

      if (!hello && msg.type === "server_hello") {
        hello = msg;
        ws.send(JSON.stringify(buildMsg(msg.sessionId)));
        return;
      }

      responses.push(msg);
      if (responses.length >= responseCount) {
        clearTimeout(timer);
        ws.close();
        resolve({ hello, responses });
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

describe("Server connect_provider flow", () => {
  beforeEach(() => {
    mockConnectModelProvider.mockReset();
    mockConnectModelProvider.mockImplementation(async (_opts: any) => ({
      ok: true,
      provider: "openai",
      mode: "api_key",
      storageFile: "/tmp/mock/.ai-coworker/config/connections.json",
      message: "Provider key saved.",
      maskedApiKey: "sk-t...est",
    }));
    mockGetAiCoworkerPaths.mockReset();
    mockGetAiCoworkerPaths.mockImplementation((_opts?: { homedir?: string }) => ({
      rootDir: "/tmp/mock/.ai-coworker",
      configDir: "/tmp/mock/.ai-coworker/config",
      sessionsDir: "/tmp/mock/.ai-coworker/sessions",
      logsDir: "/tmp/mock/.ai-coworker/logs",
      connectionsFile: "/tmp/mock/.ai-coworker/config/connections.json",
    }));
  });

  afterAll(() => {
    mock.restore();
  });

  test("connect_provider routes through session and returns assistant_message", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "google",
      },
      connectProviderImpl: mockConnectModelProvider,
      getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
    });

    try {
      const { hello, responses } = await sendConnectAndCollect(
        url,
        (sessionId) => ({
          type: "connect_provider",
          sessionId,
          provider: "openai",
          apiKey: "sk-test",
        }),
        1
      );

      expect(hello.type).toBe("server_hello");
      expect(mockConnectModelProvider).toHaveBeenCalledTimes(1);
      const call = mockConnectModelProvider.mock.calls[0][0] as any;
      expect(call.provider).toBe("openai");
      expect(call.apiKey).toBe("sk-test");
      expect(call.oauthStdioMode).toBe("pipe");

      expect(responses[0].type).toBe("assistant_message");
      expect(responses[0].text).toContain("### /connect openai");
      expect(responses[0].text).toContain("- Mode: api_key");
    } finally {
      server.stop();
    }
  });

  test("connect_provider forwards oauth log lines over websocket", async () => {
    mockConnectModelProvider.mockImplementationOnce(async (opts: any) => {
      opts.onOauthLine?.("starting oauth");
      return {
        ok: true,
        provider: "codex-cli",
        mode: "oauth",
        storageFile: "/tmp/mock/.ai-coworker/config/connections.json",
        message: "OAuth sign-in completed.",
        oauthCommand: "codex login",
      };
    });

    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "google",
      },
      connectProviderImpl: mockConnectModelProvider,
      getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
    });

    try {
      const { responses } = await sendConnectAndCollect(
        url,
        (sessionId) => ({
          type: "connect_provider",
          sessionId,
          provider: "codex-cli",
        }),
        2
      );

      const logEvt = responses.find((evt) => evt.type === "log");
      const assistantEvt = responses.find((evt) => evt.type === "assistant_message");

      expect(logEvt).toBeDefined();
      expect(logEvt.line).toContain("[connect codex-cli] starting oauth");
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toContain("### /connect codex-cli");
      expect(assistantEvt.text).toContain("- OAuth command: `codex login`");
    } finally {
      server.stop();
    }
  });
});
