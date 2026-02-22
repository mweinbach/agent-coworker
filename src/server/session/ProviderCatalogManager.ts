import { listProviderAuthMethods } from "../../providers/authRegistry";
import type { getAiCoworkerPaths } from "../../connect";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { getProviderStatuses } from "../../providerStatus";
import type { ServerErrorCode, ServerErrorSource } from "../../types";
import type { ServerEvent } from "../protocol";

export class ProviderCatalogManager {
  private refreshingProviderStatus = false;

  constructor(
    private readonly opts: {
      sessionId: string;
      getConfig: () => { provider: string; model: string };
      getCoworkPaths: () => ReturnType<typeof getAiCoworkerPaths>;
      getProviderCatalog: typeof getProviderCatalog;
      getProviderStatuses: typeof getProviderStatuses;
      emit: (evt: ServerEvent) => void;
      emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
      emitTelemetry: (
        name: string,
        status: "ok" | "error",
        attributes?: Record<string, string | number | boolean>,
        durationMs?: number
      ) => void;
      formatError: (err: unknown) => string;
    }
  ) {}

  async emitProviderCatalog() {
    try {
      const payload = await this.opts.getProviderCatalog({ paths: this.opts.getCoworkPaths() });
      const cfg = this.opts.getConfig();
      const defaults = { ...payload.default, [cfg.provider]: cfg.model };
      this.opts.emit({
        type: "provider_catalog",
        sessionId: this.opts.sessionId,
        all: payload.all,
        default: defaults,
        connected: payload.connected,
      });
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Failed to load provider catalog: ${String(err)}`);
    }
  }

  emitProviderAuthMethods() {
    try {
      this.opts.emit({
        type: "provider_auth_methods",
        sessionId: this.opts.sessionId,
        methods: listProviderAuthMethods(),
      });
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Failed to load provider auth methods: ${String(err)}`);
    }
  }

  async refreshProviderStatus() {
    if (this.refreshingProviderStatus) return;
    this.refreshingProviderStatus = true;
    const startedAt = Date.now();
    try {
      const paths = this.opts.getCoworkPaths();
      const providers = await this.opts.getProviderStatuses({ paths });
      this.opts.emit({ type: "provider_status", sessionId: this.opts.sessionId, providers });
      this.opts.emitTelemetry(
        "provider.status.refresh",
        "ok",
        { sessionId: this.opts.sessionId, providers: providers.length },
        Date.now() - startedAt
      );
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Failed to refresh provider status: ${String(err)}`);
      this.opts.emitTelemetry(
        "provider.status.refresh",
        "error",
        { sessionId: this.opts.sessionId, error: this.opts.formatError(err) },
        Date.now() - startedAt
      );
    } finally {
      this.refreshingProviderStatus = false;
    }
  }
}
