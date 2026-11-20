import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { coworkHome, home } from "../src/platform/paths";

import {
  assertCandidateNewerThanOriginating,
  assertReleaseTagMatchesVersion,
  ORIGINATING_ELECTRON_TAG,
  ORIGINATING_ELECTRON_VERSION,
  verifyAssembledReleaseDir,
} from "./assemble_rune_release";
import {
  type BridgeUpgradeLaneId,
  type BridgeUpgradeLaneSpec,
  PINNED_ORIGINATING_FIXTURE,
  resolveBridgeUpgradeLane,
  type SeededBridgeProfile,
  seedDisposableBridgeProfile,
  verifyBridgeProfileContinuity,
} from "./bridge_upgrade_fixture";
import { type BridgeFeedRequestLog, startBridgeUpgradeServer } from "./bridge_upgrade_server";
import {
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  normalizeSemverVersion,
} from "./desktop_rune_release_manifest";
import {
  inspectMachOArchs,
  parsePlistXmlStringValues,
  verifyMacCodeSignatureAndNotarization,
} from "./legacy_mac_updater";
import {
  EXPECTED_WINDOWS_MAIN_EXE,
  inspectPeMachine,
  PE_MACHINE_ARM64,
  PE_MACHINE_X64,
  verifyWindowsAuthenticodeSignature,
} from "./legacy_windows_updater";

export interface BridgeUpgradeReport {
  lane: BridgeUpgradeLaneId;
  runner: string;
  originatingVersion: string;
  originatingTag: string;
  originatingCommitSha: string;
  candidateVersion: string;
  candidateTag: string;
  followupVersion: string;
  followupTag: string;
  installPath: string;
  hop1: {
    originatingPid: number;
    originatingExited: boolean;
    relaunchedRunePid: number;
    relaunchedProcessCount: number;
    verifiedVersion: string;
    verifiedSigned: boolean;
    profileContinuous: boolean;
  };
  hop2: {
    previousRunePid: number;
    previousExited: boolean;
    relaunchedRunePid: number;
    relaunchedProcessCount: number;
    verifiedVersion: string;
    verifiedSigned: boolean;
    profileContinuous: boolean;
  };
  auditRequestCount: number;
  completedAt: string;
}

export function assertDisposableRunnerGuard(params: {
  allowDisposableHost: boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!params.allowDisposableHost) {
    throw new Error(
      "Refusing to run destructive native upgrade harness without --allow-disposable-host. Native upgrade chains must only run on disposable CI runners, never on a personal workstation.",
    );
  }
  const isDisposableCi = env.GITHUB_ACTIONS === "true" || env.COWORK_DISPOSABLE_CI_RUNNER === "1";
  if (!isDisposableCi) {
    throw new Error(
      "Refusing to mutate OS trust store, hosts routing, or app installations outside disposable CI (expected GITHUB_ACTIONS=true or COWORK_DISPOSABLE_CI_RUNNER=1).",
    );
  }
}

export function buildLateClientAdditionalAtomTags(params: {
  candidateTag: string;
  candidateVersion: string;
}): Array<{ tag: string; version: string; pubDate: string }> {
  const entries: Array<{ tag: string; version: string; pubDate: string }> = [];
  const prefix = params.candidateTag.startsWith("desktop-rune-v") ? "desktop-rune-v" : "v";
  const normalizedCandidate = normalizeSemverVersion(params.candidateVersion);
  const skippedIntermediate = normalizedCandidate === "1.4.0" ? "1.3.2" : "1.4.0";
  const skippedTag = `${prefix}${skippedIntermediate}`;
  if (skippedTag !== params.candidateTag) {
    entries.push({
      tag: skippedTag,
      version: skippedIntermediate,
      pubDate: "2026-11-01T00:00:00Z",
    });
  }
  entries.push({
    tag: ORIGINATING_ELECTRON_TAG,
    version: ORIGINATING_ELECTRON_VERSION,
    pubDate: "2026-10-04T15:54:49Z",
  });
  return entries;
}

export function assertHop1AuditLog(params: {
  requests: readonly BridgeFeedRequestLog[];
  owner: string;
  repo: string;
  candidateTag: string;
  candidateVersion: string;
  lane: BridgeUpgradeLaneSpec;
}): void {
  const prefix = `/${params.owner}/${params.repo}/releases`;
  const hop1Reqs = params.requests.filter(
    (req) => req.activeTagAtRequest === params.candidateTag && req.status === 200,
  );
  const hasAtom = hop1Reqs.some((req) => req.pathname === `${prefix}.atom`);
  const hasLatest = hop1Reqs.some(
    (req) =>
      req.pathname === `${prefix}/latest` ||
      req.pathname === `/api/v3/repos/${params.owner}/${params.repo}/releases/latest`,
  );
  const expectedChannelPath = `${prefix}/download/${params.candidateTag}/${params.lane.candidateChannelFile}`;
  const hasChannel = hop1Reqs.some((req) => req.pathname === expectedChannelPath);
  const expectedAssetName = params.lane.resolveCandidateLegacyAsset(params.candidateVersion);
  const expectedAssetPath = `${prefix}/download/${params.candidateTag}/${expectedAssetName}`;
  const hasAsset = hop1Reqs.some((req) => req.pathname === expectedAssetPath);

  const missing: string[] = [];
  if (!hasAtom) missing.push(`${prefix}.atom`);
  if (!hasLatest) missing.push(`${prefix}/latest`);
  if (!hasChannel) missing.push(expectedChannelPath);
  if (!hasAsset) missing.push(expectedAssetPath);

  if (missing.length > 0) {
    throw new Error(
      `Hop 1 (originating Electron -> Rune ${params.candidateTag}) did not observe required real updater requests: ${missing.join(", ")}`,
    );
  }
}

