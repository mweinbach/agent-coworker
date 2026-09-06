import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { handleServerRequest } from "../src/runtime/codexAppServer/serverRequests";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import { makeTmpDirs } from "./providers/helpers";
import { makeConfig } from "./runtime/codex-app-server/helpers";

const workspaces: string[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function makeParams(): Promise<RuntimeRunTurnParams> {
  const { tmp, cwd: workspace } = await makeTmpDirs();
  workspaces.push(tmp);
  await fs.mkdir(path.join(workspace, "assigned"));
  return {
    config: makeConfig(workspace),
    system: "",
    messages: [],
    tools: {},
    maxSteps: 1,
    yolo: true,
    assertCanMutate: async () => {},
    approveCommand: mock(async () => true),
  };
}

function approve(
  params: RuntimeRunTurnParams,
  kind: "fileChange" | "commandExecution",
  request: Record<string, unknown>,
) {
  return handleServerRequest(
    {
      id: "approval",
      method: `item/${kind}/requestApproval`,
      params: request,
    },
    params,
  );
}

describe("Codex native approval hard floors", () => {
  for (const yolo of [false, true]) {
    test(`configured read-only denies file grants before approval (yolo=${yolo})`, async () => {
      const params = await makeParams();
      params.config.sandbox = { mode: "read-only", network: true };
      params.yolo = yolo;
      expect(
        await approve(params, "fileChange", { grantRoot: params.config.workingDirectory }),
      ).toEqual({ decision: "decline" });
      expect(params.approveCommand).not.toHaveBeenCalled();
    });

    for (const restriction of [
      "read-only",
      "role",
      "scope",
      "network",
      "runtime-network",
    ] as const) {
      test(`${restriction} denies ambiguous command escalation (yolo=${yolo})`, async () => {
        const params = await makeParams();
        params.yolo = yolo;
        if (restriction === "read-only") {
          params.config.sandbox = { mode: "read-only", network: true };
        } else if (restriction === "role") {
          params.shellPolicy = "no_project_write";
        } else if (restriction === "scope") {
          params.agentTargetPaths = ["assigned"];
        } else if (restriction === "network") {
          params.config.sandbox = { mode: "workspace-write", network: false };
        } else {
          params.networkAllowed = false;
        }
        // Even a harmless-looking command does not attest that an approval
        // keeps the OS sandbox. Do not infer that from model-controlled text.
        expect(await approve(params, "commandExecution", { command: "echo ok" })).toEqual({
          decision: "decline",
        });
        expect(params.approveCommand).not.toHaveBeenCalled();
      });
    }
  }

  test.each([
    {},
    { grantRoot: ".." },
    { grantRoot: "." },
    { grantRoot: "assigned/.git/hooks" },
    { grantRoot: "assigned", paths: ["sibling.txt"] },
    { grantRoot: "assigned", files: [{ path: "sibling.txt" }] },
    { path: "assigned/file.txt" },
  ])("scoped file grants fail closed for ambiguous or escaping targets: %j", async (request) => {
    const params = await makeParams();
    params.agentTargetPaths = ["assigned"];
    expect(await approve(params, "fileChange", request)).toEqual({ decision: "decline" });
  });

  test("keeps an explicit in-scope file grant", async () => {
    const params = await makeParams();
    params.agentTargetPaths = ["assigned"];
    params.yolo = false;
    expect(
      await approve(params, "fileChange", {
        cwd: params.config.workingDirectory,
        grantRoot: "assigned",
        paths: ["assigned/file.txt"],
      }),
    ).toEqual({ decision: "accept" });
    expect(params.approveCommand).toHaveBeenCalledTimes(1);
  });

  test("rechecks a scoped grant after the approval wait", async () => {
    const params = await makeParams();
    const workspace = params.config.workingDirectory;
    params.agentTargetPaths = ["assigned"];
    params.yolo = false;
    params.approveCommand = async () => {
      await fs.symlink(workspace, path.join(workspace, "assigned", "alias"), "junction");
      return true;
    };
    expect(await approve(params, "fileChange", { grantRoot: "assigned/alias" })).toEqual({
      decision: "decline",
    });
  });

  test("preserves ordinary unrestricted approvals and user denial", async () => {
    const params = await makeParams();
    expect(await approve(params, "commandExecution", { command: "echo ok" })).toEqual({
      decision: "accept",
    });
    params.yolo = false;
    expect(await approve(params, "commandExecution", { command: "echo ok" })).toEqual({
      decision: "accept",
    });
    params.approveCommand = async () => false;
    expect(await approve(params, "commandExecution", { command: "echo ok" })).toEqual({
      decision: "decline",
    });
  });
});
