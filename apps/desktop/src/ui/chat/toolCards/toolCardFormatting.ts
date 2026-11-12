import {
  getRecordValue,
  humanizeToolName as humanizeGenericToolName,
  isRecord,
  nativeWebSearchAction,
  recordStringArray,
  summarizeSharedToolArgs,
  summarizeToolResult,
  type ToolCardDetailsRow,
  type ToolCardFormatting,
  toText,
  truncate,
} from "../../../../../../src/shared/toolCardFormatting";
import type { ToolFeedState } from "../../../app/types";

/** Middle-ellipsis path display so the basename stays visible. */
function formatDisplayPath(path: string, max = 48): string {
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
  if (!argsSummary) {
    return state === "output-available" && isGenericSuccessSummary(resultSummary)
      ? ""
      : resultSummary;
  }
  if (state === "input-streaming" || state === "input-available") {
    return argsSummary;
  }
  if (preferArgsWhileRunning && state === "approval-requested") {
    return argsSummary;
  }
  if (state === "output-available" && isGenericSuccessSummary(resultSummary)) {
    return argsSummary;
  }
  const separator = preferArgsWhileRunning ? " · " : " • ";
  return `${argsSummary}${separator}${resultSummary}`;
}

function humanizeToolName(name: string): string {
  const normalized = name.toLowerCase().replace(/[_.-]/g, "");
  if (normalized === "commandexecution" || normalized === "execcommand" || normalized === "bash") {
    return "Run command";
  }
  if (normalized === "todowrite") return "Update plan";
  if (normalized === "filechange") return "Edit files";
  return humanizeGenericToolName(name);
}

function summarizeArgs(name: string, args: unknown): string {
  if (!isRecord(args)) return "";

  const shared = summarizeSharedToolArgs(name, args);
  if (shared !== null) return shared;

  const base = name.toLowerCase();
  if (
    base === "bash" ||
    base === "commandexecution" ||
    base === "exec_command" ||
    base === "execcommand"
  ) {
    const command = getRecordValue(args, ["command", "cmd"]);
    return command ? truncate(toText(command).replace(/\s+/g, " ").trim(), 110) : "";
  }
  if (base === "write" || base === "edit" || base === "read") {
    const filePath = getRecordValue(args, ["filePath", "path"]);
    return filePath ? formatDisplayPath(toText(filePath), 52) : "";
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
    "cmd",
    "filePath",
    "path",
    "url",
    "pattern",
    "input",
  ]);
  return common ? truncate(toText(common), 90) : "";
}

function summarizeAgentToolResult(base: string, result: Record<string, unknown>): string | null {
  if (base === "spawnagent") {
    const agentId = getRecordValue(result, ["agentId", "id"]);
    const nickname = getRecordValue(result, ["nickname", "name"]);
    if (nickname) return `Spawned ${toText(nickname)}`;
    if (agentId) return `Spawned ${truncate(toText(agentId), 12)}`;
    return "Agent started";
  }
  if (base === "waitforagent") {
    const erroredAgentIds = recordStringArray(result, "erroredAgentIds");
    const timedOut = result.timedOut === true;
    if (erroredAgentIds.length > 0) {
      const failureSummary =
        erroredAgentIds.length === 1 ? "1 agent failed" : `${erroredAgentIds.length} agents failed`;
      return timedOut ? `${failureSummary} · Timed out` : failureSummary;
    }
    if (timedOut) return "Timed out";

    const status = getRecordValue(result, ["status", "mode"]);
    const completed = getRecordValue(result, ["completed", "done"]);
    if (completed !== undefined) return `Done: ${toText(completed)}`;
    if (status) return truncate(toText(status), 90);
    return "Agents settled";
  }
  return null;
}

function pushActionDetailRows(rows: ToolCardDetailsRow[], action: Record<string, unknown>): void {
  const actionType = getRecordValue(action, ["type"]);
  const query = getRecordValue(action, ["query", "q", "pattern"]);
  const url = getRecordValue(action, ["url"]);
  if (actionType) rows.push({ label: "Action", value: toText(actionType) });
  if (query) rows.push({ label: "Query", value: truncate(toText(query), 140) });
  if (url) rows.push({ label: "URL", value: truncate(toText(url), 140) });
}

function buildDetailsRows(
  name: string,
  args: unknown,
  result: unknown,
  state: ToolFeedState,
): ToolCardDetailsRow[] {
  const agentWaitResult =
    name.toLowerCase() === "waitforagent" && state === "output-available" && isRecord(result)
      ? result
      : null;
  const availableStatus =
    agentWaitResult && recordStringArray(agentWaitResult, "erroredAgentIds").length > 0
      ? "Error"
      : agentWaitResult?.timedOut === true
        ? "Timed Out"
        : "Done";
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
                ? availableStatus
                : state === "output-denied"
                  ? "Denied"
                  : "Error",
    },
  ];

  if (isRecord(args)) {
    if (isRecord(args.action)) {
      pushActionDetailRows(rows, args.action);
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
      pushActionDetailRows(rows, action);
      const sources = Array.isArray(result.sources)
        ? result.sources
        : Array.isArray(action.sources)
          ? action.sources
          : [];
      if (sources.length > 0) rows.push({ label: "Sources", value: toText(sources.length) });
    }

    const exitCode = getRecordValue(result, ["exitCode"]);
    const resultCount = getRecordValue(result, ["count"]);
    const provider = getRecordValue(result, ["provider"]);
    const error = getRecordValue(result, ["error"]);
    const message = getRecordValue(result, ["message", "reason"]);
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
    else if (message !== undefined) {
      rows.push({
        label: state === "output-error" || state === "output-denied" ? "Error" : "Message",
        value: truncate(toText(message), 140),
      });
    }
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
  const resultSummary = summarizeToolResult(name, state, result, summarizeAgentToolResult);
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
    details: buildDetailsRows(name, args, result, state),
  };
}
