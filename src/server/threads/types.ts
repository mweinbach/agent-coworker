import type { AgentConfig } from "../../types";

export type ThreadHostId = string;
export type ThreadRuntimeStatus = "running" | "loaded" | "notLoaded";

export type ProjectSummary = {
  projectId: string;
  name: string;
  path: string;
  hostId: ThreadHostId;
  active: boolean;
  defaultProvider?: string;
  defaultModel?: string;
};

export type ThreadSummary = {
  threadId: string;
  hostId: ThreadHostId;
  title: string;
  preview: string;
  projectId?: string;
  projectName?: string;
  cwd: string;
  modelProvider: AgentConfig["provider"];
  model: string;
  status: ThreadRuntimeStatus;
  pinned: boolean;
  pinnedAt?: string | null;
  archived: boolean;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastEventSeq: number;
};

export type ListThreadsInput = {
  hostId?: ThreadHostId;
  limit?: number;
  query?: string;
};

export type ListThreadsResult = {
  threads: ThreadSummary[];
  total: number;
};

export type ReadThreadInput = {
  threadId: string;
  hostId?: ThreadHostId;
  cursor?: string;
  includeOutputs?: boolean;
  maxOutputCharsPerItem?: number;
  turnLimit?: number;
};

export type CompactThreadItem =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "reasoning"; mode: "reasoning" | "summary"; text: string }
  | {
      type: "tool";
      toolName: string;
      state: string;
      args?: unknown;
      output?: string;
      outputTruncated?: boolean;
    }
  | { type: "error"; message: string }
  | { type: "system"; line: string }
  | { type: "log"; line: string }
  | { type: "todos"; todos: unknown[] };

export type CompactThreadTurn = {
  id: string;
  status: string;
  items: CompactThreadItem[];
};

export type ReadThreadResult = {
  thread: ThreadSummary;
  turns: CompactThreadTurn[];
  nextCursor?: string;
};

export type ThreadWorktreeStartingState = {
  /** Git ref to create the managed worktree from. Defaults to HEAD. */
  ref?: string;
  /** Optional branch name for the new worktree. Defaults to a generated cowork/fork/* branch. */
  branchName?: string;
};

export type ThreadEnvironment =
  | { type: "local" }
  | ({ type: "worktree" } & ThreadWorktreeStartingState & {
        startingState?: ThreadWorktreeStartingState;
      });

export type CreateThreadTarget =
  | {
      type: "project";
      projectId: string;
      environment?: ThreadEnvironment;
    }
  | {
      type: "projectless";
      directoryName?: string;
    };

export type CreateThreadInput = {
  hostId?: ThreadHostId;
  prompt: string;
  target: CreateThreadTarget;
  model?: string;
  thinking?: string;
};

export type CreateThreadResult = {
  thread: ThreadSummary;
  queued: true;
};

export type SendMessageToThreadInput = {
  threadId: string;
  hostId?: ThreadHostId;
  prompt: string;
  model?: string;
  thinking?: string;
};

export type SendMessageResult =
  | {
      threadId: string;
      hostId: ThreadHostId;
      queued: true;
    }
  | {
      threadId: string;
      hostId: ThreadHostId;
      queued: false;
      busy: true;
      activeTurnId?: string | null;
    };

export type SetThreadTitleInput = {
  threadId?: string;
  hostId?: ThreadHostId;
  title: string;
};

export type SetThreadPinnedInput = {
  threadId?: string;
  hostId?: ThreadHostId;
  pinned: boolean;
};

export type SetThreadArchivedInput = {
  threadId?: string;
  hostId?: ThreadHostId;
  archived: boolean;
};

export type UnsupportedThreadOperationResult = {
  status: "unsupported";
  reason: string;
};

export type ForkThreadEnvironment = ThreadEnvironment;

export type ForkThreadInput = {
  threadId?: string;
  hostId?: ThreadHostId;
  environment?: ForkThreadEnvironment;
  title?: string;
  prompt?: string;
  model?: string;
  thinking?: string;
};

export type ForkThreadResult = {
  sourceThreadId: string;
  thread: ThreadSummary;
  forked: true;
  queued: boolean;
  environment:
    | { type: "local"; cwd: string }
    | {
        type: "worktree";
        cwd: string;
        branchName: string;
        baseRef: string;
        baseCommit: string;
      };
};

export type HandoffThreadInput = {
  threadId: string;
  hostId?: ThreadHostId;
  destinationHostId?: ThreadHostId;
  followUpPrompt?: string;
};

export type HandoffStartResult = UnsupportedThreadOperationResult;

export type HandoffStatusInput = {
  operationId: string;
  hostId?: ThreadHostId;
  afterRevision?: number;
  waitMs?: number;
};

export type HandoffStatusResult = UnsupportedThreadOperationResult;

export interface ThreadHostAdapter {
  hostId: ThreadHostId;
  displayName: string;

  listProjects(): Promise<{ projects: ProjectSummary[] }>;
  listThreads(input: ListThreadsInput): Promise<ListThreadsResult>;
  readThread(input: ReadThreadInput): Promise<ReadThreadResult>;
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;
  sendMessage(input: SendMessageToThreadInput): Promise<SendMessageResult>;

  forkThread(input: ForkThreadInput): Promise<ForkThreadResult>;
  handoffThread(input: HandoffThreadInput): Promise<HandoffStartResult>;
  getHandoffStatus(input: HandoffStatusInput): Promise<HandoffStatusResult>;

  setTitle(input: SetThreadTitleInput): Promise<ThreadSummary>;
  setPinned(input: SetThreadPinnedInput): Promise<ThreadSummary>;
  setArchived(input: SetThreadArchivedInput): Promise<ThreadSummary>;
}

export interface ThreadControl {
  listProjects(): Promise<{ projects: ProjectSummary[] }>;
  listThreads(
    input: Omit<ListThreadsInput, "hostId"> & { hostId?: ThreadHostId },
  ): Promise<ListThreadsResult>;
  readThread(input: ReadThreadInput): Promise<ReadThreadResult>;
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;
  sendMessage(input: SendMessageToThreadInput): Promise<SendMessageResult>;
  forkThread(input: ForkThreadInput): Promise<ForkThreadResult>;
  handoffThread(input: HandoffThreadInput): Promise<HandoffStartResult>;
  getHandoffStatus(input: HandoffStatusInput): Promise<HandoffStatusResult>;
  setTitle(input: SetThreadTitleInput): Promise<ThreadSummary>;
  setPinned(input: SetThreadPinnedInput): Promise<ThreadSummary>;
  setArchived(input: SetThreadArchivedInput): Promise<ThreadSummary>;
}
