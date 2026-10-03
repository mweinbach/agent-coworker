import { describe, expect, mock, test } from "bun:test";
import type { ProviderStatus } from "../../src/providerStatus";
import type { ProviderCatalogPayload } from "../../src/providers/connectionCatalog";
import type { SessionEvent } from "../../src/server/protocol";
import { ProviderCatalogManager } from "../../src/server/session/ProviderCatalogManager";
import type { AgentConfig } from "../../src/types";

const SESSION_ID = "session-provider-catalog";

function status(message: string): ProviderStatus {
  return {
    provider: "openai",
    authorized: true,
    verified: false,
    mode: "api_key",
    account: null,
    message,
    checkedAt: "2026-09-23T00:00:00.000Z",
  };
}

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
    getGlobalAuthPaths: () =>
      paths as ReturnType<
        ConstructorParameters<typeof ProviderCatalogManager>[0]["getGlobalAuthPaths"]
      >,
    getProviderCatalog: (opts?.getProviderCatalog ??
      (async () => ({ all: [], default: {}, connected: [] }))) as ConstructorParameters<
      typeof ProviderCatalogManager
    >[0]["getProviderCatalog"],
    getProviderStatuses: (opts?.getProviderStatuses ?? (async () => [])) as ConstructorParameters<
      typeof ProviderCatalogManager
    >[0]["getProviderStatuses"],
    emit: (event) => {
      events.push(event);
    },
    emitError: (code, source, message) => {
      events.push({ type: "error", sessionId: SESSION_ID, code, source, message });
    },
    emitTelemetry: (name, status, attributes) => {
      telemetry.push({
        name,
        status,
        ...(typeof attributes?.error === "string" ? { error: attributes.error } : {}),
      });
    },
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
    onCatalogChanged,
  });
  return { manager, events, telemetry, paths, config, onCatalogChanged };
}

describe("ProviderCatalogManager", () => {
  test("keeps the latest catalog and overlays the live session model", async () => {
    const older = Promise.withResolvers<ProviderCatalogPayload>();
    let calls = 0;
    const getProviderCatalog = mock(async () => {
      calls += 1;
      if (calls === 1) return await older.promise;
      return {
        all: [],
        default: { openai: "catalog-default", anthropic: "claude" },
        connected: ["openai"],
      };
    });
    const { manager, events, paths, config, onCatalogChanged } = createHarness({
      getProviderCatalog: getProviderCatalog as ConstructorParameters<
        typeof ProviderCatalogManager
      >[0]["getProviderCatalog"],
    });

    const first = manager.emitProviderCatalog();
    await manager.emitProviderCatalog({ refresh: true });
    older.resolve({ all: [], default: { openai: "stale" }, connected: ["stale"] });
    await first;

    expect(getProviderCatalog).toHaveBeenLastCalledWith({
      paths,
      providerOptions: config.providerOptions,
      refresh: true,
    });
    expect(events.filter((event) => event.type === "provider_catalog")).toEqual([
      {
        type: "provider_catalog",
        sessionId: SESSION_ID,
        all: [],
        default: { openai: "session-model", anthropic: "claude" },
        connected: ["openai"],
      },
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(onCatalogChanged).toHaveBeenCalledTimes(1);
  });

  test("reports only the current catalog failure when an older request loses the race", async () => {
    const older = Promise.withResolvers<ProviderCatalogPayload>();
    let calls = 0;
    const getProviderCatalog = mock(async () => {
      calls += 1;
      if (calls === 1) return await older.promise;
      throw new Error("catalog down");
    });
    const { manager, events, onCatalogChanged } = createHarness({
      getProviderCatalog: getProviderCatalog as ConstructorParameters<
        typeof ProviderCatalogManager
      >[0]["getProviderCatalog"],
    });

    const first = manager.emitProviderCatalog();
    const second = manager.emitProviderCatalog({ refresh: true });
    older.reject(new Error("stale catalog"));
    await Promise.all([first, second]);

    expect(events).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "provider_error",
        source: "provider",
        message: "Failed to load provider catalog: Error: catalog down",
      },
    ]);
    expect(onCatalogChanged).not.toHaveBeenCalled();
  });

  test("publishes only the newest coalesced provider status", async () => {
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
    const { manager, events, telemetry } = createHarness({
      getProviderStatuses: getProviderStatuses as ConstructorParameters<
        typeof ProviderCatalogManager
      >[0]["getProviderStatuses"],
    });

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
  });

  test("hides an in-flight status failure while a newer refresh is pending", async () => {
    const initial = Promise.withResolvers<ProviderStatus[]>();
    const initialStarted = Promise.withResolvers<void>();
    let calls = 0;
    const getProviderStatuses = mock(async () => {
      calls += 1;
      if (calls === 1) {
        initialStarted.resolve();
        return await initial.promise;
      }
      throw new Error("status down");
    });
    const { manager, events, telemetry } = createHarness({
      getProviderStatuses: getProviderStatuses as ConstructorParameters<
        typeof ProviderCatalogManager
      >[0]["getProviderStatuses"],
    });

    const first = manager.refreshProviderStatus();
    await initialStarted.promise;
    const latest = manager.refreshProviderStatus({ refreshBedrockDiscovery: true });
    initial.reject(new Error("stale status"));
    await Promise.all([first, latest]);

    expect(
      getProviderStatuses.mock.calls.map(([input]) => input?.refreshBedrockDiscovery === true),
    ).toEqual([false, true]);
    expect(events).toEqual([
      {
        type: "error",
        sessionId: SESSION_ID,
        code: "provider_error",
        source: "provider",
        message: "Failed to refresh provider status: Error: status down",
      },
    ]);
    expect(telemetry).toEqual([
      { name: "provider.status.refresh", status: "error", error: "stale status" },
      { name: "provider.status.refresh", status: "error", error: "status down" },
    ]);
  });
});
