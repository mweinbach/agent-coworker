import { Show, For, createMemo, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncActions } from "../../context/sync";
import type { AskRequest } from "../../context/sync";
import { keyNameFromEvent } from "../../util/keyboard";
import { ASK_SKIP_TOKEN } from "../../../../src/shared/ask";

function decodeJsonStringLiteral(value: string): string | null {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeAskQuestion(question: string, maxChars = 480): string {
  let normalized = question.trim();
  normalized = normalized.replace(/\braw stream part:\s*\{[\s\S]*$/i, "").trim();
  const embedded = normalized.match(/"question"\s*:\s*"((?:\\.|[^"\\])+)"/i);
  if (embedded?.[1]) {
    const decoded = decodeJsonStringLiteral(embedded[1]);
    if (decoded) normalized = decoded;
  }
  normalized = normalized.replace(/^question:\s*/i, "").trim();

  const compact = normalizeWhitespace(normalized);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

function looksLikeRawPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return (
    /^raw stream part:/i.test(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.includes("\"type\":") ||
    trimmed.includes("response.") ||
    trimmed.includes("obfuscation")
  );
}

function looksUnreadableOption(value: string): boolean {
  const compact = normalizeWhitespace(value);
  if (!compact) return true;
  if (looksLikeRawPayload(compact)) return true;
  if (compact.length > 220) return true;
  if (compact.length > 90 && !/\s/.test(compact)) return true;
  if (
    compact.length > 40 &&
    !/\s/.test(compact) &&
    (/[()[\]{}]/.test(compact) || /[a-z][A-Z]/.test(compact) || compact.includes(","))
  ) {
    return true;
  }
  const punctuationCount = (compact.match(/[{}[\]:"`]/g) ?? []).length;
  if (compact.length > 24 && punctuationCount >= 4) return true;
  return false;
}

function truncateOption(option: string, maxChars = 140): string {
  const compact = normalizeWhitespace(option);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

export function normalizeAskOptions(options?: string[]): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    if (typeof option !== "string") continue;
    if (looksUnreadableOption(option)) continue;
    const normalized = truncateOption(option);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 6);
}

export function shouldRenderAskOptions(options: string[]): boolean {
  return options.length >= 2;
}

export function resolveAskEscapeAnswer(): string {
  return ASK_SKIP_TOKEN;
}

export function QuestionPrompt(props: { ask: AskRequest }) {
  const theme = useTheme();
  const actions = useSyncActions();
  const [selected, setSelected] = createSignal(0);
  const [customInput, setCustomInput] = createSignal("");
  const questionText = createMemo(() => normalizeAskQuestion(props.ask.question));
  const options = createMemo(() => normalizeAskOptions(props.ask.options));

  const hasOptions = () => shouldRenderAskOptions(options());

  const handleSubmit = () => {
    if (hasOptions()) {
      const opts = options();
      const answer = opts[selected()] ?? customInput();
      actions.answerAsk(props.ask.requestId, answer);
    } else {
      const text = customInput().trim();
      if (text) {
        actions.answerAsk(props.ask.requestId, text);
      }
    }
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    if (hasOptions()) {
      if (key === "up") {
        setSelected((s) => Math.max(0, s - 1));
        e.preventDefault?.();
      } else if (key === "down") {
        setSelected((s) => Math.min(options().length - 1, s + 1));
        e.preventDefault?.();
      } else if (key === "enter") {
        handleSubmit();
        e.preventDefault?.();
      } else if (key === "escape") {
        actions.answerAsk(props.ask.requestId, resolveAskEscapeAnswer());
        e.preventDefault?.();
      }
    } else {
      if (key === "enter") {
        // Fallback for terminals that do not route Enter to input onSubmit reliably.
        handleSubmit();
        e.preventDefault?.();
      } else if (key === "escape") {
        actions.answerAsk(props.ask.requestId, resolveAskEscapeAnswer());
        e.preventDefault?.();
      }
    }
  };

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={theme.info}
      backgroundColor={theme.backgroundPanel}
      marginLeft={1}
      marginRight={1}
      marginBottom={1}
      padding={1}
      onKeyDown={handleKeyDown}
      focused
      focusable
    >
      <text fg={theme.info} marginBottom={1}>
        ? {questionText()}
      </text>

      <Show when={hasOptions()}>
        <For each={options()}>
          {(opt, i) => (
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => {
                setSelected(i());
                handleSubmit();
              }}
            >
              <text fg={selected() === i() ? theme.accent : theme.textMuted}>
                {selected() === i() ? "▸" : " "}
              </text>
              <text fg={selected() === i() ? theme.text : theme.textMuted}>{opt}</text>
            </box>
          )}
        </For>
      </Show>

      <Show when={!hasOptions()}>
        <box flexDirection="row">
          <text fg={theme.accent}>{"❯ "}</text>
          <input
            value={customInput()}
            onChange={(v: any) => setCustomInput(typeof v === "string" ? v : v?.value ?? "")}
            onKeyDown={handleKeyDown}
            onSubmit={handleSubmit}
            placeholder="Type your answer..."
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            flexGrow={1}
            focused
          />
        </box>
      </Show>
    </box>
  );
}
