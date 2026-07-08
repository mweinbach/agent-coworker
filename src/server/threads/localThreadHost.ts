import {
  buildThreadReasoningOptionsPatch,
  parseThreadModelSelection,
} from "../../models/threadReasoningOptions";
import type { AgentConfig } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import { createOneOffChatWorkspace, isPathInsideOneOffChatsRoot } from "../../utils/oneOffChats";
import { sameWorkspacePath } from "../../utils/workspacePath";
import type { ManagedWorktree, WorktreeService } from "../git/WorktreeService";
import { projectThreadTurnsFromJournal } from "../jsonrpc/threadReadProjector";
import { type JsonRpcWorkspaceSummary, listWorkspaceSummaries } from "../jsonrpc/workspaceCatalog";
import type { SessionRegistry } from "../runtime/SessionRegistry";
import type { ThreadJournal } from "../runtime/ThreadJournal";
import type { SeededSessionContext } from "../session/SessionContext";
import type { SessionRuntime } from "../session/SessionRuntime";
import { getSessionTaskLock } from "../session/taskLocks";
import type {
  PersistedSessionRecord,
  PersistedThreadJournalEvent,
  PersistedThreadMetadata,
  SessionDb,
} from "../sessionDb";
import type { TaskCoordinator } from "../tasks/TaskCoordinator";
import type { DesktopPersistedState, WebDesktopServiceLike } from "../webDesktopService";
import type {
  CompactThreadItem,
  CompactThreadTurn,
  CreateThreadInput,
  CreateThreadResult,
  ForkThreadInput,
  ForkThreadResult,
  HandoffStartResult,
  HandoffStatusInput,
  HandoffStatusResult,
  HandoffThreadInput,
  ListThreadsInput,
  ListThreadsResult,
  ProjectSummary,
  ReadThreadInput,
  ReadThreadResult,
  SendMessageResult,
  SendMessageToThreadInput,
  SetThreadArchivedInput,
  SetThreadPinnedInput,
  SetThreadTitleInput,
  ThreadEnvironment,
  ThreadHostAdapter,
  ThreadSummary,
} from "./types";

const LOCAL_HOST_ID = "local";
const THREAD_READ_JOURNAL_BATCH_SIZE = 250;
const DEFAULT_TURN_LIMIT = 10;
const MAX_TURN_LIMIT = 50;
const DEFAULT_OUTPUT_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 20_000;
const TEXT_ITEM_CHARS = 20_000;

type WorkspaceIndex = {
  workspaces: JsonRpcWorkspaceSummary[];
  activeWorkspaceId: string | null;
};

type MetadataIndexEntry = {
  pinned: boolean;
  pinnedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
};

type DesktopThreadPatch = {
  title?: string;
  pinned?: boolean;
  pinnedAt?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
};

type ThreadSessionBootstrap = {
  config: AgentConfig;
  system: string;
};

