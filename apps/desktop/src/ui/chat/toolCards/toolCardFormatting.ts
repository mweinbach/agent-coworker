type ToolCardDetailsRow = {
  label: string;
  value: string;
};

export type ToolCardFormatting = {
  details: ToolCardDetailsRow[];
  subtitle: string;
  title: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function humanizeToolName(name: string): string {
  const compact = name.replace(/^tool[:._-]?/i, "");
  const withSpaces = compact.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  const trimmed = withSpaces.trim();
  if (!trimmed) return "Tool";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function summarizeArgs(name: string, args: unknown): string {
  if (!isRecord(args)) return "";

  const base = name.toLowerCase();
  if (base === "websearch") {
    const query = getRecordValue(args, ["query", "q"]);
    return query ? `Searching for: ${truncate(toText(query), 90)}` : "";
  }
  if (base === "webfetch") {
    const url = getRecordValue(args, ["url"]);
    return url ? `Fetching: ${truncate(toText(url), 90)}` : "";
  }
  if (base === "bash") {
    const command = getRecordValue(args, ["command", "cmd"]);
    return command ? `Command: ${truncate(toText(command), 90)}` : "";
  }
  if (base === "write" || base === "edit" || base === "read") {
    const filePath = getRecordValue(args, ["filePath", "path"]);
    return filePath ? `File: ${truncate(toText(filePath), 90)}` : "";
  }
  if (base === "glob") {
    const pattern = getRecordValue(args, ["pattern"]);
    return pattern ? `Pattern: ${truncate(toText(pattern), 90)}` : "";
  }
  if (base === "todowrite") {
    const count = getRecordValue(args, ["count"]);
    return count !== undefined ? `Updated ${toText(count)} tasks` : "";
  }
  if (base === "ask") {
    const question = getRecordValue(args, ["question"]);
    return question ? truncate(toText(question), 90) : "";
  }

  const common = getRecordValue(args, ["query", "command", "filePath", "path", "url", "pattern", "input"]);
  return common ? truncate(toText(common), 90) : "";
}

function summarizeResult(status: "running" | "done" | "error", result: unknown): string {
  if (status === "running") return "Working…";
  if (status === "error") {
    if (isRecord(result)) {
      const error = getRecordValue(result, ["error", "message", "reason"]);
      if (error) return truncate(`Error: ${toText(error)}`, 90);
    }
    return "Finished with an issue";
  }

  if (!isRecord(result)) return "Completed";

  const exitCode = getRecordValue(result, ["exitCode"]);
  if (exitCode !== undefined) return `Exit code: ${toText(exitCode)}`;

  const count = getRecordValue(result, ["count"]);
  if (count !== undefined) return `Items: ${toText(count)}`;

  const chars = getRecordValue(result, ["chars"]);
  if (chars !== undefined) return `Received ${toText(chars)} chars`;

  const ok = getRecordValue(result, ["ok"]);
  if (ok !== undefined) return ok ? "Completed successfully" : "Completed with warnings";

  const provider = getRecordValue(result, ["provider"]);
  if (provider !== undefined) return `Provider: ${toText(provider)}`;

  return "Completed";
}

function buildDetailsRows(args: unknown, result: unknown, status: "running" | "done" | "error"): ToolCardDetailsRow[] {
  const rows: ToolCardDetailsRow[] = [{ label: "Status", value: status === "running" ? "Running" : status === "done" ? "Done" : "Error" }];

  if (isRecord(args)) {
    const command = getRecordValue(args, ["command", "cmd"]);
    const query = getRecordValue(args, ["query", "q"]);
    const filePath = getRecordValue(args, ["filePath", "path"]);
    const url = getRecordValue(args, ["url"]);
    const pattern = getRecordValue(args, ["pattern"]);
    const count = getRecordValue(args, ["count"]);

    if (command) rows.push({ label: "Command", value: truncate(toText(command), 140) });
    if (query) rows.push({ label: "Query", value: truncate(toText(query), 140) });
    if (filePath) rows.push({ label: "Path", value: truncate(toText(filePath), 140) });
    if (url) rows.push({ label: "URL", value: truncate(toText(url), 140) });
    if (pattern) rows.push({ label: "Pattern", value: truncate(toText(pattern), 140) });
    if (count !== undefined) rows.push({ label: "Count", value: toText(count) });
  }

  if (isRecord(result)) {
    const exitCode = getRecordValue(result, ["exitCode"]);
    const resultCount = getRecordValue(result, ["count"]);
    const provider = getRecordValue(result, ["provider"]);
    const error = getRecordValue(result, ["error", "message", "reason"]);

    if (exitCode !== undefined) rows.push({ label: "Exit Code", value: toText(exitCode) });
    if (resultCount !== undefined) rows.push({ label: "Result Count", value: toText(resultCount) });
    if (provider !== undefined) rows.push({ label: "Provider", value: toText(provider) });
    if (error !== undefined) rows.push({ label: "Error", value: truncate(toText(error), 140) });
  }

  return rows;
}

export function formatToolCard(
  name: string,
  args: unknown,
  result: unknown,
  status: "running" | "done" | "error"
): ToolCardFormatting {
  const title = humanizeToolName(name);
  const argsSummary = summarizeArgs(name, args);
  const resultSummary = summarizeResult(status, result);
  const subtitle = argsSummary ? `${argsSummary} • ${resultSummary}` : resultSummary;

  return {
    title,
    subtitle,
    details: buildDetailsRows(args, result, status),
  };
}
