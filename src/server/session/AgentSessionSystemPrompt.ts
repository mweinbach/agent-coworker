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

const promptLoadRevisions = new WeakMap<SessionRuntimeState, { next: number; applied: number }>();

async function loadAgentSessionSystemPromptSnapshot(promptState: AgentSessionSystemPromptState) {
  const historyRevision = promptState.state.historyRevision;
  let revisions = promptLoadRevisions.get(promptState.state);
  if (!revisions) {
    revisions = { next: 0, applied: 0 };
    promptLoadRevisions.set(promptState.state, revisions);
  }
  const revision = ++revisions.next;
  const config = promptState.state.config;
  let skillCatalogMtimeSnapshot: string | null = null;
  try {
    skillCatalogMtimeSnapshot =
      (await promptState.deps.readSkillCatalogMtimeSnapshotImpl?.(config)) ?? null;
  } catch {
    // Catalog mtime checks should never block a turn or an explicit refresh.
  }
  const result = await promptState.context.deps.loadSystemPromptWithSkillsImpl(config);
  if (revision < revisions.applied || historyRevision !== promptState.state.historyRevision) {
    return null;
  }
  revisions.applied = revision;
  return { ...result, skillCatalogMtimeSnapshot };
}

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
      const result = await loadAgentSessionSystemPromptSnapshot(promptState);
      // Re-check state at completion: an eager warm-up load can race with a
      // config mutation that refreshed the prompt while this load was in
      // flight. The refreshed prompt is newer, so never clobber it.
      const promptRefreshedConcurrently =
        promptState.state.systemPromptMetadataLoaded && promptState.state.system.trim().length > 0;
      if (result && !promptRefreshedConcurrently) {
        if (promptState.state.system.trim().length === 0) {
          promptState.state.system = result.prompt;
        }
        promptState.state.discoveredSkills = result.discoveredSkills;
        promptState.state.systemPromptMetadataLoaded = true;
        if (result.skillCatalogMtimeSnapshot !== null) {
          promptState.setSkillCatalogMtimeSnapshot(result.skillCatalogMtimeSnapshot);
        }
      }
      return (
        promptState.state.systemPromptMetadataLoaded && promptState.state.system.trim().length > 0
      );
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

async function refreshAgentSessionSystemPromptIfSkillCatalogChanged(
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
    const result = await loadAgentSessionSystemPromptSnapshot(promptState);
    if (!result) return;
    if ((promptState.state.sessionInfo.sessionKind ?? "root") === "root") {
      promptState.state.system = result.prompt;
    }
    promptState.state.discoveredSkills = result.discoveredSkills;
    promptState.state.systemPromptMetadataLoaded = true;
    // Publish the snapshot captured before this load with its prompt. A catalog
    // change during the load then remains visible to the next pre-turn check.
    if (result.skillCatalogMtimeSnapshot !== null) {
      promptState.setSkillCatalogMtimeSnapshot(result.skillCatalogMtimeSnapshot);
    }
    promptState.queuePersistSessionSnapshot(reason);
  } catch (err) {
    promptState.context.emitError(
      "internal_error",
      "session",
      `Failed to refresh system prompt: ${String(err)}`,
    );
  }
}
