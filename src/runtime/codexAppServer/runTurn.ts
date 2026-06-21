import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromTextAndUsage,
  parseTelemetrySettings,
  startCodexModelCallSpan,
} from "../../observability/modelCallSpan";
import type { CodexAppServerClient } from "../../providers/codexAppServerClient";
import { isCodexAppServerContinuationState } from "../../shared/providerContinuation";
import { asRecord, asString } from "../../shared/recordParsing";
import type {
  LlmRuntime,
  PartialTurnError,
  RuntimeRunTurnParams,
  RuntimeRunTurnResult,
  RuntimeUsage,
} from "../types";
import { startCodexAppServer } from "./clientLifecycle";
import {
  codexApprovalPolicy,
  codexBaseInstructions,
  codexDynamicToolSpecs,
  codexSandboxMode,
  codexSandboxPolicy,
  codexThreadConfig,
  normalizeEffort,
  normalizeSummary,
  providerOptionStringForCodex,
  resolveEffectiveCodexModel,
} from "./config";
import {
  assistantTextFromTurn,
  createCodexTurnNotificationRouter,
  reasoningTextFromTurn,
} from "./notifications";
import { buildCodexTurnInput } from "./turnInput";
import {
  type ActiveCodexTurnTarget,
  attachUsageToError,
  CODEX_APP_SERVER_PROVIDER,
  CODEX_STARTUP_RPC_TIMEOUT_MS,
  isInvalidCodexThreadError,
  withCodexAppServerDiagnostics,
} from "./types";

async function requestWithAbort<T>(
  client: CodexAppServerClient,
  method: string,
  params: unknown,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  opts: { rejectOnAbort?: boolean } = {},
): Promise<T> {
  const requestPromise = client.request(method, params, timeoutMs) as Promise<T>;
  if (!abortSignal) return requestPromise;
  if (abortSignal.aborted) throw new Error("Cancelled by user");
  if (opts.rejectOnAbort === false) return await requestPromise;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Cancelled by user"));
    abortSignal.addEventListener("abort", onAbort, { once: true });
    requestPromise
      .then((res) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(res);
      })
      .catch((err) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}

