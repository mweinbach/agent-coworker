import {
  collapseWhitespace,
  DEFAULT_SESSION_TITLE,
  limitTokenCount,
  stripWrappingQuotes,
  TITLE_MAX_CHARS,
  TITLE_MAX_TOKENS,
  truncateToCharLimit,
} from "./shared";

export function heuristicTitleFromQuery(query: string): string {
  const compact = collapseWhitespace(stripWrappingQuotes(query));
  if (!compact) return DEFAULT_SESSION_TITLE;

  const withoutTrailingPunctuation = compact.replace(/[.!?]+$/g, "").trim();
  const tokenBound = limitTokenCount(withoutTrailingPunctuation || compact, TITLE_MAX_TOKENS);
  const charBound =
    tokenBound.length > TITLE_MAX_CHARS
      ? truncateToCharLimit(tokenBound, TITLE_MAX_CHARS)
      : tokenBound;
  return charBound || DEFAULT_SESSION_TITLE;
}
