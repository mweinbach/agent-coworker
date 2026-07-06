import { loadMCPServerForValidation, loadMCPTools } from "../../../mcp";
import { resolveMCPServerAuthState } from "../../../mcp/authStore";
import type { MCPServerSource } from "../../../mcp/configRegistry";
import { captureProductEvent } from "../../../telemetry/productAnalytics";
import type { SessionContext } from "../SessionContext";
import type { McpServerLookup } from "./McpServerLookup";
import type { McpServerResolver } from "./McpServerResolver";

const MCP_VALIDATION_TIMEOUT_MS = 10_000;

export class McpValidationFlow {
  constructor(
    private readonly context: SessionContext,
    private readonly resolver: McpServerResolver,
  ) {}

  async validate(nameRaw: string, lookup?: McpServerLookup | MCPServerSource) {
    const name = nameRaw.trim();
    const validationStartedAt = Date.now();
    if (!name) {
      this.context.emitError("validation_failed", "session", "MCP server name is required");
      return;
    }
    if (!this.context.guardBusy()) return;

    this.context.state.connecting = true;
    try {
      const server = await this.resolver.resolveByName(name, lookup);
      if (!server) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name,
          ok: false,
          mode: "error",
          message: `MCP server "${name}" not found.`,
        });
        this.captureValidationFailed(validationStartedAt, "not_found");
        return;
      }

      const authState = await resolveMCPServerAuthState(this.context.state.config, server);
      if (
        authState.mode === "missing" ||
        authState.mode === "oauth_pending" ||
        authState.mode === "error"
      ) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: authState.message,
        });
        this.captureValidationFailed(validationStartedAt, authState.mode);
        return;
      }

      // Validation is an explicit, user-initiated request to test THIS server, so
      // it is allowed to include the workspace's own (otherwise untrusted)
      // servers — this is the per-command approval branch of the trust gate. The
      // automatic turn-setup path does not pass this flag and stays fail-closed.
      const runtimeServer = await loadMCPServerForValidation(this.context.state.config, server);
      if (!runtimeServer) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: "error",
          message: "Server is not active in current MCP layering.",
        });
        this.captureValidationFailed(validationStartedAt, "not_active");
        return;
      }

      const startedAt = Date.now();
      const loadPromise = loadMCPTools([runtimeServer], { log: (line) => this.log(line) });
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
            typeof (toolDef as { description?: unknown })?.description === "string"
              ? (toolDef as { description: string }).description
              : undefined,
        }));

        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
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
            .then(async (loaded) => {
              try {
                await loaded.close();
              } catch {
                // ignore
              }
            })
            .catch(() => {
              // ignore
            });
        }
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: String(err),
          latencyMs: Date.now() - startedAt,
        });
        this.captureValidationFailed(validationStartedAt, timedOut ? "timeout" : "load_exception");
      } finally {
        if (loadTimeout) clearTimeout(loadTimeout);
      }
    } catch (err) {
      this.context.emit({
        type: "mcp_server_validation",
        sessionId: this.context.id,
        name,
        ok: false,
        mode: "error",
        message: String(err),
      });
      this.captureValidationFailed(validationStartedAt, "exception");
    } finally {
      this.context.state.connecting = false;
    }
  }

  private log(line: string) {
    this.context.emit({ type: "log", sessionId: this.context.id, line });
  }

  private captureValidationFailed(startedAt: number, errorCategory: string): void {
    captureProductEvent("mcp_server_validation_failed", {
      eventSource: "server",
      status: "failed",
      errorCategory,
      durationMs: Date.now() - startedAt,
    });
  }
}
