import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getProviderCatalog, listProviderCatalogEntries } from "../../src/providers/connectionCatalog";
import { getAiCoworkerPaths } from "../../src/connect";
import { PROVIDER_NAMES } from "../../src/types";

describe("providers/connectionCatalog", () => {
  test("catalog entries stay aligned with provider names and default-model map", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    const entryIds = payload.all.map((entry) => entry.id);
    expect(entryIds).toEqual(PROVIDER_NAMES);
    expect(payload.all).toEqual(listProviderCatalogEntries());
    expect(Object.keys(payload.default)).toEqual(PROVIDER_NAMES);
    for (const entry of payload.all) {
      expect(payload.default[entry.id]).toBe(entry.defaultModel);
    }
  });

  test("lists OpenCode providers in the provider catalog with the expected model sets", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.default["opencode-go"]).toBe("glm-5");
    expect(payload.all).toContainEqual({
      id: "opencode-go",
      name: "OpenCode Go",
      models: ["glm-5", "kimi-k2.5"],
      defaultModel: "glm-5",
    });
    expect(payload.default["opencode-zen"]).toBe("glm-5");
    expect(payload.all).toContainEqual({
      id: "opencode-zen",
      name: "OpenCode Zen",
      models: [
        "glm-5",
        "kimi-k2.5",
        "nemotron-3-super-free",
        "mimo-v2-flash-free",
        "big-pickle",
        "minimax-m2.5-free",
        "minimax-m2.5",
      ],
      defaultModel: "glm-5",
    });
  });

  test("connected providers exclude oauth_pending entries", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          openai: {
            service: "openai",
            mode: "api_key",
            apiKey: "sk-test",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
          anthropic: {
            service: "anthropic",
            mode: "oauth_pending",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
          "codex-cli": {
            service: "codex-cli",
            mode: "oauth",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
    });

    expect(payload.connected).toContain("openai");
    expect(payload.connected).toContain("codex-cli");
    expect(payload.connected).not.toContain("anthropic");
  });

  test("connected providers include codex-cli when Cowork auth exists even if connections.json is empty", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-cowork-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const authPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        version: 1,
        auth_mode: "chatgpt",
        issuer: "https://auth.openai.com",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        tokens: {
          access_token: "cowork-access-token",
          refresh_token: "cowork-refresh-token",
        },
      }),
      "utf-8",
    );

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.connected).toContain("codex-cli");
  });

  test("codex-cli only appears once in connected when both store oauth and cowork auth exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-codex-dedupe-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const authPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        version: 1,
        auth_mode: "chatgpt",
        issuer: "https://auth.openai.com",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        tokens: {
          access_token: "cowork-access-token",
          refresh_token: "cowork-refresh-token",
        },
      }),
      "utf-8",
    );

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "codex-cli": {
            service: "codex-cli",
            mode: "oauth",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
    });

    expect(payload.connected.filter((provider) => provider === "codex-cli")).toEqual(["codex-cli"]);
  });
});
