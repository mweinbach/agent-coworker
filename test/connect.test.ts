import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  connectProvider,
  getAiCoworkerPaths,
  isOauthCliProvider,
  maskApiKey,
  readConnectionStore,
} from "../src/connect";

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-connect-test-"));
}

describe("connect helpers", () => {
  test("maskApiKey masks long keys", () => {
    expect(maskApiKey("sk-1234567890abcdef")).toBe("sk-1...cdef");
  });

  test("maskApiKey masks short keys with stars", () => {
    expect(maskApiKey("abc")).toBe("****");
    expect(maskApiKey("abcd")).toBe("****");
  });

  test("isOauthCliProvider returns true for oauth cli providers", () => {
    expect(isOauthCliProvider("gemini-cli")).toBe(true);
    expect(isOauthCliProvider("codex-cli")).toBe(true);
    expect(isOauthCliProvider("claude-code")).toBe(true);
  });

  test("isOauthCliProvider returns false for non-oauth providers", () => {
    expect(isOauthCliProvider("openai")).toBe(false);
    expect(isOauthCliProvider("google")).toBe(false);
    expect(isOauthCliProvider("anthropic")).toBe(false);
  });
});

describe("connectProvider", () => {
  test("stores api key mode when key is provided", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "openai",
      apiKey: "sk-openai-test-1234",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("api_key");
    expect(result.maskedApiKey).toBe("sk-o...1234");

    const store = await readConnectionStore(paths);
    const entry = store.services.openai;
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("api_key");
    expect(entry?.apiKey).toBe("sk-openai-test-1234");
  });

  test("stores oauth_pending for non-oauth provider when key is missing", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "google",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth_pending");

    const store = await readConnectionStore(paths);
    const entry = store.services.google;
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("oauth_pending");
    expect(entry?.apiKey).toBeUndefined();
  });

  test("gemini-cli oauth in pipe mode requires interactive tty", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const runner = async () => ({ exitCode: 0 as number | null, signal: null as NodeJS.Signals | null });
    const result = await connectProvider({
      provider: "gemini-cli",
      paths,
      oauthStdioMode: "pipe",
      oauthRunner: runner,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("requires a TTY");
  });

  test("gemini-cli marks oauth when cached credentials exist", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const geminiCreds = path.join(home, ".gemini", "oauth_creds.json");
    await fs.mkdir(path.dirname(geminiCreds), { recursive: true });
    await fs.writeFile(geminiCreds, JSON.stringify({ access_token: "x" }), "utf-8");

    const result = await connectProvider({
      provider: "gemini-cli",
      paths,
      oauthStdioMode: "pipe",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(result.message).toContain("Existing OAuth credentials detected");
    expect(result.oauthCredentialsFile).toBe(path.join(home, ".cowork", "auth", "gemini-cli", "oauth_creds.json"));

    // Credentials are also persisted under ~/.cowork/auth for centralized storage.
    const persisted = await fs.readFile(path.join(home, ".cowork", "auth", "gemini-cli", "oauth_creds.json"), "utf-8");
    expect(persisted).toContain("access_token");

    const store = await readConnectionStore(paths);
    const entry = store.services["gemini-cli"];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("oauth");
    expect(entry?.apiKey).toBeUndefined();
  });

  test("codex-cli oauth command succeeds and stores oauth mode", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const seen: Array<{ command: string; args: string[]; stdioMode: string }> = [];

    const result = await connectProvider({
      provider: "codex-cli",
      paths,
      oauthStdioMode: "pipe",
      oauthRunner: async ({ command, args, stdioMode }) => {
        seen.push({ command, args, stdioMode });

        // Simulate Codex writing its OAuth credentials to ~/.codex/auth.json
        const codexCreds = path.join(home, ".codex", "auth.json");
        await fs.mkdir(path.dirname(codexCreds), { recursive: true });
        await fs.writeFile(codexCreds, JSON.stringify({ access_token: "x" }), "utf-8");

        return { exitCode: 0, signal: null };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(result.oauthCommand).toBe("codex login");
    expect(seen).toEqual([{ command: "codex", args: ["login"], stdioMode: "pipe" }]);
    expect(result.oauthCredentialsFile).toBe(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"));

    const persisted = await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8");
    expect(persisted).toContain("access_token");

    const store = await readConnectionStore(paths);
    const entry = store.services["codex-cli"];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("oauth");
  });

  test("oauth failure returns error and does not store connection", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "claude-code",
      paths,
      oauthRunner: async () => ({ exitCode: 2, signal: null }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("OAuth sign-in failed");

    const store = await readConnectionStore(paths);
    expect(store.services["claude-code"]).toBeUndefined();
  });
});
