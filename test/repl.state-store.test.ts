import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getStoredSessionForCwd, setStoredSessionForCwd } from "../src/cli/repl/stateStore";

let testHome = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function cliStatePath(): string {
  return path.join(testHome, ".cowork", "state", "cli-state.json");
}

describe("cli repl state store", () => {
  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-cli-state-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    if (!testHome) return;
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  });

  test("getStoredSessionForCwd recovers from malformed JSON", async () => {
    await fs.mkdir(path.dirname(cliStatePath()), { recursive: true });
    await fs.writeFile(cliStatePath(), "{ not-valid-json", "utf-8");

    await expect(getStoredSessionForCwd("/tmp/project")).resolves.toBeNull();
  });

  test("getStoredSessionForCwd recovers from invalid schema", async () => {
    await fs.mkdir(path.dirname(cliStatePath()), { recursive: true });
    await fs.writeFile(
      cliStatePath(),
      JSON.stringify(
        {
          version: 2,
          lastSessionByCwd: {
            "/tmp/project": 123,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await expect(getStoredSessionForCwd("/tmp/project")).resolves.toBeNull();
  });

  test("setStoredSessionForCwd rewrites malformed state with normalized data", async () => {
    await fs.mkdir(path.dirname(cliStatePath()), { recursive: true });
    await fs.writeFile(cliStatePath(), "{oops", "utf-8");

    await setStoredSessionForCwd("./project", "session-123");

    const raw = JSON.parse(await fs.readFile(cliStatePath(), "utf-8")) as Record<string, any>;
    const expectedCwd = path.resolve("./project");
    expect(raw.version).toBe(1);
    expect(raw.lastSessionByCwd?.[expectedCwd]).toBe("session-123");
  });

  test("uses USERPROFILE when HOME is not set", async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = testHome;

    await setStoredSessionForCwd("./windows-project", "session-win");

    const raw = JSON.parse(await fs.readFile(cliStatePath(), "utf-8")) as Record<string, any>;
    expect(raw.lastSessionByCwd?.[path.resolve("./windows-project")]).toBe("session-win");
  });
});
