import { childAgentReportSchema, type ChildAgentReport } from "../../shared/agents";

export const REPORT_RE = /<agent_report>\s*([\s\S]*?)\s*<\/agent_report>/i;

function tryParseChildAgentReport(candidate: string): ChildAgentReport | null {
  try {
    const parsed = JSON.parse(candidate);
    const result = childAgentReportSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function collectLegacyChildAgentReportCandidates(text: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (candidate: string | null | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const trimmed = text.trim();
  const fencedBlocks = [...trimmed.matchAll(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g)];
  for (let i = fencedBlocks.length - 1; i >= 0; i -= 1) {
    push(fencedBlocks[i]?.[1]);
  }

  const lines = trimmed.split(/\r?\n/);
  const firstJsonLine = Math.max(0, lines.length - 60);
  for (let i = lines.length - 1; i >= firstJsonLine; i -= 1) {
    const candidate = lines.slice(i).join("\n").trim();
    if (!candidate.startsWith("{")) continue;
    push(candidate);
  }

  push(trimmed);
  return candidates;
}

export function parseChildAgentReport(text: string | null | undefined): ChildAgentReport | null {
  if (!text?.trim()) return null;

  const taggedMatches = [...text.matchAll(new RegExp(REPORT_RE.source, "ig"))];
  const taggedFooter = taggedMatches.at(-1);
  if (taggedFooter) {
    return taggedFooter[1] ? tryParseChildAgentReport(taggedFooter[1]) : null;
  }

  for (const candidate of collectLegacyChildAgentReportCandidates(text)) {
    const parsed = tryParseChildAgentReport(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}
