import { For } from "solid-js";
import { useTheme } from "../context/theme";
import { THEMES } from "../context/theme";

const themeCount = Object.keys(THEMES).length;

type TipPart = { text: string; highlight: boolean };

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = [];
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g;
  const found = Array.from(tip.matchAll(regex));
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0;
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false });
      }
      acc.parts.push({ text: match[1]!, highlight: true });
      acc.index = start + match[0].length;
      return acc;
    },
    { parts, index: 0 }
  );

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false });
  }

  return parts;
}

export function Tips() {
  const theme = useTheme();
  const parts = parse(TIPS[Math.floor(Math.random() * TIPS.length)]!);

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} fg={theme.warning}>
        ● Tip{" "}
      </text>
      <text flexShrink={1}>
        <For each={parts}>
          {(part) => (
            <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>
              {part.text}
            </span>
          )}
        </For>
      </text>
    </box>
  );
}

const TIPS = [
  "Press {highlight}Ctrl+K{/highlight} to open the command palette",
  "Start a message with {highlight}!{/highlight} to run shell commands directly (e.g., {highlight}!ls -la{/highlight})",
  "Use {highlight}/models{/highlight} or {highlight}Ctrl+Shift+L{/highlight} to switch between AI models",
  `Use {highlight}/themes{/highlight} or {highlight}Ctrl+X T{/highlight} to switch between ${themeCount} built-in themes`,
  "Press {highlight}Ctrl+N{/highlight} to start a fresh conversation session",
  "Use {highlight}PageUp{/highlight}/{highlight}PageDown{/highlight} to scroll through conversation history",
  "Press {highlight}Ctrl+C{/highlight} when typing to clear the input field",
  "Press {highlight}Escape{/highlight} to stop the AI mid-response",
  "Use {highlight}/connect{/highlight} to add API keys for supported providers",
  "The sidebar shows context usage, MCP status, and todos",
  "Press {highlight}Shift+Enter{/highlight} to add newlines in your prompt",
  "Use {highlight}/status{/highlight} to see session details and connection info",
  "Use {highlight}/new{/highlight} or {highlight}/reset{/highlight} to start a fresh conversation",
  "Press {highlight}Ctrl+X S{/highlight} to list and continue previous sessions",
];
