import {
  createResponsesStreamProjector,
  projectResponsesStreamEvent,
  type ResponsesStreamProjector,
} from "../runtime/openaiResponsesProjector";
import { mapPiEventToRawParts } from "../runtime/piStreamParts";
import { normalizeModelStreamPart } from "../server/modelStream";
import type { SessionEvent } from "../server/protocol";
import {
  type GoogleInteractionsContentBlock,
  type GoogleInteractionsProviderToolCallState,
  mapGoogleInteractionsEventToStreamParts,
  processGoogleInteractionsStreamEvent,
} from "./googleInteractionsStreamParts";

import {
  type ModelStreamChunkEvent,
  type ModelStreamUpdate,
  mapModelStreamChunk,
  mapModelStreamRawEvent,
} from "./modelStream";

export type ModelStreamRawEvent = Extract<SessionEvent, { type: "model_stream_raw" }>;

export type ModelStreamReplayRuntime = {
  rawBackedTurns: Set<string>;
  projectorByTurn: Map<string, ResponsesStreamProjector>;
  googleStateByTurn: Map<
    string,
    {
      contentBlocks: Map<number, GoogleInteractionsContentBlock>;
      providerToolCallsById: Map<string, GoogleInteractionsProviderToolCallState>;
    }
  >;
};

export function createModelStreamReplayRuntime(): ModelStreamReplayRuntime {
  return {
    rawBackedTurns: new Set(),
    projectorByTurn: new Map(),
    googleStateByTurn: new Map(),
  };
}

export function clearModelStreamReplayRuntime(runtime: ModelStreamReplayRuntime): void {
  runtime.rawBackedTurns.clear();
  runtime.projectorByTurn.clear();
  runtime.googleStateByTurn.clear();
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

function getOrCreateGoogleState(
  runtime: ModelStreamReplayRuntime,
  turnId: string,
): {
  contentBlocks: Map<number, GoogleInteractionsContentBlock>;
  providerToolCallsById: Map<string, GoogleInteractionsProviderToolCallState>;
} {
  const existing = runtime.googleStateByTurn.get(turnId);
  if (existing) return existing;

  const state = {
    contentBlocks: new Map<number, GoogleInteractionsContentBlock>(),
    providerToolCallsById: new Map<string, GoogleInteractionsProviderToolCallState>(),
  };
  runtime.googleStateByTurn.set(turnId, state);
  return state;
}

function mapRawPartsToUpdates(
  evt: ModelStreamRawEvent,
  rawParts: Array<unknown>,
): ModelStreamUpdate[] {
  const updates: ModelStreamUpdate[] = [];
  let derivedIndex = 0;

  for (const rawPart of rawParts) {
    if (typeof rawPart !== "object" || rawPart === null || Array.isArray(rawPart)) {
      derivedIndex += 1;
      continue;
    }
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

  return updates;
}

export function replayModelStreamRawEvent(
  runtime: ModelStreamReplayRuntime,
  evt: ModelStreamRawEvent,
): ModelStreamUpdate[] {
  if (evt.format === "google-interactions-v1") {
    const rawEvent = evt.event as Record<string, unknown>;
    const eventType = typeof rawEvent.event_type === "string" ? rawEvent.event_type : null;
    const directUpdates: ModelStreamUpdate[] =
      eventType === "interaction.start"
        ? [{ kind: "turn_start", turnId: evt.turnId }]
        : mapModelStreamRawEvent(evt);

    try {
      const state = getOrCreateGoogleState(runtime, evt.turnId);
      processGoogleInteractionsStreamEvent(
        rawEvent,
        state.contentBlocks,
        state.providerToolCallsById,
      );
      const updates = [
        ...directUpdates,
        ...mapRawPartsToUpdates(
          evt,
          mapGoogleInteractionsEventToStreamParts(
            rawEvent,
            state.contentBlocks,
            state.providerToolCallsById,
          ),
        ),
      ];

      if (
        updates.some(
          (update) => update.kind !== "tool_input_start" && update.kind !== "tool_result",
        )
      ) {
        runtime.rawBackedTurns.add(evt.turnId);
      }

      return updates;
    } catch {
      return directUpdates;
    }
  }

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
  for (const piEvent of piEvents) {
    updates.push(...mapRawPartsToUpdates(evt, mapPiEventToRawParts(piEvent, evt.provider, true)));
  }

  if (
    updates.some((update) => update.kind !== "tool_input_start" && update.kind !== "tool_result")
  ) {
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
