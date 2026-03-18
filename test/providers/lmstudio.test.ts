import { describe, expect, mock, test } from "bun:test";

import { parseChildModelRef } from "../../src/models/childModelRouting";
import { getProviderCatalog } from "../../src/providers/connectionCatalog";
import {
  prepareLmStudioModelMetadataForInference,
  selectDefaultLmStudioModel,
} from "../../src/providers/lmstudio/catalog";
import {
  DEFAULT_LM_STUDIO_BASE_URL,
  listLmStudioModels,
} from "../../src/providers/lmstudio/client";
import type { LmStudioModel } from "../../src/providers/lmstudio/types";
import { AGENT_ROLE_DEFINITIONS } from "../../src/server/agents/roles";
import { routeAgentConfig } from "../../src/server/agents/modelRouter";
import type { ConnectionStore } from "../../src/store/connections";

import { makeConfig } from "./helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStore(overrides: Partial<ConnectionStore["services"]> = {}): ConnectionStore {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    services: {
      ...overrides,
    },
  };
}

function lmModel(overrides: Partial<LmStudioModel> & Pick<LmStudioModel, "key">): LmStudioModel {
  return {
    type: "llm",
    publisher: "local",
    key: overrides.key,
    display_name: overrides.display_name ?? `${overrides.key} Display`,
    loaded_instances: overrides.loaded_instances ?? [],
    max_context_length: overrides.max_context_length ?? 32768,
    capabilities: overrides.capabilities ?? {
      vision: false,
      trained_for_tool_use: false,
    },
    size_bytes: overrides.size_bytes ?? 1,
    architecture: overrides.architecture ?? "llama",
    format: overrides.format ?? "gguf",
    params_string: overrides.params_string ?? null,
    quantization: overrides.quantization ?? null,
    description: overrides.description ?? null,
  };
}

