import { expect, test } from "bun:test";
import fs from "node:fs/promises";

test("desktop app names itself before userData-backed services initialize", async () => {
  const source = await fs.readFile(new URL("../electron/main.ts", import.meta.url), "utf8");

  const setNameIndex = source.indexOf("app.setName(DESKTOP_APP_NAME);");
  const mobileRelayBridgeIndex = source.indexOf("const mobileRelayBridge = new MobileRelayBridge({ serverManager });");
  const persistenceIndex = source.indexOf("const persistence = new PersistenceService();");

  expect(setNameIndex).toBeGreaterThanOrEqual(0);
  expect(mobileRelayBridgeIndex).toBeGreaterThanOrEqual(0);
  expect(persistenceIndex).toBeGreaterThanOrEqual(0);
  expect(setNameIndex).toBeLessThan(mobileRelayBridgeIndex);
  expect(setNameIndex).toBeLessThan(persistenceIndex);
});
