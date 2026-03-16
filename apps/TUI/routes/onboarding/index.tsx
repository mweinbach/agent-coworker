import { createSignal, onMount } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { useTheme } from "../../context/theme";
import { useRoute } from "../../context/route";
import { useKV } from "../../context/kv";
import { useDialog } from "../../context/dialog";
import { openProviderDialog } from "../../component/dialog-provider";
import { keyNameFromEvent } from "../../util/keyboard";

export function Onboarding() {
  const theme = useTheme();
  const route = useRoute();
  const kv = useKV();
  const dialog = useDialog();

  const [focusedIndex, setFocusedIndex] = createSignal(1); // Default focus to providers

  const handleProvider = () => {
    openProviderDialog(dialog);
  };

  const handleWorkspace = () => {
    // Navigate to home after onboarding is complete
    // kv.set("onboarding_complete", "true");
    // route.navigate({ route: "home" });
  };

  const finishOnboarding = () => {
     kv.set("onboarding_complete", "true");
     route.navigate({ route: "home" });
  }

  useKeyboard((e) => {
    if (dialog.hasDialog()) return; // Don't process if a dialog is open

    const key = keyNameFromEvent(e);

    if (key === "up") {
      setFocusedIndex((prev) => Math.max(0, prev - 1));
      e.preventDefault();
    } else if (key === "down") {
      setFocusedIndex((prev) => Math.min(3, prev + 1));
      e.preventDefault();
    } else if (key === "enter") {
      const idx = focusedIndex();
      if (idx === 0) handleWorkspace();
      else if (idx === 1) handleProvider();
      else if (idx === 3) finishOnboarding();
      e.preventDefault();
    }
  });

  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <text fg={theme.text} bold>Welcome to Cowork</text>
      <box height={2} />
      <text fg={theme.textMuted}>Let's get you set up.</text>
      <box height={2} />

      <box flexDirection="column" gap={1} width={50}>
         <box border borderStyle="rounded" borderColor={focusedIndex() === 0 ? theme.primary : theme.border} padding={1} flexDirection="column" alignItems="center" onClick={() => {setFocusedIndex(0); handleWorkspace();}}>
            <text fg={theme.text}>Add a Workspace</text>
            <text fg={theme.textMuted}>(Coming soon)</text>
         </box>

         <box border borderStyle="rounded" borderColor={focusedIndex() === 1 ? theme.primary : theme.border} padding={1} flexDirection="column" alignItems="center" onClick={() => {setFocusedIndex(1); handleProvider();}}>
            <text fg={theme.text}>Add a Model Provider</text>
            <text fg={theme.textMuted}>Recommended: ChatGPT Codex</text>
            <text fg={theme.textMuted}>Also: Google, Anthropic, OpenAI, OpenCode Zen</text>
            <box height={1} />
            <box border borderStyle="rounded" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
                <text fg={theme.textMuted}>More providers...</text>
            </box>
         </box>

         <box border borderStyle="rounded" borderColor={focusedIndex() === 2 ? theme.primary : theme.border} padding={1} flexDirection="column" alignItems="center" onClick={() => setFocusedIndex(2)}>
            <text fg={theme.text}>Require Exa Search</text>
            <text fg={theme.textMuted}>More tools coming soon</text>
         </box>
      </box>

      <box height={2} />
      <box onClick={() => {setFocusedIndex(3); finishOnboarding();}} border borderStyle="rounded" borderColor={focusedIndex() === 3 ? theme.success : theme.border} padding={1}>
        <text fg={focusedIndex() === 3 ? theme.success : theme.text}>Finish Setup</text>
      </box>
    </box>
  );
}
