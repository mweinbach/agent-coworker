export function resolveAskAnswer(raw: string, options?: string[]) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const asNum = Number(trimmed);
  if (options && options.length > 0 && Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
    return options[asNum - 1];
  }
  return trimmed;
}

export function normalizeApprovalAnswer(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return false;
  if (["y", "yes", "approve", "approved"].includes(trimmed)) return true;
  if (["n", "no", "deny", "denied"].includes(trimmed)) return false;
  return false;
}
