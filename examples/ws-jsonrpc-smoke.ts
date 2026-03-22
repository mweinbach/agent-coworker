import { startAgentServer } from "../src/server/startServer";

async function main() {
  const { server, url } = await startAgentServer({
    cwd: process.cwd(),
    hostname: "127.0.0.1",
    port: 0,
    env: {
      ...process.env,
      AGENT_WORKING_DIR: process.cwd(),
      COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
    },
    runTurnImpl: (async () => ({
      text: "jsonrpc smoke ok",
      responseMessages: [],
    })) as any,
  });

  const ws = new WebSocket(url, "cowork.jsonrpc.v1");
  let nextId = 0;
  let activeThreadId = "";

  const sendRequest = (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return id;
  };

  const shutdown = async (code: number) => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    void server.stop();
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
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    console.log(JSON.stringify(message));

    if (message.id === 1) {
      ws.send(JSON.stringify({ method: "initialized" }));
      sendRequest("thread/start", { cwd: process.cwd() });
      return;
    }

    if (message.id === 2) {
      activeThreadId = message.result.thread.id;
      sendRequest("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text: "reply with exactly: jsonrpc smoke ok" }],
      });
      return;
    }

    if (message.id && message.method === "item/tool/requestUserInput") {
      ws.send(JSON.stringify({ id: message.id, result: { answer: "ok" } }));
      return;
    }

    if (message.id && message.method === "item/commandExecution/requestApproval") {
      ws.send(JSON.stringify({ id: message.id, result: { decision: "accept" } }));
      return;
    }

    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      void shutdown(0);
      return;
    }

    if (message.method === "error") {
      void shutdown(1);
    }
  };

  ws.onerror = () => {
    void shutdown(1);
  };
}

void main();
