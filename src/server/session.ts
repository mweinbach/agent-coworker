import type { ModelMessage } from "ai";
import fs from "node:fs/promises";
import path from "node:path";

import { connectProvider as connectModelProvider, getAiCoworkerPaths, type ConnectProviderResult } from "../connect";
import {
  authorizeProviderAuth,
  callbackProviderAuth as callbackProviderAuthMethod,
  listProviderAuthMethods,
  resolveProviderAuthMethod,
  setProviderApiKey as setProviderApiKeyMethod,
} from "../providers/authRegistry";
import { getProviderCatalog } from "../providers/connectionCatalog";
import { getProviderStatuses } from "../providerStatus";
import { discoverSkills, stripSkillFrontMatter } from "../skills";
import { isProviderName } from "../types";
import type {
  AgentConfig,
  HarnessContextPayload,
  ServerErrorCode,
  ServerErrorSource,
  TodoItem,
} from "../types";
import { runTurn } from "../agent";
import { loadSystemPromptWithSkills } from "../prompt";
import { createTools } from "../tools";
import { classifyCommandDetailed } from "../utils/approval";
import { HarnessContextStore } from "../harness/contextStore";
import { emitObservabilityEvent } from "../observability/otel";
import { expandCommandTemplate, listCommands as listServerCommands, resolveCommand } from "./commands";
import { normalizeModelStreamPart, reasoningModeForProvider } from "./modelStream";

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
const ASK_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const AUTO_CHECKPOINT_MIN_INTERVAL_MS = 30_000;

export class AgentSession {
  readonly id: string;

  private config: AgentConfig;
  private system: string;
  private discoveredSkills: Array<{ name: string; description: string }>;
  private readonly yolo: boolean;
  private readonly emit: (evt: ServerEvent) => void;
  private readonly connectProviderImpl: typeof connectModelProvider;
  private readonly getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  private readonly getProviderCatalogImpl: typeof getProviderCatalog;
  private readonly getProviderStatusesImpl: typeof getProviderStatuses;
  private readonly sessionBackupFactory: SessionBackupFactory;
  private readonly harnessContextStore: HarnessContextStore;
  private readonly runTurnImpl: typeof runTurn;

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
  private sessionBackupInit: Promise<void> | null = null;
  private backupOperationQueue: Promise<void> = Promise.resolve();
  private lastAutoCheckpointAt = 0;

  constructor(opts: {
    config: AgentConfig;
    system: string;
    discoveredSkills?: Array<{ name: string; description: string }>;
    yolo?: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl?: typeof connectModelProvider;
    getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
    getProviderCatalogImpl?: typeof getProviderCatalog;
    getProviderStatusesImpl?: typeof getProviderStatuses;
    sessionBackupFactory?: SessionBackupFactory;
    harnessContextStore?: HarnessContextStore;
    runTurnImpl?: typeof runTurn;
  }) {
    this.id = makeId();
    this.config = opts.config;
    this.system = opts.system;
    this.discoveredSkills = opts.discoveredSkills ?? [];
    this.yolo = opts.yolo === true;
    this.emit = opts.emit;
    this.connectProviderImpl = opts.connectProviderImpl ?? connectModelProvider;
    this.getAiCoworkerPathsImpl = opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths;
    this.getProviderCatalogImpl = opts.getProviderCatalogImpl ?? getProviderCatalog;
    this.getProviderStatusesImpl = opts.getProviderStatusesImpl ?? getProviderStatuses;
    this.sessionBackupFactory =
      opts.sessionBackupFactory ?? (async (factoryOpts) => await SessionBackupManager.create(factoryOpts));
    this.harnessContextStore = opts.harnessContextStore ?? new HarnessContextStore();
    this.runTurnImpl = opts.runTurnImpl ?? runTurn;
    this.sessionBackupState = {
      status: "initializing",
      sessionId: this.id,
      workingDirectory: this.config.workingDirectory,
      backupDirectory: null,
      createdAt: new Date().toISOString(),
      originalSnapshot: { kind: "pending" },
      checkpoints: [],
    };
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
    const observability = this.config.observability;
    const config = observability
      ? {
          provider: observability.provider,
          baseUrl: observability.baseUrl,
          otelEndpoint: observability.otelEndpoint,
          ...(observability.tracingEnvironment ? { tracingEnvironment: observability.tracingEnvironment } : {}),
          ...(observability.release ? { release: observability.release } : {}),
          hasPublicKey: !!observability.publicKey,
          hasSecretKey: !!observability.secretKey,
          configured: !!observability.publicKey && !!observability.secretKey,
        }
      : null;

    return {
      type: "observability_status",
      sessionId: this.id,
      enabled: this.config.observabilityEnabled ?? false,
      config,
    };
  }

