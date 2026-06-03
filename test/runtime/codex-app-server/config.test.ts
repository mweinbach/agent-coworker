import { describe, expect, test } from "bun:test";

import { resolveEffectiveCodexModel } from "../../../src/runtime/codexAppServer/config";

function modelListClient(models: unknown[]) {
  return {
    request: async (method: string) => {
      expect(method).toBe("model/list");
      return { data: models, nextCursor: null };
    },
  } as never;
}

describe("codex app-server model resolution", () => {
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
});
