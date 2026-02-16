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
    const q = query().toLowerCase().trim();
    if (!q) return props.items;
    return props.items.filter((item) => {
      const label = item.label.toLowerCase();
      const desc = (item.description ?? "").toLowerCase();
      const cat = (item.category ?? "").toLowerCase();
      return label.includes(q) || desc.includes(q) || cat.includes(q);
    });
  });

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    const items = filtered();

    if (key === "up") {
      setSelected((s) => Math.max(0, s - 1));
      e.preventDefault?.();
    } else if (key === "down") {
      setSelected((s) => Math.min(items.length - 1, s + 1));
      e.preventDefault?.();
    } else if (key === "enter") {
      const item = items[selected()];
      if (item) props.onSelect(item);
      e.preventDefault?.();
    } else if (key === "escape") {
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
