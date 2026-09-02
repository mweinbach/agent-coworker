import type { SessionDb } from "../../server/sessionDb";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { AgentConfig } from "../../types";
import { buildSafeModelMessages } from "./handoff";
import { shortHash } from "./normalize";
import { conversationToSessionFeed, countVisibleMessages, previewText } from "./snapshot";
import type { ConversationImportPersistInput, ConversationImportPersistResult } from "./types";

function makeSessionId(input: ConversationImportPersistInput): string {
  return `import_${input.conversation.source}_${shortHash(input.conversation.fingerprint, 24)}`;
}

function buildSnapshot(
  input: ConversationImportPersistInput,
  opts: { sessionId: string; importedAt: string },
): Omit<SessionSnapshot, "lastEventSeq"> {
  const feed = conversationToSessionFeed(input.conversation, { importedAt: opts.importedAt });
  return {
    sessionId: opts.sessionId,
    title: input.conversation.title,
    titleSource: "heuristic",
    titleModel: null,
    provider: input.provider,
    model: input.model,
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: "completed",
    lastMessagePreview: previewText(input.conversation),
    createdAt: input.conversation.createdAt,
    updatedAt: input.conversation.updatedAt,
    messageCount: countVisibleMessages(input.conversation),
    feed,
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

export async function persistImportedConversation(input: {
  sessionDb: SessionDb;
  importInput: ConversationImportPersistInput;
}): Promise<ConversationImportPersistResult> {
  const { sessionDb, importInput } = input;
  const sessionId = makeSessionId(importInput);
  const importedAt = new Date().toISOString();
  const modelMessages = buildSafeModelMessages(importInput.conversation);
  const snapshotBase = {
    sessionKind: "root" as const,
    parentSessionId: null,
    role: null,
    title: importInput.conversation.title,
    titleSource: "heuristic" as const,
    titleModel: null,
    provider: importInput.provider,
    model: importInput.model,
    workingDirectory: importInput.workspacePath,
    ...(importInput.outputDirectory ? { outputDirectory: importInput.outputDirectory } : {}),
    ...(importInput.uploadsDirectory ? { uploadsDirectory: importInput.uploadsDirectory } : {}),
    enableMcp: importInput.enableMcp,
    backupsEnabledOverride: null,
    createdAt: importInput.conversation.createdAt,
    updatedAt: importInput.conversation.updatedAt,
    status: "active" as const,
    hasPendingAsk: false,
    hasPendingApproval: false,
    systemPrompt: "",
    messages: modelMessages,
    lastMemoryGeneratedIndex: modelMessages.length,
    providerState: null,
    todos: [],
    harnessContext: null,
    costTracker: null,
    executionState: "completed" as const,
    lastMessagePreview: previewText(importInput.conversation),
  };
  return await sessionDb.persistExternalConversationImport({
    mutation: {
      sessionId,
      eventType: "external_conversation_imported",
      eventTs: importedAt,
      direction: "system",
      payload: {
        source: importInput.conversation.source,
        fingerprint: importInput.conversation.fingerprint,
        sourceId: importInput.conversation.sourceId,
        sourcePath: importInput.conversation.sourcePath,
        originalProvider: importInput.conversation.originalProvider,
        originalModel: importInput.conversation.originalModel,
      },
      snapshot: snapshotBase,
    },
    snapshot: buildSnapshot(importInput, { sessionId, importedAt }),
    record: {
      source: importInput.conversation.source,
      fingerprint: importInput.conversation.fingerprint,
      importedSessionId: sessionId,
      sourceId: importInput.conversation.sourceId,
      sourcePath: importInput.conversation.sourcePath,
      originalProvider: importInput.conversation.originalProvider,
      originalModel: importInput.conversation.originalModel,
      importedAt,
      metadata: {
        cwd: importInput.conversation.cwd,
        title: importInput.conversation.title,
        provider: importInput.provider,
        model: importInput.model,
        visibleMessageCount: countVisibleMessages(importInput.conversation),
      },
    },
  });
}

export function selectImportModel(input: {
  requestedProvider?: AgentConfig["provider"];
  requestedModel?: string;
  defaultProvider: AgentConfig["provider"];
  defaultModel: string;
}): { provider: AgentConfig["provider"]; model: string } {
  return {
    provider: input.requestedProvider ?? input.defaultProvider,
    model: input.requestedModel?.trim() || input.defaultModel,
  };
}
