import { describe, expect, test } from "bun:test";

import { jsonRpcMiscNotificationSchemas } from "../src/server/jsonrpc/schema.misc";

const skillEntry = {
  name: "documents",
  path: "/skills/documents/SKILL.md",
  source: "user" as const,
  enabled: true,
  triggers: ["pdf"],
  description: "Document skill",
};

describe("misc JSON-RPC notification schemas", () => {
  test("workspace/listChanged is strict about revision", () => {
    expect(jsonRpcMiscNotificationSchemas["workspace/listChanged"].parse({ revision: 0 })).toEqual({
      revision: 0,
    });
    expect(
      jsonRpcMiscNotificationSchemas["workspace/listChanged"].safeParse({
        revision: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      jsonRpcMiscNotificationSchemas["workspace/listChanged"].safeParse({ revision: -1 }).success,
    ).toBe(false);
    expect(
      jsonRpcMiscNotificationSchemas["workspace/listChanged"].safeParse({ revision: 1.5 }).success,
    ).toBe(false);
  });

  test("log, todos, and error notifications keep required fields and allow extras", () => {
    expect(
      jsonRpcMiscNotificationSchemas["cowork/log"].parse({
        type: "log",
        line: "ready",
        extra: "ok",
      }),
    ).toEqual({
      type: "log",
      line: "ready",
      extra: "ok",
    });
    expect(
      jsonRpcMiscNotificationSchemas["cowork/todos"].safeParse({ type: "todos" }).success,
    ).toBe(false);
    expect(
      jsonRpcMiscNotificationSchemas.error.parse({
        type: "error",
        message: "boom",
        code: "internal",
        source: "server",
        extra: true,
      }),
    ).toMatchObject({ extra: true });
    expect(
      jsonRpcMiscNotificationSchemas.error.safeParse({
        type: "error",
        message: "boom",
        code: "internal",
      }).success,
    ).toBe(false);
  });

  test("control events accept known catalog types and reject unknown ones", () => {
    expect(
      jsonRpcMiscNotificationSchemas["cowork/control/event"].parse({
        type: "skills_list",
        skills: [skillEntry],
      }),
    ).toMatchObject({ type: "skills_list" });

    expect(
      jsonRpcMiscNotificationSchemas["cowork/control/event"].safeParse({
        type: "skills_catalog",
        catalog: {
          scopes: [],
          effectiveSkills: [],
          installations: [],
        },
      }).success,
    ).toBe(false);

    expect(
      jsonRpcMiscNotificationSchemas["cowork/control/event"].parse({
        type: "skills_catalog",
        catalog: {
          scopes: [],
          effectiveSkills: [],
          installations: [],
        },
        mutationBlocked: false,
      }),
    ).toMatchObject({ type: "skills_catalog", mutationBlocked: false });

    expect(
      jsonRpcMiscNotificationSchemas["cowork/control/event"].safeParse({
        type: "not_a_control_event",
        skills: [],
      }).success,
    ).toBe(false);
  });
});
