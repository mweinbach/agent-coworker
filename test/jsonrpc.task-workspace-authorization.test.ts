import { describe, expect, test } from "bun:test";

import { createCreationRouteHandlers } from "../src/server/jsonrpc/routes/creation";
import { resolveAuthorizedProjectTaskWorkspacePath } from "../src/server/jsonrpc/routes/tasks";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcCreationResultSchemas } from "../src/server/jsonrpc/schema.creation";
import type { AgentConfig } from "../src/types";

const METHOD = "cowork/creation/preflight";

function makeResolverContext(options: {
  workspacePath: string;
  homedir: string;
  desktopService?: {
    loadState: () => Promise<{
      version: number;
      workspaces: Array<{
        id: string;
        name: string;
        path: string;
        workspaceKind: "project" | "oneOffChat";
        createdAt: string;
      }>;
    }>;
  };
}): JsonRpcRouteContext {
  return {
    getConfig: () =>
      ({
        workingDirectory: options.workspacePath,
      }) as AgentConfig,
    homedir: options.homedir,
    desktopService: options.desktopService,
  } as unknown as JsonRpcRouteContext;
}

describe("resolveAuthorizedProjectTaskWorkspacePath", () => {
  test("treats paths under the one-off chats root as unauthorized without a desktop catalog", async () => {
    const homedir = "/home/coverage";
    const workspacePath = `${homedir}/.cowork/chats/quick-chat`;
    const resolved = await resolveAuthorizedProjectTaskWorkspacePath(
      makeResolverContext({ workspacePath, homedir }),
      workspacePath,
    );
    expect(resolved).toBeNull();
  });

  test("authorizes ordinary project paths when no desktop catalog is present", async () => {
    const workspacePath = "/workspace/project";
    const resolved = await resolveAuthorizedProjectTaskWorkspacePath(
      makeResolverContext({ workspacePath, homedir: "/home/coverage" }),
      workspacePath,
    );
    expect(resolved).toBe(workspacePath);
  });

  test("uses the desktop catalog kind so a one-off entry cannot host a task", async () => {
    const workspacePath = "/workspace/looks-like-a-project";
    const resolved = await resolveAuthorizedProjectTaskWorkspacePath(
      makeResolverContext({
        workspacePath,
        homedir: "/home/coverage",
        desktopService: {
          loadState: async () => ({
            version: 2,
            workspaces: [
              {
                id: "oneoff-1",
                name: "Quick chat",
                path: workspacePath,
                workspaceKind: "oneOffChat",
                createdAt: "2026-06-01T00:00:00.000Z",
              },
            ],
          }),
        },
      }),
      workspacePath,
    );
    expect(resolved).toBeNull();
  });

  test("returns the catalog project path when the desktop entry is authorized", async () => {
    const workspacePath = "/workspace/authorized-project";
    const resolved = await resolveAuthorizedProjectTaskWorkspacePath(
      makeResolverContext({
        workspacePath,
        homedir: "/home/coverage",
        desktopService: {
          loadState: async () => ({
            version: 2,
            workspaces: [
              {
                id: "project-1",
                name: "Project",
                path: workspacePath,
                workspaceKind: "project",
                createdAt: "2026-06-01T00:00:00.000Z",
              },
            ],
          }),
        },
      }),
      workspacePath,
    );
    expect(resolved).toBe(workspacePath);
  });

  test("creation preflight blocks task kind for a catalog one-off workspace", async () => {
    const workspacePath = "/workspace/looks-like-a-project";
    const results: unknown[] = [];
    const errors: unknown[] = [];
    const context = {
      getConfig: () =>
        ({
          provider: "google",
          model: "gemini-2.5-flash",
          workingDirectory: workspacePath,
          skillsDirs: [],
          userCoworkDir: "/home/coverage/.cowork",
        }) as AgentConfig,
      homedir: "/home/coverage",
      desktopService: {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "oneoff-1",
              name: "Quick chat",
              path: workspacePath,
              workspaceKind: "oneOffChat",
              createdAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        }),
      },
      runtime: {
        getDiagnostics: () => ({ startup: { ready: true } }),
      },
      utils: {
        resolveWorkspacePath: () => workspacePath,
      },
      jsonrpc: {
        sendResult: (_ws: unknown, _id: unknown, result: unknown) => {
          results.push(result);
        },
        sendError: (_ws: unknown, _id: unknown, error: unknown) => {
          errors.push(error);
        },
      },
    } as unknown as JsonRpcRouteContext;

    const handler = createCreationRouteHandlers(context)[METHOD];
    if (!handler) throw new Error(`${METHOD} handler was not registered`);
    await handler({} as never, {
      id: 1,
      method: METHOD,
      params: { kind: "task", cwd: workspacePath },
    });

    expect(errors).toEqual([]);
    const result = jsonRpcCreationResultSchemas[METHOD].parse(results[0]);
    expect(result.ready).toBe(false);
    expect(result.checks).toEqual([
      {
        id: "project_access",
        status: "blocked",
        message: "Tasks run inside a project workspace. Choose a project instead of a quick chat.",
      },
    ]);
  });
});
