import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { useTheme } from "../context/theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

export function Spinner(props: { children?: JSX.Element; color?: string }) {
  const theme = useTheme();
  const [frame, setFrame] = createSignal(0);

  const timer = setInterval(() => {
    setFrame((f) => (f + 1) % FRAMES.length);
  }, INTERVAL);

  onCleanup(() => clearInterval(timer));

  const color = () => props.color ?? theme.textMuted;

  return (
    <box flexDirection="row" gap={1}>
      <text fg={color()}>{FRAMES[frame()]}</text>
      <Show when={props.children}>
        <text fg={color()}>{props.children}</text>
      </Show>
    </box>
  );
}
