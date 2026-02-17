const DEFAULT_DESKTOP_RENDERER_PORT = "1420";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export type DesktopRendererUrlResolution = {
  url: string;
  warning?: string;
};

function normalizeDesktopRendererPort(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_DESKTOP_RENDERER_PORT;
  }

  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_DESKTOP_RENDERER_PORT;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_DESKTOP_RENDERER_PORT;
  }

  return String(parsed);
}

function formatFallbackUrl(port: string): string {
  return `http://127.0.0.1:${port}`;
}

function isAllowedDesktopRendererUrl(rawUrl: string, expectedPort: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return false;
  }

  if (parsed.port !== expectedPort) {
    return false;
  }

  return true;
}

export function resolveDesktopRendererUrl(
  electronRendererUrl: string | undefined,
  desktopRendererPort: string | undefined
): DesktopRendererUrlResolution {
  const expectedPort = normalizeDesktopRendererPort(desktopRendererPort);
  const fallbackUrl = formatFallbackUrl(expectedPort);
  const trimmed = electronRendererUrl?.trim();

  if (!trimmed) {
    return { url: fallbackUrl };
  }

  if (isAllowedDesktopRendererUrl(trimmed, expectedPort)) {
    return { url: trimmed };
  }

  return {
    url: fallbackUrl,
    warning: `Ignoring ELECTRON_RENDERER_URL=${trimmed} because only loopback renderer URLs on port ${expectedPort} are allowed for desktop. Falling back to ${fallbackUrl}.`,
  };
}
