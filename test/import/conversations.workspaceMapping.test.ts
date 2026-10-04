import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  mapConversationWorkspace,
  validateWorkspaceMappingInput,
} from "../../src/import/conversations/workspaceMapping";
import { scratchRoots } from "../../src/platform/sandbox/policy";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "cowork-import-ws-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("conversation workspace mapping", () => {
  test("validateWorkspaceMappingInput fail-closes unknown existing workspaces and blank create paths", async () => {
    const workspaceDir = await makeTempDir();
    const workspaces = [{ id: "ws-1", name: "Project", path: workspaceDir }];

    for (const [mapping, error] of [
      [{ kind: "existing" as const, workspaceId: "missing" }, "Unknown workspace: missing"],
      [{ kind: "fallback" as const, workspaceId: "missing" }, "Unknown workspace: missing"],
      [{ kind: "create" as const, path: "   " }, "Workspace path is required."],
    ]) {
      expect(await validateWorkspaceMappingInput({ mapping, workspaces })).toEqual({ error });
    }
  });

  test("validateWorkspaceMappingInput rejects missing or non-directory create paths", async () => {
    const workspaceDir = await makeTempDir();
    const filePath = path.join(workspaceDir, "not-a-dir.txt");
    const missingPath = path.join(workspaceDir, "does-not-exist");
    await fs.writeFile(filePath, "nope");

    for (const target of [missingPath, filePath]) {
      expect(
        await validateWorkspaceMappingInput({
          mapping: { kind: "create", path: target, name: " Imported " },
          workspaces: [],
        }),
      ).toEqual({
        status: "missing",
        originalPath: target,
        reason: "path_missing",
      });
    }

    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "create", path: workspaceDir, name: " Imported " },
        workspaces: [],
      }),
    ).toEqual({
      status: "create",
      workspacePath: await fs.realpath(workspaceDir),
      name: "Imported",
    });
  });

  test("mapConversationWorkspace matches known directories and otherwise proposes create", async () => {
    const workspaceDir = await makeTempDir();
    const conversationDir = await makeTempDir();
    const workspaces = [{ id: "ws-1", name: "Project", path: workspaceDir }];
    const missingDir = path.join(workspaceDir, "missing");

    expect(await mapConversationWorkspace({ conversation: { cwd: "   " }, workspaces })).toEqual({
      status: "missing",
      originalPath: null,
      reason: "no_cwd",
    });
    expect(
      await mapConversationWorkspace({ conversation: { cwd: missingDir }, workspaces }),
    ).toEqual({
      status: "missing",
      originalPath: missingDir,
      reason: "path_missing",
    });
    expect(
      await mapConversationWorkspace({ conversation: { cwd: workspaceDir }, workspaces }),
    ).toEqual({
      status: "matched",
      workspaceId: "ws-1",
      workspacePath: workspaceDir,
    });

    const realConversationDir = await fs.realpath(conversationDir);
    expect(
      await mapConversationWorkspace({ conversation: { cwd: conversationDir }, workspaces }),
    ).toEqual({
      status: "create",
      workspacePath: realConversationDir,
      name: path.basename(realConversationDir),
    });
  });
});
