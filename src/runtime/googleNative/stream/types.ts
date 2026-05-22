import type { NativeGoogleToolName } from "../types";

export type AssistantContentBlock =
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "text"; text: string; annotations?: Array<Record<string, unknown>> }
  | {
      type: "image" | "audio" | "video" | "document";
      data?: string;
      uri?: string;
      mime_type?: string;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "providerToolCall";
      id: string;
      name: NativeGoogleToolName;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "providerToolResult";
      callId: string;
      name: NativeGoogleToolName;
      result: unknown;
      isError?: boolean;
      thoughtSignature?: string;
    };

export type ProviderToolCallState = {
  emittedId: string;
  name: NativeGoogleToolName;
  arguments: Record<string, unknown>;
};
