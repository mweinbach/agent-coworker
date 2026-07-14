import type { MCPRegistryServer } from "../../mcp/configRegistry";
import type { ServerErrorCode, ServerErrorData, ServerErrorSource } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import { resolveCoworkHomedir } from "../../utils/coworkHome";
import type { SessionEvent } from "../protocol";
import type { McpServerLookup } from "./mcp/McpServerLookup";
import type { SessionDependencies, SessionRuntimeState } from "./SessionContext";

type PromptBucket<T> = Map<string, PromiseWithResolvers<T>>;

export class SessionRuntimeSupport {
  constructor(
    private readonly opts: {
      sessionId: string;
      state: SessionRuntimeState;
      deps: SessionDependencies;
      emit: (evt: SessionEvent) => void;
      emitObservabilityStatusChanged: () => void;
    },
  ) {}

  emitError(
    code: ServerErrorCode,
    source: ServerErrorSource,
    message: string,
    data?: ServerErrorData,
  ) {
    this.opts.emit({
      type: "error",
      sessionId: this.opts.sessionId,
      message,
      code,
      source,
      ...(data ? { data } : {}),
    });
  }

  guardBusy(): boolean {
    if (this.opts.state.running) {
      this.emitError("busy", "session", "Agent is busy");
      return false;
    }
    if (this.opts.state.connecting) {
      this.emitError("busy", "session", "Connection flow already running");
      return false;
    }
    return true;
  }

  formatError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
  }

  log(line: string) {
    this.opts.emit({ type: "log", sessionId: this.opts.sessionId, line });
  }

  emitTelemetry(
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number,
  ) {
    void (async () => {
      const emitObservabilityEvent =
        this.opts.deps.emitObservabilityEventImpl ??
        (await import("../../observability/otel")).emitObservabilityEvent;
      const result = await emitObservabilityEvent(this.opts.state.config, {
        name,
        at: new Date().toISOString(),
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        attributes,
      });

      if (result.healthChanged) {
        this.opts.emitObservabilityStatusChanged();
      }
    })().catch(() => {
      // observability is best-effort; never fail core session flow
    });
  }

  getCoworkPaths() {
    return this.opts.deps.getAiCoworkerPathsImpl({ homedir: this.getUserHomeDir() });
  }

  getGlobalAuthPaths() {
    return this.opts.deps.getAiCoworkerPathsImpl({
      homedir: resolveAuthHomeDir(this.opts.state.config),
    });
  }

  async runProviderConnect(opts: Parameters<SessionDependencies["connectProviderImpl"]>[0]) {
    // Provider auth is user-global; never redirect it into a workspace-local
    // `.cowork` tree.
    const paths = opts.paths ?? this.getGlobalAuthPaths();
    return await this.opts.deps.connectProviderImpl({
      ...opts,
      cwd: opts.cwd ?? this.opts.state.config.workingDirectory,
      paths,
      oauthStdioMode: opts.oauthStdioMode ?? "pipe",
    });
  }

  async getMcpServerByName(
    nameRaw: string,
    lookup: McpServerLookup = {},
  ): Promise<MCPRegistryServer | null> {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "MCP server name is required");
      return null;
    }

    const { loadMCPConfigRegistry } = await import("../../mcp/configRegistry");
    const registry = await loadMCPConfigRegistry(this.opts.state.config);
    const pluginId = lookup.pluginId?.trim();
    const server =
      registry.servers.find(
        (entry) =>
          entry.name === name &&
          (lookup.source === undefined || entry.source === lookup.source) &&
          (!pluginId || entry.pluginId === pluginId) &&
          (!lookup.pluginScope || entry.pluginScope === lookup.pluginScope),
      ) ?? null;
    if (!server) {
      const sourceDetail = lookup.source ? ` from ${lookup.source}` : "";
      const pluginDetail =
        pluginId || lookup.pluginScope
          ? ` (${[
              pluginId ? `pluginId=${pluginId}` : null,
              lookup.pluginScope ? `pluginScope=${lookup.pluginScope}` : null,
            ]
              .filter(Boolean)
              .join(", ")})`
          : "";
      this.emitError(
        "validation_failed",
        "session",
        `MCP server "${name}"${sourceDetail}${pluginDetail} not found.`,
      );
      return null;
    }
    return server;
  }

  waitForPromptResponse<T>(requestId: string, bucket: PromptBucket<T>): Promise<T> {
    const entry = bucket.get(requestId);
    if (!entry) return Promise.reject(new Error(`Unknown prompt request: ${requestId}`));
    return entry.promise;
  }

  private getUserHomeDir(): string | undefined {
    return resolveCoworkHomedir(this.opts.state.config.userCoworkDir);
  }
}