  private getUserHomeDir(): string | undefined {
    return this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;
  }

  private getCoworkPaths() {
    return this.getAiCoworkerPathsImpl({ homedir: this.getUserHomeDir() });
  }

  private async runProviderConnect(opts: {
    provider: AgentConfig["provider"];
    methodId?: string;
    apiKey?: string;
    onOauthLine?: (line: string) => void;
  }): Promise<ConnectProviderResult> {
    const paths = this.getCoworkPaths();
    return await this.connectProviderImpl({
      provider: opts.provider,
      methodId: opts.methodId,
      apiKey: opts.apiKey,
      cwd: this.config.workingDirectory,
      paths,
      oauthStdioMode: "pipe",
      onOauthLine: opts.onOauthLine,
    });
  }

  private emitError(code: ServerErrorCode, source: ServerErrorSource, message: string) {
    this.emit({
      type: "error",
      sessionId: this.id,
      message,
      code,
      source,
    });
  }

  private classifyTurnError(err: unknown): { code: ServerErrorCode; source: ServerErrorSource } {
    const message = this.formatErrorMessage(err);
    const m = message.toLowerCase();
    const includesAny = (...needles: string[]) => needles.some((needle) => m.includes(needle));

    if (
      includesAny(
        "blocked: path is outside",
        "blocked: canonical target resolves outside",
        "outside allowed directories",
        "outside allowed roots",
        "blocked private/internal host",
        "blocked url protocol",
        "blocked url credentials",
        "glob blocked:"
      )
    ) {
      return { code: "permission_denied", source: "permissions" };
    }

    if (includesAny("observability", "traceql", "promql", "logql")) {
      return { code: "observability_error", source: "observability" };
    }

    if (includesAny("oauth", "api key", "unsupported provider")) {
      return { code: "provider_error", source: "provider" };
    }

    if (m.includes("unknown checkpoint id")) {
      return { code: "validation_failed", source: "session" };
    }

    if (includesAny("checkpoint", "session backup")) {
      return { code: "backup_error", source: "backup" };
    }

    if (includesAny("is required", "invalid ")) {
      return { code: "validation_failed", source: "session" };
    }

    return { code: "internal_error", source: "session" };
  }

  private isAbortLikeError(err: unknown): boolean {
    if (this.abortController?.signal.aborted) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true;

    const code = typeof err === "object" && err ? (err as { code?: unknown }).code : undefined;
    if (code === "ABORT_ERR") return true;

    const msg = this.formatErrorMessage(err).toLowerCase();
    return msg.includes("abort") || msg.includes("cancel");
  }

  private emitTelemetry(name: string, status: "ok" | "error", attributes?: Record<string, string | number | boolean>, durationMs?: number) {
    void emitObservabilityEvent(this.config, {
      name,
      at: new Date().toISOString(),
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
      attributes,
    });
  }

