import { loadConfig } from "../../config";
import { pickEditableOpenAiCompatibleProviderOptions } from "../../shared/openaiCompatibleOptions";
import { effectiveToolOutputOverflowChars } from "../../shared/toolOutputOverflow";
import type { AgentConfig } from "../../types";
import { mergeRuntimeProviderOptions, resolveWorkspaceA2ui } from "./ConfigPatchStore";
import type { SessionRegistry } from "./SessionRegistry";
import type { SocketSendQueue } from "./SocketSendQueue";
import type { SessionEvent } from "../protocol";
import type { AgentSession } from "../session/AgentSession";
import type { SessionBinding, StartServerSocket } from "../startServer/types";

type WorkspaceControlRefreshEvent = Extract<
  SessionEvent,
  { type: "skills_list" | "skills_catalog" | "plugins_catalog" | "mcp_servers" }
>;

export class WorkspaceControl {
  private readonly stateIds = new Map<string, string>();
  private readonly subscribers = new Map<string, Map<string, StartServerSocket>>();

  constructor(
    private readonly options: {
      env: Record<string, string | undefined>;
      builtInDir?: string;
      homedir?: string;
      yolo?: boolean;
      runtimeProviderOptions?: Record<string, unknown>;
      fallbackWorkingDirectory: string;
      registry: SessionRegistry;
      socketSendQueue: SocketSendQueue;
    },
  ) {}

