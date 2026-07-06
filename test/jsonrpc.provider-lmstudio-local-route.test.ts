import { describe, expect, mock, test } from "bun:test";
import type {
  LmStudioLocalStartResult,
  LmStudioLocalStatus,
} from "../src/providers/lmstudio/local";
import { createProviderRouteHandlers } from "../src/server/jsonrpc/routes/provider";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcProviderResultSchemas } from "../src/server/jsonrpc/schema.provider";

function makeHarness(opts?: { withService?: boolean }) {
  const results: unknown[] = [];
  const errors: Array<{ code?: number; message?: string }> = [];
  const getStatus = mock(
    async (): Promise<LmStudioLocalStatus> => ({
      installed: true,
      running: false,
      baseUrl: "http://localhost:1234",
      canAutoStart: true,
      cliPath: "/home/tester/.lmstudio/bin/lms",
      message: "LM Studio server is unreachable at http://localhost:1234.",
      checkedAt: "2026-07-06T00:00:00.000Z",
    }),
  );
  const start = mock(
    async (): Promise<LmStudioLocalStartResult> => ({
      ok: true,
      installed: true,
      running: true,
      baseUrl: "http://localhost:1234",
    }),
  );
  const context = {
    getConfig: () => ({ providerOptions: { lmstudio: { baseUrl: "http://localhost:1234" } } }),
    ...(opts?.withService === false ? {} : { lmstudioLocal: { getStatus, start } }),
    jsonrpc: {
      sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
      sendError: (_ws: unknown, _id: unknown, error: { code?: number; message?: string }) =>
        errors.push(error),
    },
  } as unknown as JsonRpcRouteContext;
  return { context, errors, getStatus, results, start };
}

describe("LM Studio local JSON-RPC routes", () => {
  test("status returns a schema-valid envelope", async () => {
    const harness = makeHarness();
    await createProviderRouteHandlers(harness.context)["cowork/provider/lmstudio/local/status"]?.(
      {} as never,
      { id: 1, method: "cowork/provider/lmstudio/local/status", params: {} },
    );

    expect(harness.errors).toEqual([]);
    expect(harness.getStatus).toHaveBeenCalledTimes(1);
    expect(
      jsonRpcProviderResultSchemas["cowork/provider/lmstudio/local/status"].safeParse(
        harness.results[0],
      ).success,
    ).toBe(true);
  });

  test("status forwards an explicit baseUrl param", async () => {
    const harness = makeHarness();
    await createProviderRouteHandlers(harness.context)["cowork/provider/lmstudio/local/status"]?.(
      {} as never,
      {
        id: 2,
        method: "cowork/provider/lmstudio/local/status",
        params: { baseUrl: "http://127.0.0.1:4321" },
      },
    );

    expect(harness.getStatus.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "http://127.0.0.1:4321",
    });
  });

  test("start returns a schema-valid envelope and passes timeoutMs", async () => {
    const harness = makeHarness();
    await createProviderRouteHandlers(harness.context)["cowork/provider/lmstudio/local/start"]?.(
      {} as never,
      {
        id: 3,
        method: "cowork/provider/lmstudio/local/start",
        params: { timeoutMs: 5_000 },
      },
    );

    expect(harness.errors).toEqual([]);
    expect(harness.start).toHaveBeenCalledTimes(1);
    expect(harness.start.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 5_000 });
    expect(
      jsonRpcProviderResultSchemas["cowork/provider/lmstudio/local/start"].safeParse(
        harness.results[0],
      ).success,
    ).toBe(true);
  });

  test("start rejects a non-loopback baseUrl with invalidParams", async () => {
    const harness = makeHarness();
    await createProviderRouteHandlers(harness.context)["cowork/provider/lmstudio/local/start"]?.(
      {} as never,
      {
        id: 4,
        method: "cowork/provider/lmstudio/local/start",
        params: { baseUrl: "http://192.168.1.50:1234" },
      },
    );

    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.code).toBe(-32602);
  });

  test("both methods fail cleanly when the service is not wired", async () => {
    const harness = makeHarness({ withService: false });
    const handlers = createProviderRouteHandlers(harness.context);
    await handlers["cowork/provider/lmstudio/local/status"]?.({} as never, {
      id: 5,
      method: "cowork/provider/lmstudio/local/status",
      params: {},
    });
    await handlers["cowork/provider/lmstudio/local/start"]?.({} as never, {
      id: 6,
      method: "cowork/provider/lmstudio/local/start",
      params: {},
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors).toHaveLength(2);
  });
});
