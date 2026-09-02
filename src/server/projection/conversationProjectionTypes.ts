import type { ModelStreamReplayRuntime } from "../../shared/modelStreamReplay";
import type { ProjectedItem, ProjectedToolState } from "../../shared/projectedItems";
import type { ToolInputDigest } from "../../shared/toolInputDigest";
import type { ProjectedReasoningMode } from "./shared";

export type BufferedReasoningState = {
  itemId: string;
  mode: ProjectedReasoningMode;
  text: string;
  textChunks?: string[];
  started: boolean;
};

export type BufferedAssistantState = {
  itemId: string;
  text: string;
  textChunks?: string[];
  started: boolean;
};

export type BufferedToolState = {
  itemId: string;
  name: string;
  args?: unknown;
  inputText: string;
  started: boolean;
  state: ProjectedToolState;
  result?: unknown;
  retryOf?: string;
  inputDigest?: ToolInputDigest;
  approval?: {
    approvalId: string;
    reason?: unknown;
    toolCall?: unknown;
  };
};

export type ConversationProjectionSeed = {
  activeTurnId: string | null;
  lastUserMessageText: string | null;
  lastUserMessageClientMessageId: string | null;
  lastUserMessageSteerRequestId: string | null;
  lastUserMessageAnnotations: Array<Record<string, unknown>> | null;
  activeAssistantByTurn: Map<string, BufferedAssistantState>;
  assistantOccurrenceByTurn: Map<string, number>;
  assistantHistoryByTurn: Map<string, string>;
  reasoningByKey: Map<string, BufferedReasoningState>;
  reasoningOccurrenceByKey: Map<string, number>;
  reasoningTextsSeenInTurn: Set<string>;
  reasoningTextHistoryInTurn: string[];
  toolByKey: Map<string, BufferedToolState>;
  toolOccurrenceByKey: Map<string, number>;
  toolInputByKey: Map<string, string>;
  replayRuntime: ModelStreamReplayRuntime;
};

export type ProjectionServerRequest =
  | {
      id: string;
      type: "ask";
      method: "item/tool/requestUserInput";
      params: {
        turnId: string | null;
        requestId: string;
        itemId: string;
        question: string;
        options?: string[];
      };
    }
  | {
      id: string;
      type: "approval";
      method: "item/commandExecution/requestApproval";
      params: {
        turnId: string | null;
        requestId: string;
        itemId: string;
        command: string;
        dangerous: boolean;
        reason: string;
        detail?: string;
        category?: "filesystem" | "network";
      };
    };

type ConversationProjectionSink = {
  emitTurnStarted: (turnId: string) => void;
  emitTurnCompleted: (turnId: string, status: "completed" | "interrupted" | "failed") => void;
  emitItemStarted: (turnId: string | null, item: ProjectedItem) => void;
  emitReasoningDelta: (
    turnId: string,
    itemId: string,
    mode: ProjectedReasoningMode,
    delta: string,
  ) => void;
  emitAgentMessageDelta: (turnId: string, itemId: string, delta: string) => void;
  emitItemCompleted: (turnId: string | null, item: ProjectedItem) => void;
  emitServerRequest?: (request: ProjectionServerRequest) => void;
};

export type CreateConversationProjectionOptions = {
  initialSeed?: ConversationProjectionSeed;
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  sink: ConversationProjectionSink;
};
