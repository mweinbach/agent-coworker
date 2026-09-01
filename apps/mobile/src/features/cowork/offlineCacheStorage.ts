type SecureStore = Pick<
  typeof import("expo-secure-store"),
  "getItemAsync" | "setItemAsync" | "deleteItemAsync"
>;

export type OfflineCacheScope = Readonly<{ desktopId: string | null; generation: number }>;

const LAST_DESKTOP_KEY = "cowork.cache.lastDesktop.v1";
const LEGACY_RECOVERY_KEY = "cowork.cache.legacyDraftRecovery.v1";
const DRAFT_RECOVERY_OWNER_KEY = "cowork.cache.draftRecoveryOwner.v1";
const WORKSPACE_BOUND_KEYS = new Set([
  "controlSnapshot",
  "providerCatalog",
  "providerAuthMethods",
  "providerStatus",
  "mcpServers",
  "mcpFiles",
  "mcpWarnings",
  "skills",
  "skillsCatalog",
  "skillsInstallations",
  "skillsEffectiveInstallations",
  "memories",
  "backups",
  "workspacePath",
]);
export const OFFLINE_WORKSPACE_CACHE_KEYS = [
  "workspaces",
  "activeWorkspaceId",
  "activeWorkspaceName",
  "activeWorkspaceCwd",
  "controlSnapshot",
  "providerCatalog",
  "providerAuthMethods",
  "providerStatus",
  "mcpServers",
  "mcpFiles",
  "mcpWarnings",
  "skills",
  "skillsCatalog",
  "skillsInstallations",
  "skillsEffectiveInstallations",
  "memories",
  "backups",
  "workspacePath",
  "threadSnapshots",
] as const;

let secureStorePromise: Promise<SecureStore> | null = null;
let scope: OfflineCacheScope = { desktopId: null, generation: 0 };
let activeWorkspaceCwd: string | null = null;
const writes = new Map<string, Promise<void>>();
const forgottenDesktops = new Set<string>();

async function getSecureStore(): Promise<SecureStore> {
  secureStorePromise ??= import("expo-secure-store");
  return secureStorePromise;
}

