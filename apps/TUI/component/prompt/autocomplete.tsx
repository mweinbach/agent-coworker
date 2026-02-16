import { createSignal, For, Show, type Accessor } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../context/theme";
import { createFrecencyTracker } from "./frecency";

/**
 * Autocomplete system for the prompt input.
 * Supports:
 *   @ — file/path autocomplete
 *   / — command autocomplete (at position 0)
 *
 * Uses fuzzysort for fuzzy matching and frecency for result boosting.
 * Matches opencode's autocomplete pattern.
 */

export type AutocompleteItem = {
  label: string;
  value: string;
  description?: string;
  category?: string;
  icon?: string;
};

type AutocompleteState = {
  visible: boolean;
  items: AutocompleteItem[];
  selectedIndex: number;
  trigger: "@" | "/" | null;
  query: string;
};

const MAX_RESULTS = 10;

export function createAutocomplete(opts: {
  getCommands: () => AutocompleteItem[];
  getFiles?: () => AutocompleteItem[];
}) {
  const [state, setState] = createSignal<AutocompleteState>({
    visible: false,
    items: [],
    selectedIndex: 0,
    trigger: null,
    query: "",
  });

  const frecency = createFrecencyTracker();

  function fuzzyMatch(items: AutocompleteItem[], query: string): AutocompleteItem[] {
    if (!query) return items.slice(0, MAX_RESULTS);

    const lowerQuery = query.toLowerCase();
    const scored = items
      .map((item) => {
        const label = item.label.toLowerCase();
        const value = item.value.toLowerCase();

        // Exact prefix match gets highest score
        if (label.startsWith(lowerQuery) || value.startsWith(lowerQuery)) {
          let score = 1000;
          // Boost with frecency if it's a file path
          if (item.category === "file") {
            score += frecency.getFrecency(item.value) * 100;
          }
          return { item, score };
        }

        // Contains match
        if (label.includes(lowerQuery) || value.includes(lowerQuery)) {
          let score = 500;
          if (item.category === "file") {
            score += frecency.getFrecency(item.value) * 100;
          }
          return { item, score };
        }

        // Fuzzy subsequence match
        let si = 0;
        for (let ci = 0; ci < label.length && si < lowerQuery.length; ci++) {
          if (label[ci] === lowerQuery[si]) si++;
        }
        if (si === lowerQuery.length) {
          let score = 100;
          if (item.category === "file") {
            score += frecency.getFrecency(item.value) * 100;
          }
          return { item, score };
        }

        return null;
      })
      .filter((r): r is { item: AutocompleteItem; score: number } => r !== null)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, MAX_RESULTS).map((r) => r.item);
  }

  function updateResults() {
    const s = state();
    let source: AutocompleteItem[];

    if (s.trigger === "/") {
      source = opts.getCommands();
    } else if (s.trigger === "@") {
      source = opts.getFiles?.() ?? [];
    } else {
      return;
    }

    const results = fuzzyMatch(source, s.query);
    setState((prev) => ({
      ...prev,
      items: results,
      selectedIndex: Math.min(prev.selectedIndex, Math.max(0, results.length - 1)),
    }));
  }

  return {
    state,

    /** Called when input text changes. Detects triggers and updates results. */
    onInput(value: string, cursorPos?: number) {
      const pos = cursorPos ?? value.length;

      // Check for / at position 0
      if (value.startsWith("/")) {
        const query = value.slice(1);
        setState({
          visible: true,
          items: [],
          selectedIndex: 0,
          trigger: "/",
          query,
        });
        updateResults();
        return;
      }

      // Check for @ preceded by whitespace or at start
      const lastAt = value.lastIndexOf("@", pos);
      if (lastAt >= 0 && (lastAt === 0 || /\s/.test(value[lastAt - 1] ?? ""))) {
        const query = value.slice(lastAt + 1, pos);
        setState({
          visible: true,
          items: [],
          selectedIndex: 0,
          trigger: "@",
          query,
        });
        updateResults();
        return;
      }

      // No trigger found — close
      if (state().visible) {
        setState((prev) => ({ ...prev, visible: false }));
      }
    },

    /** Handle keyboard events for autocomplete navigation. Returns true if handled. */
    onKeyDown(key: string, ctrl: boolean): boolean {
      const s = state();
      if (!s.visible || s.items.length === 0) return false;

      // Arrow down or Ctrl+N
      if (key === "down" || (key === "n" && ctrl)) {
        setState((prev) => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, prev.items.length - 1),
        }));
        return true;
      }

      // Arrow up or Ctrl+P
      if (key === "up" || (key === "p" && ctrl)) {
        setState((prev) => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        return true;
      }

      // Tab or Enter to select
      if (key === "tab" || key === "return") {
        return true; // Caller should call select()
      }

      // Escape to close
      if (key === "escape") {
        setState((prev) => ({ ...prev, visible: false }));
        return true;
      }

      return false;
    },

    /** Get the currently selected item. */
    getSelected(): AutocompleteItem | null {
      const s = state();
      if (!s.visible || s.items.length === 0) return null;
      return s.items[s.selectedIndex] ?? null;
    },

    /** Select an item and update frecency. Returns the replacement text. */
    select(input: string): string | null {
      const selected = this.getSelected();
      if (!selected) return null;

      const s = state();

      // Update frecency for file selections
      if (selected.category === "file") {
        frecency.updateFrecency(selected.value);
      }

      setState((prev) => ({ ...prev, visible: false }));

      if (s.trigger === "/") {
        return selected.value;
      }

      if (s.trigger === "@") {
        // Replace the @query with the selected value
        const lastAt = input.lastIndexOf("@");
        if (lastAt >= 0) {
          return input.slice(0, lastAt) + "@" + selected.value + " ";
        }
      }

      return null;
    },

    /** Close the autocomplete. */
    close() {
      setState((prev) => ({ ...prev, visible: false }));
    },
  };
}

/**
 * Autocomplete dropdown UI component.
 */
export function AutocompleteDropdown(props: {
  items: Accessor<AutocompleteItem[]>;
  selectedIndex: Accessor<number>;
  visible: Accessor<boolean>;
}) {
  const theme = useTheme();

  return (
    <Show when={props.visible() && props.items().length > 0}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.backgroundMenu}
        flexDirection="column"
        padding={0}
        paddingLeft={1}
        paddingRight={1}
        maxHeight={MAX_RESULTS + 2}
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
      </box>
    </Show>
  );
}
