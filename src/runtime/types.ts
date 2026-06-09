import type { ProviderContinuationState } from "../shared/providerContinuation";
import type { AgentConfig, ApproveCommandOptions, ModelMessage, TodoItem } from "../types";

export type RuntimeModelRawEvent = {
  format: "openai-responses-v1" | "google-interactions-v1" | "codex-app-server-v2";
  event: Record<string, unknown>;
};

export type RuntimeUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheWritePromptTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCostUsd?: number;
};

/** Error from a partial turn that may still include progress and token usage. */
export type PartialTurnError = Error & {
  usage?: RuntimeUsage;
  responseMessages?: ModelMessage[];
  providerState?: ProviderContinuationState;
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

export type RuntimeSteerInput = {
  text: string;
  expectedTurnId: string;
  content?: ModelMessage["content"];
};

export type RuntimeSteerHandler = (input: RuntimeSteerInput) => Promise<void>;

export type RuntimeRegisterSteerHandler = (handler: RuntimeSteerHandler) => () => void;

export interface RuntimeRunTurnParams {
  config: AgentConfig;
  system: string;
  messages: ModelMessage[];
  allMessages?: ModelMessage[];
  tools: RuntimeToolMap;
  maxSteps: number;
  yolo?: boolean;
  /**
   * Whether the active sandbox policy permits network egress. When false,
   * provider-native web tools (e.g. Gemini google_search/url_context) must NOT
   * be advertised — gating only the local tool execute path would still let the
   * model make provider-side web requests. Undefined means "allowed/unknown".
   */
  networkAllowed?: boolean;
  shellPolicy?: "full" | "no_project_write";
  /** Child-agent filesystem scope; becomes the OS sandbox writable roots. */
  agentTargetPaths?: readonly string[] | null;
  providerOptions?: Record<string, any>;
  providerState?: ProviderContinuationState | null;
  toolEnv?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  includeRawChunks?: boolean;
  clientMessageId?: string;
  telemetry?: unknown;
  prepareStep?: RuntimePrepareStep;
  registerSteerHandler?: RuntimeRegisterSteerHandler;
  askUser?: (question: string, options?: string[]) => Promise<string>;
  approveCommand?: (command: string, opts?: ApproveCommandOptions) => Promise<boolean>;
  updateTodos?: (todos: TodoItem[]) => void;
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
  providerState?: ProviderContinuationState;
}

import type { RuntimeName } from "../types";

export interface LlmRuntime {
  readonly name: RuntimeName;
  runTurn(params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult>;
}
