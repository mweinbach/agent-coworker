import { z } from "zod";

export const OPENAI_COMPATIBLE_PROVIDER_NAMES = [
  "openai",
  "codex-cli",
] as const;

export type OpenAICompatibleProviderName = (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number];

export const REASONING_EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];

export const REASONING_SUMMARY_VALUES = [
  "auto",
  "concise",
  "detailed",
] as const;

export type ReasoningSummaryValue = (typeof REASONING_SUMMARY_VALUES)[number];

export const TEXT_VERBOSITY_VALUES = [
  "low",
  "medium",
  "high",
] as const;

export type TextVerbosityValue = (typeof TEXT_VERBOSITY_VALUES)[number];

export type OpenAICompatibleProviderOptions = {
  reasoningEffort?: ReasoningEffortValue;
  reasoningSummary?: ReasoningSummaryValue;
  textVerbosity?: TextVerbosityValue;
};

export type WorkspaceProviderOptions = Partial<Record<OpenAICompatibleProviderName, OpenAICompatibleProviderOptions>>;

export const DEFAULT_WORKSPACE_PROVIDER_OPTIONS: Record<
  OpenAICompatibleProviderName,
  Required<OpenAICompatibleProviderOptions>
> = {
  openai: {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
    textVerbosity: "medium",
  },
  "codex-cli": {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
    textVerbosity: "medium",
  },
};

export const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);
export const reasoningSummarySchema = z.enum(REASONING_SUMMARY_VALUES);
export const textVerbositySchema = z.enum(TEXT_VERBOSITY_VALUES);

const providerOptionsSchema = z.object({
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoningSummary: reasoningSummarySchema.optional(),
  textVerbosity: textVerbositySchema.optional(),
});

export const workspaceProviderOptionsSchema = z.object({
  openai: providerOptionsSchema.optional(),
  "codex-cli": providerOptionsSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanProviderOptions(
  value: OpenAICompatibleProviderOptions | undefined
): OpenAICompatibleProviderOptions | undefined {
  if (!value) return undefined;
  const next: OpenAICompatibleProviderOptions = {};
  if (value.reasoningEffort) next.reasoningEffort = value.reasoningEffort;
  if (value.reasoningSummary) next.reasoningSummary = value.reasoningSummary;
  if (value.textVerbosity) next.textVerbosity = value.textVerbosity;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function normalizeWorkspaceProviderOptions(value: unknown): WorkspaceProviderOptions | undefined {
  if (!isRecord(value)) return undefined;
  const parsed = workspaceProviderOptionsSchema.safeParse(value);
  if (!parsed.success) return undefined;

  const next: WorkspaceProviderOptions = {};
  for (const provider of OPENAI_COMPATIBLE_PROVIDER_NAMES) {
    const cleaned = cleanProviderOptions(parsed.data[provider]);
    if (cleaned) next[provider] = cleaned;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function mergeWorkspaceProviderOptions(
  base?: WorkspaceProviderOptions,
  patch?: WorkspaceProviderOptions
): WorkspaceProviderOptions | undefined {
  const next: WorkspaceProviderOptions = {};

  for (const provider of OPENAI_COMPATIBLE_PROVIDER_NAMES) {
    const merged = cleanProviderOptions({
      ...(base?.[provider] ?? {}),
      ...(patch?.[provider] ?? {}),
    });
    if (merged) next[provider] = merged;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function getWorkspaceReasoningEffort(
  options: WorkspaceProviderOptions | undefined,
  provider: OpenAICompatibleProviderName
): ReasoningEffortValue {
  return options?.[provider]?.reasoningEffort ?? DEFAULT_WORKSPACE_PROVIDER_OPTIONS[provider].reasoningEffort;
}

export function getWorkspaceTextVerbosity(
  options: WorkspaceProviderOptions | undefined,
  provider: OpenAICompatibleProviderName
): TextVerbosityValue {
  return options?.[provider]?.textVerbosity ?? DEFAULT_WORKSPACE_PROVIDER_OPTIONS[provider].textVerbosity;
}

export function getWorkspaceReasoningSummary(
  options: WorkspaceProviderOptions | undefined,
  provider: OpenAICompatibleProviderName
): ReasoningSummaryValue {
  return options?.[provider]?.reasoningSummary ?? DEFAULT_WORKSPACE_PROVIDER_OPTIONS[provider].reasoningSummary;
}
