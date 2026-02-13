import type { ConfigSubset, ProviderName, ServerEvent, SkillEntry, TodoItem } from "../lib/wsProtocol";

export type WorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
  defaultProvider?: ProviderName;
  defaultModel?: string;
  defaultEnableMcp: boolean;
  yolo: boolean;
};

export type ThreadStatus = "active" | "disconnected" | "archived";

export type ThreadRecord = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
  status: ThreadStatus;
};

export type PersistedState = {
  version: number;
  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];
};

export type TranscriptDirection = "server" | "client";

export type TranscriptEvent = {
  ts: string;
  threadId: string;
  direction: TranscriptDirection;
  payload: unknown;
};

export type FeedItem =
  | { id: string; kind: "message"; role: "user" | "assistant"; ts: string; text: string }
  | { id: string; kind: "reasoning"; mode: "reasoning" | "summary"; ts: string; text: string }
  | { id: string; kind: "todos"; ts: string; todos: TodoItem[] }
  | { id: string; kind: "observabilityStatus"; ts: string; enabled: boolean; summary: string }
  | { id: string; kind: "harnessContext"; ts: string; context: HarnessContextPayload | null }
  | { id: string; kind: "observabilityQueryResult"; ts: string; result: ObservabilityQueryResultPayload }
  | { id: string; kind: "harnessSloResult"; ts: string; result: HarnessSloResultPayload }
  | { id: string; kind: "log"; ts: string; line: string }
  | { id: string; kind: "error"; ts: string; message: string }
  | { id: string; kind: "system"; ts: string; line: string };

export type ViewId = "chat" | "skills" | "automations" | "settings";

export type SettingsPageId = "providers" | "workspaces" | "sessions";

export type WorkspaceRuntime = {
  serverUrl: string | null;
  starting: boolean;
  error: string | null;
  controlSessionId: string | null;
  controlConfig: ConfigSubset | null;
  controlEnableMcp: boolean | null;
  skills: SkillEntry[];
  selectedSkillName: string | null;
  selectedSkillContent: string | null;
};

export type ThreadRuntime = {
  wsUrl: string | null;
  connected: boolean;
  sessionId: string | null;
  config: ConfigSubset | null;
  enableMcp: boolean | null;
  busy: boolean;
  busySince: string | null;
  feed: FeedItem[];
  backup: SessionBackupPublicState | null;
  backupReason: SessionBackupReason | null;
  backupUi: {
    refreshing: boolean;
    checkpointing: boolean;
    restoring: boolean;
    deletingById: Record<string, boolean>;
    error: string | null;
  };
  // When true, "sending" will fork into a new live thread.
  transcriptOnly: boolean;
};

export type SessionBackupStateEvent = Extract<ServerEvent, { type: "session_backup_state" }>;
export type SessionBackupPublicState = SessionBackupStateEvent["backup"];
export type SessionBackupReason = SessionBackupStateEvent["reason"];
export type SessionBackupCheckpoint = SessionBackupPublicState["checkpoints"][number];

export type ObservabilityStatusEvent = Extract<ServerEvent, { type: "observability_status" }>;
export type HarnessContextEvent = Extract<ServerEvent, { type: "harness_context" }>;
export type ObservabilityQueryResultEvent = Extract<ServerEvent, { type: "observability_query_result" }>;
export type HarnessSloResultEvent = Extract<ServerEvent, { type: "harness_slo_result" }>;

export type HarnessContextPayload = HarnessContextEvent["context"];
export type ObservabilityQueryResultPayload = ObservabilityQueryResultEvent["result"];
export type HarnessSloResultPayload = HarnessSloResultEvent["result"];

export type ConnectDraft = {
  provider: ProviderName;
  apiKey: string;
};

export type AskPrompt = {
  requestId: string;
  question: string;
  options?: string[];
};

export type ApprovalPrompt = {
  requestId: string;
  command: string;
  dangerous: boolean;
};

export type PromptModalState =
  | { kind: "ask"; threadId: string; prompt: AskPrompt }
  | { kind: "approval"; threadId: string; prompt: ApprovalPrompt }
  | null;

export type Notification = {
  id: string;
  ts: string;
  kind: "info" | "error";
  title: string;
  detail?: string;
};

export type ThreadEvent = Extract<
  ServerEvent,
  {
    type:
      | "assistant_message"
      | "reasoning"
      | "todos"
      | "log"
      | "error"
      | "user_message"
      | "session_busy"
      | "observability_status"
      | "harness_context"
      | "observability_query_result"
      | "harness_slo_result";
  }
>;
