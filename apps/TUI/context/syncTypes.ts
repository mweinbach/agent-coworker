import type { ServerEvent } from "../../../src/server/protocol";
import type {
  CodexCliProviderOptions,
  CodexWebSearchBackend,
  CodexWebSearchContextSize,
  CodexWebSearchLocation,
  CodexWebSearchMode,
  OpenAiCompatibleProviderName,
  OpenAiCompatibleProviderOptionsByProvider,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
  OpenAiTextVerbosity,
} from "../../../src/shared/openaiCompatibleOptions";
import type {
  ApprovalRiskCode,
  CommandInfo,
  HarnessContextPayload,
  ServerErrorCode,
  ServerErrorSource,
  TodoItem,
} from "../../../src/types";

export type FeedItem =
  | {
      id: string;
      type: "message";
      role: "user" | "assistant";
      text: string;
      annotations?: Array<Record<string, unknown>>;
    }
  | { id: string; type: "reasoning"; kind: "reasoning" | "summary"; text: string }
  | {
      id: string;
      type: "tool";
      name: string;
      sub?: string;
      status: "running" | "done";
      args?: any;
      result?: any;
    }
  | { id: string; type: "todos"; todos: TodoItem[] }
  | { id: string; type: "system"; line: string }
  | { id: string; type: "log"; line: string }
  | { id: string; type: "error"; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | {
      id: string;
      type: "skill_content";
      skill: Extract<ServerEvent, { type: "skill_content" }>["skill"];
      content: string;
    }
  | {
      id: string;
      type: "session_backup_state";
      reason: Extract<ServerEvent, { type: "session_backup_state" }>["reason"];
      backup: Extract<ServerEvent, { type: "session_backup_state" }>["backup"];
    };

export type AskRequest = {
  requestId: string;
  question: string;
  options?: string[];
};

export type ApprovalRequest = {
  requestId: string;
  command: string;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
};

export type ProviderCatalogState = Extract<ServerEvent, { type: "provider_catalog" }>["all"];
export type ProviderAuthMethodsState = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"];
export type ProviderStatusesState = Extract<ServerEvent, { type: "provider_status" }>["providers"];
export type ProviderAuthChallengeState = Extract<ServerEvent, { type: "provider_auth_challenge" }> | null;
export type ProviderAuthResultState = Extract<ServerEvent, { type: "provider_auth_result" }> | null;
export type HarnessContextState = Extract<ServerEvent, { type: "harness_context" }>["context"];
export type SkillsState = Extract<ServerEvent, { type: "skills_list" }>["skills"];
export type SessionBackupState = Extract<ServerEvent, { type: "session_backup_state" }>["backup"] | null;
export type ToolDescriptor = Extract<ServerEvent, { type: "tools" }>["tools"][number];
export type AgentSummaryState = Extract<ServerEvent, { type: "agent_status" }>["agent"];
export type SessionKindState = Extract<ServerEvent, { type: "server_hello" }>["sessionKind"];
export type AgentRoleState = Extract<ServerEvent, { type: "server_hello" }>["role"];
export type AgentModeState = Extract<ServerEvent, { type: "server_hello" }>["mode"];
export type AgentReasoningEffortState = Extract<ServerEvent, { type: "server_hello" }>["effectiveReasoningEffort"];
export type AgentExecutionState = Extract<ServerEvent, { type: "server_hello" }>["executionState"];
export type ContextUsageSnapshot = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type OpenAICompatibleProviderName = OpenAiCompatibleProviderName;
export type OpenAICompatibleReasoningEffort = OpenAiReasoningEffort;
export type OpenAICompatibleReasoningSummary = OpenAiReasoningSummary;
export type OpenAICompatibleTextVerbosity = OpenAiTextVerbosity;
export type CodexWebSearchBackendValue = CodexWebSearchBackend;
export type CodexWebSearchModeValue = CodexWebSearchMode;
export type CodexWebSearchContextSizeValue = CodexWebSearchContextSize;
export type CodexWebSearchLocationValue = CodexWebSearchLocation;
export type CodexProviderOptionsValue = CodexCliProviderOptions;
export type SyncConfigPatch = {
  yolo?: boolean;
  observabilityEnabled?: boolean;
  backupsEnabled?: boolean;
  preferredChildModel?: string;
  maxSteps?: number;
  toolOutputOverflowChars?: number | null;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  userName?: string;
  userProfile?: {
    instructions?: string;
    work?: string;
    details?: string;
  };
};

export type SyncState = {
  status: "connecting" | "connected" | "disconnected";
  sessionId: string | null;
  sessionTitle: string | null;
  sessionKind: SessionKindState | null;
  parentSessionId: string | null;
  role: AgentRoleState | null;
  mode: AgentModeState | null;
  depth: number;
  nickname: string | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  requestedReasoningEffort: AgentReasoningEffortState | null;
  effectiveReasoningEffort: AgentReasoningEffortState | null;
  executionState: AgentExecutionState | null;
  lastMessagePreview: string | null;
  provider: string;
  model: string;
  cwd: string;
  enableMcp: boolean;
  tools: ToolDescriptor[];
  commands: CommandInfo[];
  providerCatalog: ProviderCatalogState;
  providerDefault: Record<string, string>;
  providerConnected: string[];
  providerAuthMethods: ProviderAuthMethodsState;
  providerStatuses: ProviderStatusesState;
  providerAuthChallenge: ProviderAuthChallengeState;
  providerAuthResult: ProviderAuthResultState;
  observabilityEnabled: boolean;
  backupsEnabled: boolean;
  observabilityConfig: Extract<ServerEvent, { type: "observability_status" }>["config"];
  observabilityHealth: Extract<ServerEvent, { type: "observability_status" }>["health"] | null;
  harnessContext: HarnessContextState;
  skills: SkillsState;
  backup: SessionBackupState;
  contextUsage: ContextUsageSnapshot | null;
  sessionSummaries: Extract<ServerEvent, { type: "sessions" }>["sessions"];
  agents: AgentSummaryState[];
  userName: string;
  userProfile: {
    instructions: string;
    work: string;
    details: string;
  };
  busy: boolean;
  feed: FeedItem[];
  todos: TodoItem[];
  pendingAsk: AskRequest | null;
  pendingApproval: ApprovalRequest | null;
};

export type SyncActions = {
  sendMessage: (text: string) => boolean;
  answerAsk: (requestId: string, answer: string) => void;
  respondApproval: (requestId: string, approved: boolean) => void;
  setModel: (provider: string, model: string) => void;
  setConfig: (config: SyncConfigPatch) => boolean;
  requestProviderCatalog: () => void;
  requestProviderAuthMethods: () => void;
  refreshProviderStatus: () => void;
  authorizeProviderAuth: (provider: string, methodId: string) => void;
  callbackProviderAuth: (provider: string, methodId: string, code?: string) => void;
  setProviderApiKey: (provider: string, methodId: string, apiKey: string) => void;
  setEnableMcp: (enabled: boolean) => void;
  refreshTools: () => void;
  refreshCommands: () => void;
  requestHarnessContext: () => void;
  setHarnessContext: (context: HarnessContextPayload) => void;
  executeCommand: (name: string, args?: string, displayText?: string) => boolean;
  requestSessions: () => void;
  requestAgentList: () => void;
  waitForAgents: (agentIds: string[], timeoutMs?: number) => boolean;
  resumeAgent: (agentId: string) => boolean;
  closeAgent: (agentId: string) => boolean;
  resumeSession: (sessionId: string) => void;
  reset: () => void;
  cancel: () => void;
  clearUsageHardCap: () => boolean;
};

export type SyncContextValue = {
  state: SyncState;
  actions: SyncActions;
};

export type ServerHelloEvent = Extract<ServerEvent, { type: "server_hello" }>;
