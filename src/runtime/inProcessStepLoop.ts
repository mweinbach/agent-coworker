import { asRecord, asString } from "../shared/recordParsing";
import type { ModelMessage } from "../types";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
import {
  buildInvalidToolCallFormatReminderMessage,
  executeToolCalls,
  isAbortLikeError,
  shouldAddInvalidToolCallFormatReminder,
  splitStepOverrides,
} from "./piRuntime";
import { extractToolCallsFromAssistant, type PiToolCallLike } from "./piRuntimeOptions";
import {
  type PartialTurnError,
  RUNTIME_COMMITTED_PROGRESS,
  type RuntimeRunTurnParams,
  type RuntimeRunTurnResult,
  type RuntimeStepOverride,
  type RuntimeToolMap,
  type RuntimeUsage,
} from "./types";

export type InProcessTurnUsageTracker = {
  readonly usage: RuntimeUsage | undefined;
  readonly requestUsages: readonly RuntimeUsage[];
  readonly hasCompleteRequestUsage: boolean;
  recordStepUsage: (rawUsage: unknown) => RuntimeUsage | undefined;
  recordPartialErrorUsage: (error: unknown, fallbackRawUsage?: unknown) => void;
  buildUsageResult: () => Pick<RuntimeRunTurnResult, "usage" | "requestUsages">;
};

export function createInProcessTurnUsageTracker(): InProcessTurnUsageTracker {
  let usage: RuntimeUsage | undefined;
  const requestUsages: RuntimeUsage[] = [];
  let hasCompleteRequestUsage = true;

  const recordStepUsage = (rawUsage: unknown): RuntimeUsage | undefined => {
    const normalized = normalizePiUsage(rawUsage);
    if (!normalized) return undefined;
    requestUsages.push(normalized);
    usage = mergePiUsage(usage, normalized);
    return normalized;
  };

  const recordPartialErrorUsage = (error: unknown, fallbackRawUsage?: unknown): void => {
    const errorRecord = asRecord(error);
    if (Array.isArray(errorRecord?.requestUsages) && errorRecord.requestUsages.length > 0) {
      for (const entry of errorRecord.requestUsages) {
        recordStepUsage(entry);
      }
      return;
    }
    const partialUsage = normalizePiUsage(errorRecord?.usage);
    if (partialUsage) {
      usage = mergePiUsage(usage, partialUsage);
      hasCompleteRequestUsage = false;
      return;
    }
    if (fallbackRawUsage !== undefined) {
      recordStepUsage(fallbackRawUsage);
    }
  };

  return {
    get usage() {
      return usage;
    },
    get requestUsages() {
      return requestUsages;
    },
    get hasCompleteRequestUsage() {
      return hasCompleteRequestUsage;
    },
    recordStepUsage,
    recordPartialErrorUsage,
    buildUsageResult: () => ({
      usage,
      ...(hasCompleteRequestUsage && requestUsages.length > 0
        ? { requestUsages: [...requestUsages] }
        : {}),
    }),
  };
}

export function createStreamPartEmitter(
  params: Pick<RuntimeRunTurnParams, "onModelStreamPart">,
): (part: unknown) => Promise<void> {
  return async (part: unknown) => {
    if (!params.onModelStreamPart) return;
    await params.onModelStreamPart(part);
  };
}

export function assertTurnNotAborted(params: Pick<RuntimeRunTurnParams, "abortSignal">): void {
  if (params.abortSignal?.aborted) {
    throw new Error("Model turn aborted.");
  }
}

