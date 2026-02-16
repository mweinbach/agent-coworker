import { createSignal, For, Show, type Accessor } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../context/theme";
import { normalizeKeyName } from "../../util/keyboard";
import { createFrecencyTracker } from "./frecency";

export type AutocompleteItem = {
  label: string;
  value: string;
  description?: string;
  category?: string;
  icon?: string;
};

type AutocompleteMode = "@" | "/" | null;

type AutocompleteState = {
  visible: boolean;
  items: AutocompleteItem[];
  selectedIndex: number;
  mode: AutocompleteMode;
  query: string;
  triggerIndex: number;
};

const MAX_FUZZY_RESULTS = 10;

type TriggerMatch = {
  mode: Exclude<AutocompleteMode, null>;
  query: string;
  triggerIndex: number;
};

function findTrigger(value: string, cursorPos: number): TriggerMatch | null {
  const prefix = value.slice(0, cursorPos);

  // Slash commands are only eligible at token starts (start of input or after whitespace).
  const slash = prefix.match(/(?:^|\s)\/(\S*)$/);
  if (slash) {
    const query = slash[1] ?? "";
    return {
      mode: "/",
      query,
      triggerIndex: prefix.length - query.length - 1,
    };
  }

  // @ mentions/files are also token-based.
  const at = prefix.match(/(?:^|\s)@(\S*)$/);
  if (at) {
    const query = at[1] ?? "";
    return {
      mode: "@",
      query,
      triggerIndex: prefix.length - query.length - 1,
    };
  }

  return null;
}

function fuzzyMatch(items: AutocompleteItem[], query: string): AutocompleteItem[] {
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return items;

  const scored = items
    .map((item) => {
      const label = item.label.toLowerCase();
      const value = item.value.toLowerCase();

      if (label.startsWith(lowerQuery) || value.startsWith(lowerQuery)) {
        return { item, score: 1000 };
      }

      if (label.includes(lowerQuery) || value.includes(lowerQuery)) {
        return { item, score: 500 };
      }

      let queryIndex = 0;
      for (let charIndex = 0; charIndex < label.length && queryIndex < lowerQuery.length; charIndex++) {
        if (label[charIndex] === lowerQuery[queryIndex]) queryIndex++;
      }

      if (queryIndex === lowerQuery.length) {
        return { item, score: 100 };
      }

      return null;
    })
    .filter((row): row is { item: AutocompleteItem; score: number } => row !== null)
    .sort((a, b) => b.score - a.score);

  return scored.map((row) => row.item);
}

