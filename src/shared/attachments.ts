export const MAX_ATTACHMENT_BASE64_SIZE = 10 * 1024 * 1024;

export function formatAttachmentDisplayText(fileNames: readonly string[]): string {
  const visibleNames = fileNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (visibleNames.length === 0) {
    return "";
  }
  return `[${visibleNames.join(", ")}]`;
}