export function advanceBridgeFeedAfterHop1Download(params: {
  server: { getRequests: () => BridgeFeedRequestLog[]; setActiveTag: (tag: string) => void };
  owner: string;
  repo: string;
  candidateTag: string;
  candidateVersion: string;
  followupTag: string;
  lane: BridgeUpgradeLaneSpec;
}): void {
  assertHop1AuditLog({
    requests: params.server.getRequests(),
    owner: params.owner,
    repo: params.repo,
    candidateTag: params.candidateTag,
    candidateVersion: params.candidateVersion,
    lane: params.lane,
  });
  params.server.setActiveTag(params.followupTag);
}

export function assertHop2AuditLog(params: {
  requests: readonly BridgeFeedRequestLog[];
  owner: string;
  repo: string;
  followupTag: string;
  followupVersion: string;
  lane: BridgeUpgradeLaneSpec;
  candidateTag?: string;
}): void {
  const prefix = `/${params.owner}/${params.repo}/releases`;
  const expectedFeedPath = `${prefix}/latest/download/latest.json`;

  if (params.candidateTag) {
    const prematureCandidatePoll = params.requests.find(
      (req) => req.pathname === expectedFeedPath && req.activeTagAtRequest === params.candidateTag,
    );
    if (prematureCandidatePoll) {
      throw new Error(
        `Hop 2 feed timing race detected: Rune polled ${expectedFeedPath} while active Latest tag was still ${params.candidateTag} (expected feed to advance to ${params.followupTag} before candidate's first update poll).`,
      );
    }
  }

  const hop2Reqs = params.requests.filter(
    (req) => req.activeTagAtRequest === params.followupTag && req.status === 200,
  );
  const expectedAssetName = params.lane.resolveFollowupNativeAsset(params.followupVersion);
  const expectedAssetPath = `${prefix}/download/${params.followupTag}/${expectedAssetName}`;

  const hasFeed = hop2Reqs.some((req) => req.pathname === expectedFeedPath);
  const hasAsset = hop2Reqs.some((req) => req.pathname === expectedAssetPath);

  const missing: string[] = [];
  if (!hasFeed) missing.push(expectedFeedPath);
  if (!hasAsset) missing.push(expectedAssetPath);

  if (missing.length > 0) {
    throw new Error(
      `Hop 2 (Rune candidate -> Rune ${params.followupTag}) did not observe required real native updater requests: ${missing.join(", ")}`,
    );
  }
}

/**
 * Normalizes a Windows registry `InstallLocation` value for exact path comparison.
 * Accepts either an unquoted absolute directory path (`C:\Users\...\Cowork`) or a
 * single balanced double-quoted path (`"C:\Users\...\Cowork"`, as written to
 * `UNINSTKEY\InstallLocation` by `crates/cowork-desktop/packaging/nsis/installer.nsi`).
 * Rejects empty values, unbalanced quotes, embedded quotes, and relative paths.
 */
export function normalizeWindowsInstallLocation(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Windows InstallLocation is empty.");
  }

  let unquoted = trimmed;
  if (unquoted.startsWith('"') || unquoted.endsWith('"')) {
    if (!(unquoted.startsWith('"') && unquoted.endsWith('"') && unquoted.length >= 2)) {
      throw new Error(`Windows InstallLocation has unbalanced quotes: ${raw}`);
    }
    unquoted = unquoted.slice(1, -1).trim();
  }

  if (!unquoted || unquoted.includes('"')) {
    throw new Error(`Windows InstallLocation is empty or contains embedded quotes: ${raw}`);
  }

  if (!/^[A-Za-z]:[\\/]/.test(unquoted)) {
    throw new Error(`Windows InstallLocation is not an absolute drive path: ${raw}`);
  }

  const normalized = unquoted.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\+$/.test(normalized)) {
    return `${normalized.slice(0, 2)}\\`;
  }
  return normalized.replace(/\\+$/, "");
}

