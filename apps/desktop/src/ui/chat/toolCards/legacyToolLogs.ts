import type { FeedItem } from "../../../app/types";
import { z } from "zod";

export type LegacyToolLog = {
  direction: "start" | "finish";
  name: string;
  payload?: unknown;
};

const LEGACY_TOOL_LOG_RE = /^tool([<>])\s+([A-Za-z0-9_.:-]+)(?:\s+(.+))?$/;
const toolDirectionSymbolSchema = z.enum([">", "<"]);
const toolNameSchema = z.string().trim().regex(/^[A-Za-z0-9_.:-]+$/);
const payloadTextSchema = z.string().trim().min(1);
const payloadErrorStatusSchema = z.object({
  error: z.unknown().optional(),
  denied: z.unknown().optional(),
}).passthrough();

function parsePayload(value: unknown): unknown {
  const parsedPayloadText = payloadTextSchema.safeParse(value);
  if (!parsedPayloadText.success) return undefined;

  try {
    return JSON.parse(parsedPayloadText.data);
  } catch {
    return parsedPayloadText.data;
  }
}

function inferStatusFromPayload(payload: unknown): "done" | "error" {
  const parsedPayload = payloadErrorStatusSchema.safeParse(payload);
  if (parsedPayload.success) {
    if ("error" in parsedPayload.data || "denied" in parsedPayload.data) return "error";
  }
  return "done";
}

export function parseLegacyToolLogLine(line: string): LegacyToolLog | null {
  const match = line.match(LEGACY_TOOL_LOG_RE);
  if (!match) return null;

  const directionSymbol = toolDirectionSymbolSchema.safeParse(match[1]);
  const name = toolNameSchema.safeParse(match[2]);
  if (!directionSymbol.success || !name.success) return null;

  return {
    direction: directionSymbol.data === ">" ? "start" : "finish",
    name: name.data,
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
