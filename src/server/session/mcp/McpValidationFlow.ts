import { loadMCPServers, loadMCPTools } from "../../../mcp";
import { resolveMCPServerAuthState } from "../../../mcp/authStore";
import type { SessionContext } from "../SessionContext";
import { McpServerResolver } from "./McpServerResolver";

const MCP_VALIDATION_TIMEOUT_MS = 3_000;

export class McpValidationFlow {
  constructor(
    private readonly context: SessionContext,
    private readonly resolver: McpServerResolver,
  ) {}

  async validate(nameRaw: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.context.emitError("validation_failed", "session", "MCP server name is required");
      return;
    }
    if (!this.context.guardBusy()) return;

    this.context.state.connecting = true;
    try {
      const server = await this.resolver.resolveByName(name);
      if (!server) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name,
          ok: false,
          mode: "error",
          message: `MCP server \"${name}\" not found.`,
        });
        return;
      }

      const authState = await resolveMCPServerAuthState(this.context.state.config, server);
      if (authState.mode === "missing" || authState.mode === "oauth_pending" || authState.mode === "error") {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: authState.message,
        });
        return;
      }

      const runtimeServers = await loadMCPServers(this.context.state.config);
      const runtimeServer = runtimeServers.find((entry) => entry.name === server.name);
      if (!runtimeServer) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: "error",
          message: "Server is not active in current MCP layering.",
        });
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
              reject(new Error(`MCP server validation timed out after ${MCP_VALIDATION_TIMEOUT_MS}ms.`));
            }, MCP_VALIDATION_TIMEOUT_MS);
          }),
        ]);

        const toolCount = Object.keys(loaded.tools).length;
        const latencyMs = Date.now() - startedAt;
        const ok = loaded.errors.length === 0;
        const message = ok ? "MCP server validation succeeded." : loaded.errors[0] ?? "MCP server validation failed.";
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok,
          mode: authState.mode,
          message,
          toolCount,
          latencyMs,
        });
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
    } finally {
      this.context.state.connecting = false;
    }
  }

  private log(line: string) {
    this.context.emit({ type: "log", sessionId: this.context.id, line });
  }
}
