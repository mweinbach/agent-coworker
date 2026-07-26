import fs from "node:fs/promises";
import path from "node:path";

import { asRecord, asString } from "../../shared/recordParsing";
import { windowsSandboxHome } from "./windows";

/**
 * Keeps the Codex Windows-sandbox setup state consistent across the two
 * Cowork-owned Codex engine homes: Cowork's sandbox home (`~/.cowork`, used
 * by the vendored `cowork-win-sandbox` helper) and the managed app-server's
 * `CODEX_HOME` (`~/.cowork/auth/codex-cli`).
 *
 * Why this exists: the upstream Windows sandbox (`crates/cowork-win-sandbox`,
 * vendored from `openai/codex`, and the managed `codex-app-server` alike)
 * keys its setup state off the engine's home directory —
 * `<home>/.sandbox/setup_marker.json` plus
 * `<home>/.sandbox-secrets/sandbox_users.json` — while the sandbox identities
 * (`CodexSandboxOffline`/`CodexSandboxOnline`) are machine-global local
 * accounts. Every full setup generates FRESH random passwords for those
 * shared accounts (NetUserSetInfo) and records them only in the requesting
 * home's secrets file. Two homes provisioning independently therefore
 * invalidate each other's stored credentials, and each side then re-runs an
 * elevated full setup to repair itself — an endless clobber loop with UAC
 * prompts.
 *
 * The break: setup credentials are DPAPI-protected per Windows user, so both
 * Cowork homes can consume the same state. Newest-wins syncing means neither
 * Cowork-spawned engine ever observes a missing/stale marker, so neither ever
 * triggers a password-resetting full setup over the other.
 *
 * Isolation contract: the native Codex home (`~/.codex`) is NEVER read or
 * written here (mirrors `buildCodexSpawnEnv` — state from a standalone Codex
 * install must not leak into the Cowork-managed runtime). Imported foreign
 * state would be worse than useless: a version- or proxy-skewed marker makes
 * the consumer's `request_mismatch_reason` check fail and triggers the very
 * elevated full setup this module prevents, and a broken-but-newer foreign
 * state would overwrite a working one. When a native Codex install
 * re-provisions the shared accounts, Cowork's homes go stale and Cowork's own
 * one-time setup repairs them — an upstream cross-product limitation, not
 * something reading `~/.codex` may paper over.
 *
 * `SETUP_VERSION` compatibility: only states whose marker AND users versions
 * match {@link CODEX_WINDOWS_SANDBOX_SETUP_VERSION} are propagated — the
 * vendored helper and the managed app-server both understand that version. A
 * newer/older state is ignored (the affected engine falls back to upstream's
 * own re-setup path, i.e. status quo without this module).
 */

/** Matches `SETUP_VERSION` in crates/cowork-win-sandbox (upstream windows-sandbox-rs). */
export const CODEX_WINDOWS_SANDBOX_SETUP_VERSION = 5;

const SETUP_MARKER_RELATIVE = path.join(".sandbox", "setup_marker.json");
const SANDBOX_USERS_RELATIVE = path.join(".sandbox-secrets", "sandbox_users.json");

export type CodexWindowsSandboxSetupSyncResult = {
  /** Home that supplied the winning state (undefined when no complete state exists). */
  sourceHome?: string;
  /** Writable homes whose state was created/refreshed from the winner. */
  updatedHomes: string[];
};

type SetupState = {
  markerContents: string;
  usersContents: string;
  /** Newer wins: marker `created_at` when present, else the marker file's mtime. */
  freshness: number;
};

type SyncParticipant = {
  home: string;
  state: SetupState | null;
};

function parseVersion(json: unknown): number | undefined {
  const record = asRecord(json);
  const version = record?.version;
  return typeof version === "number" && Number.isFinite(version) ? version : undefined;
}

