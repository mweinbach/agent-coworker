import type {
  ApprovalRiskCode,
  ConfigSubset,
  MCPServerConfig,
  ProviderName,
  ServerErrorCode,
  ServerErrorSource,
  ServerEvent,
  SkillEntry,
  TodoItem,
} from "../lib/wsProtocol";

export type ExplorerEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
};

export type WorkspaceExplorerState = {
  rootPath: string | null;
  currentPath: string | null;
  entries: ExplorerEntry[];
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  requestId: number;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
  defaultProvider?: ProviderName;
  defaultModel?: string;
  defaultSubAgentModel?: string;
  defaultEnableMcp: boolean;
  yolo: boolean;
};

export type ThreadStatus = "active" | "disconnected";

export type ThreadTitleSource = "default" | "model" | "heuristic" | "manual";

export type ThreadRecord = {
  id: string;
  workspaceId: string;
  title: string;
  titleSource?: ThreadTitleSource;
  createdAt: string;
  lastMessageAt: string;
  status: ThreadStatus;
  sessionId: string | null;
  lastEventSeq: number;
};

export type PersistedState = {
  version: number;
  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];
  developerMode?: boolean;
  showHiddenFiles?: boolean;
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
  | { id: string; kind: "tool"; ts: string; name: string; status: "running" | "done" | "error"; args?: unknown; result?: unknown }
  | { id: string; kind: "todos"; ts: string; todos: TodoItem[] }
  | { id: string; kind: "log"; ts: string; line: string }
  | { id: string; kind: "error"; ts: string; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | { id: string; kind: "system"; ts: string; line: string };

export type ViewId = "chat" | "skills" | "settings";

export type SettingsPageId = "providers" | "workspaces" | "developer";

export type SessionConfigSubset = Extract<ServerEvent, { type: "session_config" }>["config"];

export type WorkspaceRuntime = {
  serverUrl: string | null;
  starting: boolean;
  error: string | null;
  controlSessionId: string | null;
  controlConfig: ConfigSubset | null;
  controlSessionConfig: SessionConfigSubset | null;
  controlEnableMcp: boolean | null;
  mcpConfigPath: string | null;
  mcpRawJson: string;
  mcpProjectServers: MCPServerConfig[];
  mcpEffectiveServers: MCPServerConfig[];
  mcpParseError: string | null;
  mcpSaving: boolean;
  skills: SkillEntry[];
  selectedSkillName: string | null;
  selectedSkillContent: string | null;
};

export type ThreadRuntime = {
  wsUrl: string | null;
  connected: boolean;
  sessionId: string | null;
  config: ConfigSubset | null;
  sessionConfig: SessionConfigSubset | null;
  enableMcp: boolean | null;
  busy: boolean;
  busySince: string | null;
  feed: FeedItem[];
  transcriptOnly: boolean;
};

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
  reasonCode: ApprovalRiskCode;
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
