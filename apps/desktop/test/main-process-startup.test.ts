import { expect, test } from "bun:test";
import fs from "node:fs/promises";

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
