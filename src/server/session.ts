import type { ModelMessage } from "ai";
import fs from "node:fs/promises";
import path from "node:path";

import { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import { getProviderStatuses } from "../providerStatus";
import { discoverSkills, stripSkillFrontMatter } from "../skills";
import { isProviderName } from "../types";
import type { AgentConfig, HarnessContextPayload, HarnessSloCheck, ObservabilityQueryRequest, TodoItem } from "../types";
import { runTurn } from "../agent";
import { loadSystemPromptWithSkills } from "../prompt";
import { createTools } from "../tools";
import { classifyCommand } from "../utils/approval";
import { HarnessContextStore } from "../harness/contextStore";
import { emitObservabilityEvent } from "../observability/otel";
import { runObservabilityQuery } from "../observability/query";
import { evaluateHarnessSlo } from "../observability/slo";

import type { ServerEvent } from "./protocol";
import {
  SessionBackupManager,
  type SessionBackupHandle,
  type SessionBackupInitOptions,
  type SessionBackupPublicState,
} from "./sessionBackup";

function makeId(): string {
  return crypto.randomUUID();
}

type SessionBackupFactory = (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Maximum number of message history entries before older entries are pruned. */
const MAX_MESSAGE_HISTORY = 200;

export class AgentSession {
  readonly id: string;

  private config: AgentConfig;
  private system: string;
  private discoveredSkills: Array<{ name: string; description: string }>;
  private readonly yolo: boolean;
  private readonly emit: (evt: ServerEvent) => void;
  private readonly connectProviderImpl: typeof connectModelProvider;
  private readonly getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  private readonly getProviderStatusesImpl: typeof getProviderStatuses;
  private readonly sessionBackupFactory: SessionBackupFactory;
  private readonly harnessContextStore: HarnessContextStore;
  private readonly runObservabilityQueryImpl: typeof runObservabilityQuery;
  private readonly evaluateHarnessSloImpl: typeof evaluateHarnessSlo;

  private messages: ModelMessage[] = [];
  private running = false;
  private connecting = false;
  private refreshingProviderStatus = false;
  private abortController: AbortController | null = null;

  private readonly pendingAsk = new Map<string, Deferred<string>>();
  private readonly pendingApproval = new Map<string, Deferred<boolean>>();

  private todos: TodoItem[] = [];
  private sessionBackup: SessionBackupHandle | null = null;
  private sessionBackupState: SessionBackupPublicState;
  private readonly sessionBackupInit: Promise<void>;

  constructor(opts: {
    config: AgentConfig;
    system: string;
    discoveredSkills?: Array<{ name: string; description: string }>;
    yolo?: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl?: typeof connectModelProvider;
    getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
    getProviderStatusesImpl?: typeof getProviderStatuses;
    sessionBackupFactory?: SessionBackupFactory;
    harnessContextStore?: HarnessContextStore;
    runObservabilityQueryImpl?: typeof runObservabilityQuery;
    evaluateHarnessSloImpl?: typeof evaluateHarnessSlo;
  }) {
    this.id = makeId();
    this.config = opts.config;
    this.system = opts.system;
    this.discoveredSkills = opts.discoveredSkills ?? [];
    this.yolo = opts.yolo === true;
    this.emit = opts.emit;
    this.connectProviderImpl = opts.connectProviderImpl ?? connectModelProvider;
    this.getAiCoworkerPathsImpl = opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths;
    this.getProviderStatusesImpl = opts.getProviderStatusesImpl ?? getProviderStatuses;
    this.sessionBackupFactory =
      opts.sessionBackupFactory ?? (async (factoryOpts) => await SessionBackupManager.create(factoryOpts));
    this.harnessContextStore = opts.harnessContextStore ?? new HarnessContextStore();
    this.runObservabilityQueryImpl = opts.runObservabilityQueryImpl ?? runObservabilityQuery;
    this.evaluateHarnessSloImpl = opts.evaluateHarnessSloImpl ?? evaluateHarnessSlo;
    this.sessionBackupState = {
      status: "initializing",
      sessionId: this.id,
      workingDirectory: this.config.workingDirectory,
      backupDirectory: null,
      createdAt: new Date().toISOString(),
      originalSnapshot: { kind: "pending" },
      checkpoints: [],
    };
    this.sessionBackupInit = this.initializeSessionBackup();
  }

  getPublicConfig() {
    return {
      provider: this.config.provider,
      model: this.config.model,
      workingDirectory: this.config.workingDirectory,
      outputDirectory: this.config.outputDirectory,
    };
  }

  getEnableMcp() {
    return this.config.enableMcp ?? false;
  }

  getObservabilityStatusEvent(): Extract<ServerEvent, { type: "observability_status" }> {
    return {
      type: "observability_status",
      sessionId: this.id,
      enabled: this.config.observabilityEnabled ?? false,
      observability: this.config.observability,
    };
  }

  reset() {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }
    this.messages = [];
    this.todos = [];
    this.emit({ type: "todos", sessionId: this.id, todos: [] });
    this.emit({ type: "reset_done", sessionId: this.id });
  }

  listTools() {
    const tools = Object.keys(
      createTools({
        config: this.config,
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => false,
      })
    ).sort();
    this.emit({ type: "tools", sessionId: this.id, tools });
  }

  async listSkills() {
    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      this.emit({ type: "skills_list", sessionId: this.id, skills });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `Failed to list skills: ${String(err)}` });
    }
  }

  async readSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emit({ type: "error", sessionId: this.id, message: "Skill name is required" });
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emit({ type: "error", sessionId: this.id, message: `Skill "${skillName}" not found.` });
        return;
      }

      const content = await fs.readFile(skill.path, "utf-8");
      this.emit({ type: "skill_content", sessionId: this.id, skill, content: stripSkillFrontMatter(content) });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `Failed to read skill: ${String(err)}` });
    }
  }

  private globalSkillsDirs(): { enabledDir: string | null; disabledDir: string | null } {
    const enabledDir = this.config.skillsDirs.length >= 2 ? this.config.skillsDirs[1]! : null;
    if (!enabledDir) return { enabledDir: null, disabledDir: null };
    return { enabledDir, disabledDir: path.join(path.dirname(enabledDir), "disabled-skills") };
  }

  private async refreshSkillsList() {
    const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
    // Keep the cached metadata used by skill tool descriptions in sync with the
    // current enabled set so subsequent turns don't advertise stale skills.
    this.discoveredSkills = skills
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description }));
    this.emit({ type: "skills_list", sessionId: this.id, skills });
  }

  async disableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emit({ type: "error", sessionId: this.id, message: "Skill name is required" });
      return;
    }
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.emit({ type: "error", sessionId: this.id, message: "Global skills directory is not configured." });
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emit({ type: "error", sessionId: this.id, message: `Skill "${skillName}" not found.` });
        return;
      }
      if (skill.source !== "global") {
        this.emit({ type: "error", sessionId: this.id, message: "Only global skills can be disabled in v1." });
        return;
      }
      if (!skill.enabled) {
        await this.refreshSkillsList();
        return;
      }

      await fs.mkdir(disabledDir, { recursive: true });
      const from = path.join(enabledDir, skillName);
      const to = path.join(disabledDir, skillName);
      await fs.rename(from, to);
      await this.refreshSkillsList();
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `Failed to disable skill: ${String(err)}` });
    }
  }

  async enableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emit({ type: "error", sessionId: this.id, message: "Skill name is required" });
      return;
    }
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.emit({ type: "error", sessionId: this.id, message: "Global skills directory is not configured." });
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emit({ type: "error", sessionId: this.id, message: `Skill "${skillName}" not found.` });
        return;
      }
      if (skill.source !== "global") {
        this.emit({ type: "error", sessionId: this.id, message: "Only global skills can be enabled in v1." });
        return;
      }
      if (skill.enabled) {
        await this.refreshSkillsList();
        return;
      }

      await fs.mkdir(enabledDir, { recursive: true });
      const from = path.join(disabledDir, skillName);
      const to = path.join(enabledDir, skillName);
      await fs.rename(from, to);
      await this.refreshSkillsList();
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `Failed to enable skill: ${String(err)}` });
    }
  }

  async deleteSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emit({ type: "error", sessionId: this.id, message: "Skill name is required" });
      return;
    }
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emit({ type: "error", sessionId: this.id, message: `Skill "${skillName}" not found.` });
        return;
      }
      if (skill.source !== "global") {
        this.emit({ type: "error", sessionId: this.id, message: "Only global skills can be deleted in v1." });
        return;
      }

      // Delete the containing directory (skill.path points at SKILL.md).
      const skillDir = path.dirname(skill.path);
      await fs.rm(skillDir, { recursive: true, force: true });
      await this.refreshSkillsList();
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `Failed to delete skill: ${String(err)}` });
    }
  }

  setEnableMcp(enableMcp: boolean) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    this.config = { ...this.config, enableMcp };
    this.emit({ type: "session_settings", sessionId: this.id, enableMcp });
  }

  getHarnessContext() {
    this.emit({
      type: "harness_context",
      sessionId: this.id,
      context: this.harnessContextStore.get(this.id),
    });
  }

  setHarnessContext(context: HarnessContextPayload) {
    const next = this.harnessContextStore.set(this.id, context);
    this.emit({ type: "harness_context", sessionId: this.id, context: next });
  }

  async queryObservability(query: ObservabilityQueryRequest) {
    const result = await this.runObservabilityQueryImpl(this.config, query);
    this.emit({ type: "observability_query_result", sessionId: this.id, result });
  }

  async evaluateHarnessSloChecks(checks: HarnessSloCheck[]) {
    const result = await this.evaluateHarnessSloImpl(this.config, checks);
    this.emit({ type: "harness_slo_result", sessionId: this.id, result });
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    const modelId = modelIdRaw.trim();
    if (!modelId) {
      this.emit({ type: "error", sessionId: this.id, message: "Model id is required" });
      return;
    }
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    const nextProvider =
      providerRaw === undefined
        ? this.config.provider
        : isProviderName(providerRaw)
          ? providerRaw
          : null;
    if (!nextProvider) {
      this.emit({ type: "error", sessionId: this.id, message: `Unsupported provider: ${String(providerRaw)}` });
      return;
    }

    this.config = {
      ...this.config,
      provider: nextProvider,
      model: modelId,
      // Keep sub-agent model aligned for now until we expose a dedicated toggle.
      subAgentModel: modelId,
    };

    try {
      const result = await loadSystemPromptWithSkills(this.config);
      this.system = result.prompt;
      this.discoveredSkills = result.discoveredSkills;
    } catch (err) {
      this.emit({
        type: "error",
        sessionId: this.id,
        message: `Model updated but failed to refresh prompt: ${String(err)}`,
      });
    }

    this.emit({
      type: "config_updated",
      sessionId: this.id,
      config: this.getPublicConfig(),
    });
  }

  async connectProvider(providerRaw: AgentConfig["provider"], apiKeyRaw?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }
    if (this.connecting) {
      this.emit({ type: "error", sessionId: this.id, message: "Connection flow already running" });
      return;
    }
    if (!isProviderName(providerRaw)) {
      this.emit({ type: "error", sessionId: this.id, message: `Unsupported provider: ${String(providerRaw)}` });
      return;
    }

    this.connecting = true;
    try {
      const userHome = this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;
      const paths = this.getAiCoworkerPathsImpl({ homedir: userHome });
      const result = await this.connectProviderImpl({
        provider: providerRaw,
        apiKey: apiKeyRaw,
        cwd: this.config.workingDirectory,
        paths,
        oauthStdioMode: "pipe",
        allowOpenTerminal: providerRaw === "claude-code",
        onOauthLine: (line) => this.log(`[connect ${providerRaw}] ${line}`),
      });

      if (!result.ok) {
        this.emit({
          type: "error",
          sessionId: this.id,
          message: result.message,
        });
        return;
      }

      const lines = [`### /connect ${providerRaw}`, "", result.message, "", `- Mode: ${result.mode}`, `- Storage: \`${result.storageFile}\``];
      if (result.maskedApiKey) lines.splice(4, 0, `- Key: \`${result.maskedApiKey}\``);
      if (result.oauthCommand) lines.push(`- OAuth command: \`${result.oauthCommand}\``);
      if (result.oauthCredentialsFile) lines.push(`- OAuth credentials: \`${result.oauthCredentialsFile}\``);
      this.emit({
        type: "assistant_message",
        sessionId: this.id,
        text: lines.join("\n"),
      });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `connect failed: ${String(err)}` });
    } finally {
      this.connecting = false;
    }
  }

  async refreshProviderStatus() {
    if (this.refreshingProviderStatus) return;
    this.refreshingProviderStatus = true;
    try {
      const userHome = this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;
      const paths = this.getAiCoworkerPathsImpl({ homedir: userHome });
      const providers = await this.getProviderStatusesImpl({ paths });
      this.emit({ type: "provider_status", sessionId: this.id, providers });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `Failed to refresh provider status: ${String(err)}` });
    } finally {
      this.refreshingProviderStatus = false;
    }
  }

  handleAskResponse(requestId: string, answer: string) {
    const d = this.pendingAsk.get(requestId);
    if (!d) return;
    this.pendingAsk.delete(requestId);
    d.resolve(answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    const d = this.pendingApproval.get(requestId);
    if (!d) return;
    this.pendingApproval.delete(requestId);
    d.resolve(approved);
  }

  /** Cancel the currently running agent turn. */
  cancel() {
    if (!this.running) return;
    if (this.abortController) {
      this.abortController.abort();
    }
    // Reject any pending ask/approval so the turn unblocks.
    for (const [id, d] of this.pendingAsk) {
      d.reject(new Error("Cancelled by user"));
      this.pendingAsk.delete(id);
    }
    for (const [id, d] of this.pendingApproval) {
      d.reject(new Error("Cancelled by user"));
      this.pendingApproval.delete(id);
    }
  }

  dispose(reason: string) {
    this.abortController?.abort();
    for (const [id, d] of this.pendingAsk) {
      d.reject(new Error(`Session disposed (${reason})`));
      this.pendingAsk.delete(id);
    }
    for (const [id, d] of this.pendingApproval) {
      d.reject(new Error(`Session disposed (${reason})`));
      this.pendingApproval.delete(id);
    }
    this.harnessContextStore.clear(this.id);

    void this.closeSessionBackup();
  }

  private log(line: string) {
    this.emit({ type: "log", sessionId: this.id, line });
  }

  private async askUser(question: string, options?: string[]) {
    const requestId = makeId();
    const d = deferred<string>();
    this.pendingAsk.set(requestId, d);

    this.emit({ type: "ask", sessionId: this.id, requestId, question, options });
    return await d.promise;
  }

  private async approveCommand(command: string) {
    if (this.yolo) return true;

    const classification = classifyCommand(command);
    if (classification.kind === "auto") return true;

    const requestId = makeId();
    const d = deferred<boolean>();
    this.pendingApproval.set(requestId, d);

    this.emit({
      type: "approval",
      sessionId: this.id,
      requestId,
      command,
      dangerous: classification.dangerous,
    });

    return await d.promise;
  }

  private updateTodos = (todos: TodoItem[]) => {
    this.todos = todos;
    this.emit({ type: "todos", sessionId: this.id, todos });
  };

  async getSessionBackupState() {
    await this.sessionBackupInit;
    this.emitSessionBackupState("requested");
  }

  async createManualSessionCheckpoint() {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    await this.sessionBackupInit;
    if (!this.sessionBackup) {
      const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
      this.emit({ type: "error", sessionId: this.id, message: reason });
      return;
    }

    try {
      await this.sessionBackup.createCheckpoint("manual");
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("manual_checkpoint");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `manual checkpoint failed: ${String(err)}` });
    }
  }

  async restoreSessionBackup(checkpointId?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    await this.sessionBackupInit;
    if (!this.sessionBackup) {
      const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
      this.emit({ type: "error", sessionId: this.id, message: reason });
      return;
    }

    try {
      if (checkpointId) {
        await this.sessionBackup.restoreCheckpoint(checkpointId);
      } else {
        await this.sessionBackup.restoreOriginal();
      }
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("restore");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `restore failed: ${String(err)}` });
    }
  }

  async deleteSessionCheckpoint(checkpointId: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    await this.sessionBackupInit;
    if (!this.sessionBackup) {
      const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
      this.emit({ type: "error", sessionId: this.id, message: reason });
      return;
    }

    try {
      const removed = await this.sessionBackup.deleteCheckpoint(checkpointId);
      if (!removed) {
        this.emit({
          type: "error",
          sessionId: this.id,
          message: `Unknown checkpoint id: ${checkpointId}`,
        });
        return;
      }
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("delete");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `delete checkpoint failed: ${String(err)}` });
    }
  }

  async sendUserMessage(text: string, clientMessageId?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const turnStartedAt = Date.now();
    try {
      this.emit({ type: "user_message", sessionId: this.id, text, clientMessageId });
      this.emit({ type: "session_busy", sessionId: this.id, busy: true });
      // Telemetry is best-effort; don't block turn execution on network I/O.
      void emitObservabilityEvent(this.config, {
        name: "agent.turn.started",
        at: new Date().toISOString(),
        status: "ok",
        attributes: {
          sessionId: this.id,
          provider: this.config.provider,
          model: this.config.model,
        },
      });
      await this.sessionBackupInit;
      this.messages.push({ role: "user", content: text });

      // Trim message history to prevent unbounded memory growth.
      if (this.messages.length > MAX_MESSAGE_HISTORY) {
        // Keep the most recent messages, preserving at least the first system/user
        // turn so the model retains initial context.
        this.messages = this.messages.slice(-MAX_MESSAGE_HISTORY);
      }

      const res = await runTurn({
        config: this.config,
        system: this.system,
        messages: this.messages,
        log: (line) => this.log(line),
        askUser: (q, opts) => this.askUser(q, opts),
        approveCommand: (cmd) => this.approveCommand(cmd),
        updateTodos: (todos) => this.updateTodos(todos),
        discoveredSkills: this.discoveredSkills,
        maxSteps: 100,
        enableMcp: this.config.enableMcp,
        abortSignal: this.abortController.signal,
      });

      this.messages.push(...res.responseMessages);

      const reasoning = (res.reasoningText || "").trim();
      if (reasoning) {
        const kind = this.config.provider === "openai" || this.config.provider === "codex-cli" ? "summary" : "reasoning";
        this.emit({ type: "reasoning", sessionId: this.id, kind, text: reasoning });
      }

      const out = (res.text || "").trim();
      if (out) this.emit({ type: "assistant_message", sessionId: this.id, text: out });
      // Telemetry is best-effort; don't block turn execution on network I/O.
      void emitObservabilityEvent(this.config, {
        name: "agent.turn.completed",
        at: new Date().toISOString(),
        status: "ok",
        durationMs: Date.now() - turnStartedAt,
        attributes: {
          sessionId: this.id,
          provider: this.config.provider,
          model: this.config.model,
        },
      });
    } catch (err) {
      const msg = String(err);
      // Don't emit error for user-initiated cancellation.
      if (!msg.includes("abort") && !msg.includes("cancel")) {
        this.emit({ type: "error", sessionId: this.id, message: msg });
      }
      // Telemetry is best-effort; don't block turn execution on network I/O.
      void emitObservabilityEvent(this.config, {
        name: "agent.turn.failed",
        at: new Date().toISOString(),
        status: "error",
        durationMs: Date.now() - turnStartedAt,
        attributes: {
          sessionId: this.id,
          provider: this.config.provider,
          model: this.config.model,
          error: msg,
        },
      });
    } finally {
      await this.takeAutomaticSessionCheckpoint();
      this.emit({ type: "session_busy", sessionId: this.id, busy: false });
      this.running = false;
      this.abortController = null;
    }
  }

  private emitSessionBackupState(
    reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete"
  ) {
    this.emit({
      type: "session_backup_state",
      sessionId: this.id,
      reason,
      backup: this.sessionBackupState,
    });
  }

  private async initializeSessionBackup() {
    const userHome = this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;

    try {
      this.sessionBackup = await this.sessionBackupFactory({
        sessionId: this.id,
        workingDirectory: this.config.workingDirectory,
        homedir: userHome,
      });
      this.sessionBackupState = this.sessionBackup.getPublicState();
    } catch (err) {
      const reason = `session backup initialization failed: ${String(err)}`;
      this.sessionBackup = null;
      this.sessionBackupState = {
        ...this.sessionBackupState,
        status: "failed",
        failureReason: reason,
        originalSnapshot: { kind: "pending" },
      };
    }
  }

  private async takeAutomaticSessionCheckpoint() {
    if (!this.sessionBackup) return;
    try {
      await this.sessionBackup.createCheckpoint("auto");
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("auto_checkpoint");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `automatic checkpoint failed: ${String(err)}` });
    }
  }

  private async closeSessionBackup() {
    await this.sessionBackupInit;
    if (!this.sessionBackup) return;
    try {
      await this.sessionBackup.close();
      this.sessionBackupState = this.sessionBackup.getPublicState();
    } catch {
      // best-effort close
    }
  }
}
