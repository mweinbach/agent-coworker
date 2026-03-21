import type { HarnessContextState } from "../types";

function normalizeLine(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeList(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeMetadata(
  metadata: HarnessContextState["metadata"],
): Array<[key: string, value: string]> {
  if (!metadata) return [];

  return Object.entries(metadata)
    .map(([key, value]) => [key.trim(), value.trim()] as [string, string])
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

export function renderHarnessContextSection(
  context: HarnessContextState | null | undefined,
): string {
  if (!context) return "";

  const runId = normalizeLine(context.runId);
  const objective = normalizeLine(context.objective);
  if (!runId || !objective) return "";

  const taskId = normalizeLine(context.taskId);
  const acceptanceCriteria = normalizeList(context.acceptanceCriteria);
  const constraints = normalizeList(context.constraints);
  const metadataEntries = normalizeMetadata(context.metadata);

  const lines: string[] = [
    "## Active Harness Context",
    "",
    "This section is server-supplied run context for the current session.",
    "Treat it as the authoritative task contract for this run.",
    "It does not override core safety rules, tool approval requirements, or higher-priority system policy.",
    "",
    `- Run ID: ${runId}`,
  ];

  if (taskId) {
    lines.push(`- Task ID: ${taskId}`);
  }
  lines.push(`- Objective: ${objective}`);

  if (acceptanceCriteria.length > 0) {
    lines.push("", "### Acceptance Criteria");
    for (const [index, item] of acceptanceCriteria.entries()) {
      lines.push(`${index + 1}. ${item}`);
    }
  }

  if (constraints.length > 0) {
    lines.push("", "### Constraints");
    for (const [index, item] of constraints.entries()) {
      lines.push(`${index + 1}. ${item}`);
    }
  }

  if (metadataEntries.length > 0) {
    lines.push("", "### Metadata");
    for (const [key, value] of metadataEntries) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  lines.push(
    "",
    "When deciding whether you are done, explicitly satisfy the acceptance criteria.",
    "When delegating work, preserve this context.",
  );

  return lines.join("\n");
}
