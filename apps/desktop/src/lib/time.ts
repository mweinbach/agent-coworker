export function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function formatThreadTime(iso: string): string {
  const d = safeDate(iso);
  if (!d) return "";

  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatRelativeAge(iso: string, now: Date = new Date()): string {
  const d = safeDate(iso);
  if (!d) return "";

  const deltaMs = Math.max(0, now.getTime() - d.getTime());
  const minutes = Math.floor(deltaMs / 60_000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  const years = Math.floor(days / 365);
  return `${years}y`;
}
