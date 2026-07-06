import { describe, expect, mock, test } from "bun:test";
import type { ExecFileCompatResult } from "../../src/utils/execFileCompat";
import {
  createLmStudioLocalService,
  isLoopbackBaseUrl,
  type LmStudioLocalDeps,
  resolveLmsCliPath,
} from "../../src/providers/lmstudio/local";

const MODELS_OK = new Response(JSON.stringify({ models: [] }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function okFetch(): typeof fetch {
  return (async () => MODELS_OK.clone()) as unknown as typeof fetch;
}

function downFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed: connection refused");
  }) as unknown as typeof fetch;
}

function httpErrorFetch(status: number): typeof fetch {
  return (async () => new Response("nope", { status })) as unknown as typeof fetch;
}

function makeDeps(overrides: Partial<LmStudioLocalDeps> = {}): LmStudioLocalDeps {
  return {
    env: {},
    homedir: () => "/home/tester",
    platform: "darwin",
    fetchImpl: okFetch(),
    fileExists: async () => true,
    execFile: mock(
      async (): Promise<ExecFileCompatResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    ),
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
}

describe("resolveLmsCliPath", () => {
  test("uses ~/.lmstudio/bin/lms on posix platforms", () => {
    expect(resolveLmsCliPath({ homedir: () => "/home/tester", platform: "darwin" })).toBe(
      "/home/tester/.lmstudio/bin/lms",
    );
    expect(resolveLmsCliPath({ homedir: () => "/home/tester", platform: "linux" })).toBe(
      "/home/tester/.lmstudio/bin/lms",
    );
  });

  test("uses lms.exe under the profile dir on Windows", () => {
    expect(resolveLmsCliPath({ homedir: () => "C:\\Users\\tester", platform: "win32" })).toContain(
      "lms.exe",
    );
  });
});

describe("isLoopbackBaseUrl", () => {
  test("accepts loopback hosts", () => {
    expect(isLoopbackBaseUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackBaseUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLoopbackBaseUrl("http://[::1]:1234")).toBe(true);
  });

  test("rejects remote and malformed urls", () => {
    expect(isLoopbackBaseUrl("http://192.168.1.50:1234")).toBe(false);
    expect(isLoopbackBaseUrl("http://lmstudio.internal:1234")).toBe(false);
    expect(isLoopbackBaseUrl("not a url")).toBe(false);
  });
});

describe("createLmStudioLocalService.getStatus", () => {
  test("reports installed + running when the CLI exists and the probe succeeds", async () => {
    const service = createLmStudioLocalService(makeDeps());
    const status = await service.getStatus();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.baseUrl).toBe("http://localhost:1234");
    expect(status.canAutoStart).toBe(true);
    expect(status.cliPath).toBe("/home/tester/.lmstudio/bin/lms");
  });

  test("reports not running when the connection fails", async () => {
    const service = createLmStudioLocalService(makeDeps({ fetchImpl: downFetch() }));
    const status = await service.getStatus();
    expect(status.running).toBe(false);
    expect(status.message).toContain("unreachable");
  });

  test("treats HTTP-level errors as running (the server answered)", async () => {
    const service = createLmStudioLocalService(makeDeps({ fetchImpl: httpErrorFetch(401) }));
    const status = await service.getStatus();
    expect(status.running).toBe(true);
  });

  test("reports not installed when the lms CLI is missing", async () => {
    const service = createLmStudioLocalService(
      makeDeps({ fileExists: async () => false, fetchImpl: downFetch() }),
    );
    const status = await service.getStatus();
    expect(status.installed).toBe(false);
    expect(status.canAutoStart).toBe(false);
    expect(status.cliPath).toBeUndefined();
  });

  test("never offers auto-start for a remote baseUrl", async () => {
    const service = createLmStudioLocalService(makeDeps({ fetchImpl: downFetch() }));
    const status = await service.getStatus({ baseUrl: "http://192.168.1.50:1234" });
    expect(status.installed).toBe(true);
    expect(status.canAutoStart).toBe(false);
    expect(status.baseUrl).toBe("http://192.168.1.50:1234");
  });

  test("prefers providerOptions baseUrl and env override", async () => {
    const service = createLmStudioLocalService(
      makeDeps({ env: { LM_STUDIO_BASE_URL: "http://127.0.0.1:9999" } }),
    );
    const status = await service.getStatus({
      providerOptions: { lmstudio: { baseUrl: "http://localhost:4321" } },
    });
    expect(status.baseUrl).toBe("http://127.0.0.1:9999");
  });

  test("caches positive probes briefly and never caches negatives", async () => {
    let calls = 0;
    let up = true;
    let nowMs = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (!up) throw new TypeError("connection refused");
      return MODELS_OK.clone();
    }) as unknown as typeof fetch;
    const service = createLmStudioLocalService(makeDeps({ fetchImpl, now: () => nowMs }));

    await service.getStatus();
    await service.getStatus();
    expect(calls).toBe(1); // second call inside the 5s window uses the cache

    nowMs = 10_000;
    up = false;
    await service.getStatus();
    await service.getStatus();
    expect(calls).toBe(3); // failures are re-probed every time
  });
});

