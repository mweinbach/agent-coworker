export const TRANSCRIPT_REQUEST_MAX_EVENTS = 100;
export const TRANSCRIPT_EVENTS_MAX_BYTES = 256 * 1024;
export const TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES = 16 * 1024;
export const TRANSCRIPT_REQUEST_BODY_MAX_BYTES =
  TRANSCRIPT_EVENTS_MAX_BYTES + TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES;

export function measureUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function serializeTranscriptBatchRequest(batchId: string, events: unknown[]): string {
  return JSON.stringify({ batchId, events });
}

export function measureTranscriptEventsBytes(events: unknown[]): number {
  return measureUtf8Bytes(JSON.stringify(events));
}

export function measureTranscriptRequestBytes(batchId: string, events: unknown[]): number {
  return measureUtf8Bytes(serializeTranscriptBatchRequest(batchId, events));
}

export function measureTranscriptBatchBudgetBytes(batchId: string, events: unknown[]): number {
  const eventsBytes = measureTranscriptEventsBytes(events);
  const requestBytes = measureTranscriptRequestBytes(batchId, events);
  return Math.max(requestBytes, eventsBytes + TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES);
}

export function transcriptBatchFitsRequestLimits(batchId: string, events: unknown[]): boolean {
  return (
    events.length > 0 &&
    events.length <= TRANSCRIPT_REQUEST_MAX_EVENTS &&
    measureTranscriptEventsBytes(events) <= TRANSCRIPT_EVENTS_MAX_BYTES &&
    measureTranscriptRequestBytes(batchId, events) <= TRANSCRIPT_REQUEST_BODY_MAX_BYTES
  );
}
