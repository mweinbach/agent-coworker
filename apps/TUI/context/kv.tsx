import { createContext, useContext, createSignal, onCleanup, type JSX, type Accessor } from "solid-js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

type KVContextValue = {
  get: (key: string, defaultValue?: string) => string;
  set: (key: string, value: string) => void;
  signal: (key: string, defaultValue: boolean) => [Accessor<boolean>, (v: boolean) => void];
};

const KVContext = createContext<KVContextValue>();

const KV_DIR = path.join(os.homedir(), ".cowork", "config");
const KV_FILE = path.join(KV_DIR, "tui-kv.json");
const kvStoreSchema = z.record(z.string(), z.string());

function loadStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(KV_FILE, "utf-8");
    const parsed = kvStoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {};
    }
    return parsed.data;
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, string>) {
  try {
    fs.mkdirSync(KV_DIR, { recursive: true });
    fs.writeFileSync(KV_FILE, JSON.stringify(store, null, 2));
  } catch {
    // ignore write errors
  }
}

export function KVProvider(props: { children: JSX.Element }) {
  const store = loadStore();
  const subscribersByKey = new Map<string, Set<(nextRaw: string) => void>>();

  const notifySubscribers = (key: string, nextRaw: string) => {
    const subscribers = subscribersByKey.get(key);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      subscriber(nextRaw);
    }
  };

  const setValue = (key: string, val: string) => {
    store[key] = val;
    saveStore(store);
    notifySubscribers(key, val);
  };

  const value: KVContextValue = {
    get(key: string, defaultValue = "") {
      return store[key] ?? defaultValue;
    },

    set(key: string, val: string) {
      setValue(key, val);
    },

    signal(key: string, defaultValue: boolean): [Accessor<boolean>, (v: boolean) => void] {
      const initial = store[key] !== undefined ? store[key] === "true" : defaultValue;
      const [val, setVal] = createSignal(initial);

      const subscriber = (nextRaw: string) => setVal(nextRaw === "true");
      const existing = subscribersByKey.get(key);
      if (existing) {
        existing.add(subscriber);
      } else {
        subscribersByKey.set(key, new Set([subscriber]));
      }

      onCleanup(() => {
        const subscribers = subscribersByKey.get(key);
        if (!subscribers) return;
        subscribers.delete(subscriber);
        if (subscribers.size === 0) subscribersByKey.delete(key);
      });

      const setter = (v: boolean) => {
        setValue(key, String(v));
      };

      return [val, setter];
    },
  };

  return (
    <KVContext.Provider value={value}>
      {props.children}
    </KVContext.Provider>
  );
}

export function useKV(): KVContextValue {
  const ctx = useContext(KVContext);
  if (!ctx) throw new Error("useKV must be used within KVProvider");
  return ctx;
}
