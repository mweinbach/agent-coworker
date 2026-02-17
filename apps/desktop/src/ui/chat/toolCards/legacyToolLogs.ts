import type { FeedItem } from "../../../app/types";

export type LegacyToolLog = {
  direction: "start" | "finish";
  name: string;
  payload?: unknown;
};

const LEGACY_TOOL_LOG_RE = /^tool([<>])\s+([A-Za-z0-9_.:-]+)(?:\s+(.+))?$/;

function parsePayload(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function inferStatusFromPayload(payload: unknown): "done" | "error" {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if ("error" in record || "denied" in record) return "error";
  }
  return "done";
}

export function parseLegacyToolLogLine(line: string): LegacyToolLog | null {
  const match = line.match(LEGACY_TOOL_LOG_RE);
  if (!match) return null;
  return {
    direction: match[1] === ">" ? "start" : "finish",
    name: match[2],
    payload: parsePayload(match[3]),
  };
}

export function normalizeFeedForToolCards(feed: FeedItem[], developerMode: boolean): FeedItem[] {
  if (developerMode) return feed;

  const out: FeedItem[] = [];
  const pendingByName = new Map<string, number[]>();

  for (const item of feed) {
    if (item.kind !== "log") {
      out.push(item);
      continue;
    }

    const parsed = parseLegacyToolLogLine(item.line);
    if (!parsed) {
      out.push(item);
      continue;
    }

    if (parsed.direction === "start") {
      out.push({
        id: item.id,
        kind: "tool",
        ts: item.ts,
        name: parsed.name,
        status: "running",
        args: parsed.payload,
      });
      const pending = pendingByName.get(parsed.name) ?? [];
      pending.push(out.length - 1);
      pendingByName.set(parsed.name, pending);
      continue;
    }

    const pending = pendingByName.get(parsed.name);
    if (pending && pending.length > 0) {
      const idx = pending.shift()!;
      const existing = out[idx];
      if (existing && existing.kind === "tool") {
        out[idx] = {
          ...existing,
          status: inferStatusFromPayload(parsed.payload),
          result: parsed.payload,
        };
      }
      if (pending.length === 0) pendingByName.delete(parsed.name);
      continue;
    }

    out.push({
      id: item.id,
      kind: "tool",
      ts: item.ts,
      name: parsed.name,
      status: inferStatusFromPayload(parsed.payload),
      result: parsed.payload,
    });
  }

  return out;
}
