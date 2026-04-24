import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bedrock } from "@aws-sdk/client-bedrock";
import { getModel, loadConfig } from "../../src/config";
import { getAiCoworkerPaths, writeConnectionStore } from "../../src/connect";
import { refreshBedrockDiscoveryCache } from "../../src/providers/bedrockShared";

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

function mockBedrockDiscovery(modelId = "custom.bedrock-model-v1") {
  const originalListFoundationModels = Bedrock.prototype.listFoundationModels;
  const originalListInferenceProfiles = Bedrock.prototype.listInferenceProfiles;
  const originalListCustomModelDeployments = Bedrock.prototype.listCustomModelDeployments;
  const originalListProvisionedModelThroughputs = Bedrock.prototype.listProvisionedModelThroughputs;
  const originalListImportedModels = Bedrock.prototype.listImportedModels;

  Bedrock.prototype.listFoundationModels = async () =>
    ({
      modelSummaries: [
        {
          modelId,
          modelName: "Custom Bedrock Model",
          responseStreamingSupported: true,
          inputModalities: ["TEXT"],
        } as any,
      ],
    }) as any;
  Bedrock.prototype.listInferenceProfiles = async () => ({ inferenceProfileSummaries: [] }) as any;
  Bedrock.prototype.listCustomModelDeployments = async () =>
    ({ modelDeploymentSummaries: [] }) as any;
  Bedrock.prototype.listProvisionedModelThroughputs = async () =>
    ({ provisionedModelSummaries: [] }) as any;
  Bedrock.prototype.listImportedModels = async () => ({ modelSummaries: [] }) as any;

  return () => {
    Bedrock.prototype.listFoundationModels = originalListFoundationModels;
    Bedrock.prototype.listInferenceProfiles = originalListInferenceProfiles;
    Bedrock.prototype.listCustomModelDeployments = originalListCustomModelDeployments;
    Bedrock.prototype.listProvisionedModelThroughputs = originalListProvisionedModelThroughputs;
    Bedrock.prototype.listImportedModels = originalListImportedModels;
  };
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

  test("resolves the default Bedrock model from the requested homedir context", async () => {
    const { cwd, home } = await makeTmpDirs();
    const envHome = path.join(path.dirname(home), "env-home");
    await fs.mkdir(envHome, { recursive: true });
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        bedrock: {
          service: "bedrock",
          mode: "credentials",
          methodId: "aws_default",
          values: {},
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const restoreBedrockDiscovery = mockBedrockDiscovery();
    try {
      await refreshBedrockDiscoveryCache({ paths, env: {} as NodeJS.ProcessEnv });

      const cfg = await loadConfig({
        cwd,
        homedir: home,
        builtInDir: repoRoot(),
        env: {
          AGENT_PROVIDER: "bedrock",
          HOME: envHome,
        },
      });

      expect(cfg.provider).toBe("bedrock");
      expect(cfg.model).toBe("custom.bedrock-model-v1");
      expect(cfg.preferredChildModel).toBe("custom.bedrock-model-v1");
    } finally {
      restoreBedrockDiscovery();
    }
  });

  test("accepts arbitrary Bedrock model IDs and ARNs", async () => {
    const { cwd, home } = await makeTmpDirs();
    const customModelArn =
      "arn:aws:bedrock:us-east-1:123456789012:custom-model-deployment/abcd1234efgh";
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
