import { z } from "zod";

import type { ModelMessage } from "../types";

type GoogleProviderKey = "google" | "vertex";

type GooglePrepareStepPayload = {
  stepNumber: number;
  messages: ModelMessage[];
};

const recordSchema = z.record(z.string(), z.unknown());
const assistantMessageWithContentSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.unknown()),
}).passthrough();

function isRecord(v: unknown): v is Record<string, unknown> {
  return recordSchema.safeParse(v).success;
}

function getGoogleProviderKey(providerOptions: Record<string, unknown>): GoogleProviderKey | undefined {
  if (isRecord(providerOptions.google)) return "google";
  if (isRecord(providerOptions.vertex)) return "vertex";
  return undefined;
}

function getGoogleThoughtSignatureFromPart(part: Record<string, unknown>): string | undefined {
  const providerOptions = part.providerOptions;
  if (!isRecord(providerOptions)) return undefined;
  for (const key of ["google", "vertex"] as const) {
    const providerValue = providerOptions[key];
    if (!isRecord(providerValue)) continue;
    const signature = providerValue.thoughtSignature ?? providerValue.thought_signature;
    if (typeof signature === "string" && signature.length > 0) return signature;
  }
  return undefined;
}

function withGoogleIncludeThoughts(
  providerOptions: Record<string, any> | undefined,
  includeThoughts: boolean
): Record<string, any> | undefined {
  if (!isRecord(providerOptions)) return providerOptions;
  const providerKey = getGoogleProviderKey(providerOptions) ?? "google";
  const googleOptions = isRecord(providerOptions[providerKey]) ? providerOptions[providerKey] : {};
  const thinkingConfig = isRecord(googleOptions.thinkingConfig) ? googleOptions.thinkingConfig : {};
  return {
    ...providerOptions,
    [providerKey]: {
      ...googleOptions,
      thinkingConfig: {
        ...thinkingConfig,
        includeThoughts,
      },
    },
  } as Record<string, any>;
}

function repairGoogleToolCallSignatures(messages: ModelMessage[]): {
  messages: ModelMessage[];
  repairedToolCalls: number;
  unresolvedToolCalls: number;
} {
  let changed = false;
  let repairedToolCalls = 0;
  let unresolvedToolCalls = 0;

  const repairedMessages = messages.map((message) => {
    const parsedMessage = assistantMessageWithContentSchema.safeParse(message);
    if (!parsedMessage.success) return message;

    let messageChanged = false;
    let lastSignature: string | undefined;

    const repairedContent = parsedMessage.data.content.map((part) => {
      if (!isRecord(part)) return part;

      const existingSignature = getGoogleThoughtSignatureFromPart(part);
      if (existingSignature) {
        lastSignature = existingSignature;
        return part;
      }

      if (part.type !== "tool-call") return part;
      if (!lastSignature) {
        unresolvedToolCalls += 1;
        return part;
      }

      const providerOptions = isRecord(part.providerOptions) ? part.providerOptions : {};
      const providerKey: GoogleProviderKey = isRecord(providerOptions.vertex) ? "vertex" : "google";
      const providerValue = isRecord(providerOptions[providerKey]) ? providerOptions[providerKey] : {};

      repairedToolCalls += 1;
      messageChanged = true;
      changed = true;
      return {
        ...part,
        providerOptions: {
          ...providerOptions,
          [providerKey]: {
            ...providerValue,
            thoughtSignature: lastSignature,
          },
        },
      };
    });

    return messageChanged ? ({ ...parsedMessage.data, content: repairedContent } as ModelMessage) : message;
  });

  return {
    messages: changed ? repairedMessages : messages,
    repairedToolCalls,
    unresolvedToolCalls,
  };
}

export function buildGooglePrepareStep(
  providerOptions: Record<string, any> | undefined,
  log: (line: string) => void
): ((step: GooglePrepareStepPayload) => Promise<Record<string, unknown> | undefined>) | undefined {
  if (!isRecord(providerOptions)) return undefined;
  const providerKey = getGoogleProviderKey(providerOptions);
  if (!providerKey) return undefined;

  const googleOptions = providerOptions[providerKey];
  if (!isRecord(googleOptions)) return undefined;
  const thinkingConfig = isRecord(googleOptions.thinkingConfig) ? googleOptions.thinkingConfig : undefined;
  if (thinkingConfig?.includeThoughts !== true) return undefined;

  return async ({ stepNumber, messages }: GooglePrepareStepPayload) => {
    if (stepNumber <= 0) return undefined;

    const repaired = repairGoogleToolCallSignatures(messages);
    if (repaired.repairedToolCalls > 0) {
      log(`[info] Repaired ${repaired.repairedToolCalls} Gemini tool call(s) with replay thought signatures.`);
    }

    if (repaired.unresolvedToolCalls > 0) {
      log(
        `[warn] Gemini replay has ${repaired.unresolvedToolCalls} tool call(s) without thought signatures; ` +
          "disabling thoughts for this step."
      );
      return {
        messages: repaired.messages,
        providerOptions: withGoogleIncludeThoughts(providerOptions, false),
      };
    }

    return repaired.repairedToolCalls > 0 ? { messages: repaired.messages } : undefined;
  };
}
