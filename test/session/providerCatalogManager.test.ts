import { describe, expect, mock, test } from "bun:test";
import type { ProviderStatus } from "../../src/providerStatus";
import type { ProviderCatalogPayload } from "../../src/providers/connectionCatalog";
import type { SessionEvent } from "../../src/server/protocol";
import { ProviderCatalogManager } from "../../src/server/session/ProviderCatalogManager";
import type { AgentConfig } from "../../src/types";

const SESSION_ID = "session-provider-catalog";

const status = (message: string): ProviderStatus => ({
  provider: "openai",
  authorized: true,
  verified: false,
  mode: "api_key",
  account: null,
  message,
  checkedAt: "2026-09-23T00:00:00.000Z",
});

function createHarness(opts?: {
  getProviderCatalog?: (input: { refresh?: boolean }) => Promise<ProviderCatalogPayload>;
  getProviderStatuses?: (input: { refreshBedrockDiscovery?: boolean }) => Promise<ProviderStatus[]>;
}) {
  const events: SessionEvent[] = [];
  const telemetry: Array<{ name: string; status: "ok" | "error"; error?: string }> = [];
  const paths = { rootDir: "/auth-home" };
  const config = {
    provider: "openai",
    model: "session-model",
    providerOptions: { openai: { baseUrl: "https://example.test" } },
  } as AgentConfig;
  const onCatalogChanged = mock(async () => {});
  const manager = new ProviderCatalogManager({
    sessionId: SESSION_ID,
    getConfig: () => config,
    getGlobalAuthPaths: () => paths as never,
    getProviderCatalog: (opts?.getProviderCatalog ??
      (async () => ({ all: [], default: {}, connected: [] }))) as never,
    getProviderStatuses: (opts?.getProviderStatuses ?? (async () => [])) as never,
    emit: (event) => events.push(event),
    emitError: (code, source, message) =>
      events.push({ type: "error", sessionId: SESSION_ID, code, source, message }),
    emitTelemetry: (name, status, attributes) =>
      telemetry.push({
        name,
        status,
        ...(typeof attributes?.error === "string" ? { error: attributes.error } : {}),
      }),
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
    onCatalogChanged,
  });
  return { manager, events, telemetry, paths, config, onCatalogChanged };
}

describe("ProviderCatalogManager", () => {
  test("keeps the latest catalog, overlays the live session model, and ignores stale catalog failures", async () => {
    const olderOk = Promise.withResolvers<ProviderCatalogPayload>();
    let okCalls = 0;
    const getProviderCatalog = mock(async () => {
      okCalls += 1;
      if (okCalls === 1) return await olderOk.promise;
      return {
        all: [],
        default: { openai: "catalog-default", anthropic: "claude" },
        connected: ["openai"],
      };
    });
    const { manager, events, paths, config, onCatalogChanged } = createHarness({
      getProviderCatalog,
    });

    const first = manager.emitProviderCatalog();
    await manager.emitProviderCatalog({ refresh: true });
    olderOk.resolve({ all: [], default: { openai: "stale" }, connected: ["stale"] });
    await first;

    expect(getProviderCatalog).toHaveBeenLastCalledWith({
      paths,
      providerOptions: config.providerOptions,
      refresh: true,
    });
    expect(events).toEqual([
      {
        type: "provider_catalog",
        sessionId: SESSION_ID,
        all: [],
        default: { openai: "session-model", anthropic: "claude" },
        connected: ["openai"],
      },
    ]);
    expect(onCatalogChanged).toHaveBeenCalledTimes(1);

    const olderFail = Promise.withResolvers<ProviderCatalogPayload>();
    let failCalls = 0;
    const failing = createHarness({
      getProviderCatalog: mock(async () => {
        failCalls += 1;
        if (failCalls === 1) return await olderFail.promise;
        throw new Error("catalog down");
      }),
    });
    const f1 = failing.manager.emitProviderCatalog();
    const f2 = failing.manager.emitProviderCatalog({ refresh: true });
    olderFail.reject(new Error("stale catalog"));
    await Promise.all([f1, f2]);

    expect(failing.events).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "provider_error",
        source: "provider",
        message: "Failed to load provider catalog: Error: catalog down",
      },
    ]);
    expect(failing.onCatalogChanged).not.toHaveBeenCalled();
  });

  test("publishes only the newest coalesced provider status and hides in-flight status failures", async () => {
    const initial = Promise.withResolvers<ProviderStatus[]>();
    const initialStarted = Promise.withResolvers<void>();
    let calls = 0;
    const getProviderStatuses = mock(async () => {
      calls += 1;
      if (calls === 1) {
        initialStarted.resolve();
        return await initial.promise;
      }
      return [status("fresh")];
    });
    const { manager, events, telemetry } = createHarness({ getProviderStatuses });

    const first = manager.refreshProviderStatus();
    await initialStarted.promise;
    const forced = manager.refreshProviderStatus({ refreshBedrockDiscovery: true });
    const followUp = manager.refreshProviderStatus();
    initial.resolve([status("stale")]);
    await Promise.all([first, forced, followUp]);

    expect(
      getProviderStatuses.mock.calls.map(([input]) => input?.refreshBedrockDiscovery === true),
    ).toEqual([false, true]);
    expect(events).toEqual([
      { type: "provider_status", sessionId: SESSION_ID, providers: [status("fresh")] },
    ]);
    expect(telemetry.map((entry) => entry.status)).toEqual(["ok", "ok"]);

    const failInit = Promise.withResolvers<ProviderStatus[]>();
    const failStarted = Promise.withResolvers<void>();
    let failCalls = 0;
    const failStatuses = mock(async () => {
      failCalls += 1;
      if (failCalls === 1) {
        failStarted.resolve();
        return await failInit.promise;
      }
      throw new Error("status down");
    });
    const failing = createHarness({ getProviderStatuses: failStatuses });

    const f1 = failing.manager.refreshProviderStatus();
    await failStarted.promise;
    const f2 = failing.manager.refreshProviderStatus({ refreshBedrockDiscovery: true });
    failInit.reject(new Error("stale status"));
    await Promise.all([f1, f2]);

    expect(
      failStatuses.mock.calls.map(([input]) => input?.refreshBedrockDiscovery === true),
    ).toEqual([false, true]);
    expect(failing.events).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "provider_error",
        source: "provider",
        message: "Failed to refresh provider status: Error: status down",
      },
    ]);
    expect(failing.telemetry).toEqual([
      { name: "provider.status.refresh", status: "error", error: "stale status" },
      { name: "provider.status.refresh", status: "error", error: "status down" },
    ]);
  });
});
