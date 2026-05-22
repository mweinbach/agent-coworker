import type { SessionContext, SessionDependencies, SessionRuntimeState } from "./SessionContext";

export type AgentSessionSystemPromptState = {
  state: SessionRuntimeState;
  deps: SessionDependencies;
  context: SessionContext;
  getSkillCatalogMtimeSnapshot: () => string | null;
  setSkillCatalogMtimeSnapshot: (value: string | null) => void;
  getSystemPromptLoadPromise: () => Promise<boolean> | null;
  setSystemPromptLoadPromise: (value: Promise<boolean> | null) => void;
  queuePersistSessionSnapshot: (reason: string) => void;
};

export async function ensureAgentSessionSystemPromptReady(
  promptState: AgentSessionSystemPromptState,
): Promise<boolean> {
  const hasSystemPrompt = promptState.state.system.trim().length > 0;
  if (hasSystemPrompt && promptState.state.systemPromptMetadataLoaded) {
    await refreshAgentSessionSystemPromptIfSkillCatalogChanged(promptState);
    return true;
  }
  const existingPromise = promptState.getSystemPromptLoadPromise();
  if (existingPromise) {
    return await existingPromise;
  }

  const loadPromise = (async () => {
    try {
      const result = await promptState.context.deps.loadSystemPromptWithSkillsImpl(
        promptState.state.config,
      );
      if (!hasSystemPrompt) {
        promptState.state.system = result.prompt;
      }
      promptState.state.discoveredSkills = result.discoveredSkills;
      promptState.state.systemPromptMetadataLoaded = true;
      await recordAgentSessionSkillCatalogMtimeSnapshot(promptState);
      return true;
    } catch (err) {
      promptState.context.emitError(
        "internal_error",
        "session",
        `Failed to load system prompt: ${String(err)}`,
      );
      return false;
    } finally {
      promptState.setSystemPromptLoadPromise(null);
    }
  })();

  promptState.setSystemPromptLoadPromise(loadPromise);
  return await loadPromise;
}

export async function recordAgentSessionSkillCatalogMtimeSnapshot(
  promptState: AgentSessionSystemPromptState,
): Promise<void> {
  const readSnapshot = promptState.deps.readSkillCatalogMtimeSnapshotImpl;
  if (!readSnapshot) {
    return;
  }
  try {
    promptState.setSkillCatalogMtimeSnapshot(await readSnapshot(promptState.state.config));
  } catch {
    // Catalog mtime checks should never block a turn or an explicit refresh.
  }
}

export async function refreshAgentSessionSystemPromptIfSkillCatalogChanged(
  promptState: AgentSessionSystemPromptState,
): Promise<void> {
  const readSnapshot = promptState.deps.readSkillCatalogMtimeSnapshotImpl;
  if (!readSnapshot) {
    return;
  }
  let nextSnapshot: string;
  try {
    nextSnapshot = await readSnapshot(promptState.state.config);
  } catch {
    return;
  }
  const previousSnapshot = promptState.getSkillCatalogMtimeSnapshot();
  if (previousSnapshot === null) {
    promptState.setSkillCatalogMtimeSnapshot(nextSnapshot);
    return;
  }
  if (previousSnapshot === nextSnapshot) {
    return;
  }
  await refreshAgentSessionSystemPromptWithSkills(promptState, "skills.pre_turn_mtime_refresh");
}

export async function refreshAgentSessionSystemPromptWithSkills(
  promptState: AgentSessionSystemPromptState,
  reason = "session.refresh_system_prompt",
): Promise<void> {
  try {
    const result = await promptState.context.deps.loadSystemPromptWithSkillsImpl(
      promptState.state.config,
    );
    promptState.state.system = result.prompt;
    promptState.state.discoveredSkills = result.discoveredSkills;
    promptState.state.systemPromptMetadataLoaded = true;
    await recordAgentSessionSkillCatalogMtimeSnapshot(promptState);
    promptState.queuePersistSessionSnapshot(reason);
  } catch (err) {
    promptState.context.emitError(
      "internal_error",
      "session",
      `Failed to refresh system prompt: ${String(err)}`,
    );
  }
}
