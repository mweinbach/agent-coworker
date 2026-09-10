export function parseBearerToken(header: string | null): string | null {
  if (header === null || header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
