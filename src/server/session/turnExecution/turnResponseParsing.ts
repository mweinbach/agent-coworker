import { z } from "zod";

const assistantMessageContentArraySchema = z.array(z.unknown());
const assistantMessageContentPartSchema = z
  .object({
    type: z.enum(["text", "output_text"]),
    text: z.string(),
    phase: z.string().optional(),
  })
  .passthrough();

type ToolExecutionDiagnostics = {
  totalResults: number;
  successfulResults: number;
  unknownToolErrors: number;
  invalidToolInputErrors: number;
  malformedToolNameErrors: number;
  errorMessages: string[];
};

function extractAssistantTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  const parsedContent = assistantMessageContentArraySchema.safeParse(content);
  if (!parsedContent.success) return "";

  const chunks: string[] = [];
  for (const part of parsedContent.data) {
    const parsedPart = assistantMessageContentPartSchema.safeParse(part);
    if (!parsedPart.success) continue;
    if (parsedPart.data.phase === "commentary") continue;
    if (parsedPart.data.text.length > 0) chunks.push(parsedPart.data.text);
  }
  return chunks.join("");
}

export function extractAssistantTextFromResponseMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const text = extractAssistantTextFromMessageContent(message.content).trim();
    if (!text) continue;
    chunks.push(text);
  }
  return chunks.join("\n\n");
}

export function normalizePreviewText(text: string, maxChars = 800): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function extractToolExecutionDiagnostics(
  messages: Array<{ role: string; content: unknown }>,
): ToolExecutionDiagnostics {
  const diagnostics: ToolExecutionDiagnostics = {
    totalResults: 0,
    successfulResults: 0,
    unknownToolErrors: 0,
    invalidToolInputErrors: 0,
    malformedToolNameErrors: 0,
    errorMessages: [],
  };

  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "tool-result") continue;

      diagnostics.totalResults += 1;
      const isError = record.isError === true;
      if (!isError) {
        diagnostics.successfulResults += 1;
        continue;
      }

      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      const output =
        typeof record.output === "object" && record.output !== null
          ? (record.output as Record<string, unknown>)
          : null;
      const messageText = typeof output?.value === "string" ? output.value.trim() : "";
      if (messageText) {
        diagnostics.errorMessages.push(messageText);
      }
      if (/^tool(?:[<\s]|$)/i.test(toolName)) {
        diagnostics.malformedToolNameErrors += 1;
      }
      if (/tool .* not found/i.test(messageText)) {
        diagnostics.unknownToolErrors += 1;
      }
      if (/invalid input|expected .* received|too small:/i.test(messageText)) {
        diagnostics.invalidToolInputErrors += 1;
      }
    }
  }

  return diagnostics;
}

export function detectMalformedToolCallFailure(
  messages: Array<{ role: string; content: unknown }>,
  assistantText: string,
): string | null {
  const diagnostics = extractToolExecutionDiagnostics(messages);
  if (diagnostics.totalResults === 0) return null;
  if (diagnostics.successfulResults > 0) return null;
  if (diagnostics.errorMessages.length < 3) return null;

  const hasFormattingComplaint = /function call format|tool call format|proper parameters/i.test(
    assistantText,
  );
  const repeatedToolFailures =
    diagnostics.unknownToolErrors +
      diagnostics.invalidToolInputErrors +
      diagnostics.malformedToolNameErrors >=
    3;
  if (!hasFormattingComplaint && !repeatedToolFailures) return null;

  const sampleErrors = [...new Set(diagnostics.errorMessages)].slice(0, 2).join("; ");
  return sampleErrors
    ? `Model failed to produce valid tool calls after repeated attempts: ${sampleErrors}`
    : "Model failed to produce valid tool calls after repeated attempts.";
}
