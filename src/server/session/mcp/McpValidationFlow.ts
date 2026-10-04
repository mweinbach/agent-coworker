import { loadMCPServerForValidation, loadMCPTools } from "../../../mcp";
import { resolveMCPServerAuthState } from "../../../mcp/authStore";
import type { MCPServerSource } from "../../../mcp/configRegistry";
import { captureProductEvent } from "../../../telemetry/productAnalytics";
import type { SessionEvent } from "../../protocol";
import type { SessionContext } from "../SessionContext";
import { acquireMcpOperation } from "./McpOperationLock";
import type { McpServerLookup } from "./McpServerLookup";
import type { McpServerResolver } from "./McpServerResolver";

const MCP_VALIDATION_TIMEOUT_MS = 10_000;

export type McpValidationFlowDeps = {
  loadMCPServerForValidation?: typeof loadMCPServerForValidation;
  loadMCPTools?: typeof loadMCPTools;
  resolveMCPServerAuthState?: typeof resolveMCPServerAuthState;
  captureProductEvent?: typeof captureProductEvent;
};

type ValidationEventPayload = Omit<
  Extract<SessionEvent, { type: "mcp_server_validation" }>,
  "type" | "sessionId"
>;

export class McpValidationFlow {
  private readonly deps: Required<McpValidationFlowDeps>;

  constructor(
    private readonly context: SessionContext,
    private readonly resolver: McpServerResolver,
    deps: McpValidationFlowDeps = {},
  ) {
    this.deps = {
      loadMCPServerForValidation,
      loadMCPTools,
      resolveMCPServerAuthState,
      captureProductEvent,
      ...deps,
    };
  }

  async validate(nameRaw: string, lookup?: McpServerLookup | MCPServerSource) {
    const name = nameRaw.trim();
    const validationStartedAt = Date.now();
    if (!name) {
      this.context.emitError("validation_failed", "session", "MCP server name is required");
      return;
    }
    const release = acquireMcpOperation(this.context);
    if (!release) return;
    try {
      const server = await this.resolver.resolveByName(name, lookup);
      if (!server) {
        this.emitValidationFailure(
          { name, mode: "error", message: `MCP server "${name}" not found.` },
          validationStartedAt,
          "not_found",
        );
        return;
      }

      const authState = await this.deps.resolveMCPServerAuthState(
        this.context.state.config,
        server,
      );
      if (
        authState.mode === "missing" ||
        authState.mode === "oauth_pending" ||
        authState.mode === "error"
      ) {
        this.emitValidationFailure(
          { name: server.name, mode: authState.mode, message: authState.message },
          validationStartedAt,
          authState.mode,
        );
        return;
      }

      // Validation is an explicit, user-initiated request to test THIS server, so
      // it is allowed to include the workspace's own (otherwise untrusted)
      // servers — this is the per-command approval branch of the trust gate. The
      // automatic turn-setup path does not pass this flag and stays fail-closed.
      const runtimeServer = await this.deps.loadMCPServerForValidation(
        this.context.state.config,
        server,
      );
      if (!runtimeServer) {
        this.emitValidationFailure(
          {
            name: server.name,
            mode: "error",
            message: "Server is not active in current MCP layering.",
          },
          validationStartedAt,
          "not_active",
        );
        return;
      }

      const startedAt = Date.now();
      const loadPromise = this.deps.loadMCPTools([runtimeServer], {
        log: (line) => this.context.emit({ type: "log", sessionId: this.context.id, line }),
      });
      let loadTimeout: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      try {
        const loaded = await Promise.race([
          loadPromise,
          new Promise<never>((_, reject) => {
            loadTimeout = setTimeout(() => {
              timedOut = true;
              reject(
                new Error(`MCP server validation timed out after ${MCP_VALIDATION_TIMEOUT_MS}ms.`),
              );
            }, MCP_VALIDATION_TIMEOUT_MS);
          }),
        ]);

        const toolCount = Object.keys(loaded.tools).length;
        const latencyMs = Date.now() - startedAt;
        const ok = loaded.errors.length === 0;
        const message = ok
          ? "MCP server validation succeeded."
          : (loaded.errors[0] ?? "MCP server validation failed.");
        const tools = Object.entries(loaded.tools).map(([toolName, toolDef]) => ({
          name: toolName,
          description:
            typeof (toolDef as { description?: unknown }).description === "string"
              ? (toolDef as { description: string }).description
              : undefined,
        }));

        this.emitValidation({
          name: server.name,
          ok,
          mode: authState.mode,
          message,
          toolCount,
          tools,
          latencyMs,
        });
        if (!ok) {
          this.captureValidationFailed(validationStartedAt, "load_failed");
        }
        await loaded.close();
      } catch (err) {
        if (timedOut) {
          void loadPromise
            .then((loaded) => loaded.close())
            .catch(() => {
              // ignore late close errors after timeout
            });
        }
        this.emitValidationFailure(
          {
            name: server.name,
            mode: authState.mode,
            message: String(err),
            latencyMs: Date.now() - startedAt,
          },
          validationStartedAt,
          timedOut ? "timeout" : "load_exception",
        );
      } finally {
        if (loadTimeout) clearTimeout(loadTimeout);
      }
    } catch (err) {
      this.emitValidationFailure(
        { name, mode: "error", message: String(err) },
        validationStartedAt,
        "exception",
      );
    } finally {
      release();
    }
  }

  private emitValidation(payload: ValidationEventPayload) {
    this.context.emit({
      type: "mcp_server_validation",
      sessionId: this.context.id,
      ...payload,
    });
  }

  private emitValidationFailure(
    payload: Omit<ValidationEventPayload, "ok">,
    startedAt: number,
    errorCategory: string,
  ) {
    this.emitValidation({ ...payload, ok: false });
    this.captureValidationFailed(startedAt, errorCategory);
  }

  private captureValidationFailed(startedAt: number, errorCategory: string): void {
    this.deps.captureProductEvent("mcp_server_validation_failed", {
      eventSource: "server",
      status: "failed",
      errorCategory,
      durationMs: Date.now() - startedAt,
    });
  }
}
