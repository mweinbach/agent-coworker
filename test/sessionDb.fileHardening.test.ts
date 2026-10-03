import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  quarantineCorruptedDb,
} from "../src/server/sessionDb/fileHardening";

const fixtureRoots: string[] = [];

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(import.meta.dir, "sessiondb-harden-"));
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("session DB file hardening", () => {
  test("quarantineCorruptedDb renames the only copy to a .corrupt.bak", async () => {
    const root = await makeFixture();
    const dbPath = path.join(root, "sessions.sqlite");
    await fs.writeFile(dbPath, "corrupt-bytes");

    await quarantineCorruptedDb(dbPath);

    await expect(fs.stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
    const backups = (await fs.readdir(root)).filter(
      (name) => name.startsWith("sessions.sqlite.corrupt.") && name.endsWith(".bak"),
    );
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(root, backups[0] ?? ""), "utf8")).toBe("corrupt-bytes");
  });

  test("quarantineCorruptedDb fails closed when the original file is already gone", async () => {
    const root = await makeFixture();
    const dbPath = path.join(root, "missing.sqlite");

    await expect(quarantineCorruptedDb(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("ensurePrivateDirectory and hardenPrivateFile apply private modes", async () => {
    const root = await makeFixture();
    const dirPath = path.join(root, "private");
    const filePath = path.join(dirPath, "sessions.sqlite");

    await ensurePrivateDirectory(dirPath);
    await fs.writeFile(filePath, "db", { mode: 0o644 });
    await hardenPrivateFile(filePath);

    expect((await fs.stat(dirPath)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
