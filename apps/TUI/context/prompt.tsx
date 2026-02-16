import { createContext, useContext, createSignal, type JSX, type Accessor } from "solid-js";

type PromptContextValue = {
  input: Accessor<string>;
  setInput: (v: string) => void;
  history: Accessor<string[]>;
  historyIndex: Accessor<number>;
  navigateUp: () => string | null;
  navigateDown: () => string | null;
  pushHistory: (entry: string) => void;
  stash: Accessor<string | null>;
  doStash: () => void;
  doUnstash: () => string | null;
};

const PromptContext = createContext<PromptContextValue>();

const MAX_HISTORY = 100;

export function PromptProvider(props: { children: JSX.Element }) {
  const [input, setInput] = createSignal("");
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [stash, setStash] = createSignal<string | null>(null);

  const value: PromptContextValue = {
    input,
    setInput(v: string) {
      setInput(v);
      setHistoryIndex(-1);
    },
    history,
    historyIndex,

    navigateUp(): string | null {
      const h = history();
      if (h.length === 0) return null;
      const idx = historyIndex();
      const next = idx < h.length - 1 ? idx + 1 : idx;
      setHistoryIndex(next);
      return h[h.length - 1 - next] ?? null;
    },

    navigateDown(): string | null {
      const idx = historyIndex();
      if (idx <= 0) {
        setHistoryIndex(-1);
        return "";
      }
      const next = idx - 1;
      setHistoryIndex(next);
      const h = history();
      return h[h.length - 1 - next] ?? "";
    },

    pushHistory(entry: string) {
      if (!entry.trim()) return;
      setHistory((prev) => {
        const filtered = prev.filter((e) => e !== entry);
        const next = [...filtered, entry];
        if (next.length > MAX_HISTORY) next.shift();
        return next;
      });
      setHistoryIndex(-1);
    },

    stash,
    doStash() {
      const current = input();
      if (current.trim()) {
        setStash(current);
        setInput("");
      }
    },
    doUnstash(): string | null {
      const saved = stash();
      if (saved !== null) {
        setStash(null);
        return saved;
      }
      return null;
    },
  };

  return (
    <PromptContext.Provider value={value}>
      {props.children}
    </PromptContext.Provider>
  );
}

export function usePrompt(): PromptContextValue {
  const ctx = useContext(PromptContext);
  if (!ctx) throw new Error("usePrompt must be used within PromptProvider");
  return ctx;
}
