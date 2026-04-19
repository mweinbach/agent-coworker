import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

import type { DesktopFeatureFlagOverrides } from "../shared/featureFlags";
import { normalizeDesktopFeatureFlagOverrides } from "../shared/featureFlags";
import { writeTextFileAtomic } from "../utils/atomicFile";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_APP_NAME = "Cowork";
const FALLBACK_WORKSPACE_ID_PREFIX = "web";

type DesktopWorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
  defaultEnableMcp: boolean;
  defaultBackupsEnabled: boolean;
  yolo: boolean;
  [key: string]: unknown;
};

type DesktopThreadRecord = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
  status: "active" | "disconnected";
  sessionId: string | null;
  messageCount: number;
  lastEventSeq: number;
  [key: string]: unknown;
};

export type DesktopPersistedState = {
  version: number;
  workspaces: DesktopWorkspaceRecord[];
  threads: DesktopThreadRecord[];
  developerMode: boolean;
  showHiddenFiles: boolean;
  perWorkspaceSettings: boolean;
  desktopFeatureFlagOverrides: DesktopFeatureFlagOverrides;
  providerState?: unknown;
  providerUiState?: unknown;
  onboarding?: unknown;
};

export type DesktopTranscriptEvent = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
};

export type WebDesktopServiceLike = {
  loadState(opts?: { fallbackCwd?: string }): Promise<DesktopPersistedState>;
  saveState(state: unknown): Promise<DesktopPersistedState>;
  listWorkspaces(fallbackCwd: string): Promise<Array<{ name: string; path: string }>>;
  getWorkspaceRoots(fallbackCwd: string): Promise<string[]>;
  resolveWorkspaceDirectory(workspacePath: string): Promise<string>;
  startWorkspaceServer(opts: { workspaceId: string; workspacePath: string; yolo: boolean }): Promise<{ url: string }>;
  stopWorkspaceServer(workspaceId: string): Promise<void>;
  readTranscript(threadId: string): Promise<DesktopTranscriptEvent[]>;
  appendTranscriptEvent(event: DesktopTranscriptEvent): Promise<void>;
  appendTranscriptBatch(events: DesktopTranscriptEvent[]): Promise<void>;
  deleteTranscript(threadId: string): Promise<void>;
  stopAll(): Promise<void>;
};

type WorkspaceServerHandle = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  url: string;
  workspacePath: string;
  yolo: boolean;
};

type SourceWorkspaceServerLaunch = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  url: string;
};

type WorkspaceServerOutputSource = "stdout" | "stderr";

type WorkspaceServerMonitor = {
  ready: Promise<{ url: string }>;
  drained: Promise<void>;
};

type SourceWorkspaceServerManagerDeps = {
  repoRoot?: string;
  sourceEntry?: string;
  launchWorkspaceServer?: (opts: {
    repoRoot: string;
    sourceEntry: string;
    workspacePath: string;
    yolo: boolean;
  }) => Promise<SourceWorkspaceServerLaunch>;
  gracefulKill?: (child: ChildProcessByStdio<null, Readable, Readable>) => Promise<void>;
};

const transcriptEventSchema = z.object({
  ts: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  direction: z.enum(["server", "client"]),
  payload: z.unknown(),
}).passthrough();

const serverListeningSchema = z.object({
  type: z.literal("server_listening"),
  url: z.string().trim().min(1),
}).passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asSafeId(value: unknown): string | null {
  const candidate = asNonEmptyString(value);
  if (!candidate || !SAFE_ID.test(candidate)) {
    return null;
  }
  return candidate;
}

function asTimestamp(value: unknown): string | null {
  const candidate = asNonEmptyString(value);
  if (!candidate || Number.isNaN(Date.parse(candidate))) {
    return null;
  }
  return candidate;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asThreadStatus(value: unknown): "active" | "disconnected" {
  return value === "active" ? "active" : "disconnected";
}

function asNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function workspaceBasename(workspacePath: string): string {
  return workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? workspacePath;
}

async function resolveWorkspacePath(value: unknown): Promise<string | null> {
  const candidate = asNonEmptyString(value);
  if (!candidate) {
    return null;
  }
  const resolved = path.resolve(candidate);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return null;
    }
    return await fs.realpath(resolved);
  } catch {
    return null;
  }
}

function hashValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function defaultState(): DesktopPersistedState {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    desktopFeatureFlagOverrides: {},
  };
}

function buildFallbackWorkspace(cwd: string): DesktopWorkspaceRecord {
  const now = new Date().toISOString();
  return {
    id: `${FALLBACK_WORKSPACE_ID_PREFIX}-${hashValue(cwd)}`,
    name: workspaceBasename(cwd),
    path: cwd,
    createdAt: now,
    lastOpenedAt: now,
    wsProtocol: "jsonrpc",
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
  };
}

async function normalizeState(raw: unknown): Promise<DesktopPersistedState> {
  if (!isRecord(raw)) {
    return defaultState();
  }

  const workspaces: DesktopWorkspaceRecord[] = [];
  const seenWorkspaceIds = new Set<string>();
  for (const item of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
    if (!isRecord(item)) {
      continue;
    }

    const id = asSafeId(item.id);
    const name = asNonEmptyString(item.name);
    const createdAt = asTimestamp(item.createdAt);
    const lastOpenedAt = asTimestamp(item.lastOpenedAt);
    const workspacePath = await resolveWorkspacePath(item.path);
    if (!id || !name || !createdAt || !lastOpenedAt || !workspacePath || seenWorkspaceIds.has(id)) {
      continue;
    }

    workspaces.push({
      ...item,
      id,
      name,
      path: workspacePath,
      createdAt,
      lastOpenedAt,
      wsProtocol: "jsonrpc",
      defaultEnableMcp: asBoolean(item.defaultEnableMcp, true),
      defaultBackupsEnabled: asBoolean(item.defaultBackupsEnabled, true),
      yolo: asBoolean(item.yolo, false),
    });
    seenWorkspaceIds.add(id);
  }

  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const threads: DesktopThreadRecord[] = [];
  const seenThreadIds = new Set<string>();
  for (const item of Array.isArray(raw.threads) ? raw.threads : []) {
    if (!isRecord(item)) {
      continue;
    }

    const id = asSafeId(item.id);
    const workspaceId = asSafeId(item.workspaceId);
    const title = asNonEmptyString(item.title);
    const createdAt = asTimestamp(item.createdAt);
    const lastMessageAt = asTimestamp(item.lastMessageAt);
    if (!id || !workspaceId || !title || !createdAt || !lastMessageAt || seenThreadIds.has(id)) {
      continue;
    }
    if (!workspaceIds.has(workspaceId)) {
      continue;
    }

    threads.push({
      ...item,
      id,
      workspaceId,
      title,
      createdAt,
      lastMessageAt,
      status: asThreadStatus(item.status),
      sessionId: asNonEmptyString(item.sessionId) ?? null,
      messageCount: asNonNegativeInteger(item.messageCount, 0),
      lastEventSeq: asNonNegativeInteger(item.lastEventSeq, 0),
    });
    seenThreadIds.add(id);
  }

  return {
    version: typeof raw.version === "number" && Number.isFinite(raw.version)
      ? Math.max(2, Math.floor(raw.version))
      : 2,
    workspaces,
    threads,
    developerMode: asBoolean(raw.developerMode, false),
    showHiddenFiles: asBoolean(raw.showHiddenFiles, false),
    perWorkspaceSettings: asBoolean(raw.perWorkspaceSettings, false),
    desktopFeatureFlagOverrides: normalizeDesktopFeatureFlagOverrides(raw.desktopFeatureFlagOverrides) ?? {},
    ...(raw.providerState !== undefined ? { providerState: raw.providerState } : {}),
    ...(raw.providerUiState !== undefined ? { providerUiState: raw.providerUiState } : {}),
    ...(raw.onboarding !== undefined ? { onboarding: raw.onboarding } : {}),
  };
}

function resolveDesktopUserDataDir(explicitDir?: string): string {
  const override = explicitDir?.trim() || process.env.COWORK_DESKTOP_USER_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  const homeDir = os.homedir();
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", DEFAULT_APP_NAME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, DEFAULT_APP_NAME);
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  return path.join(configHome, DEFAULT_APP_NAME);
}

