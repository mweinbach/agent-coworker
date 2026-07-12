import { describe, expect, test } from "bun:test";

import {
  normalizeEffort,
  resolveEffectiveCodexModel,
} from "../../../src/runtime/codexAppServer/config";

function modelListClient(models: unknown[]) {
  return {
    request: async (method: string) => {
      expect(method).toBe("model/list");
      return { data: models, nextCursor: null };
    },
  } as never;
}

describe("codex app-server model resolution", () => {
  test("passes the GPT-5.6 max effort through to app-server", () => {
    expect(normalizeEffort("max")).toBe("max");
  });

  test("honors an explicitly selected GPT-5.6 tier when available", async () => {
    const effective = await resolveEffectiveCodexModel(
      modelListClient([
        { id: "gpt-5.6-sol", model: "gpt-5.6-sol", isDefault: false },
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra", isDefault: true },
      ]),
      "gpt-5.6-sol",
    );

    expect(effective).toBe("gpt-5.6-sol");
  });

  test("accepts configured future models when app-server reports them", async () => {
    const effective = await resolveEffectiveCodexModel(
      modelListClient([
        {
          id: "future-model",
          model: "future-model",
          displayName: "Future Model",
          isDefault: true,
        },
      ]),
      "future-model",
    );

    expect(effective).toBe("future-model");
  });

  test("falls back to the live app-server default when configured model is unavailable", async () => {
    const logs: string[] = [];
    const effective = await resolveEffectiveCodexModel(
      modelListClient([
        {
          id: "future-model",
          model: "future-model",
          displayName: "Future Model",
          isDefault: true,
        },
      ]),
      "gpt-5.4",
      (line) => logs.push(line),
    );

    expect(effective).toBe("future-model");
    expect(logs.join("\n")).toContain(
      'model "gpt-5.4" is not available from the resolved app-server',
    );
  });

  test("falls back to the first live model when none is marked default", async () => {
    const effective = await resolveEffectiveCodexModel(
      modelListClient([
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
        { id: "gpt-5.6-luna", model: "gpt-5.6-luna" },
      ]),
      "gpt-5.6-sol",
    );

    expect(effective).toBe("gpt-5.6-terra");
  });

  test("fails explicitly when app-server reports no models", async () => {
    await expect(resolveEffectiveCodexModel(modelListClient([]), "gpt-5.6-sol")).rejects.toThrow(
      "Codex app-server did not report any available models",
    );
  });
});
