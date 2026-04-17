import { z } from "zod";

import type { SessionFeedItem } from "./sessionSnapshot";
import {
  SERVER_ERROR_CODES,
  SERVER_ERROR_SOURCES,
  type TodoItem,
} from "../types";

const nonEmptyStringSchema = z.string().trim().min(1);
const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string(),
}).strict();

export const projectedToolStateSchema = z.enum([
  "input-streaming",
  "input-available",
  "approval-requested",
  "output-available",
  "output-error",
  "output-denied",
]);

export const projectedUserMessageContentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
}).strict();

export const projectedItemSchema = z.discriminatedUnion("type", [
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("userMessage"),
    content: z.array(projectedUserMessageContentPartSchema),
    clientMessageId: nonEmptyStringSchema.optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("agentMessage"),
    text: z.string(),
    annotations: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("reasoning"),
    mode: z.enum(["reasoning", "summary"]),
    text: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("toolCall"),
    toolName: z.string(),
    state: projectedToolStateSchema,
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    approval: z.object({
      approvalId: nonEmptyStringSchema,
      reason: z.unknown().optional(),
      toolCall: z.unknown().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("system"),
    line: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("log"),
    line: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("todos"),
    todos: z.array(todoItemSchema),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("error"),
    message: z.string(),
    code: z.enum(SERVER_ERROR_CODES),
    source: z.enum(SERVER_ERROR_SOURCES),
  }).strict(),
]);

export type ProjectedItem = z.infer<typeof projectedItemSchema>;
export type ProjectedToolState = z.infer<typeof projectedToolStateSchema>;

function userMessageText(content: Array<{ type: "text"; text: string }>): string {
  return content
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function existingTsOr(ts: string, existing?: SessionFeedItem): string {
  return existing?.ts ?? ts;
}

function toFeedItem(
  item: ProjectedItem,
  ts: string,
  existing?: SessionFeedItem,
): SessionFeedItem {
  switch (item.type) {
    case "userMessage":
      return {
        id: item.id,
        kind: "message",
        role: "user",
        ts: existingTsOr(ts, existing),
        text: userMessageText(item.content),
      };
    case "agentMessage":
      return {
        id: item.id,
        kind: "message",
        role: "assistant",
        ts: existingTsOr(ts, existing),
        text: item.text,
        ...(item.annotations ? { annotations: item.annotations } : {}),
      };
    case "reasoning":
      return {
        id: item.id,
        kind: "reasoning",
        mode: item.mode,
        ts: existingTsOr(ts, existing),
        text: item.text,
      };
    case "toolCall":
      return {
        id: item.id,
        kind: "tool",
        ts: existingTsOr(ts, existing),
        name: item.toolName,
        state: item.state,
        ...(item.args !== undefined ? { args: item.args } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
        ...(item.approval ? { approval: item.approval } : {}),
      };
    case "system":
      return {
        id: item.id,
        kind: "system",
        ts: existingTsOr(ts, existing),
        line: item.line,
      };
    case "log":
      return {
        id: item.id,
        kind: "log",
        ts: existingTsOr(ts, existing),
        line: item.line,
      };
    case "todos":
      return {
        id: item.id,
        kind: "todos",
        ts: existingTsOr(ts, existing),
        todos: item.todos,
      };
    case "error":
      return {
        id: item.id,
        kind: "error",
        ts: existingTsOr(ts, existing),
        message: item.message,
        code: item.code,
        source: item.source,
      };
  }
}

function upsertFeedItem(feed: SessionFeedItem[], item: ProjectedItem, ts: string): SessionFeedItem[] {
  const index = feed.findIndex((entry) => entry.id === item.id);
  const existing = index >= 0 ? feed[index] : undefined;
  const next = toFeedItem(item, ts, existing);
  if (index < 0) {
    return [...feed, next];
  }
  const updated = [...feed];
  updated[index] = next;
  return updated;
}

export function applyProjectedItemStarted(
  feed: SessionFeedItem[],
  item: ProjectedItem,
  ts: string,
): SessionFeedItem[] {
  return upsertFeedItem(feed, item, ts);
}

export function applyProjectedItemCompleted(
  feed: SessionFeedItem[],
  item: ProjectedItem,
  ts: string,
): SessionFeedItem[] {
  return upsertFeedItem(feed, item, ts);
}

export function applyProjectedAgentMessageDelta(
  feed: SessionFeedItem[],
  itemId: string,
  delta: string,
  ts: string,
): SessionFeedItem[] {
  const index = feed.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return [
      ...feed,
      {
        id: itemId,
        kind: "message",
        role: "assistant",
        ts,
        text: delta,
      },
    ];
  }
  const existing = feed[index];
  if (!existing || existing.kind !== "message" || existing.role !== "assistant") {
    return feed;
  }
  const updated = [...feed];
  updated[index] = {
    ...existing,
    text: `${existing.text}${delta}`,
  };
  return updated;
}

export function applyProjectedReasoningDelta(
  feed: SessionFeedItem[],
  itemId: string,
  mode: "reasoning" | "summary",
  delta: string,
  ts: string,
): SessionFeedItem[] {
  const index = feed.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return [
      ...feed,
      {
        id: itemId,
        kind: "reasoning",
        mode,
        ts,
        text: delta,
      },
    ];
  }
  const existing = feed[index];
  if (!existing || existing.kind !== "reasoning") {
    return feed;
  }
  const updated = [...feed];
  updated[index] = {
    ...existing,
    mode,
    text: `${existing.text}${delta}`,
  };
  return updated;
}

export function projectedTodosFromItem(item: ProjectedItem): TodoItem[] | null {
  return item.type === "todos" ? item.todos : null;
}