  registerSubscriber(ws: StartServerSocket, cwd: string): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return;
    }
    for (const [registeredCwd, subscribers] of this.subscribers) {
      if (registeredCwd === cwd) {
        continue;
      }
      subscribers.delete(connectionId);
      if (subscribers.size === 0) {
        this.subscribers.delete(registeredCwd);
        this.stateIds.delete(registeredCwd);
      }
    }
    const subscribers = this.subscribers.get(cwd) ?? new Map<string, StartServerSocket>();
    subscribers.set(connectionId, ws);
    this.subscribers.set(cwd, subscribers);
  }

  removeSubscriber(ws: StartServerSocket): void {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return;
    }
    for (const [cwd, subscribers] of this.subscribers) {
      subscribers.delete(connectionId);
      if (subscribers.size === 0) {
        this.subscribers.delete(cwd);
        this.stateIds.delete(cwd);
      }
    }
  }

  clearSubscribers(): void {
    this.subscribers.clear();
  }

  async getOrCreateBinding(cwd: string): Promise<SessionBinding> {
    return this.options.registry.createWorkspaceControlBinding(await this.loadConfig(cwd));
  }

  async withSession<T>(
    cwd: string,
    runner: (binding: SessionBinding, session: AgentSession) => Promise<T>,
  ): Promise<T> {
    const binding = await this.getOrCreateBinding(cwd);
    if (!binding.session) {
      throw new Error(`Unable to create workspace control session for ${cwd}`);
    }
    try {
      return await runner(binding, binding.session);
    } finally {
      this.options.registry.disposeBinding(
        binding,
        `workspace control request completed for ${cwd}`,
      );
    }
  }

  async readState(cwd: string): Promise<SessionEvent[]> {
    return this.buildStateEventsFromConfig(await this.loadConfig(cwd));
  }

  async emitRefreshNotifications({
    workingDirectory,
    allWorkspaces = false,
  }: {
    workingDirectory: string;
    allWorkspaces?: boolean;
  }): Promise<void> {
    const targetWorkspaces = allWorkspaces ? [...this.subscribers.keys()] : [workingDirectory];
    for (const cwd of targetWorkspaces) {
      const events = await this.readRefreshEvents(cwd);
      for (const event of events) {
        this.notifySubscribers(cwd, event);
      }
    }
  }

  private getOrCreateStateId(cwd: string): string {
    const existing = this.stateIds.get(cwd);
    if (existing) {
      return existing;
    }
    const created = `jsonrpc-control:${crypto.randomUUID()}`;
    this.stateIds.set(cwd, created);
    return created;
  }

  private async loadConfig(cwd: string): Promise<AgentConfig> {
    const nextConfig = await loadConfig({
      cwd,
      env: {
        ...this.options.env,
        AGENT_WORKING_DIR: cwd,
      },
      homedir: this.options.homedir,
      builtInDir: this.options.builtInDir,
    });
    const providerOptions = mergeRuntimeProviderOptions(
      this.options.runtimeProviderOptions,
      nextConfig.providerOptions,
    );
    if (providerOptions) {
      nextConfig.providerOptions = providerOptions;
    }
    return nextConfig;
  }

  private buildStateEventsFromConfig(controlConfig: AgentConfig): SessionEvent[] {
    const sessionId = this.getOrCreateStateId(controlConfig.workingDirectory);
    const providerOptions = pickEditableOpenAiCompatibleProviderOptions(
      controlConfig.providerOptions,
    );
    const defaultBackupsEnabled = controlConfig.backupsEnabled ?? true;
    const defaultToolOutputOverflowChars =
      controlConfig.projectConfigOverrides?.toolOutputOverflowChars;
    const toolOutputOverflowChars = effectiveToolOutputOverflowChars(
      controlConfig.toolOutputOverflowChars,
    );
    const workspaceA2ui = resolveWorkspaceA2ui(controlConfig);
    const preferredChildModelRef =
      controlConfig.preferredChildModelRef ??
      `${controlConfig.provider}:${controlConfig.preferredChildModel}`;

    return [
      {
        type: "config_updated",
        sessionId,
        config: {
          provider: controlConfig.provider,
          model: controlConfig.model,
          workingDirectory: controlConfig.workingDirectory,
          ...(controlConfig.outputDirectory
            ? { outputDirectory: controlConfig.outputDirectory }
            : {}),
        },
      },
      {
        type: "session_settings",
        sessionId,
        enableMcp: controlConfig.enableMcp ?? false,
        enableMemory: controlConfig.enableMemory ?? true,
        memoryRequireApproval: controlConfig.memoryRequireApproval ?? false,
      },
      {
        type: "session_config",
        sessionId,
        config: {
          yolo: this.options.yolo === true,
          observabilityEnabled: controlConfig.observabilityEnabled ?? false,
          backupsEnabled: defaultBackupsEnabled,
          defaultBackupsEnabled,
          enableA2ui: workspaceA2ui,
          enableMemory: controlConfig.enableMemory ?? true,
          memoryRequireApproval: controlConfig.memoryRequireApproval ?? false,
          preferredChildModel: controlConfig.preferredChildModel,
          childModelRoutingMode: controlConfig.childModelRoutingMode ?? "same-provider",
          preferredChildModelRef,
          allowedChildModelRefs: controlConfig.allowedChildModelRefs ?? [],
          maxSteps: 100,
          toolOutputOverflowChars,
          ...(defaultToolOutputOverflowChars !== undefined
            ? { defaultToolOutputOverflowChars }
            : {}),
          ...(providerOptions ? { providerOptions } : {}),
          userName: controlConfig.userName,
          userProfile: {
            instructions: controlConfig.userProfile?.instructions ?? "",
            work: controlConfig.userProfile?.work ?? "",
            details: controlConfig.userProfile?.details ?? "",
          },
          featureFlags: {
            workspace: {
              a2ui: workspaceA2ui,
            },
          },
        },
      },
    ];
  }

  private notifySubscribers(cwd: string, event: WorkspaceControlRefreshEvent): void {
    const subscribers = this.subscribers.get(cwd);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    for (const ws of subscribers.values()) {
      if (!this.options.socketSendQueue.shouldSendNotification(ws, "cowork/control/event")) {
        continue;
      }
      this.options.socketSendQueue.send(ws, {
        method: "cowork/control/event",
        params: {
          cwd,
          ...event,
        },
      });
    }
  }

  private async readRefreshEvents(cwd: string): Promise<WorkspaceControlRefreshEvent[]> {
    const subscribers = this.subscribers.get(cwd);
    if (!subscribers || subscribers.size === 0) {
      return [];
    }
    const binding = await this.getOrCreateBinding(cwd);
    if (!binding.session) {
      return [];
    }
    const captureRefreshEvent = async <T extends SessionEvent>(
      action: () => Promise<void>,
      predicate: (event: SessionEvent) => event is T,
    ): Promise<T | null> => {
      try {
        return await this.options.registry.sessionEventCapture.capture(binding, action, predicate);
      } catch {
        return null;
      }
    };
    try {
      const session = binding.session;
      const events = [
        await captureRefreshEvent(
          async () => await session.listSkills(),
          (event): event is Extract<SessionEvent, { type: "skills_list" }> =>
            event.type === "skills_list",
        ),
        await captureRefreshEvent(
          async () => await session.getSkillsCatalog(),
          (event): event is Extract<SessionEvent, { type: "skills_catalog" }> =>
            event.type === "skills_catalog",
        ),
        await captureRefreshEvent(
          async () => await session.getPluginsCatalog(),
          (event): event is Extract<SessionEvent, { type: "plugins_catalog" }> =>
            event.type === "plugins_catalog",
        ),
        await captureRefreshEvent(
          async () => await session.emitMcpServers(),
          (event): event is Extract<SessionEvent, { type: "mcp_servers" }> =>
            event.type === "mcp_servers",
        ),
      ];
      return events.filter((event): event is WorkspaceControlRefreshEvent => event !== null);
    } finally {
      this.options.registry.disposeBinding(
        binding,
        `workspace control refresh capture completed for ${cwd}`,
      );
    }
  }
}
