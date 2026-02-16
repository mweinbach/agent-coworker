import { createContext, useContext, createSignal, type JSX, type Accessor } from "solid-js";

export type KeyCombo = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type Command = {
  id: string;
  name: string;
  description: string;
  category: "session" | "display" | "navigation" | "system";
  keybind?: KeyCombo;
  action: () => void;
};

type KeybindContextValue = {
  commands: Accessor<Command[]>;
  register: (cmd: Command) => void;
  registerMany: (cmds: Command[]) => void;
  unregister: (id: string) => void;
  execute: (id: string) => boolean;
  matchKey: (key: string, ctrl: boolean, shift: boolean, alt: boolean) => Command | null;
};

const KeybindContext = createContext<KeybindContextValue>();

function keysMatch(combo: KeyCombo, key: string, ctrl: boolean, shift: boolean, alt: boolean): boolean {
  if (combo.key.toLowerCase() !== key.toLowerCase()) return false;
  if ((combo.ctrl ?? false) !== ctrl) return false;
  if ((combo.shift ?? false) !== shift) return false;
  if ((combo.alt ?? false) !== alt) return false;
  return true;
}

export function formatKeybind(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join("+");
}

export function KeybindProvider(props: { children: JSX.Element }) {
  const [commands, setCommands] = createSignal<Command[]>([]);

  const value: KeybindContextValue = {
    commands,

    register(cmd: Command) {
      setCommands((prev) => [...prev.filter((c) => c.id !== cmd.id), cmd]);
    },

    registerMany(cmds: Command[]) {
      setCommands((prev) => {
        const ids = new Set(cmds.map((c) => c.id));
        return [...prev.filter((c) => !ids.has(c.id)), ...cmds];
      });
    },

    unregister(id: string) {
      setCommands((prev) => prev.filter((c) => c.id !== id));
    },

    execute(id: string): boolean {
      const cmd = commands().find((c) => c.id === id);
      if (!cmd) return false;
      cmd.action();
      return true;
    },

    matchKey(key: string, ctrl: boolean, shift: boolean, alt: boolean): Command | null {
      for (const cmd of commands()) {
        if (cmd.keybind && keysMatch(cmd.keybind, key, ctrl, shift, alt)) {
          return cmd;
        }
      }
      return null;
    },
  };

  return (
    <KeybindContext.Provider value={value}>
      {props.children}
    </KeybindContext.Provider>
  );
}

export function useKeybind(): KeybindContextValue {
  const ctx = useContext(KeybindContext);
  if (!ctx) throw new Error("useKeybind must be used within KeybindProvider");
  return ctx;
}
