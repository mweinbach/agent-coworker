import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeTextFileAtomic } from "../src/utils/atomicFile";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-atomic-file-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("writeTextFileAtomic", () => {
  test("replaces an existing file", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "config.json");
    await fs.writeFile(target, "{\n  \"provider\": \"google\"\n}\n", "utf-8");

    await writeTextFileAtomic(target, "{\n  \"provider\": \"openai\"\n}\n");

    expect(await fs.readFile(target, "utf-8")).toBe("{\n  \"provider\": \"openai\"\n}\n");
  });

  test("retries transient Windows rename failures", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "config.json");
    let renameCalls = 0;
    let sleepCalls = 0;

    await writeTextFileAtomic(
      target,
      "{\"model\":\"gpt-5.2\"}\n",
      {},
      {
        platform: "win32",
        sleepImpl: async () => {
          sleepCalls += 1;
        },
        fsImpl: {
          mkdir: fs.mkdir.bind(fs),
          writeFile: fs.writeFile.bind(fs),
          unlink: fs.unlink.bind(fs),
          rename: async (from: string, to: string) => {
            renameCalls += 1;
            if (renameCalls < 3) {
              const err = new Error("transient lock") as NodeJS.ErrnoException;
              err.code = "EPERM";
              throw err;
            }
            await fs.rename(from, to);
          },
        },
      }
    );

    expect(await fs.readFile(target, "utf-8")).toBe("{\"model\":\"gpt-5.2\"}\n");
    expect(renameCalls).toBe(3);
    expect(sleepCalls).toBe(2);
  });

  test("does not retry EPERM on non-Windows platforms", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "config.json");
    let renameCalls = 0;
    let sleepCalls = 0;

    await expect(
      writeTextFileAtomic(
        target,
        "{\"model\":\"gpt-5.2\"}\n",
        {},
        {
          platform: "linux",
          sleepImpl: async () => {
            sleepCalls += 1;
          },
          fsImpl: {
            mkdir: fs.mkdir.bind(fs),
            writeFile: fs.writeFile.bind(fs),
            unlink: fs.unlink.bind(fs),
            rename: async () => {
              renameCalls += 1;
              const err = new Error("locked") as NodeJS.ErrnoException;
              err.code = "EPERM";
              throw err;
            },
          },
        }
      )
    ).rejects.toThrow("locked");

    expect(renameCalls).toBe(1);
    expect(sleepCalls).toBe(0);
  });
});
