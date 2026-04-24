import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ISSUER,
  clearCodexAuthMaterial,
  codexMaterialFromTokenResponse,
  decodeJwtPayload,
  ensureCodexAuthDirWritable,
  extractAccountIdFromClaims,
  extractEmailFromClaims,
  extractJwtExpiryMs,
  extractPlanTypeFromClaims,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
} from "../../src/providers/codex-auth";

function b64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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
        new Response(
          JSON.stringify({ access_token: makeJwt({ exp: 1_760_000_000 }), expires_in: 60 }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
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

  test("refreshCodexAuthMaterial keeps a newer on-disk token written by another process", async () => {
    const authDir = await makeTmpAuthDir();
    const authFile = path.join(authDir, "codex-cli", "auth.json");
    const newerAccessToken = makeJwt({ exp: 1_860_000_000, email: "newer@example.com" });
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(
      authFile,
      JSON.stringify(
        {
          version: 1,
          auth_mode: "chatgpt",
          issuer: CODEX_OAUTH_ISSUER,
          client_id: CODEX_OAUTH_CLIENT_ID,
          tokens: {
            access_token: newerAccessToken,
            refresh_token: "refresh-token-newer",
          },
          account: {
            email: "newer@example.com",
          },
          updated_at: "2026-03-11T18:00:01.000Z",
          last_refresh: "2026-03-11T18:00:01.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const staleMaterial = {
      file: authFile,
      issuer: CODEX_OAUTH_ISSUER,
      clientId: CODEX_OAUTH_CLIENT_ID,
      accessToken: makeJwt({ exp: 1_750_000_000, email: "stale@example.com" }),
      refreshToken: "refresh-token-stale",
      updatedAt: "2026-03-11T18:00:00.000Z",
    };

    const refreshed = await refreshCodexAuthMaterial({
      paths: { authDir },
      material: staleMaterial,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: makeJwt({ exp: 1_760_000_000, email: "refreshed@example.com" }),
            refresh_token: "refresh-token-refreshed",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    expect(refreshed.accessToken).toBe(newerAccessToken);
    expect(refreshed.refreshToken).toBe("refresh-token-newer");
    expect(refreshed.email).toBe("newer@example.com");

    const persisted = await readCodexAuthMaterial({ authDir });
    expect(persisted?.accessToken).toBe(newerAccessToken);
    expect(persisted?.refreshToken).toBe("refresh-token-newer");
    expect(persisted?.email).toBe("newer@example.com");
  });
});

describe("codex auth directory writability", () => {
  test("ensureCodexAuthDirWritable accepts a normal Cowork auth dir", async () => {
    const authDir = await makeTmpAuthDir();

    const dir = await ensureCodexAuthDirWritable({ authDir });

    expect(dir).toBe(path.join(authDir, "codex-cli"));
    await fs.access(dir);
  });

  test("ensureCodexAuthDirWritable surfaces a clear permission-denied error", async () => {
    const authDir = await makeTmpAuthDir();
    const denied = new Error("permission denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";

    await expect(
      ensureCodexAuthDirWritable(
        { authDir },
        {
          fsImpl: {
            mkdir: async () => undefined,
            chmod: async () => undefined,
            access: async () => {
              throw denied;
            },
            writeFile: async () => undefined,
            unlink: async () => undefined,
          },
        },
      ),
    ).rejects.toThrow(
      `Cowork cannot write Codex auth under ${path.join(authDir, "codex-cli")}: permission denied.`,
    );
  });

  test("ensureCodexAuthDirWritable ignores probe cleanup failures after a successful write", async () => {
    const authDir = await makeTmpAuthDir();
    const cleanupFailure = new Error("locked") as NodeJS.ErrnoException;
    cleanupFailure.code = "EPERM";

    await expect(
      ensureCodexAuthDirWritable(
        { authDir },
        {
          fsImpl: {
            mkdir: async () => undefined,
            chmod: async () => undefined,
            access: async () => undefined,
            writeFile: async () => undefined,
            unlink: async () => {
              throw cleanupFailure;
            },
          },
        },
      ),
    ).resolves.toBe(path.join(authDir, "codex-cli"));
  });
});

describe("readCodexAuthMaterial fallback behavior", () => {
  function makePaths(home: string): { authDir: string; rootDir: string } {
    return {
      authDir: path.join(home, ".cowork", "auth"),
      rootDir: path.join(home, ".cowork"),
    };
  }

  test("invalid cowork JSON is treated as missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-read-invalid-json-"));
    const paths = makePaths(home);
    const coworkPath = path.join(paths.authDir, "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(coworkPath), { recursive: true });
    await fs.writeFile(coworkPath, "{not-valid-json", "utf-8");

    await expect(readCodexAuthMaterial(paths)).resolves.toBeNull();
  });

  test("schema-invalid cowork auth falls back to the legacy Cowork auth shape", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-read-legacy-fallback-"));
    const paths = makePaths(home);
    const coworkPath = path.join(paths.authDir, "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(coworkPath), { recursive: true });
    await fs.writeFile(
      coworkPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 3600,
              email: "legacy@example.com",
            }),
            refresh_token: "legacy-refresh-token",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const material = await readCodexAuthMaterial(paths);
    expect(material).toBeTruthy();
    expect(material?.file).toBe(coworkPath);
    expect(material?.accessToken).toBeTruthy();
    expect(material?.refreshToken).toBe("legacy-refresh-token");
  });

  test("token claims override stale persisted account metadata", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-read-stale-account-"));
    const paths = makePaths(home);
    const coworkPath = path.join(paths.authDir, "codex-cli", "auth.json");
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "token@example.com",
    });
    const idToken = makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_token",
        chatgpt_plan_type: "pro",
      },
      "https://api.openai.com/profile": {
        email: "token@example.com",
      },
    });
    await fs.mkdir(path.dirname(coworkPath), { recursive: true });
    await fs.writeFile(
      coworkPath,
      JSON.stringify(
        {
          version: 1,
          auth_mode: "chatgpt",
          issuer: CODEX_OAUTH_ISSUER,
          client_id: CODEX_OAUTH_CLIENT_ID,
          tokens: {
            access_token: accessToken,
            refresh_token: "refresh-token",
            id_token: idToken,
          },
          account: {
            account_id: "acct_stale",
            email: "stale@example.com",
            plan_type: "free",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const material = await readCodexAuthMaterial(paths);

    expect(material?.accountId).toBe("acct_token");
    expect(material?.email).toBe("token@example.com");
    expect(material?.planType).toBe("pro");
  });

  test("ignores legacy external auth when Cowork auth is missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-import-legacy-"));
    const paths = makePaths(home);
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "legacy@example.com",
    });
    const idToken = makeJwt({
      iss: CODEX_OAUTH_ISSUER,
      email: "legacy@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_legacy" },
    });
    const legacyPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "legacy-refresh-token",
          id_token: idToken,
        },
      }),
      "utf-8",
    );

    await expect(readCodexAuthMaterial(paths)).resolves.toBeNull();
    await expect(
      fs.readFile(path.join(paths.authDir, "codex-cli", "auth.json"), "utf-8"),
    ).rejects.toThrow();
  });

  test("clearCodexAuthMaterial only clears Cowork auth and does not restore from legacy auth", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-block-legacy-"));
    const paths = makePaths(home);
    const coworkPath = path.join(paths.authDir, "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(coworkPath), { recursive: true });
    await fs.writeFile(
      coworkPath,
      JSON.stringify({
        version: 1,
        auth_mode: "chatgpt",
        tokens: {
          access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "cowork-refresh-token",
        },
      }),
      "utf-8",
    );

    const legacyPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "legacy-refresh-token",
        },
      }),
      "utf-8",
    );

    const cleared = await clearCodexAuthMaterial(paths);

    expect(cleared.removed).toBe(true);
    await expect(readCodexAuthMaterial(paths)).resolves.toBeNull();
    await expect(fs.readFile(coworkPath, "utf-8")).rejects.toThrow();
    await expect(fs.readFile(legacyPath, "utf-8")).resolves.toContain("legacy-refresh-token");
  });
});
