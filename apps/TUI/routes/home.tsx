import { createMemo, Show } from "solid-js";
import { useTheme } from "../context/theme";
import { useSyncState } from "../context/sync";
import { useKV } from "../context/kv";
import { Logo } from "../component/logo";
import { Tips } from "../component/tips";
import { Prompt } from "../component/prompt/index";

const VERSION = "0.1.0";

export function Home() {
  const theme = useTheme();
  const syncState = useSyncState();
  const kv = useKV();

  const [tipsHidden] = kv.signal("tips_hidden", false);
  const showTips = createMemo(() => !tipsHidden());

  const statusText = createMemo(() => {
    return syncState.status === "connected"
      ? `${syncState.provider}/${syncState.model}`
      : syncState.status;
  });

  const Hint = (
    <Show when={syncState.status === "connected"}>
      <box flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.text}>
          <span style={{ fg: theme.success }}>●</span>{" "}
          connected
        </text>
      </box>
    </Show>
  );

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        {/* Spacer top */}
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />

        {/* Logo */}
        <box flexShrink={0}>
          <Logo />
        </box>

        <box height={1} minHeight={0} flexShrink={1} />

        {/* Prompt */}
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <Prompt hint={Hint} />
        </box>

        {/* Tips */}
        <box
          height={4}
          minHeight={0}
          width="100%"
          maxWidth={75}
          alignItems="center"
          paddingTop={3}
          flexShrink={1}
        >
          <Show when={showTips()}>
            <Tips />
          </Show>
        </box>

        {/* Spacer bottom */}
        <box flexGrow={1} minHeight={0} />
      </box>

      {/* Footer */}
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        flexShrink={0}
        gap={2}
      >
        <text fg={theme.textMuted}>{syncState.cwd || process.cwd()}</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted}>{statusText()}</text>
        <box flexShrink={0}>
          <text fg={theme.textMuted}>v{VERSION}</text>
        </box>
      </box>
    </>
  );
}