describe("lmstudio provider", () => {
  test("lists models through the native LM Studio /api/v1/models endpoint", async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_LM_STUDIO_BASE_URL}/api/v1/models`);
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer lmstudio-token");
      return jsonResponse({
        models: [lmModel({ key: "local/qwen-2.5" })],
      });
    });

    const result = await listLmStudioModels({
      baseUrl: `${DEFAULT_LM_STUDIO_BASE_URL}/v1/`,
      apiKey: "lmstudio-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.key)).toEqual(["local/qwen-2.5"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("selectDefaultLmStudioModel prefers already-loaded llms and ignores embeddings", () => {
    const selected = selectDefaultLmStudioModel([
      {
        ...lmModel({ key: "local/embedder" }),
        type: "embedding",
      },
      lmModel({ key: "local/zeta" }),
      lmModel({
        key: "local/alpha",
        loaded_instances: [{ id: "inst-1", config: { context_length: 4096 } }],
      }),
    ], DEFAULT_LM_STUDIO_BASE_URL);

    expect(selected.key).toBe("local/alpha");
  });

  test("getProviderCatalog returns live LM Studio llms and uses a stored optional token", async () => {
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer stored-token");
      return jsonResponse({
        models: [
          {
            ...lmModel({ key: "local/embedder" }),
            type: "embedding",
          },
          lmModel({ key: "local/beta" }),
          lmModel({
            key: "local/alpha",
            loaded_instances: [{ id: "inst-1", config: { context_length: 8192 } }],
            capabilities: { vision: true, trained_for_tool_use: true },
          }),
        ],
      });
    });

    const catalog = await getProviderCatalog({
      readStore: async () => makeStore({
        lmstudio: {
          service: "lmstudio",
          mode: "api_key",
          apiKey: "stored-token",
          updatedAt: new Date().toISOString(),
        },
      }),
      readCodexAuthMaterialImpl: async () => null,
      lmstudioFetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const entry = catalog.all.find((provider) => provider.id === "lmstudio");
    expect(entry).toBeDefined();
    expect(entry?.models.map((model) => model.id)).toEqual(["local/alpha", "local/beta"]);
    expect(entry?.defaultModel).toBe("local/alpha");
    expect(entry?.state).toBe("ready");
    expect(catalog.connected).toContain("lmstudio");
  });

  test("getProviderCatalog surfaces unreachable LM Studio instances without crashing", async () => {
    const catalog = await getProviderCatalog({
      readStore: async () => makeStore(),
      readCodexAuthMaterialImpl: async () => null,
      lmstudioFetchImpl: mock(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    const entry = catalog.all.find((provider) => provider.id === "lmstudio");
    expect(entry?.models).toEqual([]);
    expect(entry?.defaultModel).toBe("");
    expect(entry?.state).toBe("unreachable");
    expect(entry?.message).toContain("LM Studio");
    expect(catalog.connected).not.toContain("lmstudio");
  });

  test("prepareLmStudioModelMetadataForInference reuses loaded context when no override is requested", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      models: [
        lmModel({
          key: "local/qwen-2.5",
          loaded_instances: [{ id: "inst-1", config: { context_length: 4096 } }],
        }),
      ],
    }));

    const prepared = await prepareLmStudioModelMetadataForInference({
      modelId: "local/qwen-2.5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(prepared.metadata.effectiveContextLength).toBe(4096);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("prepareLmStudioModelMetadataForInference loads an unloaded model with an explicit context length", async () => {
    const calls: string[] = [];
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input)}`);
      if (String(input).endsWith("/api/v1/models")) {
        return jsonResponse({ models: [lmModel({ key: "local/qwen-2.5" })] });
      }
      return jsonResponse({
        type: "llm",
        instance_id: "inst-2",
        load_time_seconds: 0.5,
        status: "loaded",
        load_config: {
          context_length: 8192,
        },
      });
    });

    const prepared = await prepareLmStudioModelMetadataForInference({
      modelId: "local/qwen-2.5",
      providerOptions: {
        lmstudio: {
          contextLength: 8192,
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(prepared.metadata.loaded).toBe(true);
    expect(prepared.metadata.effectiveContextLength).toBe(8192);
    expect(calls).toEqual([
      "GET http://localhost:1234/api/v1/models",
      "POST http://localhost:1234/api/v1/models/load",
    ]);
  });

  test("prepareLmStudioModelMetadataForInference reloads on context mismatch by default", async () => {
    const logLines: string[] = [];
    const calls: string[] = [];
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input)}`);
      if (String(input).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [
            lmModel({
              key: "local/qwen-2.5",
              loaded_instances: [{ id: "inst-1", config: { context_length: 4096 } }],
            }),
          ],
        });
      }
      if (String(input).endsWith("/api/v1/models/unload")) {
        return jsonResponse({ status: "ok" });
      }
      return jsonResponse({
        type: "llm",
        instance_id: "inst-2",
        load_time_seconds: 0.5,
        status: "loaded",
        load_config: {
          context_length: 8192,
        },
      });
    });

    const prepared = await prepareLmStudioModelMetadataForInference({
      modelId: "local/qwen-2.5",
      providerOptions: {
        lmstudio: {
          contextLength: 8192,
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (line) => {
        logLines.push(line);
      },
    });

    expect(prepared.metadata.effectiveContextLength).toBe(8192);
    expect(calls).toEqual([
      "GET http://localhost:1234/api/v1/models",
      "POST http://localhost:1234/api/v1/models/unload",
      "POST http://localhost:1234/api/v1/models/load",
    ]);
    expect(logLines.some((line) => line.includes("requested context length 8192 differs from loaded 4096"))).toBe(true);
  });

  test("prepareLmStudioModelMetadataForInference errors when the requested model is missing", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      models: [lmModel({ key: "local/other" })],
    }));

    await expect(
      prepareLmStudioModelMetadataForInference({
        modelId: "local/qwen-2.5",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('LM Studio model "local/qwen-2.5" is not available');
  });

  test("parseChildModelRef accepts explicit lmstudio model refs", () => {
    const parsed = parseChildModelRef("lmstudio:local/qwen-2.5", "google", "child model");
    expect(parsed.provider).toBe("lmstudio");
    expect(parsed.modelId).toBe("local/qwen-2.5");
    expect(parsed.ref).toBe("lmstudio:local/qwen-2.5");
  });

  test("routeAgentConfig accepts arbitrary same-provider lmstudio child model keys", () => {
    const parentConfig = makeConfig({
      provider: "lmstudio",
      model: "local/current",
      preferredChildModel: "local/current",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "lmstudio:local/current",
      knowledgeCutoff: "Unknown",
    });

    const routed = routeAgentConfig(parentConfig, {
      role: AGENT_ROLE_DEFINITIONS.worker,
      model: "local/qwen-2.5",
      connectedProviders: ["lmstudio"],
    });

    expect(routed.effectiveProvider).toBe("lmstudio");
    expect(routed.effectiveModel).toBe("local/qwen-2.5");
    expect(routed.config.model).toBe("local/qwen-2.5");
  });

  test("routeAgentConfig supports cross-provider LM Studio child targets", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-pro-preview",
      preferredChildModel: "gemini-3-pro-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "google:gemini-3-pro-preview",
      allowedChildModelRefs: ["lmstudio:local/qwen-2.5"],
    });

    const routed = routeAgentConfig(parentConfig, {
      role: AGENT_ROLE_DEFINITIONS.worker,
      model: "lmstudio:local/qwen-2.5",
      connectedProviders: ["google", "lmstudio"],
    });

    expect(routed.effectiveProvider).toBe("lmstudio");
    expect(routed.effectiveModel).toBe("local/qwen-2.5");
  });

  test("routeAgentConfig falls back cleanly when LM Studio is disconnected", () => {
    const parentConfig = makeConfig({
      provider: "lmstudio",
      model: "local/current",
      preferredChildModel: "local/current",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "lmstudio:local/current",
      knowledgeCutoff: "Unknown",
    });

    const routed = routeAgentConfig(parentConfig, {
      role: AGENT_ROLE_DEFINITIONS.worker,
      model: "local/qwen-2.5",
      connectedProviders: ["openai"],
    });

    expect(routed.effectiveProvider).toBe("lmstudio");
    expect(routed.effectiveModel).toBe("local/current");
    expect(routed.fallbackLine).toContain("LM Studio is not connected");
  });
});
