import type { SDKMessage } from "@cursor/sdk";
import { asRecord, asString } from "./piRuntimeOptions";
import type { RuntimeRunTurnParams } from "./types";

type StreamItemState = {
  kind: "text" | "reasoning" | "tool";
  toolName?: string;
  started: boolean;
  text: string;
};

export type CursorSdkStreamBridge = {
  handleMessage: (message: SDKMessage) => Promise<void>;
  assistantText: () => string;
  reasoningText: () => string | undefined;
};

export function createCursorSdkStreamBridge(params: RuntimeRunTurnParams): CursorSdkStreamBridge {
  const items = new Map<string, StreamItemState>();
  const itemOrder: string[] = [];

  const ensureItem = (
    id: string,
    kind: StreamItemState["kind"],
    toolName?: string,
  ): StreamItemState => {
    const existing = items.get(id);
    if (existing) return existing;
    const created: StreamItemState = { kind, toolName, started: false, text: "" };
    items.set(id, created);
    itemOrder.push(id);
    return created;
  };

  const startItem = async (id: string, kind: StreamItemState["kind"], toolName?: string) => {
    const item = ensureItem(id, kind, toolName);
    if (item.started) return;
    item.started = true;
    if (kind === "text") {
      await params.onModelStreamPart?.({ type: "text-start", id });
    } else if (kind === "reasoning") {
      await params.onModelStreamPart?.({ type: "reasoning-start", id });
    } else {
      await params.onModelStreamPart?.({
        type: "tool-call",
        toolCallId: id,
        toolName: toolName ?? "cursorTool",
        input: {},
        providerExecuted: true,
      });
    }
  };

  const endItem = async (id: string) => {
    const item = items.get(id);
    if (!item?.started) return;
    if (item.kind === "text") {
      await params.onModelStreamPart?.({ type: "text-end", id });
    } else if (item.kind === "reasoning") {
      await params.onModelStreamPart?.({ type: "reasoning-end", id });
    } else {
      await params.onModelStreamPart?.({
        type: "tool-result",
        toolCallId: id,
        toolName: item.toolName ?? "cursorTool",
        output: item.text || null,
        providerExecuted: true,
      });
    }
  };

  return {
    async handleMessage(message) {
      switch (message.type) {
        case "assistant": {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) {
              const id = `${message.run_id}:assistant`;
              await startItem(id, "text");
              const item = ensureItem(id, "text");
              item.text += block.text;
              await params.onModelStreamPart?.({
                type: "text-delta",
                id,
                text: block.text,
              });
            }
          }
          break;
        }
        case "thinking": {
          const id = `${message.run_id}:thinking`;
          await startItem(id, "reasoning");
          const item = ensureItem(id, "reasoning");
          item.text += message.text;
          await params.onModelStreamPart?.({
            type: "reasoning-delta",
            id,
            text: message.text,
          });
          if (message.thinking_duration_ms !== undefined) {
            await endItem(id);
          }
          break;
        }
        case "tool_call": {
          const id = message.call_id;
          if (message.status === "running") {
            await startItem(id, "tool", message.name);
            return;
          }
          const item = ensureItem(id, "tool", message.name);
          if (message.status === "error") {
            await params.onModelStreamPart?.({
              type: "tool-error",
              toolCallId: id,
              toolName: message.name,
              error: stringifyUnknown(message.result ?? "tool failed"),
              providerExecuted: true,
            });
          } else {
            item.text = stringifyUnknown(message.result);
            await endItem(id);
          }
          break;
        }
        case "request": {
          const answer = await params.askUser?.(
            "Cursor agent is waiting for your input to continue.",
          );
          if (answer) {
            params.log?.(`[cursor-sdk] user response captured for request ${message.request_id}`);
          }
          break;
        }
        case "status":
          params.log?.(
            `[cursor-sdk] status ${message.status}${message.message ? `: ${message.message}` : ""}`,
          );
          break;
        case "task":
          if (message.text) {
            params.log?.(`[cursor-sdk] task: ${message.text}`);
          }
          break;
        default:
          break;
      }
    },
    assistantText: () =>
      itemOrder
        .map((id) => {
          const item = items.get(id);
          return item?.kind === "text" ? item.text.trim() : "";
        })
        .filter(Boolean)
        .join("\n"),
    reasoningText: () => {
      const chunks = itemOrder
        .map((id) => {
          const item = items.get(id);
          return item?.kind === "reasoning" ? item.text.trim() : "";
        })
        .filter(Boolean);
      return chunks.length > 0 ? chunks.join("\n") : undefined;
    },
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function usageFromTurnEnded(update: unknown):
  | {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedPromptTokens?: number;
    }
  | undefined {
  const record = asRecord(update);
  if (record?.type !== "turn-ended") return undefined;
  const usage = asRecord(record.usage);
  if (!usage) return undefined;
  const promptTokens = Number(usage.inputTokens ?? 0);
  const completionTokens = Number(usage.outputTokens ?? 0);
  const cachedPromptTokens = Number(usage.cacheReadTokens ?? 0) || undefined;
  const totalTokens =
    promptTokens +
    completionTokens +
    (cachedPromptTokens ?? 0) +
    Number(usage.cacheWriteTokens ?? 0);
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
  };
}

export function extractSdkImages(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of content) {
    const record = asRecord(part);
    const data = asString(record?.data);
    const mimeType = asString(record?.mimeType) ?? asString(record?.mime_type) ?? "image/png";
    const type = asString(record?.type);
    if (data && (type === "image" || mimeType.startsWith("image/"))) {
      images.push({ data, mimeType });
    }
  }
  return images;
}
