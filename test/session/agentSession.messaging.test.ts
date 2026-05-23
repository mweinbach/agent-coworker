import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  flushAsyncWork,
  fs,
  getSupportedModel,
  isRecord,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  type SessionCostTracker,
  waitForCondition,
  withEnv,
} from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  describe("sendUserMessage", () => {
    test("rejects if already running (emits error)", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendUserMessage("second");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;
    });

    test("sets running=true then false after completion", async () => {
      const { session, events } = makeSession();

      let wasRunningDuringExecution = false;

      mockRunTurn.mockImplementation(async () => {
        await session.sendUserMessage("concurrent");
        const busyError = events.find(
          (e) => e.type === "error" && (e as any).message === "Agent is busy",
        );
        wasRunningDuringExecution = busyError !== undefined;
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");
      expect(wasRunningDuringExecution).toBe(true);

      events.length = 0;
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));
      await session.sendUserMessage("after");
      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeUndefined();
    });

    test("emits session_busy true then false", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const p = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const busyTrueIdx = events.findIndex(
        (e) => e.type === "session_busy" && (e as any).busy === true,
      );
      const busyFalseIdx = events.findIndex(
        (e) => e.type === "session_busy" && (e as any).busy === false,
      );
      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBe(-1);

      resolveRunTurn();
      await p;

      const busyFalseIdxAfter = events.findIndex(
        (e) => e.type === "session_busy" && (e as any).busy === false,
      );
      expect(busyFalseIdxAfter).toBeGreaterThan(busyTrueIdx);
    });

    test("persists partial progress and messages when runTurn fails with responseMessages attached to the error", async () => {
      const { session, events } = makeSession();

      const partialMessages = [
        { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      ];
      mockRunTurn.mockImplementation(async () => {
        const error = new Error("Mocked execution failure midway");
        (error as any).responseMessages = partialMessages;
        throw error;
      });

      await session.sendUserMessage("trigger error");

      // Verify that the error event was emitted
      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("Mocked execution failure midway");

      // Verify that the partial messages were appended to the history
      const history = (session as any).state.allMessages;
      expect(
        history.some(
          (m: any) => m.role === "assistant" && m.content[0]?.text === "Working on it...",
        ),
      ).toBe(true);
    });

    test("records provider failure usage once when runTurn throws with usage", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async () => {
        const error = new Error("Provider failed after billing usage");
        (error as any).usage = {
          promptTokens: 12,
          completionTokens: 6,
          totalTokens: 18,
        };
        throw error;
      });

      await session.sendUserMessage("trigger billed error");

      const usageEvents = events.filter((e) => e.type === "turn_usage") as Array<
        Extract<SessionEvent, { type: "turn_usage" }>
      >;
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.usage).toEqual({
        promptTokens: 12,
        completionTokens: 6,
        totalTokens: 18,
        estimatedCostUsd: 0.000024,
      });

      const tracker = (session as any).state.costTracker as SessionCostTracker;
      const compact = tracker.getCompactSnapshot();
      expect(compact.totalPromptTokens).toBe(12);
      expect(compact.totalCompletionTokens).toBe(6);
      expect(compact.totalTokens).toBe(18);
      expect(compact.turns[0]?.usage).toEqual({
        promptTokens: 12,
        completionTokens: 6,
        totalTokens: 18,
      });
    });

    test("defers external skill refresh until the active turn completes", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "Refreshed system prompt",
        discoveredSkills: [{ name: "refreshed-skill", description: "Refreshed skill" }],
      }));
      const { session, events } = makeSession({ loadSystemPromptWithSkillsImpl });

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      await session.refreshSkillStateFromExternalMutation("skills.shared_refresh");
      expect(loadSystemPromptWithSkillsImpl).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "skills_list")).toBe(false);

      resolveRunTurn();
      await turnPromise;
      await waitForCondition(() => events.some((event) => event.type === "skills_list"));

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
      const busyFalseIdx = events.findIndex(
        (event) => event.type === "session_busy" && (event as any).busy === false,
      );
      const skillsListIdx = events.findIndex((event) => event.type === "skills_list");
      expect(busyFalseIdx).toBeGreaterThanOrEqual(0);
      expect(skillsListIdx).toBeGreaterThan(busyFalseIdx);
    });

    test("accepts steer_message for the active turn without emitting another busy=true", async () => {
      const { session, events } = makeSession();

      let capturedPrepareStep:
        | ((step: { stepNumber: number; messages: any[] }) => Promise<any>)
        | undefined;
      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        (params: any) =>
          new Promise((resolve) => {
            capturedPrepareStep = params.prepareStep;
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const busyTrue = events.find(
        (e) => e.type === "session_busy" && (e as any).busy === true,
      ) as any;
      expect(busyTrue?.turnId).toBeTruthy();

      await session.sendSteerMessage("narrow the scope", busyTrue.turnId, "steer-1");

      const steerAccepted = events.find((e) => e.type === "steer_accepted") as
        | Extract<SessionEvent, { type: "steer_accepted" }>
        | undefined;
      expect(steerAccepted).toBeDefined();
      expect(steerAccepted?.turnId).toBe(busyTrue.turnId);
      expect(
        events.filter((e) => e.type === "session_busy" && (e as any).busy === true),
      ).toHaveLength(1);
      expect(
        events.some((e) => e.type === "user_message" && (e as any).text === "narrow the scope"),
      ).toBe(false);

      await capturedPrepareStep?.({
        stepNumber: 1,
        messages: [{ role: "user", content: "go" }],
      });

      resolveRunTurn();
      await turnPromise;
    });

    test("rejects steer_message for the wrong active turn id", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendSteerMessage("continue", "wrong-turn", "steer-wrong");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt?.message).toBe("Active turn mismatch.");
      expect(events.some((e) => e.type === "steer_accepted")).toBe(false);

      resolveRunTurn();
      await turnPromise;
    });

    test("commits an accepted steer only when prepareStep drains it", async () => {
      const { session, events } = makeSession();
      let capturedPrepareStep:
        | ((step: { stepNumber: number; messages: any[] }) => Promise<any>)
        | undefined;
      let resolveRunTurn!: () => void;

      mockRunTurn.mockImplementation(async (params: any) => {
        capturedPrepareStep = params.prepareStep;
        await new Promise<void>((resolve) => {
          resolveRunTurn = resolve;
        });
        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "done" }],
        };
      });

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const activeTurnId = session.activeTurnId;
      expect(activeTurnId).toBeTruthy();
      await session.sendSteerMessage("mention the queue behavior", activeTurnId!, "steer-commit");

      expect(
        (session as any).state.allMessages.some(
          (message: any) => message.content === "mention the queue behavior",
        ),
      ).toBe(false);
      expect(
        events.some(
          (e) => e.type === "user_message" && (e as any).clientMessageId === "steer-commit",
        ),
      ).toBe(false);

      const baseMessages = [{ role: "user", content: "go" }];
      const prepareResult = await capturedPrepareStep?.({ stepNumber: 2, messages: baseMessages });
      expect(prepareResult?.messages).toEqual([
        ...baseMessages,
        { role: "user", content: "mention the queue behavior" },
      ]);
      expect(
        (session as any).state.allMessages.some(
          (message: any) => message.content === "mention the queue behavior",
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type === "user_message" &&
            (e as any).text === "mention the queue behavior" &&
            (e as any).clientMessageId === "steer-commit",
        ),
      ).toBe(true);

      resolveRunTurn();
      await turnPromise;
    });

    test("uses an attachment label when an attachment-only steer is committed", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-steer-attachments-"));
      const uploadsDir = path.join(dir, "custom-uploads");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });
      let capturedPrepareStep:
        | ((step: { stepNumber: number; messages: any[] }) => Promise<any>)
        | undefined;
      let resolveRunTurn!: () => void;

      mockRunTurn.mockImplementation(async (params: any) => {
        capturedPrepareStep = params.prepareStep;
        await new Promise<void>((resolve) => {
          resolveRunTurn = resolve;
        });
        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "done" }],
        };
      });

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendSteerMessage("", session.activeTurnId!, "steer-attachment", [
        {
          filename: "diagram.png",
          contentBase64: "aGVsbG8=",
          mimeType: "image/png",
        },
      ]);

      await capturedPrepareStep?.({
        stepNumber: 2,
        messages: [{ role: "user", content: "go" }],
      });

      expect(
        events.some(
          (e) =>
            e.type === "user_message" &&
            (e as any).clientMessageId === "steer-attachment" &&
            (e as any).text === "[diagram.png]",
        ),
      ).toBe(true);
      await expect(fs.readFile(path.join(uploadsDir, "diagram.png"), "utf8")).resolves.toBe(
        "hello",
      );

      resolveRunTurn();
      await turnPromise;
    });

    test("rejects steer attachments once the queued payload would exceed the pending steer budget", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const activeTurnId = session.activeTurnId;
      expect(activeTurnId).toBeTruthy();

      await session.sendSteerMessage(
        "first attachment steer",
        activeTurnId!,
        "steer-attachment-1",
        [
          {
            filename: "large-1.txt",
            contentBase64: "a".repeat(MAX_ATTACHMENT_BASE64_SIZE),
            mimeType: "text/plain",
          },
        ],
      );
      await session.sendSteerMessage(
        "second attachment steer",
        activeTurnId!,
        "steer-attachment-2",
        [
          {
            filename: "large-2.txt",
            contentBase64: "b".repeat(
              MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE - MAX_ATTACHMENT_BASE64_SIZE + 4,
            ),
            mimeType: "text/plain",
          },
        ],
      );

      const errorEvt = events.findLast((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt?.message).toBe(
        "Pending steer attachments are too large. Wait for the current turn to consume queued steers.",
      );
      expect(
        events.some(
          (e) => e.type === "steer_accepted" && (e as any).clientMessageId === "steer-attachment-1",
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) => e.type === "steer_accepted" && (e as any).clientMessageId === "steer-attachment-2",
        ),
      ).toBe(false);
      expect((session as any).state.pendingSteers).toHaveLength(1);
      (session as any).state.pendingSteers.splice(0);

      resolveRunTurn();
      await turnPromise;
    });

    test("injects a steer before the next model step in the same pass", async () => {
      const { session } = makeSession();
      const stepMessages: any[][] = [];
      let allowSecondStep!: () => void;

      mockRunTurn.mockImplementation(async (params: any) => {
        const initialMessages = [{ role: "user", content: "go" }];
        const stepOne = await params.prepareStep?.({ stepNumber: 1, messages: initialMessages });
        stepMessages.push(stepOne?.messages ?? initialMessages);

        await new Promise<void>((resolve) => {
          allowSecondStep = resolve;
        });

        const stepTwo = await params.prepareStep?.({
          stepNumber: 2,
          messages: stepMessages[0]!,
        });
        stepMessages.push(stepTwo?.messages ?? stepMessages[0]!);

        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "done" }],
        };
      });

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendSteerMessage("mention tests", session.activeTurnId!, "steer-step");
      allowSecondStep();
      await turnPromise;

      expect(stepMessages).toHaveLength(2);
      expect(stepMessages[1]?.at(-1)).toEqual({ role: "user", content: "mention tests" });
    });

    test("late steer continuations only receive the remaining maxSteps budget", async () => {
      const { session } = makeSession();
      (session as any).state.maxSteps = 2;
      const seenMaxSteps: number[] = [];
      let runCount = 0;

      mockRunTurn.mockImplementation(async (params: any) => {
        runCount += 1;
        seenMaxSteps.push(params.maxSteps);
        await params.onModelStreamPart?.({ type: "start-step", stepNumber: 1 });

        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage(
              "follow up once",
              session.activeTurnId!,
              "steer-remaining-steps",
            );
          });
        }

        return {
          text: runCount === 1 ? "first pass" : "second pass",
          reasoningText: undefined,
          responseMessages: [
            { role: "assistant", content: runCount === 1 ? "first pass" : "second pass" },
          ],
        };
      });

      await session.sendUserMessage("go");

      expect(seenMaxSteps).toEqual([2, 1]);
    });

    test("continues the same outer turn for a late steer and emits one aggregated turn_usage", async () => {
      const { session, events } = makeSession();
      const seenTurnIds: string[] = [];
      const secondPassMessages: any[][] = [];
      let runCount = 0;

      mockRunTurn.mockImplementation(async (params: any) => {
        runCount += 1;
        seenTurnIds.push(String(params.telemetryContext?.metadata?.turnId ?? ""));

        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage(
              "follow up in the same turn",
              session.activeTurnId!,
              "steer-late",
            );
          });
          return {
            text: "first pass",
            reasoningText: undefined,
            responseMessages: [{ role: "assistant", content: "first pass" }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            providerState: {
              provider: "openai",
              model: "gpt-5.2",
              responseId: "resp_1",
              updatedAt: new Date().toISOString(),
            },
          };
        }

        secondPassMessages.push([...params.messages]);
        const prepareResult = await params.prepareStep?.({
          stepNumber: 1,
          messages: params.messages,
        });
        expect(prepareResult).toBeUndefined();

        return {
          text: "second pass",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "second pass" }],
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        };
      });

      await session.sendUserMessage("go");

      expect(runCount).toBe(2);
      expect(new Set(seenTurnIds).size).toBe(1);
      expect(secondPassMessages).toHaveLength(1);
      expect(secondPassMessages[0]?.at(-1)).toEqual({
        role: "user",
        content: "follow up in the same turn",
      });
      expect(
        events.filter((e) => e.type === "session_busy" && (e as any).busy === true),
      ).toHaveLength(1);

      const usageEvents = events.filter((e) => e.type === "turn_usage") as Array<
        Extract<SessionEvent, { type: "turn_usage" }>
      >;
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.turnId).toBe(seenTurnIds[0]);
      expect(usageEvents[0]?.usage).toMatchObject({
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
      });

      const tracker = (session as any).state.costTracker as SessionCostTracker;
      const compact = tracker.getCompactSnapshot();
      expect(compact.totalTurns).toBe(1);
      expect(compact.turns).toHaveLength(1);
      expect(compact.turns[0]?.turnId).toBe(seenTurnIds[0]);
    });

    test("does not commit a late steer after the turn is cancelled", async () => {
      const { session, events } = makeSession();
      let runCount = 0;

      mockRunTurn.mockImplementation(async () => {
        runCount += 1;
        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage(
              "follow up in the same turn",
              session.activeTurnId!,
              "steer-cancelled",
            );
            queueMicrotask(() => {
              session.cancel();
            });
          });
          return {
            text: "first pass",
            reasoningText: undefined,
            responseMessages: [{ role: "assistant", content: "first pass" }],
          };
        }

        throw new Error("late steer continuation should not run after cancellation");
      });

      await session.sendUserMessage("go");

      expect(runCount).toBe(1);
      expect(
        (session as any).state.allMessages.some(
          (message: any) => message.content === "follow up in the same turn",
        ),
      ).toBe(false);
      expect(
        events.some(
          (e) => e.type === "user_message" && (e as any).clientMessageId === "steer-cancelled",
        ),
      ).toBe(false);
    });

    test("does not cancel child agents unless explicitly requested", async () => {
      const cancelAgentSessionsImpl = mock(() => {});
      const { session } = makeSession({ cancelAgentSessionsImpl });

      mockRunTurn.mockImplementationOnce(async (params: any) => {
        await new Promise((_, reject) => {
          params.abortSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
            { once: true },
          );
        });

        throw new Error("unreachable");
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((resolve) => setTimeout(resolve, 0));

      session.cancel();
      await sendPromise;

      expect(cancelAgentSessionsImpl).not.toHaveBeenCalled();
    });

    test("can cancel child agents when a root turn is cancelled explicitly", async () => {
      const cancelAgentSessionsImpl = mock(() => {});
      const { session } = makeSession({ cancelAgentSessionsImpl });

      mockRunTurn.mockImplementationOnce(async (params: any) => {
        await new Promise((_, reject) => {
          params.abortSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
            { once: true },
          );
        });

        throw new Error("unreachable");
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((resolve) => setTimeout(resolve, 0));

      session.cancel({ includeSubagents: true });
      await sendPromise;

      expect(cancelAgentSessionsImpl).toHaveBeenCalledTimes(1);
      expect(cancelAgentSessionsImpl).toHaveBeenCalledWith(session.id);
    });

    test("can cancel child agents explicitly even when the root session is idle", () => {
      const cancelAgentSessionsImpl = mock(() => {});
      const { session } = makeSession({ cancelAgentSessionsImpl });

      session.cancel({ includeSubagents: true });

      expect(cancelAgentSessionsImpl).toHaveBeenCalledTimes(1);
      expect(cancelAgentSessionsImpl).toHaveBeenCalledWith(session.id);
    });

    test("persists aggregated usage when a late steer continuation errors after an earlier pass consumed tokens", async () => {
      const { session, events } = makeSession();
      let runCount = 0;

      mockRunTurn.mockImplementation(async () => {
        runCount += 1;

        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage(
              "follow up and fail",
              session.activeTurnId!,
              "steer-error",
            );
          });
          return {
            text: "first pass",
            reasoningText: undefined,
            responseMessages: [{ role: "assistant", content: "first pass" }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        }

        throw new Error("follow-up provider failed");
      });

      await session.sendUserMessage("go");

      expect(runCount).toBe(2);

      const busyTrue = events.find((e) => e.type === "session_busy" && (e as any).busy === true) as
        | Extract<SessionEvent, { type: "session_busy" }>
        | undefined;
      expect(busyTrue?.turnId).toBeTruthy();

      const usageEvents = events.filter((e) => e.type === "turn_usage") as Array<
        Extract<SessionEvent, { type: "turn_usage" }>
      >;
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.turnId).toBe(busyTrue?.turnId);
      expect(usageEvents[0]?.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      const tracker = (session as any).state.costTracker as SessionCostTracker;
      const compact = tracker.getCompactSnapshot();
      expect(compact.totalTurns).toBe(1);
      expect(compact.turns).toHaveLength(1);
      expect(compact.turns[0]?.turnId).toBe(busyTrue?.turnId);
      expect(compact.turns[0]?.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      const sessionUsageEvents = events.filter((e) => e.type === "session_usage") as Array<
        Extract<SessionEvent, { type: "session_usage" }>
      >;
      expect(sessionUsageEvents).toHaveLength(1);
      expect(sessionUsageEvents[0]?.usage?.totalTurns).toBe(1);
      expect(sessionUsageEvents[0]?.usage?.turns[0]?.turnId).toBe(busyTrue?.turnId);

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt?.message).toContain("follow-up provider failed");

      const busyFalse = events.find((e) => e.type === "session_busy" && !(e as any).busy) as
        | Extract<SessionEvent, { type: "session_busy" }>
        | undefined;
      expect(busyFalse?.outcome).toBe("error");
    });

    test("rejects steer_message once the active turn stops accepting steering", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const activeTurnId = session.activeTurnId;
      expect(activeTurnId).toBeTruthy();
      (session as any).state.acceptingSteers = false;

      await session.sendSteerMessage("too late", activeTurnId!, "steer-closed");

      const errorEvt = events.findLast((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt?.message).toBe("Active turn no longer accepts steering.");
      expect(
        events.some(
          (e) => e.type === "steer_accepted" && (e as any).clientMessageId === "steer-closed",
        ),
      ).toBe(false);

      resolveRunTurn();
      await turnPromise;
    });

    test("updates child session_info executionState across a successful turn", async () => {
      const { session, events } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      expect(
        events.some(
          (event) =>
            event.type === "session_info" &&
            event.sessionId === session.id &&
            event.executionState === "running",
        ),
      ).toBe(true);

      resolveRunTurn();
      await sendPromise;

      expect(session.getSessionInfoEvent().executionState).toBe("completed");
      expect(
        events.some(
          (event) =>
            event.type === "session_info" &&
            event.sessionId === session.id &&
            event.executionState === "completed",
        ),
      ).toBe(true);
    });

    test("updates child session_info executionState to errored when a turn fails", async () => {
      const { session, events } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      mockRunTurn.mockImplementation(async () => {
        throw new Error("delegate failed");
      });

      await session.sendUserMessage("go");

      expect(session.getSessionInfoEvent().executionState).toBe("errored");
      expect(
        events.some(
          (event) =>
            event.type === "session_info" &&
            event.sessionId === session.id &&
            event.executionState === "running",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "session_info" &&
            event.sessionId === session.id &&
            event.executionState === "errored",
        ),
      ).toBe(true);
    });

    test("replaces a stale child preview with the latest error text on a failed rerun", async () => {
      const { session } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      mockRunTurn
        .mockImplementationOnce(async () => ({
          text: "First child result",
          reasoningText: undefined,
          responseMessages: [
            { role: "assistant", content: [{ type: "text", text: "First child result" }] },
          ],
        }))
        .mockImplementationOnce(async () => {
          throw new Error("delegate failed");
        });

      await session.sendUserMessage("first");
      expect(session.getSessionInfoEvent().lastMessagePreview).toBe("First child result");

      await session.sendUserMessage("second");
      expect(session.getSessionInfoEvent().executionState).toBe("errored");
      expect(session.getSessionInfoEvent().lastMessagePreview).toBe("delegate failed");
    });

    test("marks malformed repeated tool-call churn as a provider error", async () => {
      const { session, events } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      mockRunTurn.mockImplementationOnce(async () => ({
        text: "I'm having trouble with the function call format. Let me try again.",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I'm having trouble with the function call format. Let me try again.",
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "tool",
                output: { value: "Tool tool not found" },
                isError: true,
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "tool",
                output: { value: "Tool tool not found" },
                isError: true,
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "read",
                output: { value: "Invalid input: expected string, received undefined" },
                isError: true,
              },
            ],
          },
        ],
      }));

      await session.sendUserMessage("go");

      expect(session.getSessionInfoEvent().executionState).toBe("errored");
      expect(session.getSessionInfoEvent().lastMessagePreview).toContain(
        "Model failed to produce valid tool calls",
      );
      expect(
        events.some(
          (event) =>
            event.type === "error" &&
            event.sessionId === session.id &&
            event.code === "provider_error" &&
            event.message.includes("Model failed to produce valid tool calls"),
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "assistant_message")).toBe(false);
    });

    test("clears busy and allows follow-up even when auto-checkpoint never resolves", async () => {
      const sessionBackupFactory = mock(
        async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
          const createdAt = new Date().toISOString();
          const checkpoints: SessionBackupPublicCheckpoint[] = [
            {
              id: "cp-0001",
              index: 1,
              createdAt,
              trigger: "initial",
              changed: false,
              patchBytes: 0,
            },
          ];
          const state = (): SessionBackupPublicState => ({
            status: "ready",
            sessionId: opts.sessionId,
            workingDirectory: opts.workingDirectory,
            backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
            createdAt,
            originalSnapshot: { kind: "directory" },
            checkpoints: [...checkpoints],
          });

          return {
            getPublicState: () => state(),
            createCheckpoint: async (trigger) => {
              if (trigger === "auto") {
                await new Promise<never>(() => {});
              }
              const checkpoint: SessionBackupPublicCheckpoint = {
                id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
                index: checkpoints.length + 1,
                createdAt: new Date().toISOString(),
                trigger,
                changed: true,
                patchBytes: 42,
              };
              checkpoints.push(checkpoint);
              return checkpoint;
            },
            restoreOriginal: async () => {},
            restoreCheckpoint: async (_checkpointId: string) => {},
            deleteCheckpoint: async (_checkpointId: string) => false,
            reloadFromDisk: async () => state(),
            close: async () => {},
          };
        },
      );

      const { session, events } = makeSession({ sessionBackupFactory });

      const firstTurnResult = await Promise.race([
        session.sendUserMessage("first").then(() => "resolved" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 50);
        }),
      ]);
      expect(firstTurnResult).toBe("resolved");

      const busyTrueIdx = events.findIndex(
        (e) => e.type === "session_busy" && (e as any).busy === true,
      );
      const busyFalseIdx = events.findIndex(
        (e) => e.type === "session_busy" && (e as any).busy === false,
      );
      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBeGreaterThan(busyTrueIdx);

      events.length = 0;
      await session.sendUserMessage("follow-up");
      const busyError = events.find(
        (e) => e.type === "error" && (e as any).message === "Agent is busy",
      );
      expect(busyError).toBeUndefined();
    });

    test("emits user_message event", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello world");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt).toBeDefined();
      expect(userEvt.text).toBe("hello world");
      expect(userEvt.sessionId).toBe(session.id);
    });

    test("emits user_message event with clientMessageId when provided", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello", "msg-123");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.clientMessageId).toBe("msg-123");
    });

    test("uses an attachment label for attachment-only user_message events without mutating model input text", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "custom-uploads");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.sendUserMessage("", "msg-attachment", undefined, [
        {
          filename: "photo.png",
          contentBase64: "aGVsbG8=",
          mimeType: "image/png",
        },
      ]);

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt).toMatchObject({
        text: "[photo.png]",
        clientMessageId: "msg-attachment",
      });
      await expect(fs.readFile(path.join(uploadsDir, "photo.png"), "utf8")).resolves.toBe("hello");
    });

    test("includes attached MP3 label in text user_message events without mutating model input text", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "custom-uploads");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.sendUserMessage("what do you think of IO this year", "msg-mp3", undefined, [
        {
          filename: "io-recap.mp3",
          contentBase64: Buffer.from("audio bytes").toString("base64"),
          mimeType: "audio/mpeg",
        },
      ]);

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt).toMatchObject({
        text: "what do you think of IO this year\n\nAttached: [io-recap.mp3]",
        clientMessageId: "msg-mp3",
      });

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "text",
        text: "what do you think of IO this year",
      });
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "audio",
        data: Buffer.from("audio bytes").toString("base64"),
        mimeType: "audio/mpeg",
      });
      await expect(fs.readFile(path.join(uploadsDir, "io-recap.mp3"))).resolves.toEqual(
        Buffer.from("audio bytes"),
      );
    });

    test("adds chunked file-output guidance for Gemini audio markdown requests", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.sendUserMessage("give me a markdown file with this", "msg-mp3-md", undefined, [
        {
          filename: "google-io-preview.mp3",
          contentBase64: Buffer.from("audio bytes").toString("base64"),
          mimeType: "audio/mpeg",
        },
      ]);

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt).toMatchObject({
        text: "give me a markdown file with this\n\nAttached: [google-io-preview.mp3]",
        clientMessageId: "msg-mp3-md",
      });

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      const content = call.messages.at(-1)?.content as Array<Record<string, unknown>>;
      expect(content).toContainEqual({
        type: "text",
        text: "give me a markdown file with this",
      });
      expect(content).toContainEqual({
        type: "audio",
        data: Buffer.from("audio bytes").toString("base64"),
        mimeType: "audio/mpeg",
      });
      const guidance = content.find(
        (part) => part.type === "text" && String(part.text).includes('mode="append"'),
      );
      expect(guidance).toBeDefined();
      expect(String(guidance?.text)).toContain("do not stream the full transcript");
      expect(String(guidance?.text)).toContain("do not call read on the uploaded media path");
      expect(String(guidance?.text)).toContain("Return only the file path");

      const uploadNote = content.find(
        (part) =>
          part.type === "text" && String(part.text).includes("already attached as audio content"),
      );
      expect(uploadNote).toBeDefined();
      expect(String(uploadNote?.text)).toContain("do not call read on this uploaded media path");
      expect(String(uploadNote?.text)).toContain("write the requested output file directly");
    });

    test("deduplicates attachment filenames against existing uploads without stale in-memory names", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "custom-uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(path.join(uploadsDir, "photo.png"), "existing");
      const { session } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.sendUserMessage("", undefined, undefined, [
        {
          filename: "photo.png",
          contentBase64: "b25l",
          mimeType: "image/png",
        },
        {
          filename: "photo.png",
          contentBase64: "dHdv",
          mimeType: "image/png",
        },
      ]);

      await expect(fs.readFile(path.join(uploadsDir, "photo.png"), "utf8")).resolves.toBe(
        "existing",
      );
      await expect(fs.readFile(path.join(uploadsDir, "photo_1.png"), "utf8")).resolves.toBe("one");
      await expect(fs.readFile(path.join(uploadsDir, "photo_2.png"), "utf8")).resolves.toBe("two");
    });

    test("rejects inline attachments when the uploads root resolves outside the workspace", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "session-upload-outside-"));
      const uploadsDir = path.join(dir, "uploads");
      await fs.symlink(outsideDir, uploadsDir, process.platform === "win32" ? "junction" : "dir");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.sendUserMessage("", "msg-upload-root-escape", undefined, [
        {
          filename: "inline.txt",
          contentBase64: Buffer.from("blocked inline").toString("base64"),
          mimeType: "text/plain",
        },
      ]);

      const errorEvt = events.findLast((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: "Uploads directory resolves outside the workspace.",
      });
      expect(events.some((e) => e.type === "user_message")).toBe(false);
      expect(mockRunTurn).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(outsideDir, "inline.txt"), "utf8")).rejects.toThrow();
    });

    test("reuses uploaded attachment paths without rewriting the file", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      const uploadedPath = path.join(uploadsDir, "large.bin");
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadedPath, "existing-large-file");
      const { session } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-uploaded-path", undefined, [
        {
          filename: "large.bin",
          path: uploadedPath,
          mimeType: "application/octet-stream",
        },
      ]);

      await expect(fs.readFile(uploadedPath, "utf8")).resolves.toBe("existing-large-file");
      await expect(fs.readdir(uploadsDir)).resolves.toEqual(["large.bin"]);
      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "text",
        text: `[System: The user uploaded a file which has been saved to ${uploadedPath}]`,
      });
    });

    test("rejects uploaded attachment paths when the uploads root resolves outside the workspace", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "session-upload-path-"));
      const uploadsDir = path.join(dir, "uploads");
      const escapedPath = path.join(uploadsDir, "secret.txt");
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "top secret");
      await fs.symlink(outsideDir, uploadsDir, process.platform === "win32" ? "junction" : "dir");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.sendUserMessage("", "msg-upload-root-escape", undefined, [
        {
          filename: "secret.txt",
          path: escapedPath,
          mimeType: "text/plain",
        },
      ]);

      const errorEvt = events.findLast((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: "Uploads directory resolves outside the workspace.",
      });
      expect(events.some((e) => e.type === "user_message")).toBe(false);
      expect(mockRunTurn).not.toHaveBeenCalled();
    });

    test("rejects dot-path attachment filenames before acknowledging attachment-only input", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const { session, events } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-invalid-filename", undefined, [
        {
          filename: "..",
          contentBase64: "aGVsbG8=",
          mimeType: "image/png",
        },
      ]);

      const errorEvt = events.findLast((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: "Invalid attachment filename: ..",
      });
      expect(events.some((e) => e.type === "session_busy")).toBe(false);
      await expect(fs.readdir(path.join(dir, "User Uploads"))).rejects.toThrow();
    });

    test("rejects uploaded attachment directories as invalid files", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      const nestedDir = path.join(uploadsDir, "folder");
      await fs.mkdir(nestedDir, { recursive: true });
      const { session, events } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-uploaded-dir", undefined, [
        {
          filename: "folder",
          path: nestedDir,
          mimeType: "image/png",
        },
      ]);

      const errorEvt = events.findLast((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: `Uploaded attachment is not a file: ${nestedDir}`,
      });
      expect(events.some((e) => e.type === "session_busy")).toBe(false);
    });

    test("preserves multimodal content for uploaded image attachments", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      const uploadedPath = path.join(uploadsDir, "photo.png");
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadedPath, "uploaded-image-bytes");
      const { session } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-uploaded-image", undefined, [
        {
          filename: "photo.png",
          path: uploadedPath,
          mimeType: "image/png",
        },
      ]);

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "text",
        text: `[System: The user uploaded a file which has been saved to ${uploadedPath}]`,
      });
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "image",
        data: Buffer.from("uploaded-image-bytes").toString("base64"),
        mimeType: "image/png",
      });
    });

    test("preserves correct multimodal part types for uploaded Google attachments", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      const pdfPath = path.join(uploadsDir, "notes.pdf");
      const audioPath = path.join(uploadsDir, "voice.mp3");
      const videoPath = path.join(uploadsDir, "clip.mp4");
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(pdfPath, "pdf-bytes");
      await fs.writeFile(audioPath, "audio-bytes");
      await fs.writeFile(videoPath, "video-bytes");
      const { session } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-uploaded-google-multimodal", undefined, [
        {
          filename: "notes.pdf",
          path: pdfPath,
          mimeType: "application/pdf",
        },
        {
          filename: "voice.mp3",
          path: audioPath,
          mimeType: "audio/mp3",
        },
        {
          filename: "clip.mp4",
          path: videoPath,
          mimeType: "video/mp4",
        },
      ]);

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "document",
        data: Buffer.from("pdf-bytes").toString("base64"),
        mimeType: "application/pdf",
      });
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "audio",
        data: Buffer.from("audio-bytes").toString("base64"),
        mimeType: "audio/mp3",
      });
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "video",
        data: Buffer.from("video-bytes").toString("base64"),
        mimeType: "video/mp4",
      });
    });

    test("preserves inline base64 audio attachments for Google multimodal input", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      const { session } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-inline-audio", undefined, [
        {
          filename: "voice.mp3",
          contentBase64: Buffer.from("inline-audio-bytes").toString("base64"),
          mimeType: "audio/mpeg",
        },
      ]);

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.messages.at(-1)?.content).toContainEqual({
        type: "audio",
        data: Buffer.from("inline-audio-bytes").toString("base64"),
        mimeType: "audio/mpeg",
      });
      await expect(fs.readFile(path.join(uploadsDir, "voice.mp3"))).resolves.toEqual(
        Buffer.from("inline-audio-bytes"),
      );
    });

    test("rejects oversized uploaded multimodal attachments before emitting a user_message event", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const uploadsDir = path.join(dir, "uploads");
      const uploadedPath = path.join(uploadsDir, "oversized.pdf");
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadedPath, "");
      await fs.truncate(uploadedPath, MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1);
      const { session, events } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-uploaded-too-large", undefined, [
        {
          filename: "oversized.pdf",
          path: uploadedPath,
          mimeType: "application/pdf",
        },
      ]);

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: "Uploaded multimodal file too large to send to the model (max 25MB)",
      });
      expect(events.some((e) => e.type === "user_message")).toBe(false);
    });

    test("rejects oversized attachment payloads before emitting a user_message event", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const { session, events } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage("", "msg-too-large", undefined, [
        {
          filename: "large.bin",
          contentBase64: "a".repeat(MAX_ATTACHMENT_BASE64_SIZE + 1),
          mimeType: "application/octet-stream",
        },
      ]);

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: "File too large to send inline (max 25MB)",
      });
      expect(events.some((e) => e.type === "user_message")).toBe(false);
    });

    test("rejects too many attachments before emitting a user_message event", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachments-"));
      const { session, events } = makeSession({
        config: makeConfig(dir),
      });

      await session.sendUserMessage(
        "",
        "msg-too-many-files",
        undefined,
        Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, (_, index) => ({
          filename: `file-${index}.txt`,
          contentBase64: "YQ==",
          mimeType: "text/plain",
        })),
      );

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
      });
      expect(events.some((e) => e.type === "user_message")).toBe(false);
    });

    test("emits user_message event without clientMessageId when not provided", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.clientMessageId).toBeUndefined();
    });

    test("generates title once from the first accepted user prompt", async () => {
      mockGenerateSessionTitle.mockResolvedValueOnce({
        title: "First prompt title",
        source: "model",
        model: "gpt-5-mini",
      });
      const { session, events } = makeSession();

      await session.sendUserMessage("first question");
      await session.sendUserMessage("second question");
      await flushAsyncWork();

      expect(mockGenerateSessionTitle).toHaveBeenCalledTimes(1);
      expect(mockGenerateSessionTitle.mock.calls[0]?.[0]).toMatchObject({
        query: "first question",
      });
      const infoEvents = events.filter(
        (evt): evt is Extract<SessionEvent, { type: "session_info" }> =>
          evt.type === "session_info",
      );
      expect(infoEvents.some((evt) => evt.title === "First prompt title")).toBe(true);
    });

    test("manual titles are not overwritten by in-flight auto title generation", async () => {
      let resolveTitle!: (value: { title: string; source: "heuristic"; model: null }) => void;
      mockGenerateSessionTitle.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTitle = resolve;
          }),
      );

      const { session } = makeSession();

      await session.sendUserMessage("first question");
      session.setSessionTitle("My Manual Title");

      resolveTitle({ title: "Generated Title", source: "heuristic", model: null });
      await flushAsyncWork();

      const info = session.getSessionInfoEvent();
      expect(info.title).toBe("My Manual Title");
      expect(info.titleSource).toBe("manual");
      expect(info.titleModel).toBeNull();
    });

    test("adds user message to messages array", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("test message");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toContainEqual({ role: "user", content: "test message" });
    });

    test("calls runTurn with config, system, messages", async () => {
      const dir = "/tmp/test-session";
      const config = makeConfig(dir);
      const { session } = makeSession({ config, system: "Be helpful." });
      await session.sendUserMessage("question");

      expect(mockRunTurn).toHaveBeenCalledTimes(1);
      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.config).toEqual(config);
      expect(call.system).toBe("Be helpful.");
      expect(call.messages).toEqual([{ role: "user", content: "question" }]);
    });

    test("passes allMessages and providerState to runTurn", async () => {
      const { session } = makeSession();
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_prev",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.sendUserMessage("question");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toEqual([{ role: "user", content: "question" }]);
      expect(call.allMessages).toEqual([{ role: "user", content: "question" }]);
      expect(call.providerState).toEqual({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_prev",
        updatedAt: "2026-02-16T00:00:00.000Z",
      });
    });

    test("passes maxSteps=100 to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.maxSteps).toBe(100);
    });

    test("passes enableMcp from config to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.enableMcp).toBe(true);
    });

    test("passes includeRawChunks and onModelStreamPart to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.includeRawChunks).toBe(true);
      expect(typeof call.onModelStreamPart).toBe("function");
    });

    test("adds response messages to history", async () => {
      const responseMsg = { role: "assistant" as const, content: "I helped!" };
      let callNum = 0;
      mockRunTurn.mockImplementation(async () => {
        callNum++;
        return {
          text: callNum === 1 ? "I helped!" : "",
          reasoningText: undefined,
          // Only return responseMessages on first call to avoid reference mutation
          responseMessages: callNum === 1 ? [responseMsg] : [],
        };
      });

      const { session } = makeSession();
      await session.sendUserMessage("first");
      await session.sendUserMessage("second");

      // After first call completes, responseMsg was pushed to messages.
      // Second call should see [user:first, responseMsg, user:second]
      const secondCall = mockRunTurn.mock.calls[1][0] as any;
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0]).toEqual({ role: "user", content: "first" });
      expect(secondCall.messages[1]).toEqual(responseMsg);
      expect(secondCall.messages[2]).toEqual({ role: "user", content: "second" });
    });

    test("retries once when the stored OpenAI continuation handle is rejected", async () => {
      mockRunTurn
        .mockImplementationOnce(async () => {
          throw new Error("Invalid previous_response_id: response not found");
        })
        .mockImplementationOnce(async () => ({
          text: "ok",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "ok" }],
          providerState: {
            provider: "openai",
            model: "gpt-5.2",
            responseId: "resp_fresh",
            updatedAt: "2026-02-16T00:00:02.000Z",
          },
        }));

      const dir = "/tmp/test-session";
      const config = {
        ...makeConfig(dir),
        provider: "openai" as const,
        model: "gpt-5.2",
        preferredChildModel: "gpt-5.2",
      };
      const { session } = makeSession({ config });
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_stale",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.sendUserMessage("hello");

      expect(mockRunTurn).toHaveBeenCalledTimes(2);
      expect((mockRunTurn.mock.calls[0][0] as any).providerState?.responseId).toBe("resp_stale");
      expect((mockRunTurn.mock.calls[1][0] as any).providerState).toBeNull();
      expect((session as any).state.providerState).toEqual({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_fresh",
        updatedAt: "2026-02-16T00:00:02.000Z",
      });
    });

    test("persists Google continuation state returned by runTurn", async () => {
      const googleProviderState = {
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        interactionId: "interaction_fresh",
        updatedAt: "2026-03-18T14:00:00.000Z",
      };
      mockRunTurn.mockResolvedValueOnce({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "ok" }],
        providerState: googleProviderState,
      });

      const dir = "/tmp/test-session";
      const config = makeConfig(dir, {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      });
      const { session } = makeSession({ config });

      await session.sendUserMessage("hello");
      await flushAsyncWork();
      await flushAsyncWork();

      expect((session as any).state.providerState).toEqual(googleProviderState);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.providerState).toEqual(googleProviderState);
    });

    test("retries once when the stored Google continuation handle is rejected", async () => {
      const freshGoogleProviderState = {
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        interactionId: "interaction_fresh",
        updatedAt: "2026-03-19T18:30:00.000Z",
      };
      mockRunTurn
        .mockImplementationOnce(async () => {
          throw new Error("Invalid previous_interaction_id: interaction_id not found");
        })
        .mockImplementationOnce(async () => ({
          text: "ok",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "ok" }],
          providerState: freshGoogleProviderState,
        }));

      const dir = "/tmp/test-session";
      const config = makeConfig(dir, {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      });
      const { session } = makeSession({ config });
      (session as any).state.providerState = {
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "interaction_stale",
        updatedAt: "2026-03-19T18:00:00.000Z",
      };

      await session.sendUserMessage("hello");

      expect(mockRunTurn).toHaveBeenCalledTimes(2);
      expect((mockRunTurn.mock.calls[0][0] as any).providerState?.interactionId).toBe(
        "interaction_stale",
      );
      expect((mockRunTurn.mock.calls[1][0] as any).providerState).toBeNull();
      expect((session as any).state.providerState).toEqual(freshGoogleProviderState);
    });

    test("does not clear Google continuation state for generic invalid request errors", async () => {
      mockRunTurn.mockImplementationOnce(async () => {
        throw new Error("INVALID_ARGUMENT: bad attachment content");
      });

      const dir = "/tmp/test-session";
      const config = makeConfig(dir, {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      });
      const { session } = makeSession({ config });
      const googleProviderState = {
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        interactionId: "interaction_valid",
        updatedAt: "2026-03-19T18:00:00.000Z",
      };
      (session as any).state.providerState = googleProviderState;

      await session.sendUserMessage("hello");

      expect(mockRunTurn).toHaveBeenCalledTimes(1);
      expect((mockRunTurn.mock.calls[0][0] as any).providerState?.interactionId).toBe(
        "interaction_valid",
      );
      expect((session as any).state.providerState).toEqual(googleProviderState);
    });

    test("persists full session context including response history", async () => {
      mockRunTurn.mockResolvedValueOnce({
        text: "assistant reply",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "assistant reply" }],
      });
      const { session } = makeSession();

      await session.sendUserMessage("persist me");
      await flushAsyncWork();

      const last = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      const snapshot = last?.snapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot.context.system).toBe("You are a test assistant.");
      expect(Array.isArray(snapshot.context.messages)).toBe(true);
      expect(snapshot.context.messages.some((msg: any) => msg.role === "user")).toBe(true);
      expect(snapshot.context.messages.some((msg: any) => msg.role === "assistant")).toBe(true);
    });

    test("keeps full persisted history while capping runtime context window", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();
      const totalMessages = 205;
      for (let i = 0; i < totalMessages; i++) {
        await session.sendUserMessage(`message ${i + 1}`);
      }
      await flushAsyncWork();

      expect(session.messageCount).toBe(totalMessages);
      const lastRunTurnCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastRunTurnCall.messages.length).toBe(200);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.messages.length).toBe(totalMessages);
    });

    test("emits assistant_message when response has text", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "Here is my response.",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Here is my response.");
      expect(assistantEvt.sessionId).toBe(session.id);
    });

    test("emits ordered model_stream_chunk events with turnId/index/provider/model", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "start" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "hel" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "lo" });
        await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
        return {
          text: "hello",
          reasoningText: "because",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const, model: "gpt-5.2" };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("hi");

      const chunks = events.filter((e) => e.type === "model_stream_chunk") as Extract<
        SessionEvent,
        { type: "model_stream_chunk" }
      >[];
      expect(chunks).toHaveLength(4);
      expect(chunks.map((chunk) => chunk.partType)).toEqual([
        "start",
        "text_delta",
        "text_delta",
        "finish",
      ]);
      expect(new Set(chunks.map((chunk) => chunk.turnId)).size).toBe(1);
      expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
      for (const chunk of chunks) {
        expect(chunk.sessionId).toBe(session.id);
        expect(chunk.provider).toBe("openai");
        expect(chunk.model).toBe("gpt-5.2");
      }
      expect((chunks[1]?.part.text as string) ?? "").toBe("hel");
      expect((chunks[2]?.part.text as string) ?? "").toBe("lo");

      const legacyReasoning = events.find((e) => e.type === "reasoning");
      const legacyAssistant = events.find((e) => e.type === "assistant_message");
      expect(legacyReasoning).toBeDefined();
      expect(legacyAssistant).toBeDefined();
    });

    test("does not emit assistant_message when response text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("falls back to assistant responseMessages text when stream text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Here is what I found in this folder." }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("whats in this folder");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeDefined();
      if (assistantEvt && assistantEvt.type === "assistant_message") {
        expect(assistantEvt.text).toBe("Here is what I found in this folder.");
      }
    });

    test("does not emit assistant_message when response text is only whitespace", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "   \n\t  ",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("emits reasoning event when reasoningText is present", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "I thought about this carefully.",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("think hard");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.text).toBe("I thought about this carefully.");
      expect(reasoningEvt.sessionId).toBe(session.id);
    });

    test("does not emit reasoning when reasoningText is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test("does not emit reasoning when reasoningText is undefined", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test("does not emit reasoning when reasoningText is only whitespace", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "   \n  ",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test('uses "summary" kind for openai provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.kind).toBe("summary");
    });

    test('normalizes reasoning_delta mode to "summary" for openai stream parts', async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "r1", text: "thinking" });
        return {
          text: "done",
          reasoningText: "thinking",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const chunk = events.find(
        (e) => e.type === "model_stream_chunk" && e.partType === "reasoning_delta",
      ) as Extract<SessionEvent, { type: "model_stream_chunk" }> | undefined;
      expect(chunk).toBeDefined();
      if (chunk) {
        expect(chunk.part.mode).toBe("summary");
      }
    });

    test('uses "summary" kind for codex-cli provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "codex-cli" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.kind).toBe("summary");
    });

    test('uses "reasoning" kind for google provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "google" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt.kind).toBe("reasoning");
    });

    test('normalizes reasoning_delta mode to "reasoning" for google stream parts', async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "r1", text: "thinking" });
        return {
          text: "done",
          reasoningText: "thinking",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "google" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const chunk = events.find(
        (e) => e.type === "model_stream_chunk" && e.partType === "reasoning_delta",
      ) as Extract<SessionEvent, { type: "model_stream_chunk" }> | undefined;
      expect(chunk).toBeDefined();
      if (chunk) {
        expect(chunk.part.mode).toBe("reasoning");
      }
    });

    test("sanitizes non-json-safe stream raw payloads", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        const cyclic: any = { name: "root", count: 12n };
        cyclic.self = cyclic;
        cyclic.items = [1, 2, 3];
        await params.onModelStreamPart?.({ type: "raw", rawValue: cyclic });
        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk") as
        | Extract<SessionEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (!chunk) return;

      expect(chunk.partType).toBe("raw");
      expect(isRecord(chunk.part.raw)).toBe(true);
      const partRaw = chunk.part.raw as Record<string, unknown>;
      expect(partRaw.self).toBe("[circular]");
      expect(partRaw.count).toBe("12");
      expect(isRecord(chunk.rawPart)).toBe(true);
    });

    test('uses "reasoning" kind for anthropic provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "anthropic" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt.kind).toBe("reasoning");
    });

    test("catches runTurn errors and emits error event", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Model API failure");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("Model API failure");
      expect(errorEvt.sessionId).toBe(session.id);
    });

    test("classifies unknown checkpoint id failures as validation_failed", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Unknown checkpoint id: cp-404");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("classifies glob guard rejections as permission_denied", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("glob blocked: pattern cannot escape cwd");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("classifies backup errors containing invalid as backup_error", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("session backup has invalid state");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("classifies checkpoint errors as backup_error even when message includes provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("session backup checkpoint failed for provider reconnect flow");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("does not classify generic backup mentions as backup subsystem errors", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("failed to create backup before editing");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("internal_error");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("catches non-Error throws and emits error event", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw "string error";
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("string error");
    });

    test("sets running=false even on error (finally block)", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("fail");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("first");

      events.length = 0;
      mockRunTurn.mockImplementation(async () => ({
        text: "recovered",
        reasoningText: undefined,
        responseMessages: [],
      }));

      await session.sendUserMessage("second");
      const busyError = events.find(
        (e) => e.type === "error" && (e as any).message === "Agent is busy",
      );
      expect(busyError).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("recovered");
    });

    test("event emission order: user_message comes before assistant_message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "response",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const userIdx = events.findIndex((e) => e.type === "user_message");
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(userIdx).toBeLessThan(assistantIdx);
    });

    test("event emission order: reasoning comes before assistant_message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "response",
        reasoningText: "thinking",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const reasoningIdx = events.findIndex((e) => e.type === "reasoning");
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(reasoningIdx).toBeLessThan(assistantIdx);
    });

    test("passes log callback that emits log events", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        params.log("doing something");
        params.log("done");
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const logEvents = events.filter((e) => e.type === "log") as any[];
      expect(logEvents).toHaveLength(2);
      expect(logEvents[0].line).toBe("doing something");
      expect(logEvents[1].line).toBe("done");
      expect(logEvents[0].sessionId).toBe(session.id);
    });

    test("messages accumulate across multiple sendUserMessage calls", async () => {
      const responseMsg1 = { role: "assistant" as const, content: "resp1" };
      const responseMsg2 = { role: "assistant" as const, content: "resp2" };

      mockRunTurn
        .mockImplementationOnce(async () => ({
          text: "resp1",
          reasoningText: undefined,
          responseMessages: [responseMsg1],
        }))
        .mockImplementationOnce(async () => ({
          text: "resp2",
          reasoningText: undefined,
          responseMessages: [responseMsg2],
        }))
        .mockImplementationOnce(async () => ({
          text: "resp3",
          reasoningText: undefined,
          responseMessages: [],
        }));

      const { session } = makeSession();
      await session.sendUserMessage("msg1");
      await session.sendUserMessage("msg2");
      await session.sendUserMessage("msg3");

      const thirdCall = mockRunTurn.mock.calls[2][0] as any;
      expect(thirdCall.messages).toHaveLength(5);
      expect(thirdCall.messages[0]).toEqual({ role: "user", content: "msg1" });
      expect(thirdCall.messages[1]).toEqual(responseMsg1);
      expect(thirdCall.messages[2]).toEqual({ role: "user", content: "msg2" });
      expect(thirdCall.messages[3]).toEqual(responseMsg2);
      expect(thirdCall.messages[4]).toEqual({ role: "user", content: "msg3" });
    });
  });

  // =========================================================================
  // updateTodos callback
  // =========================================================================
});