  reset() {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
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

  async listCommands() {
    try {
      const commands = await listServerCommands(this.config);
      this.emit({ type: "commands", sessionId: this.id, commands });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to list commands: ${String(err)}`);
    }
  }

  async executeCommand(nameRaw: string, argumentsText = "", clientMessageId?: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "Command name is required");
      return;
    }

    const resolved = await resolveCommand(this.config, name);
    if (!resolved) {
      this.emitError("validation_failed", "session", `Unknown command: ${name}`);
      return;
    }

    const expanded = expandCommandTemplate(resolved.template, argumentsText);
    if (!expanded.trim()) {
      this.emitError("validation_failed", "session", `Command "${name}" expanded to empty prompt`);
      return;
    }

    const trimmedArgs = argumentsText.trim();
    const slashText = `/${resolved.name}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
    await this.sendUserMessage(expanded, clientMessageId, slashText);
  }

  async listSkills() {
    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      this.emit({ type: "skills_list", sessionId: this.id, skills });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to list skills: ${String(err)}`);
    }
  }

  async readSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }

      const content = await fs.readFile(skill.path, "utf-8");
      this.emit({ type: "skill_content", sessionId: this.id, skill, content: stripSkillFrontMatter(content) });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to read skill: ${String(err)}`);
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
    await this.listCommands();
  }

  async disableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.emitError("validation_failed", "session", "Global skills directory is not configured.");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.emitError("validation_failed", "session", "Only global skills can be disabled in v1.");
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
      this.emitError("internal_error", "session", `Failed to disable skill: ${String(err)}`);
    }
  }

  async enableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.emitError("validation_failed", "session", "Global skills directory is not configured.");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.emitError("validation_failed", "session", "Only global skills can be enabled in v1.");
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
      this.emitError("internal_error", "session", `Failed to enable skill: ${String(err)}`);
    }
  }

  async deleteSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.emitError("validation_failed", "session", "Only global skills can be deleted in v1.");
        return;
      }

      // Delete the containing directory (skill.path points at SKILL.md).
      const skillDir = path.dirname(skill.path);
      await fs.rm(skillDir, { recursive: true, force: true });
      await this.refreshSkillsList();
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to delete skill: ${String(err)}`);
    }
  }

  setEnableMcp(enableMcp: boolean) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
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
    this.emitTelemetry("harness.context.set", "ok", {
      sessionId: this.id,
      runId: context.runId,
      objectiveLength: context.objective.length,
    });
  }

  private formatErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    const modelId = modelIdRaw.trim();
    if (!modelId) {
      this.emitError("validation_failed", "session", "Model id is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const nextProvider =
      providerRaw === undefined
        ? this.config.provider
        : isProviderName(providerRaw)
          ? providerRaw
          : null;
    if (!nextProvider) {
      this.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
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
      this.emitError("internal_error", "session", `Model updated but failed to refresh prompt: ${String(err)}`);
    }

    this.emit({
      type: "config_updated",
      sessionId: this.id,
      config: this.getPublicConfig(),
    });
  }

  async emitProviderCatalog() {
    try {
      const payload = await this.getProviderCatalogImpl({ paths: this.getCoworkPaths() });
      this.emit({
        type: "provider_catalog",
        sessionId: this.id,
        all: payload.all,
        default: payload.default,
        connected: payload.connected,
      });
    } catch (err) {
      this.emitError("provider_error", "provider", `Failed to load provider catalog: ${String(err)}`);
    }
  }

  emitProviderAuthMethods() {
    try {
      this.emit({
        type: "provider_auth_methods",
        sessionId: this.id,
        methods: listProviderAuthMethods(),
      });
    } catch (err) {
      this.emitError("provider_error", "provider", `Failed to load provider auth methods: ${String(err)}`);
    }
  }

  async authorizeProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }
    if (!isProviderName(providerRaw)) {
      this.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    const methodId = methodIdRaw.trim();
    if (!methodId) {
      this.emitError("validation_failed", "provider", "Auth method id is required");
      return;
    }
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    const result = authorizeProviderAuth({ provider: providerRaw, methodId });
    if (!result.ok) {
      this.emitError("provider_error", "provider", result.message);
      this.emitTelemetry("provider.auth.authorize", "error", {
        sessionId: this.id,
        provider: providerRaw,
        methodId,
        error: result.message,
      });
      return;
    }
    this.emit({
      type: "provider_auth_challenge",
      sessionId: this.id,
      provider: providerRaw,
      methodId,
      challenge: result.challenge,
    });
    this.emitTelemetry("provider.auth.authorize", "ok", {
      sessionId: this.id,
      provider: providerRaw,
      methodId,
    });
  }

  async callbackProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string, codeRaw?: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }
    if (this.connecting) {
      this.emitError("busy", "session", "Connection flow already running");
      return;
    }
    if (!isProviderName(providerRaw)) {
      this.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    const methodId = methodIdRaw.trim();
    if (!methodId) {
      this.emitError("validation_failed", "provider", "Auth method id is required");
      return;
    }
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    this.connecting = true;
    const startedAt = Date.now();
    try {
      const code = codeRaw?.trim() ? codeRaw.trim() : undefined;
      const result = await callbackProviderAuthMethod({
        provider: providerRaw,
        methodId,
        code,
        cwd: this.config.workingDirectory,
        paths: this.getCoworkPaths(),
        connect: async (opts) => await this.runProviderConnect(opts),
        oauthStdioMode: "pipe",
        onOauthLine: (line) => this.log(`[connect ${providerRaw}] ${line}`),
      });

      this.emit({
        type: "provider_auth_result",
        sessionId: this.id,
        provider: providerRaw,
        methodId,
        ok: result.ok,
        mode: result.ok ? result.mode : undefined,
        message: result.message,
      });

      if (result.ok) {
        await this.refreshProviderStatus();
        await this.emitProviderCatalog();
      }
      this.emitTelemetry(
        "provider.auth.callback",
        result.ok ? "ok" : "error",
        {
          sessionId: this.id,
          provider: providerRaw,
          methodId,
          mode: result.mode ?? "unknown",
        },
        Date.now() - startedAt
      );
    } catch (err) {
      this.emitError("provider_error", "provider", `Provider auth callback failed: ${String(err)}`);
      this.emitTelemetry(
        "provider.auth.callback",
        "error",
        {
          sessionId: this.id,
          provider: providerRaw,
          methodId,
          error: this.formatErrorMessage(err),
        },
        Date.now() - startedAt
      );
    } finally {
      this.connecting = false;
    }
  }

  async setProviderApiKey(providerRaw: AgentConfig["provider"], methodIdRaw: string, apiKeyRaw: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }
    if (this.connecting) {
      this.emitError("busy", "session", "Connection flow already running");
      return;
    }
    if (!isProviderName(providerRaw)) {
      this.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    const methodId = methodIdRaw.trim();
    if (!methodId) {
      this.emitError("validation_failed", "provider", "Auth method id is required");
      return;
    }
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    this.connecting = true;
    const startedAt = Date.now();
    try {
      const result = await setProviderApiKeyMethod({
        provider: providerRaw,
        methodId,
        apiKey: apiKeyRaw,
        cwd: this.config.workingDirectory,
        paths: this.getCoworkPaths(),
        connect: async (opts) => await this.runProviderConnect(opts),
      });

      this.emit({
        type: "provider_auth_result",
        sessionId: this.id,
        provider: providerRaw,
        methodId,
        ok: result.ok,
        mode: result.ok ? result.mode : undefined,
        message: result.message,
      });

      if (result.ok) {
        await this.refreshProviderStatus();
        await this.emitProviderCatalog();
      }
      this.emitTelemetry(
        "provider.auth.api_key",
        result.ok ? "ok" : "error",
        {
          sessionId: this.id,
          provider: providerRaw,
          methodId,
          mode: result.mode ?? "unknown",
        },
        Date.now() - startedAt
      );
    } catch (err) {
      this.emitError("provider_error", "provider", `Setting provider API key failed: ${String(err)}`);
      this.emitTelemetry(
        "provider.auth.api_key",
        "error",
        {
          sessionId: this.id,
          provider: providerRaw,
          methodId,
          error: this.formatErrorMessage(err),
        },
        Date.now() - startedAt
      );
    } finally {
      this.connecting = false;
    }
  }

  async refreshProviderStatus() {
    if (this.refreshingProviderStatus) return;
    this.refreshingProviderStatus = true;
    const startedAt = Date.now();
    try {
      const paths = this.getCoworkPaths();
      const providers = await this.getProviderStatusesImpl({ paths });
      this.emit({ type: "provider_status", sessionId: this.id, providers });
      this.emitTelemetry(
        "provider.status.refresh",
        "ok",
        { sessionId: this.id, providers: providers.length },
        Date.now() - startedAt
      );
    } catch (err) {
      this.emitError("provider_error", "provider", `Failed to refresh provider status: ${String(err)}`);
      this.emitTelemetry(
        "provider.status.refresh",
        "error",
        { sessionId: this.id, error: this.formatErrorMessage(err) },
        Date.now() - startedAt
      );
    } finally {
      this.refreshingProviderStatus = false;
    }
  }

  handleAskResponse(requestId: string, answer: string) {
    const d = this.pendingAsk.get(requestId);
    if (!d) {
      this.log(`[warn] ask_response for unknown requestId: ${requestId}`);
      return;
    }
    this.pendingAsk.delete(requestId);
    d.resolve(answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    const d = this.pendingApproval.get(requestId);
    if (!d) {
      this.log(`[warn] approval_response for unknown requestId: ${requestId}`);
      return;
    }
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

  private waitForPromptResponse<T>(
    requestId: string,
    bucket: Map<string, Deferred<T>>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    const deferredValue = bucket.get(requestId);
    if (!deferredValue) return Promise.reject(new Error(`Unknown prompt request: ${requestId}`));

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        bucket.delete(requestId);
        deferredValue.reject(new Error(timeoutMessage));
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      deferredValue.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private async runInBackupQueue<T>(op: () => Promise<T>): Promise<T> {
    const prior = this.backupOperationQueue;
    let release!: () => void;
    this.backupOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prior.catch(() => {});
    try {
      return await op();
    } finally {
      release();
    }
  }

  private async ensureSessionBackupInitialized() {
    if (!this.sessionBackupInit) {
      this.sessionBackupInit = this.initializeSessionBackup();
    }
    await this.sessionBackupInit;
  }

  private async askUser(question: string, options?: string[]) {
    const requestId = makeId();
    const d = deferred<string>();
    this.pendingAsk.set(requestId, d);

    this.emit({ type: "ask", sessionId: this.id, requestId, question, options });
    return await this.waitForPromptResponse(
      requestId,
      this.pendingAsk,
      ASK_RESPONSE_TIMEOUT_MS,
      "Ask prompt timed out waiting for user response."
    );
  }

  private async approveCommand(command: string) {
    if (this.yolo) return true;

    const classification = classifyCommandDetailed(command, {
      allowedRoots: [
        path.dirname(this.config.projectAgentDir),
        this.config.workingDirectory,
        this.config.outputDirectory,
      ],
    });
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
      reasonCode: classification.riskCode,
    });

    return await this.waitForPromptResponse(
      requestId,
      this.pendingApproval,
      APPROVAL_RESPONSE_TIMEOUT_MS,
      "Command approval timed out waiting for user response."
    );
  }

  private updateTodos = (todos: TodoItem[]) => {
    this.todos = todos;
    this.emit({ type: "todos", sessionId: this.id, todos });
  };

  async getSessionBackupState() {
    await this.ensureSessionBackupInitialized();
    this.emitSessionBackupState("requested");
    this.emitTelemetry("session.backup.state_requested", "ok", { sessionId: this.id });
  }

  async createManualSessionCheckpoint() {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }
    const startedAt = Date.now();
    try {
      const didCheckpoint = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) {
          const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.emitError("backup_error", "backup", reason);
          return false;
        }
        await this.sessionBackup.createCheckpoint("manual");
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("manual_checkpoint");
        return true;
      });
      if (!didCheckpoint) return;
      this.emitTelemetry("session.backup.checkpoint.manual", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      this.emitError("backup_error", "backup", `manual checkpoint failed: ${String(err)}`);
      this.emitTelemetry("session.backup.checkpoint.manual", "error", { sessionId: this.id }, Date.now() - startedAt);
    }
  }

  async restoreSessionBackup(checkpointId?: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const startedAt = Date.now();
    try {
      const didRestore = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) {
          const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.emitError("backup_error", "backup", reason);
          return false;
        }
        if (checkpointId) {
          await this.sessionBackup.restoreCheckpoint(checkpointId);
        } else {
          await this.sessionBackup.restoreOriginal();
        }
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("restore");
        return true;
      });
      if (!didRestore) return;
      this.emitTelemetry("session.backup.restore", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      this.emitError("backup_error", "backup", `restore failed: ${String(err)}`);
      this.emitTelemetry("session.backup.restore", "error", { sessionId: this.id }, Date.now() - startedAt);
    }
  }

  async deleteSessionCheckpoint(checkpointId: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const startedAt = Date.now();
    try {
      const didDelete = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) {
          const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.emitError("backup_error", "backup", reason);
          return false;
        }
        const removed = await this.sessionBackup.deleteCheckpoint(checkpointId);
        if (!removed) {
          this.emitError("validation_failed", "backup", `Unknown checkpoint id: ${checkpointId}`);
          return false;
        }
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("delete");
        return true;
      });
      if (!didDelete) return;
      this.emitTelemetry("session.backup.checkpoint.delete", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      this.emitError("backup_error", "backup", `delete checkpoint failed: ${String(err)}`);
      this.emitTelemetry("session.backup.checkpoint.delete", "error", { sessionId: this.id }, Date.now() - startedAt);
    }
  }

  async sendUserMessage(text: string, clientMessageId?: string, displayText?: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const turnStartedAt = Date.now();
    try {
      this.emit({ type: "user_message", sessionId: this.id, text: displayText ?? text, clientMessageId });
      this.emit({ type: "session_busy", sessionId: this.id, busy: true });
      this.emitTelemetry("agent.turn.started", "ok", {
        sessionId: this.id,
        provider: this.config.provider,
        model: this.config.model,
      });
      this.messages.push({ role: "user", content: text });

      // Trim message history to prevent unbounded memory growth.
      // Keep the first message (initial context) plus the most recent entries.
      if (this.messages.length > MAX_MESSAGE_HISTORY) {
        const first = this.messages[0];
        this.messages = [first, ...this.messages.slice(-(MAX_MESSAGE_HISTORY - 1))];
      }

      const turnId = makeId();
      let streamPartIndex = 0;
      const res = await this.runTurnImpl({
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
        spawnDepth: 0,
        abortSignal: this.abortController.signal,
        includeRawChunks: true,
        onModelError: async (error) => {
          this.emitTelemetry("agent.stream.error", "error", {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
            error: this.formatErrorMessage(error),
          });
        },
        onModelAbort: async () => {
          this.emitTelemetry("agent.stream.aborted", "ok", {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
          });
        },
        onModelStreamPart: async (rawPart) => {
          const normalized = normalizeModelStreamPart(rawPart, {
            provider: this.config.provider,
            includeRawPart: true,
          });
          this.emit({
            type: "model_stream_chunk",
            sessionId: this.id,
            turnId,
            index: streamPartIndex++,
            provider: this.config.provider,
            model: this.config.model,
            partType: normalized.partType,
            part: normalized.part,
            ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
          });
        },
      });

      this.messages.push(...res.responseMessages);

      const reasoning = (res.reasoningText || "").trim();
      if (reasoning) {
        const kind = reasoningModeForProvider(this.config.provider);
        this.emit({ type: "reasoning", sessionId: this.id, kind, text: reasoning });
      }

      const out = (res.text || "").trim();
      if (out) this.emit({ type: "assistant_message", sessionId: this.id, text: out });
      this.emitTelemetry(
        "agent.turn.completed",
        "ok",
        {
          sessionId: this.id,
          provider: this.config.provider,
          model: this.config.model,
        },
        Date.now() - turnStartedAt
      );
    } catch (err) {
      const msg = this.formatErrorMessage(err);
      if (!this.isAbortLikeError(err)) {
        const classified = this.classifyTurnError(err);
        this.emitError(classified.code, classified.source, msg);
        this.emitTelemetry(
          "agent.turn.failed",
          "error",
          {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
            error: msg,
          },
          Date.now() - turnStartedAt
        );
      } else {
        this.emitTelemetry(
          "agent.turn.aborted",
          "ok",
          {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
          },
          Date.now() - turnStartedAt
        );
      }
    } finally {
      this.emit({ type: "session_busy", sessionId: this.id, busy: false });
      this.running = false;
      this.abortController = null;
      // Auto-checkpointing is best-effort and must never block follow-up prompts.
      void this.takeAutomaticSessionCheckpoint().catch(() => {
        // takeAutomaticSessionCheckpoint already emits backup errors/telemetry.
      });
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
    const startedAt = Date.now();

    try {
      this.sessionBackup = await this.sessionBackupFactory({
        sessionId: this.id,
        workingDirectory: this.config.workingDirectory,
        homedir: userHome,
      });
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitTelemetry("session.backup.initialize", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      const reason = `session backup initialization failed: ${String(err)}`;
      this.sessionBackup = null;
      this.sessionBackupState = {
        ...this.sessionBackupState,
        status: "failed",
        failureReason: reason,
        originalSnapshot: { kind: "pending" },
      };
      this.emitTelemetry(
        "session.backup.initialize",
        "error",
        { sessionId: this.id, error: reason },
        Date.now() - startedAt
      );
    }
  }

  private async takeAutomaticSessionCheckpoint() {
    if (Date.now() - this.lastAutoCheckpointAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) return;

    try {
      const didCheckpoint = await this.runInBackupQueue(async () => {
        if (Date.now() - this.lastAutoCheckpointAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) return;
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) return false;
        await this.sessionBackup.createCheckpoint("auto");
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("auto_checkpoint");
        this.lastAutoCheckpointAt = Date.now();
        return true;
      });
      if (!didCheckpoint) return;
    } catch (err) {
      this.emitError("backup_error", "backup", `automatic checkpoint failed: ${String(err)}`);
      this.emitTelemetry("session.backup.checkpoint.auto", "error", {
        sessionId: this.id,
        error: this.formatErrorMessage(err),
      });
      return;
    }

    this.emitTelemetry("session.backup.checkpoint.auto", "ok", { sessionId: this.id });
  }

  private async closeSessionBackup() {
    if (!this.sessionBackupInit) return;
    try {
      await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) return;
        await this.sessionBackup.close();
        this.sessionBackupState = this.sessionBackup.getPublicState();
      });
      this.emitTelemetry("session.backup.close", "ok", { sessionId: this.id });
    } catch {
      // best-effort close
      this.emitTelemetry("session.backup.close", "error", { sessionId: this.id });
    }
  }
}
