export function isLoopbackHost(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }
  const normalized =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "::ffff:127.0.0.1"
  );
}
