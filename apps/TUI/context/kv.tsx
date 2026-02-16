import { createContext, useContext, createSignal, type JSX, type Accessor } from "solid-js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type KVContextValue = {
  get: (key: string, defaultValue?: string) => string;
  set: (key: string, value: string) => void;
  signal: (key: string, defaultValue: boolean) => [Accessor<boolean>, (v: boolean) => void];
};

const KVContext = createContext<KVContextValue>();

const KV_DIR = path.join(os.homedir(), ".cowork", "config");
const KV_FILE = path.join(KV_DIR, "tui-kv.json");

function loadStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(KV_FILE, "utf-8");
    return JSON.parse(raw);
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

  const value: KVContextValue = {
    get(key: string, defaultValue = "") {
      return store[key] ?? defaultValue;
    },

    set(key: string, val: string) {
      store[key] = val;
      saveStore(store);
    },

    signal(key: string, defaultValue: boolean): [Accessor<boolean>, (v: boolean) => void] {
      const initial = store[key] !== undefined ? store[key] === "true" : defaultValue;
      const [val, setVal] = createSignal(initial);

      const setter = (v: boolean) => {
        setVal(v);
        store[key] = String(v);
        saveStore(store);
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
