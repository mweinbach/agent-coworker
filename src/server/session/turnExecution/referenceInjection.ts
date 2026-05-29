import { buildPluginCatalogSnapshot } from "../../../plugins";
import { discoverSkillsForConfig } from "../../../skills";
import {
  isSkillBodyLoadAllowed,
  type LoadedSkillBody,
  loadSkillBodyByName,
} from "../../../skills/loadSkillBody";
import type {
  ModelMessage,
  PluginCatalogSnapshot,
  ReferencedPluginContext,
  TurnReference,
} from "../../../types";
import { normalizeModelStreamPart } from "../../modelStream";
import type { SessionContext } from "../SessionContext";

/**
 * Server-side handling for skill/plugin references the user @-mentioned on a turn
 * (`TurnReference[]`).
 *
 * - Skill references are HARD-forced: each skill's SKILL.md body is injected as a
 *   synthetic `skill` tool-call + tool-result pair, both appended to model history
 *   (so it persists for later turns) and surfaced to the transcript via
 *   `model_stream_chunk` events (so it renders exactly like a real skill load,
 *   live and on journal replay). This does not depend on the model choosing to
 *   call the tool.
 * - Plugin references are SOFT awareness: resolved to `ReferencedPluginContext`
 *   and rendered into a turn-scoped system block elsewhere
 *   (`renderReferencedPluginsSection`).
 */

export type ReferencedSkillContext = LoadedSkillBody;

export type InjectReferencedSkillsResult = {
  messages: ModelMessage[];
  skills: ReferencedSkillContext[];
};

/** Deterministic, occurrence-stable id so live + journal-replay item ids match. */
export function buildSyntheticSkillToolCallId(
  turnId: string,
  skillName: string,
  index: number,
): string {
  return `skillref_${turnId}_${index}_${skillName}`;
}

/**
 * Build the synthetic history messages for a forced skill load. Shapes match what
 * a real `skill` tool call produces in history (`piMessageBridge` round-trips
 * these across every provider): an assistant `tool-call` part and a `tool` message
 * whose `tool-result` output uses the structured `{ type: "text", value }` form.
 */
export function buildSyntheticSkillMessages(
  toolCallId: string,
  skillName: string,
  body: string,
): { assistant: ModelMessage; tool: ModelMessage } {
  return {
    assistant: {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "skill", input: { skillName } }],
    },
    tool: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "skill",
          output: { type: "text", value: body },
          isError: false,
        },
      ],
    },
  };
}

function emitSkillLoadChunk(
  context: SessionContext,
  turnId: string,
  index: number,
  includeRawChunks: boolean,
  rawPart: Record<string, unknown>,
): void {
  const normalized = normalizeModelStreamPart(rawPart, {
    provider: context.state.config.provider,
    includeRawPart: includeRawChunks,
    fallbackIdSeed: turnId,
    rawPartMode: process.env.COWORK_MODEL_STREAM_RAW_MODE === "full" ? "full" : "sanitized",
  });
  context.emit({
    type: "model_stream_chunk",
    sessionId: context.id,
    turnId,
    index,
    provider: context.state.config.provider,
    model: context.state.config.model,
    normalizerVersion: normalized.normalizerVersion,
    partType: normalized.partType,
    part: normalized.part,
    ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
  });
}

function dedupeReferenceNames(references: TurnReference[], kind: TurnReference["kind"]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of references) {
    if (ref.kind !== kind) continue;
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push(ref.name);
  }
  return out;
}

export async function resolveReferencedSkills(opts: {
  context: SessionContext;
  references: TurnReference[];
  log: (line: string) => void;
}): Promise<ReferencedSkillContext[]> {
  const { context, references, log } = opts;
  const skillNames = dedupeReferenceNames(references, "skill");
  const skills: ReferencedSkillContext[] = [];
  for (const name of skillNames) {
    const loaded = await loadSkillBodyByName(context.state.config, name);
    if (!loaded) {
      log(`[skill-ref] skipping unknown, disabled, or unreadable skill "${name}"`);
      continue;
    }
    skills.push(loaded);
  }
  return skills;
}

