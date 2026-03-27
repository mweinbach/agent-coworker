import { describe, expect, test } from "bun:test";
import { createRunTurn } from "../src/agent";
import { startAgentServer } from "../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer, withSession } from "./helpers/wsHarness";

describe("WebSocket harness context runtime visibility", () => {
  test("root-session turns inject harness context into the runtime system prompt", async () => {
    const tmpDir = await makeTmpProject();
    const capturedSystems: string[] = [];
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          capturedSystems.push(params.system);
          return {
            text: "done",
            responseMessages: [],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));

    try {
      await withSession(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "harness_context_set",
              sessionId,
              context: {
                runId: "run-root",
                objective: "Verify root runtime prompt injection",
                acceptanceCriteria: ["System prompt contains harness context"],
                constraints: ["Do not override safety policy"],
                metadata: { owner: "agent" },
              },
            }));
            return;
          }

          if (message.type === "harness_context") {
            ws.send(JSON.stringify({
              type: "user_message",
              sessionId,
              text: "run the task",
            }));
            return;
          }

          if (message.type === "assistant_message") {
            resolve(undefined);
          }
        },
      );

      expect(capturedSystems).toHaveLength(1);
      expect(capturedSystems[0]).toContain("## Active Harness Context");
      expect(capturedSystems[0]).toContain("- Run ID: run-root");
      expect(capturedSystems[0]).toContain("- Objective: Verify root runtime prompt injection");
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);

  test("forked child-agent turns inherit harness context in the runtime prompt", async () => {
    const tmpDir = await makeTmpProject();
    const capturedByRole = new Map<string, string[]>();
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          const roleKey = params.config.provider && Object.keys(params.tools).includes("write")
            ? "worker"
            : "unknown";
          const bucket = capturedByRole.get(roleKey) ?? [];
          bucket.push(params.system);
          capturedByRole.set(roleKey, bucket);
          return {
            text: "done",
            responseMessages: [],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));

    try {
      await withSession(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "harness_context_set",
              sessionId,
              context: {
                runId: "run-child",
                objective: "Verify child runtime prompt injection",
                acceptanceCriteria: ["Forked child sees harness context"],
                constraints: ["Do not duplicate into transcript"],
              },
            }));
            return;
          }

          if (message.type === "harness_context") {
            ws.send(JSON.stringify({
              type: "agent_spawn",
              sessionId,
              role: "worker",
              forkContext: true,
              message: "handle the child task",
            }));
            return;
          }

          if (message.type === "agent_spawned") {
            setTimeout(() => resolve(undefined), 50);
          }
        },
      );

      const workerSystems = capturedByRole.get("worker") ?? [];
      expect(workerSystems.length).toBeGreaterThan(0);
      expect(workerSystems.some((system) => system.includes("- Run ID: run-child"))).toBe(true);
      expect(workerSystems.some((system) => system.includes("- Objective: Verify child runtime prompt injection"))).toBe(true);
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);

  test("harness context survives restart and resume through the real session boundary", async () => {
    const tmpDir = await makeTmpProject();
    const first = await startAgentServer(serverOpts(tmpDir));
    let sessionId = "";

    try {
      sessionId = await withSession(
        first.url,
        ({ ws, sessionId: nextSessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "harness_context_set",
              sessionId: nextSessionId,
              context: {
                runId: "run-persisted",
                objective: "Persist harness context across restart",
                acceptanceCriteria: ["Resume returns stored harness context"],
                constraints: ["Use the real session boundary"],
              },
            }));
            return;
          }

          if (message.type === "harness_context") {
            resolve(nextSessionId);
          }
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await stopTestServer(first.server);
    }

    const second = await startAgentServer(serverOpts(tmpDir));
    try {
      const restored = await withSession<any>(
        second.url,
        ({ ws, sessionId: resumedSessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            expect(message.sessionId).toBe(sessionId);
            expect(message.isResume).toBe(true);
            ws.send(JSON.stringify({
              type: "harness_context_get",
              sessionId: resumedSessionId,
            }));
            return;
          }

          if (message.type === "harness_context") {
            resolve(message.context);
          }
        },
        { resumeSessionId: sessionId },
      );

      expect(restored).toMatchObject({
        runId: "run-persisted",
        objective: "Persist harness context across restart",
      });
    } finally {
      await stopTestServer(second.server);
    }
  }, 30_000);
});

