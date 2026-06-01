import type { CloudSyncProvider } from "../CloudSyncProvider";
import { parseCloudSyncRemoteChange, parseCloudSyncRemoteState } from "../redaction";
import type {
  CloudSyncHealth,
  CloudSyncPatch,
  CloudSyncPullResult,
  CloudSyncRemoteState,
  CloudSyncScope,
} from "../types";

export type CustomHttpCloudSyncProviderOptions = {
  endpoint: string;
  token?: string;
  fetchImpl?: typeof fetch;
};

function joinEndpoint(endpoint: string, suffix: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return `${base}${suffix}`;
}

function authHeaders(token?: string): HeadersInit {
  const trimmed = token?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

export class CustomHttpCloudSyncProvider implements CloudSyncProvider {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CustomHttpCloudSyncProviderOptions) {
    this.endpoint = opts.endpoint.trim();
    this.token = opts.token?.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async readRemoteState(scope: CloudSyncScope): Promise<CloudSyncRemoteState | null> {
    const url = new URL(joinEndpoint(this.endpoint, "/v1/state"));
    url.searchParams.set("scope", scope);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: authHeaders(this.token),
    });
    if (!response.ok) throw new Error(`cloud sync read failed: ${response.status}`);
    return parseCloudSyncRemoteState(await readJson(response));
  }

  async pushPatch(_scope: CloudSyncScope, patch: CloudSyncPatch): Promise<{ cursor?: string }> {
    const response = await this.fetchImpl(joinEndpoint(this.endpoint, "/v1/patch"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(this.token),
      },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(`cloud sync push failed: ${response.status}`);
    const body = await readJson(response);
    return body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "cursor" in body &&
      typeof body.cursor === "string" &&
      body.cursor.trim()
      ? { cursor: body.cursor.trim() }
      : {};
  }

  async pullSince(scope: CloudSyncScope, cursor?: string): Promise<CloudSyncPullResult> {
    const url = new URL(joinEndpoint(this.endpoint, "/v1/changes"));
    url.searchParams.set("scope", scope);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: authHeaders(this.token),
    });
    if (!response.ok) throw new Error(`cloud sync pull failed: ${response.status}`);
    const body = await readJson(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { changes: [] };
    const rawChanges = Array.isArray((body as { changes?: unknown }).changes)
      ? (body as { changes: unknown[] }).changes
      : [];
    return {
      ...(typeof (body as { cursor?: unknown }).cursor === "string" &&
      (body as { cursor: string }).cursor.trim()
        ? { cursor: (body as { cursor: string }).cursor.trim() }
        : {}),
      changes: rawChanges
        .map((entry) => parseCloudSyncRemoteChange(entry))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    };
  }

  async healthCheck(): Promise<CloudSyncHealth> {
    const response = await this.fetchImpl(joinEndpoint(this.endpoint, "/v1/health"), {
      method: "GET",
      headers: authHeaders(this.token),
    });
    if (!response.ok) {
      return { ok: false, status: "error", message: `HTTP ${response.status}` };
    }
    return { ok: true, status: "connected" };
  }

  async shutdown(): Promise<void> {}
}

export function createCustomHttpCloudSyncProvider(
  opts: CustomHttpCloudSyncProviderOptions,
): CloudSyncProvider {
  return new CustomHttpCloudSyncProvider(opts);
}
