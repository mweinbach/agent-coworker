import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bedrock } from "@aws-sdk/client-bedrock";
import { getAiCoworkerPaths, writeConnectionStore } from "../../src/connect";

import {
  bedrockClientConfig,
  maskBedrockFieldValues,
  readBedrockCatalogSnapshot,
  refreshBedrockDiscoveryCache,
  resolveBedrockAuthConfig,
} from "../../src/providers/bedrockShared";

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-bedrock-shared-"));
}

describe("providers/bedrockShared", () => {
  test("masks Bedrock credential values while preserving non-secret fields", () => {
    const masked = maskBedrockFieldValues({
      accessKeyId: "AKIASECRET1234",
      secretAccessKey: "secret-value-1234",
      sessionToken: "session-token-1234",
      apiKey: "bedrock-api-key-1234",
      region: "us-west-2",
      profile: "sandbox",
    });

    expect(masked.region).toBe("us-west-2");
    expect(masked.profile).toBe("sandbox");
    expect(masked.accessKeyId).toBe("AKIA...1234");
    expect(masked.secretAccessKey).toBe("secr...1234");
    expect(masked.sessionToken).toBe("sess...1234");
    expect(masked.apiKey).toBe("bedr...1234");
  });

  test("resolves saved Bedrock auth config from the global connection store", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        bedrock: {
          service: "bedrock",
          mode: "credentials",
          methodId: "aws_profile",
          values: {
            profile: "sandbox",
            region: "us-west-2",
          },
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const auth = await resolveBedrockAuthConfig({ paths, env: {} as NodeJS.ProcessEnv });
    expect(auth).toEqual({
      methodId: "aws_profile",
      source: "saved",
      profile: "sandbox",
      region: "us-west-2",
    });
  });

  test("keeps aws_profile on the Bedrock client config for profile-scoped discovery", () => {
    const client = new Bedrock(
      bedrockClientConfig({
        methodId: "aws_profile",
        source: "saved",
        profile: "sandbox",
        region: "us-west-2",
      }),
    );

    expect(client.config.profile).toBe("sandbox");
    expect(typeof client.config.region).toBe("function");
    expect(typeof client.config.credentialDefaultProvider).toBe("function");
  });

  test("does not force a default region for saved aws_default auth", async () => {
    const home = await makeTmpHome();
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

    const auth = await resolveBedrockAuthConfig({ paths, env: {} as NodeJS.ProcessEnv });
    expect(auth).toEqual({
      methodId: "aws_default",
      source: "saved",
    });
  });

  test("recognizes a standard shared-config default AWS profile as ambient Bedrock auth", async () => {
    const home = await makeTmpHome();
    const awsDir = path.join(home, ".aws");
    await fs.mkdir(awsDir, { recursive: true });
    await fs.writeFile(
      path.join(awsDir, "credentials"),
      "[default]\naws_access_key_id = AKIADEFAULT1234\naws_secret_access_key = secret-default-1234\n",
      "utf-8",
    );
    await fs.writeFile(path.join(awsDir, "config"), "[default]\nregion = us-west-2\n", "utf-8");

    const auth = await resolveBedrockAuthConfig({
      paths: getAiCoworkerPaths({ homedir: home }),
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    expect(auth).toEqual({
      methodId: "aws_default",
      source: "env",
    });
  });

  test("recognizes EC2/IMDS-backed ambient auth as aws_default", async () => {
    const auth = await resolveBedrockAuthConfig({
      env: {
        HOME: await makeTmpHome(),
        AWS_EC2_METADATA_DISABLED: "false",
      } as NodeJS.ProcessEnv,
    });
    expect(auth).toEqual({
      methodId: "aws_default",
      source: "env",
    });
  });

  test("returns curated fallback catalog state when Bedrock is not configured", async () => {
    const home = await makeTmpHome();
    const snapshot = await readBedrockCatalogSnapshot({
      paths: getAiCoworkerPaths({ homedir: home }),
      env: {} as NodeJS.ProcessEnv,
    });

    expect(snapshot.connected).toBe(false);
    expect(snapshot.defaultModel).toBe("amazon.nova-lite-v1:0");
    expect(snapshot.models.some((model) => model.id === "amazon.nova-lite-v1:0")).toBe(true);
    expect(snapshot.message).toContain("Configure Amazon Bedrock credentials");
  });

  test("filters non-streaming foundation models during Bedrock discovery", async () => {
    const home = await makeTmpHome();
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

    const originalListFoundationModels = Bedrock.prototype.listFoundationModels;
    const originalListInferenceProfiles = Bedrock.prototype.listInferenceProfiles;
    const originalListCustomModelDeployments = Bedrock.prototype.listCustomModelDeployments;
    const originalListProvisionedModelThroughputs =
      Bedrock.prototype.listProvisionedModelThroughputs;
    const originalListImportedModels = Bedrock.prototype.listImportedModels;

    Bedrock.prototype.listFoundationModels = async () =>
      ({
        modelSummaries: [
          {
            modelId: "streaming-model",
            modelName: "Streaming Model",
            responseStreamingSupported: true,
            inputModalities: ["TEXT"],
          } as any,
          {
            modelId: "non-streaming-model",
            modelName: "Non Streaming Model",
            responseStreamingSupported: false,
            inputModalities: ["TEXT"],
          } as any,
        ],
      }) as any;
    Bedrock.prototype.listInferenceProfiles = async () =>
      ({ inferenceProfileSummaries: [] }) as any;
    Bedrock.prototype.listCustomModelDeployments = async () =>
      ({ modelDeploymentSummaries: [] }) as any;
    Bedrock.prototype.listProvisionedModelThroughputs = async () =>
      ({ provisionedModelSummaries: [] }) as any;
    Bedrock.prototype.listImportedModels = async () => ({ modelSummaries: [] }) as any;

    try {
      const snapshot = await refreshBedrockDiscoveryCache({ paths, env: {} as NodeJS.ProcessEnv });
      expect(snapshot.models.map((model) => model.id)).toEqual(["streaming-model"]);
    } finally {
      Bedrock.prototype.listFoundationModels = originalListFoundationModels;
      Bedrock.prototype.listInferenceProfiles = originalListInferenceProfiles;
      Bedrock.prototype.listCustomModelDeployments = originalListCustomModelDeployments;
      Bedrock.prototype.listProvisionedModelThroughputs = originalListProvisionedModelThroughputs;
      Bedrock.prototype.listImportedModels = originalListImportedModels;
    }
  });

  test("drops derived Bedrock entries whose backing model was filtered out", async () => {
    const home = await makeTmpHome();
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

    const originalListFoundationModels = Bedrock.prototype.listFoundationModels;
    const originalListInferenceProfiles = Bedrock.prototype.listInferenceProfiles;
    const originalListCustomModelDeployments = Bedrock.prototype.listCustomModelDeployments;
    const originalListProvisionedModelThroughputs =
      Bedrock.prototype.listProvisionedModelThroughputs;
    const originalListImportedModels = Bedrock.prototype.listImportedModels;

    Bedrock.prototype.listFoundationModels = async () =>
      ({
        modelSummaries: [
          {
            modelId: "non-streaming-model",
            modelName: "Non Streaming Model",
            responseStreamingSupported: false,
            inputModalities: ["TEXT"],
            modelArn: "arn:aws:bedrock:us-east-1::foundation-model/non-streaming-model",
          } as any,
        ],
      }) as any;
    Bedrock.prototype.listInferenceProfiles = async () =>
      ({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "profile-1",
            inferenceProfileName: "Profile One",
            status: "ACTIVE",
            models: [
              { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/non-streaming-model" },
            ],
          } as any,
        ],
      }) as any;
    Bedrock.prototype.listProvisionedModelThroughputs = async () =>
      ({
        provisionedModelSummaries: [
          {
            provisionedModelArn: "arn:aws:bedrock:us-east-1:123:provisioned-model/prov-1",
            provisionedModelName: "Provisioned One",
            status: "InService",
            foundationModelArn: "arn:aws:bedrock:us-east-1::foundation-model/non-streaming-model",
            modelArn: "arn:aws:bedrock:us-east-1::foundation-model/non-streaming-model",
          } as any,
        ],
      }) as any;
    Bedrock.prototype.listCustomModelDeployments = async () =>
      ({ modelDeploymentSummaries: [] }) as any;
    Bedrock.prototype.listImportedModels = async () => ({ modelSummaries: [] }) as any;

    try {
      const snapshot = await refreshBedrockDiscoveryCache({ paths, env: {} as NodeJS.ProcessEnv });
      expect(snapshot.models).toEqual([]);
    } finally {
      Bedrock.prototype.listFoundationModels = originalListFoundationModels;
      Bedrock.prototype.listInferenceProfiles = originalListInferenceProfiles;
      Bedrock.prototype.listCustomModelDeployments = originalListCustomModelDeployments;
      Bedrock.prototype.listProvisionedModelThroughputs = originalListProvisionedModelThroughputs;
      Bedrock.prototype.listImportedModels = originalListImportedModels;
    }
  });
});