type LocalThreadHostDeps = {
  sessionDb: SessionDb;
  registry: SessionRegistry;
  threadJournal: ThreadJournal;
  taskCoordinator: Pick<TaskCoordinator, "isTaskThread">;
  desktopService?: WebDesktopServiceLike | null;
  worktreeService?: WorktreeService | null;
  getConfig: () => AgentConfig;
  loadThreadSessionBootstrap?: (cwd: string) => Promise<ThreadSessionBootstrap>;
  homedir?: string;
  onThreadListChanged?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asTimestamp(value: unknown): string | null {
  const text = asString(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function hashValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function encodeCursor(value: { beforeTurnIndex: number }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined, totalTurns: number): { beforeTurnIndex: number } {
  if (!raw) return { beforeTurnIndex: totalTurns };
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.beforeTurnIndex !== "number") {
      throw new Error("invalid cursor");
    }
    return {
      beforeTurnIndex: Math.max(0, Math.min(totalTurns, Math.floor(parsed.beforeTurnIndex))),
    };
  } catch {
    throw new Error("Invalid thread cursor");
  }
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}…`, truncated: true };
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function projectedUserMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function projectedItemToCompact(
  item: Record<string, unknown>,
  opts: { includeOutputs: boolean; maxOutputChars: number },
): CompactThreadItem | null {
  switch (item.type) {
    case "userMessage":
      return {
        type: "user",
        text: truncateText(projectedUserMessageText(item), TEXT_ITEM_CHARS).text,
      };
    case "agentMessage":
      return {
        type: "assistant",
        text: truncateText(typeof item.text === "string" ? item.text : "", TEXT_ITEM_CHARS).text,
      };
    case "reasoning":
      return {
        type: "reasoning",
        mode: item.mode === "summary" ? "summary" : "reasoning",
        text: truncateText(typeof item.text === "string" ? item.text : "", TEXT_ITEM_CHARS).text,
      };
    case "toolCall": {
      const compact: Extract<CompactThreadItem, { type: "tool" }> = {
        type: "tool",
        toolName: typeof item.toolName === "string" ? item.toolName : "tool",
        state: typeof item.state === "string" ? item.state : "unknown",
        ...(item.args !== undefined ? { args: item.args } : {}),
      };
      if (opts.includeOutputs && item.result !== undefined) {
        const truncated = truncateText(stringifyToolOutput(item.result), opts.maxOutputChars);
        compact.output = truncated.text;
        if (truncated.truncated) compact.outputTruncated = true;
      }
      return compact;
    }
    case "error":
      return {
        type: "error",
        message: truncateText(typeof item.message === "string" ? item.message : "", TEXT_ITEM_CHARS)
          .text,
      };
    case "system":
      return {
        type: "system",
        line: truncateText(typeof item.line === "string" ? item.line : "", TEXT_ITEM_CHARS).text,
      };
    case "log":
      return {
        type: "log",
        line: truncateText(typeof item.line === "string" ? item.line : "", TEXT_ITEM_CHARS).text,
      };
    case "todos":
      return { type: "todos", todos: Array.isArray(item.todos) ? item.todos : [] };
    default:
      return null;
  }
}

function snapshotFeedItemToCompact(
  item: Record<string, unknown>,
  opts: { includeOutputs: boolean; maxOutputChars: number },
): CompactThreadItem | null {
  switch (item.kind) {
    case "message":
      if (item.role === "user") {
        return {
          type: "user",
          text: truncateText(asString(item.text) ?? "", TEXT_ITEM_CHARS).text,
        };
      }
      if (item.role === "assistant") {
        return {
          type: "assistant",
          text: truncateText(asString(item.text) ?? "", TEXT_ITEM_CHARS).text,
        };
      }
      return null;
    case "reasoning":
      return {
        type: "reasoning",
        mode: item.mode === "summary" ? "summary" : "reasoning",
        text: truncateText(asString(item.text) ?? "", TEXT_ITEM_CHARS).text,
      };
    case "tool": {
      const compact: Extract<CompactThreadItem, { type: "tool" }> = {
        type: "tool",
        toolName: asString(item.name) ?? "tool",
        state: asString(item.state) ?? "unknown",
        ...(item.args !== undefined ? { args: item.args } : {}),
      };
      if (opts.includeOutputs && item.result !== undefined) {
        const truncated = truncateText(stringifyToolOutput(item.result), opts.maxOutputChars);
        compact.output = truncated.text;
        if (truncated.truncated) compact.outputTruncated = true;
      }
      return compact;
    }
    case "error":
      return {
        type: "error",
        message: truncateText(asString(item.message) ?? "", TEXT_ITEM_CHARS).text,
      };
    case "system":
      return {
        type: "system",
        line: truncateText(asString(item.line) ?? "", TEXT_ITEM_CHARS).text,
      };
    case "log":
      return { type: "log", line: truncateText(asString(item.line) ?? "", TEXT_ITEM_CHARS).text };
    case "todos":
      return { type: "todos", todos: Array.isArray(item.todos) ? item.todos : [] };
    default:
      return null;
  }
}

function compactProjectedTurns(
  turns: Array<{ id: string; status: string; items: Array<Record<string, unknown>> }>,
  opts: { includeOutputs: boolean; maxOutputChars: number },
): CompactThreadTurn[] {
  return turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items.flatMap((item) => {
      const compact = projectedItemToCompact(item, opts);
      return compact ? [compact] : [];
    }),
  }));
}

function compactSnapshotFeed(
  feed: unknown,
  opts: { includeOutputs: boolean; maxOutputChars: number },
): CompactThreadTurn[] {
  if (!Array.isArray(feed) || feed.length === 0) return [];
  const items = feed.flatMap((item) => {
    if (!isRecord(item)) return [];
    const compact = snapshotFeedItemToCompact(item, opts);
    return compact ? [compact] : [];
  });
  return items.length > 0 ? [{ id: "snapshot", status: "completed", items }] : [];
}

function compactItemsMatch(left: CompactThreadItem, right: CompactThreadItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeSnapshotAndProjectedTurns(
  snapshotTurns: CompactThreadTurn[],
  projectedTurns: CompactThreadTurn[],
): CompactThreadTurn[] {
  if (snapshotTurns.length === 0) return projectedTurns;
  if (projectedTurns.length === 0) return snapshotTurns;

  const snapshotItems = snapshotTurns.flatMap((turn) => turn.items);
  const projectedItems = projectedTurns.flatMap((turn) => turn.items);
  let overlap = 0;
  for (let size = Math.min(snapshotItems.length, projectedItems.length); size > 0; size -= 1) {
    const snapshotTail = snapshotItems.slice(-size);
    const projectedTail = projectedItems.slice(-size);
    if (
      snapshotTail.every((item, index) => {
        const projectedItem = projectedTail[index];
        return projectedItem !== undefined && compactItemsMatch(item, projectedItem);
      })
    ) {
      overlap = size;
      break;
    }
  }

  const seedItems = snapshotItems.slice(0, snapshotItems.length - overlap);
  return [
    ...(seedItems.length > 0 ? [{ id: "snapshot", status: "completed", items: seedItems }] : []),
    ...projectedTurns,
  ];
}

export class LocalThreadHost implements ThreadHostAdapter {
  readonly hostId = LOCAL_HOST_ID;
  readonly displayName = "Local Cowork";

  constructor(private readonly deps: LocalThreadHostDeps) {}

  isSessionEligibleForTools(sessionId: string): boolean {
    if (this.deps.taskCoordinator.isTaskThread(sessionId)) return false;
    const runtime = this.deps.registry.sessionBindings.get(sessionId)?.runtime;
    if (!runtime) return false;
    return (
      runtime.read.sessionKind === "root" &&
      runtime.read.parentSessionId === null &&
      runtime.read.role == null
    );
  }

  async listProjects(): Promise<{ projects: ProjectSummary[] }> {
    const workspaceIndex = await this.loadWorkspaceIndex();
    return {
      projects: workspaceIndex.workspaces
        .filter((workspace) => workspace.workspaceKind === "project")
        .map((workspace) => ({
          projectId: workspace.id,
          name: workspace.name,
          path: workspace.path,
          hostId: this.hostId,
          active: workspace.id === workspaceIndex.activeWorkspaceId,
          ...(workspace.defaultProvider ? { defaultProvider: workspace.defaultProvider } : {}),
          ...(workspace.defaultModel ? { defaultModel: workspace.defaultModel } : {}),
        })),
    };
  }

  async listThreads(input: ListThreadsInput = {}): Promise<ListThreadsResult> {
    const workspaceIndex = await this.loadWorkspaceIndex();
    const metadata = await this.loadMetadataIndex();
    const threads = new Map<string, ThreadSummary>();

    for (const summary of this.deps.sessionDb.listSessions()) {
      if (this.deps.taskCoordinator.isTaskThread(summary.sessionId)) continue;
      const record = this.deps.sessionDb.getSessionRecord(summary.sessionId);
      if (!record || !this.shouldIncludeRecord(record)) continue;
      threads.set(
        record.sessionId,
        this.buildThreadSummaryFromRecord(record, metadata, workspaceIndex),
      );
    }

    for (const runtime of this.deps.registry.listLiveRoot()) {
      if (this.deps.taskCoordinator.isTaskThread(runtime.id)) continue;
      threads.set(
        runtime.id,
        this.buildThreadSummaryFromRuntime(runtime, metadata, workspaceIndex),
      );
    }

    const query = input.query?.trim().toLowerCase() ?? "";
    const filtered = [...threads.values()].filter((thread) => {
      const matches = this.threadMatchesQuery(thread, query);
      if (query && !matches) return false;
      if (!query && thread.archived) return false;
      if (query && thread.archived && !matches) return false;
      return true;
    });
    filtered.sort((left, right) => this.compareThreads(left, right, query));
    const total = filtered.length;
    const limit = clampPositiveInteger(input.limit, 50, 200);
    return {
      threads: filtered.slice(0, limit),
      total,
    };
  }

  async readThread(input: ReadThreadInput): Promise<ReadThreadResult> {
    const threadId = this.requireThreadId(input.threadId, "read_thread");
    this.assertThreadIsNotTaskOwned(threadId);
    const summary = await this.getThreadSummary(threadId);
    const includeOutputs = input.includeOutputs === true;
    const maxOutputChars = clampPositiveInteger(
      input.maxOutputCharsPerItem,
      DEFAULT_OUTPUT_CHARS,
      MAX_OUTPUT_CHARS,
    );
    await this.deps.threadJournal.waitForIdle(threadId);
    const events = this.readAllJournalEvents(threadId);
    const projected = projectThreadTurnsFromJournal(events);
    const snapshot = this.deps.registry.readThreadSnapshot(threadId);
    const compact = mergeSnapshotAndProjectedTurns(
      compactSnapshotFeed(snapshot?.feed, { includeOutputs, maxOutputChars }),
      compactProjectedTurns(projected, { includeOutputs, maxOutputChars }),
    );
    const turnLimit = clampPositiveInteger(input.turnLimit, DEFAULT_TURN_LIMIT, MAX_TURN_LIMIT);
    const cursor = decodeCursor(input.cursor, compact.length);
    const end = cursor.beforeTurnIndex;
    const start = Math.max(0, end - turnLimit);
    const page = compact.slice(start, end);
    return {
      thread: summary,
      turns: page,
      ...(start > 0 ? { nextCursor: encodeCursor({ beforeTurnIndex: start }) } : {}),
    };
  }

  async createThread(input: CreateThreadInput): Promise<CreateThreadResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("create_thread requires a non-empty prompt");
    const { cwd, workspaceId } = await this.resolveCreateTarget(input);
    const bootstrap = await this.loadThreadSessionBootstrap(cwd);
    const config = bootstrap?.config ?? this.deps.getConfig();
    const modelSelection = parseThreadModelSelection(input.model, config.provider, {
      home: resolveAuthHomeDir(config, this.deps.homedir),
    });
    const runtime = this.deps.registry.createJsonRpcThreadSession(
      cwd,
      modelSelection.provider,
      modelSelection.model,
      bootstrap ? { config: bootstrap.config, system: bootstrap.system } : undefined,
    );
    if (input.thinking) {
      await this.applyThinking(runtime, input.thinking);
    }
    await runtime.lifecycle.waitForPersistenceIdle();
    await this.upsertDesktopThread(runtime, workspaceId);
    void runtime.turns.sendUserMessage(prompt).catch(() => undefined);
    return {
      thread: await this.getThreadSummary(runtime.id),
      queued: true,
    };
  }

  async sendMessage(input: SendMessageToThreadInput): Promise<SendMessageResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("send_message_to_thread requires a non-empty prompt");
    this.assertThreadIsNotTaskOwned(input.threadId);
    this.assertThreadCanReceiveTurns(input.threadId);
    const binding = this.deps.registry.loadThreadBinding(input.threadId);
    const runtime = binding?.runtime;
    if (!runtime) throw new Error(`Unknown thread: ${input.threadId}`);
    if (runtime.read.isBusy) {
      return {
        threadId: input.threadId,
        hostId: this.hostId,
        queued: false,
        busy: true,
        activeTurnId: runtime.turns.activeTurnId,
      };
    }
    await this.applyModelAndThinking(runtime, input.model, input.thinking);
    void runtime.turns.sendUserMessage(prompt).catch(() => undefined);
    return {
      threadId: input.threadId,
      hostId: this.hostId,
      queued: true,
    };
  }

  async forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    const threadId = this.requireThreadId(input.threadId, "fork_thread");
    const prompt = input.prompt?.trim();
    if (input.prompt !== undefined && !prompt) {
      throw new Error("fork_thread prompt must be non-empty when provided");
    }
    const source = await this.loadForkSource(threadId);
    const environment = input.environment ?? { type: "local" };
    const forkTitle = input.title?.trim() || `Fork of ${source.title}`;
    const target = await this.resolveForkTarget(source, environment, forkTitle);
    const selection = this.resolveForkModelSelection(source, input.model);
    const bootstrap = await this.loadThreadSessionBootstrap(target.cwd);
    const baseConfig = bootstrap?.config ?? this.deps.getConfig();
    const runtime = this.deps.registry.createJsonRpcThreadSession(
      target.cwd,
      selection.provider,
      selection.model,
      {
        seedContext: this.buildSeedContext(source),
        title: forkTitle,
        config: {
          ...baseConfig,
          providerOptions: source.providerOptions ?? baseConfig.providerOptions,
        },
        ...(bootstrap ? { system: bootstrap.system } : {}),
      },
    );
    if (input.thinking?.trim()) {
      await this.applyThinking(runtime, input.thinking);
    }
    await runtime.lifecycle.waitForPersistenceIdle();
    await this.upsertDesktopThread(runtime, target.workspaceId);
    if (prompt) {
      void runtime.turns.sendUserMessage(prompt).catch(() => undefined);
    }
    return {
      sourceThreadId: threadId,
      thread: await this.getThreadSummary(runtime.id),
      forked: true,
      queued: Boolean(prompt),
      environment: target.environment,
    };
  }

  async handoffThread(_input: HandoffThreadInput): Promise<HandoffStartResult> {
    return { status: "unsupported", reason: "handoff_thread ships in a later phase" };
  }

  async getHandoffStatus(_input: HandoffStatusInput): Promise<HandoffStatusResult> {
    return { status: "unsupported", reason: "handoff_thread ships in a later phase" };
  }

  async setTitle(input: SetThreadTitleInput): Promise<ThreadSummary> {
    const threadId = this.requireThreadId(input.threadId, "set_thread_title");
    const title = input.title.trim();
    if (!title) throw new Error("set_thread_title requires a non-empty title");
    this.assertThreadIsNotTaskOwned(threadId);
    const binding = this.deps.registry.loadThreadBinding(threadId);
    const runtime = binding?.runtime;
    if (!runtime) throw new Error(`Unknown thread: ${threadId}`);
    runtime.settings.setTitle(title);
    await runtime.lifecycle.waitForPersistenceIdle();
    await this.updateDesktopThread(threadId, { title });
    return await this.getThreadSummary(threadId);
  }

  async setPinned(input: SetThreadPinnedInput): Promise<ThreadSummary> {
    const threadId = this.requireThreadId(input.threadId, "set_thread_pinned");
    this.assertThreadIsNotTaskOwned(threadId);
    this.assertKnownThread(threadId);
    const now = new Date().toISOString();
    const metadata = await this.loadMetadataIndex();
    const persisted = this.deps.sessionDb.getThreadMetadata(threadId);
    const current = metadata.get(threadId) ?? this.defaultMetadata();
    await this.deps.sessionDb.setThreadMetadata({
      threadId,
      pinned: input.pinned,
      ...(persisted ? {} : { archived: current.archived, archivedAt: current.archivedAt }),
      updatedAt: now,
    });
    await this.updateDesktopThread(threadId, {
      pinned: input.pinned,
      pinnedAt: input.pinned ? now : null,
    });
    return await this.getThreadSummary(threadId);
  }

  async setArchived(input: SetThreadArchivedInput): Promise<ThreadSummary> {
    const threadId = this.requireThreadId(input.threadId, "set_thread_archived");
    this.assertThreadIsNotTaskOwned(threadId);
    this.assertKnownThread(threadId);
    const now = new Date().toISOString();
    const metadata = await this.loadMetadataIndex();
    const persisted = this.deps.sessionDb.getThreadMetadata(threadId);
    const current = metadata.get(threadId) ?? this.defaultMetadata();
    await this.deps.sessionDb.setThreadMetadata({
      threadId,
      archived: input.archived,
      ...(persisted ? {} : { pinned: current.pinned, pinnedAt: current.pinnedAt }),
      updatedAt: now,
    });
    await this.updateDesktopThread(threadId, {
      archived: input.archived,
      archivedAt: input.archived ? now : null,
    });
    return await this.getThreadSummary(threadId);
  }

  private requireThreadId(threadId: string | undefined, operation: string): string {
    const trimmed = threadId?.trim();
    if (!trimmed) throw new Error(`${operation} requires threadId`);
    return trimmed;
  }

  private async resolveCreateTarget(input: CreateThreadInput): Promise<{
    cwd: string;
    workspaceId: string | null;
  }> {
    if (input.target.type === "project") {
      const target = input.target;
      const workspaceIndex = await this.loadWorkspaceIndex();
      const workspace = workspaceIndex.workspaces.find(
        (candidate) => candidate.id === target.projectId && candidate.workspaceKind === "project",
      );
      if (!workspace) throw new Error(`Unknown project: ${target.projectId}`);
      if (target.environment?.type === "worktree") {
        const worktree = await this.createManagedWorktree(
          workspace.path,
          target.environment,
          workspace.name,
        );
        return {
          cwd: worktree.path,
          workspaceId: await this.ensureDesktopWorkspace(
            worktree.path,
            `${workspace.name} worktree`,
            "project",
          ),
        };
      }
      return {
        cwd: workspace.path,
        workspaceId: await this.ensureDesktopWorkspace(workspace.path, workspace.name, "project"),
      };
    }

    const titleHint = input.target.directoryName ?? input.prompt;
    const workspace = this.deps.desktopService
      ? await this.deps.desktopService.createOneOffChatWorkspace({ titleHint })
      : await createOneOffChatWorkspace({ titleHint, homedir: this.deps.homedir });
    return {
      cwd: workspace.path,
      workspaceId: await this.ensureDesktopWorkspace(workspace.path, workspace.name, "oneOffChat"),
    };
  }

  private async loadForkSource(threadId: string): Promise<PersistedSessionRecord> {
    this.assertThreadIsNotTaskOwned(threadId);
    this.assertThreadCanReceiveTurns(threadId);
    const binding = this.deps.registry.loadThreadBinding(threadId);
    const runtime = binding?.runtime;
    if (!runtime) throw new Error(`Unknown thread: ${threadId}`);
    if (runtime.read.isBusy) {
      throw new Error("Cannot fork a thread while it is running");
    }
    await runtime.lifecycle.waitForPersistenceIdle();
    const record = this.deps.sessionDb.getSessionRecord(threadId);
    if (!record) throw new Error(`Unknown thread: ${threadId}`);
    if (record.sessionKind !== "root" || record.parentSessionId !== null || record.role !== null) {
      throw new Error("Only root threads can be forked");
    }
    return record;
  }

  private async loadThreadSessionBootstrap(cwd: string): Promise<ThreadSessionBootstrap | null> {
    return (await this.deps.loadThreadSessionBootstrap?.(cwd)) ?? null;
  }

  private buildSeedContext(record: PersistedSessionRecord): SeededSessionContext {
    return {
      messages: structuredClone(record.messages),
      todos: structuredClone(record.todos),
      harnessContext: record.harnessContext ? structuredClone(record.harnessContext) : null,
    };
  }

  private resolveForkModelSelection(
    source: PersistedSessionRecord,
    model: string | undefined,
  ): { provider: AgentConfig["provider"]; model: string } {
    if (!model?.trim()) {
      return { provider: source.provider, model: source.model };
    }
    const selection = parseThreadModelSelection(model, source.provider, {
      home: resolveAuthHomeDir(this.deps.getConfig(), this.deps.homedir),
    });
    return {
      provider: selection.provider ?? source.provider,
      model: selection.model ?? source.model,
    };
  }

  private async resolveForkTarget(
    source: PersistedSessionRecord,
    environment: ThreadEnvironment,
    titleHint: string,
  ): Promise<{
    cwd: string;
    workspaceId: string | null;
    environment: ForkThreadResult["environment"];
  }> {
    if (environment.type === "worktree") {
      const worktree = await this.createManagedWorktree(
        source.workingDirectory,
        environment,
        titleHint,
      );
      return {
        cwd: worktree.path,
        workspaceId: await this.ensureDesktopWorkspace(
          worktree.path,
          `${titleHint} worktree`,
          "project",
        ),
        environment: this.worktreeResultEnvironment(worktree),
      };
    }

    return {
      cwd: source.workingDirectory,
      workspaceId: await this.ensureDesktopWorkspace(
        source.workingDirectory,
        titleHint,
        this.workspaceKindForPath(source.workingDirectory),
      ),
      environment: { type: "local", cwd: source.workingDirectory },
    };
  }

  private async createManagedWorktree(
    sourceCwd: string,
    environment: Extract<ThreadEnvironment, { type: "worktree" }>,
    titleHint: string,
  ): Promise<ManagedWorktree> {
    const service = this.deps.worktreeService;
    if (!service) throw new Error("Managed worktrees are unavailable");
    const startingState = environment.startingState ?? {};
    return await service.createWorktree({
      sourceCwd,
      titleHint,
      ref: environment.ref ?? startingState.ref,
      branchName: environment.branchName ?? startingState.branchName,
    });
  }

  private worktreeResultEnvironment(
    worktree: ManagedWorktree,
  ): Extract<ForkThreadResult["environment"], { type: "worktree" }> {
    return {
      type: "worktree",
      cwd: worktree.path,
      branchName: worktree.branchName,
      baseRef: worktree.baseRef,
      baseCommit: worktree.baseCommit,
    };
  }

  private workspaceKindForPath(workspacePath: string): "project" | "oneOffChat" {
    return isPathInsideOneOffChatsRoot(workspacePath, this.deps.homedir) ? "oneOffChat" : "project";
  }

  private async applyModelAndThinking(
    runtime: SessionRuntime,
    model: string | undefined,
    thinking: string | undefined,
  ): Promise<void> {
    if (model?.trim()) {
      const config = runtime.read.publicConfig;
      const selection = parseThreadModelSelection(model, config.provider, {
        home: resolveAuthHomeDir(this.deps.getConfig(), this.deps.homedir),
      });
      await runtime.settings.setModel(selection.model ?? model.trim(), selection.provider);
    }
    if (thinking?.trim()) {
      await this.applyThinking(runtime, thinking);
    }
  }

  private async applyThinking(runtime: SessionRuntime, thinking: string): Promise<void> {
    const config = runtime.read.publicConfig;
    const patch = buildThreadReasoningOptionsPatch({
      provider: config.provider,
      model: config.model,
      thinking,
      current: runtime.settings.configEvent.config.providerOptions,
    });
    if (patch) {
      await runtime.settings.setConfig({ providerOptions: patch });
    }
  }

  private async getThreadSummary(threadId: string): Promise<ThreadSummary> {
    const workspaceIndex = await this.loadWorkspaceIndex();
    const metadata = await this.loadMetadataIndex();
    const liveRuntime = this.deps.registry.sessionBindings.get(threadId)?.runtime;
    if (liveRuntime) {
      return this.buildThreadSummaryFromRuntime(liveRuntime, metadata, workspaceIndex);
    }
    const record = this.deps.sessionDb.getSessionRecord(threadId);
    if (!record) throw new Error(`Unknown thread: ${threadId}`);
    return this.buildThreadSummaryFromRecord(record, metadata, workspaceIndex);
  }

  private buildThreadSummaryFromRuntime(
    runtime: SessionRuntime,
    metadata: Map<string, MetadataIndexEntry>,
    workspaceIndex: WorkspaceIndex,
  ): ThreadSummary {
    const info = runtime.read.info;
    const snapshot = runtime.snapshot.peek();
    const meta = metadata.get(runtime.id) ?? this.defaultMetadata();
    const workspace = this.findWorkspaceForPath(
      workspaceIndex.workspaces,
      runtime.read.workingDirectory,
    );
    return {
      threadId: runtime.id,
      hostId: this.hostId,
      title: info.title,
      preview: info.lastMessagePreview ?? runtime.read.getLatestAssistantText() ?? "",
      ...(workspace?.workspaceKind === "project"
        ? { projectId: workspace.id, projectName: workspace.name }
        : {}),
      cwd: runtime.read.workingDirectory,
      modelProvider: info.provider,
      model: info.model,
      status: runtime.read.isBusy ? "running" : "loaded",
      pinned: meta.pinned,
      pinnedAt: meta.pinnedAt,
      archived: meta.archived,
      archivedAt: meta.archivedAt,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      messageCount: snapshot.messageCount,
      lastEventSeq: snapshot.lastEventSeq,
    };
  }

  private buildThreadSummaryFromRecord(
    record: PersistedSessionRecord,
    metadata: Map<string, MetadataIndexEntry>,
    workspaceIndex: WorkspaceIndex,
  ): ThreadSummary {
    const meta = metadata.get(record.sessionId) ?? this.defaultMetadata();
    const workspace = this.findWorkspaceForPath(workspaceIndex.workspaces, record.workingDirectory);
    return {
      threadId: record.sessionId,
      hostId: this.hostId,
      title: record.title,
      preview: record.lastMessagePreview ?? "",
      ...(workspace?.workspaceKind === "project"
        ? { projectId: workspace.id, projectName: workspace.name }
        : {}),
      cwd: record.workingDirectory,
      modelProvider: record.provider,
      model: record.model,
      status: "notLoaded",
      pinned: meta.pinned,
      pinnedAt: meta.pinnedAt,
      archived: meta.archived,
      archivedAt: meta.archivedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount,
      lastEventSeq: record.lastEventSeq,
    };
  }

  private shouldIncludeRecord(record: PersistedSessionRecord): boolean {
    return (
      record.executionState === "running" ||
      record.executionState === "pending_init" ||
      record.messageCount > 0 ||
      record.titleSource !== "default" ||
      record.hasPendingAsk ||
      record.hasPendingApproval
    );
  }

  private compareThreads(left: ThreadSummary, right: ThreadSummary, query: string): number {
    if (query) {
      const leftExact = left.threadId.toLowerCase() === query;
      const rightExact = right.threadId.toLowerCase() === query;
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
    }
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  }

  private threadMatchesQuery(thread: ThreadSummary, query: string): boolean {
    if (!query) return true;
    return [
      thread.threadId,
      thread.title,
      thread.preview,
      thread.cwd,
      thread.projectId ?? "",
      thread.projectName ?? "",
    ].some((value) => value.toLowerCase().includes(query));
  }

  private readAllJournalEvents(threadId: string): PersistedThreadJournalEvent[] {
    const events: PersistedThreadJournalEvent[] = [];
    let afterSeq = 0;
    while (true) {
      const batch = this.deps.threadJournal.list(threadId, {
        afterSeq,
        limit: THREAD_READ_JOURNAL_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      events.push(...batch);
      afterSeq = batch.at(-1)?.seq ?? afterSeq;
      if (batch.length < THREAD_READ_JOURNAL_BATCH_SIZE) break;
    }
    return events;
  }

  private assertThreadIsNotTaskOwned(threadId: string): void {
    if (this.deps.taskCoordinator.isTaskThread(threadId)) {
      throw new Error("Task-owned threads are not managed by thread-management tools");
    }
  }

  private assertKnownThread(threadId: string): void {
    if (this.deps.registry.sessionBindings.has(threadId)) return;
    if (this.deps.sessionDb.getSessionRecord(threadId)) return;
    throw new Error(`Unknown thread: ${threadId}`);
  }

  private assertThreadCanReceiveTurns(threadId: string): void {
    const lock = getSessionTaskLock(
      this.deps.sessionDb,
      threadId,
      (sessionId) =>
        this.deps.registry.sessionBindings.get(sessionId)?.runtime?.read.parentSessionId ?? null,
    );
    if (lock) throw new Error(lock.message);
  }

  private async loadWorkspaceIndex(): Promise<WorkspaceIndex> {
    return await listWorkspaceSummaries({
      workingDirectory: this.deps.getConfig().workingDirectory,
      desktopService: this.deps.desktopService ?? null,
      homedir: this.deps.homedir,
    });
  }

  private async loadMetadataIndex(): Promise<Map<string, MetadataIndexEntry>> {
    const metadata = new Map<string, MetadataIndexEntry>();
    for (const entry of this.deps.sessionDb.listThreadMetadata()) {
      metadata.set(entry.threadId, this.metadataFromDb(entry));
    }

    const state = await this.loadDesktopStateOrNull();
    for (const item of state?.threads ?? []) {
      if (!isRecord(item)) continue;
      const threadId = asString(item.sessionId) ?? asString(item.id);
      if (!threadId || metadata.has(threadId)) continue;
      metadata.set(threadId, {
        pinned: asBoolean(item.pinned) ?? false,
        pinnedAt: asTimestamp(item.pinnedAt),
        archived: asBoolean(item.archived) ?? false,
        archivedAt: asTimestamp(item.archivedAt),
      });
    }
    return metadata;
  }

  private metadataFromDb(entry: PersistedThreadMetadata): MetadataIndexEntry {
    return {
      pinned: entry.pinned,
      pinnedAt: entry.pinnedAt,
      archived: entry.archived,
      archivedAt: entry.archivedAt,
    };
  }

  private defaultMetadata(): MetadataIndexEntry {
    return { pinned: false, pinnedAt: null, archived: false, archivedAt: null };
  }

  private findWorkspaceForPath(
    workspaces: JsonRpcWorkspaceSummary[],
    workspacePath: string,
  ): JsonRpcWorkspaceSummary | null {
    return workspaces.find((workspace) => sameWorkspacePath(workspace.path, workspacePath)) ?? null;
  }

  private async loadDesktopStateOrNull(): Promise<DesktopPersistedState | null> {
    if (!this.deps.desktopService) return null;
    try {
      return await this.deps.desktopService.loadState({
        fallbackCwd: this.deps.getConfig().workingDirectory,
      });
    } catch {
      return null;
    }
  }

  private async ensureDesktopWorkspace(
    workspacePath: string,
    name: string,
    workspaceKind: "project" | "oneOffChat",
  ): Promise<string | null> {
    const desktopService = this.deps.desktopService;
    if (!desktopService) return null;
    const state = await desktopService.loadState({
      fallbackCwd: this.deps.getConfig().workingDirectory,
    });
    const existing = state.workspaces.find((workspace) =>
      sameWorkspacePath(workspace.path, workspacePath),
    );
    if (existing) return existing.id;

    const now = new Date().toISOString();
    let id = `${workspaceKind === "project" ? "project" : "chat"}-${hashValue(workspacePath)}`;
    if (state.workspaces.some((workspace) => workspace.id === id)) {
      id = `${id}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
    }
    state.workspaces.push({
      id,
      name,
      path: workspacePath,
      workspaceKind,
      createdAt: now,
      lastOpenedAt: now,
      wsProtocol: "jsonrpc",
      defaultEnableMcp: true,
      defaultBackupsEnabled: false,
      yolo: false,
    });
    await desktopService.saveState(state);
    this.deps.onThreadListChanged?.();
    return id;
  }

  private async upsertDesktopThread(
    runtime: SessionRuntime,
    workspaceId: string | null,
  ): Promise<void> {
    const desktopService = this.deps.desktopService;
    if (!desktopService || !workspaceId) return;
    const state = await desktopService.loadState({
      fallbackCwd: this.deps.getConfig().workingDirectory,
    });
    const info = runtime.read.info;
    const snapshot = runtime.snapshot.peek();
    const existing = state.threads.find(
      (thread) => thread.sessionId === runtime.id || thread.id === runtime.id,
    );
    const record = {
      id: runtime.id,
      workspaceId,
      title: info.title,
      titleSource: info.titleSource,
      createdAt: info.createdAt,
      lastMessageAt: info.updatedAt,
      status: "active" as const,
      sessionId: runtime.id,
      messageCount: snapshot.messageCount,
      lastEventSeq: snapshot.lastEventSeq,
    };
    if (existing) {
      Object.assign(existing, record);
    } else {
      state.threads.unshift(record);
    }
    await desktopService.saveState(state);
    this.deps.onThreadListChanged?.();
  }

  private async updateDesktopThread(threadId: string, patch: DesktopThreadPatch): Promise<void> {
    const desktopService = this.deps.desktopService;
    if (!desktopService) {
      this.deps.onThreadListChanged?.();
      return;
    }
    const state = await desktopService.loadState({
      fallbackCwd: this.deps.getConfig().workingDirectory,
    });
    const thread = state.threads.find(
      (entry) => entry.sessionId === threadId || entry.id === threadId,
    );
    if (thread) {
      Object.assign(thread, patch);
      await desktopService.saveState(state);
    }
    this.deps.onThreadListChanged?.();
  }
}
