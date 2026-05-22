import type { SessionEvent } from "../../../src/server/protocol";

export const sessionId = "session-1";
export const turnId = "turn-1";
export const PI_PROVIDER_CASES = [
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "baseten", model: "deepseek-r1-0528" },
  { provider: "together", model: "deepseek-ai/DeepSeek-R1" },
  { provider: "nvidia", model: "meta/llama-4-maverick-17b-128e-instruct" },
  { provider: "lmstudio", model: "local-model" },
  { provider: "opencode-go", model: "glm-5" },
  { provider: "opencode-zen", model: "kimi-k2.5" },
] as const;

export function streamChunk(
  partType: Extract<SessionEvent, { type: "model_stream_chunk" }>["partType"],
  part: Record<string, unknown>,
): SessionEvent {
  return {
    type: "model_stream_chunk",
    sessionId,
    turnId,
    index: 0,
    provider: "openai",
    model: "gpt-5.4-mini",
    partType,
    part,
  };
}

export function piChunk(
  provider: (typeof PI_PROVIDER_CASES)[number]["provider"],
  model: string,
  partType: Extract<SessionEvent, { type: "model_stream_chunk" }>["partType"],
  part: Record<string, unknown>,
): SessionEvent {
  return {
    type: "model_stream_chunk",
    sessionId,
    turnId,
    index: 0,
    provider,
    model,
    partType,
    part,
  };
}

export function googleRaw(index: number, event: Record<string, unknown>): SessionEvent {
  return {
    type: "model_stream_raw",
    sessionId,
    turnId,
    index,
    provider: "google",
    model: "gemini-3.1-pro-preview-customtools",
    format: "google-interactions-v1",
    normalizerVersion: 1,
    event,
  };
}
