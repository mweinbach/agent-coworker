import type { AgentConfig } from "../types";
import type { ModelMessage } from "../types";
import type { OpenAiContinuationState } from "../shared/openaiContinuation";

export type RuntimeModelRawEvent = {
  format: "openai-responses-v1";
  event: Record<string, unknown>;
};

export type RuntimeUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  estimatedCostUsd?: number;
};

export type RuntimeToolDefinition = {
  description?: string;
  inputSchema?: unknown;
  execute: (input: unknown) => Promise<unknown> | unknown;
};

export type RuntimeToolMap = Record<string, RuntimeToolDefinition>;

export type RuntimeStepOverride = {
  messages?: ModelMessage[];
  providerOptions?: Record<string, unknown>;
  streamOptions?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RuntimePrepareStep = (step: {
  stepNumber: number;
  messages: ModelMessage[];
}) => Promise<RuntimeStepOverride | undefined>;

export interface RuntimeRunTurnParams {
  config: AgentConfig;
  system: string;
  messages: ModelMessage[];
  allMessages?: ModelMessage[];
  tools: RuntimeToolMap;
  maxSteps: number;
  providerOptions?: Record<string, any>;
  providerState?: OpenAiContinuationState | null;
  abortSignal?: AbortSignal;
  includeRawChunks?: boolean;
  telemetry?: unknown;
  prepareStep?: RuntimePrepareStep;
  onModelStreamPart?: (part: unknown) => void | Promise<void>;
  onModelRawEvent?: (event: RuntimeModelRawEvent) => void | Promise<void>;
  onModelError?: (error: unknown) => void | Promise<void>;
  onModelAbort?: () => void | Promise<void>;
  log?: (line: string) => void;
}

export interface RuntimeRunTurnResult {
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  usage?: RuntimeUsage;
  providerState?: OpenAiContinuationState;
}

import type { RuntimeName } from "../types";

export interface LlmRuntime {
  readonly name: RuntimeName;
  runTurn(params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult>;
}
