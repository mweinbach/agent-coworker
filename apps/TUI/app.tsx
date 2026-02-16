import { Show, createMemo } from "solid-js";
import { useRoute } from "./context/route";
import { useTheme } from "./context/theme";
import { useDialog } from "./context/dialog";
import { Home } from "./routes/home";
import { Session } from "./routes/session/index";

export function App() {
  const { current } = useRoute();
  const theme = useTheme();
  const dialog = useDialog();

  const isHome = createMemo(() => current().route === "home");
  const sessionId = createMemo(() => {
    const c = current();
    return c.route === "session" ? c.sessionId : null;
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      <Show when={isHome()}>
        <Home />
      </Show>
      <Show when={sessionId()}>
        {(sid) => <Session sessionId={sid()} />}
      </Show>

      {/* Dialog overlay */}
      <Show when={dialog.hasDialog()}>
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={100}
        >
          {dialog.stack().length > 0 && dialog.stack()[dialog.stack().length - 1]!.element()}
        </box>
      </Show>
    </box>
  );
}
