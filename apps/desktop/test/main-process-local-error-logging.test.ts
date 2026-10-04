import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { createElectronMock } from "./helpers/mockElectron";

test("main-process failures are logged locally even when crash reporting is off", async () => {
  const userDataDir = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-main-errors-"));
  mock.module("electron", () =>
    createElectronMock({
      app: { getVersion: () => "9.9.9", getPath: () => userDataDir, isPackaged: false },
    }),
  );

  const exceptionBefore = new Set(process.listeners("uncaughtExceptionMonitor"));
  const rejectionBefore = new Set(process.listeners("unhandledRejection"));
  const addedExceptions = () =>
    process.listeners("uncaughtExceptionMonitor").filter((fn) => !exceptionBefore.has(fn));
  const addedRejections = () =>
    process.listeners("unhandledRejection").filter((fn) => !rejectionBefore.has(fn));

  const { registerMainProcessLocalErrorLogging } = await import(
    "../electron/services/crashReporting"
  );
  const { flushLocalLogWrites, getLocalLogPath } = await import("../electron/services/localLogs");

  const readMeta = async () => {
    const raw = await fs.readFile(getLocalLogPath("desktop-main.log"), "utf8").catch(() => "");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) => (JSON.parse(line) as { meta?: { operation?: string; message?: string } }).meta,
      );
  };

  try {
    registerMainProcessLocalErrorLogging();
    expect(addedExceptions()).toHaveLength(1);
    expect(addedRejections()).toHaveLength(1);

    addedExceptions()[0]?.(new Error("renderer host exploded"), "uncaughtException");
    const afterSync = await readMeta();
    expect(afterSync).toEqual([
      expect.objectContaining({
        operation: "unhandled_exception",
        message: "renderer host exploded",
      }),
    ]);

    addedRejections()[0]?.("budget worker rejected", Promise.resolve());
    expect(await readMeta()).toEqual(afterSync);

    await flushLocalLogWrites();
    expect(await readMeta()).toEqual([
      expect.objectContaining({
        operation: "unhandled_exception",
        message: "renderer host exploded",
      }),
      expect.objectContaining({
        operation: "unhandled_rejection",
        message: "budget worker rejected",
      }),
    ]);

    registerMainProcessLocalErrorLogging();
    expect(addedExceptions()).toHaveLength(1);
    addedExceptions()[0]?.(new Error("second failure"), "uncaughtException");
    expect(
      (await readMeta())
        .filter((meta) => meta?.operation === "unhandled_exception")
        .map((meta) => meta?.message),
    ).toEqual(["renderer host exploded", "second failure"]);
  } finally {
    for (const listener of addedExceptions()) process.off("uncaughtExceptionMonitor", listener);
    for (const listener of addedRejections()) process.off("unhandledRejection", listener);
    await flushLocalLogWrites();
    mock.restore();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