function cacheKey(key: string, desktopId: string | null): string {
  const owner =
    desktopId === null
      ? "unpaired"
      : Array.from(new TextEncoder().encode(desktopId), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  return `cowork.cache.v2.${owner}.${key}`;
}

function enqueueWrite(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  writes.set(key, next);
  void next
    .finally(() => {
      if (writes.get(key) === next) writes.delete(key);
    })
    .catch(() => {});
  return next;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    await writes.get(key)?.catch(() => {});
    const raw = await (await getSecureStore()).getItemAsync(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function getOfflineCacheScope(): OfflineCacheScope {
  return scope;
}

export function setOfflineCacheDesktop(desktopId: string | null): OfflineCacheScope {
  if (scope.desktopId === desktopId) return scope;
  if (desktopId !== null) forgottenDesktops.delete(desktopId);
  scope = { desktopId, generation: scope.generation + 1 };
  void enqueueWrite(LAST_DESKTOP_KEY, async () => {
    await (await getSecureStore()).setItemAsync(LAST_DESKTOP_KEY, JSON.stringify(desktopId));
  }).catch(() => {});
  return scope;
}

export function retireOfflineCacheDesktop(desktopId: string): void {
  forgottenDesktops.add(desktopId);
}

export function setOfflineCacheWorkspace(cwd: string | null): void {
  activeWorkspaceCwd = cwd;
}

export async function resolveOfflineCacheDesktop(
  connectedDesktopId: string | null,
  trustedDesktopIds: readonly string[],
): Promise<string | null> {
  const before = scope;
  const previous = await readJson<unknown>(LAST_DESKTOP_KEY);
  if (scope !== before) return scope.desktopId;
  const desktopId =
    connectedDesktopId ??
    (typeof previous === "string" && trustedDesktopIds.includes(previous)
      ? previous
      : trustedDesktopIds.length === 1
        ? (trustedDesktopIds[0] ?? null)
        : null);
  return desktopId;
}

export async function saveToOfflineCache(
  key: string,
  value: unknown,
  desktopId = scope.desktopId,
  workspaceCwd = activeWorkspaceCwd,
): Promise<boolean> {
  try {
    if (desktopId !== null && forgottenDesktops.has(desktopId)) return true;
    const serialized = JSON.stringify(
      WORKSPACE_BOUND_KEYS.has(key) ? { cacheVersion: 1, workspaceCwd, value } : value,
    );
    const storageKey = cacheKey(key, desktopId);
    await enqueueWrite(storageKey, async () => {
      if (desktopId !== null && forgottenDesktops.has(desktopId)) return;
      await (await getSecureStore()).setItemAsync(storageKey, serialized);
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadFromOfflineCache<T>(
  key: string,
  desktopId = scope.desktopId,
  workspaceCwd = activeWorkspaceCwd,
): Promise<T | null> {
  const stored = await readJson<
    T | { cacheVersion: number; workspaceCwd: string | null; value: T }
  >(cacheKey(key, desktopId));
  if (!WORKSPACE_BOUND_KEYS.has(key)) return stored as T | null;
  if (
    stored === null ||
    typeof stored !== "object" ||
    !("cacheVersion" in stored) ||
    stored.cacheVersion !== 1 ||
    !("workspaceCwd" in stored) ||
    stored.workspaceCwd !== workspaceCwd ||
    !("value" in stored)
  )
    return null;
  return stored.value as T;
}

export async function loadLegacyThreadCache(): Promise<unknown> {
  if (await readJson<boolean>(LEGACY_RECOVERY_KEY)) return null;
  return readJson("cowork.cache.threadSnapshots");
}

export async function markLegacyDraftsRecovered(): Promise<void> {
  await enqueueWrite(LEGACY_RECOVERY_KEY, async () => {
    await (await getSecureStore()).setItemAsync(LEGACY_RECOVERY_KEY, "true");
  });
}

export async function claimOfflineDraftRecovery(desktopId: string): Promise<boolean> {
  let claimed = false;
  await enqueueWrite(DRAFT_RECOVERY_OWNER_KEY, async () => {
    const SecureStore = await getSecureStore();
    const raw = await SecureStore.getItemAsync(DRAFT_RECOVERY_OWNER_KEY);
    if (raw !== null && JSON.parse(raw) !== desktopId) return;
    // Persist ownership before copying: interrupted recovery retries on this desktop, never
    // on another trusted host while the source cache is waiting to be removed.
    await SecureStore.setItemAsync(DRAFT_RECOVERY_OWNER_KEY, JSON.stringify(desktopId));
    claimed = true;
  });
  return claimed;
}

export async function clearUnpairedThreadCache(): Promise<void> {
  const key = cacheKey("threadSnapshots", null);
  await enqueueWrite(key, async () => {
    await (await getSecureStore()).deleteItemAsync(key);
  });
}

export async function clearLegacyOfflineCache(forgottenDesktopId?: string): Promise<void> {
  const SecureStore = await getSecureStore();
  await Promise.all([
    ...[
      ...OFFLINE_WORKSPACE_CACHE_KEYS.map((key) => `cowork.cache.${key}`),
      LEGACY_RECOVERY_KEY,
    ].map((key) => enqueueWrite(key, () => SecureStore.deleteItemAsync(key))),
    enqueueWrite(DRAFT_RECOVERY_OWNER_KEY, async () => {
      const raw = await SecureStore.getItemAsync(DRAFT_RECOVERY_OWNER_KEY);
      const owner: unknown = raw === null ? null : JSON.parse(raw);
      if (forgottenDesktopId !== undefined && owner !== forgottenDesktopId) return;
      if (forgottenDesktopId !== undefined) await clearUnpairedThreadCache();
      await SecureStore.deleteItemAsync(DRAFT_RECOVERY_OWNER_KEY);
    }),
  ]);
}

export async function clearAllOfflineWorkspaceCache(desktopId = scope.desktopId): Promise<void> {
  const SecureStore = await getSecureStore();
  await Promise.all(
    OFFLINE_WORKSPACE_CACHE_KEYS.map((key) => {
      const storageKey = cacheKey(key, desktopId);
      return enqueueWrite(storageKey, () => SecureStore.deleteItemAsync(storageKey));
    }),
  );
}