export function createAutocomplete(opts: {
  getCommands: () => AutocompleteItem[];
  getFiles?: () => AutocompleteItem[];
}) {
  const [state, setState] = createSignal<AutocompleteState>({
    visible: false,
    items: [],
    selectedIndex: 0,
    mode: null,
    query: "",
    triggerIndex: -1,
  });

  const frecency = createFrecencyTracker();

  function sourceItems(mode: Exclude<AutocompleteMode, null>): AutocompleteItem[] {
    if (mode === "/") return opts.getCommands();
    return opts.getFiles?.() ?? [];
  }

  function updateResults(mode: Exclude<AutocompleteMode, null>, query: string, triggerIndex: number) {
    const source = sourceItems(mode);

    let results: AutocompleteItem[];
    if (!query) {
      // OpenCode parity: slash with empty query shows full command surface.
      results = mode === "/" ? source : source.slice(0, MAX_FUZZY_RESULTS);
    } else {
      results = fuzzyMatch(source, query).slice(0, MAX_FUZZY_RESULTS);
    }

    if (mode === "@") {
      results = results.map((item) => {
        if (item.category !== "file") return item;
        return {
          ...item,
          // Frecency only influences ranking when query exists.
          _f: frecency.getFrecency(item.value),
        } as AutocompleteItem & { _f?: number };
      });

      if (query) {
        results = [...results]
          .sort((a, b) => {
            const af = (a as AutocompleteItem & { _f?: number })._f ?? 0;
            const bf = (b as AutocompleteItem & { _f?: number })._f ?? 0;
            return bf - af;
          })
          .slice(0, MAX_FUZZY_RESULTS)
          .map((item) => {
            const { _f, ...rest } = item as AutocompleteItem & { _f?: number };
            return rest;
          });
      } else {
        results = results.map((item) => {
          const { _f, ...rest } = item as AutocompleteItem & { _f?: number };
          return rest;
        });
      }
    }

    setState((prev) => ({
      ...prev,
      visible: true,
      mode,
      query,
      triggerIndex,
      items: results,
      selectedIndex: Math.min(prev.selectedIndex, Math.max(0, results.length - 1)),
    }));
  }

  return {
    state,

    onInput(value: string, cursorPos?: number) {
      const position = cursorPos ?? value.length;
      const trigger = findTrigger(value, position);

      if (!trigger) {
        if (state().visible) {
          setState((prev) => ({ ...prev, visible: false, mode: null, triggerIndex: -1, query: "" }));
        }
        return;
      }

      updateResults(trigger.mode, trigger.query, trigger.triggerIndex);
    },

    onKeyDown(key: string, ctrl: boolean): boolean {
      const normalized = normalizeKeyName(key);
      const current = state();

      if (!current.visible) return false;

      if (normalized === "escape") {
        setState((prev) => ({ ...prev, visible: false }));
        return true;
      }

      if (current.items.length === 0) return false;

      if (normalized === "down" || (normalized === "n" && ctrl)) {
        setState((prev) => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, prev.items.length - 1),
        }));
        return true;
      }

      if (normalized === "up" || (normalized === "p" && ctrl)) {
        setState((prev) => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        return true;
      }

      if (normalized === "tab" || normalized === "enter") {
        return true;
      }

      return false;
    },

    getSelected(): AutocompleteItem | null {
      const current = state();
      if (!current.visible || current.items.length === 0) return null;
      return current.items[current.selectedIndex] ?? null;
    },

    select(input: string, cursorPos?: number): string | null {
      const selected = this.getSelected();
      if (!selected) return null;

      const current = state();
      const position = cursorPos ?? input.length;
      if (current.triggerIndex < 0 || current.mode === null) return null;

      if (selected.category === "file") {
        frecency.updateFrecency(selected.value);
      }

      setState((prev) => ({ ...prev, visible: false }));

      const before = input.slice(0, current.triggerIndex);
      const after = input.slice(position);

      if (current.mode === "/") {
        return `${before}${selected.value} ${after}`;
      }

      return `${before}@${selected.value} ${after}`;
    },

    close() {
      setState((prev) => ({ ...prev, visible: false }));
    },
  };
}

export function AutocompleteDropdown(props: {
  items: Accessor<AutocompleteItem[]>;
  selectedIndex: Accessor<number>;
  visible: Accessor<boolean>;
  emptyText?: string;
}) {
  const theme = useTheme();

  return (
    <Show when={props.visible()}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.backgroundMenu}
        flexDirection="column"
        padding={0}
        paddingLeft={1}
        paddingRight={1}
        maxHeight={MAX_FUZZY_RESULTS + 2}
      >
        <Show
          when={props.items().length > 0}
          fallback={<text fg={theme.textMuted}>{props.emptyText ?? "No matching items"}</text>}
        >
          <For each={props.items()}>
            {(item, idx) => {
              const isSelected = () => idx() === props.selectedIndex();
              return (
                <box flexDirection="row" gap={1}>
                  <text
                    fg={isSelected() ? theme.accent : theme.text}
                    attributes={isSelected() ? TextAttributes.BOLD : undefined}
                    bg={isSelected() ? theme.backgroundElement : undefined}
                  >
                    {isSelected() ? "▸ " : "  "}
                    {item.icon ? item.icon + " " : ""}
                    {item.label}
                  </text>
                  <Show when={item.description}>
                    <text fg={theme.textMuted}>{item.description}</text>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </box>
    </Show>
  );
}
