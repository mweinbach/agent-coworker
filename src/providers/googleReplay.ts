import type { Message, AssistantMessage, ThinkingContent, ToolCall } from "../pi/types";
import { z } from "zod";

/**
 * Google thought signature replay for pi Message format.
 *
 * Pi's Message types carry thought signatures directly on ThinkingContent.thinkingSignature
 * and ToolCall.thoughtSignature. Pi's Google streaming layer may handle replay internally.
 *
 * This module is retained for safety during migration. If pi handles it internally,
 * this can be removed after verification.
 */

const recordSchema = z.record(z.string(), z.unknown());

function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return msg.role === "assistant";
}

/**
 * Repair Google tool call thought signatures on pi Message[].
 *
 * In Google's API, tool calls that follow thinking blocks must carry the
 * preceding thinking block's thought signature. This function propagates
 * the last-seen thinkingSignature onto subsequent tool calls that lack one.
 */
export function repairGoogleToolCallSignatures(messages: Message[]): {
  messages: Message[];
  repairedToolCalls: number;
  unresolvedToolCalls: number;
} {
  let changed = false;
  let repairedToolCalls = 0;
  let unresolvedToolCalls = 0;

  const repairedMessages = messages.map((message) => {
    if (!isAssistantMessage(message)) return message;

    let messageChanged = false;
    let lastSignature: string | undefined;

    const repairedContent = message.content.map((part) => {
      // Track thinking signatures.
      if (part.type === "thinking") {
        const thinkingPart = part as ThinkingContent;
        if (thinkingPart.thinkingSignature) {
          lastSignature = thinkingPart.thinkingSignature;
        }
        return part;
      }

      // Repair tool calls missing thought signatures.
      if (part.type === "toolCall") {
        const toolCall = part as ToolCall;
        if (toolCall.thoughtSignature) {
          lastSignature = toolCall.thoughtSignature;
          return part;
        }

        if (!lastSignature) {
          unresolvedToolCalls += 1;
          return part;
        }

        repairedToolCalls += 1;
        messageChanged = true;
        changed = true;
        return {
          ...toolCall,
          thoughtSignature: lastSignature,
        };
      }

      return part;
    });

    return messageChanged
      ? ({ ...message, content: repairedContent } as AssistantMessage)
      : message;
  });

  return {
    messages: changed ? repairedMessages : messages,
    repairedToolCalls,
    unresolvedToolCalls,
  };
}

/**
 * Build a context transform that repairs Google thought signatures.
 *
 * Returns a function compatible with pi's AgentLoopConfig.transformContext,
 * or undefined if not needed for the current provider options.
 */
export function buildGoogleTransformContext(
  log: (line: string) => void,
): ((messages: Message[]) => Message[]) {
  return (messages: Message[]): Message[] => {
    const repaired = repairGoogleToolCallSignatures(messages);
    if (repaired.repairedToolCalls > 0) {
      log(`[info] Repaired ${repaired.repairedToolCalls} Gemini tool call(s) with replay thought signatures.`);
    }
    if (repaired.unresolvedToolCalls > 0) {
      log(
        `[warn] Gemini replay has ${repaired.unresolvedToolCalls} tool call(s) without thought signatures.`,
      );
    }
    return repaired.messages;
  };
}

// ── Preserved for backward compatibility during migration ────────────────────

type LegacyGooglePrepareStepPayload = {
  stepNumber: number;
  messages: unknown[];
};

/**
 * @deprecated Use buildGoogleTransformContext for pi-based agent loops.
 * Kept temporarily for any code paths that haven't migrated yet.
 */
export function buildGooglePrepareStep(
  providerOptions: Record<string, any> | undefined,
  log: (line: string) => void,
): ((step: LegacyGooglePrepareStepPayload) => Promise<Record<string, unknown> | undefined>) | undefined {
  if (!providerOptions) return undefined;
  const parsed = recordSchema.safeParse(providerOptions);
  if (!parsed.success) return undefined;

  const hasGoogle = recordSchema.safeParse(parsed.data.google).success;
  const hasVertex = recordSchema.safeParse(parsed.data.vertex).success;
  if (!hasGoogle && !hasVertex) return undefined;

  return async ({ stepNumber }: LegacyGooglePrepareStepPayload) => {
    if (stepNumber <= 0) return undefined;
    log("[info] Google thought signature replay handled by pi framework.");
    return undefined;
  };
}
