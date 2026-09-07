/** Returns the trimmed textual representation used for persisted model-message content. */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
      if (typeof record.inputText === "string" && record.inputText.trim()) {
        return record.inputText.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
