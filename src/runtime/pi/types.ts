import type { ModelMessage } from "../../types";
import type { PiModel } from "../piRuntimeOptions";
import type { RuntimeStepOverride } from "../types";

export const LM_STUDIO_LOCAL_SENTINEL_API_KEY = "lmstudio-local";

export const PI_PLACEHOLDER_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const VALID_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export const INVALID_TOOL_CALL_FORMAT_REMINDER =
  "Possible invalid tool call format detected. Use the exact tool name from the provided tool list and pass arguments as a structured object matching that tool schema. Do not include XML tags, arg markers, or prose in the tool name.";

export type ResolvedPiRuntimeModel = {
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
  accountId?: string;
  streamOptions?: Record<string, unknown>;
};

export type RuntimeStepOverrides = RuntimeStepOverride;

export type RuntimeStepState = {
  modelMessages: ModelMessage[];
  providerOptions: Record<string, unknown> | undefined;
  streamOptions: Record<string, unknown>;
  piMessages: Array<Record<string, unknown>>;
};

export type PiRuntimeOverrides = {
  piStreamImpl?: typeof import("@mariozechner/pi-ai").stream;
};
