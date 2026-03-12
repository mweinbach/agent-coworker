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

  test("honors mode option when writing temp file", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "config.json");
    let seenOptions: any = undefined;

    const fsImpl = {
      mkdir: fs.mkdir.bind(fs),
      writeFile: async (path: string, payload: string, opts?: any) => {
        seenOptions = opts;
        return fs.writeFile(path, payload, "utf-8");
      },
      unlink: fs.unlink.bind(fs),
      rename: fs.rename.bind(fs),
    };

    await writeTextFileAtomic(
      target,
      "{\"model\":\"gpt-5.2\"}\n",
      { mode: 0o600 },
      { fsImpl }
    );

    expect(seenOptions?.mode).toBe(0o600);
  });

  test("retries Windows EACCES and EBUSY rename codes", async () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const dir = await makeTmpDir();
      const target = path.join(dir, "config.json");
      let renameCalls = 0;

      await writeTextFileAtomic(
        target,
        "{\"model\":\"gpt-5.2\"}\n",
        {},
        {
          platform: "win32",
          fsImpl: {
            mkdir: fs.mkdir.bind(fs),
            writeFile: fs.writeFile.bind(fs),
            unlink: fs.unlink.bind(fs),
            rename: async (from: string, to: string) => {
              renameCalls += 1;
              if (renameCalls < 3) {
                const err = new Error("busy") as NodeJS.ErrnoException;
                err.code = code;
                throw err;
              }
              await fs.rename(from, to);
            },
          },
          sleepImpl: async () => {},
        }
      );

      expect(renameCalls).toBe(3);
    }
  });

  test("honors maxRenameAttempts and cleans up temp file even when unlink fails ENOENT", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "config.json");
    const tmpCalls: string[] = [];
    let renameCalls = 0;

    const error = new Error("rename fail") as NodeJS.ErrnoException;
    error.code = "EBUSY";

    await expect(
      writeTextFileAtomic(
        target,
        "{\"model\":\"gpt-5.2\"}\n",
        { maxRenameAttempts: 2 },
        {
          platform: "win32",
          fsImpl: {
            mkdir: fs.mkdir.bind(fs),
            writeFile: async (filePath: string, payload: string, opts?: any) => {
              tmpCalls.push(filePath);
              return fs.writeFile(filePath, payload, "utf-8");
            },
            rename: async () => {
              renameCalls += 1;
              throw error;
            },
            unlink: async () => {
              throw Object.assign(new Error("not found"), { code: "ENOENT" });
            },
          },
          sleepImpl: async () => {},
        }
      )
    ).rejects.toThrow("rename fail");

    expect(renameCalls).toBe(2);
    expect(tmpCalls.length).toBeGreaterThan(0);
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
