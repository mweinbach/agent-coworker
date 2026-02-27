import type { AgentConfig } from "../types";
import type { ModelMessage } from "../types";

export type RuntimeUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type RuntimeToolDefinition = {
  description?: string;
  inputSchema?: unknown;
  execute: (input: unknown) => Promise<unknown> | unknown;
};

export type RuntimeToolMap = Record<string, RuntimeToolDefinition>;

export type RuntimePrepareStep = (step: {
  stepNumber: number;
  messages: ModelMessage[];
}) => Promise<Record<string, unknown> | undefined>;

export interface RuntimeRunTurnParams {
  config: AgentConfig;
  system: string;
  messages: ModelMessage[];
  tools: RuntimeToolMap;
  maxSteps: number;
  providerOptions?: Record<string, any>;
  abortSignal?: AbortSignal;
  includeRawChunks?: boolean;
  telemetry?: unknown;
  prepareStep?: RuntimePrepareStep;
  onModelStreamPart?: (part: unknown) => void | Promise<void>;
  onModelError?: (error: unknown) => void | Promise<void>;
  onModelAbort?: () => void | Promise<void>;
  log?: (line: string) => void;
}

export interface RuntimeRunTurnResult {
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  usage?: RuntimeUsage;
}

import type { RuntimeName } from "../types";

export interface LlmRuntime {
  readonly name: RuntimeName;
  runTurn(params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult>;
}
