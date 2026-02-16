export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `… (${s.length - maxChars} more chars)`;
}

export function jsonPreview(value: unknown, maxChars = 12_000): string {
  let raw: string;
  if (typeof value === "string") raw = value;
  else {
    try {
      raw = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  return truncateText(raw, maxChars);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  if (count === 1) return `${count} ${singular}`;
  return `${count} ${plural ?? singular + "s"}`;
}
