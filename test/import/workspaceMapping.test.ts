import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  mapConversationWorkspace,
  resolveWorkspaceMappingInput,
  validateWorkspaceMappingInput,
} from "../../src/import/conversations/workspaceMapping";

const createdDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.cwd(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("conversation workspace mapping", () => {
  test("mapConversationWorkspace reports missing cwd and missing paths", async () => {
    expect(
      await mapConversationWorkspace({
        conversation: { cwd: null },
        workspaces: [],
      }),
    ).toEqual({ status: "missing", originalPath: null, reason: "no_cwd" });
    expect(
      await mapConversationWorkspace({
        conversation: { cwd: "   " },
        workspaces: [],
      }),
    ).toEqual({ status: "missing", originalPath: null, reason: "no_cwd" });

    const missing = path.join(process.cwd(), "does-not-exist-import-map");
    expect(
      await mapConversationWorkspace({
        conversation: { cwd: missing },
        workspaces: [{ id: "ws-1", name: "Project", path: missing }],
      }),
    ).toEqual({
      status: "missing",
      originalPath: missing,
      reason: "path_missing",
    });
  });

  test("matches catalog workspaces through realpath aliases and otherwise offers create", async () => {
    const workspaceDir = await makeDir("cowork-import-ws-");
    const aliasDir = await makeDir("cowork-import-alias-");
    const alias = path.join(aliasDir, "link");
    await fs.symlink(workspaceDir, alias);

    expect(
      await mapConversationWorkspace({
        conversation: { cwd: alias },
        workspaces: [{ id: "ws-1", name: "Project", path: workspaceDir }],
      }),
    ).toEqual({
      status: "matched",
      workspaceId: "ws-1",
      workspacePath: workspaceDir,
    });

    const otherDir = await makeDir("cowork-import-other-");
    expect(
      await mapConversationWorkspace({
        conversation: { cwd: otherDir },
        workspaces: [{ id: "ws-1", name: "Project", path: workspaceDir }],
      }),
    ).toEqual({
      status: "create",
      workspacePath: await fs.realpath(otherDir),
      name: path.basename(otherDir),
    });
  });

  test("resolve and validate mapping input fail closed for unknown or missing targets", async () => {
    const workspaceDir = await makeDir("cowork-import-validate-");
    const workspaces = [{ id: "ws-1", name: "Project", path: workspaceDir }];

    expect(
      resolveWorkspaceMappingInput({
        mapping: { kind: "create", path: "   " },
        workspaces,
      }),
    ).toEqual({ error: "Workspace path is required." });
    expect(
      resolveWorkspaceMappingInput({
        mapping: { kind: "existing", workspaceId: "missing" },
        workspaces,
      }),
    ).toEqual({ error: "Unknown workspace: missing" });
    expect(
      resolveWorkspaceMappingInput({
        mapping: { kind: "existing", workspaceId: "ws-1" },
        workspaces,
      }),
    ).toEqual({
      workspaceId: "ws-1",
      workspacePath: workspaceDir,
      name: "Project",
    });

    const missingPath = path.join(workspaceDir, "gone");
    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "create", path: missingPath, name: "New" },
        workspaces,
      }),
    ).toEqual({
      status: "missing",
      originalPath: missingPath,
      reason: "path_missing",
    });
    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "create", path: workspaceDir },
        workspaces,
      }),
    ).toEqual({
      status: "create",
      workspacePath: await fs.realpath(workspaceDir),
      name: path.basename(await fs.realpath(workspaceDir)),
    });
    expect(
      await validateWorkspaceMappingInput({
        mapping: { kind: "fallback", workspaceId: "ws-1" },
        workspaces,
      }),
    ).toEqual({
      status: "matched",
      workspaceId: "ws-1",
      workspacePath: workspaceDir,
    });
  });
});