export function assertWindowsInstallLocationMatches(actualRaw: string, expectedDir: string): void {
  const actual = normalizeWindowsInstallLocation(actualRaw);
  const expected = normalizeWindowsInstallLocation(expectedDir);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Rune InstallLocation drifted: ${actualRaw} vs ${expectedDir}`);
  }
}

export function parseAndVerifyWindowsRuneRegistryOutput(
  stdout: string,
  expected: { installDir: string; expectedVersion: string },
): void {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Windows Rune uninstall registry check returned empty output.");
  }
  const parsed = JSON.parse(trimmed) as {
    DisplayVersion?: unknown;
    InstallLocation?: unknown;
  };
  const displayVersion = typeof parsed.DisplayVersion === "string" ? parsed.DisplayVersion : "";
  if (displayVersion !== expected.expectedVersion) {
    throw new Error(
      `Rune uninstall DisplayVersion is ${displayVersion}, expected ${expected.expectedVersion}`,
    );
  }
  const installLocation = typeof parsed.InstallLocation === "string" ? parsed.InstallLocation : "";
  assertWindowsInstallLocationMatches(installLocation, expected.installDir);
}

async function execCapture(
  cmd: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: options?.cwd,
    env: options?.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function execChecked(
  cmd: string[],
  label: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const res = await execCapture(cmd, options);
  if (res.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${res.exitCode}):\nstdout: ${res.stdout.trim()}\nstderr: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition<T>(
  label: string,
  timeoutMs: number,
  pollMs: number,
  check: () => Promise<T | null | false | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(pollMs);
  }
  const suffix = lastError
    ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
    : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
}

interface RunnerTlsInterceptHandle {
  certPem: string;
  keyPem: string;
  cleanup: () => Promise<void>;
}

async function setupDisposableRunnerGithubIntercept(
  workDir: string,
  platform: "darwin" | "win32",
): Promise<RunnerTlsInterceptHandle> {
  const tlsDir = path.join(workDir, "ephemeral-tls");
  await fs.mkdir(tlsDir, { recursive: true });

  const caKeyPath = path.join(tlsDir, "ca.key");
  const caCertPath = path.join(tlsDir, "ca.crt");
  const leafKeyPath = path.join(tlsDir, "github.key");
  const leafCsrPath = path.join(tlsDir, "github.csr");
  const leafCertPath = path.join(tlsDir, "github.crt");
  const extPath = path.join(tlsDir, "san.ext");

  await fs.writeFile(
    extPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = @alt_names",
      "",
      "[alt_names]",
      "DNS.1 = github.com",
      "IP.1 = 127.0.0.1",
      "",
    ].join("\n"),
    "utf8",
  );

  const opensslBin = "openssl";
  await execChecked(
    [
      opensslBin,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caCertPath,
      "-days",
      "1",
      "-subj",
      "/CN=Cowork Disposable CI Bridge Root CA",
    ],
    "generate ephemeral CA certificate",
  );
  await execChecked(
    [
      opensslBin,
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKeyPath,
      "-out",
      leafCsrPath,
      "-subj",
      "/CN=github.com",
    ],
    "generate ephemeral github.com CSR",
  );
  await execChecked(
    [
      opensslBin,
      "x509",
      "-req",
      "-in",
      leafCsrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      leafCertPath,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extPath,
    ],
    "sign ephemeral github.com TLS certificate",
  );

  const certPem = await fs.readFile(leafCertPath, "utf8");
  const keyPem = await fs.readFile(leafKeyPath, "utf8");
  const hostsPath =
    platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
  const originalHosts = await fs.readFile(hostsPath, "utf8");
  const hostsMarker = "# cowork-disposable-bridge-upgrade";
  const updatedHosts = `${originalHosts.trimEnd()}\n127.0.0.1 github.com ${hostsMarker}\n`;
  let installedWindowsThumbprint: string | null = null;

  if (platform === "darwin") {
    await execChecked(
      [
        "sudo",
        "security",
        "add-trusted-cert",
        "-d",
        "-r",
        "trustRoot",
        "-k",
        "/Library/Keychains/System.keychain",
        caCertPath,
      ],
      "trust ephemeral CA in macOS System keychain",
    );
    const tmpHosts = path.join(tlsDir, "hosts.next");
    await fs.writeFile(tmpHosts, updatedHosts, "utf8");
    await execChecked(["sudo", "cp", tmpHosts, hostsPath], "update /etc/hosts for github.com");
    await execCapture(["sudo", "dscacheutil", "-flushcache"]);
    await execCapture(["sudo", "killall", "-HUP", "mDNSResponder"]);
  } else {
    const thumbOut = await execChecked(
      [
        "pwsh",
        "-NoProfile",
        "-Command",
        `$cert = Import-Certificate -FilePath '${caCertPath.replaceAll("'", "''")}' -CertStoreLocation Cert:\\LocalMachine\\Root; Write-Output $cert.Thumbprint`,
      ],
      "trust ephemeral CA in Windows LocalMachine Root store",
    );
    installedWindowsThumbprint = thumbOut.trim().split(/\r?\n/).pop()?.trim() ?? null;
    await fs.writeFile(hostsPath, updatedHosts, "utf8");
    await execCapture(["ipconfig", "/flushdns"]);
  }

  return {
    certPem,
    keyPem,
    cleanup: async () => {
      try {
        if (platform === "darwin") {
          const restorePath = path.join(tlsDir, "hosts.orig");
          await fs.writeFile(restorePath, originalHosts, "utf8");
          await execCapture(["sudo", "cp", restorePath, hostsPath]);
          await execCapture(["sudo", "security", "remove-trusted-cert", "-d", caCertPath]);
          await execCapture(["sudo", "dscacheutil", "-flushcache"]);
          await execCapture(["sudo", "killall", "-HUP", "mDNSResponder"]);
        } else {
          await fs.writeFile(hostsPath, originalHosts, "utf8");
          if (installedWindowsThumbprint) {
            await execCapture([
              "pwsh",
              "-NoProfile",
              "-Command",
              `Remove-Item -Path 'Cert:\\LocalMachine\\Root\\${installedWindowsThumbprint}' -Force -ErrorAction SilentlyContinue`,
            ]);
          }
          await execCapture(["ipconfig", "/flushdns"]);
        }
      } catch (err) {
        console.warn(
          `[bridge-harness] Cleanup warning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

function resolveDefaultUserDataDir(platform: "darwin" | "win32"): {
  userDataDir: string;
  coworkHomeDir: string;
} {
  const homeDir = home();
  const coworkHomeDir = coworkHome();
  if (platform === "darwin") {
    return {
      userDataDir: path.join(homeDir, "Library", "Application Support", "Cowork"),
      coworkHomeDir,
    };
  }
  const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  return {
    userDataDir: path.join(appData, "Cowork"),
    coworkHomeDir,
  };
}

async function listCoworkProcesses(params: {
  platform: "darwin" | "win32";
  expectedExePath: string;
}): Promise<Array<{ pid: number; path: string }>> {
  if (params.platform === "darwin") {
    const res = await execCapture(["ps", "-axo", "pid=,comm="]);
    if (res.exitCode !== 0) return [];
    const expectedResolved = path.resolve(params.expectedExePath);
    const expectedReal = await fs.realpath(expectedResolved).catch(() => expectedResolved);
    const matches: Array<{ pid: number; path: string }> = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const comm = match[2]!.trim();
      const commReal = await fs.realpath(comm).catch(() => comm);
      if (
        comm === expectedResolved ||
        comm === expectedReal ||
        commReal === expectedReal ||
        comm.startsWith(`${expectedResolved} `) ||
        comm.startsWith(`${expectedReal} `)
      ) {
        matches.push({ pid, path: comm });
      }
    }
    return matches;
  }

  const escaped = path.resolve(params.expectedExePath).replaceAll("'", "''");
  const exeName = path.basename(params.expectedExePath).replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$target = '${escaped}'.ToLowerInvariant()`,
    `$procs = Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $target } | Select-Object ProcessId, ExecutablePath`,
    "@($procs) | ConvertTo-Json -Compress",
  ].join("; ");
  const res = await execCapture(["pwsh", "-NoProfile", "-Command", script]);
  if (res.exitCode !== 0 || !res.stdout.trim()) return [];
  const parsed = JSON.parse(res.stdout.trim()) as
    | { ProcessId?: number; ExecutablePath?: string }
    | Array<{ ProcessId?: number; ExecutablePath?: string }>;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter(
      (item) => typeof item?.ProcessId === "number" && typeof item?.ExecutablePath === "string",
    )
    .map((item) => ({ pid: item.ProcessId!, path: item.ExecutablePath! }));
}

async function isPidAlive(pid: number, platform: "darwin" | "win32"): Promise<boolean> {
  if (platform === "darwin") {
    const res = await execCapture(["kill", "-0", String(pid)]);
    return res.exitCode === 0;
  }
  const res = await execCapture([
    "pwsh",
    "-NoProfile",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
  ]);
  return res.exitCode === 0;
}

async function stopPidIfAlive(pid: number, platform: "darwin" | "win32"): Promise<void> {
  if (!(await isPidAlive(pid, platform))) return;
  if (platform === "darwin") {
    await execCapture(["kill", "-TERM", String(pid)]);
    await sleep(1_500);
    if (await isPidAlive(pid, platform)) {
      await execCapture(["kill", "-KILL", String(pid)]);
    }
  } else {
    await execCapture([
      "pwsh",
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ]);
  }
}

class MinimalCdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message ?? "CDP error"));
        } else {
          entry.resolve(msg.result);
        }
      }
    });
  }

  static async connect(wsUrl: string): Promise<MinimalCdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => resolve();
      const onError = () => reject(new Error(`Failed to connect CDP WebSocket: ${wsUrl}`));
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
    return new MinimalCdpClient(ws);
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const res = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (res.exceptionDetails) {
      throw new Error(`CDP evaluation failed: ${res.exceptionDetails.text ?? "unknown error"}`);
    }
    return res.result?.value as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore close errors
    }
  }
}