export function injectResolvedReferencedSkills(opts: {
  context: SessionContext;
  appendToHistory: (messages: ModelMessage[]) => void;
  turnId: string;
  skills: ReferencedSkillContext[];
  allocateStreamIndex: () => number;
  includeRawChunks: boolean;
  log: (line: string) => void;
}): ModelMessage[] {
  const { context, appendToHistory, turnId, skills, allocateStreamIndex, includeRawChunks, log } =
    opts;
  const injectedMessages: ModelMessage[] = [];
  for (const loaded of skills) {
    const toolCallId = buildSyntheticSkillToolCallId(
      turnId,
      loaded.name,
      context.state.turnReferenceInjectionCounter++,
    );
    const { assistant, tool } = buildSyntheticSkillMessages(toolCallId, loaded.name, loaded.body);
    appendToHistory([assistant, tool]);
    injectedMessages.push(assistant, tool);
    emitSkillLoadChunk(context, turnId, allocateStreamIndex(), includeRawChunks, {
      type: "tool-call",
      toolCallId,
      toolName: "skill",
      input: { skillName: loaded.name },
    });
    emitSkillLoadChunk(context, turnId, allocateStreamIndex(), includeRawChunks, {
      type: "tool-result",
      toolCallId,
      toolName: "skill",
      output: loaded.body,
    });
    log(`[skill-ref] injected skill "${loaded.name}"`);
  }
  return injectedMessages;
}

/**
 * Hard-force every `kind:"skill"` reference: load its body, append the synthetic
 * tool-call/result pair to history, and emit the matching transcript chunks.
 * The stream-chunk's tool-result `output` is the raw body string (matching the
 * pi runtime's real tool-result emission); the history message uses the
 * structured output form (matching the canonical persisted shape).
 */
export async function injectReferencedSkills(opts: {
  context: SessionContext;
  appendToHistory: (messages: ModelMessage[]) => void;
  turnId: string;
  references: TurnReference[];
  allocateStreamIndex: () => number;
  includeRawChunks: boolean;
  log: (line: string) => void;
}): Promise<InjectReferencedSkillsResult> {
  const {
    context,
    appendToHistory,
    turnId,
    references,
    allocateStreamIndex,
    includeRawChunks,
    log,
  } = opts;
  const skills = await resolveReferencedSkills({ context, references, log });
  const messages = injectResolvedReferencedSkills({
    context,
    appendToHistory,
    turnId,
    skills,
    allocateStreamIndex,
    includeRawChunks,
    log,
  });
  return { messages, skills };
}

/**
 * Resolve every `kind:"plugin"` reference against the plugin catalog into the
 * turn-scoped awareness context. Unknown plugin names are dropped.
 */
export async function resolveReferencedPlugins(
  context: SessionContext,
  references: TurnReference[],
  pluginCatalog?: PluginCatalogSnapshot,
): Promise<ReferencedPluginContext[]> {
  const pluginNames = dedupeReferenceNames(references, "plugin");
  if (pluginNames.length === 0) return [];

  const catalog = pluginCatalog ?? (await buildPluginCatalogSnapshot(context.state.config));
  const enabledSkillNames = new Set(
    (await discoverSkillsForConfig(context.state.config))
      .filter((skill) => skill.enabled && isSkillBodyLoadAllowed(context.state.config, skill.name))
      .map((skill) => skill.name),
  );
  const out: ReferencedPluginContext[] = [];
  for (const name of pluginNames) {
    // Skill names take precedence over plugin names for the same token.
    if (enabledSkillNames.has(name)) continue;

    const entry = catalog.plugins.find((plugin) => plugin.name === name && plugin.enabled);
    if (!entry) continue;
    out.push({
      name: entry.name,
      displayName: entry.displayName || entry.name,
      skillNames: entry.skills
        .filter(
          (skill) => skill.enabled && isSkillBodyLoadAllowed(context.state.config, skill.name),
        )
        .map((skill) => skill.name),
    });
  }
  return out;
}
