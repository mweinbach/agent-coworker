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
  readCodexAuthMaterial,
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

  test("refreshCodexAuthMaterial preserves existing refresh/id tokens when omitted by refresh response", async () => {
    const authDir = await makeTmpAuthDir();
    const material = {
      file: path.join(authDir, "codex-cli", "auth.json"),
      issuer: CODEX_OAUTH_ISSUER,
      clientId: CODEX_OAUTH_CLIENT_ID,
      accessToken: makeJwt({ exp: 1_750_000_000 }),
      refreshToken: "refresh-token-existing",
      idToken: makeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-existing",
          chatgpt_plan_type: "enterprise",
        },
        "https://api.openai.com/profile": {
          email: "existing@example.com",
        },
      }),
      accountId: "acct-existing",
      email: "existing@example.com",
      planType: "enterprise",
    };

    const refreshed = await refreshCodexAuthMaterial({
      paths: { authDir },
      material,
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: makeJwt({ exp: 1_760_000_000 }), expires_in: 60 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    expect(refreshed.refreshToken).toBe("refresh-token-existing");
    expect(refreshed.idToken).toBe(material.idToken);
    expect(refreshed.accountId).toBe("acct-existing");
    expect(refreshed.email).toBe("existing@example.com");
    expect(refreshed.planType).toBe("enterprise");

    const persistedRaw = await fs.readFile(path.join(authDir, "codex-cli", "auth.json"), "utf-8");
    const persisted = JSON.parse(persistedRaw);
    expect(persisted.tokens.refresh_token).toBe("refresh-token-existing");
    expect(persisted.tokens.id_token).toBe(material.idToken);
    expect(persisted.account.account_id).toBe("acct-existing");
    expect(persisted.account.email).toBe("existing@example.com");
    expect(persisted.account.plan_type).toBe("enterprise");
  });
});

describe("readCodexAuthMaterial fallback behavior", () => {
  function makePaths(home: string): { authDir: string; rootDir: string } {
    return {
      authDir: path.join(home, ".cowork", "auth"),
      rootDir: path.join(home, ".cowork"),
    };
  }

  test("invalid cowork JSON is treated as missing when legacy migration is disabled", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-read-invalid-json-"));
    const paths = makePaths(home);
    const coworkPath = path.join(paths.authDir, "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(coworkPath), { recursive: true });
    await fs.writeFile(coworkPath, "{not-valid-json", "utf-8");

    await expect(readCodexAuthMaterial(paths, { migrateLegacy: false })).resolves.toBeNull();
  });

  test("schema-invalid cowork auth falls back to legacy auth migration", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-read-legacy-fallback-"));
    const paths = makePaths(home);
    const coworkPath = path.join(paths.authDir, "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(coworkPath), { recursive: true });
    await fs.writeFile(
      coworkPath,
      JSON.stringify(
        {
          version: 0,
          auth_mode: "chatgpt",
          tokens: { refresh_token: "cowork-refresh-only" },
        },
        null,
        2
      ),
      "utf-8"
    );

    const legacyAccessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "legacy@example.com" });
    const legacyPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: legacyAccessToken,
            refresh_token: "legacy-refresh-token",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const material = await readCodexAuthMaterial(paths, { migrateLegacy: true });
    expect(material).toBeTruthy();
    expect(material?.file).toBe(coworkPath);
    expect(material?.accessToken).toBe(legacyAccessToken);
    expect(material?.refreshToken).toBe("legacy-refresh-token");

    const migrated = JSON.parse(await fs.readFile(coworkPath, "utf-8")) as Record<string, any>;
    expect(migrated.version).toBe(1);
    expect(migrated.tokens?.access_token).toBe(legacyAccessToken);
    expect(migrated.tokens?.refresh_token).toBe("legacy-refresh-token");
  });
});
