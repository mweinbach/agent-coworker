import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { getSavedProviderApiKey } from "../../src/config";
import { defaultModelForProvider } from "../../src/providers";
import { readCodexAppServerAccount } from "../../src/providers/codexAppServerAuth";
import { resolveGoogleInteractionsModel } from "../../src/runtime/googleInteractionsModel";
import { resolveGoogleApiKey } from "../../src/runtime/googleNative/client";
import { runOpenAiNativeResponseStep } from "../../src/runtime/openaiNativeResponses";
import { resolveOpenAiResponsesModel } from "../../src/runtime/openaiResponsesModel";
import { resolvePiModel } from "../../src/runtime/pi/modelResolution";
import type { RuntimeRunTurnParams } from "../../src/runtime/types";
import type { AgentConfig, ProviderName } from "../../src/types";
import { makeConfig, makeTmpDirs, withEnv, writeJson } from "./helpers";

const temporaryDirectories: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function authFixture(provider: ProviderName) {
  const directories = await makeTmpDirs();
  temporaryDirectories.push(directories.tmp);
  const config = makeConfig({
    provider,
    model: defaultModelForProvider(provider),
    workingDirectory: directories.cwd,
    projectCoworkDir: path.join(directories.cwd, ".cowork"),
    userCoworkDir: path.join(directories.home, ".cowork"),
  });
  return { ...directories, config };
}

function params(config: AgentConfig): RuntimeRunTurnParams {
  return { config, system: "Test", messages: [], tools: {}, maxSteps: 1 };
}

async function saveKeys(home: string, keys: Partial<Record<ProviderName, string | null>>) {
  await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
    version: 1,
    updatedAt: timestamp,
    services: Object.fromEntries(
      Object.entries(keys).map(([service, apiKey]) => [
        service,
        {
          service,
          mode: apiKey === null ? "oauth_pending" : "api_key",
          ...(apiKey === null ? {} : { apiKey }),
          updatedAt: timestamp,
        },
      ]),
    ),
  });
}

const resolutionCases = [
  { provider: "openai", envKey: "OPENAI_API_KEY", resolve: resolveOpenAiResponsesModel },
  {
    provider: "google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    resolve: resolveGoogleInteractionsModel,
  },
  { provider: "anthropic", envKey: "ANTHROPIC_API_KEY", resolve: resolvePiModel },
  { provider: "baseten", envKey: "BASETEN_API_KEY", resolve: resolvePiModel },
  { provider: "together", envKey: "TOGETHER_API_KEY", resolve: resolvePiModel },
  { provider: "fireworks", envKey: "FIREWORKS_API_KEY", resolve: resolvePiModel },
  { provider: "firepass", envKey: "FIREPASS_API_KEY", resolve: resolvePiModel },
  { provider: "nvidia", envKey: "NVIDIA_API_KEY", resolve: resolvePiModel },
  { provider: "minimax", envKey: "MINIMAX_API_KEY", resolve: resolvePiModel },
  { provider: "opencode-go", envKey: "OPENCODE_API_KEY", resolve: resolvePiModel },
  { provider: "opencode-zen", envKey: "OPENCODE_ZEN_API_KEY", resolve: resolvePiModel },
] as const;

