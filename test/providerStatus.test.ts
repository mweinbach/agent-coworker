import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths, writeConnectionStore } from "../src/connect";
import { getProviderStatuses } from "../src/providerStatus";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-provider-status-test-"));
}

describe("getProviderStatuses", () => {
  test("includes masked provider/tool API keys in google status", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        google: {
          service: "google",
          mode: "api_key",
          apiKey: "goog-secret-1234",
          updatedAt: new Date().toISOString(),
        },
      },
      toolApiKeys: {
        exa: "exa-secret-5678",
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const google = statuses.find((s) => s.provider === "google");
    expect(google).toBeDefined();
    expect(google?.savedApiKeyMasks?.api_key).toBe("goog...1234");
    expect(google?.savedApiKeyMasks?.exa_api_key).toBe("exa-...5678");
  });

  test("includes masked Exa key even when google provider key is not connected", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {},
      toolApiKeys: {
        exa: "exa-secret-5678",
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const google = statuses.find((s) => s.provider === "google");
    expect(google).toBeDefined();
    expect(google?.authorized).toBe(false);
    expect(google?.mode).toBe("missing");
    expect(google?.savedApiKeyMasks?.api_key).toBeUndefined();
    expect(google?.savedApiKeyMasks?.exa_api_key).toBe("exa-...5678");
  });

  test("codex-cli: verified via OIDC userinfo + shows name/email", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const iss = "https://auth.example.com";
    const idToken = makeJwt({ iss, email: "jwt@example.com" });
    const accessToken = "access-token";

    const codexAuth = {
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: accessToken },
    };
    const codexAuthPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fs.writeFile(codexAuthPath, JSON.stringify(codexAuth), "utf-8");

    const runner = async ({ command }: { command: string }) => {
      if (command === "claude") return { exitCode: 1, signal: null, stdout: "", stderr: "not logged in" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "unknown" };
    };

    const fetchImpl = async (url: any, init?: any) => {
      const u = String(url);
      if (u === `${iss}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ userinfo_endpoint: `${iss}/userinfo` }), { status: 200 });
      }
      if (u === `${iss}/userinfo`) {
        expect(init?.headers?.authorization).toBe(`Bearer ${accessToken}`);
        return new Response(JSON.stringify({ email: "user@example.com", name: "Example User" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const statuses = await getProviderStatuses({ paths, runner: runner as any, fetchImpl: fetchImpl as any });
    const codex = statuses.find((s) => s.provider === "codex-cli");
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(true);
    expect(codex?.mode).toBe("oauth");
    expect(codex?.account?.email).toBe("user@example.com");
    expect(codex?.account?.name).toBe("Example User");
  });

  test("codex-cli: userinfo failure keeps credentials authorized but unverified", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const iss = "https://auth.example.com";
    const idToken = makeJwt({ iss, email: "jwt@example.com" });
    const accessToken = "access-token";
    const codexAuthPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fs.writeFile(
      codexAuthPath,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: accessToken } }),
      "utf-8"
    );

    const runner = async ({ command }: { command: string }) => {
      if (command === "claude") return { exitCode: 1, signal: null, stdout: "", stderr: "not logged in" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "" };
    };

    const fetchImpl = async () => new Response("boom", { status: 500 });

    const statuses = await getProviderStatuses({ paths, runner: runner as any, fetchImpl: fetchImpl as any });
    const codex = statuses.find((s) => s.provider === "codex-cli");
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(false);
    expect(codex?.account?.email).toBe("jwt@example.com");
    expect(codex?.message).toContain("verification failed");
  });

});
