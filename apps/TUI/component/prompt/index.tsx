import { createSignal, createMemo, Show, type JSX } from "solid-js";
import { useTheme } from "../../context/theme";
import { usePrompt } from "../../context/prompt";
import { useSyncState, useSyncActions } from "../../context/sync";
import { useRoute } from "../../context/route";
import { createPromptHistory } from "./history";
import { createAutocomplete, AutocompleteDropdown } from "./autocomplete";
import { getTextareaAction } from "../textarea-keybindings";

const PLACEHOLDERS = [
  "Ask me anything...",
  "What would you like to build?",
  "Describe a task or ask a question...",
  "How can I help?",
  "What should we work on?",
];

const SHELL_PLACEHOLDERS = [
  "Enter a shell command...",
  "Run a command...",
  "$ ",
];

const history = createPromptHistory();

export function Prompt(props: {
  hint?: JSX.Element;
  onSubmit?: (text: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const prompt = usePrompt();
  const syncState = useSyncState();
  const syncActions = useSyncActions();
  const route = useRoute();

  const [focused, setFocused] = createSignal(true);
  const [shellMode, setShellMode] = createSignal(false);

  const placeholder = () => {
    if (shellMode()) {
      return SHELL_PLACEHOLDERS[Math.floor(Math.random() * SHELL_PLACEHOLDERS.length)]!;
    }
    return PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]!;
  };

  const autocomplete = createAutocomplete({
    getCommands: () => [
      { label: "/new", value: "/new", description: "New session", category: "command", icon: "+" },
      { label: "/clear", value: "/clear", description: "Clear session", category: "command", icon: "×" },
      { label: "/status", value: "/status", description: "Show status", category: "command", icon: "i" },
      { label: "/exit", value: "/exit", description: "Exit", category: "command", icon: "⏻" },
      { label: "/models", value: "/models", description: "Switch model", category: "command", icon: "◇" },
      { label: "/connect", value: "/connect", description: "Connect provider", category: "command", icon: "⚡" },
      { label: "/themes", value: "/themes", description: "Change theme", category: "command", icon: "🎨" },
      { label: "/help", value: "/help", description: "Show help", category: "command", icon: "?" },
    ],
  });

  const isDisabled = createMemo(() => {
    return props.disabled || syncState.busy || syncState.pendingAsk !== null || syncState.pendingApproval !== null;
  });

  const handleSubmit = () => {
    const text = prompt.input().trim();
    if (!text) return;

    // Save to persistent history
    history.append(text, shellMode() ? "shell" : "normal");
    // Also save to context history
    prompt.pushHistory(text);

    if (props.onSubmit) {
      props.onSubmit(text);
    } else {
      // Handle shell mode — prefix with ! if in shell mode
      const messageText = shellMode() ? `!${text}` : text;

      if (route.current().route === "home") {
        syncActions.sendMessage(messageText);
        route.navigate({ route: "session", sessionId: syncState.sessionId ?? "pending" });
      } else {
        syncActions.sendMessage(messageText);
      }
    }

    prompt.setInput("");
  };

  const handleKeyDown = (e: any) => {
    const key = e.key ?? e.name ?? "";
    const ctrl = e.ctrl ?? false;
    const shift = e.shift ?? false;
    const alt = e.alt ?? false;

    // Let autocomplete handle keys first
    const acState = autocomplete.state();
    if (acState.visible) {
      if (autocomplete.onKeyDown(key, ctrl)) {
        e.preventDefault?.();

        // If tab/enter, do the selection
        if (key === "tab" || key === "return") {
          const replacement = autocomplete.select(prompt.input());
          if (replacement !== null) {
            prompt.setInput(replacement);
          }
        }
        return;
      }
    }

    // Use textarea keybinding mapping
    const action = getTextareaAction(key, ctrl, shift, alt);

    switch (action) {
      case "submit":
        e.preventDefault?.();
        handleSubmit();
        return;

      case "newline":
        // Allow newline insertion (Shift+Enter)
        return;

      case "clear":
        prompt.setInput("");
        return;

      case "history_up": {
        const entry = history.navigateUp(prompt.input());
        if (entry !== null) {
          prompt.setInput(entry.input);
          if (entry.mode === "shell") setShellMode(true);
          else if (entry.mode === "normal") setShellMode(false);
        }
        return;
      }

      case "history_down": {
        const entry = history.navigateDown();
        if (entry !== null) {
          prompt.setInput(entry.input);
        }
        return;
      }

      case "cancel":
        if (prompt.input()) {
          prompt.setInput("");
        }
        return;

      case "stash":
        prompt.doStash();
        return;

      case "unstash": {
        const restored = prompt.doUnstash();
        if (restored !== null) {
          prompt.setInput(restored);
        }
        return;
      }

      case "shell_mode":
        setShellMode((m) => !m);
        return;
    }
  };

  const handleInput = (v: any) => {
    const value = typeof v === "string" ? v : v?.value ?? "";
    prompt.setInput(value);
    history.resetIndex();

    // Check for ! prefix to auto-enable shell mode
    if (value.startsWith("!") && !shellMode()) {
      setShellMode(true);
      prompt.setInput(value.slice(1));
      return;
    }

    // Update autocomplete
    autocomplete.onInput(value);
  };

  return (
    <box flexDirection="column" width="100%">
      {/* Autocomplete dropdown above the input */}
      <AutocompleteDropdown
        items={() => autocomplete.state().items}
        selectedIndex={() => autocomplete.state().selectedIndex}
        visible={() => autocomplete.state().visible}
      />

      <box
        border
        borderStyle="rounded"
        borderColor={focused() ? theme.borderActive : theme.border}
        backgroundColor={focused() ? theme.backgroundElement : theme.backgroundPanel}
        flexDirection="column"
        padding={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row">
          {/* Mode indicator */}
          <text fg={shellMode() ? theme.warning : theme.accent} selectable={false}>
            {shellMode() ? "$ " : "❯ "}
          </text>
          <input
            value={prompt.input()}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={isDisabled() ? "Waiting..." : placeholder()}
            placeholderColor={theme.textMuted}
            fg={theme.text}
            flexGrow={1}
            autoFocus={!props.disabled}
            disabled={isDisabled()}
          />
          {/* Shell mode badge */}
          <Show when={shellMode()}>
            <text fg={theme.warning} selectable={false}>
              {" SHELL"}
            </text>
          </Show>
        </box>
        <Show when={props.hint}>
          <box paddingTop={0}>
            {props.hint}
          </box>
        </Show>
      </box>
      <Show when={syncState.busy}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>Agent is working...</text>
        </box>
      </Show>
    </box>
  );
}
