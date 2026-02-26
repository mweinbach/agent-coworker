import path from "node:path";

import { loadMCPConfigRegistry, type MCPRegistryServer } from "../../mcp/configRegistry";
import { emitObservabilityEvent } from "../../observability/otel";
import type { ServerErrorCode, ServerErrorSource } from "../../types";
import type { ServerEvent } from "../protocol";
import type { SessionDependencies, SessionRuntimeState } from "./SessionContext";

type PromptBucket<T> = Map<string, PromiseWithResolvers<T>>;

export class SessionRuntimeSupport {
  constructor(
    private readonly opts: {
      sessionId: string;
      state: SessionRuntimeState;
      deps: SessionDependencies;
      emit: (evt: ServerEvent) => void;
      emitObservabilityStatusChanged: () => void;
    }
  ) {}

  emitError(code: ServerErrorCode, source: ServerErrorSource, message: string) {
    this.opts.emit({
      type: "error",
      sessionId: this.opts.sessionId,
      message,
      code,
      source,
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
    durationMs?: number
  ) {
    void (async () => {
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

  async runProviderConnect(opts: Parameters<SessionDependencies["connectProviderImpl"]>[0]) {
    const paths = opts.paths ?? this.getCoworkPaths();
    return await this.opts.deps.connectProviderImpl({
      ...opts,
      cwd: opts.cwd ?? this.opts.state.config.workingDirectory,
      paths,
      oauthStdioMode: opts.oauthStdioMode ?? "pipe",
    });
  }

  async getMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "MCP server name is required");
      return null;
    }

    const registry = await loadMCPConfigRegistry(this.opts.state.config);
    const server = registry.servers.find((entry) => entry.name === name) ?? null;
    if (!server) {
      this.emitError("validation_failed", "session", `MCP server \"${name}\" not found.`);
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
    return this.opts.state.config.userAgentDir ? path.dirname(this.opts.state.config.userAgentDir) : undefined;
  }
}
