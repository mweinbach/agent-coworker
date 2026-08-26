import { z } from "zod";

import { serializeTurnDelta } from "../advancedMemory/MemoryGenerator";
import {
  listPersistedSessionSnapshots,
  type PersistedSessionSummary,
  readPersistedSessionSnapshot,
} from "../server/sessionStore";
import { getAiCoworkerPaths } from "../store/connections";
import type { ModelMessage } from "../types";
import { truncateText } from "../utils/paths";
import { sameWorkspacePath } from "../utils/workspacePath";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

/**
 * Lets the main agent revisit prior sessions: list recent conversations or read
 * a specific transcript by sessionId (tool outputs truncated for frugality).
 * Memory entries record their `originSessionId`, which feeds this tool.
 */
type ReadPastConversationDeps = {
  getPaths?: () => Parameters<typeof listPersistedSessionSnapshots>[0];
  listSnapshots?: typeof listPersistedSessionSnapshots;
  readSnapshot?: typeof readPersistedSessionSnapshot;
  historyReader?: ReadPastConversationHistoryReader;
};

type ReadPastConversationRecord = {
  sessionId: string;
  title: string;
  workingDirectory: string;
  messages: ModelMessage[];
};

export type ReadPastConversationHistoryReader = {
  list: (opts: {
    workingDirectory: string;
  }) => Promise<PersistedSessionSummary[]> | PersistedSessionSummary[];
  read: (opts: {
    sessionId: string;
  }) => Promise<ReadPastConversationRecord | null> | ReadPastConversationRecord | null;
};

const historyReaders = new Map<string, ReadPastConversationHistoryReader>();

function formatSessionSummaries(summaries: PersistedSessionSummary[]): string {
  return summaries
    .map(
      (s) =>
        `- ${s.sessionId} — ${s.title || "(untitled)"} (${s.messageCount} msgs, updated ${s.updatedAt})`,
    )
    .join("\n");
}

function mergeSessionSummaries(
  canonical: PersistedSessionSummary[],
  legacy: PersistedSessionSummary[],
): PersistedSessionSummary[] {
  const bySessionId = new Map<string, PersistedSessionSummary>();
  for (const summary of canonical) {
    bySessionId.set(summary.sessionId, summary);
  }
  for (const summary of legacy) {
    if (!bySessionId.has(summary.sessionId)) {
      bySessionId.set(summary.sessionId, summary);
    }
  }
  return [...bySessionId.values()].sort((a, b) =>
    b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0,
  );
}

async function removeLegacySummariesOwnedByCanonicalReader(
  legacy: PersistedSessionSummary[],
  canonical: PersistedSessionSummary[],
  historyReader: ReadPastConversationHistoryReader,
): Promise<PersistedSessionSummary[]> {
  const canonicalSessionIds = new Set(canonical.map((summary) => summary.sessionId));
  const unownedLegacy: PersistedSessionSummary[] = [];
  for (const summary of legacy) {
    if (canonicalSessionIds.has(summary.sessionId)) continue;
    if (await historyReader.read({ sessionId: summary.sessionId })) continue;
    unownedLegacy.push(summary);
  }
  return unownedLegacy;
}

export function registerReadPastConversationHistoryReader(
  sessionId: string,
  reader: ReadPastConversationHistoryReader,
): () => void {
  historyReaders.set(sessionId, reader);
  return () => {
    if (historyReaders.get(sessionId) === reader) {
      historyReaders.delete(sessionId);
    }
  };
}

export function createReadPastConversationTool(
  ctx: ToolContext,
  deps: ReadPastConversationDeps = {},
) {
  const paths = (deps.getPaths ?? getAiCoworkerPaths)();
  const listSnapshots = deps.listSnapshots ?? listPersistedSessionSnapshots;
  const readSnapshot = deps.readSnapshot ?? readPersistedSessionSnapshot;
  const historyReader =
    deps.historyReader ?? (ctx.sessionId ? historyReaders.get(ctx.sessionId) : undefined);
  const activeWorkingDirectory = ctx.config.workingDirectory;

  return defineTool({
    description: `Read a prior conversation transcript by sessionId, or list recent sessions. Memory entries reference their originSessionId, which you can pass here.`,
    inputSchema: z.object({
      sessionId: z
        .string()
        .optional()
        .describe("Session id to read; omit with list:true to browse"),
      list: z.boolean().optional().describe("List recent sessions instead of reading one"),
      limit: z.number().int().positive().max(50).optional().describe("Max sessions to list"),
    }),
    execute: async ({
      sessionId,
      list,
      limit,
    }: {
      sessionId?: string;
      list?: boolean;
      limit?: number;
    }) => {
      ctx.log(`tool> readPastConversation ${JSON.stringify({ sessionId, list, limit })}`);

      if (list || !sessionId) {
        const legacySummaries = await listSnapshots(paths, {
          workingDirectory: activeWorkingDirectory,
        });
        if (historyReader) {
          const canonicalSummaries = await historyReader.list({
            workingDirectory: activeWorkingDirectory,
          });
          const summaries = mergeSessionSummaries(
            canonicalSummaries,
            await removeLegacySummariesOwnedByCanonicalReader(
              legacySummaries,
              canonicalSummaries,
              historyReader,
            ),
          );
          const top = summaries.slice(0, limit ?? 20);
          if (top.length === 0) return "No past conversations found.";
          return formatSessionSummaries(top);
        }

        const top = legacySummaries.slice(0, limit ?? 20);
        if (top.length === 0) return "No past conversations found.";
        return formatSessionSummaries(top);
      }

      if (historyReader) {
        const record = await historyReader.read({ sessionId });
        if (record) {
          if (!sameWorkspacePath(record.workingDirectory, activeWorkingDirectory)) {
            return `No conversation found for sessionId "${sessionId}".`;
          }
          const transcript = serializeTurnDelta(record.messages);
          const header = `# ${record.title || "(untitled)"}\nsessionId: ${record.sessionId}\n\n`;
          return truncateText(`${header}${transcript}`, 30000);
        }
      }

      const snapshot = await readSnapshot({ paths, sessionId });
      if (!snapshot) return `No conversation found for sessionId "${sessionId}".`;
      if (!sameWorkspacePath(snapshot.config.workingDirectory, activeWorkingDirectory)) {
        return `No conversation found for sessionId "${sessionId}".`;
      }
      const transcript = serializeTurnDelta(snapshot.context.messages as ModelMessage[]);
      const header = `# ${snapshot.session.title || "(untitled)"}\nsessionId: ${snapshot.sessionId}\n\n`;
      return truncateText(`${header}${transcript}`, 30000);
    },
  });
}
