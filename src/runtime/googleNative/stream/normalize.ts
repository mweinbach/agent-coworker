import { asNonEmptyString, asRecord } from "../messageToInput";

export type GoogleStreamEventKind =
  | "interaction_start"
  | "interaction_complete"
  | "interaction_status"
  | "content"
  | "error"
  | "unknown";

export function normalizeGoogleStreamEvent(event: Record<string, unknown>): {
  kind: GoogleStreamEventKind;
  eventType: string;
  index?: number;
  content?: Record<string, unknown> | null;
  delta?: Record<string, unknown> | null;
} {
  const eventType = asNonEmptyString(event.event_type) ?? "unknown";
  if (eventType === "interaction.start" || eventType === "interaction.created") {
    return { kind: "interaction_start", eventType };
  }
  if (eventType === "interaction.complete" || eventType === "interaction.completed") {
    return { kind: "interaction_complete", eventType };
  }
  if (eventType === "interaction.status_update") {
    return { kind: "interaction_status", eventType };
  }
  if (eventType === "error") {
    return { kind: "error", eventType };
  }
  if (
    eventType === "content.start" ||
    eventType === "content.delta" ||
    eventType === "content.stop" ||
    eventType === "step.start" ||
    eventType === "step.delta" ||
    eventType === "step.stop"
  ) {
    return {
      kind: "content",
      eventType,
      index: typeof event.index === "number" ? event.index : undefined,
      content: asRecord(event.content ?? event.step),
      delta: asRecord(event.delta),
    };
  }
  return { kind: "unknown", eventType };
}
