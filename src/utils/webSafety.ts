import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "metadata.aws.internal",
  "host.docker.internal",
]);

function normalizeHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase().split("%")[0] || host.toLowerCase();
  const hextets = parseIpv6Hextets(normalized);
  if (hextets && isIpv4MappedIpv6(hextets)) {
    const mappedIpv4 = `${(hextets[6] >> 8) & 0xff}.${hextets[6] & 0xff}.${(hextets[7] >> 8) & 0xff}.${hextets[7] & 0xff}`;
    return isPrivateIpv4(mappedIpv4);
  }

  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  if (normalized.startsWith("ff")) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;

  const ipKind = isIP(host);
  if (ipKind === 4) return isPrivateIpv4(host);
  if (ipKind === 6) return isPrivateIpv6(host);
  return false;
}

type LookupResult = { address: string; family: number };
type DnsLookup = (hostname: string) => Promise<LookupResult[]>;

let dnsLookup: DnsLookup = async (hostname: string) => lookup(hostname, { all: true, verbatim: true });

async function assertHostResolvesToPublicAddress(hostname: string): Promise<void> {
  const host = normalizeHost(hostname);
  if (isIP(host) !== 0) return;

  const results = await dnsLookup(host);
  if (results.length === 0) {
    throw new Error(`Blocked unresolved host: ${hostname}`);
  }

  for (const result of results) {
    if (isBlockedHost(result.address)) {
      throw new Error(`Blocked private/internal host: ${hostname}`);
    }
  }
}

function parseIpv6Hextets(host: string): number[] | null {
  if (!host) return null;

  const [left, right] = host.split("::");
  if (host.split("::").length > 2) return null;

  const leftParts = expandIpv6Parts(left);
  const rightParts = expandIpv6Parts(right);
  if (!leftParts || !rightParts) return null;

  const compressedCount = 8 - (leftParts.length + rightParts.length);
  if (compressedCount < 0) return null;
  if (!host.includes("::") && compressedCount !== 0) return null;

  return [...leftParts, ...new Array(compressedCount).fill(0), ...rightParts];
}

function expandIpv6Parts(segment: string | undefined): number[] | null {
  if (!segment) return [];

  const pieces = segment.split(":");
  const result: number[] = [];
  for (const piece of pieces) {
    if (!piece) return null;
    if (piece.includes(".")) {
      if (isIP(piece) !== 4) return null;
      const ipv4Octets = piece.split(".").map((octet) => Number(octet));
      result.push((ipv4Octets[0] << 8) | ipv4Octets[1], (ipv4Octets[2] << 8) | ipv4Octets[3]);
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
    result.push(Number.parseInt(piece, 16));
  }

  return result;
}

function isIpv4MappedIpv6(hextets: number[]): boolean {
  return hextets.length === 8 && hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
}

export async function assertSafeWebUrl(urlRaw: string): Promise<URL> {
  const parsed = new URL(urlRaw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Blocked URL credentials in authority");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Blocked private/internal host: ${parsed.hostname}`);
  }
  await assertHostResolvesToPublicAddress(parsed.hostname);
  return parsed;
}

export const __internal = {
  setDnsLookup(fn: DnsLookup): void {
    dnsLookup = fn;
  },
  resetDnsLookup(): void {
    dnsLookup = async (hostname: string) => lookup(hostname, { all: true, verbatim: true });
  },
};
