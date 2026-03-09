import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getProviderCatalog } from "../../src/providers/connectionCatalog";
import { getAiCoworkerPaths } from "../../src/connect";

describe("providers/connectionCatalog", () => {
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
});