async function driveElectronUpdatesRestartToInstall(params: {
  cdpPort: number;
  expectedCandidateVersion: string;
  originatingPid: number;
  platform: "darwin" | "win32";
  timeoutMs: number;
  onBeforeRestartToInstall?: () => Promise<void> | void;
}): Promise<void> {
  const target = await waitForCondition("Electron CDP page target", 60_000, 1_000, async () => {
    const resp = await fetch(`http://127.0.0.1:${params.cdpPort}/json`);
    if (!resp.ok) return null;
    const targets = (await resp.json()) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
      url?: string;
    }>;
    return (
      targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string") ?? null
    );
  });

  const cdp = await MinimalCdpClient.connect(target.webSocketDebuggerUrl!);
  try {
    await cdp.send("Runtime.enable");

    // Wait for renderer preload bridge to mount, then trigger an explicit update check
    // alongside the app's automatic startup check, and wait for phase === "downloaded".
    await waitForCondition("Electron renderer window.cowork preload API", 45_000, 500, async () => {
      return await cdp.evaluate<boolean>(
        `Boolean(window.cowork && typeof window.cowork.getUpdateState === "function")`,
      );
    });

    await cdp.evaluate(`
      (async () => {
        const state = await window.cowork.getUpdateState();
        if (state.phase === "idle" || state.phase === "up-to-date" || state.phase === "error") {
          await window.cowork.checkForUpdates();
        }
        return true;
      })()
    `);

    const downloadedState = await waitForCondition(
      `Electron update downloaded for v${params.expectedCandidateVersion}`,
      params.timeoutMs,
      2_000,
      async () => {
        const state = await cdp.evaluate<{
          phase: string;
          error: string | null;
          release: { version?: string } | null;
        }>(`window.cowork.getUpdateState()`);
        if (state.phase === "error") {
          throw new Error(`Originating Electron updater failed: ${state.error ?? "unknown error"}`);
        }
        if (state.phase === "disabled") {
          throw new Error("Originating Electron updater unexpectedly entered disabled state.");
        }
        if (state.phase === "downloaded") {
          return state;
        }
        return null;
      },
    );

    if (
      downloadedState.release?.version &&
      normalizeSemverVersion(downloadedState.release.version) !==
        normalizeSemverVersion(params.expectedCandidateVersion)
    ) {
      throw new Error(
        `Electron downloaded unexpected version ${downloadedState.release.version}, expected ${params.expectedCandidateVersion}.`,
      );
    }

    // Confirm the originating Electron app stays running until user approves Restart and Install.
    await sleep(3_000);
    if (!(await isPidAlive(params.originatingPid, params.platform))) {
      throw new Error(
        "Originating Electron app exited before user approved Restart and Install (autoInstallOnAppQuit must stay false).",
      );
    }

    // Allow the caller to verify completed Hop 1 requests and advance the local Latest
    // feed to vNext BEFORE triggering Restart and Install so Rune vCandidate's first
    // automatic update check (after its unchanged 10s STARTUP_CHECK_DELAY) sees vNext.
    await params.onBeforeRestartToInstall?.();

    // Navigate to Settings -> Updates and click the real "Restart to update" button if visible;
    // otherwise invoke the same renderer preload action bound to the button (`quitAndInstallUpdate`).
    const clickedButton = await cdp.evaluate<boolean>(`
      (async () => {
        const findBtn = (needle) =>
          Array.from(document.querySelectorAll("button")).find((el) =>
            (el.textContent || "").toLowerCase().includes(needle) && !el.disabled
          );
        const settingsBtn = Array.from(document.querySelectorAll("button, a")).find((el) =>
          (el.textContent || "").trim().toLowerCase() === "settings" ||
          (el.getAttribute("aria-label") || "").toLowerCase().includes("settings")
        );
        if (settingsBtn) settingsBtn.click();
        await new Promise((r) => setTimeout(r, 500));
        const updatesNav = Array.from(document.querySelectorAll("button, a")).find((el) =>
          (el.textContent || "").trim().toLowerCase() === "updates"
        );
        if (updatesNav) updatesNav.click();
        await new Promise((r) => setTimeout(r, 500));
        const restartBtn = findBtn("restart to update");
        if (restartBtn) {
          restartBtn.click();
          return true;
        }
        await window.cowork.quitAndInstallUpdate();
        return false;
      })()
    `);
    console.log(
      `[bridge-harness] Triggered originating Electron Restart and Install (clickedUpdatesButton=${clickedButton}).`,
    );
  } finally {
    cdp.close();
  }
}

