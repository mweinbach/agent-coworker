import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { createElectronMock } from "./helpers/mockElectron";

test("main-process failures are logged locally even when crash reporting is off", async () => {
  const userDataDir = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-main-errors-"));
  mock.module("electron", () =>
    createElectronMock({
      app: {
        getVersion: () => "9.9.9",
        getPath: () => userDataDir,
        isPackaged: false,
      },
    }),
  );

  const exceptionBefore = process.listeners("uncaughtExceptionMonitor");
  const rejectionBefore = process.listeners("unhandledRejection");
  const { registerMainProcessLocalErrorLogging } = await import(
    "../electron/services/crashReporting"
  );
  const { flushLocalLogWrites, getLocalLogPath } = await import("../electron/services/localLogs");

  const readOperations = async () => {
    const logPath = getLocalLogPath("desktop-main.log");
    const raw = await fs.readFile(logPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { meta?: { operation?: string; message?: string } });
  };

  try {
    registerMainProcessLocalErrorLogging();
    const exceptionListeners = process
      .listeners("uncaughtExceptionMonitor")
      .filter((listener) => !exceptionBefore.includes(listener));
    const rejectionListeners = process
      .listeners("unhandledRejection")
      .filter((listener) => !rejectionBefore.includes(listener));
    expect(exceptionListeners).toHaveLength(1);
    expect(rejectionListeners).toHaveLength(1);

    exceptionListeners[0]?.(new Error("renderer host exploded"), "uncaughtException");
    const afterSync = await readOperations();
    expect(afterSync.map((entry) => entry.meta?.operation)).toEqual(["unhandled_exception"]);
    expect(afterSync[0]?.meta?.message).toBe("renderer host exploded");

    rejectionListeners[0]?.("budget worker rejected", Promise.resolve());
    expect(await readOperations()).toEqual(afterSync);

    await flushLocalLogWrites();
    const afterFlush = await readOperations();
    expect(afterFlush.map((entry) => entry.meta?.operation)).toEqual([
      "unhandled_exception",
      "unhandled_rejection",
    ]);
    expect(afterFlush[1]?.meta?.message).toBe("budget worker rejected");

    registerMainProcessLocalErrorLogging();
    expect(
      process
        .listeners("uncaughtExceptionMonitor")
        .filter((listener) => !exceptionBefore.includes(listener)),
    ).toHaveLength(1);
    exceptionListeners[0]?.(new Error("second failure"), "uncaughtException");
    const exceptions = (await readOperations()).filter(
      (entry) => entry.meta?.operation === "unhandled_exception",
    );
    expect(exceptions.map((entry) => entry.meta?.message)).toEqual([
      "renderer host exploded",
      "second failure",
    ]);
  } finally {
    for (const listener of process.listeners("uncaughtExceptionMonitor")) {
      if (!exceptionBefore.includes(listener)) process.off("uncaughtExceptionMonitor", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!rejectionBefore.includes(listener)) process.off("unhandledRejection", listener);
    }
    await flushLocalLogWrites();
    mock.restore();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
