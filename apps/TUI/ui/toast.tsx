import { For, Show, createSignal } from "solid-js";
import { useTheme } from "../context/theme";

type ToastMessage = {
  id: number;
  text: string;
  type: "info" | "success" | "error" | "warning";
};

let toastId = 0;
const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

export function showToast(text: string, type: ToastMessage["type"] = "info") {
  const id = ++toastId;
  setToasts((prev) => [...prev, { id, text, type }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, 3000);
}

export function Toast() {
  const theme = useTheme();

  const colorForType = (type: ToastMessage["type"]) => {
    switch (type) {
      case "success": return theme.success;
      case "error": return theme.error;
      case "warning": return theme.warning;
      default: return theme.info;
    }
  };

  return (
    <Show when={toasts().length > 0}>
      <box
        position="absolute"
        right={2}
        bottom={2}
        flexDirection="column"
        gap={1}
        zIndex={200}
      >
        <For each={toasts()}>
          {(toast) => (
            <box
              border
              borderStyle="rounded"
              borderColor={colorForType(toast.type)}
              backgroundColor={theme.backgroundPanel}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={colorForType(toast.type)}>{toast.text}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}