async function triggerRuneRestartAndInstallViaOsAccessibility(
  platform: "darwin" | "win32",
): Promise<void> {
  if (platform === "darwin") {
    const script = `
      tell application "System Events"
        tell process "Cowork"
          set frontmost to true
          delay 0.5
          repeat with w in windows
            try
              set btns to (every button of entire contents of w whose name contains "Restart")
              if (count of btns) > 0 then
                click item 1 of btns
                return "clicked"
              end if
            end try
          end repeat
        end tell
      end tell
      return "not-found"
    `;
    const out = await execChecked(["osascript", "-e", script], "macOS Restart & Install UI click");
    if (!out.includes("clicked")) {
      throw new Error(
        `Could not locate Rune "Restart & install" button via macOS accessibility (got: ${out.trim()}).`,
      );
    }
    return;
  }

  const runeProcName = path.basename(EXPECTED_WINDOWS_MAIN_EXE, ".exe");
  const psScript = `
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $proc = Get-Process -Name '${runeProcName}' -ErrorAction Stop | Select-Object -First 1
    $pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
    $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
    foreach ($win in $windows) {
      $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
      foreach ($btn in $buttons) {
        $name = $btn.Current.Name
        if ($name -and $name.ToLowerInvariant().Contains("restart")) {
          $pattern = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          Write-Output "clicked:$name"
          exit 0
        }
      }
    }
    Write-Error "Rune Restart & install button not found in Windows UI Automation tree"
    exit 1
  `;
  const out = await execChecked(
    ["pwsh", "-NoProfile", "-Command", psScript],
    "Windows UI Automation Restart & Install click",
  );
  console.log(`[bridge-harness] Triggered Rune Restart & Install on Windows: ${out.trim()}`);
}

