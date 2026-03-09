import { parse as partialParse } from "partial-json";

import type { PiModel } from "./piRuntimeOptions";

type AssistantContentBlock =
  | { type: "thinking"; thinking?: string; thinkingSignature?: string }
  | { type: "text"; text: string; textSignature?: string; phase?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; partialJson?: string };

type ResponsesProjectorOutput = Record<string, any> & {
  content: AssistantContentBlock[];
  usage?: Record<string, any>;
  stopReason?: string;
};

export type ResponsesStreamProjector = {
  output: ResponsesProjectorOutput;
  model?: PiModel;
  currentItem: Record<string, any> | null;
  currentBlock: AssistantContentBlock | null;
};

export function parseStreamingJson(partialJson: string): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") return {};
  try {
    return JSON.parse(partialJson) as Record<string, unknown>;
  } catch {
    try {
      return (partialParse(partialJson) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function calculateCost(model: PiModel, usage: Record<string, any>) {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

function mapStopReason(status: unknown): string {
  if (typeof status !== "string" || !status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${String(status)}`);
  }
}

export function createResponsesStreamProjector(
  output: Record<string, any>,
  model?: PiModel,
): ResponsesStreamProjector {
  const withContent = output as ResponsesProjectorOutput;
  if (!Array.isArray(withContent.content)) {
    withContent.content = [];
  }
  return {
    output: withContent,
    model,
    currentItem: null,
    currentBlock: null,
  };
}

export function projectResponsesStreamEvent(
  projector: ResponsesStreamProjector,
  event: Record<string, any>,
  stream: { push: (event: Record<string, unknown>) => void },
): void {
  const { output } = projector;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  if (event.type === "response.output_item.added") {
    const item = event.item as Record<string, any>;
    if (item.type === "reasoning") {
      projector.currentItem = item;
      projector.currentBlock = { type: "thinking", thinking: "" };
      blocks.push(projector.currentBlock);
      stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    } else if (item.type === "message") {
      projector.currentItem = item;
      projector.currentBlock = {
        type: "text",
        text: "",
        ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      };
      blocks.push(projector.currentBlock);
      stream.push({
        type: "text_start",
        contentIndex: blockIndex(),
        partial: output,
        ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      });
    } else if (item.type === "function_call") {
      projector.currentItem = item;
      projector.currentBlock = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        partialJson: item.arguments || "",
      };
      blocks.push(projector.currentBlock);
      stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
    }
    return;
  }

  if (event.type === "response.reasoning_summary_part.added") {
    if (projector.currentItem?.type === "reasoning") {
      projector.currentItem.summary = projector.currentItem.summary || [];
      projector.currentItem.summary.push(event.part);
    }
    return;
  }

  if (event.type === "response.reasoning_summary_text.delta") {
    if (projector.currentItem?.type === "reasoning" && projector.currentBlock?.type === "thinking") {
      projector.currentItem.summary = projector.currentItem.summary || [];
      const lastPart = projector.currentItem.summary[projector.currentItem.summary.length - 1];
      if (lastPart) {
        projector.currentBlock.thinking = `${projector.currentBlock.thinking ?? ""}${event.delta}`;
        lastPart.text += event.delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    }
    return;
  }

  if (event.type === "response.reasoning_summary_part.done") {
    if (projector.currentItem?.type === "reasoning" && projector.currentBlock?.type === "thinking") {
      projector.currentItem.summary = projector.currentItem.summary || [];
      const lastPart = projector.currentItem.summary[projector.currentItem.summary.length - 1];
      if (lastPart) {
        projector.currentBlock.thinking = `${projector.currentBlock.thinking ?? ""}\n\n`;
        lastPart.text += "\n\n";
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: "\n\n",
          partial: output,
        });
      }
    }
    return;
  }

  if (event.type === "response.content_part.added") {
    if (projector.currentItem?.type === "message") {
      projector.currentItem.content = projector.currentItem.content || [];
      if (event.part.type === "output_text" || event.part.type === "refusal") {
        projector.currentItem.content.push(event.part);
      }
    }
    return;
  }

  if (event.type === "response.output_text.delta") {
    if (projector.currentItem?.type === "message" && projector.currentBlock?.type === "text") {
      const lastPart = projector.currentItem.content?.[projector.currentItem.content.length - 1];
      if (lastPart?.type === "output_text") {
        projector.currentBlock.text += event.delta;
        lastPart.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
          ...(typeof projector.currentBlock.phase === "string" ? { phase: projector.currentBlock.phase } : {}),
        });
      }
    }
    return;
  }

  if (event.type === "response.refusal.delta") {
    if (projector.currentItem?.type === "message" && projector.currentBlock?.type === "text") {
      const lastPart = projector.currentItem.content?.[projector.currentItem.content.length - 1];
      if (lastPart?.type === "refusal") {
        projector.currentBlock.text += event.delta;
        lastPart.refusal += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
          ...(typeof projector.currentBlock.phase === "string" ? { phase: projector.currentBlock.phase } : {}),
        });
      }
    }
    return;
  }

  if (event.type === "response.function_call_arguments.delta") {
    if (projector.currentItem?.type === "function_call" && projector.currentBlock?.type === "toolCall") {
      projector.currentBlock.partialJson = `${projector.currentBlock.partialJson ?? ""}${event.delta}`;
      projector.currentBlock.arguments = parseStreamingJson(projector.currentBlock.partialJson);
      stream.push({
        type: "toolcall_delta",
        contentIndex: blockIndex(),
        delta: event.delta,
        partial: output,
      });
    }
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    if (projector.currentItem?.type === "function_call" && projector.currentBlock?.type === "toolCall") {
      projector.currentBlock.partialJson = typeof event.arguments === "string" ? event.arguments : "";
      projector.currentBlock.arguments = parseStreamingJson(projector.currentBlock.partialJson);
    }
    return;
  }

  if (event.type === "response.output_item.done") {
    const item = event.item as Record<string, any>;
    if (item.type === "reasoning" && projector.currentBlock?.type === "thinking") {
      projector.currentBlock.thinking = item.summary?.map((summary: { text: string }) => summary.text).join("\n\n") || "";
      projector.currentBlock.thinkingSignature = JSON.stringify(item);
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: projector.currentBlock.thinking,
        partial: output,
      });
      projector.currentBlock = null;
    } else if (item.type === "message" && projector.currentBlock?.type === "text") {
      projector.currentBlock.text = item.content
        .map((content: { type: string; text?: string; refusal?: string }) =>
          content.type === "output_text" ? content.text : content.refusal)
        .join("");
      projector.currentBlock.textSignature = item.id;
      if (typeof item.phase === "string") {
        projector.currentBlock.phase = item.phase;
      }
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: projector.currentBlock.text,
        partial: output,
        ...(typeof projector.currentBlock.phase === "string" ? { phase: projector.currentBlock.phase } : {}),
      });
      projector.currentBlock = null;
    } else if (item.type === "function_call") {
      const args = projector.currentBlock?.type === "toolCall" && projector.currentBlock.partialJson
        ? parseStreamingJson(projector.currentBlock.partialJson)
        : parseStreamingJson(item.arguments || "{}");
      const toolCall = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: args,
      };
      projector.currentBlock = null;
      stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
    }
    return;
  }

  if (event.type === "response.completed") {
    const response = event.response as Record<string, any> | undefined;
    if (response?.usage) {
      const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
      output.usage = {
        input: (response.usage.input_tokens || 0) - cachedTokens,
        output: response.usage.output_tokens || 0,
        cacheRead: cachedTokens,
        cacheWrite: 0,
        totalTokens: response.usage.total_tokens || 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      if (projector.model) {
        calculateCost(projector.model, output.usage);
      }
    }
    output.stopReason = mapStopReason(response?.status);
    if (output.content.some((block: { type: string }) => block.type === "toolCall") && output.stopReason === "stop") {
      output.stopReason = "toolUse";
    }
    return;
  }

  if (event.type === "error") {
    throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
  }

  if (event.type === "response.failed") {
    throw new Error("Unknown error");
  }
}
