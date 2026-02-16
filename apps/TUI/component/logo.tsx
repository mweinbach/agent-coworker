import { For, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../context/theme";

// Shadow markers:
// _ = full shadow cell (space with bg=shadow)
// ^ = letter top, shadow bottom (▀ with fg=letter, bg=shadow)
// ~ = shadow top only (▀ with fg=shadow)

// "cowork" logo with shadow effects
const LOGO_LEFT = [
  "           ",
  "           ",
  "           ",
  "           ",
];

const LOGO_RIGHT = [
  "              _         _    ",
  "  ___ ___ _ _|_|___ ___| |__ ",
  " |  _| . | | | | . |  _| '_^",
  " |___|___|___^|_|___|_| |_,_~",
];

const SHADOW_MARKER = /[_^~]/;

function tint(base: string, color: string, amount: number): string {
  // Simple blending: mix color into base by amount
  const parseHex = (h: string) => {
    const v = h.replace("#", "");
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  };
  try {
    const [br, bg, bb] = parseHex(base);
    const [cr, cg, cb] = parseHex(color);
    const r = Math.round(br + (cr - br) * amount);
    const g = Math.round(bg + (cg - bg) * amount);
    const b = Math.round(bb + (cb - bb) * amount);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  } catch {
    return color;
  }
}

export function Logo() {
  const theme = useTheme();

  const renderLine = (line: string, fg: string, bold: boolean): JSX.Element[] => {
    const shadow = tint(theme.background, fg, 0.25);
    const attrs = bold ? TextAttributes.BOLD : undefined;
    const elements: JSX.Element[] = [];
    let i = 0;

    while (i < line.length) {
      const rest = line.slice(i);
      const markerIndex = rest.search(SHADOW_MARKER);

      if (markerIndex === -1) {
        elements.push(
          <text fg={fg} attributes={attrs} selectable={false}>
            {rest}
          </text>
        );
        break;
      }

      if (markerIndex > 0) {
        elements.push(
          <text fg={fg} attributes={attrs} selectable={false}>
            {rest.slice(0, markerIndex)}
          </text>
        );
      }

      const marker = rest[markerIndex];
      switch (marker) {
        case "_":
          elements.push(
            <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
              {" "}
            </text>
          );
          break;
        case "^":
          elements.push(
            <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
              ▀
            </text>
          );
          break;
        case "~":
          elements.push(
            <text fg={shadow} attributes={attrs} selectable={false}>
              ▀
            </text>
          );
          break;
      }

      i += markerIndex + 1;
    }

    return elements;
  };

  return (
    <box>
      <For each={LOGO_LEFT}>
        {(line, index) => (
          <box flexDirection="row" gap={1}>
            <box flexDirection="row">{renderLine(line, theme.textMuted, false)}</box>
            <box flexDirection="row">{renderLine(LOGO_RIGHT[index()], theme.text, true)}</box>
          </box>
        )}
      </For>
    </box>
  );
}
