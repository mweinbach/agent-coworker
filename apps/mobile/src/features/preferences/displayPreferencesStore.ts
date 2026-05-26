import { create } from "zustand";

const DISPLAY_PREFERENCES_CACHE_KEY = "displayPreferences";

export type DisplayPreferences = {
  showDebugMessages: boolean;
};

type DisplayPreferencesState = DisplayPreferences & {
  hydrated: boolean;
  hydrate(): Promise<void>;
  setShowDebugMessages(value: boolean): void;
};

let secureStorePromise: Promise<typeof import("expo-secure-store")> | null = null;

async function getSecureStore() {
  secureStorePromise ??= import("expo-secure-store");
  return await secureStorePromise;
}

async function persistPreferences(preferences: DisplayPreferences): Promise<void> {
  try {
    const SecureStore = await getSecureStore();
    await SecureStore.setItemAsync(
      `cowork.cache.${DISPLAY_PREFERENCES_CACHE_KEY}`,
      JSON.stringify(preferences),
    );
  } catch {
    // Silent fail in tests / environments without SecureStore
  }
}

async function loadPreferences(): Promise<DisplayPreferences | null> {
  try {
    const SecureStore = await getSecureStore();
    const raw = await SecureStore.getItemAsync(`cowork.cache.${DISPLAY_PREFERENCES_CACHE_KEY}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DisplayPreferences>;
    return {
      showDebugMessages: parsed.showDebugMessages === true,
    };
  } catch {
    return null;
  }
}

export const useDisplayPreferencesStore = create<DisplayPreferencesState>((set) => ({
  showDebugMessages: false,
  hydrated: false,
  async hydrate() {
    const stored = await loadPreferences();
    set({
      hydrated: true,
      showDebugMessages: stored?.showDebugMessages ?? false,
    });
  },
  setShowDebugMessages(value) {
    set({ showDebugMessages: value });
    void persistPreferences({ showDebugMessages: value });
  },
}));
