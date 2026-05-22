import type { Interactions } from "@google/genai";
import type { ModelMessage } from "../../types";
import type { GoogleInteractionsModelInfo } from "../googleInteractionsModel";

export type GoogleInteractionsToolChoice =
  | Interactions.ToolChoiceType
  | Interactions.ToolChoiceConfig;

type GoogleInteractionsStreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  thinkingLevel?: Interactions.ThinkingLevel;
  thinkingBudget?: number;
  thinkingSummaries?: "auto" | "none";
  maxOutputTokens?: number;
  toolChoice?: GoogleInteractionsToolChoice;
  nativeWebSearch?: boolean;
  responseFormat?: unknown;
  responseMimeType?: string;
};

export type GoogleNativeStepRequest = {
  model: GoogleInteractionsModelInfo;
  apiKey?: string;
  systemPrompt: string;
  messages: ModelMessage[];
  tools: Array<Record<string, unknown>>;
  streamOptions: GoogleInteractionsStreamOptions;
  previousInteractionId?: string;
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  onRawEvent?: (event: Record<string, unknown>) => void | Promise<void>;
};

export type GoogleNativeStepResult = {
  assistant: Record<string, unknown>;
  interactionId?: string;
};

export type RunGoogleNativeInteractionStep = (
  opts: GoogleNativeStepRequest,
) => Promise<GoogleNativeStepResult>;

export type GoogleInteractionErrorKind =
  | "abort"
  | "auth"
  | "quota"
  | "stale_continuation"
  | "schema"
  | "output_size"
  | "retryable"
  | "unknown";

export type NativeGoogleToolName =
  | "nativeWebSearch"
  | "nativeUrlContext"
  | "nativeFileSearch"
  | "nativeGoogleMaps"
  | "nativeMcpServerTool";
