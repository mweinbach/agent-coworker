import type { ModelMessage } from "../../types";
import { normalizeText, truncateText } from "./normalize";
import type { ExternalConversation, ExternalConversationItem } from "./types";

const MAX_HANDOFF_CHARS = 80_000;
const MAX_RECENT_VISIBLE_MESSAGES = 40;
const MAX_TOOL_SUMMARY_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 20_000;

const SENSITIVE_TOKEN_PATTERNS = [
  /call_[A-Za-z0-9_-]+/g,
  /resp_[A-Za-z0-9_-]+/g,
  /thread_[A-Za-z0-9_-]+/g,
  /run_[A-Za-z0-9_-]+/g,
  /gAAAAA[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9+/=]{160,}/g,
];

function redactSensitiveTokens(value: string): string {
  let next = value;
  for (const pattern of SENSITIVE_TOKEN_PATTERNS) {
    next = next.replace(pattern, "[redacted-provider-token]");
  }
  return next;
}

function visibleTextItems(
  items: ExternalConversationItem[],
): Array<Extract<ExternalConversationItem, { kind: "user" | "assistant" }>> {
  return items.filter(
    (item): item is Extract<ExternalConversationItem, { kind: "user" | "assistant" }> =>
      item.kind === "user" || item.kind === "assistant",
  );
}

function summarizeTools(items: ExternalConversationItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const resultText =
      typeof item.result === "string"
        ? normalizeText(item.result)
        : item.result === undefined
          ? ""
          : normalizeText(JSON.stringify(item.result));
    const status = item.error ? `error: ${item.error}` : resultText ? resultText : "completed";
    lines.push(`- ${item.name}: ${status}`);
  }
  return truncateText(redactSensitiveTokens(lines.join("\n")), MAX_TOOL_SUMMARY_CHARS);
}

function buildVisibleTranscript(items: ExternalConversationItem[]): string {
  const recent = visibleTextItems(items).slice(-MAX_RECENT_VISIBLE_MESSAGES);
  return recent
    .map(
      (item) =>
        `${item.kind === "user" ? "User" : "Assistant"}: ${redactSensitiveTokens(item.text)}`,
    )
    .join("\n\n");
}

function buildReasoningSummary(items: ExternalConversationItem[]): string {
  const summaries = items
    .filter(
      (item): item is Extract<ExternalConversationItem, { kind: "reasoning" }> =>
        item.kind === "reasoning",
    )
    .map((item) => redactSensitiveTokens(item.text));
  return truncateText(summaries.join("\n\n"), MAX_SUMMARY_CHARS);
}

export function buildSafeHandoffText(conversation: ExternalConversation): string {
  const sections: string[] = [];
  const summary = conversation.summary ? redactSensitiveTokens(conversation.summary) : "";
  const visibleTranscript = buildVisibleTranscript(conversation.items);
  const toolSummary = summarizeTools(conversation.items);
  const reasoningSummary = buildReasoningSummary(conversation.items);

  sections.push(
    `<past_conversation source="${conversation.source}" original_model="${conversation.originalModel ?? "unknown"}">`,
  );
  sections.push(`Title:\n${conversation.title}`);
  if (conversation.cwd) sections.push(`Original workspace:\n${conversation.cwd}`);
  if (summary) sections.push(`Summary:\n${summary}`);
  if (visibleTranscript) sections.push(`Recent visible transcript:\n${visibleTranscript}`);
  if (toolSummary) sections.push(`Tool activity summary:\n${toolSummary}`);
  if (reasoningSummary) sections.push(`Visible reasoning summaries:\n${reasoningSummary}`);
  sections.push(
    "Safety note:\nThis conversation was imported. Provider-specific continuation IDs, raw tool-call protocol, thinking signatures, encrypted reasoning, and hidden chain-of-thought were intentionally omitted.",
  );
  sections.push("</past_conversation>");

  return truncateText(redactSensitiveTokens(sections.join("\n\n")), MAX_HANDOFF_CHARS);
}

export function buildSafeModelMessages(conversation: ExternalConversation): ModelMessage[] {
  return [
    {
      role: "user",
      content: buildSafeHandoffText(conversation),
    },
  ];
}
