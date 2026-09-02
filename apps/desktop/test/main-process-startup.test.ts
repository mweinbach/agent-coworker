import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import { createDesktopStateApplier } from "../electron/services/applyDesktopState";
import { loadCreatedWindow } from "../electron/services/windowActivation";
import type { PersistedState } from "../src/app/types";

test("a loading native window is not discarded when quit preflight temporarily gates creation", async () => {
  const source = await fs.readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function loadCreatedRendererWindow(");
  const end = source.indexOf("async function createMainWindow(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  let finishLoad!: () => void;
  const loading = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  const win = { isDestroyed: () => false, destroy: mock() };
  const load = new Function(
    "loadCreatedWindow",
    "loadRendererWindow",
    "assertWindowCreationAllowed",
    `${compiled}\nreturn loadCreatedRendererWindow;`,
  )(
    loadCreatedWindow,
    () => loading,
    () => {
      throw new Error("Quit preflight pending");
    },
  ) as (window: typeof win, mode: string) => Promise<typeof win>;
  const result = load(win, "canvas").then(
    (window) => ({ window }),
    (error) => ({ error }),
  );
  finishLoad();

  // Once allocated, this window belongs to the close coordinator, which may
  // still receive a save veto. Only an actual renderer-load failure discards it.
  expect(await result).toEqual({ window: win });
  expect(win.destroy).not.toHaveBeenCalled();
});

test("committed privacy changes reach main reporting before state application completes", async () => {
  let finishOptOut!: () => void;
  const optOut = new Promise<void>((resolve) => {
    finishOptOut = resolve;
  });
  const reporting = mock(async (settings?: { crashReportsEnabled?: boolean }) => {
    if (settings?.crashReportsEnabled === false) await optOut;
  });
  const analytics = mock(async (_state: PersistedState) => {});
  const apply = createDesktopStateApplier({
    applyWindowSettings: mock(),
    applyProductAnalytics: analytics,
    applyCrashReporting: reporting,
  });
  const state = (enabled: boolean): PersistedState => ({
    version: 2,
    workspaces: [],
    threads: [],
    privacyTelemetrySettings: { crashReportsEnabled: enabled, productAnalyticsEnabled: false },
  });

  await apply(state(true));
  let saved = false;
  const disabling = apply(state(false)).then(() => {
    saved = true;
  });
  await Promise.resolve();
  expect(saved).toBe(false);
  finishOptOut();
  await disabling;
  await apply(state(false));
  await apply(state(true));

  expect(reporting.mock.calls.map((call) => call[0]?.crashReportsEnabled)).toEqual([
    true,
    false,
    true,
  ]);
  expect(analytics).toHaveBeenCalledTimes(4);
});

test("a failed reporting change can be retried with unchanged committed settings", async () => {
  const reporting = mock(async () => {});
  reporting.mockImplementationOnce(async () => {
    throw new Error("reporting shutdown failed");
  });
  const apply = createDesktopStateApplier({
    applyWindowSettings() {},
    applyProductAnalytics: async () => {},
    applyCrashReporting: reporting,
  });
  const state: PersistedState = { version: 2, workspaces: [], threads: [] };
  await expect(apply(state)).rejects.toThrow("reporting shutdown failed");
  await apply(state);
  expect(reporting).toHaveBeenCalledTimes(2);
});

test("desktop app names itself before userData-backed services initialize", async () => {
  const source = await fs.readFile(new URL("../electron/main.ts", import.meta.url), "utf8");

  const setNameIndex = source.indexOf("app.setName(DESKTOP_APP_NAME);");
  const userDataOverrideIndex = source.indexOf(
    "const electronUserDataDirOverride = applyElectronUserDataDirOverride(app, process.env);",
  );
  const remoteDebugIndex = source.indexOf(
    "const electronRemoteDebug = resolveElectronRemoteDebugConfig",
  );
  const mobileRelayBridgeIndex = source.indexOf(
    "const mobileRelayBridge = new MobileRelayBridge({ serverManager });",
  );
  const persistenceIndex = source.indexOf("const persistence = new PersistenceService();");
  const singleInstanceLockIndex = source.indexOf(
    "const gotSingleInstanceLock = app.requestSingleInstanceLock();",
  );

  expect(setNameIndex).toBeGreaterThanOrEqual(0);
  expect(userDataOverrideIndex).toBeGreaterThanOrEqual(0);
  expect(remoteDebugIndex).toBeGreaterThanOrEqual(0);
  expect(mobileRelayBridgeIndex).toBeGreaterThanOrEqual(0);
  expect(persistenceIndex).toBeGreaterThanOrEqual(0);
  expect(singleInstanceLockIndex).toBeGreaterThanOrEqual(0);
  expect(setNameIndex).toBeLessThan(mobileRelayBridgeIndex);
  expect(setNameIndex).toBeLessThan(persistenceIndex);
  expect(setNameIndex).toBeLessThan(userDataOverrideIndex);
  expect(userDataOverrideIndex).toBeLessThan(mobileRelayBridgeIndex);
  expect(userDataOverrideIndex).toBeLessThan(persistenceIndex);
  expect(userDataOverrideIndex).toBeLessThan(remoteDebugIndex);
  expect(userDataOverrideIndex).toBeLessThan(singleInstanceLockIndex);
});

test("desktop main window applies the adaptive narrow-width guard", async () => {
  const source = await fs.readFile(new URL("../electron/main.ts", import.meta.url), "utf8");

  const mainWindowStart = source.indexOf("async function createMainWindow");
  const quickChatStart = source.indexOf("async function createQuickChatWindow");
  const mainWindowSource = source.slice(mainWindowStart, quickChatStart);

  expect(mainWindowStart).toBeGreaterThanOrEqual(0);
  expect(quickChatStart).toBeGreaterThan(mainWindowStart);
  expect(mainWindowSource).toContain("minWidth: MAIN_WINDOW_MIN_WIDTH");
  expect(mainWindowSource).toContain("minHeight: MAIN_WINDOW_MIN_HEIGHT");
});
