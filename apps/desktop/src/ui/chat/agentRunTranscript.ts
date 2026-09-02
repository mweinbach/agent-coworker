import { type ChildAgentReport, childAgentReportSchema } from "../../../../../src/shared/agents";
import type { FeedItem } from "../../app/types";

/**
 * Read-only presentation cleanup for subagent run transcripts.
 *
 * Child agents close their final message with machine-readable footers
 * (`<workflow_result>` JSON envelope, then an `<agent_report>` JSON footer).
 * Raw, those blocks dump escaped JSON inline with the prose. This transform
 * swaps each block for a markdown rendering — unescaped text, fenced JSON, or
 * a compact report card — so the run viewer reads like a transcript instead
 * of a protocol dump. Display-only: the stored feed is never mutated.
 */

const WORKFLOW_RESULT_RE = /<workflow_result>([\s\S]*?)(?:<\/workflow_result>|$)/gi;
const AGENT_REPORT_RE = /<agent_report>\s*([\s\S]*?)\s*(?:<\/agent_report>|$)/gi;

function tryParseJson(candidate: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

function fencedBlock(language: string, body: string): string {
  return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
}

function renderWorkflowResultBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const parsed = tryParseJson(trimmed);
  if (parsed.ok) {
    if (typeof parsed.value === "string") {
      // A JSON string envelope carries markdown with escaped newlines —
      // restore it to prose.
      const text = parsed.value.trim();
      return text ? `\n\n${text}\n\n` : "";
    }
    return fencedBlock("json", JSON.stringify(parsed.value, null, 2));
  }
  return fencedBlock("text", trimmed);
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Human-readable status note for the report card ("finished" reads better than a raw enum). */
const REPORT_STATUS_LABELS: Record<ChildAgentReport["status"], string> = {
  completed: "finished",
  blocked: "blocked",
  failed: "failed",
};

function renderAgentReportMarkdown(report: ChildAgentReport): string {
  // The <agent_report> footer is the subagent's closing note to its parent —
  // say so in plain language instead of echoing the protocol tag name.
  const sections: string[] = [
    `**Report to main agent** · ${REPORT_STATUS_LABELS[report.status]}\n\n${quoteLines(report.summary)}`,
  ];
  if (report.filesChanged?.length) {
    sections.push(
      `**Files changed:** ${report.filesChanged.map((path) => `\`${path}\``).join(", ")}`,
    );
  }
  if (report.filesRead?.length) {
    sections.push(
      `**Files read:** ${report.filesRead.length} ${report.filesRead.length === 1 ? "file" : "files"}`,
    );
  }
  if (report.verification?.length) {
    sections.push(
      [
        "**Verification:**",
        ...report.verification.map(
          (entry) =>
            `- \`${entry.command}\` — ${entry.outcome}${entry.notes ? ` (${entry.notes})` : ""}`,
        ),
      ].join("\n"),
    );
  }
  if (report.residualRisks?.length) {
    sections.push(
      ["**Residual risks:**", ...report.residualRisks.map((risk) => `- ${risk}`)].join("\n"),
    );
  }
  return `\n\n${sections.join("\n\n")}\n\n`;
}

function renderAgentReportBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const parsed = tryParseJson(trimmed);
  if (parsed.ok) {
    const result = childAgentReportSchema.safeParse(parsed.value);
    if (result.success) {
      return renderAgentReportMarkdown(result.data);
    }
    return fencedBlock("json", JSON.stringify(parsed.value, null, 2));
  }
  return fencedBlock("text", trimmed);
}

export function formatAgentRunMessageText(text: string): string {
  if (!/<\/?(agent_report|workflow_result)>/i.test(text)) {
    return text;
  }
  return text
    .replace(WORKFLOW_RESULT_RE, (_match, body: string) => renderWorkflowResultBody(body))
    .replace(AGENT_REPORT_RE, (_match, body: string) => renderAgentReportBody(body));
}

export function formatAgentRunFeedForViewer(feed: FeedItem[]): FeedItem[] {
  let changed = false;
  const next = feed.map((item) => {
    if (item.kind !== "message" || item.role !== "assistant") return item;
    const formatted = formatAgentRunMessageText(item.text);
    if (formatted === item.text) return item;
    changed = true;
    return { ...item, text: formatted };
  });
  return changed ? next : feed;
}
