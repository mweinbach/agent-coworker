import type { ProjectedReasoningMode } from "./projectorShared";

export type ProjectedUserMessageItem = {
  id: string;
  type: "userMessage";
  content: Array<{ type: "text"; text: string }>;
  clientMessageId?: string;
};

export type ProjectedAgentMessageItem = {
  id: string;
  type: "agentMessage";
  text: string;
};

export type ProjectedReasoningItem = {
  id: string;
  type: "reasoning";
  mode: ProjectedReasoningMode;
  text: string;
};

export type ProjectedToolCallItem = {
  id: string;
  type: "toolCall";
  toolName: string;
  state: "input-streaming" | "output-available" | "output-error" | "output-denied";
  args?: unknown;
  result?: unknown;
};

export type ProjectedItem =
  | ProjectedUserMessageItem
  | ProjectedAgentMessageItem
  | ProjectedReasoningItem
  | ProjectedToolCallItem;

export type ProjectedTurnStarted = {
  id: string;
  status: "inProgress";
  items: ProjectedItem[];
};

export type ProjectedTurnCompleted = {
  id: string;
  status: "completed" | "interrupted" | "failed";
};

export type ProjectedEvent =
  | { type: "turn/started"; turnId: string; turn: ProjectedTurnStarted }
  | { type: "turn/completed"; turnId: string; turn: ProjectedTurnCompleted }
  | { type: "item/started"; turnId: string; item: ProjectedItem }
  | { type: "item/completed"; turnId: string; item: ProjectedItem }
  | { type: "item/agentMessage/delta"; turnId: string; itemId: string; delta: string }
  | {
      type: "item/reasoning/delta";
      turnId: string;
      itemId: string;
      mode: ProjectedReasoningMode;
      delta: string;
    }
  | {
      type: "ask";
      turnId: string | null;
      requestId: string;
      itemId: string;
      question: string;
      options?: string[];
    }
  | {
      type: "approval";
      turnId: string | null;
      requestId: string;
      itemId: string;
      command: string;
      dangerous: boolean;
      reason: string;
    };

export type ProjectionSink = {
  emit: (event: ProjectedEvent) => void;
};
