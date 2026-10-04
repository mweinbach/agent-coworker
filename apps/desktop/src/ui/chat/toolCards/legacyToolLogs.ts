import type { FeedItem } from "../../../app/types";

export type LegacyToolLog = {
  direction: "start" | "finish";
  name: string;
  payload?: unknown;
};

const LEGACY_TOOL_LOG_RE = /^tool([<>])\s+([A-Za-z0-9_.:-]+)(?:\s+(.+))?$/;

function parsePayload(raw: string | undefined): unknown {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function inferStateFromPayload(payload: unknown): Extract<FeedItem, { kind: "tool" }>["state"] {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    if ("error" in payload) return "output-error";
    if ("denied" in payload) return "output-denied";
  }
  return "output-available";
}

export function parseLegacyToolLogLine(line: string): LegacyToolLog | null {
  const match = line.match(LEGACY_TOOL_LOG_RE);
  if (!match?.[1] || !match[2]) return null;

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
  const modernToolNames = new Set(
    feed
      .filter((item): item is Extract<FeedItem, { kind: "tool" }> => item.kind === "tool")
      .map((item) => item.name),
  );

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

    // Modern tool feed items already render these invocations cleanly. Keeping the legacy
    // log lines as logs avoids double-materializing the same tool activity in non-dev mode.
    if (modernToolNames.has(parsed.name)) {
      out.push(item);
      continue;
    }

    if (parsed.direction === "start") {
      out.push({
        id: item.id,
        kind: "tool",
        ts: item.ts,
        name: parsed.name,
        state: "input-available",
        args: parsed.payload,
      });
      const pending = pendingByName.get(parsed.name) ?? [];
      pending.push(out.length - 1);
      pendingByName.set(parsed.name, pending);
      continue;
    }

    const pending = pendingByName.get(parsed.name);
    if (pending && pending.length > 0) {
      const idx = pending.shift();
      if (idx === undefined) continue;
      const existing = out[idx];
      if (existing && existing.kind === "tool") {
        out[idx] = {
          ...existing,
          state: inferStateFromPayload(parsed.payload),
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
      state: inferStateFromPayload(parsed.payload),
      result: parsed.payload,
    });
  }

  return out;
}
