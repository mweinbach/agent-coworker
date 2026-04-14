import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths, writeConnectionStore } from "../../src/connect";
import {
  maskBedrockFieldValues,
  readBedrockCatalogSnapshot,
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
});