export async function beginInProcessStep(options: {
  params: RuntimeRunTurnParams;
  stepNumber: number;
  modelId: string;
  stepMessages: ModelMessage[];
  emitPart: (part: unknown) => Promise<void>;
  recheckAbortBetweenBoundaries?: boolean;
}): Promise<RuntimeStepOverride> {
  const {
    params,
    stepNumber,
    modelId,
    stepMessages,
    emitPart,
    recheckAbortBetweenBoundaries = false,
  } = options;
  assertTurnNotAborted(params);
  await emitPart({
    type: "start-step",
    stepNumber,
    request: { model: modelId, provider: params.config.provider },
  });
  if (recheckAbortBetweenBoundaries) {
    assertTurnNotAborted(params);
  }
  if (!params.prepareStep) return {};
  const stepOverrides = await params.prepareStep({
    stepNumber,
    messages: stepMessages,
  });
  if (recheckAbortBetweenBoundaries) {
    assertTurnNotAborted(params);
  }
  return splitStepOverrides(stepOverrides);
}

async function emitFinishStepPart(options: {
  emitPart: (part: unknown) => Promise<void>;
  stepNumber: number;
  assistantRecord: Record<string, unknown>;
  assistantMessages: ModelMessage[];
}): Promise<string | undefined> {
  const { emitPart, stepNumber, assistantRecord, assistantMessages } = options;
  await emitPart({
    type: "finish-step",
    [RUNTIME_COMMITTED_PROGRESS]: { assistantMessages },
    stepNumber,
    response: { stopReason: assistantRecord.stopReason },
    usage: normalizePiUsage(assistantRecord.usage),
    finishReason: assistantRecord.stopReason ?? "unknown",
  });
  return asString(assistantRecord.stopReason);
}

function assertAssistantStopReasonOk(
  assistantRecord: Record<string, unknown>,
  fallbackErrorMessage: string,
): string | undefined {
  const stopReason = asString(assistantRecord.stopReason);
  if (stopReason === "error" || stopReason === "aborted") {
    throw new Error(asString(assistantRecord.errorMessage) ?? fallbackErrorMessage);
  }
  return stopReason;
}

async function executeStepToolCalls(options: {
  toolCalls: PiToolCallLike[];
  params: RuntimeRunTurnParams;
  stepTools?: RuntimeToolMap;
  emitPart: (part: unknown) => Promise<void>;
  turnMessages: Array<Record<string, unknown>>;
}): Promise<ModelMessage[]> {
  const { toolCalls, params, stepTools = params.tools, emitPart, turnMessages } = options;
  const toolResultMessages: ModelMessage[] = [];
  let needsInvalidToolCallReminder = false;

  await executeToolCalls(
    toolCalls,
    { ...params, tools: stepTools },
    emitPart,
    (toolCall, toolResult) => {
      turnMessages.push(toolResult);
      toolResultMessages.push(...piTurnMessagesToModelMessages([toolResult as never]));
      needsInvalidToolCallReminder ||= shouldAddInvalidToolCallFormatReminder(
        toolCall,
        toolResult,
        stepTools,
      );
    },
  );

  if (needsInvalidToolCallReminder) {
    toolResultMessages.push(buildInvalidToolCallFormatReminderMessage());
  }

  return toolResultMessages;
}

export async function completeInProcessAssistantStep(options: {
  stepNumber: number;
  assistantRecord: Record<string, unknown>;
  assistantMessages: ModelMessage[];
  stepMessages: ModelMessage[];
  appendAssistantToStepMessages?: boolean;
  replaceStepMessagesWithToolResults?: boolean;
  terminalFailureFallbackMessage?: string;
  params: RuntimeRunTurnParams;
  stepTools?: RuntimeToolMap;
  emitPart: (part: unknown) => Promise<void>;
  turnMessages: Array<Record<string, unknown>>;
}): Promise<{
  stepMessages: ModelMessage[];
  stopReason: string | undefined;
  shouldContinue: boolean;
}> {
  const {
    stepNumber,
    assistantRecord,
    assistantMessages,
    appendAssistantToStepMessages = true,
    replaceStepMessagesWithToolResults = false,
    terminalFailureFallbackMessage,
    params,
    stepTools,
    emitPart,
    turnMessages,
  } = options;

  let nextStepMessages = appendAssistantToStepMessages
    ? [...options.stepMessages, ...assistantMessages]
    : options.stepMessages;

  const stopReason = await emitFinishStepPart({
    emitPart,
    stepNumber,
    assistantRecord,
    assistantMessages,
  });

  if (terminalFailureFallbackMessage) {
    assertAssistantStopReasonOk(assistantRecord, terminalFailureFallbackMessage);
  }

  const toolCalls = extractToolCallsFromAssistant(assistantRecord);
  if (toolCalls.length === 0) {
    return {
      stepMessages: nextStepMessages,
      stopReason,
      shouldContinue: false,
    };
  }

  const toolResultMessages = await executeStepToolCalls({
    toolCalls,
    params,
    stepTools,
    emitPart,
    turnMessages,
  });

  nextStepMessages = replaceStepMessagesWithToolResults
    ? toolResultMessages
    : [...nextStepMessages, ...toolResultMessages];

  return {
    stepMessages: nextStepMessages,
    stopReason,
    shouldContinue: !params.shouldStopAfterToolStep?.(),
  };
}