describe("runtime saved API key resolution", () => {
  for (const { provider, envKey, resolve } of resolutionCases) {
    test(`${provider} saved key overrides environment and observes store updates`, async () => {
      const { config, home } = await authFixture(provider);
      await saveKeys(home, { [provider]: "saved-key" });
      await withEnv("HOME", home, async () => {
        await withEnv(envKey, "environment-key", async () => {
          expect((await resolve(params(config))).apiKey).toBe("saved-key");
          await saveKeys(home, { [provider]: "updated-key" });
          expect((await resolve(params(config))).apiKey).toBe("updated-key");
        });
      });
    });

    test(`${provider} does not treat pending auth as a saved API key`, async () => {
      const { config, home } = await authFixture(provider);
      await saveKeys(home, { [provider]: null });
      await withEnv("HOME", home, async () => {
        await withEnv(envKey, "environment-key", async () => {
          const resolved = await resolve(params(config));
          if (provider === "google") {
            expect(resolveGoogleApiKey(resolved.apiKey)).toBe("environment-key");
          } else if (provider === "openai" || provider === "anthropic") {
            expect(resolved.apiKey).toBeUndefined();
          } else {
            expect(resolved.apiKey).toBe("environment-key");
          }
        });
      });
    });

    test(`${provider} leaves missing credentials unresolved`, async () => {
      const { config, home } = await authFixture(provider);
      await withEnv("HOME", home, async () => {
        await withEnv(envKey, undefined, async () => {
          expect((await resolve(params(config))).apiKey).toBeUndefined();
        });
      });
    });
  }

  test.each([
    [{ antigravity: "antigravity-key", google: "google-key" }, "antigravity-key", "google-key"],
    [{ antigravity: null, google: "google-key" }, "google-key", "google-key"],
    [{ antigravity: "antigravity-key", google: null }, "antigravity-key", "antigravity-key"],
  ] as const)(
    "candidate ordering and Google fallback: %j",
    async (keys, antigravityKey, googleKey) => {
      const { config, home } = await authFixture("google");
      await saveKeys(home, keys);
      await withEnv("HOME", home, async () => {
        expect(getSavedProviderApiKey(config, "antigravity")).toBe(antigravityKey);
        expect((await resolveGoogleInteractionsModel(params(config))).apiKey).toBe(googleKey);
      });
    },
  );

  test("Fireworks and Fire Pass saved keys remain isolated", async () => {
    const { config, home } = await authFixture("fireworks");
    await saveKeys(home, { fireworks: "fireworks-key", firepass: "firepass-key" });
    expect((await resolvePiModel(params(config))).apiKey).toBe("fireworks-key");
    expect(
      (
        await resolvePiModel(
          params({
            ...config,
            provider: "firepass",
            model: defaultModelForProvider("firepass"),
          }),
        )
      ).apiKey,
    ).toBe("firepass-key");
  });

  test.each([
    ["fireworks", "https://api.fireworks.ai/inference/v1"],
    ["firepass", "https://api.fireworks.ai/inference/v1"],
    ["minimax", "https://api.minimax.io/v1"],
  ] as const)("%s resolves its supported inference endpoint", async (provider, baseUrl) => {
    const { config } = await authFixture(provider);
    const { model } = await resolvePiModel(params(config));
    expect(model).toMatchObject({
      id: config.model,
      provider,
      api: "openai-completions",
      baseUrl,
    });
  });

  test("session auth home wins over process HOME and workspace stores", async () => {
    const { config, home, cwd } = await authFixture("openai");
    const processHome = path.join(cwd, "process-home");
    await saveKeys(home, { openai: "session-key" });
    await saveKeys(processHome, { openai: "process-key" });
    await saveKeys(cwd, { openai: "workspace-key" });
    await writeJson(path.join(cwd, ".agent", "auth", "connections.json"), {
      version: 1,
      updatedAt: timestamp,
      services: {},
    });
    await withEnv("HOME", processHome, async () => {
      expect((await resolveOpenAiResponsesModel(params(config))).apiKey).toBe("session-key");
      await fs.rm(path.join(home, ".cowork", "auth", "connections.json"));
      expect((await resolveOpenAiResponsesModel(params(config))).apiKey).toBeUndefined();
      expect(
        (
          await resolveOpenAiResponsesModel(
            params({
              ...config,
              userCoworkDir: path.join(cwd, ".agent"),
              skillsDirs: [],
            }),
          )
        ).apiKey,
      ).toBe("process-key");
    });
  });

  for (const { provider, resolve } of resolutionCases) {
    test.each([
      ["invalid JSON", "{invalid"],
      ["legacy apiKeys", JSON.stringify({ apiKeys: { openai: "legacy-key" } })],
      ["invalid services", JSON.stringify({ version: 1, updatedAt: timestamp, services: [] })],
    ])(`${provider} rejects malformed canonical store: %s`, async (_name, raw) => {
      const { config, home } = await authFixture(provider);
      await saveKeys(home, { [provider]: "old-key" });
      const connectionsFile = path.join(home, ".cowork", "auth", "connections.json");
      await fs.writeFile(connectionsFile, raw);
      await withEnv("HOME", home, async () => {
        await expect(resolve(params(config))).rejects.toThrow(/connection store/i);
      });
      expect(await fs.readFile(connectionsFile, "utf-8")).toBe(raw);
    });
  }

  test("Codex never borrows OpenAI keys or imports external Codex auth", async () => {
    const { config, home } = await authFixture("codex-cli");
    await saveKeys(home, { openai: "openai-key", "codex-cli": "ignored-key" });
    await writeJson(path.join(home, ".codex", "auth.json"), {
      auth_mode: "chatgpt",
      tokens: { access_token: "external-token", refresh_token: "external-refresh" },
    });
    await withEnv("HOME", home, async () => {
      expect(getSavedProviderApiKey(config, "codex-cli")).toBeUndefined();
      expect(
        await readCodexAppServerAccount({
          codexHome: path.join(home, ".cowork", "auth", "codex-cli"),
        }),
      ).toEqual({ account: null, requiresOpenaiAuth: true });
      expect(await fs.exists(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"))).toBe(
        false,
      );
    });
  });

  test.each(["saved", "environment"] as const)(
    "OpenAI request uses %s credentials",
    async (source) => {
      const { config, home } = await authFixture("openai");
      await saveKeys(home, { openai: source === "saved" ? "saved-key" : null });
      const originalFetch = globalThis.fetch;
      const requests: Headers[] = [];
      globalThis.fetch = (async (input, init) => {
        requests.push(new Headers(input instanceof Request ? input.headers : init?.headers));
        return new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "response-auth",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch;
      try {
        await withEnv("HOME", home, async () => {
          await withEnv("OPENAI_API_KEY", "environment-key", async () => {
            const resolved = await resolveOpenAiResponsesModel(params(config));
            await runOpenAiNativeResponseStep({
              provider: "openai",
              ...resolved,
              systemPrompt: "Test",
              piMessages: [],
              tools: [],
              streamOptions: {},
            });
            expect(requests).toHaveLength(1);
            expect(requests[0]?.get("authorization")).toBe(`Bearer ${source}-key`);
          });
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
