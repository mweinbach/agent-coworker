import {
  type AgentReportStatus,
  type ChildAgentReport,
  childAgentReportSchema,
} from "../../shared/agents";

const REPORT_RE = /<agent_report>\s*([\s\S]*?)\s*<\/agent_report>/i;

export type ChildAgentReportInspection = AgentReportStatus & {
  parsedReport: ChildAgentReport | null;
};

function diagnosticFromUnknown(error: unknown): string {
  if (error instanceof SyntaxError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function validationDiagnostic(issues: { path: PropertyKey[]; message: string }[]): string {
  const firstIssue = issues[0];
  if (!firstIssue) return "Report schema validation failed.";
  const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
  return `Report schema validation failed: ${path}${firstIssue.message}`;
}

function tryParseChildAgentReport(
  candidate: string,
): { ok: true; report: ChildAgentReport } | { ok: false; diagnostic: string } {
  try {
    const parsed = JSON.parse(candidate);
    const result = childAgentReportSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, report: result.data };
    }
    return { ok: false, diagnostic: validationDiagnostic(result.error.issues) };
  } catch (error) {
    return { ok: false, diagnostic: `Invalid JSON: ${diagnosticFromUnknown(error)}` };
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
  return inspectChildAgentReport(text).parsedReport;
}

export function inspectChildAgentReport(
  text: string | null | undefined,
): ChildAgentReportInspection {
  const base = {
    reportRequired: true,
    reportFound: false,
    reportValid: false,
    reportBlockCount: 0,
    reportDiagnostic: null,
    parsedReport: null,
  } satisfies ChildAgentReportInspection;

  if (!text?.trim()) {
    return {
      ...base,
      reportDiagnostic: "No assistant message available to inspect for an <agent_report> footer.",
    };
  }

  const taggedMatches = [...text.matchAll(new RegExp(REPORT_RE.source, "ig"))];
  const reportBlockCount = taggedMatches.length;
  const taggedFooter = taggedMatches.at(-1);
  if (taggedFooter) {
    if (!taggedFooter[1]?.trim()) {
      return {
        ...base,
        reportFound: true,
        reportBlockCount,
        reportDiagnostic: "Empty <agent_report> footer.",
      };
    }
    const parsed = tryParseChildAgentReport(taggedFooter[1]);
    if (!parsed.ok) {
      return {
        ...base,
        reportFound: true,
        reportBlockCount,
        reportDiagnostic: parsed.diagnostic,
      };
    }
    return {
      ...base,
      reportFound: true,
      reportValid: true,
      reportBlockCount,
      reportDiagnostic:
        reportBlockCount > 1
          ? "Multiple <agent_report> blocks found; parsed the trailing block."
          : null,
      parsedReport: parsed.report,
    };
  }

  for (const candidate of collectLegacyChildAgentReportCandidates(text)) {
    const parsed = tryParseChildAgentReport(candidate);
    if (parsed.ok) {
      return {
        ...base,
        reportFound: true,
        reportValid: true,
        reportDiagnostic: "Parsed legacy report without an <agent_report> footer.",
        parsedReport: parsed.report,
      };
    }
  }

  return {
    ...base,
    reportDiagnostic: "No <agent_report> footer or valid legacy report found.",
  };
}