export function createCodexAppServerRuntime(): LlmRuntime {
  return {
    name: "codex-app-server",
    runTurn: async (params): Promise<RuntimeRunTurnResult> => {
      let threadId: string | undefined;
      let startedTurnId: string | undefined;
      let effectiveModelForContinuation: string | undefined;
      const activeTarget: ActiveCodexTurnTarget = {
        threadId: () => threadId,
        turnId: () => startedTurnId,
      };
      const {
        client,
        env: appServerEnv,
        waitForRawEvents,
        dispose,
      } = await startCodexAppServer(params, activeTarget);
      const preparedParams: RuntimeRunTurnParams = { ...params, toolEnv: appServerEnv };
      let usage: RuntimeUsage | undefined;
      let unregisterSteerHandler: (() => void) | undefined;
      let notificationRouter: ReturnType<typeof createCodexTurnNotificationRouter> | undefined;
      try {
        params.abortSignal?.throwIfAborted();

        const effectiveModel = await resolveEffectiveCodexModel(
          client,
          params.config.model,
          params.log,
        );
        effectiveModelForContinuation = effectiveModel;
        params.abortSignal?.throwIfAborted();
        const currentState = isCodexAppServerContinuationState(params.providerState)
          ? params.providerState
          : null;
        const approvalPolicy = codexApprovalPolicy(preparedParams);
        const sandboxMode = codexSandboxMode(preparedParams);
        const sandboxPolicy = codexSandboxPolicy(preparedParams);
        const threadConfig = codexThreadConfig(preparedParams);
        const dynamicTools = codexDynamicToolSpecs(params.tools);
        const resumeState = currentState?.model === effectiveModel ? currentState : null;
        let resumedThread = resumeState !== null;
        const startThread = async () =>
          await requestWithAbort<unknown>(
            client,
            "thread/start",
            {
              cwd: params.config.workingDirectory,
              model: effectiveModel,
              modelProvider: "openai",
              approvalPolicy,
              sandbox: sandboxMode,
              ...(threadConfig ? { config: threadConfig } : {}),
              baseInstructions: codexBaseInstructions(params.system, appServerEnv),
              experimentalRawEvents: params.includeRawChunks ?? true,
              ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
            CODEX_STARTUP_RPC_TIMEOUT_MS,
            params.abortSignal,
          );
        let threadResult: unknown;
        if (resumeState) {
          try {
            threadResult = await requestWithAbort<unknown>(
              client,
              "thread/resume",
              {
                threadId: resumeState.threadId,
                cwd: params.config.workingDirectory,
                model: effectiveModel,
                modelProvider: "openai",
                approvalPolicy,
                sandbox: sandboxMode,
                ...(threadConfig ? { config: threadConfig } : {}),
                experimentalRawEvents: params.includeRawChunks ?? true,
                ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
              },
              CODEX_STARTUP_RPC_TIMEOUT_MS,
              params.abortSignal,
            );
          } catch (error) {
            if (!isInvalidCodexThreadError(error)) throw error;
            params.log?.(
              `[codex-app-server] stored thread ${resumeState.threadId} was rejected; starting a fresh app-server thread.`,
            );
            resumedThread = false;
            threadResult = await startThread();
          }
        } else {
          threadResult = await startThread();
        }
        params.abortSignal?.throwIfAborted();
        const thread = asRecord(asRecord(threadResult)?.thread);
        threadId = asString(thread?.id);
        if (!threadId) throw new Error("codex app-server did not return a thread id.");

        await params.onModelStreamPart?.({
          type: "start",
          request: { model: effectiveModel, provider: params.config.provider },
        });
        await params.onModelStreamPart?.({
          type: "start-step",
          stepNumber: 1,
          request: { model: effectiveModel, provider: params.config.provider },
        });

        const input = buildCodexTurnInput(params.allMessages ?? params.messages, {
          resumedThread,
        });
        if (input.length === 0)
          throw new Error("codex app-server runtime requires a user message.");
        params.abortSignal?.throwIfAborted();

        const telemetry = parseTelemetrySettings(params.telemetry);
        const span = startCodexModelCallSpan(telemetry, params, effectiveModel, 1, input);

        notificationRouter = createCodexTurnNotificationRouter(client, params, activeTarget, {
          threadId: () => threadId,
          turnId: () => startedTurnId,
          onUsage: (nextUsage) => {
            usage = nextUsage;
          },
          abortSignal: params.abortSignal,
          interrupt: async () => {
            if (!threadId) return;
            try {
              await client.interruptTurn({
                threadId,
                ...(startedTurnId ? { turnId: startedTurnId } : {}),
              });
            } catch (error) {
              params.log?.(
                `[codex-app-server] interrupt failed, forcing hard close: ${String(error)}`,
              );
              await client.close().catch(() => {});
            }
          },
        });

        try {
          const completion = notificationRouter.waitForCompletion();
          const turnStartRequest = requestWithAbort<unknown>(
            client,
            "turn/start",
            {
              threadId,
              input,
              cwd: params.config.workingDirectory,
              model: effectiveModel,
              approvalPolicy,
              sandboxPolicy,
              effort: normalizeEffort(
                providerOptionStringForCodex(params.providerOptions, "reasoningEffort"),
              ),
              summary: normalizeSummary(
                providerOptionStringForCodex(params.providerOptions, "reasoningSummary"),
              ),
              clientMessageId: params.clientMessageId,
            },
            CODEX_STARTUP_RPC_TIMEOUT_MS,
            params.abortSignal,
            { rejectOnAbort: false },
          );
          turnStartRequest.catch(() => {
            // If a provider completion wins the race, the stale start response
            // may still time out or reject later. The completion channel owns
            // the turn outcome in that case.
          });
          let finalTurn: unknown;
          const turnStartOutcome = turnStartRequest.then(
            (result) => ({ kind: "started" as const, result }),
            async (error) => {
              if (params.abortSignal?.aborted) {
                return { kind: "completed" as const, turn: await completion };
              }
              throw error;
            },
          );
          const startOrCompletion = await Promise.race([
            turnStartOutcome,
            completion.then((turn) => ({ kind: "completed" as const, turn })),
          ]);

          if (startOrCompletion.kind === "completed") {
            finalTurn = startOrCompletion.turn;
            startedTurnId = asString(asRecord(finalTurn)?.id);
          } else {
            const startedTurn = asRecord(asRecord(startOrCompletion.result)?.turn);
            startedTurnId = asString(startedTurn?.id);
            if (params.registerSteerHandler && startedTurnId) {
              unregisterSteerHandler = params.registerSteerHandler(async (steer) => {
                if (!threadId || !startedTurnId) {
                  throw new Error("Codex app-server turn is not ready for steering.");
                }
                const steerInput = buildCodexTurnInput(
                  [{ role: "user", content: steer.content ?? steer.text }],
                  { resumedThread: true },
                );
                await client.request(
                  "turn/steer",
                  {
                    threadId,
                    expectedTurnId: startedTurnId,
                    input:
                      steerInput.length > 0
                        ? steerInput
                        : [{ type: "text", text: steer.text, text_elements: [] }],
                  },
                  CODEX_STARTUP_RPC_TIMEOUT_MS,
                );
              });
            }
            finalTurn = await completion;
          }
          if (params.abortSignal?.aborted) {
            throw new Error("Cancelled by user");
          }

          const text = assistantTextFromTurn(finalTurn) || notificationRouter.assistantText();
          const reasoningText = reasoningTextFromTurn(finalTurn);
          await params.onModelStreamPart?.({
            type: "finish-step",
            stepNumber: 1,
            response: { stopReason: "stop" },
            usage,
            finishReason: "stop",
          });
          await params.onModelStreamPart?.({
            type: "finish",
            finishReason: "stop",
            totalUsage: usage,
          });

          markModelCallSpanSuccessFromTextAndUsage(span, telemetry, text, usage);

          return {
            text,
            ...(reasoningText ? { reasoningText } : {}),
            responseMessages: text ? [{ role: "assistant", content: text }] : [],
            ...(usage ? { usage } : {}),
            providerState: {
              provider: CODEX_APP_SERVER_PROVIDER,
              model: effectiveModel,
              threadId,
              updatedAt: new Date().toISOString(),
            },
          };
        } catch (error) {
          markModelCallSpanError(span, error);
          throw error;
        }
      } catch (error) {
        const contextualError = withCodexAppServerDiagnostics(error, client.command);
        if (threadId && effectiveModelForContinuation) {
          (contextualError as PartialTurnError).providerState = {
            provider: CODEX_APP_SERVER_PROVIDER,
            model: effectiveModelForContinuation,
            threadId,
            updatedAt: new Date().toISOString(),
          };
        }
        const partialText = params.abortSignal?.aborted
          ? ""
          : notificationRouter?.assistantText().trim();
        if (partialText) {
          (contextualError as PartialTurnError).responseMessages = [
            { role: "assistant", content: partialText },
          ];
        }
        const errorWithUsage = attachUsageToError(contextualError, usage);
        if (params.abortSignal?.aborted) {
          await params.onModelAbort?.();
        } else {
          await params.onModelError?.(errorWithUsage);
        }
        throw errorWithUsage;
      } finally {
        notificationRouter?.dispose();
        unregisterSteerHandler?.();
        dispose();
        try {
          await waitForRawEvents();
        } catch (error) {
          params.log?.(`[codex-app-server] failed to persist raw events: ${String(error)}`);
        }
      }
    },
  };
}
