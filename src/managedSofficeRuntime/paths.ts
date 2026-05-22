import path from "node:path";

export function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function managedSofficeRoot(home: string): string {
  return path.join(home, ".cache", "cowork", "libreoffice");
}

export function pathKeyForEnv(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function dedupePathEntries(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export function prependPath(
  env: Record<string, string | undefined>,
  runtimeEnv: Record<string, string>,
  dir: string,
): Record<string, string> {
  const pathKey = pathKeyForEnv(env);
  const existing = env[pathKey] ?? "";
  const next = dedupePathEntries([dir, ...(existing ? existing.split(path.delimiter) : [])]);
  return { ...runtimeEnv, [pathKey]: next.join(path.delimiter) };
}

export function parseSofficeVersion(output: string): string | undefined {
  const match = output.match(/LibreOffice\s+([^\s]+)/i);
  return match?.[1];
}

export function parseResolvedSofficePath(stderr: string): string | undefined {
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith("[cowork-soffice] using "));
  return line?.slice("[cowork-soffice] using ".length).trim() || undefined;
}
