import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import {
  extractCitationSourcesFromWebSearchResult,
  extractCitationUrlsFromWebSearchResult,
} from "../../../../../src/shared/displayCitationMarkers";
import { readFile } from "../../lib/desktopCommands";

type OverflowCitationContext = {
  sourcesByMessageId: Map<string, CitationSource[]>;
  urlsByMessageId: Map<string, Map<number, string>>;
};

export async function loadOverflowCitationContext(
  entries: Array<[messageId: string, filePath: string]>,
  readFileFn: (input: { path: string }) => Promise<string> = readFile,
): Promise<OverflowCitationContext> {
  const urlsByMessageId = new Map<string, Map<number, string>>();
  const sourcesByMessageId = new Map<string, CitationSource[]>();
  const textByPath = new Map<string, string>();
  const latestMessageIdByPath = new Map<string, string>();

  for (const [messageId, filePath] of entries) {
    latestMessageIdByPath.set(filePath, messageId);
  }

  for (const [messageId, filePath] of entries) {
    try {
      let content = textByPath.get(filePath);
      if (content === undefined) {
        content = await readFileFn({ path: filePath });
        textByPath.set(filePath, content);
      }

      urlsByMessageId.set(messageId, extractCitationUrlsFromWebSearchResult(content));

      const sources = extractCitationSourcesFromWebSearchResult(content);
      if (sources.length > 0 && latestMessageIdByPath.get(filePath) === messageId) {
        sourcesByMessageId.set(messageId, sources);
      }
    } catch {
      urlsByMessageId.set(messageId, new Map());
    }
  }

  return { urlsByMessageId, sourcesByMessageId };
}