async function readSetupState(home: string): Promise<SetupState | null> {
  const markerPath = path.join(home, SETUP_MARKER_RELATIVE);
  const usersPath = path.join(home, SANDBOX_USERS_RELATIVE);
  let markerRaw: string;
  let usersRaw: string;
  try {
    [markerRaw, usersRaw] = await Promise.all([
      fs.readFile(markerPath, "utf8"),
      fs.readFile(usersPath, "utf8"),
    ]);
  } catch {
    return null;
  }
  try {
    if (parseVersion(JSON.parse(markerRaw)) !== CODEX_WINDOWS_SANDBOX_SETUP_VERSION) return null;
    if (parseVersion(JSON.parse(usersRaw)) !== CODEX_WINDOWS_SANDBOX_SETUP_VERSION) return null;
  } catch {
    return null;
  }
  let freshness = Number.NaN;
  try {
    const createdAt = asString(asRecord(JSON.parse(markerRaw))?.created_at);
    if (createdAt) freshness = Date.parse(createdAt);
  } catch {
    // fall through to the mtime fallback
  }
  if (!Number.isFinite(freshness)) {
    try {
      freshness = (await fs.stat(markerPath)).mtimeMs;
    } catch {
      freshness = 0;
    }
  }
  return { markerContents: markerRaw, usersContents: usersRaw, freshness };
}

async function writeSetupState(home: string, state: SetupState): Promise<void> {
  const targets: Array<[string, string]> = [
    [path.join(home, SETUP_MARKER_RELATIVE), state.markerContents],
    [path.join(home, SANDBOX_USERS_RELATIVE), state.usersContents],
  ];
  for (const [target, contents] of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, target);
  }
}

export type CodexWindowsSandboxSetupSyncOptions = {
  /** Defaults to the host platform; injectable for tests. */
  platform?: NodeJS.Platform;
  /** Environment for home resolution (COWORK_HOME_OVERRIDE / COWORK_WIN_SANDBOX_HOME). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

/**
 * Newest-wins sync of the Windows sandbox setup marker + credentials between
 * Cowork's sandbox home and the managed app-server's CODEX_HOME. Win32-only;
 * a no-op elsewhere. Best-effort: never throws — a failed sync must not block
 * app-server startup, it just means the engines fall back to upstream's own
 * setup behavior.
 */
export async function syncCodexWindowsSandboxSetupState(
  codexHome: string,
  opts: CodexWindowsSandboxSetupSyncOptions = {},
): Promise<CodexWindowsSandboxSetupSyncResult> {
  const result: CodexWindowsSandboxSetupSyncResult = { updatedHomes: [] };
  // `bun test` sets NODE_ENV=test; suites must stay hermetic (no writes to the
  // developer's real ~/.cowork), so the default invocation no-ops under test.
  // This module's own tests inject the levers explicitly.
  if (process.env.NODE_ENV === "test" && !opts.platform && !opts.env) {
    return result;
  }
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return result;

  const env = opts.env ?? process.env;
  // Only Cowork-owned homes participate. The native Codex home (`~/.codex`)
  // is never read or written: foreign setup state must not leak into the
  // Cowork-managed runtime (see the module docstring).
  const declared = [windowsSandboxHome(env), codexHome];

  // Dedupe by resolved path (Windows paths are case-insensitive) in case the
  // two homes alias each other in a non-standard configuration.
  const homes = new Map<string, string>();
  for (const entry of declared) {
    const resolved = path.resolve(entry);
    homes.set(resolved.toLowerCase(), resolved);
  }

  const participants: SyncParticipant[] = [];
  for (const participantHome of homes.values()) {
    let state: SetupState | null = null;
    try {
      state = await readSetupState(participantHome);
    } catch (error) {
      opts.log?.(
        `[codex-windows-sandbox] failed to read setup state from ${participantHome}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    participants.push({ home: participantHome, state });
  }

  let winner: SyncParticipant | null = null;
  for (const participant of participants) {
    if (!participant.state) continue;
    if (!winner || (winner.state?.freshness ?? -1) < participant.state.freshness) {
      winner = participant;
    }
  }
  if (!winner?.state) return result;
  result.sourceHome = winner.home;

  for (const participant of participants) {
    if (participant === winner) continue;
    if (participant.state && participant.state.freshness >= winner.state.freshness) continue;
    try {
      await writeSetupState(participant.home, winner.state);
      result.updatedHomes.push(participant.home);
      opts.log?.(
        `[codex-windows-sandbox] synced sandbox setup state ${winner.home} -> ${participant.home}`,
      );
    } catch (error) {
      opts.log?.(
        `[codex-windows-sandbox] failed to sync setup state to ${participant.home}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
}
