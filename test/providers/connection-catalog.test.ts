import { describe, expect, test } from "bun:test";

import { getProviderCatalog } from "../../src/providers/connectionCatalog";

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
});
