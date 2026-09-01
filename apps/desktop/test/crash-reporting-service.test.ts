import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { createElectronMock } from "./helpers/mockElectron";

test("main crash reporting honors live opt-out and opt-in without environment feedback", async () => {
  const userDataDir = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-crash-consent-"));
  const envKeys = [
    "COWORK_CRASH_REPORTS_ENABLED",
    "COWORK_DISABLE_NETWORK_TELEMETRY",
    "COWORK_SENTRY_DSN",
    "COWORK_SENTRY_ENVIRONMENT",
    "COWORK_TELEMETRY_MODE",
    "COWORK_RELEASE",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const initialRejectionListeners = process.listeners("unhandledRejection");
  const initialExceptionListeners = process.listeners("uncaughtExceptionMonitor");
  const captureException = mock(() => "synthetic-report");
  const init = mock(() => {});
  const close = mock(async () => true);

  mock.module("electron", () =>
    createElectronMock({
      app: {
        getVersion: () => "1.2.23",
        getPath: () => userDataDir,
        isPackaged: false,
      },
    }),
  );
  mock.module("@sentry/electron/main", () => ({ init, close, captureException }));
  delete process.env.COWORK_CRASH_REPORTS_ENABLED;
  delete process.env.COWORK_DISABLE_NETWORK_TELEMETRY;
  process.env.COWORK_SENTRY_DSN = "https://public@sentry.example/1";
  process.env.COWORK_TELEMETRY_MODE = "local-dev";

  const { shutdownCrashReporting } = await import("../../../src/telemetry/crashReporting");
  const { initElectronMainCrashReporting, captureCrashReportingError } = await import(
    "../electron/services/crashReporting"
  );
  const { flushLocalLogWrites } = await import("../electron/services/localLogs");
  await shutdownCrashReporting();
  try {
    expect((await initElectronMainCrashReporting({ crashReportsEnabled: true })).initialized).toBe(
      true,
    );
    captureCrashReportingError(new Error("before opt-out"));
    expect(captureException).toHaveBeenCalledTimes(1);

    const disabled = await initElectronMainCrashReporting({ crashReportsEnabled: false });
    captureCrashReportingError(new Error("after opt-out"));
    expect(disabled.enabled).toBe(false);
    expect(disabled.initialized).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(process.env.COWORK_CRASH_REPORTS_ENABLED).toBe("false");

    expect((await initElectronMainCrashReporting({ crashReportsEnabled: true })).initialized).toBe(
      true,
    );
    captureCrashReportingError(new Error("after opt-in"));
    expect(init).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(2);
  } finally {
    await shutdownCrashReporting();
    await flushLocalLogWrites();
    for (const listener of process.listeners("unhandledRejection")) {
      if (!initialRejectionListeners.includes(listener))
        process.off("unhandledRejection", listener);
    }
    for (const listener of process.listeners("uncaughtExceptionMonitor")) {
      if (!initialExceptionListeners.includes(listener)) {
        process.off("uncaughtExceptionMonitor", listener);
      }
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mock.restore();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
