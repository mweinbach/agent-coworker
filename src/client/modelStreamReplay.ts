import {
  createResponsesStreamProjector,
  projectResponsesStreamEvent,
  type ResponsesStreamProjector,
} from "../runtime/openaiResponsesProjector";
import { mapPiEventToRawParts } from "../runtime/piStreamParts";
import { normalizeModelStreamPart } from "../server/modelStream";
import type { ServerEvent } from "../server/protocol";

import {
  mapModelStreamChunk,
  mapModelStreamRawEvent,
  type ModelStreamChunkEvent,
  type ModelStreamUpdate,
} from "./modelStream";

export type ModelStreamRawEvent = Extract<ServerEvent, { type: "model_stream_raw" }>;

export type ModelStreamReplayRuntime = {
  rawBackedTurns: Set<string>;
  projectorByTurn: Map<string, ResponsesStreamProjector>;
};

export function createModelStreamReplayRuntime(): ModelStreamReplayRuntime {
  return {
    rawBackedTurns: new Set(),
    projectorByTurn: new Map(),
  };
}

export function clearModelStreamReplayRuntime(runtime: ModelStreamReplayRuntime): void {
  runtime.rawBackedTurns.clear();
  runtime.projectorByTurn.clear();
}

function getOrCreateProjector(
  runtime: ModelStreamReplayRuntime,
  evt: ModelStreamRawEvent,
): ResponsesStreamProjector {
  const existing = runtime.projectorByTurn.get(evt.turnId);
  if (existing) return existing;

  const projector = createResponsesStreamProjector({
    role: "assistant",
    api: evt.format === "openai-responses-v1" ? "openai-responses" : evt.format,
    provider: evt.provider,
    model: evt.model,
    content: [],
    timestamp: Date.now(),
  });
  runtime.projectorByTurn.set(evt.turnId, projector);
  return projector;
}

export function replayModelStreamRawEvent(
  runtime: ModelStreamReplayRuntime,
  evt: ModelStreamRawEvent,
): ModelStreamUpdate[] {
  const directUpdates = mapModelStreamRawEvent(evt);
  const projector = getOrCreateProjector(runtime, evt);
  const piEvents: Array<Record<string, unknown>> = [];

  try {
    projectResponsesStreamEvent(projector, evt.event, {
      push: (event) => {
        piEvents.push(event);
      },
    });
  } catch {
    return [];
  }

  const updates: ModelStreamUpdate[] = [...directUpdates];
  let derivedIndex = 0;
  for (const piEvent of piEvents) {
    for (const rawPart of mapPiEventToRawParts(piEvent, evt.provider, true)) {
      const normalized = normalizeModelStreamPart(rawPart, {
        provider: evt.provider,
        fallbackIdSeed: `${evt.turnId}:${evt.index}:${derivedIndex}`,
      });
      const mapped = mapModelStreamChunk({
        type: "model_stream_chunk",
        sessionId: evt.sessionId,
        turnId: evt.turnId,
        index: evt.index * 1000 + derivedIndex,
        provider: evt.provider,
        model: evt.model,
        normalizerVersion: normalized.normalizerVersion,
        partType: normalized.partType,
        part: normalized.part,
        ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
      } satisfies ModelStreamChunkEvent);
      if (mapped) updates.push(mapped);
      derivedIndex += 1;
    }
  }

  if (updates.some((update) => update.kind !== "tool_input_start" && update.kind !== "tool_result")) {
    runtime.rawBackedTurns.add(evt.turnId);
  }

  return updates;
}

const RAW_REPLAY_PART_TYPES = new Set<ModelStreamChunkEvent["partType"]>([
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);

export function shouldIgnoreNormalizedChunkForRawBackedTurn(
  runtime: ModelStreamReplayRuntime,
  evt: ModelStreamChunkEvent,
): boolean {
  return runtime.rawBackedTurns.has(evt.turnId) && RAW_REPLAY_PART_TYPES.has(evt.partType);
}
