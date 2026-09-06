import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { withCoworkRuntimeBootstrapLock } from "../src/coworkRuntime/bootstrapLock";
import { consumerLeaseTesting, retainRuntimeForProcess } from "../src/coworkRuntime/consumerLease";
import { pruneInstalledRuntimes } from "../src/coworkRuntime/install";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";

const homes: string[] = [];
const worker = path.join(import.meta.dir, "fixtures", "runtime-consumer-worker.ts");
const versions = ["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"];

async function temporaryHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(scratchRoots()[0]!, "cowork-runtime-consumers-"));
  homes.push(home);
  for (const version of versions) {
    await fs.mkdir(path.join(home, ".cowork", "runtime", version), { recursive: true });
  }
  await fs.writeFile(
    path.join(home, ".cowork", "runtime", "current.json"),
    JSON.stringify({ schemaVersion: 1, version: versions.at(-1) }),
  );
  return home;
}

function startWorker(home: string, mode = "lease") {
  return Bun.spawn({
    cmd: [process.execPath, worker, home, versions[0]!, mode],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function expectReady(child: ReturnType<typeof startWorker>): Promise<void> {
  const reader = child.stdout.getReader();
  try {
    const message = await reader.read();
    expect(new TextDecoder().decode(message.value)).toContain("ready");
  } finally {
    reader.releaseLock();
  }
}

afterEach(async () => {
  consumerLeaseTesting.releaseAll();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Cowork runtime consumer leases", () => {
  test("released leases allow immediate fixture removal while the consumer process stays alive", async () => {
    const home = await temporaryHome();
    const owner = startWorker(home, "release");
    try {
      await expectReady(owner);
      expect(owner.exitCode).toBeNull();
      await fs.rm(home, { recursive: true, force: true });
      await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(owner.exitCode).toBeNull();
    } finally {
      owner.stdin.end();
      await owner.exited;
    }
  });

  test.each([false, true])(
    "shares canonical leases when both runtime roots alias a relocated directory (reverse=%s)",
    async (reverse) => {
      const home = await temporaryHome();
      const runtimeRoot = path.join(home, ".cowork", "runtime");
      const sharedRoot = path.join(home, "relocated-runtime");
      await fs.rename(runtimeRoot, sharedRoot);
      const aliasHome = path.join(home, "alias");
      await fs.mkdir(path.join(aliasHome, ".cowork"), { recursive: true });
      for (const target of [runtimeRoot, path.join(aliasHome, ".cowork", "runtime")]) {
        await fs.symlink(sharedRoot, target, hostPlatform() === "win32" ? "junction" : "dir");
      }
      const owner = startWorker(reverse ? aliasHome : home);
      const mutationHome = reverse ? home : aliasHome;
      const leaseFile = path.join(sharedRoot, ".consumer-leases", `${versions[0]}.sqlite`);
      try {
        await expectReady(owner);
        const before = await fs.stat(leaseFile);
        expect((await pruneInstalledRuntimes(mutationHome)).map((entry) => entry.version)).toEqual([
          versions[1]!,
        ]);
        expect((await fs.stat(path.join(sharedRoot, versions[0]!))).isDirectory()).toBe(true);
        expect((await fs.stat(leaseFile)).ino).toBe(before.ino);
      } finally {
        owner.kill("SIGKILL");
        await owner.exited;
      }
      const before = await fs.stat(leaseFile);
      expect((await pruneInstalledRuntimes(mutationHome)).map((entry) => entry.version)).toEqual([
        versions[0]!,
      ]);
      expect((await fs.stat(leaseFile)).ino).toBe(before.ino);
    },
  );

  test("retains every live reader and crash-recovers under concurrent pruners without replacing lock files", async () => {
    const home = await temporaryHome();
    const first = startWorker(home);
    const second = startWorker(home);
    const runtimeDir = path.join(home, ".cowork", "runtime", versions[0]!);
    try {
      await Promise.all([expectReady(first), expectReady(second)]);
      const leaseFile = path.join(
        home,
        ".cowork",
        "locks",
        "runtime-consumers",
        `${versions[0]}.sqlite`,
      );
      const identity = await fs.stat(leaseFile);
      expect((await pruneInstalledRuntimes(home)).map((entry) => entry.version)).toEqual([
        versions[1]!,
      ]);
      expect((await fs.stat(runtimeDir)).isDirectory()).toBe(true);
      first.kill("SIGKILL");
      await first.exited;
      expect(await pruneInstalledRuntimes(home)).toEqual([]);
      second.kill("SIGKILL");
      await second.exited;
      const pruners = [
        startWorker(home, "prune"),
        startWorker(home, "prune"),
        startWorker(home, "prune"),
      ];
      const removals = await Promise.all(
        pruners.map(async (child) => {
          const output = await new Response(child.stdout).text();
          expect(await child.exited).toBe(0);
          return JSON.parse(output) as Array<{ version: string }>;
        }),
      );
      expect(removals.flat().map((entry) => entry.version)).toEqual([versions[0]!]);
      expect((await fs.stat(leaseFile)).ino).toBe(identity.ino);
      await expect(fs.stat(runtimeDir)).rejects.toThrow();
      // Reinstalling a version reuses its permanent database identity; a new
      // consumer must not be confused with the crashed owner's old lease.
      await fs.mkdir(runtimeDir);
      await withCoworkRuntimeBootstrapLock({ home, version: versions[0]! }, async (lock) => {
        await retainRuntimeForProcess(runtimeDir, lock);
      });
      expect(await pruneInstalledRuntimes(home)).toEqual([]);
      expect((await fs.stat(leaseFile)).ino).toBe(identity.ino);
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
      await Promise.all([first.exited, second.exited]);
    }
  });

  test.skipIf(hostPlatform() === "win32")("never expires a suspended live consumer", async () => {
    const home = await temporaryHome();
    const owner = startWorker(home);
    try {
      await expectReady(owner);
      owner.kill("SIGSTOP");
      const leaseFile = path.join(
        home,
        ".cowork",
        "locks",
        "runtime-consumers",
        `${versions[0]}.sqlite`,
      );
      await fs.utimes(leaseFile, new Date(0), new Date(0));
      expect((await pruneInstalledRuntimes(home)).map((entry) => entry.version)).toEqual([
        versions[1]!,
      ]);
      expect(await fs.readdir(path.join(home, ".cowork", "runtime", versions[0]!))).toEqual([]);
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
    }
  });

  test("recovers a crash during the first lease database initialization", async () => {
    const home = await temporaryHome();
    const initializer = startWorker(home, "initialize");
    const file = path.join(home, ".cowork", "locks", "runtime-consumers", `${versions[0]}.sqlite`);
    try {
      await expectReady(initializer);
      expect((await fs.stat(file)).isFile()).toBe(true);
      expect((await fs.stat(`${file}-journal`)).size).toBeGreaterThan(0);
    } finally {
      initializer.kill("SIGKILL");
      await initializer.exited;
    }
    expect((await pruneInstalledRuntimes(home)).map((entry) => entry.version)).toEqual([
      versions[1]!,
      versions[0]!,
    ]);
  });

  test("fails closed on an unknown lease database without deleting runtime or foreign data", async () => {
    const home = await temporaryHome();
    const leaseRoot = path.join(home, ".cowork", "locks", "runtime-consumers");
    await fs.mkdir(leaseRoot, { recursive: true });
    const file = path.join(leaseRoot, `${versions[1]}.sqlite`);
    await fs.writeFile(file, "foreign data");
    await expect(pruneInstalledRuntimes(home)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("foreign data");
    expect(await fs.readdir(path.join(home, ".cowork", "runtime", versions[1]!))).toEqual([]);
  });

  test.each(["application", "journal", "anchor"] as const)(
    "rejects invalid lease %s metadata and closes the database before fixture cleanup",
    async (invalid) => {
      const home = await temporaryHome();
      const leaseRoot = path.join(home, ".cowork", "locks", "runtime-consumers");
      await fs.mkdir(leaseRoot, { recursive: true });
      const file = path.join(leaseRoot, `${versions[1]}.sqlite`);
      const database = new DatabaseSync(file);
      try {
        database.exec(`
          PRAGMA application_id = ${invalid === "application" ? 0 : 0x4357524c};
          PRAGMA journal_mode = ${invalid === "journal" ? "WAL" : "DELETE"};
          CREATE TABLE lease_anchor (id INTEGER PRIMARY KEY);
          ${invalid === "anchor" ? "" : "INSERT INTO lease_anchor VALUES (1);"}
        `);
      } finally {
        database.close();
      }
      await expect(pruneInstalledRuntimes(home)).rejects.toThrow(/invalid.*lease database/);
      expect(
        (await fs.stat(path.join(home, ".cowork", "runtime", versions[1]!))).isDirectory(),
      ).toBe(true);
      await fs.rm(home, { recursive: true, force: true });
      await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("rejects symbolic lease files without following or removing foreign paths", async () => {
    const home = await temporaryHome();
    const leaseRoot = path.join(home, ".cowork", "locks", "runtime-consumers");
    await fs.mkdir(leaseRoot, { recursive: true });
    const foreign = path.join(home, "foreign.sqlite");
    await fs.writeFile(foreign, "foreign data");
    const file = path.join(leaseRoot, `${versions[1]}.sqlite`);
    // Directory junctions need no Windows symlink privilege and must likewise
    // be rejected before SQLite gets a chance to open the path.
    await fs.symlink(
      hostPlatform() === "win32" ? home : foreign,
      file,
      hostPlatform() === "win32" ? "junction" : "file",
    );
    await expect(pruneInstalledRuntimes(home)).rejects.toThrow(/Invalid.*lease database/);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign data");
  });
});
