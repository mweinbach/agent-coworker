import { expect, test } from "bun:test";
import fs from "node:fs/promises";

test("server entrypoint loads reflect metadata before sidecar server imports", async () => {
  const source = await fs.readFile(new URL("../src/server/index.ts", import.meta.url), "utf8");

  const reflectImportIndex = source.indexOf('import "reflect-metadata";');
  const startServerImportIndex = source.indexOf('import("./startServer")');

  expect(reflectImportIndex).toBeGreaterThanOrEqual(0);
  expect(startServerImportIndex).toBeGreaterThanOrEqual(0);
  expect(reflectImportIndex).toBeLessThan(startServerImportIndex);
});
