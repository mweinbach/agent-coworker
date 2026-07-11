import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import {
  extractCitationSourcesFromWebSearchResult,
  extractCitationUrlsFromWebSearchResult,
} from "../../../../../src/shared/displayCitationMarkers";
import type { ReadFileForPreviewOutput } from "../../lib/desktopApi";
import { loadTextPreviewResource } from "../../lib/filePreviewResource";

type OverflowCitationContext = {
  sourcesByMessageId: Map<string, CitationSource[]>;
  urlsByMessageId: Map<string, Map<number, string>>;
};

type OverflowCitationReader = (input: {
  path: string;
  maxBytes?: number;
}) => Promise<ReadFileForPreviewOutput>;

async function readCachedCitationFile(
  input: { path: string },
  signal?: AbortSignal,
  reader?: OverflowCitationReader,
): Promise<string> {
  return (await loadTextPreviewResource({ path: input.path, signal, reader })).value;
}

export function buildOverflowCitationPathSignature(
  entries: Array<[messageId: string, filePath: string]>,
): string {
  return JSON.stringify(entries);
}

export async function loadOverflowCitationContext(
  entries: Array<[messageId: string, filePath: string]>,
  readFileFn?: OverflowCitationReader,
  signal?: AbortSignal,
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
      if (signal?.aborted) {
        throw signal.reason;
      }
      let content = textByPath.get(filePath);
      if (content === undefined) {
        content = await readCachedCitationFile({ path: filePath }, signal, readFileFn);
        if (signal?.aborted) {
          throw signal.reason;
        }
        textByPath.set(filePath, content);
      }

      urlsByMessageId.set(messageId, extractCitationUrlsFromWebSearchResult(content));

      const sources = extractCitationSourcesFromWebSearchResult(content);
      if (sources.length > 0 && latestMessageIdByPath.get(filePath) === messageId) {
        sourcesByMessageId.set(messageId, sources);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      urlsByMessageId.set(messageId, new Map());
    }
  }

  return { urlsByMessageId, sourcesByMessageId };
}
