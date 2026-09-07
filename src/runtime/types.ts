import type { ProviderContinuationState } from "../shared/providerContinuation";
import type { AgentConfig, ApproveCommandOptions, ModelMessage, TodoItem } from "../types";

/** Internal pre-cancellation proof; symbol keys never enter JSON stream notifications. */
export const RUNTIME_COMMITTED_PROGRESS = Symbol("runtime.committedProgress");

export type RuntimeCommittedProgress = {
  /** Canonical assistant records captured when a model step has completed. */
  assistantMessages?: readonly ModelMessage[];
  /** Provider-owned tool events captured before deferred delivery or cancellation. */
  toolParts?: readonly unknown[];
};

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
  [RUNTIME_COMMITTED_PROGRESS]?: RuntimeCommittedProgress;
  usage?: RuntimeUsage;
  /** Request-level rows covering usage; omit when only aggregate usage is available. */
  requestUsages?: RuntimeUsage[];
  responseMessages?: ModelMessage[];
  providerState?: ProviderContinuationState | null;
};

export type RuntimeToolDefinition = {
  description?: string;
  inputSchema?: unknown;
  /** Opt-in only; unsupported providers/schemas retain ordinary locally validated calls. */
  constrainedSampling?: false | { type: "json_schema"; strict: "prefer" };
  /** Only verified independent reads may overlap. Omission is sequential. */
  executionPolicy?: "parallel-read" | "sequential";
  execute: (input: unknown, options?: RuntimeToolExecutionOptions) => Promise<unknown> | unknown;
};

export type RuntimeToolExecutionOptions = {
  abortSignal?: AbortSignal;
  /** Harness-owned discovery hook, never inferred from tool output text. */
  onToolsDiscovered?: (names: readonly string[]) => void;
};

export type RuntimeToolMap = Record<string, RuntimeToolDefinition>;

export type RuntimeLiveToolCatalog = {
  /** Hints are not grants: only current authorized definitions may be returned. */
  resolveTools: (names: readonly string[]) => Promise<RuntimeToolMap>;
};

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
  /** Stable session identity for provider caching; never synthesized across sessions. */
  sessionId?: string;
  /** Filtered capabilities before optional schema deferral; not callable-name registration. */
  authorizedToolNames?: readonly string[];
  system: string;
  messages: ModelMessage[];
  allMessages?: ModelMessage[];
  tools: RuntimeToolMap;
  /** Optional native schema activation; adapters without support keep portable envelopes. */
  deferredToolCatalog?: RuntimeLiveToolCatalog;
  maxSteps: number;
  yolo?: boolean;
  shellPolicy?: "full" | "no_project_write";
  /** Whether provider-side/network-backed tools are allowed for this turn. */
  networkAllowed?: boolean;
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
  shouldStopAfterToolStep?: () => boolean;
  registerSteerHandler?: RuntimeRegisterSteerHandler;
  askUser?: (question: string, options?: string[]) => Promise<string>;
  approveCommand?: (command: string, opts?: ApproveCommandOptions) => Promise<boolean>;
  updateTodos?: (todos: TodoItem[]) => void;
  assertCanMutate?: (toolName: string) => void | Promise<void>;
  onModelStreamPart?: (part: unknown) => void | Promise<void>;
  onModelRawEvent?: (event: RuntimeModelRawEvent) => void | Promise<void>;
  onModelError?: (error: unknown) => void | Promise<void>;
  onModelAbort?: () => void | Promise<void>;
  log?: (line: string) => void;
}

export interface RuntimeRunTurnResult {
  [RUNTIME_COMMITTED_PROGRESS]?: RuntimeCommittedProgress;
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  usage?: RuntimeUsage;
  /** Request-level rows covering usage; omit when only aggregate usage is available. */
  requestUsages?: RuntimeUsage[];
  providerState?: ProviderContinuationState;
}

import type { RuntimeName } from "../types";

export interface LlmRuntime {
  readonly name: RuntimeName;
  runTurn(params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult>;
}