export function buildInProcessTurnResult(options: {
  turnMessages: Array<Record<string, unknown>>;
  usageTracker: InProcessTurnUsageTracker;
  toModelMessages?: (messages: Array<Record<string, unknown>>) => ModelMessage[];
  providerState?: RuntimeRunTurnResult["providerState"];
}): RuntimeRunTurnResult {
  const {
    turnMessages,
    usageTracker,
    toModelMessages = (messages) => piTurnMessagesToModelMessages(messages as never),
    providerState,
  } = options;
  return {
    text: extractPiAssistantText(turnMessages as never),
    reasoningText: extractPiReasoningText(turnMessages as never),
    responseMessages: toModelMessages(turnMessages),
    ...usageTracker.buildUsageResult(),
    ...(providerState ? { providerState } : {}),
  };
}

export async function handleInProcessTurnFailure(options: {
  error: unknown;
  params: RuntimeRunTurnParams;
  turnMessages: Array<Record<string, unknown>>;
  usageTracker: InProcessTurnUsageTracker;
  toModelMessages?: (messages: Array<Record<string, unknown>>) => ModelMessage[];
  includeErrorPartialUsage?: boolean;
  includeErrorResponseMessages?: boolean;
  clearProviderStateOnError?: boolean;
}): Promise<never> {
  const {
    error,
    params,
    turnMessages,
    usageTracker,
    toModelMessages = (messages) => piTurnMessagesToModelMessages(messages as never),
    includeErrorPartialUsage = false,
    includeErrorResponseMessages = false,
    clearProviderStateOnError = false,
  } = options;

  if (error && typeof error === "object") {
    try {
      const partialError = error as PartialTurnError;
      if (includeErrorPartialUsage) {
        usageTracker.recordPartialErrorUsage(partialError);
      }
      partialError.usage = usageTracker.usage;
      if (usageTracker.hasCompleteRequestUsage && usageTracker.requestUsages.length > 0) {
        partialError.requestUsages = [...usageTracker.requestUsages];
      } else {
        delete partialError.requestUsages;
      }

      const committedMessages = Array.isArray(turnMessages) ? toModelMessages(turnMessages) : [];
      const trailingPartialMessages =
        includeErrorResponseMessages && Array.isArray(partialError.responseMessages)
          ? partialError.responseMessages
          : [];
      const responseMessages = [...committedMessages, ...trailingPartialMessages];
      Object.defineProperty(error, "responseMessages", {
        value: responseMessages,
        configurable: true,
        writable: true,
      });

      if (clearProviderStateOnError) {
        // The failed request may never have entered provider history.
        // Replay local history next turn, including its user input and partial output.
        Object.defineProperty(error, "providerState", {
          value: null,
          configurable: true,
          writable: true,
        });
      }
    } catch {
      // Ignore if error object is not extensible/writable
    }
  }

  if (isAbortLikeError(error, params.abortSignal)) {
    await params.onModelAbort?.();
  } else {
    await params.onModelError?.(error);
  }
  throw error;
}
