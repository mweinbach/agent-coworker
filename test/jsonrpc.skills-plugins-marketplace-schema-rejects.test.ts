import { describe, expect, test } from "bun:test";

import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("skills, plugins, and marketplace request schema rejects", () => {
  test("skills install uses project|global and rejects blank names or extras", () => {
    const install = jsonRpcControlRequestSchemas["cowork/skills/install"];
    const read = jsonRpcControlRequestSchemas["cowork/skills/read"];
    const disable = jsonRpcControlRequestSchemas["cowork/skills/disable"];
    expect(
      install.parse({ sourceInput: "https://example.test/skill", targetScope: "project" }),
    ).toEqual({
      sourceInput: "https://example.test/skill",
      targetScope: "project",
    });
    rejects(install, { sourceInput: "https://example.test/skill", targetScope: "workspace" });
    rejects(install, { sourceInput: "https://example.test/skill", targetScope: "user" });
    rejects(install, {
      sourceInput: "https://example.test/skill",
      targetScope: "project",
      extra: true,
    });
    rejects(read, { skillName: "   " });
    rejects(disable, { skillName: "review", extra: true });
  });

  test("plugins install uses workspace|user and rejects the skills install scopes", () => {
    const install = jsonRpcControlRequestSchemas["cowork/plugins/install"];
    const preview = jsonRpcControlRequestSchemas["cowork/plugins/install/preview"];
    const read = jsonRpcControlRequestSchemas["cowork/plugins/read"];
    expect(
      install.parse({ sourceInput: "https://example.test/plugin", targetScope: "user" }),
    ).toEqual({
      sourceInput: "https://example.test/plugin",
      targetScope: "user",
    });
    rejects(install, { sourceInput: "https://example.test/plugin", targetScope: "project" });
    rejects(install, { sourceInput: "https://example.test/plugin", targetScope: "global" });
    rejects(preview, { sourceInput: "https://example.test/plugin", targetScope: "project" });
    rejects(read, { pluginId: " " });
    rejects(read, { pluginId: "figma", scope: "global" });
  });

  test("marketplace add/remove reject blank ids and extras", () => {
    const add = jsonRpcControlRequestSchemas["cowork/marketplaces/add"];
    const remove = jsonRpcControlRequestSchemas["cowork/marketplaces/remove"];
    const detail = jsonRpcControlRequestSchemas["cowork/marketplaces/detail"];
    expect(add.parse({ sourceInput: "  https://example.test/market  " })).toEqual({
      sourceInput: "https://example.test/market",
    });
    rejects(add, { sourceInput: "   " });
    rejects(add, { sourceInput: "https://example.test/market", extra: true });
    rejects(remove, { id: " " });
    rejects(remove, { id: "acme", extra: true });
    rejects(detail, { id: "   " });
  });

  test("skill improvement restore requires a skill name and rejects extras", () => {
    const run = jsonRpcControlRequestSchemas["cowork/skills/improvement/run"];
    const restore = jsonRpcControlRequestSchemas["cowork/skills/improvement/restore"];
    expect(run.parse({ skillName: "  review  " })).toEqual({ skillName: "review" });
    expect(run.parse({})).toEqual({});
    rejects(run, { extra: true });
    rejects(restore, {});
    rejects(restore, { skillName: "   " });
    rejects(restore, { skillName: "review", extra: true });
  });
});
