import { useTheme } from "../context/theme";

const LOGO_TEXT = "cowork";

export function Logo() {
  const theme = useTheme();

  return (
    <box width="100%" alignItems="center">
      <ascii_font
        text={LOGO_TEXT}
        font="block"
        color={theme.text}
        backgroundColor={theme.background}
        selectable={false}
      />
    </box>
  );
}
