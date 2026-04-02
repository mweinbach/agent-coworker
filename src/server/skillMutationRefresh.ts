import type { AgentSession } from "./session/AgentSession";
import type { SessionBinding } from "./startServer/types";

export function collectSessionsForSkillRefresh(opts: {
  sessionBindings: Iterable<SessionBinding>;
  workspaceControlBindings: Iterable<SessionBinding>;
  workingDirectory: string;
  allWorkspaces: boolean;
}): AgentSession[] {
  const sessions: AgentSession[] = [];
  const seenSessionIds = new Set<string>();
  const addSession = (candidate: AgentSession | null | undefined) => {
    if (!candidate) {
      return;
    }
    if (!opts.allWorkspaces && candidate.getWorkingDirectory() !== opts.workingDirectory) {
      return;
    }
    if (seenSessionIds.has(candidate.id)) {
      return;
    }
    seenSessionIds.add(candidate.id);
    sessions.push(candidate);
  };

  for (const binding of opts.sessionBindings) {
    addSession(binding.session);
  }
  for (const binding of opts.workspaceControlBindings) {
    addSession(binding.session);
  }

  return sessions;
}

export async function refreshSessionsForSkillMutation(opts: {
  sessionBindings: Iterable<SessionBinding>;
  workspaceControlBindings: Iterable<SessionBinding>;
  workingDirectory: string;
  sourceSessionId?: string;
  allWorkspaces?: boolean;
}): Promise<void> {
  const allWorkspaces = opts.allWorkspaces ?? false;
  const sessions = collectSessionsForSkillRefresh({
    sessionBindings: opts.sessionBindings,
    workspaceControlBindings: opts.workspaceControlBindings,
    workingDirectory: opts.workingDirectory,
    allWorkspaces,
  });
  const refreshReason = allWorkspaces ? "skills.shared_refresh" : "skills.workspace_refresh";
  await Promise.all(
    sessions.map(async (session) => {
      if (opts.sourceSessionId && session.id === opts.sourceSessionId) {
        await session.refreshSystemPromptWithSkills(refreshReason);
        return;
      }
      await session.refreshSkillStateFromExternalMutation(refreshReason);
    }),
  );
}