describe("WebSocket harness golden flows", () => {
  test("ask flow works over the real session boundary", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        const answer = await params.askUser("Pick one", ["a", "b"]);
        return {
          text: `answer:${answer}`,
          responseMessages: [],
        };
      }) as any,
    }));

    try {
      const assistantText = await withSession<string>(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "start ask flow" }));
            return;
          }

          if (message.type === "ask") {
            ws.send(JSON.stringify({
              type: "ask_response",
              sessionId,
              requestId: message.requestId,
              answer: "b",
            }));
            return;
          }

          if (message.type === "assistant_message") {
            resolve(message.text);
          }
        },
      );

      expect(assistantText).toBe("answer:b");
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);

  test("approval flow handles both approve and deny responses", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        const approved = await params.approveCommand("rm -rf /tmp/example");
        return {
          text: approved ? "approved" : "denied",
          responseMessages: [],
        };
      }) as any,
    }));

    const runApprovalFlow = async (approved: boolean) => {
      return await withSession<string>(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "start approval flow" }));
            return;
          }

          if (message.type === "approval") {
            ws.send(JSON.stringify({
              type: "approval_response",
              sessionId,
              requestId: message.requestId,
              approved,
            }));
            return;
          }

          if (message.type === "assistant_message") {
            resolve(message.text);
          }
        },
      );
    };

    try {
      expect(await runApprovalFlow(true)).toBe("approved");
      expect(await runApprovalFlow(false)).toBe("denied");
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);

  test("child-agent spawn/list/wait works over the real protocol boundary", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => ({
        text: "child finished",
        responseMessages: [],
      })) as any,
    }));

    try {
      const result = await withSession<{ childId: string; listed: boolean; waited: boolean }>(
        url,
        ({ ws, sessionId, message, resolve }) => {
          const state = ((ws as any).__childFlowState ??= {
            childId: "",
            listed: false,
            waited: false,
          });

          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "agent_spawn",
              sessionId,
              role: "worker",
              message: "handle the child task",
            }));
            return;
          }

          if (message.type === "agent_spawned") {
            state.childId = message.agent.agentId;
            ws.send(JSON.stringify({ type: "agent_list_get", sessionId }));
            ws.send(JSON.stringify({
              type: "agent_wait",
              sessionId,
              agentIds: [message.agent.agentId],
              timeoutMs: 1_000,
            }));
            return;
          }

          if (message.type === "agent_list") {
            state.listed = message.agents.some((agent: any) => agent.agentId === state.childId);
          }

          if (message.type === "agent_wait_result") {
            state.waited =
              !message.timedOut
              && message.agents.some((agent: any) => agent.agentId === message.agentIds[0]);
          }

          if (state.childId && state.listed && state.waited) {
            resolve({
              childId: state.childId,
              listed: state.listed,
              waited: state.waited,
            });
          }
        },
      );

      expect(result.listed).toBe(true);
      expect(result.waited).toBe(true);
      expect(result.childId).toEqual(expect.any(String));
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);

  test("child-agent role policy is enforced on the real runtime path", async () => {
    const tmpDir = await makeTmpProject();
    const capturedToolSets: string[][] = [];
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          capturedToolSets.push(Object.keys(params.tools).sort());
          return {
            text: "done",
            responseMessages: [],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));

    const spawnRole = async (role: "explorer" | "worker") => {
      await withSession<void>(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "agent_spawn",
              sessionId,
              role,
              message: `run as ${role}`,
            }));
            return;
          }

          if (message.type === "agent_spawned") {
            setTimeout(() => resolve(undefined), 50);
          }
        },
      );
    };

    try {
      await spawnRole("explorer");
      await spawnRole("worker");

      const explorerTools = capturedToolSets[0] ?? [];
      const workerTools = capturedToolSets[1] ?? [];

      expect(explorerTools).toEqual(expect.arrayContaining(["bash", "glob", "grep", "read"]));
      expect(explorerTools).not.toContain("write");
      expect(explorerTools).not.toContain("edit");
      expect(explorerTools).not.toContain("notebookEdit");

      expect(workerTools).toEqual(expect.arrayContaining(["bash", "glob", "grep", "read", "write", "edit"]));
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);

  test("child-agent follow-up input preserves history and supports close/resume over protocol", async () => {
    const tmpDir = await makeTmpProject();
    const childMessageSnapshots: Array<Array<{ role: string; content: unknown }>> = [];
    let childTurnCount = 0;
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          childMessageSnapshots.push(
            params.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          );
          childTurnCount += 1;
          const text = childTurnCount === 1 ? "first child answer" : "second child answer";
          return {
            text,
            responseMessages: [{ role: "assistant", content: text }],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));

    try {
      const flow = await withSession<{
        childId: string;
        closed: boolean;
        resumed: boolean;
      }>(
        url,
        ({ ws, sessionId, message, resolve }) => {
          const state = ((ws as any).__followUpState ??= {
            childId: "",
            waitCount: 0,
            sawClosed: false,
            sawResumed: false,
          });

          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "agent_spawn",
              sessionId,
              role: "worker",
              message: "first task",
            }));
            return;
          }

          if (message.type === "agent_spawned") {
            state.childId = message.agent.agentId;
            ws.send(JSON.stringify({
              type: "agent_wait",
              sessionId,
              agentIds: [state.childId],
              timeoutMs: 1_000,
            }));
            return;
          }

          if (message.type === "agent_wait_result") {
            state.waitCount += 1;
            if (state.waitCount === 1) {
              ws.send(JSON.stringify({
                type: "agent_input_send",
                sessionId,
                agentId: state.childId,
                message: "second task",
              }));
              ws.send(JSON.stringify({
                type: "agent_wait",
                sessionId,
                agentIds: [state.childId],
                timeoutMs: 1_000,
              }));
              return;
            }

            if (state.waitCount === 2) {
              ws.send(JSON.stringify({
                type: "agent_close",
                sessionId,
                agentId: state.childId,
              }));
            }
            return;
          }

          if (message.type === "agent_status" && message.agent?.agentId === state.childId) {
            if (message.agent.executionState === "closed") {
              state.sawClosed = true;
              ws.send(JSON.stringify({
                type: "agent_resume",
                sessionId,
                agentId: state.childId,
              }));
              return;
            }

            if (state.sawClosed && message.agent.executionState === "completed") {
              state.sawResumed = true;
              resolve({
                childId: state.childId,
                closed: state.sawClosed,
                resumed: state.sawResumed,
              });
            }
          }
        },
      );

      expect(flow.childId).toEqual(expect.any(String));
      expect(flow.closed).toBe(true);
      expect(flow.resumed).toBe(true);
      expect(childMessageSnapshots).toHaveLength(2);
      expect(childMessageSnapshots[0]?.map((message) => message.role)).toEqual(["user"]);
      expect(childMessageSnapshots[1]?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    } finally {
      await stopTestServer(server);
    }
  }, 30_000);
});
