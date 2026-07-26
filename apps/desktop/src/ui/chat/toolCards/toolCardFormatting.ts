import type { ToolFeedState } from "../../../app/types";
import { ASK_SKIP_TOKEN } from "../../../lib/wsProtocol";

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

/** Middle-ellipsis path display so the basename stays visible. */
export function formatDisplayPath(path: string, max = 48): string {
  const raw = path.trim();
  if (!raw) return "";
  if (raw.length <= max) return raw;

  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const basename = parts[parts.length - 1] ?? raw;
  const drive = raw.match(/^[A-Za-z]:/)?.[0] ?? (raw.startsWith("\\\\") ? "\\\\" : "");

  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    const tail = `${parent}/${basename}`;
    if (tail.length + 2 <= max) {
      const prefix = drive ? `${drive}/…/` : "…/";
      return `${prefix}${tail}`;
    }
  }
  if (basename.length + 2 <= max) {
    return `…/${basename}`;
  }
  if (basename.length <= max) return basename;
  const head = Math.max(8, Math.floor((max - 1) / 2));
  const tail = Math.max(8, max - 1 - head);
  return `${basename.slice(0, head)}…${basename.slice(-tail)}`;
}

function isGenericSuccessSummary(summary: string): boolean {
  return summary === "Completed" || summary === "Completed successfully";
}

function composeToolSubtitle(
  argsSummary: string,
  resultSummary: string,
  state: ToolFeedState,
  preferArgsWhileRunning: boolean,
): string {
  if (!argsSummary) return resultSummary;
  if (preferArgsWhileRunning) {
    if (state === "output-available" || state === "output-error" || state === "output-denied") {
      return isGenericSuccessSummary(resultSummary)
        ? argsSummary
        : `${argsSummary} · ${resultSummary}`;
    }
    return argsSummary;
  }
  if (state === "output-available" && isGenericSuccessSummary(resultSummary)) {
    return argsSummary;
  }
  if (state === "input-streaming" || state === "input-available") {
    return argsSummary;
  }
  if (state === "output-error" || state === "output-denied" || state === "approval-requested") {
    return `${argsSummary} • ${resultSummary}`;
  }
  return isGenericSuccessSummary(resultSummary) ? argsSummary : `${argsSummary} • ${resultSummary}`;
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

function nativeGoogleToolKind(name: string): "web-search" | "url-context" | null {
  const normalized = name.toLowerCase();
  if (normalized === "nativewebsearch") return "web-search";
  if (normalized === "nativeurlcontext") return "url-context";
  return null;
}

function recordStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function firstStringArrayValue(record: Record<string, unknown>, key: string): string | null {
  const values = recordStringArray(record, key);
  return values[0] ?? null;
}

function humanizeToolName(name: string): string {
  const nativeKind = nativeGoogleToolKind(name);
  if (nativeKind === "web-search") {
    return "Web Search";
  }
  if (nativeKind === "url-context") {
    return "URL Context";
  }
  const compact = name.replace(/^tool[:._-]?/i, "");
  const withSpaces = compact.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  const trimmed = withSpaces.trim();
  if (!trimmed) return "Tool";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function nativeWebSearchAction(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.action)) return value.action;
  const actionType = getRecordValue(value, ["type"]);
  if (typeof actionType === "string" && actionType.trim().length > 0) {
    return value;
  }
  const queries = recordStringArray(value, "queries");
  if (queries.length > 0) {
    return {
      type: "search",
      ...(queries.length === 1 ? { query: queries[0] } : {}),
      queries,
    };
  }
  return null;
}

function nativeWebSearchActionSummary(action: Record<string, unknown>): string {
  const actionType = toText(getRecordValue(action, ["type"]))
    .trim()
    .toLowerCase();
  if (actionType === "search") {
    const query =
      getRecordValue(action, ["query", "q"]) ?? firstStringArrayValue(action, "queries");
    if (query) {
      return `Search: ${truncate(toText(query), 90)}`;
    }
    const queryCount = recordStringArray(action, "queries").length;
    return queryCount > 1 ? `Searches: ${queryCount}` : "Search completed";
  }
  if (actionType === "open_page") {
    const url = getRecordValue(action, ["url"]);
    return url ? `Opened: ${truncate(toText(url), 90)}` : "Opened page";
  }
  if (actionType === "find_in_page") {
    const pattern = getRecordValue(action, ["pattern", "query"]);
    const url = getRecordValue(action, ["url"]);
    if (pattern && url) {
      return `${truncate(`'${toText(pattern)}'`, 36)} in ${truncate(toText(url), 60)}`;
    }
    if (pattern) {
      return `Find: ${truncate(toText(pattern), 90)}`;
    }
    return "Find in page completed";
  }
  return "Searching the web";
}

