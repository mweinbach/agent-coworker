import type {
  ApprovalRiskCode,
  ConfigSubset,
  ProviderName,
  ServerErrorCode,
  ServerErrorSource,
  ServerEvent,
  SkillEntry,
  TodoItem,
} from "../lib/wsProtocol";
import type { WorkspaceProviderOptions } from "./openaiCompatibleProviderOptions";

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
  providerOptions?: WorkspaceProviderOptions;
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

export type PersistedProviderStatus = Extract<ServerEvent, { type: "provider_status" }>["providers"][number];

export type PersistedProviderState = {
  statusByName?: Partial<Record<ProviderName, PersistedProviderStatus>>;
  statusLastUpdatedAt?: string | null;
};

export type PersistedState = {
  version: number;
  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];
  developerMode?: boolean;
  showHiddenFiles?: boolean;
  providerState?: PersistedProviderState;
};

export type TranscriptDirection = "server" | "client";

export type TranscriptEvent = {
  ts: string;
  threadId: string;
  direction: TranscriptDirection;
  payload: unknown;
};

export type ToolFeedState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "output-available"
  | "output-error"
  | "output-denied";

export type ToolApprovalMetadata = {
  approvalId: string;
  reason?: unknown;
  toolCall?: unknown;
};

export type FeedItem =
  | { id: string; kind: "message"; role: "user" | "assistant"; ts: string; text: string }
  | { id: string; kind: "reasoning"; mode: "reasoning" | "summary"; ts: string; text: string }
  | { id: string; kind: "tool"; ts: string; name: string; state: ToolFeedState; args?: unknown; result?: unknown; approval?: ToolApprovalMetadata }
  | { id: string; kind: "todos"; ts: string; todos: TodoItem[] }
  | { id: string; kind: "log"; ts: string; line: string }
  | { id: string; kind: "error"; ts: string; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | { id: string; kind: "system"; ts: string; line: string };

export type ViewId = "chat" | "skills" | "settings";

export type SettingsPageId = "providers" | "usage" | "workspaces" | "mcp" | "updates" | "developer";

export type SessionConfigSubset = Extract<ServerEvent, { type: "session_config" }>["config"];
export type MCPServersEvent = Extract<ServerEvent, { type: "mcp_servers" }>;
export type MCPServerValidationEvent = Extract<ServerEvent, { type: "mcp_server_validation" }>;
export type MCPServerAuthChallengeEvent = Extract<ServerEvent, { type: "mcp_server_auth_challenge" }>;
export type MCPServerAuthResultEvent = Extract<ServerEvent, { type: "mcp_server_auth_result" }>;
export type SessionUsageSnapshot = NonNullable<Extract<ServerEvent, { type: "session_usage" }>["usage"]>;
export type TurnUsageSnapshot = Pick<Extract<ServerEvent, { type: "turn_usage" }>, "turnId" | "usage">;

export type WorkspaceRuntime = {
  serverUrl: string | null;
  starting: boolean;
  error: string | null;
  controlSessionId: string | null;
  controlConfig: ConfigSubset | null;
  controlSessionConfig: SessionConfigSubset | null;
  controlEnableMcp: boolean | null;
  mcpServers: MCPServersEvent["servers"];
  mcpLegacy: MCPServersEvent["legacy"] | null;
  mcpFiles: MCPServersEvent["files"];
  mcpWarnings: string[];
  mcpValidationByName: Record<string, MCPServerValidationEvent>;
  mcpLastAuthChallenge: MCPServerAuthChallengeEvent | null;
  mcpLastAuthResult: MCPServerAuthResultEvent | null;
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
  sessionUsage: SessionUsageSnapshot | null;
  lastTurnUsage: TurnUsageSnapshot | null;
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
