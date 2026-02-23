import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ISSUER,
  codexMaterialFromTokenResponse,
  decodeJwtPayload,
  extractAccountIdFromClaims,
  extractEmailFromClaims,
  extractJwtExpiryMs,
  extractPlanTypeFromClaims,
  refreshCodexAuthMaterial,
} from "../../src/providers/codex-auth";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

async function makeTmpAuthDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
}

describe("codex auth claim parsing", () => {
  test("decodeJwtPayload returns payload object", () => {
    const token = makeJwt({ sub: "user_1", email: "a@example.com" });
    const decoded = decodeJwtPayload(token);
    expect(decoded).toEqual({
      sub: "user_1",
      email: "a@example.com",
    });
  });

  test("extractJwtExpiryMs accepts numeric-string exp", () => {
    const token = makeJwt({ exp: "1710000000" });
    expect(extractJwtExpiryMs(token)).toBe(1_710_000_000_000);
  });

  test("extractAccountIdFromClaims resolves direct, nested, and fallback fields", () => {
    expect(
      extractAccountIdFromClaims({
        chatgpt_account_id: "acct-direct",
      }),
    ).toBe("acct-direct");

    expect(
      extractAccountIdFromClaims({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-auth" },
      }),
    ).toBe("acct-auth");

    expect(
      extractAccountIdFromClaims({
        organizations: [{ id: "org-1" }],
      }),
    ).toBe("org-1");

    expect(
      extractAccountIdFromClaims({
        organization_id: "org-fallback",
      }),
    ).toBe("org-fallback");
  });

  test("extractEmailFromClaims and extractPlanTypeFromClaims read nested namespaces", () => {
    expect(
      extractEmailFromClaims({
        "https://api.openai.com/profile": { email: "nested@example.com" },
      }),
    ).toBe("nested@example.com");

    expect(
      extractPlanTypeFromClaims({
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
      }),
    ).toBe("pro");
  });
});

describe("codex auth token response parsing", () => {
  test("codexMaterialFromTokenResponse parses claims and string expires_in", () => {
    const accessToken = makeJwt({
      exp: "1750000000",
      account_id: "acct-access",
      email: "access@example.com",
      chatgpt_plan_type: "plus",
    });
    const idToken = makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-id",
        chatgpt_plan_type: "pro",
      },
      "https://api.openai.com/profile": {
        email: "id@example.com",
      },
    });
    const material = codexMaterialFromTokenResponse("auth.json", {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: "refresh-1",
      expires_in: "120",
    });

    expect(material.file).toBe("auth.json");
    expect(material.issuer).toBe(CODEX_OAUTH_ISSUER);
    expect(material.clientId).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(material.accessToken).toBe(accessToken);
    expect(material.idToken).toBe(idToken);
    expect(material.refreshToken).toBe("refresh-1");
    expect(material.accountId).toBe("acct-id");
    expect(material.email).toBe("id@example.com");
    expect(material.planType).toBe("pro");
    expect(material.expiresAtMs).toBeDefined();
  });

  test("refreshCodexAuthMaterial rejects invalid refresh payload schema", async () => {
    const authDir = await makeTmpAuthDir();
    const material = {
      file: path.join(authDir, "codex-cli", "auth.json"),
      issuer: CODEX_OAUTH_ISSUER,
      clientId: CODEX_OAUTH_CLIENT_ID,
      accessToken: makeJwt({ exp: 1_750_000_000 }),
      refreshToken: "refresh-token",
    };

    await expect(
      refreshCodexAuthMaterial({
        paths: { authDir },
        material,
        fetchImpl: async () =>
          new Response(JSON.stringify({ refresh_token: "missing-access-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ).rejects.toThrow("Codex token refresh response missing access_token.");
  });
});
