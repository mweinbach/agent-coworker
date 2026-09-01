/** Share delimiter selection between SheetJS previews and CSV write-back. */
export function readCsvDialect(text: string): {
  delimiter: string;
  preamble: string;
  content: string;
} {
  const content = text.replace(/^\uFEFF/, "");
  const preamble = /^sep=(.)(?:\r\n|\r|\n)/.exec(content);
  if (preamble) {
    return {
      delimiter: preamble[1] as string,
      preamble: preamble[0],
      content: content.slice(preamble[0].length),
    };
  }

  // Match SheetJS's supported delimiters and tie order, ignoring quoted text.
  const counts = new Map([
    [",", 0],
    ["\t", 0],
    [";", 0],
    ["|", 0],
  ]);
  let inQuotes = false;
  for (const character of content.slice(0, 1_024)) {
    if (character === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }
  let delimiter = ",";
  let largestCount = 0;
  for (const [candidate, count] of counts) {
    if (count > largestCount) {
      delimiter = candidate;
      largestCount = count;
    }
  }
  return { delimiter, preamble: "", content };
}