function resolveRepoRoot(): string {
  const override = process.env.COWORK_REPO_ROOT?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (fsSync.existsSync(path.join(resolved, "src", "server", "index.ts"))) {
      return resolved;
    }
  }

  const repoRoot = path.resolve(import.meta.dir, "../..");
  if (!fsSync.existsSync(path.join(repoRoot, "src", "server", "index.ts"))) {
    throw new Error(`Unable to resolve repo root from ${import.meta.dir}`);
  }
  return repoRoot;
}

async function assertWorkspaceDirectory(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${workspacePath}`);
  }
  return await fs.realpath(resolved);
}

function waitForServerListening(child: ChildProcessByStdio<null, Readable, Readable>): Promise<{ url: string }> {
  const monitor = createWorkspaceServerMonitor(child);
  void monitor.drained.catch(() => {});
  return monitor.ready;
}

function createWorkspaceServerMonitor(
  child: ChildProcessByStdio<null, Readable, Readable>,
  onOutputLine: (source: WorkspaceServerOutputSource, line: string) => void = () => {},
): WorkspaceServerMonitor {
  let resolveReady!: (value: { url: string }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ url: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveDrained!: () => void;
  let rejectDrained!: (error: Error) => void;
  const drained = new Promise<void>((resolve, reject) => {
    resolveDrained = resolve;
    rejectDrained = reject;
  });

  const recentLines: string[] = [];
  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  let readySeen = false;
  let finished = false;
  let readySettled = false;

  const settleReadyResolve = (value: { url: string }) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady(value);
  };

  const settleReadyReject = (error: Error) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(error);
  };

  const recordLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    recentLines.push(trimmed);
    if (recentLines.length > 5) {
      recentLines.shift();
    }
  };

  const withRecentLines = (message: string) =>
    recentLines.length > 0 ? `${message}; output=${recentLines.join(" | ")}` : message;

  const cleanup = () => {
    if (finished) {
      return false;
    }
    finished = true;
    clearTimeout(timeout);
    stdoutReader.off("line", onStdoutLine);
    stderrReader.off("line", onStderrLine);
    child.off("exit", onExit);
    child.off("error", onError);
    stdoutReader.close();
    stderrReader.close();
    return true;
  };

  const onTimeout = () => {
    if (!cleanup()) {
      return;
    }
    const error = new Error(withRecentLines(`Workspace server startup timed out after ${SERVER_STARTUP_TIMEOUT_MS / 1000} seconds`));
    settleReadyReject(error);
    rejectDrained(error);
  };

  const timeout = setTimeout(onTimeout, SERVER_STARTUP_TIMEOUT_MS);

  const onError = (error: Error) => {
    if (!cleanup()) {
      return;
    }
    settleReadyReject(error);
    rejectDrained(error);
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!cleanup()) {
      return;
    }
    if (!readySeen) {
      settleReadyReject(new Error(withRecentLines(`Workspace server exited before reporting readiness (code=${code ?? "null"}, signal=${signal ?? "null"})`)));
    }
    resolveDrained();
  };

  const handleOutputLine = (source: WorkspaceServerOutputSource, line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    recordLine(trimmed);
    if (!readySeen && source === "stdout") {
      try {
        const parsed = serverListeningSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) {
          readySeen = true;
          clearTimeout(timeout);
          settleReadyResolve({ url: parsed.data.url });
          return;
        }
      } catch {
        // Ignore non-JSON startup noise while waiting for the server_listening event.
      }
    }

    onOutputLine(source, trimmed);
  };

  const onStdoutLine = (line: string) => {
    handleOutputLine("stdout", line);
  };

  const onStderrLine = (line: string) => {
    handleOutputLine("stderr", line);
  };

  stdoutReader.on("line", onStdoutLine);
  stderrReader.on("line", onStderrLine);
  child.once("exit", onExit);
  child.once("error", onError);

  return { ready, drained };
}

async function gracefulKill(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill();
  } catch {
    // ignore
  }

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (exited) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
}

class SourceWorkspaceServerManager {
  private readonly repoRoot: string;
  private readonly sourceEntry: string;
  private readonly servers = new Map<string, WorkspaceServerHandle>();
  private readonly launchWorkspaceServerImpl: NonNullable<SourceWorkspaceServerManagerDeps["launchWorkspaceServer"]>;
  private readonly gracefulKillImpl: NonNullable<SourceWorkspaceServerManagerDeps["gracefulKill"]>;

  constructor(deps: SourceWorkspaceServerManagerDeps = {}) {
    this.repoRoot = deps.repoRoot ?? resolveRepoRoot();
    this.sourceEntry = deps.sourceEntry ?? path.join(this.repoRoot, "src", "server", "index.ts");
    this.launchWorkspaceServerImpl = deps.launchWorkspaceServer ?? launchWorkspaceServer;
    this.gracefulKillImpl = deps.gracefulKill ?? gracefulKill;
  }

  async startWorkspaceServer(opts: { workspaceId: string; workspacePath: string; yolo: boolean }): Promise<{ url: string }> {
    const workspaceId = asSafeId(opts.workspaceId);
    if (!workspaceId) {
      throw new Error("workspaceId contains invalid characters");
    }
    const workspacePath = await assertWorkspaceDirectory(opts.workspacePath);

    const existing = this.servers.get(workspaceId);
    if (existing && existing.child.exitCode === null && existing.child.signalCode === null) {
      if (existing.workspacePath === workspacePath && existing.yolo === opts.yolo) {
        return { url: existing.url };
      }
      this.servers.delete(workspaceId);
      await this.gracefulKillImpl(existing.child);
    } else if (existing) {
      this.servers.delete(workspaceId);
      await this.gracefulKillImpl(existing.child);
    }

    try {
      const listening = await this.launchWorkspaceServerImpl({
        repoRoot: this.repoRoot,
        sourceEntry: this.sourceEntry,
        workspacePath,
        yolo: opts.yolo,
      });
      const handle: WorkspaceServerHandle = {
        child: listening.child,
        url: listening.url,
        workspacePath,
        yolo: opts.yolo,
      };
      this.servers.set(workspaceId, handle);
      listening.child.once("exit", () => {
        const active = this.servers.get(workspaceId);
        if (active?.child === listening.child) {
          this.servers.delete(workspaceId);
        }
      });
      return { url: handle.url };
    } catch (error) {
      throw error;
    }
  }

  async stopWorkspaceServer(workspaceId: string): Promise<void> {
    const safeWorkspaceId = asSafeId(workspaceId);
    if (!safeWorkspaceId) {
      throw new Error("workspaceId contains invalid characters");
    }
    const handle = this.servers.get(safeWorkspaceId);
    if (!handle) {
      return;
    }
    this.servers.delete(safeWorkspaceId);
    await this.gracefulKillImpl(handle.child);
  }

  async stopAll(): Promise<void> {
    const handles = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(handles.map((handle) => this.gracefulKillImpl(handle.child)));
  }
}

async function launchWorkspaceServer(opts: {
  repoRoot: string;
  sourceEntry: string;
  workspacePath: string;
  yolo: boolean;
}): Promise<SourceWorkspaceServerLaunch> {
  const args = [
    opts.sourceEntry,
    "--dir",
    opts.workspacePath,
    "--port",
    "0",
    "--json",
    "--ws-protocol-default",
    "jsonrpc",
  ];
  if (opts.yolo) {
    args.push("--yolo");
  }

  const child = spawn(process.execPath, args, {
    cwd: opts.repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
    },
  });

  try {
    const listening = await waitForServerListening(child);
    return { child, url: listening.url };
  } catch (error) {
    await gracefulKill(child);
    throw error;
  }
}

export class WebDesktopService implements WebDesktopServiceLike {
  private readonly userDataDir: string;
  private readonly serverManager: SourceWorkspaceServerManager;

  constructor(opts: { userDataDir?: string; serverManager?: SourceWorkspaceServerManager } = {}) {
    this.userDataDir = resolveDesktopUserDataDir(opts.userDataDir);
    this.serverManager = opts.serverManager ?? new SourceWorkspaceServerManager();
  }

  private get stateFilePath(): string {
    return path.join(this.userDataDir, "state.json");
  }

  private get transcriptsDir(): string {
    return path.join(this.userDataDir, "transcripts");
  }

  private transcriptFilePath(threadId: string): string {
    const safeThreadId = asSafeId(threadId);
    if (!safeThreadId) {
      throw new Error("threadId contains invalid characters");
    }
    return path.join(this.transcriptsDir, `${safeThreadId}.jsonl`);
  }

  async loadState(opts: { fallbackCwd?: string } = {}): Promise<DesktopPersistedState> {
    let state = defaultState();
    try {
      const raw = await fs.readFile(this.stateFilePath, "utf8");
      state = await normalizeState(JSON.parse(raw));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    if (state.workspaces.length === 0 && opts.fallbackCwd) {
      const fallbackWorkspacePath = await resolveWorkspacePath(opts.fallbackCwd);
      if (fallbackWorkspacePath) {
        state = {
          ...state,
          workspaces: [buildFallbackWorkspace(fallbackWorkspacePath)],
        };
      }
    }

    return state;
  }

  async saveState(state: unknown): Promise<DesktopPersistedState> {
    const normalized = await normalizeState(state);
    await fs.mkdir(this.userDataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeTextFileAtomic(
      this.stateFilePath,
      JSON.stringify(normalized, null, 2),
      { mode: PRIVATE_FILE_MODE },
    );
    return normalized;
  }

  async listWorkspaces(fallbackCwd: string): Promise<Array<{ name: string; path: string }>> {
    const state = await this.loadState({ fallbackCwd });
    return state.workspaces.map((workspace) => ({
      name: workspace.name,
      path: workspace.path,
    }));
  }

  async getWorkspaceRoots(fallbackCwd: string): Promise<string[]> {
    const state = await this.loadState({ fallbackCwd });
    const roots = state.workspaces.map((workspace) => workspace.path);
    return roots.length > 0 ? roots : [fallbackCwd];
  }

  async resolveWorkspaceDirectory(workspacePath: string): Promise<string> {
    return await assertWorkspaceDirectory(workspacePath);
  }

  async startWorkspaceServer(opts: { workspaceId: string; workspacePath: string; yolo: boolean }): Promise<{ url: string }> {
    return await this.serverManager.startWorkspaceServer(opts);
  }

  async stopWorkspaceServer(workspaceId: string): Promise<void> {
    await this.serverManager.stopWorkspaceServer(workspaceId);
  }

  async readTranscript(threadId: string): Promise<DesktopTranscriptEvent[]> {
    let raw = "";
    try {
      raw = await fs.readFile(this.transcriptFilePath(threadId), "utf8");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const events: DesktopTranscriptEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = transcriptEventSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) {
          events.push(parsed.data);
        }
      } catch {
        // Ignore malformed transcript lines and salvage the rest of the thread.
      }
    }
    return events;
  }

  async appendTranscriptEvent(event: DesktopTranscriptEvent): Promise<void> {
    await this.appendTranscriptBatch([event]);
  }

  async appendTranscriptBatch(events: DesktopTranscriptEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const normalizedEvents = events.map((event) => {
      const parsed = transcriptEventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid transcript event");
      }
      return parsed.data;
    });

    await fs.mkdir(this.transcriptsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const buckets = new Map<string, DesktopTranscriptEvent[]>();
    for (const event of normalizedEvents) {
      const existing = buckets.get(event.threadId);
      if (existing) {
        existing.push(event);
      } else {
        buckets.set(event.threadId, [event]);
      }
    }

    for (const [threadId, bucket] of buckets) {
      const filePath = this.transcriptFilePath(threadId);
      const payload = `${bucket.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await fs.appendFile(filePath, payload, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      await fs.chmod(filePath, PRIVATE_FILE_MODE);
    }
  }

  async deleteTranscript(threadId: string): Promise<void> {
    try {
      await fs.unlink(this.transcriptFilePath(threadId));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async stopAll(): Promise<void> {
    await this.serverManager.stopAll();
  }
}

export const __internal = {
  SourceWorkspaceServerManager,
  createWorkspaceServerMonitor,
  waitForServerListening,
};