async function verifyInstalledMacRuneBundle(params: {
  appPath: string;
  expectedVersion: string;
  requireSigned: boolean;
}): Promise<void> {
  const plistPath = path.join(params.appPath, "Contents", "Info.plist");
  const plistXml = await fs.readFile(plistPath, "utf8");
  const plist = parsePlistXmlStringValues(plistXml);
  if (plist.CFBundleIdentifier !== PINNED_ORIGINATING_FIXTURE.bundleId) {
    throw new Error(
      `Installed macOS app bundle ID drifted: ${plist.CFBundleIdentifier} (expected ${PINNED_ORIGINATING_FIXTURE.bundleId}).`,
    );
  }
  if (plist.CFBundleExecutable !== "Cowork") {
    throw new Error(
      `Installed macOS CFBundleExecutable drifted: ${plist.CFBundleExecutable} (expected Cowork).`,
    );
  }
  if (normalizeSemverVersion(plist.CFBundleShortVersionString ?? "") !== params.expectedVersion) {
    throw new Error(
      `Installed macOS app version is ${plist.CFBundleShortVersionString}, expected ${params.expectedVersion}.`,
    );
  }

  const electronAsar = path.join(params.appPath, "Contents", "Resources", "app.asar");
  const electronFramework = path.join(
    params.appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  if (await fs.stat(electronAsar).catch(() => null)) {
    throw new Error(`Legacy Electron app.asar still exists after upgrade: ${electronAsar}`);
  }
  if (await fs.stat(electronFramework).catch(() => null)) {
    throw new Error(`Legacy Electron Framework still exists after upgrade: ${electronFramework}`);
  }

  const mainExe = path.join(params.appPath, "Contents", "MacOS", "Cowork");
  const archs = await inspectMachOArchs(mainExe);
  if (!archs.includes("arm64")) {
    throw new Error(`Installed macOS Rune executable lacks arm64 slice: [${archs.join(", ")}]`);
  }

  if (params.requireSigned) {
    await verifyMacCodeSignatureAndNotarization({
      appPath: params.appPath,
      requireDeveloperId: true,
      requireNotarization: true,
      expectedBundleId: PINNED_ORIGINATING_FIXTURE.bundleId,
    });
  }
}

async function verifyInstalledWindowsRune(params: {
  installDir: string;
  expectedVersion: string;
  arch: "x64" | "arm64";
  requireSigned: boolean;
  expectedPublisher?: string;
}): Promise<void> {
  const mainExe = path.join(params.installDir, EXPECTED_WINDOWS_MAIN_EXE);
  const stat = await fs.stat(mainExe).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Expected upgraded Rune executable missing at ${mainExe}`);
  }

  const legacyExe = path.join(params.installDir, "Cowork.exe");
  if (await fs.stat(legacyExe).catch(() => null)) {
    throw new Error(`Legacy Electron Cowork.exe still exists after Windows upgrade: ${legacyExe}`);
  }

  const legacyAsar = path.join(params.installDir, "resources", "app.asar");
  if (await fs.stat(legacyAsar).catch(() => null)) {
    throw new Error(`Legacy Electron app.asar still exists after Windows upgrade: ${legacyAsar}`);
  }

  const pe = await inspectPeMachine(mainExe);
  const expectedMachine = params.arch === "arm64" ? PE_MACHINE_ARM64 : PE_MACHINE_X64;
  if (pe.machine !== expectedMachine) {
    throw new Error(
      `Upgraded Windows ${EXPECTED_WINDOWS_MAIN_EXE} has wrong PE machine 0x${pe.machine.toString(16)}, expected 0x${expectedMachine.toString(16)} (${params.arch}).`,
    );
  }

  if (params.requireSigned) {
    await verifyWindowsAuthenticodeSignature(mainExe, params.expectedPublisher);
  }

  const normalizedInstallDir = normalizeWindowsInstallLocation(params.installDir);
  const escapedDir = normalizedInstallDir.replaceAll("'", "''");
  const verifyRegScript = `
    $ErrorActionPreference = 'Stop'
    $legacyKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PINNED_ORIGINATING_FIXTURE.windowsLegacyUninstallGuid}'
    if (Test-Path $legacyKey) {
      throw "Legacy Electron uninstall entry still exists after upgrade: $legacyKey"
    }
    $runeKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cowork'
    if (-not (Test-Path $runeKey)) {
      throw "Missing Rune uninstall entry: $runeKey"
    }
    $props = Get-ItemProperty -Path $runeKey
    $uninstExe = Join-Path '${escapedDir}' 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstExe)) {
      throw "Missing Rune uninstaller: $uninstExe"
    }
    $startMenuLnk = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Cowork.lnk'
    if (-not (Test-Path -LiteralPath $startMenuLnk)) {
      throw "Missing Start Menu shortcut: $startMenuLnk"
    }
    @{
      DisplayVersion = [string]$props.DisplayVersion
      InstallLocation = [string]$props.InstallLocation
    } | ConvertTo-Json -Compress
  `;
  const regOut = await execChecked(
    ["pwsh", "-NoProfile", "-Command", verifyRegScript],
    "verify Windows single uninstall ownership and shortcuts",
  );
  parseAndVerifyWindowsRuneRegistryOutput(regOut, {
    installDir: normalizedInstallDir,
    expectedVersion: params.expectedVersion,
  });
}

export async function runNativeBridgeUpgradeChain(params: {
  lane: BridgeUpgradeLaneId;
  originatingAssetPath: string;
  candidateDir: string;
  candidateVersion: string;
  candidateTag: string;
  followupDir: string;
  followupVersion: string;
  followupTag: string;
  workDir: string;
  owner?: string;
  repo?: string;
  requireSigned?: boolean;
  expectedWindowsPublisher?: string;
  allowDisposableHost: boolean;
  reportPath?: string;
}): Promise<BridgeUpgradeReport> {
  assertDisposableRunnerGuard({ allowDisposableHost: params.allowDisposableHost });

  const lane = resolveBridgeUpgradeLane(params.lane);
  const owner = (params.owner ?? DEFAULT_GITHUB_OWNER).trim();
  const repo = (params.repo ?? DEFAULT_GITHUB_REPO).trim();
  const candidateVersion = normalizeSemverVersion(params.candidateVersion);
  const followupVersion = normalizeSemverVersion(params.followupVersion);
  const requireSigned = params.requireSigned ?? true;

  assertReleaseTagMatchesVersion(params.candidateTag, candidateVersion);
  assertCandidateNewerThanOriginating(candidateVersion, ORIGINATING_ELECTRON_VERSION);
  assertReleaseTagMatchesVersion(params.followupTag, followupVersion);
  assertCandidateNewerThanOriginating(followupVersion, candidateVersion);

  await verifyAssembledReleaseDir({
    dir: params.candidateDir,
    version: candidateVersion,
    tag: params.candidateTag,
    owner,
    repo,
    requireComplete: false,
    minOriginatingVersion: ORIGINATING_ELECTRON_VERSION,
  });
  await verifyAssembledReleaseDir({
    dir: params.followupDir,
    version: followupVersion,
    tag: params.followupTag,
    owner,
    repo,
    requireComplete: false,
    minOriginatingVersion: candidateVersion,
  });

  const workDir = path.resolve(params.workDir);
  await fs.mkdir(workDir, { recursive: true });

  const { userDataDir, coworkHomeDir } = resolveDefaultUserDataDir(lane.platform);
  const workspaceDir = path.join(workDir, "disposable-workspace");
  const profile: SeededBridgeProfile = await seedDisposableBridgeProfile({
    userDataDir,
    coworkHomeDir,
    workspaceDir,
  });

  // 1. Install pinned originating Electron v1.3.1 into disposable location.
  let installPath: string;
  let originatingExePath: string;
  let runeExePath: string;
  if (lane.platform === "darwin") {
    const appsDir = path.join(workDir, "Applications");
    await fs.mkdir(appsDir, { recursive: true });
    await execChecked(
      ["ditto", "-x", "-k", path.resolve(params.originatingAssetPath), appsDir],
      "extract pinned originating macOS v1.3.1 ZIP",
    );
    installPath = path.join(appsDir, "Cowork.app");
    originatingExePath = path.join(installPath, "Contents", "MacOS", "Cowork");
    runeExePath = originatingExePath;
    await execCapture(["xattr", "-dr", "com.apple.quarantine", installPath]);
  } else {
    await execChecked(
      [path.resolve(params.originatingAssetPath), "/S"],
      "silently install pinned originating Windows v1.3.1 NSIS installer",
    );
    const installLocOut = await execChecked(
      [
        "pwsh",
        "-NoProfile",
        "-Command",
        `(Get-ItemProperty -Path 'HKCU:\\Software\\${PINNED_ORIGINATING_FIXTURE.windowsLegacyUninstallGuid}').InstallLocation`,
      ],
      "read originating Windows InstallLocation",
    );
    installPath = installLocOut.trim() ? normalizeWindowsInstallLocation(installLocOut) : "";
    if (!installPath) {
      throw new Error("Originating Windows v1.3.1 installer did not register InstallLocation.");
    }
    originatingExePath = path.join(installPath, "Cowork.exe");
    runeExePath = path.join(installPath, EXPECTED_WINDOWS_MAIN_EXE);
  }

  // 2. Intercept https://github.com locally on disposable runner ONLY (guaranteed cleanup in finally).
  const tlsIntercept = await setupDisposableRunnerGithubIntercept(workDir, lane.platform);
  let server: Awaited<ReturnType<typeof startBridgeUpgradeServer>> | null = null;
  const spawnedPids = new Set<number>();

  try {
    server = await startBridgeUpgradeServer({
      owner,
      repo,
      releases: [
        { tag: params.candidateTag, version: candidateVersion, dir: params.candidateDir },
        { tag: params.followupTag, version: followupVersion, dir: params.followupDir },
      ],
      initialLatestTag: params.candidateTag,
      additionalAtomTags: buildLateClientAdditionalAtomTags({
        candidateTag: params.candidateTag,
        candidateVersion,
      }),
      hostname: "127.0.0.1",
      port: 443,
      tls: { cert: tlsIntercept.certPem, key: tlsIntercept.keyPem },
      publicOrigin: "https://github.com",
    });

    // 3. Launch unmodified originating Electron v1.3.1 with CDP port on loopback.
    const cdpPort = 9322;
    const oldProc = Bun.spawn(
      [
        originatingExePath,
        `--remote-debugging-port=${cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    spawnedPids.add(oldProc.pid);

    // 4. Wait for real automatic update discovery & download, verify Hop 1 requests,
    // advance Latest -> vNext BEFORE Restart and Install so Rune vCandidate's very first
    // automatic check (after its unchanged 10s STARTUP_CHECK_DELAY) polls vNext, then
    // trigger Restart and Install.
    await driveElectronUpdatesRestartToInstall({
      cdpPort,
      expectedCandidateVersion: candidateVersion,
      originatingPid: oldProc.pid,
      platform: lane.platform,
      timeoutMs: 240_000,
      onBeforeRestartToInstall: () => {
        advanceBridgeFeedAfterHop1Download({
          server: server!,
          owner,
          repo,
          candidateTag: params.candidateTag,
          candidateVersion,
          followupTag: params.followupTag,
          lane,
        });
      },
    });

    if (server.getActiveTag() !== params.followupTag) {
      throw new Error(
        `Bridge feed failed to advance to ${params.followupTag} before candidate launch (active=${server.getActiveTag()}).`,
      );
    }

    // 5. Verify Hop 1: old Electron exits, installed app is Rune vCandidate, single relaunch, profile intact.
    await waitForCondition("originating Electron process exit", 120_000, 1_000, async () => {
      return !(await isPidAlive(oldProc.pid, lane.platform));
    });

    await waitForCondition(
      `installed Rune v${candidateVersion} at ${installPath}`,
      180_000,
      2_000,
      async () => {
        try {
          if (lane.platform === "darwin") {
            await verifyInstalledMacRuneBundle({
              appPath: installPath,
              expectedVersion: candidateVersion,
              requireSigned,
            });
          } else {
            await verifyInstalledWindowsRune({
              installDir: installPath,
              expectedVersion: candidateVersion,
              arch: lane.arch,
              requireSigned,
              expectedPublisher: params.expectedWindowsPublisher,
            });
          }
          return true;
        } catch {
          return false;
        }
      },
    );

    const hop1Procs = await waitForCondition(
      "single relaunched Rune vCandidate process",
      90_000,
      1_500,
      async () => {
        const procs = await listCoworkProcesses({
          platform: lane.platform,
          expectedExePath: runeExePath,
        });
        return procs.length > 0 ? procs : null;
      },
    );
    if (hop1Procs.length !== 1) {
      throw new Error(
        `Expected exactly 1 relaunched Rune process after Hop 1, found ${hop1Procs.length}: ${JSON.stringify(hop1Procs)}`,
      );
    }
    const hop1RunePid = hop1Procs[0]!.pid;
    spawnedPids.add(hop1RunePid);

    await verifyBridgeProfileContinuity(profile);

    // 6. Hop 2: Local feed server was already advanced to vNext before candidate launched;
    // verify real signed Rune -> Rune update discovery, download, Minisign verification, and install.
    const stagingDir = path.join(userDataDir, "updates-staging");
    await waitForCondition(
      `Rune v${candidateVersion} to download & Minisign-verify v${followupVersion}`,
      240_000,
      2_000,
      async () => {
        const reqs = server!.getRequests();
        try {
          assertHop2AuditLog({
            requests: reqs,
            owner,
            repo,
            followupTag: params.followupTag,
            followupVersion,
            lane,
            candidateTag: params.candidateTag,
          });
        } catch {
          return false;
        }
        const entries = await fs.readdir(stagingDir).catch(() => []);
        const hasPart = entries.some((name) => name.endsWith(".part"));
        const hasStaged = entries.some(
          (name) => name.includes(followupVersion) && !name.endsWith(".part"),
        );
        return hasStaged && !hasPart;
      },
    );

    await triggerRuneRestartAndInstallViaOsAccessibility(lane.platform);

    await waitForCondition("Rune vCandidate process exit", 120_000, 1_000, async () => {
      return !(await isPidAlive(hop1RunePid, lane.platform));
    });

    await waitForCondition(
      `installed Rune v${followupVersion} at ${installPath}`,
      180_000,
      2_000,
      async () => {
        try {
          if (lane.platform === "darwin") {
            await verifyInstalledMacRuneBundle({
              appPath: installPath,
              expectedVersion: followupVersion,
              requireSigned,
            });
          } else {
            await verifyInstalledWindowsRune({
              installDir: installPath,
              expectedVersion: followupVersion,
              arch: lane.arch,
              requireSigned,
              expectedPublisher: params.expectedWindowsPublisher,
            });
          }
          return true;
        } catch {
          return false;
        }
      },
    );

    const hop2Procs = await waitForCondition(
      "single relaunched Rune vNext process",
      90_000,
      1_500,
      async () => {
        const procs = await listCoworkProcesses({
          platform: lane.platform,
          expectedExePath: runeExePath,
        });
        return procs.length > 0 ? procs : null;
      },
    );
    if (hop2Procs.length !== 1) {
      throw new Error(
        `Expected exactly 1 relaunched Rune process after Hop 2, found ${hop2Procs.length}: ${JSON.stringify(hop2Procs)}`,
      );
    }
    const hop2RunePid = hop2Procs[0]!.pid;
    spawnedPids.add(hop2RunePid);

    await verifyBridgeProfileContinuity(profile);

    const report: BridgeUpgradeReport = {
      lane: lane.lane,
      runner: lane.runner,
      originatingVersion: ORIGINATING_ELECTRON_VERSION,
      originatingTag: ORIGINATING_ELECTRON_TAG,
      originatingCommitSha: PINNED_ORIGINATING_FIXTURE.commitSha,
      candidateVersion,
      candidateTag: params.candidateTag,
      followupVersion,
      followupTag: params.followupTag,
      installPath,
      hop1: {
        originatingPid: oldProc.pid,
        originatingExited: true,
        relaunchedRunePid: hop1RunePid,
        relaunchedProcessCount: hop1Procs.length,
        verifiedVersion: candidateVersion,
        verifiedSigned: requireSigned,
        profileContinuous: true,
      },
      hop2: {
        previousRunePid: hop1RunePid,
        previousExited: true,
        relaunchedRunePid: hop2RunePid,
        relaunchedProcessCount: hop2Procs.length,
        verifiedVersion: followupVersion,
        verifiedSigned: requireSigned,
        profileContinuous: true,
      },
      auditRequestCount: server.getRequests().length,
      completedAt: new Date().toISOString(),
    };

    if (params.reportPath) {
      const reportFile = path.resolve(params.reportPath);
      await fs.mkdir(path.dirname(reportFile), { recursive: true });
      await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    return report;
  } finally {
    for (const pid of spawnedPids) {
      await stopPidIfAlive(pid, lane.platform);
    }
    if (server) {
      await server.stop();
    }
    await tlsIntercept.cleanup();
  }
}