function summarizeArgs(name: string, args: unknown): string {
  if (!isRecord(args)) return "";

  const nativeKind = nativeGoogleToolKind(name);
  if (nativeKind === "web-search") {
    const action = nativeWebSearchAction(args);
    return action ? nativeWebSearchActionSummary(action) : "Searching the web";
  }
  if (nativeKind === "url-context") {
    const urls = recordStringArray(args, "urls");
    if (urls.length === 1 && urls[0]) return `Reading: ${truncate(urls[0], 90)}`;
    if (urls.length > 1) return `Reading ${urls.length} URLs`;
    return "Reading URL context";
  }

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
    return filePath ? formatDisplayPath(toText(filePath), 52) : "";
  }
  if (base === "glob") {
    const pattern = getRecordValue(args, ["pattern"]);
    return pattern ? `Pattern: ${truncate(toText(pattern), 90)}` : "";
  }
  if (base === "todowrite") {
    const todos = getRecordValue(args, ["todos"]);
    if (Array.isArray(todos) && todos.length > 0) {
      let completed = 0;
      let inProgress = 0;
      let pending = 0;
      for (const entry of todos) {
        if (!isRecord(entry)) continue;
        const status = toText(entry.status).toLowerCase();
        if (status === "completed") completed += 1;
        else if (status === "in_progress") inProgress += 1;
        else pending += 1;
      }
      const total = todos.length;
      if (completed === total) {
        return total === 1 ? "Completed 1 task" : `Completed ${total} tasks`;
      }
      const parts: string[] = [];
      if (inProgress > 0) parts.push(`${inProgress} active`);
      if (completed > 0) parts.push(`${completed} complete`);
      if (pending > 0) parts.push(`${pending} pending`);
      if (parts.length > 0) return parts.join(" · ");
      return total === 1 ? "Updated 1 task" : `Updated ${total} tasks`;
    }
    const count = getRecordValue(args, ["count"]);
    return count !== undefined ? `Updated ${toText(count)} tasks` : "";
  }
  if (base === "ask") {
    const question = getRecordValue(args, ["question"]);
    return question ? truncate(toText(question), 90) : "";
  }
  if (base === "spawnagent") {
    const nickname = getRecordValue(args, ["nickname", "name"]);
    const role = getRecordValue(args, ["role"]);
    const task = getRecordValue(args, ["message", "task", "prompt"]);
    if (nickname && role) return `${toText(nickname)} · ${toText(role)}`;
    if (nickname) return toText(nickname);
    if (role) return `Role: ${toText(role)}`;
    if (task) return truncate(toText(task), 90);
    return "";
  }
  if (base === "waitforagent") {
    const agentIds = getRecordValue(args, ["agentIds", "agents"]);
    if (Array.isArray(agentIds) && agentIds.length > 0) {
      return agentIds.length === 1
        ? "Waiting for 1 agent"
        : `Waiting for ${agentIds.length} agents`;
    }
    const mode = getRecordValue(args, ["mode"]);
    return mode ? `Mode: ${toText(mode)}` : "Waiting for agents";
  }

  const common = getRecordValue(args, [
    "query",
    "command",
    "filePath",
    "path",
    "url",
    "pattern",
    "input",
  ]);
  return common ? truncate(toText(common), 90) : "";
}

function summarizeAskResult(result: unknown): string | null {
  if (!isRecord(result)) return null;

  const directAnswer = getRecordValue(result, ["answer"]);
  if (typeof directAnswer === "string") {
    const trimmed = directAnswer.trim();
    if (!trimmed) return "No answer (rejected)";
    if (trimmed === ASK_SKIP_TOKEN) return "Skipped";
    return `Answer: ${truncate(trimmed, 90)}`;
  }

  const answers = getRecordValue(result, ["answers"]);
  if (!isRecord(answers)) return null;
  const normalizedAnswers = Object.values(answers)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim());

  if (normalizedAnswers.length === 0) return null;
  const nonEmpty = normalizedAnswers.filter((value) => value.length > 0);
  if (nonEmpty.length === 0) return "No answer (rejected)";

  if (nonEmpty.length === 1) {
    if (nonEmpty[0] === ASK_SKIP_TOKEN) return "Skipped";
    return `Answer: ${truncate(nonEmpty[0], 90)}`;
  }

  const skippedCount = nonEmpty.filter((value) => value === ASK_SKIP_TOKEN).length;
  if (skippedCount === nonEmpty.length) return `Skipped ${nonEmpty.length} questions`;
  if (skippedCount > 0) return `Answered ${nonEmpty.length} questions (${skippedCount} skipped)`;
  return `Answered ${nonEmpty.length} questions`;
}

