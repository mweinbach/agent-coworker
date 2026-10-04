import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { withBackupPathLock } from "../src/server/sessionBackup/locking";

const fixtureRoots: string[] = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(import.meta.dir, "backup-lock-"));
  fixtureRoots.push(root);
  const homedir = path.join(root, "home");
  const target = path.join(root, "workspace", "notes.txt");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "original");
  return { root, homedir, target };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("withBackupPathLock", () => {
  test("serializes overlapping operations on the same canonical path", async () => {
    const { homedir, target } = await makeFixture();
    const events: string[] = [];

    await Promise.all([
      withBackupPathLock(
        target,
        async () => {
          events.push("one-start");
          await Bun.sleep(25);
          events.push("one-end");
        },
        homedir,
      ),
      withBackupPathLock(
        target,
        async () => {
          events.push("two-start", "two-end");
        },
        homedir,
      ),
    ]);
    expect(events).toEqual(["one-start", "one-end", "two-start", "two-end"]);
  });

  test("releases the queue after a failed operation so later work can run", async () => {
    const { homedir, target } = await makeFixture();
    await expect(
      withBackupPathLock(
        target,
        async () => {
          throw new Error("checkpoint failed");
        },
        homedir,
      ),
    ).rejects.toThrow("checkpoint failed");
    await expect(withBackupPathLock(target, async () => "recovered", homedir)).resolves.toBe(
      "recovered",
    );
  });

  test("lets distinct paths overlap instead of sharing one queue", async () => {
    const { root, homedir, target } = await makeFixture();
    const other = path.join(root, "workspace", "other.txt");
    await fs.writeFile(other, "other");
    const hold = Promise.withResolvers<void>();
    let firstEntered = false;
    let secondStartedDuringFirst = false;

    const first = withBackupPathLock(
      target,
      async () => {
        firstEntered = true;
        await hold.promise;
      },
      homedir,
    );
    while (!firstEntered) await Bun.sleep(1);
    await withBackupPathLock(
      other,
      async () => {
        secondStartedDuringFirst = firstEntered;
      },
      homedir,
    );
    hold.resolve();
    await first;
    expect(secondStartedDuringFirst).toBe(true);
  });
});