export function computeReportDigest(report: BridgeUpgradeReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function getFlagValue(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  const prefix = `${flag}=`;
  const eq = argv.find((arg) => arg.startsWith(prefix));
  return eq ? eq.slice(prefix.length) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(
      [
        "Usage:",
        "  bun scripts/bridge_upgrade_harness.ts run \\",
        "    --lane <macos-arm64|windows-x64|windows-arm64> \\",
        "    --originating-asset <path> \\",
        "    --candidate-dir <dir> --candidate-version <semver> --candidate-tag <tag> \\",
        "    --followup-dir <dir> --followup-version <semver> --followup-tag <tag> \\",
        "    --work-dir <dir> [--report <path>] [--require-signed] [--publisher <subject>] \\",
        "    --allow-disposable-host",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "run") {
    const lane = getFlagValue(args, "--lane");
    const originatingAssetPath = getFlagValue(args, "--originating-asset");
    const candidateDir = getFlagValue(args, "--candidate-dir");
    const candidateVersion = getFlagValue(args, "--candidate-version");
    const candidateTag = getFlagValue(args, "--candidate-tag");
    const followupDir = getFlagValue(args, "--followup-dir");
    const followupVersion = getFlagValue(args, "--followup-version");
    const followupTag = getFlagValue(args, "--followup-tag");
    const workDir = getFlagValue(args, "--work-dir");
    const owner = getFlagValue(args, "--owner");
    const repo = getFlagValue(args, "--repo");
    const reportPath = getFlagValue(args, "--report");
    const expectedWindowsPublisher =
      getFlagValue(args, "--publisher") ?? process.env.WINDOWS_SIGN_PUBLISHER;
    const requireSigned = args.includes("--require-signed");
    const allowDisposableHost = args.includes("--allow-disposable-host");

    if (!lane) throw new Error("Missing required --lane.");
    if (!originatingAssetPath) throw new Error("Missing required --originating-asset.");
    if (!candidateDir) throw new Error("Missing required --candidate-dir.");
    if (!candidateVersion) throw new Error("Missing required --candidate-version.");
    if (!candidateTag) throw new Error("Missing required --candidate-tag.");
    if (!followupDir) throw new Error("Missing required --followup-dir.");
    if (!followupVersion) throw new Error("Missing required --followup-version.");
    if (!followupTag) throw new Error("Missing required --followup-tag.");
    if (!workDir) throw new Error("Missing required --work-dir.");

    const report = await runNativeBridgeUpgradeChain({
      lane: resolveBridgeUpgradeLane(lane).lane,
      originatingAssetPath,
      candidateDir,
      candidateVersion,
      candidateTag,
      followupDir,
      followupVersion,
      followupTag,
      workDir,
      owner,
      repo,
      requireSigned,
      expectedWindowsPublisher,
      allowDisposableHost,
      reportPath,
    });
    console.log(
      `[bridge-harness] PASSED ${report.lane}: ${report.originatingVersion} -> ${report.candidateVersion} -> ${report.followupVersion} (digest=${computeReportDigest(report).slice(0, 12)})`,
    );
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Expected "run".`);
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