function summarizeResult(name: string, state: ToolFeedState, result: unknown): string {
  const nativeKind = nativeGoogleToolKind(name);
  if (nativeKind === "web-search" || nativeKind === "url-context") {
    const waitingLabel = nativeKind === "url-context" ? "Reading URL context" : "Searching the web";
    if (state === "input-streaming" || state === "input-available") {
      return waitingLabel;
    }
    if (state === "approval-requested") {
      return "Waiting for approval";
    }
    if (state === "output-error" || state === "output-denied") {
      if (isRecord(result)) {
        const error = getRecordValue(result, ["error", "message", "reason"]);
        if (error) {
          return truncate(`Error: ${toText(error)}`, 90);
        }
      }
      return state === "output-denied"
        ? "Denied"
        : nativeKind === "url-context"
          ? "URL context failed"
          : "Web search failed";
    }

    if (!isRecord(result)) return "Completed";

    if (nativeKind === "web-search") {
      const action = nativeWebSearchAction(result);
      if (action) return nativeWebSearchActionSummary(action);
      const queries = recordStringArray(result, "queries");
      if (queries.length === 1 && queries[0]) return `Search: ${truncate(queries[0], 90)}`;
      if (queries.length > 1) return `Searches: ${queries.length}`;
      return "Completed";
    }

    if (nativeKind === "url-context") {
      const urls = recordStringArray(result, "urls");
      const urlResults = Array.isArray(result.results) ? result.results.length : 0;
      if (urls.length === 1 && urls[0]) return `Read: ${truncate(urls[0], 90)}`;
      if (urls.length > 1) return `Read ${urls.length} URLs`;
      if (urlResults > 0) return `URL results: ${urlResults}`;
      return "Completed";
    }
  }

  if (state === "input-streaming") return "Capturing input…";
  if (state === "input-available") return "Running…";
  if (state === "approval-requested") return "Waiting for approval";
  if (state === "output-error" || state === "output-denied") {
    if (isRecord(result)) {
      const error = getRecordValue(result, ["error", "message", "reason"]);
      const prefix = state === "output-denied" ? "Denied" : "Error";
      if (error) return truncate(`${prefix}: ${toText(error)}`, 90);
    }
    return state === "output-denied" ? "Denied" : "Finished with an issue";
  }

  if (!isRecord(result)) return "Completed";

  const base = name.toLowerCase();
  if (base === "ask") {
    const askSummary = summarizeAskResult(result);
    if (askSummary) return askSummary;
  }
  if (base === "spawnagent") {
    const agentId = getRecordValue(result, ["agentId", "id"]);
    const nickname = getRecordValue(result, ["nickname", "name"]);
    if (nickname) return `Spawned ${toText(nickname)}`;
    if (agentId) return `Spawned ${truncate(toText(agentId), 12)}`;
    return "Agent started";
  }
  if (base === "waitforagent") {
    const status = getRecordValue(result, ["status", "mode"]);
    const completed = getRecordValue(result, ["completed", "done"]);
    if (completed !== undefined) return `Done: ${toText(completed)}`;
    if (status) return truncate(toText(status), 90);
    return "Agents settled";
  }

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

function buildDetailsRows(
  args: unknown,
  result: unknown,
  state: ToolFeedState,
): ToolCardDetailsRow[] {
  const rows: ToolCardDetailsRow[] = [
    {
      label: "Status",
      value:
        state === "input-streaming"
          ? "Capturing Input"
          : state === "input-available"
            ? "Running"
            : state === "approval-requested"
              ? "Awaiting Approval"
              : state === "output-available"
                ? "Done"
                : state === "output-denied"
                  ? "Denied"
                  : "Error",
    },
  ];

  if (isRecord(args)) {
    if (isRecord(args.action)) {
      const action = args.action;
      const actionType = getRecordValue(action, ["type"]);
      const query = getRecordValue(action, ["query", "q", "pattern"]);
      const url = getRecordValue(action, ["url"]);
      if (actionType) rows.push({ label: "Action", value: toText(actionType) });
      if (query) rows.push({ label: "Query", value: truncate(toText(query), 140) });
      if (url) rows.push({ label: "URL", value: truncate(toText(url), 140) });
    }

    const command = getRecordValue(args, ["command", "cmd"]);
    const query = getRecordValue(args, ["query", "q"]);
    const filePath = getRecordValue(args, ["filePath", "path"]);
    const url = getRecordValue(args, ["url"]);
    const pattern = getRecordValue(args, ["pattern"]);
    const count = getRecordValue(args, ["count"]);
    const urls = recordStringArray(args, "urls");
    const queries = recordStringArray(args, "queries");

    if (command) rows.push({ label: "Command", value: truncate(toText(command), 140) });
    if (query) rows.push({ label: "Query", value: truncate(toText(query), 140) });
    if (filePath) rows.push({ label: "Path", value: toText(filePath) });
    if (url) rows.push({ label: "URL", value: truncate(toText(url), 140) });
    if (pattern) rows.push({ label: "Pattern", value: truncate(toText(pattern), 140) });
    if (count !== undefined) rows.push({ label: "Count", value: toText(count) });
    const todos = getRecordValue(args, ["todos"]);
    if (Array.isArray(todos) && todos.length > 0) {
      rows.push({ label: "Tasks", value: toText(todos.length) });
    }
    if (urls.length === 1 && urls[0]) rows.push({ label: "URL", value: truncate(urls[0], 140) });
    if (urls.length > 1) rows.push({ label: "URLs", value: toText(urls.length) });
    if (queries.length === 1 && queries[0])
      rows.push({ label: "Query", value: truncate(queries[0], 140) });
    if (queries.length > 1) rows.push({ label: "Queries", value: toText(queries.length) });
  }

  if (isRecord(result)) {
    const action = nativeWebSearchAction(result);
    if (action) {
      const actionType = getRecordValue(action, ["type"]);
      const query = getRecordValue(action, ["query", "q", "pattern"]);
      const url = getRecordValue(action, ["url"]);
      const sources = Array.isArray(result.sources)
        ? result.sources
        : Array.isArray(action.sources)
          ? action.sources
          : [];
      if (actionType) rows.push({ label: "Action", value: toText(actionType) });
      if (query) rows.push({ label: "Query", value: truncate(toText(query), 140) });
      if (url) rows.push({ label: "URL", value: truncate(toText(url), 140) });
      if (sources.length > 0) rows.push({ label: "Sources", value: toText(sources.length) });
    }

    const exitCode = getRecordValue(result, ["exitCode"]);
    const resultCount = getRecordValue(result, ["count"]);
    const provider = getRecordValue(result, ["provider"]);
    const error = getRecordValue(result, ["error", "message", "reason"]);
    const urlResults = Array.isArray(result.results) ? result.results.length : undefined;
    const places = Array.isArray(result.places) ? result.places.length : undefined;
    const widgetContextToken = getRecordValue(result, ["widgetContextToken"]);

    if (exitCode !== undefined) rows.push({ label: "Exit Code", value: toText(exitCode) });
    if (resultCount !== undefined) rows.push({ label: "Result Count", value: toText(resultCount) });
    if (urlResults !== undefined) rows.push({ label: "Results", value: toText(urlResults) });
    if (places !== undefined) rows.push({ label: "Places", value: toText(places) });
    if (widgetContextToken !== undefined) rows.push({ label: "Widget", value: "Available" });
    if (provider !== undefined) rows.push({ label: "Provider", value: toText(provider) });
    if (error !== undefined) rows.push({ label: "Error", value: truncate(toText(error), 140) });
  }

  return rows;
}

export function formatToolCard(
  name: string,
  args: unknown,
  result: unknown,
  state: ToolFeedState,
): ToolCardFormatting {
  const base = name.toLowerCase();
  const title =
    base === "spawnagent"
      ? "Spawn Agent"
      : base === "waitforagent"
        ? "Wait for Agents"
        : humanizeToolName(name);
  const argsSummary = summarizeArgs(name, args);
  const resultSummary = summarizeResult(name, state, result);
  // Prefer the distinctive arg line for in-flight agent tools; appending
  // "Running…" makes parallel spawn rows look identical and out of order.
  // Also drop generic "Completed" when args already describe the call.
  const subtitle = composeToolSubtitle(
    argsSummary,
    resultSummary,
    state,
    base === "spawnagent" || base === "waitforagent",
  );

  return {
    title,
    subtitle,
    details: buildDetailsRows(args, result, state),
  };
}
