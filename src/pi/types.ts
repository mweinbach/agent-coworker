/**
 * Canonical pi framework type re-exports for agent-coworker.
 *
 * This module provides a single import point for all pi types used throughout the codebase,
 * isolating the rest of the code from direct pi package imports.
 */

// ── pi-ai core types ──────────────────────────────────────────────────────────
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  KnownProvider,
  Message,
  Model,
  Provider,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ThinkingLevel as PiThinkingLevel,
  ThinkingBudgets,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";

export {
  Type,
  type Static,
  type TSchema,
} from "@mariozechner/pi-ai";

export {
  complete,
  completeSimple,
  getModel as getPiModel,
  getModels as getPiModels,
  getProviders as getPiProviders,
  stream,
  streamSimple,
  StringEnum,
  validateToolCall,
  validateToolArguments,
  EventStream,
} from "@mariozechner/pi-ai";

// ── pi-agent-core types ───────────────────────────────────────────────────────
export type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  CustomAgentMessages,
  StreamFn,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

export {
  Agent,
  agentLoop,
  agentLoopContinue,
} from "@mariozechner/pi-agent-core";
