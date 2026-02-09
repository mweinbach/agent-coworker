import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../src/connect";
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

    const runnerCalls: Array<{ command: string; args: string[] }> = [];
    const runner = async ({ command, args }: { command: string; args: string[] }) => {
      runnerCalls.push({ command, args });
      if (command === "codex") {
        return { exitCode: 0, signal: null, stdout: "Logged in using ChatGPT\n", stderr: "" };
      }
      // Avoid real Claude calls during this test.
      if (command === "claude") {
        return { exitCode: 1, signal: null, stdout: "", stderr: "not logged in" };
      }
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

    expect(runnerCalls).toContainEqual({ command: "codex", args: ["login", "status"] });
  });

  test("codex-cli: userinfo failure but codex login status ok still verifies", async () => {
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
      if (command === "codex") return { exitCode: 0, signal: null, stdout: "Logged in using ChatGPT\n", stderr: "" };
      if (command === "claude") return { exitCode: 1, signal: null, stdout: "", stderr: "not logged in" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "" };
    };

    const fetchImpl = async () => new Response("boom", { status: 500 });

    const statuses = await getProviderStatuses({ paths, runner: runner as any, fetchImpl: fetchImpl as any });
    const codex = statuses.find((s) => s.provider === "codex-cli");
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(true);
    expect(codex?.account?.email).toBe("jwt@example.com");
    expect(codex?.message).toContain("Codex CLI logged in");
  });

  test("claude-code: verified via claude CLI + extracts identity from credentials file when present", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const credsPath = path.join(paths.authDir, "claude-code", "credentials.json");
    await fs.mkdir(path.dirname(credsPath), { recursive: true });
    await fs.writeFile(credsPath, JSON.stringify({ email: "c@example.com", name: "Claude User" }), "utf-8");

    const runner = async ({ command }: { command: string }) => {
      if (command === "claude") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
          stderr: "",
        };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "" };
    };

    const statuses = await getProviderStatuses({ paths, runner: runner as any, fetchImpl: fetch as any });
    const claude = statuses.find((s) => s.provider === "claude-code");
    expect(claude).toBeDefined();
    expect(claude?.authorized).toBe(true);
    expect(claude?.verified).toBe(true);
    expect(claude?.mode).toBe("oauth");
    expect(claude?.account?.email).toBe("c@example.com");
    expect(claude?.account?.name).toBe("Claude User");
  });

  test("claude-code: loads identity via keychain creds + OAuth profile", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const runner = async ({ command, args }: { command: string; args: string[] }) => {
      if (command === "claude") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
          stderr: "",
        };
      }
      if (command === "security") {
        // Simulate finding keychain credentials (do not include real tokens in tests).
        if (args.includes("find-generic-password")) {
          return { exitCode: 0, signal: null, stdout: JSON.stringify({ accessToken: "test-access-token" }), stderr: "" };
        }
        return { exitCode: 1, signal: null, stdout: "", stderr: "unsupported" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unknown" };
    };

    const fetchImpl = async (url: any, init?: any) => {
      const u = String(url);
      if (u === "https://api.anthropic.com/api/oauth/profile") {
        expect(init?.headers?.authorization).toBe("Bearer test-access-token");
        return new Response(JSON.stringify({ account: { email: "c@example.com", display_name: "Claude User" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const statuses = await getProviderStatuses({ paths, runner: runner as any, fetchImpl: fetchImpl as any });
    const claude = statuses.find((s) => s.provider === "claude-code");
    expect(claude).toBeDefined();
    expect(claude?.authorized).toBe(true);
    expect(claude?.verified).toBe(true);
    expect(claude?.mode).toBe("oauth");
    expect(claude?.account?.email).toBe("c@example.com");
    expect(claude?.account?.name).toBe("Claude User");
  });
});
