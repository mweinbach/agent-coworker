import type { SessionEvent } from "../protocol";

function previewValue(value: unknown, maxChars = 160): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars - 1)}...` : value;
  }
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}...` : raw;
  } catch {
    const fallback = String(value);
    return fallback.length > maxChars ? `${fallback.slice(0, maxChars - 1)}...` : fallback;
  }
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function humanizeUnderscoreLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuestionPreview(question: string, maxChars = 220): string {
  let normalized = question.trim().replace(/\s+/g, " ");
  normalized = normalized.replace(/^question:\s*/i, "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

export function formatAskSystemLine(evt: Extract<SessionEvent, { type: "ask" }>): string {
  const preview = normalizeQuestionPreview(evt.question);
  return preview ? `question: ${preview}` : "question:";
}

export function formatApprovalSystemLine(evt: Extract<SessionEvent, { type: "approval" }>): string {
  const command = evt.command.trim();
  return command ? `approval requested: ${command}` : "approval requested";
}

function formatObservabilityDiagnosticLine(evt: {
  enabled: boolean;
  health: { status?: unknown; reason?: unknown; message?: unknown };
  config?: unknown;
}): string {
  const configured =
    isRecord(evt.config) && typeof evt.config.configured === "boolean"
      ? evt.config.configured
      : false;
  const healthStatus = typeof evt.health.status === "string" ? evt.health.status : "unknown";
  const healthReason = typeof evt.health.reason === "string" ? evt.health.reason : "unknown";
  const healthMessage = previewValue(evt.health.message);
  const healthDetail = healthMessage ? `${healthReason}: ${healthMessage}` : healthReason;
  return `Observability: enabled=${yesNo(evt.enabled)}, configured=${yesNo(configured)}, health=${healthStatus} (${healthDetail})`;
}

function formatSessionBackupDiagnosticLine(evt: { reason?: unknown; backup?: unknown }): string {
  const reason =
    typeof evt.reason === "string" && evt.reason.trim().length > 0
      ? humanizeUnderscoreLabel(evt.reason)
      : "update";
  const status =
    isRecord(evt.backup) && typeof evt.backup.status === "string" ? evt.backup.status : "unknown";
  const checkpointCount =
    isRecord(evt.backup) && Array.isArray(evt.backup.checkpoints)
      ? evt.backup.checkpoints.length
      : null;
  return checkpointCount === null
    ? `Session backup (${reason}): status=${status}`
    : `Session backup (${reason}): status=${status}, checkpoints=${checkpointCount}`;
}

function formatHarnessContextDiagnosticLine(evt: { context?: unknown }): string {
  if (evt.context === null || evt.context === undefined) {
    return "Harness context cleared";
  }
  if (!isRecord(evt.context)) {
    return "Harness context updated";
  }

  const details: string[] = [];
  if (typeof evt.context.taskId === "string" && evt.context.taskId.trim().length > 0) {
    details.push(`taskId=${evt.context.taskId}`);
  }
  if (typeof evt.context.runId === "string" && evt.context.runId.trim().length > 0) {
    details.push(`runId=${evt.context.runId}`);
  }
  if (typeof evt.context.objective === "string" && evt.context.objective.trim().length > 0) {
    details.push(`objective=${previewValue(evt.context.objective, 80)}`);
  }
  if (Array.isArray(evt.context.acceptanceCriteria)) {
    details.push(`acceptanceCriteria=${evt.context.acceptanceCriteria.length}`);
  }
  if (Array.isArray(evt.context.constraints)) {
    details.push(`constraints=${evt.context.constraints.length}`);
  }
  return details.length > 0
    ? `Harness context updated: ${details.join(", ")}`
    : "Harness context updated";
}

export function developerDiagnosticSystemLineFromSessionEvent(
  evt: Extract<
    SessionEvent,
    { type: "observability_status" | "session_backup_state" | "harness_context" }
  >,
): string {
  switch (evt.type) {
    case "observability_status":
      return formatObservabilityDiagnosticLine(evt);
    case "session_backup_state":
      return formatSessionBackupDiagnosticLine(evt);
    case "harness_context":
      return formatHarnessContextDiagnosticLine(evt);
  }
}

export function shouldSuppressRawDebugLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^raw stream part:/i.test(trimmed)) return true;
  if (/response\.function_call_arguments\./i.test(trimmed)) return true;
  if (/response\.reasoning(?:_|\.|[a-z])/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"response\./i.test(trimmed)) return true;
  if (/\bobfuscation\b/i.test(trimmed)) return true;

  return false;
}
