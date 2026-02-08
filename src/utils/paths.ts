import path from "node:path";

export function resolveMaybeRelative(p: string, baseDir: string): string {
  if (!p) return p;
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.normalize(path.join(baseDir, p));
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== "..");
}

export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

export function truncateLine(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "...";
}
