import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { resolveProviderToolApiKey } from "../src/tools/api-keys";
import type { ToolContext } from "../src/tools/context";

const ENV_VAR = "COWORK_TEST_TOOL_API_KEY_RESOLUTION";

function toolContext(userCoworkDir: string): ToolContext {
  return { config: { userCoworkDir } } as ToolContext;
}

async function withHome(run: (userCoworkDir: string) => Promise<void>): Promise<void> {
  const [tempRoot] = scratchRoots();
  if (!tempRoot) throw new Error("No platform scratch root is available");
  const home = await fs.mkdtemp(path.join(tempRoot, "tool-api-key-"));
  try {
    await run(path.join(home, ".cowork"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConnections(userCoworkDir: string, toolApiKeys: Record<string, string>) {
  const authDir = path.join(userCoworkDir, "auth");
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    path.join(authDir, "connections.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-10-05T00:00:00.000Z",
      services: {},
      toolApiKeys,
    }),
    "utf8",
  );
}

describe("resolveProviderToolApiKey", () => {
  const previous = process.env[ENV_VAR];

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = previous;
  });

  test("prefers a trimmed saved key over the environment", async () => {
    process.env[ENV_VAR] = "env-key";
    await withHome(async (userCoworkDir) => {
      await writeConnections(userCoworkDir, { exa: "  saved-key  " });
      await expect(
        resolveProviderToolApiKey(toolContext(userCoworkDir), "exa", ENV_VAR),
      ).resolves.toBe("saved-key");
    });
  });

  test("falls through a blank saved key and a missing store to a trimmed environment key", async () => {
    process.env[ENV_VAR] = "  env-key  ";
    await withHome(async (userCoworkDir) => {
      await writeConnections(userCoworkDir, { parallel: "   " });
      await expect(
        resolveProviderToolApiKey(toolContext(userCoworkDir), "parallel", ENV_VAR),
      ).resolves.toBe("env-key");
    });

    await withHome(async (userCoworkDir) => {
      await expect(
        resolveProviderToolApiKey(toolContext(userCoworkDir), "exa", ENV_VAR),
      ).resolves.toBe("env-key");
    });
  });

  test("uses the environment when the credential store cannot be read", async () => {
    process.env[ENV_VAR] = "env-key";
    await withHome(async (userCoworkDir) => {
      await fs.mkdir(path.join(userCoworkDir, "auth", "connections.json"), { recursive: true });
      await expect(
        resolveProviderToolApiKey(toolContext(userCoworkDir), "exa", ENV_VAR),
      ).resolves.toBe("env-key");
    });
  });

  test("returns undefined when neither a saved key nor the environment is set", async () => {
    delete process.env[ENV_VAR];
    await withHome(async (userCoworkDir) => {
      await expect(
        resolveProviderToolApiKey(toolContext(userCoworkDir), "exa", ENV_VAR),
      ).resolves.toBeUndefined();
    });

    process.env[ENV_VAR] = "   ";
    await withHome(async (userCoworkDir) => {
      await expect(
        resolveProviderToolApiKey(toolContext(userCoworkDir), "parallel", ENV_VAR),
      ).resolves.toBeUndefined();
    });
  });
});
