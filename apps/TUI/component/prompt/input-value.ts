type UnknownRecord = Record<string, unknown>;

function readStringField(value: UnknownRecord, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

export function resolveTextareaInputValue(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return fallback;

  const asRecord = raw as UnknownRecord;
  return (
    readStringField(asRecord, "value") ??
    readStringField(asRecord, "text") ??
    readStringField(asRecord, "content") ??
    fallback
  );
}
