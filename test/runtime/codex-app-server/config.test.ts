import { describe, expect, test } from "bun:test";

import {
  codexDeveloperInstructions,
  codexDynamicToolSpecs,
  normalizeEffort,
  normalizeSummaryForModel,
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

describe("codex app-server developer tool boundary", () => {
  test("does not advertise unavailable root, workflow, MCP, or clarification tools", () => {
    const dynamicTools = ["skill", "todoWrite"].map((name) => ({
      name,
      description: name,
      inputSchema: {},
    }));
    const instructions = codexDeveloperInstructions("Restricted child system", {}, dynamicTools);

    expect(instructions).toContain("`skill`");
    expect(instructions).toContain("`todoWrite`");
    expect(instructions).not.toContain("workflow");
    expect(instructions).not.toContain("session/thread management");
    expect(instructions).not.toContain("AskUserQuestion");
    expect(instructions).not.toContain("cowork_mcp__");
    expect(instructions).toContain("Never call the native `request_user_input` tool");
  });

  test("advertises only root capabilities actually exposed as dynamic tools", () => {
    const names = [
      "workflow",
      "createTask",
      "spawnAgent",
      "list_threads",
      "AskUserQuestion",
      "cowork_mcp__docs__search",
    ];
    const dynamicTools = names.map((name) => ({
      name,
      description: name,
      inputSchema: {},
    }));
    const instructions = codexDeveloperInstructions("Root system", {}, dynamicTools);

    for (const name of names) expect(instructions).toContain(`\`${name}\``);
    expect(instructions).toContain("For user clarification");
    expect(instructions).toContain("Cowork MCP tools are exposed");
    expect(instructions).toContain("Never call the native `request_user_input` tool");
  });
});

describe("codex app-server dynamic tool registration", () => {
  const tools = Object.fromEntries(
    ["read", "glob", "grep", "bash", "write", "edit", "webFetch", "skill"].map((name) => [
      name,
      {
        description: name,
        inputSchema: { type: "object", properties: {} },
        execute: () => name,
      },
    ]),
  );

  test("registers scoped file readers without exposing native execution tools", () => {
    const specs = codexDynamicToolSpecs(tools, { preserveScopedFileReadTools: true });

    expect(specs.map(({ name }) => name)).toEqual(["read", "glob", "grep", "skill"]);
  });

  test("keeps unscoped file access on the native tool boundary", () => {
    expect(codexDynamicToolSpecs(tools).map(({ name }) => name)).toEqual(["skill"]);
  });
});

describe("codex app-server model resolution", () => {
  test("passes the GPT-5.6 max effort through to app-server", () => {
    expect(normalizeEffort("max")).toBe("max");
  });

  test("omits reasoning summaries for Spark and keeps them for summary-capable models", () => {
    expect(normalizeSummaryForModel("gpt-5.3-codex-spark", "detailed")).toBeUndefined();
    expect(normalizeSummaryForModel("gpt-5.3-codex-spark", "auto")).toBeUndefined();
    expect(normalizeSummaryForModel("gpt-5.3-codex-spark", undefined)).toBeUndefined();

    expect(normalizeSummaryForModel("gpt-5.4", "detailed")).toBe("detailed");
    expect(normalizeSummaryForModel("gpt-5.4", "concise")).toBe("concise");
    expect(normalizeSummaryForModel("gpt-5.4", "unsupported")).toBeUndefined();
    expect(normalizeSummaryForModel("gpt-5.4", undefined)).toBeUndefined();
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
