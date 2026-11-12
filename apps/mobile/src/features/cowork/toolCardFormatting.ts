import {
  getRecordValue,
  humanizeToolName,
  isRecord,
  summarizeSharedToolArgs,
  summarizeToolResult,
  type ToolCardFormatting,
  toText,
  truncate,
} from "../../../../../src/shared/toolCardFormatting";
import type { ToolFeedState } from "../../../../../src/shared/toolFeedState";

function summarizeArgs(name: string, args: unknown): string {
  if (!isRecord(args)) return "";

  const shared = summarizeSharedToolArgs(name, args);
  if (shared !== null) return shared;

  const base = name.toLowerCase();
  if (base === "bash") {
    const command = getRecordValue(args, ["command", "cmd"]);
    return command ? `Command: ${truncate(toText(command), 90)}` : "";
  }
  if (base === "write" || base === "edit" || base === "read") {
    const filePath = getRecordValue(args, ["filePath", "path"]);
    return filePath ? `File: ${truncate(toText(filePath), 90)}` : "";
  }
  if (base === "todowrite") {
    const count = getRecordValue(args, ["count"]);
    return count !== undefined ? `Updated ${toText(count)} tasks` : "";
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

export function formatToolCard(
  name: string,
  args: unknown,
  result: unknown,
  state: ToolFeedState,
): ToolCardFormatting {
  const title = humanizeToolName(name);
  const argsSummary = summarizeArgs(name, args);
  const resultSummary = summarizeToolResult(name, state, result);
  const subtitle = argsSummary ? `${argsSummary} • ${resultSummary}` : resultSummary;

  return {
    title,
    subtitle,
    details: [],
  };
}