describe("createLmStudioLocalService.start", () => {
  test("returns ok immediately when the server is already running", async () => {
    const execFile = mock(
      async (): Promise<ExecFileCompatResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    );
    const service = createLmStudioLocalService(makeDeps({ execFile }));
    const result = await service.start();
    expect(result.ok).toBe(true);
    expect(result.running).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  test("spawns lms server start with the baseUrl port and polls until reachable", async () => {
    let nowMs = 0;
    let probeCount = 0;
    const fetchImpl = (async () => {
      probeCount += 1;
      if (probeCount < 3) throw new TypeError("connection refused");
      return MODELS_OK.clone();
    }) as unknown as typeof fetch;
    const execFile = mock(
      async (): Promise<ExecFileCompatResult> => ({ stdout: "started", stderr: "", exitCode: 0 }),
    );
    const service = createLmStudioLocalService(
      makeDeps({
        fetchImpl,
        execFile,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      }),
    );

    const result = await service.start({ baseUrl: "http://localhost:4321" });
    expect(result.ok).toBe(true);
    expect(result.running).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe("/home/tester/.lmstudio/bin/lms");
    expect(execFile.mock.calls[0]?.[1]).toEqual(["server", "start", "--port", "4321"]);
  });

  test("fails with the CLI stderr when the server never becomes reachable", async () => {
    let nowMs = 0;
    const execFile = mock(
      async (): Promise<ExecFileCompatResult> => ({
        stdout: "",
        stderr: "boom: daemon crashed",
        exitCode: 1,
      }),
    );
    const service = createLmStudioLocalService(
      makeDeps({
        fetchImpl: downFetch(),
        execFile,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      }),
    );

    const result = await service.start({ timeoutMs: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.running).toBe(false);
    expect(result.message).toContain("boom: daemon crashed");
  });

  test("refuses to start for a remote baseUrl", async () => {
    const execFile = mock(
      async (): Promise<ExecFileCompatResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    );
    const service = createLmStudioLocalService(makeDeps({ execFile, fetchImpl: downFetch() }));
    const result = await service.start({ baseUrl: "http://192.168.1.50:1234" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("non-local");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("reports missing installation instead of spawning", async () => {
    const execFile = mock(
      async (): Promise<ExecFileCompatResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    );
    const service = createLmStudioLocalService(
      makeDeps({ execFile, fetchImpl: downFetch(), fileExists: async () => false }),
    );
    const result = await service.start();
    expect(result.ok).toBe(false);
    expect(result.installed).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  test("coalesces concurrent starts for the same baseUrl", async () => {
    let nowMs = 0;
    let probeCount = 0;
    const fetchImpl = (async () => {
      probeCount += 1;
      if (probeCount < 4) throw new TypeError("connection refused");
      return MODELS_OK.clone();
    }) as unknown as typeof fetch;
    const execFile = mock(
      async (): Promise<ExecFileCompatResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    );
    const service = createLmStudioLocalService(
      makeDeps({
        fetchImpl,
        execFile,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      }),
    );

    const [a, b] = await Promise.all([service.start(), service.start()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
