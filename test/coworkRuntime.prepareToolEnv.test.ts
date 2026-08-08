import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  COWORK_RUNTIME_INSTRUCTIONS_HEADING,
  prepareCoworkRuntimeToolEnv,
  renderCoworkRuntimeInstructions,
} from "../src/coworkRuntime";
import { scratchRoots } from "../src/platform/sandbox";

async function tempHome(label: string): Promise<string> {
  return await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", `cowork-prepare-tool-env-${label}-`));
}

describe("prepareCoworkRuntimeToolEnv", () => {
  test("strips COWORK_RUNTIME_* keys when no runtime is installed", async () => {
    const home = await tempHome("missing");
    try {
      const env = await prepareCoworkRuntimeToolEnv({
        homedir: home,
        env: {
          PATH: "/usr/bin",
          COWORK_RUNTIME_DIR: undefined,
          COWORK_RUNTIME_NODE: "/stale/node",
          COWORK_RUNTIME_NODE_MODULES: "/stale/node_modules",
          OTHER: "keep",
        },
      });

      expect(env.PATH).toBe("/usr/bin");
      expect(env.OTHER).toBe("keep");
      expect(env.COWORK_RUNTIME_NODE).toBeUndefined();
      expect(env.COWORK_RUNTIME_NODE_MODULES).toBeUndefined();
      expect(Object.keys(env).some((key) => key.toUpperCase().startsWith("COWORK_RUNTIME_"))).toBe(
        false,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("fail-closes untrusted explicit runtime dirs and strips runtime keys", async () => {
    const home = await tempHome("untrusted");
    const bogusRuntime = path.join(home, "bogus-runtime");
    await fs.mkdir(bogusRuntime, { recursive: true });
    const logs: string[] = [];

    try {
      const env = await prepareCoworkRuntimeToolEnv({
        homedir: home,
        env: {
          PATH: "/usr/bin",
          COWORK_RUNTIME_DIR: bogusRuntime,
          COWORK_RUNTIME_NODE: "/stale/node",
          COWORK_RUNTIME_PYTHON: "/stale/python",
          KEEP: "yes",
        },
        log: (line) => logs.push(line),
      });

      expect(env.PATH).toBe("/usr/bin");
      expect(env.KEEP).toBe("yes");
      expect(env.COWORK_RUNTIME_DIR).toBeUndefined();
      expect(env.COWORK_RUNTIME_NODE).toBeUndefined();
      expect(env.COWORK_RUNTIME_PYTHON).toBeUndefined();
      expect(logs.some((line) => line.includes(`Blocked untrusted Cowork runtime at ${bogusRuntime}`))).toBe(
        true,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("honors COWORK_DISABLE_RUNTIME without mutating the env", async () => {
    const env = await prepareCoworkRuntimeToolEnv({
      env: {
        COWORK_DISABLE_RUNTIME: "1",
        COWORK_RUNTIME_NODE: "/kept/node",
      },
    });

    expect(env.COWORK_DISABLE_RUNTIME).toBe("1");
    expect(env.COWORK_RUNTIME_NODE).toBe("/kept/node");
  });
});

describe("renderCoworkRuntimeInstructions", () => {
  test("returns null without COWORK_RUNTIME_NODE_MODULES", () => {
    expect(
      renderCoworkRuntimeInstructions({
        COWORK_RUNTIME_NODE: "/runtime/node",
      }),
    ).toBeNull();
  });

  test("renders runtime heading and optional tool paths", () => {
    const text = renderCoworkRuntimeInstructions({
      COWORK_RUNTIME_NODE_MODULES: "/runtime/node_modules",
      COWORK_RUNTIME_NODE: "/runtime/bin/node",
      COWORK_RUNTIME_PYTHON: "/runtime/bin/python",
      COWORK_RUNTIME_SOFFICE: "/runtime/bin/soffice",
    });

    expect(text).toContain(COWORK_RUNTIME_INSTRUCTIONS_HEADING);
    expect(text).toContain("`/runtime/bin/node`");
    expect(text).toContain("`/runtime/bin/python`");
    expect(text).toContain("`/runtime/bin/soffice`");
    expect(text).toContain("@oai/artifact-tool");
  });
});
