import { hostPlatform } from "../../platform/host";
import { join, styleFor } from "../../platform/pathString";
import { home as resolveHome } from "../../platform/paths";
import { type ExecFileCompatRunner, execFileCompat } from "../../utils/execFileCompat";
import { isLmStudioError, listLmStudioModels, resolveLmStudioProviderOptions } from "./client";

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_POSITIVE_CACHE_MS = 5_000;
const START_COMMAND_TIMEOUT_MS = 15_000;
const START_DEFAULT_TIMEOUT_MS = 20_000;
const START_MAX_TIMEOUT_MS = 60_000;
const START_POLL_INTERVAL_MS = 500;

export type LmStudioLocalStatus = {
  installed: boolean;
  running: boolean;
  baseUrl: string;
  canAutoStart: boolean;
  cliPath?: string;
  message?: string;
  checkedAt: string;
};

export type LmStudioLocalStartResult = {
  ok: boolean;
  installed: boolean;
  running: boolean;
  baseUrl: string;
  message?: string;
};

export type LmStudioLocalDeps = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  fileExists?: (path: string) => Promise<boolean>;
  execFile?: ExecFileCompatRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type LmStudioLocalService = {
  getStatus(opts?: { baseUrl?: string; providerOptions?: unknown }): Promise<LmStudioLocalStatus>;
  start(opts?: {
    baseUrl?: string;
    providerOptions?: unknown;
    timeoutMs?: number;
  }): Promise<LmStudioLocalStartResult>;
};

export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function resolveLmsCliPath(deps?: LmStudioLocalDeps): string {
  const platform = deps?.platform ?? hostPlatform();
  const home = deps?.homedir?.() ?? resolveHome(deps?.env, platform);
  return join(
    styleFor(platform),
    home,
    ".lmstudio",
    "bin",
    platform === "win32" ? "lms.exe" : "lms",
  );
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseUrlPort(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return parsed.port;
    return parsed.protocol === "https:" ? "443" : "1234";
  } catch {
    return "1234";
  }
}

export function createLmStudioLocalService(deps: LmStudioLocalDeps = {}): LmStudioLocalService {
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const execFile = deps.execFile ?? execFileCompat;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const reachableUntilByBaseUrl = new Map<string, number>();
  const inflightStartByBaseUrl = new Map<string, Promise<LmStudioLocalStartResult>>();

  function resolveBaseUrl(opts?: { baseUrl?: string; providerOptions?: unknown }): {
    baseUrl: string;
    apiKey?: string;
  } {
    const resolved = resolveLmStudioProviderOptions(
      opts?.baseUrl ? { lmstudio: { baseUrl: opts.baseUrl } } : opts?.providerOptions,
      opts?.baseUrl ? {} : env,
    );
    return { baseUrl: resolved.baseUrl, ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}) };
  }

  async function probe(
    baseUrl: string,
    apiKey?: string,
  ): Promise<{ running: boolean; message?: string }> {
    const cachedUntil = reachableUntilByBaseUrl.get(baseUrl);
    if (cachedUntil !== undefined && cachedUntil > now()) {
      return { running: true };
    }
    const baseFetch = deps.fetchImpl ?? fetch;
    const timedFetch = ((input: URL | RequestInfo, init?: RequestInit) =>
      baseFetch(input, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })) as typeof fetch;
    try {
      await listLmStudioModels({ baseUrl, apiKey, fetchImpl: timedFetch });
      reachableUntilByBaseUrl.set(baseUrl, now() + PROBE_POSITIVE_CACHE_MS);
      return { running: true };
    } catch (error) {
      // Any HTTP-level response (auth failure, bad JSON, ...) still proves the
      // server is up; only a failed connection means it is not running.
      if (isLmStudioError(error) && error.code !== "unreachable") {
        reachableUntilByBaseUrl.set(baseUrl, now() + PROBE_POSITIVE_CACHE_MS);
        return { running: true };
      }
      reachableUntilByBaseUrl.delete(baseUrl);
      const message = error instanceof Error ? error.message : String(error);
      return { running: false, message };
    }
  }

  async function getStatus(opts?: {
    baseUrl?: string;
    providerOptions?: unknown;
  }): Promise<LmStudioLocalStatus> {
    const { baseUrl, apiKey } = resolveBaseUrl(opts);
    const cliPath = resolveLmsCliPath(deps);
    const [installed, probed] = await Promise.all([fileExists(cliPath), probe(baseUrl, apiKey)]);
    return {
      installed,
      running: probed.running,
      baseUrl,
      canAutoStart: installed && isLoopbackBaseUrl(baseUrl),
      ...(installed ? { cliPath } : {}),
      ...(probed.message ? { message: probed.message } : {}),
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function startOnce(opts?: {
    baseUrl?: string;
    providerOptions?: unknown;
    timeoutMs?: number;
  }): Promise<LmStudioLocalStartResult> {
    const { baseUrl, apiKey } = resolveBaseUrl(opts);
    const cliPath = resolveLmsCliPath(deps);
    const installed = await fileExists(cliPath);

    if (!isLoopbackBaseUrl(baseUrl)) {
      return {
        ok: false,
        installed,
        running: false,
        baseUrl,
        message: `Cannot auto-start LM Studio for a non-local server (${baseUrl}).`,
      };
    }
    if (!installed) {
      return {
        ok: false,
        installed: false,
        running: false,
        baseUrl,
        message: `LM Studio CLI not found at ${cliPath}. Install LM Studio from https://lmstudio.ai.`,
      };
    }

    const already = await probe(baseUrl, apiKey);
    if (already.running) {
      return { ok: true, installed: true, running: true, baseUrl };
    }

    const timeoutMs = Math.min(
      Math.max(opts?.timeoutMs ?? START_DEFAULT_TIMEOUT_MS, START_POLL_INTERVAL_MS),
      START_MAX_TIMEOUT_MS,
    );
    const deadline = now() + timeoutMs;

    // `lms server start` returns once the daemon is up, but poll reachability
    // ourselves so a slow or log-streaming CLI cannot stall the start flow.
    const command = execFile(cliPath, ["server", "start", "--port", baseUrlPort(baseUrl)], {
      timeoutMs: START_COMMAND_TIMEOUT_MS,
    });
    command.catch(() => {});

    while (now() < deadline) {
      await sleep(START_POLL_INTERVAL_MS);
      const probed = await probe(baseUrl, apiKey);
      if (probed.running) {
        return { ok: true, installed: true, running: true, baseUrl };
      }
    }

    const result = await command;
    const detail = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      installed: true,
      running: false,
      baseUrl,
      message: detail
        ? `LM Studio did not become reachable at ${baseUrl}: ${detail.slice(0, 400)}`
        : `LM Studio did not become reachable at ${baseUrl} within ${Math.round(timeoutMs / 1000)}s.`,
    };
  }

  function start(opts?: {
    baseUrl?: string;
    providerOptions?: unknown;
    timeoutMs?: number;
  }): Promise<LmStudioLocalStartResult> {
    const { baseUrl } = resolveBaseUrl(opts);
    const inflight = inflightStartByBaseUrl.get(baseUrl);
    if (inflight) return inflight;
    const next = startOnce(opts).finally(() => {
      inflightStartByBaseUrl.delete(baseUrl);
    });
    inflightStartByBaseUrl.set(baseUrl, next);
    return next;
  }

  return { getStatus, start };
}
