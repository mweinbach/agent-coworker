import { createSignal, createMemo, For, Show, type JSX } from "solid-js";
import { useTheme } from "../context/theme";
import { Dialog } from "./dialog";
import { keyNameFromEvent } from "../util/keyboard";

export type SelectItem = {
  label: string;
  value: string;
  description?: string;
  category?: string;
  keybind?: string;
};

export function filterSelectItems(items: SelectItem[], query: string): SelectItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  return items.filter((item) => {
    const label = item.label.toLowerCase();
    const desc = (item.description ?? "").toLowerCase();
    const cat = (item.category ?? "").toLowerCase();
    return label.includes(q) || desc.includes(q) || cat.includes(q);
  });
}

export function getSelectedSelectItem(items: SelectItem[], selectedIndex: number): SelectItem | null {
  return items[selectedIndex] ?? null;
}

export function resolveDialogSelectKeyAction(
  key: string,
  selectedIndex: number,
  itemCount: number
): { nextSelectedIndex: number; dismiss: boolean } {
  if (itemCount <= 0) {
    if (key === "escape") return { nextSelectedIndex: selectedIndex, dismiss: true };
    return { nextSelectedIndex: selectedIndex, dismiss: false };
  }
  if (key === "up") {
    return { nextSelectedIndex: Math.max(0, selectedIndex - 1), dismiss: false };
  }
  if (key === "down") {
    return { nextSelectedIndex: Math.min(itemCount - 1, selectedIndex + 1), dismiss: false };
  }
  if (key === "escape") {
    return { nextSelectedIndex: selectedIndex, dismiss: true };
  }
  return { nextSelectedIndex: selectedIndex, dismiss: false };
}

type DialogSelectProps = {
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
  onDismiss: () => void;
  title?: string;
  placeholder?: string;
  width?: number | "auto" | `${number}%`;
};

export function DialogSelect(props: DialogSelectProps) {
  const theme = useTheme();
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);

  const filtered = createMemo(() => {
    return filterSelectItems(props.items, query());
  });

  const submitSelectedItem = () => {
    const item = getSelectedSelectItem(filtered(), selected());
    if (item) props.onSelect(item);
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    const action = resolveDialogSelectKeyAction(key, selected(), filtered().length);
    if (action.nextSelectedIndex !== selected()) {
      setSelected(action.nextSelectedIndex);
      e.preventDefault?.();
      return;
    }

    if (action.dismiss) {
      props.onDismiss();
      e.preventDefault?.();
    }
  };

  return (
    <Dialog onDismiss={props.onDismiss} width={props.width}>
      <box flexDirection="column" onKeyDown={handleKeyDown}>
        <Show when={props.title}>
          <text fg={theme.text} marginBottom={1}>
            <strong>{props.title}</strong>
          </text>
        </Show>

        <box
          border
          borderStyle="single"
          borderColor={theme.borderActive}
          marginBottom={1}
          paddingLeft={1}
        >
          <input
            value={query()}
            onChange={(v: any) => {
              setQuery(typeof v === "string" ? v : v?.value ?? "");
              setSelected(0);
            }}
            onKeyDown={handleKeyDown}
            onSubmit={submitSelectedItem}
            placeholder={props.placeholder ?? "Search..."}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focused
            flexGrow={1}
          />
        </box>

        <scrollbox maxHeight={20}>
          <For each={filtered()}>
            {(item, i) => {
              const isSelected = () => selected() === i();
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                  paddingLeft={1}
                  onMouseDown={() => {
                    setSelected(i());
                    props.onSelect(item);
                  }}
                >
                  <text fg={isSelected() ? theme.accent : theme.textMuted}>
                    {isSelected() ? "▸" : " "}
                  </text>
                  <text fg={isSelected() ? theme.text : theme.textMuted} flexGrow={1}>
                    {item.label}
                  </text>
                  <Show when={item.description}>
                    <text fg={theme.textMuted} flexShrink={1}>
                      {item.description}
                    </text>
                  </Show>
                  <Show when={item.keybind}>
                    <text fg={theme.accent}>{item.keybind}</text>
                  </Show>
                </box>
              );
            }}
          </For>
        </scrollbox>

        <Show when={filtered().length === 0}>
          <text fg={theme.textMuted} paddingLeft={1}>
            No results found
          </text>
        </Show>
      </box>
    </Dialog>
  );
}
