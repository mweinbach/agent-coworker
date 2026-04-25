import type { SessionRuntime } from "./session/SessionRuntime";
import type { SessionBinding } from "./startServer/types";

export function collectSessionsForSkillRefresh(opts: {
  sessionBindings: Iterable<SessionBinding>;
  workspaceControlBindings: Iterable<SessionBinding>;
  workingDirectory: string;
  allWorkspaces: boolean;
}): SessionRuntime[] {
  const runtimes: SessionRuntime[] = [];
  const seenSessionIds = new Set<string>();
  const addRuntime = (candidate: SessionRuntime | null | undefined) => {
    if (!candidate) {
      return;
    }
    if (!opts.allWorkspaces && candidate.read.workingDirectory !== opts.workingDirectory) {
      return;
    }
    if (seenSessionIds.has(candidate.id)) {
      return;
    }
    seenSessionIds.add(candidate.id);
    runtimes.push(candidate);
  };

  for (const binding of opts.sessionBindings) {
    addRuntime(binding.runtime);
  }
  for (const binding of opts.workspaceControlBindings) {
    addRuntime(binding.runtime);
  }

  return runtimes;
}

export async function refreshSessionsForSkillMutation(opts: {
  sessionBindings: Iterable<SessionBinding>;
  workspaceControlBindings: Iterable<SessionBinding>;
  workingDirectory: string;
  sourceSessionId?: string;
  allWorkspaces?: boolean;
}): Promise<void> {
  const allWorkspaces = opts.allWorkspaces ?? false;
  const runtimes = collectSessionsForSkillRefresh({
    sessionBindings: opts.sessionBindings,
    workspaceControlBindings: opts.workspaceControlBindings,
    workingDirectory: opts.workingDirectory,
    allWorkspaces,
  });
  const refreshReason = allWorkspaces ? "skills.shared_refresh" : "skills.workspace_refresh";
  await Promise.all(
    runtimes.map(async (runtime) => {
      if (opts.sourceSessionId && runtime.id === opts.sourceSessionId) {
        await runtime.skills.refreshSystemPrompt(refreshReason);
        return;
      }
      await runtime.skills.refreshFromExternalMutation(refreshReason);
    }),
  );
}
