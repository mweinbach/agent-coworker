import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { WebSocket as NodeWebSocket } from "ws";

import { startAgentServer } from "../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      5_000,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });
}

async function expectWorkspaceListResponse(response: Response, tmpDir: string): Promise<void> {
  const body = (await response.json()) as {
    workspaces: Array<{ name: string; path: string }>;
  };
  expect(body.workspaces).toHaveLength(1);
  expect(body.workspaces[0]?.name).toBe(path.basename(tmpDir));
  expect(await fs.realpath(body.workspaces[0]?.path ?? "")).toBe(await fs.realpath(tmpDir));
}

function waitForNodeWsOpen(ws: NodeWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      5_000,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForNodeWsJson(ws: NodeWebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket message")),
      5_000,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof data === "string" ? data : data.toString("utf8")));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForSingleMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket message")),
      5_000,
    );
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof event.data === "string" ? event.data : ""));
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });
}

async function expectNoMessage(ws: WebSocket, durationMs = 150): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      resolve();
    }, durationMs);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Unexpected websocket message: ${typeof event.data === "string" ? event.data : "<binary>"}`,
        ),
      );
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });
}

async function requestRawWebSocketUpgrade(
  url: string,
  options: string | { origin?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  const parsed = new URL(url);
  const origin = typeof options === "string" ? options : options.origin;
  const extraHeaders = typeof options === "string" ? {} : (options.headers ?? {});
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(Number(parsed.port), parsed.hostname, () => {
      socket.write(
        [
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Protocol: cowork.jsonrpc.v1",
          ...(origin ? [`Origin: ${origin}`] : []),
          ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(raw);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("Timed out waiting for upgrade response"));
    });
  });
}

describe("server JSON-RPC websocket mode", () => {
  test("requires the browser access token for no-origin websocket upgrades on network-exposed listeners", async () => {
    const tmpDir = await makeTmpProject();
    const { server, browserAccessToken } = await startAgentServer(
      serverOpts(tmpDir, {
        hostname: "0.0.0.0",
      }),
    );
    const connectUrl = `ws://127.0.0.1:${server.port}/ws`;

    try {
      expect(typeof browserAccessToken).toBe("string");
      const unauthorized = await requestRawWebSocketUpgrade(connectUrl);
      expect(unauthorized).toStartWith("HTTP/1.1 401");
      expect(unauthorized).toContain("Unauthorized server access");

      const authorized = await requestRawWebSocketUpgrade(
        `${connectUrl}?coworkBrowserToken=${encodeURIComponent(browserAccessToken ?? "")}`,
      );
      expect(authorized).toStartWith("HTTP/1.1 101");
    } finally {
      await stopTestServer(server);
    }
  });

  test("keeps no-origin websocket upgrades open on loopback listeners", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url, browserAccessToken } = await startAgentServer(serverOpts(tmpDir));

    try {
      expect(browserAccessToken).toBeUndefined();
      const response = await requestRawWebSocketUpgrade(url);
      expect(response).toStartWith("HTTP/1.1 101");
    } finally {
      await stopTestServer(server);
    }
  });

  test("rejects websocket upgrades from non-loopback browser origins", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const response = await requestRawWebSocketUpgrade(url, "https://evil.example");
      expect(response).toStartWith("HTTP/1.1 403");
      expect(response).toContain("Forbidden origin");
    } finally {
      await stopTestServer(server);
    }
  });

  test("requires the browser access token for loopback-origin websocket upgrades", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url, browserAccessToken } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          COWORK_WEB_DESKTOP_SERVICE: "1",
        },
      }),
    );

    try {
      expect(typeof browserAccessToken).toBe("string");
      const unauthorized = await requestRawWebSocketUpgrade(url, "http://localhost:5173");
      expect(unauthorized).toStartWith("HTTP/1.1 401");
      expect(unauthorized).toContain("Unauthorized browser access");

      const authorized = await requestRawWebSocketUpgrade(
        `${url}?coworkBrowserToken=${encodeURIComponent(browserAccessToken ?? "")}`,
        "http://localhost:5173",
      );
      expect(authorized).toStartWith("HTTP/1.1 101");
    } finally {
      await stopTestServer(server);
    }
  });

  test("allows packaged file-origin websocket upgrades with the browser access token", async () => {
    const tmpDir = await makeTmpProject();
    const browserAccessToken = "packaged-renderer-browser-token";
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          COWORK_BROWSER_ACCESS_TOKEN: browserAccessToken,
        },
      }),
    );

    try {
      const unauthorized = await requestRawWebSocketUpgrade(url, "file://");
      expect(unauthorized).toStartWith("HTTP/1.1 401");
      expect(unauthorized).toContain("Unauthorized browser access");

      const authorized = await requestRawWebSocketUpgrade(
        `${url}?coworkBrowserToken=${encodeURIComponent(browserAccessToken)}`,
        "file://",
      );
      expect(authorized).toStartWith("HTTP/1.1 101");

      const nullOriginAuthorized = await requestRawWebSocketUpgrade(
        `${url}?coworkBrowserToken=${encodeURIComponent(browserAccessToken)}`,
        "null",
      );
      expect(nullOriginAuthorized).toStartWith("HTTP/1.1 101");
    } finally {
      await stopTestServer(server);
    }
  });

  test("allows browser preflight but protects cowork HTTP routes with the browser token", async () => {
    const tmpDir = await makeTmpProject();
    const desktopUserDataDir = path.join(tmpDir, ".cowork", "web-desktop-test-data");
    const { server, browserAccessToken } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          COWORK_WEB_DESKTOP_SERVICE: "1",
          COWORK_DESKTOP_USER_DATA_DIR: desktopUserDataDir,
        },
      }),
    );
    const httpBase = `http://127.0.0.1:${server.port}`;

    try {
      expect(typeof browserAccessToken).toBe("string");
      const preflight = await fetch(`${httpBase}/cowork/workspaces`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Headers": "X-Cowork-Browser-Token",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain(
        "X-Cowork-Browser-Token",
      );

      const unauthorized = await fetch(`${httpBase}/cowork/workspaces`, {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`${httpBase}/cowork/workspaces`, {
        headers: {
          Origin: "http://localhost:5173",
          "X-Cowork-Browser-Token": browserAccessToken ?? "",
        },
      });
      expect(authorized.status).toBe(200);
      await expectWorkspaceListResponse(authorized, tmpDir);
    } finally {
      await stopTestServer(server);
    }
  });

  test("requires the browser access token for no-origin cowork HTTP routes on network-exposed listeners", async () => {
    const tmpDir = await makeTmpProject();
    const { server, browserAccessToken } = await startAgentServer(
      serverOpts(tmpDir, {
        hostname: "0.0.0.0",
      }),
    );
    const httpBase = `http://127.0.0.1:${server.port}`;

    try {
      expect(typeof browserAccessToken).toBe("string");
      const unauthorized = await fetch(`${httpBase}/cowork/workspaces`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.text()).toBe("Unauthorized server access");

      const authorized = await fetch(`${httpBase}/cowork/workspaces`, {
        headers: {
          "X-Cowork-Browser-Token": browserAccessToken ?? "",
        },
      });
      expect(authorized.status).toBe(200);
      await expectWorkspaceListResponse(authorized, tmpDir);
    } finally {
      await stopTestServer(server);
    }
  });

  test("jsonrpc is the default websocket protocol", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url);
      await waitForOpen(ws);
      // JSON-RPC mode requires initialize handshake — no immediate server_hello
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 1,
          method: "thread/list",
          params: {},
        }),
      );
      const notInitialized = await waitForSingleMessage(ws);
      expect(notInitialized.error?.code).toBe(-32002);
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("JSON-RPC subprotocol mode requires initialize handshake", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 1,
          method: "thread/list",
          params: {},
        }),
      );
      const notInitialized = await waitForSingleMessage(ws);
      expect(notInitialized).toEqual({
        id: 1,
        error: {
          code: -32002,
          message: "Not initialized",
        },
      });

      ws.send(
        JSON.stringify({
          id: 2,
          method: "initialize",
          params: {
            clientInfo: {
              name: "test-client",
              version: "1.0.0",
            },
          },
        }),
      );
      const initializeResponse = await waitForSingleMessage(ws);
      expect(initializeResponse.id).toBe(2);
      expect(initializeResponse.result.protocolVersion).toBe("0.1");
      expect(initializeResponse.result.transport.protocolMode).toBe("jsonrpc");

      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 3,
          method: "thread/list",
          params: {},
        }),
      );
      const listedThreads = await waitForSingleMessage(ws);
      expect(listedThreads).toEqual({
        id: 3,
        result: {
          threads: [],
        },
      });
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  }, 15_000);

  test("subprotocol JSON-RPC mode initializes without sending an implicit hello", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      await expectNoMessage(ws);
      expect(ws.protocol).toBe("cowork.jsonrpc.v1");

      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "subprotocol-client",
            },
          },
        }),
      );
      const response = await waitForSingleMessage(ws);
      expect(response.id).toBe(1);
      expect(response.result.serverInfo.subprotocol).toBe("cowork.jsonrpc.v1");
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("multi-offer websocket clients preserve a supported first-offer JSON-RPC subprotocol on the wire", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new NodeWebSocket(url, ["cowork.jsonrpc.v1", "foo"]);
      await waitForNodeWsOpen(ws);
      expect(ws.protocol).toBe("cowork.jsonrpc.v1");

      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "multi-offer-client",
            },
          },
        }),
      );
      const response = await waitForNodeWsJson(ws);
      expect(response.id).toBe(1);
      expect(response.result.serverInfo.subprotocol).toBe("cowork.jsonrpc.v1");
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("JSON-RPC returns -32001 when the request queue is overloaded", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
          COWORK_WS_JSONRPC_MAX_PENDING_REQUESTS: "0",
        },
      }),
    );

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "test-client",
            },
          },
        }),
      );
      await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 2,
          method: "thread/list",
          params: {},
        }),
      );
      const overloaded = await waitForSingleMessage(ws);
      expect(overloaded).toEqual({
        id: 2,
        error: {
          code: -32001,
          message: "Server overloaded; retry later.",
        },
      });
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("JSON-RPC workspace control routes fall back to the server cwd when params.cwd is omitted", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "test-client",
            },
          },
        }),
      );
      await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 2,
          method: "cowork/provider/status/refresh",
          params: {},
        }),
      );
      const response = await waitForSingleMessage(ws);
      expect(response.id).toBe(2);
      expect(response.result?.event?.type).toBe("provider_status");
      expect(Array.isArray(response.result?.event?.providers)).toBe(true);
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  }, 15_000);

  test("thread/list isolates one-off chat cwd histories", async () => {
    const tmpDir = await makeTmpProject();
    const chatA = path.join(tmpDir, ".cowork", "chats", "20260516-chat-a");
    const chatB = path.join(tmpDir, ".cowork", "chats", "20260516-chat-b");
    await fs.mkdir(chatA, { recursive: true });
    await fs.mkdir(chatB, { recursive: true });
    const realChatA = await fs.realpath(chatA);
    const realChatB = await fs.realpath(chatB);
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "test-client" } },
        }),
      );
      await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: chatA } }));
      const startedA = await waitForSingleMessage(ws);
      await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ id: 3, method: "thread/start", params: { cwd: chatB } }));
      const startedB = await waitForSingleMessage(ws);
      await waitForSingleMessage(ws);

      ws.send(JSON.stringify({ id: 4, method: "thread/list", params: { cwd: chatA } }));
      const listedA = await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ id: 5, method: "thread/list", params: { cwd: chatB } }));
      const listedB = await waitForSingleMessage(ws);

      expect(listedA.result.threads.map((thread: { id: string }) => thread.id)).toEqual([
        startedA.result.thread.id,
      ]);
      expect(listedB.result.threads.map((thread: { id: string }) => thread.id)).toEqual([
        startedB.result.thread.id,
      ]);
      expect(startedA.result.thread.cwd).toBe(realChatA);
      expect(startedB.result.thread.cwd).toBe(realChatB);
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  }, 15_000);
});
