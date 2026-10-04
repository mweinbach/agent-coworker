import { describe, expect, test } from "bun:test";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const s = jsonRpcControlRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("skills, plugins, and marketplace request schema rejects", () => {
  test("skills install uses project|global and rejects blank names or extras", () => {
    const install = s["cowork/skills/install"];
    expect(
      install.parse({ sourceInput: "https://example.test/skill", targetScope: "project" }),
    ).toEqual({
      sourceInput: "https://example.test/skill",
      targetScope: "project",
    });
    rejectsAll(install, [
      { sourceInput: "https://example.test/skill", targetScope: "workspace" },
      { sourceInput: "https://example.test/skill", targetScope: "user" },
      { sourceInput: "https://example.test/skill", targetScope: "project", extra: true },
    ]);
    rejectsAll(s["cowork/skills/read"], [{ skillName: "   " }]);
    rejectsAll(s["cowork/skills/disable"], [{ skillName: "review", extra: true }]);
  });

  test("plugins install uses workspace|user and rejects the skills install scopes", () => {
    const install = s["cowork/plugins/install"];
    expect(
      install.parse({ sourceInput: "https://example.test/plugin", targetScope: "user" }),
    ).toEqual({
      sourceInput: "https://example.test/plugin",
      targetScope: "user",
    });
    rejectsAll(install, [
      { sourceInput: "https://example.test/plugin", targetScope: "project" },
      { sourceInput: "https://example.test/plugin", targetScope: "global" },
    ]);
    rejectsAll(s["cowork/plugins/install/preview"], [
      { sourceInput: "https://example.test/plugin", targetScope: "project" },
    ]);
    rejectsAll(s["cowork/plugins/read"], [
      { pluginId: " " },
      { pluginId: "figma", scope: "global" },
    ]);
  });

  test("marketplace add/remove reject blank ids and extras", () => {
    const add = s["cowork/marketplaces/add"];
    expect(add.parse({ sourceInput: "  https://example.test/market  " })).toEqual({
      sourceInput: "https://example.test/market",
    });
    rejectsAll(add, [
      { sourceInput: "   " },
      { sourceInput: "https://example.test/market", extra: true },
    ]);
    rejectsAll(s["cowork/marketplaces/remove"], [{ id: " " }, { id: "acme", extra: true }]);
    rejectsAll(s["cowork/marketplaces/detail"], [{ id: "   " }]);
  });

  test("skill improvement restore requires a skill name and rejects extras", () => {
    const run = s["cowork/skills/improvement/run"];
    expect(run.parse({ skillName: "  review  " })).toEqual({ skillName: "review" });
    expect(run.parse({})).toEqual({});
    rejectsAll(run, [{ extra: true }]);
    rejectsAll(s["cowork/skills/improvement/restore"], [
      {},
      { skillName: "   " },
      { skillName: "review", extra: true },
    ]);
  });
});
