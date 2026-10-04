import { describe, expect, test } from "bun:test";
import { refreshSessionsForSkillMutation } from "../src/server/skillMutationRefresh";
import type { SessionBinding } from "../src/server/startServer/types";

function binding(id: string, cwd: string, calls: string[]): SessionBinding {
  return {
    session: null,
    sinks: new Map(),
    runtime: {
      id,
      read: { workingDirectory: cwd },
      skills: {
        refreshSystemPrompt: async (reason: string) => {
          calls.push(`${id}:system:${reason}`);
        },
        refreshFromExternalMutation: async (reason: string) => {
          calls.push(`${id}:external:${reason}`);
        },
      },
    },
  } as SessionBinding;
}

describe("refreshSessionsForSkillMutation", () => {
  test("shared refresh includes other workspaces and keeps the source session on the system prompt", async () => {
    const calls: string[] = [];
    await refreshSessionsForSkillMutation({
      sessionBindings: [
        binding("source", "/workspace-a", calls),
        binding("peer", "/workspace-a", calls),
        binding("other", "/workspace-b", calls),
      ],
      workspaceControlBindings: [binding("control", "/workspace-b", calls)],
      workingDirectory: "/workspace-a",
      sourceSessionId: "source",
      allWorkspaces: true,
    });

    expect(calls.sort()).toEqual([
      "control:external:skills.shared_refresh",
      "other:external:skills.shared_refresh",
      "peer:external:skills.shared_refresh",
      "source:system:skills.shared_refresh",
    ]);
  });

  test("refreshes a session once when it is bound as both a chat and a workspace control", async () => {
    const calls: string[] = [];
    const source = binding("source", "/workspace-a", calls);
    const peer = binding("peer", "/workspace-a", calls);
    await refreshSessionsForSkillMutation({
      sessionBindings: [source, peer, { session: null, runtime: null, sinks: new Map() }],
      workspaceControlBindings: [source, peer],
      workingDirectory: "/workspace-a",
      sourceSessionId: "source",
    });

    expect(calls.sort()).toEqual([
      "peer:external:skills.workspace_refresh",
      "source:system:skills.workspace_refresh",
    ]);
  });

  test("treats every matching session as external when no source session is named", async () => {
    const calls: string[] = [];
    await refreshSessionsForSkillMutation({
      sessionBindings: [
        binding("source", "/workspace-a", calls),
        binding("other", "/workspace-b", calls),
      ],
      workspaceControlBindings: [],
      workingDirectory: "/workspace-a",
    });

    expect(calls).toEqual(["source:external:skills.workspace_refresh"]);
  });
});
