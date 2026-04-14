import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getModel, loadConfig } from "../../src/config";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}

async function makeTmpDirs() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-bedrock-provider-"));
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { cwd, home };
}

describe("bedrock provider", () => {
  test("defaults to the curated Bedrock fallback model", async () => {
    const { cwd, home } = await makeTmpDirs();
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "bedrock" },
    });

    expect(cfg.provider).toBe("bedrock");
    expect(cfg.model).toBe("amazon.nova-lite-v1:0");
    expect(cfg.preferredChildModel).toBe("amazon.nova-lite-v1:0");
  });

  test("accepts arbitrary Bedrock model IDs and ARNs", async () => {
    const { cwd, home } = await makeTmpDirs();
    const customModelArn = "arn:aws:bedrock:us-east-1:123456789012:custom-model-deployment/abcd1234efgh";
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_PROVIDER: "bedrock",
        AGENT_MODEL: customModelArn,
      },
    });

    expect(cfg.provider).toBe("bedrock");
    expect(cfg.model).toBe(customModelArn);
    expect(cfg.preferredChildModel).toBe(customModelArn);
    expect(cfg.knowledgeCutoff).toBe("Unknown");
  });

  test("getModel returns a Bedrock model adapter", async () => {
    const { cwd, home } = await makeTmpDirs();
    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "bedrock" },
    });

    const model = getModel(cfg) as any;
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("amazon-bedrock.converse");
    expect(model.modelId).toBe("amazon.nova-lite-v1:0");
  });
});
