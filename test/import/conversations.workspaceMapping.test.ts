import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  mapConversationWorkspace,
  validateWorkspaceMappingInput,
} from "../../src/import/conversations/workspaceMapping";
import { scratchRoots } from "../../src/platform/sandbox/policy";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("conversation workspace mapping", () => {
  test("validateWorkspaceMappingInput fail-closes unknown existing workspaces and blank create paths", async () => {
    const workspaceDir = await makeTempDir("cowork-import-ws-");
    const workspaces = [{ id: "ws-1", name: "Project", path: workspaceDir }];

    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "existing", workspaceId: "missing" },
        workspaces,
      }),
    ).toEqual({ error: "Unknown workspace: missing" });
    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "fallback", workspaceId: "missing" },
        workspaces,
      }),
    ).toEqual({ error: "Unknown workspace: missing" });
    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "create", path: "   " },
        workspaces,
      }),
    ).toEqual({ error: "Workspace path is required." });
  });

  test("validateWorkspaceMappingInput rejects missing or non-directory create paths", async () => {
    const workspaceDir = await makeTempDir("cowork-import-create-");
    const filePath = path.join(workspaceDir, "not-a-dir.txt");
    await fs.writeFile(filePath, "nope");

    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "create", path: path.join(workspaceDir, "does-not-exist") },
        workspaces: [],
      }),
    ).toEqual({
      status: "missing",
      originalPath: path.join(workspaceDir, "does-not-exist"),
      reason: "path_missing",
    });
    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "create", path: filePath, name: " Imported " },
        workspaces: [],
      }),
    ).toEqual({
      status: "missing",
      originalPath: filePath,
      reason: "path_missing",
    });

    const created = await validateWorkspaceMappingInput({
      mapping: { kind: "create", path: workspaceDir, name: " Imported " },
      workspaces: [],
    });
    expect(created).toEqual({
      status: "create",
      workspacePath: await fs.realpath(workspaceDir),
      name: "Imported",
    });
  });

  test("mapConversationWorkspace matches known directories and otherwise proposes create", async () => {
    const workspaceDir = await makeTempDir("cowork-import-map-ws-");
    const conversationDir = await makeTempDir("cowork-import-map-cwd-");
    const workspaces = [{ id: "ws-1", name: "Project", path: workspaceDir }];

    expect(
      await mapConversationWorkspace({
        conversation: { cwd: "   " },
        workspaces,
      }),
    ).toEqual({ status: "missing", originalPath: null, reason: "no_cwd" });
    expect(
      await mapConversationWorkspace({
        conversation: { cwd: path.join(workspaceDir, "missing") },
        workspaces,
      }),
    ).toEqual({
      status: "missing",
      originalPath: path.join(workspaceDir, "missing"),
      reason: "path_missing",
    });

    const matched = await mapConversationWorkspace({
      conversation: { cwd: workspaceDir },
      workspaces,
    });
    expect(matched).toEqual({
      status: "matched",
      workspaceId: "ws-1",
      workspacePath: workspaceDir,
    });

    const proposed = await mapConversationWorkspace({
      conversation: { cwd: conversationDir },
      workspaces,
    });
    const realConversationDir = await fs.realpath(conversationDir);
    expect(proposed).toEqual({
      status: "create",
      workspacePath: realConversationDir,
      name: path.basename(realConversationDir),
    });
  });
});
